/**
 * #287 phase 13: immutable, owner-checked SQS mapping manifest for a future
 * single-orphan fence. This module only stages the manifest; it NEVER calls
 * UpdateEventSourceMapping, installs an erasure fence, or deletes a provider
 * object. It is not wired to the review API or production SQS worker.
 *
 * A future privileged worker must recheck all provider/ownership evidence
 * under a live, drained profile fence before installing replay markers.
 */
import {createHash} from "node:crypto";
import {TransactWriteCommand, type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {OrphanSafetyError, type OrphanDeletionOperation} from "./orphan-deletion-executor.js";
import type {OrphanWorkerMappingInventory} from "./orphan-worker-mappings.js";
import type {Profile} from "./types.js";

const ID=/^[A-Za-z0-9_-]{1,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQS_ARN=/^arn:[a-z0-9-]+:sqs:[a-z0-9-]+:\d{12}:[a-zA-Z0-9_.-]+$/;
const PROFILES=new Set<Profile>(["home","antonio","work"]);
const MAX_MAPPINGS=100, MAX_PROOF_AGE=120000;
const key=(opId:string)=>({pk:"ORPHAN_FENCE_MANIFEST#"+opId,sk:"STATE"});
type Db=Pick<DynamoDBDocumentClient,"send">;

export interface OrphanMappingRow {
  id:string;eventSourceArn:string;functionArn:string;state:"Enabled";
}
export interface OrphanFenceManifest {
  pk:string;sk:"STATE";
  operationId:string;caseId:string;profile:Profile;caseUpdatedAt:string;
  side:"todoist"|"calendar";targetId:string;providerDigest:string;
  mappingIds:string[]; originallyEnabledIds:string[];
  mappingFingerprint:string;targetWorkerFunction:string;
  timeoutSeconds:number;epoch:number;
  status:"staged";version:0;createdAt:string;
}
export interface OrphanFenceManifestRequest {
  operation:OrphanDeletionOperation;
  mappingInventory:OrphanWorkerMappingInventory;
  mappings:readonly OrphanMappingRow[];
  targetWorkerFunction:string;
  expectedErasureEpoch:number;
  now?:Date;
}
function table():string {
  const name=process.env.STATE_TABLE_NAME?.trim();
  if(!name)throw new OrphanSafetyError("Orphan fence staging state table is unavailable");
  return name;
}
function assertStagingEnabled():void {
  if(process.env.ORPHAN_FENCE_STAGING_ENABLED!=="true"
    ||process.env.ERASURE_PROTOCOL_VERSION!=="1"
    ||process.env.ORPHAN_WORKER_INSPECTION_ENABLED!=="true")
    throw new OrphanSafetyError("Immutable orphan fence manifest staging is disabled");
}
/** Same canonical fingerprint construction as the read-only #318 inspector.
 * A mismatch means the raw mapping list is not the verified snapshot. */
function fingerprint(fn:string,timeout:number,rows:readonly OrphanMappingRow[]):string {
  const manifest=rows.map(row=>[row.id,row.eventSourceArn,row.state,row.functionArn])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  return createHash("sha256").update(JSON.stringify([fn,timeout,manifest])).digest("hex");
}
function assertOperation(op:OrphanDeletionOperation,now:number):void {
  const issued=Date.parse(op.confirmedAt),expires=Date.parse(op.confirmationExpiresAt);
  if(!ID.test(op.id)||typeof op.caseId!=="string"||!op.caseId.trim()||
    !PROFILES.has(op.profile)||!["todoist","calendar"].includes(op.side)||
    typeof op.targetId!=="string"||!op.targetId.trim()||
    /[\u0000-\u001f]/.test(op.targetId)||
    !SHA.test(op.providerDigest)||op.phase!=="confirmed"||op.version!==0||
    !op.actorSubject||!op.caseUpdatedAt||!Number.isFinite(issued)||
    !Number.isFinite(expires)||issued>now||expires<=now||
    expires<=issued||expires-issued>300000||
    (op.side==="calendar"?!op.providerEtag:op.providerEtag!==undefined))
    throw new OrphanSafetyError("The orphan approval is expired, stale or not an exact singleton");
}
export function buildOrphanFenceManifest(req:OrphanFenceManifestRequest):OrphanFenceManifest {
  const when=req.now??new Date(),ms=when.getTime(),op=req.operation;
  if(!Number.isFinite(ms))throw new OrphanSafetyError("Invalid staging time");
  assertOperation(op,ms);
  const inv=req.mappingInventory,rows=req.mappings;
  const name=req.targetWorkerFunction?.trim();
  if(!name||name.length>256||/[\u0000-\u001f]/.test(name)||
    !inv||inv.verified!==true||inv.blockers.length!==0||
    !SHA.test(inv.fingerprint??"")||
    !Number.isInteger(inv.timeoutSeconds)||!inv.timeoutSeconds||
    inv.timeoutSeconds<1||inv.timeoutSeconds>900||
    !Number.isInteger(inv.mappingCount)||
    !Array.isArray(rows)||!rows.length||rows.length>MAX_MAPPINGS||
    inv.mappingCount!==rows.length||
    !Number.isSafeInteger(req.expectedErasureEpoch)||req.expectedErasureEpoch<0)
    throw new OrphanSafetyError("Complete, stable target worker mapping inventory is required");
  const checked=Date.parse(inv.checkedAt);
  if(!Number.isFinite(checked)||checked>ms+10000||ms-checked>MAX_PROOF_AGE)
    throw new OrphanSafetyError("Worker mapping inventory expired or is from the future");
  const seen=new Set<string>();
  for(const row of rows){
    if(!row||!UUID.test(row.id)||!SQS_ARN.test(row.eventSourceArn)||
      !row.functionArn||row.functionArn.length>512||
      /[\u0000-\u001f]/.test(row.functionArn)||
      row.state!=="Enabled"||seen.has(row.id))
      throw new OrphanSafetyError("Worker mappings are incomplete, foreign or duplicated");
    seen.add(row.id);
  }
  if(fingerprint(name,inv.timeoutSeconds,rows)!==inv.fingerprint)
    throw new OrphanSafetyError("Worker mapping identity diverged from the independently verified inventory");
  const ids=[...seen].sort();
  return {...key(op.id),operationId:op.id,caseId:op.caseId,profile:op.profile,
    caseUpdatedAt:op.caseUpdatedAt,side:op.side,targetId:op.targetId,
    providerDigest:op.providerDigest,mappingIds:ids,originallyEnabledIds:[...ids],
    mappingFingerprint:inv.fingerprint,targetWorkerFunction:name,
    timeoutSeconds:inv.timeoutSeconds,epoch:req.expectedErasureEpoch,
    status:"staged",version:0,createdAt:when.toISOString()};
}
/** Persist one immutable staging record only if the approved journal, case,
 * case lock, profile admission fence and epoch still match. This is a
 * non-idempotent conditional create; a timeout/conflict demands operator
 * inspection, NEVER a blind overwrite or replayed mapping disable. */
export async function stageOrphanFenceManifest(
  req:OrphanFenceManifestRequest,db:Db=documentClient,
):Promise<OrphanFenceManifest> {
  assertStagingEnabled();
  const manifest=buildOrphanFenceManifest(req),op=req.operation;
  await db.send(new TransactWriteCommand({TransactItems:[
    {Put:{TableName:table(),Item:manifest,ConditionExpression:"attribute_not_exists(pk)"}},
    {ConditionCheck:{TableName:table(),Key:{pk:"ORPHAN_DELETE#"+op.id,sk:"STATE"},
      ConditionExpression:"#phase=:confirmed AND #version=:zero AND caseId=:caseId AND profile=:profile AND side=:side AND targetId=:target AND providerDigest=:digest AND actorSubject=:actor AND caseUpdatedAt=:caseVersion AND confirmedAt=:confirmedAt AND confirmationExpiresAt=:expiry"
        +(op.side==="calendar"?" AND providerEtag=:etag":" AND attribute_not_exists(providerEtag)"),
      ExpressionAttributeNames:{"#phase":"phase","#version":"version"},
      ExpressionAttributeValues:{":confirmed":"confirmed",":zero":0,":caseId":op.caseId,
        ":profile":op.profile,":side":op.side,":target":op.targetId,
        ":digest":op.providerDigest,":actor":op.actorSubject,
        ":caseVersion":op.caseUpdatedAt,":confirmedAt":op.confirmedAt,
        ":expiry":op.confirmationExpiresAt,
        ...(op.side==="calendar"?{":etag":op.providerEtag}:{})}}},
    {ConditionCheck:{TableName:table(),Key:{pk:"ORPHAN_CASE_LOCK#"+op.caseId,sk:"STATE"},
      ConditionExpression:"operationId=:id AND caseId=:caseId AND profile=:profile AND side=:side AND targetId=:target AND caseUpdatedAt=:caseVersion",
      ExpressionAttributeValues:{":id":op.id,":caseId":op.caseId,":profile":op.profile,
        ":side":op.side,":target":op.targetId,":caseVersion":op.caseUpdatedAt}}},
    {ConditionCheck:{TableName:table(),Key:{pk:"REVIEW_CASE#"+op.caseId,sk:"STATE"},
      ConditionExpression:"#state=:open AND updatedAt=:caseVersion AND profile=:profile AND attribute_not_exists(operationId)",
      ExpressionAttributeNames:{"#state":"status"},
      ExpressionAttributeValues:{":open":"open",":caseVersion":op.caseUpdatedAt,":profile":op.profile}}},
    {ConditionCheck:{TableName:table(),Key:{pk:"ERASURE#"+op.profile,sk:"FENCE"},
      ConditionExpression:"attribute_not_exists(pk)"}},
    {ConditionCheck:{TableName:table(),Key:{pk:"ERASURE#"+op.profile,sk:"EPOCH"},
      ConditionExpression:"(attribute_not_exists(#epoch) AND :epoch=:zero) OR #epoch=:epoch",
      ExpressionAttributeNames:{"#epoch":"epoch"},
      ExpressionAttributeValues:{":epoch":manifest.epoch,":zero":0}}},
  ]}));
  return manifest;
}
