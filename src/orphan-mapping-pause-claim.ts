/**
 * #287 phase 15: an exclusive, recoverable CLAIM on the worker pause intent.
 *
 * This module does not disable Lambda mappings, fence providers, install
 * replay markers or perform deletion. A staged manifest is not a fence.
 * #307 must independently prove ALL qualified/historical writer paths before
 * a future privileged mapping-pause worker can use this claim.
 *
 * A conditional transaction atomically creates (1) a durable operation
 * receipt and (2) a worker-global pause owner. A crash/uncertain commit
 * must be recovered by strongly consistent readback, never blind retry or
 * automatic lock removal.
 */
import {createHash} from "node:crypto";
import {GetCommand,TransactWriteCommand,type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {DynamoOrphanJournal,OrphanSafetyError,type OrphanDeletionOperation} from "./orphan-deletion-executor.js";
import {inspectOrphanWorkerMappings,type OrphanWorkerMappingInventory} from "./orphan-worker-mappings.js";
import {inspectErasureFence} from "./erasure-protocol.js";
import type {OrphanFenceManifest} from "./orphan-fence-manifest.js";
import type {Profile} from "./types.js";

type Db=Pick<DynamoDBDocumentClient,"send">;
const PROFILES=["antonio","home","work"] as const satisfies readonly Profile[];
const SHA=/^[a-f0-9]{64}$/;
const OP_ID=/^[A-Za-z0-9_-]{1,128}$/;
const PAUSE_PREFIX="ORPHAN_MAPPING_PAUSE#";
const OWNER_PREFIX="ORPHAN_WORKER_PAUSE_OWNER#";
const key=(pk:string)=>({pk,sk:"STATE" as const});

export interface OrphanPauseClaim {
  pk:string;sk:"STATE";operationId:string;caseId:string;profile:Profile;
  mappingFingerprint:string;workerNameDigest:string;
  phase:"claimed_no_mappings_modified";version:0;claimedAt:string;
  /** False in every phase of this milestone; never execution authority. */
  mappingsDisabled:false;fenceInstalled:false;deletionAuthorized:false;
}
interface PauseOwner {
  pk:string;sk:"STATE";operationId:string;caseId:string;profile:Profile;
  mappingFingerprint:string;claimedAt:string;
}
export interface PauseClaimResult {
  operationId:string;caseId:string;profile:Profile;
  status:"pause_claimed_no_mappings_modified";mappingCount:number;
  mappingChanges:0;fenceInstalled:false;deletionAuthorized:false;
}
export interface PauseClaimReadback {
  found:boolean;owned:boolean;operationId:string;
  phase?:"claimed_no_mappings_modified";mappingsDisabled:false;
  fenceInstalled:false;deletionAuthorized:false;
}
export interface PauseClaimSources {
  db?:Db;
  getOperation?:(id:string)=>Promise<OrphanDeletionOperation|undefined>;
  inventory?:(workerName:string)=>Promise<OrphanWorkerMappingInventory>;
  inspectProfile?:(profile:Profile)=>Promise<{fence?:Record<string,unknown>;leases:Record<string,unknown>[]}>;
  now?:()=>Date;
}
function table():string {
  const name=process.env.STATE_TABLE_NAME?.trim();
  if(!name)throw new OrphanSafetyError("Orphan pause claim requires a state table");
  return name;
}
function workerDigest(name:string):string {
  if(!name||name.length>256||/[\u0000-\u001f]/.test(name))
    throw new OrphanSafetyError("Pause claim requires an exact target worker");
  return createHash("sha256").update(name).digest("hex");
}
function enabled():boolean {
  return process.env.ORPHAN_PAUSE_CLAIM_ENABLED==="true"
    && process.env.ORPHAN_FENCE_STAGING_ENABLED==="true"
    && process.env.ORPHAN_WORKER_INSPECTION_ENABLED==="true"
    && process.env.ERASURE_PROTOCOL_VERSION==="1";
}
function expectConfirmed(op:OrphanDeletionOperation,now:number):void {
  const issued=Date.parse(op.confirmedAt),expiry=Date.parse(op.confirmationExpiresAt);
  if(!OP_ID.test(op.id)||!op.caseId||!PROFILES.includes(op.profile)||
    !["todoist","calendar"].includes(op.side)||!op.targetId||
    op.phase!=="confirmed"||op.version!==0||!SHA.test(op.providerDigest)||
    !op.actorSubject||!op.caseUpdatedAt||!Number.isFinite(issued)||
    !Number.isFinite(expiry)||issued>now||expiry<=now||
    expiry-issued>300000||expiry<=issued||
    (op.side==="calendar"?!op.providerEtag:op.providerEtag!==undefined))
    throw new OrphanSafetyError("Orphan operation changed, is no longer confirmed, or its approval has expired");
}
function expectManifest(m:OrphanFenceManifest|undefined,op:OrphanDeletionOperation,workerName:string):OrphanFenceManifest {
  if(!m||m.operationId!==op.id||m.caseId!==op.caseId||m.profile!==op.profile||
    m.caseUpdatedAt!==op.caseUpdatedAt||m.side!==op.side||
    m.targetId!==op.targetId||m.providerDigest!==op.providerDigest||
    m.status!=="staged"||m.version!==0||m.targetWorkerFunction!==workerName||
    !SHA.test(m.mappingFingerprint)||!Array.isArray(m.mappingIds)||!m.mappingIds.length||
    m.mappingIds.length>100||new Set(m.mappingIds).size!==m.mappingIds.length||
    !Array.isArray(m.originallyEnabledIds)||
    m.mappingIds.join(",")!==m.originallyEnabledIds.join(",")||
    m.mappingIds.join(",")!==[...m.mappingIds].sort().join(",")||
    !Number.isSafeInteger(m.epoch)||m.epoch<0||
    !Number.isInteger(m.timeoutSeconds)||m.timeoutSeconds<1||m.timeoutSeconds>900)
    throw new OrphanSafetyError("Immutable worker mapping manifest is incomplete or no longer belongs to the approval");
  return m;
}
async function stronglyConsistent(db:Db,pk:string):Promise<Record<string,unknown>|undefined> {
  const result=await db.send(new GetCommand({TableName:table(),Key:key(pk),ConsistentRead:true}));
  return result.Item as Record<string,unknown>|undefined;
}
function epochCondition(profile:Profile,epoch:number){
  return {ConditionCheck:{TableName:table(),Key:{pk:"ERASURE#"+profile,sk:"EPOCH"},
    ConditionExpression:epoch===0?"attribute_not_exists(pk) OR #epoch=:expected":"#epoch=:expected",
    ExpressionAttributeNames:{"#epoch":"epoch"},
    ExpressionAttributeValues:{":expected":epoch}}};
}
/**
 * Prepares only an advisory, exclusive pause OWNER (global to the target
 * Lambda, not merely a profile). A positive claim is never evidence that
 * worker leases drained or that any event-source mapping was disabled.
 */
export async function claimOrphanWorkerPause(
  id:string,sources:PauseClaimSources={},
):Promise<PauseClaimResult>{
  if(!enabled())throw new OrphanSafetyError("Exclusive orphan pause-claim staging is disabled");
  if(!OP_ID.test(id))throw new OrphanSafetyError("Invalid orphan operation ID");
  const now=sources.now?.()??new Date();
  if(!Number.isFinite(now.getTime()))throw new OrphanSafetyError("Invalid pause-claim clock");
  const db=sources.db??documentClient;
  const name=process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim()||"";
  const digest=workerDigest(name);
  const op=await (sources.getOperation??(operationId=>new DynamoOrphanJournal(db).get(operationId)))(id);
  if(!op||op.id!==id)throw new OrphanSafetyError("Durable orphan operation was not found");
  expectConfirmed(op,now.getTime());
  const manifest=expectManifest(
    await stronglyConsistent(db,"ORPHAN_FENCE_MANIFEST#"+id) as unknown as OrphanFenceManifest|undefined,
    op,name);
  const inventory=await (sources.inventory??(fn=>inspectOrphanWorkerMappings({
    functionName:fn,now:()=>now,
  })))(name);
  if(!inventory.verified||inventory.blockers.length||
    !SHA.test(inventory.fingerprint||"")||
    inventory.fingerprint!==manifest.mappingFingerprint||
    inventory.mappingCount!==manifest.mappingIds.length||
    inventory.timeoutSeconds!==manifest.timeoutSeconds)
    throw new OrphanSafetyError("Verified worker mapping inventory changed since manifest staging");
  // The advisory owner is not a fence. Always check all three profiles, but
  // repeat the complete drain under a real protocol fence before ANY action.
  for(const profile of PROFILES){
    const state=await (sources.inspectProfile??inspectErasureFence)(profile);
    if(state.fence||!Array.isArray(state.leases)||state.leases.length)
      throw new OrphanSafetyError("An active/unknown profile fence or lease blocks worker pause preparation");
  }
  const epochs:Record<Profile,number>={antonio:0,home:0,work:0};
  for(const profile of PROFILES){
    const result=await db.send(new GetCommand({TableName:table(),
      Key:{pk:"ERASURE#"+profile,sk:"EPOCH"},ConsistentRead:true}));
    const epoch=result.Item?.epoch;
    if(epoch!==undefined&&(!Number.isSafeInteger(epoch)||epoch<0))
      throw new OrphanSafetyError("The erasure epoch is malformed");
    epochs[profile]=epoch??0;
  }
  if(epochs[op.profile]!==manifest.epoch)
    throw new OrphanSafetyError("Erasure epoch advanced since immutable manifest staging");

  // Evidence collection can take time. Do not reserve an expired approval
  // even when the initial preflight was valid.
  const actionTime=sources.now?.()??new Date();
  if(!Number.isFinite(actionTime.getTime()))
    throw new OrphanSafetyError("Invalid action-time pause-claim clock");
  expectConfirmed(op,actionTime.getTime());
  const claimedAt=actionTime.toISOString();
  const ownerPk=OWNER_PREFIX+digest;
  const receipt:OrphanPauseClaim={...key(PAUSE_PREFIX+id),
    operationId:id,caseId:op.caseId,profile:op.profile,
    mappingFingerprint:manifest.mappingFingerprint,workerNameDigest:digest,
    phase:"claimed_no_mappings_modified",version:0,claimedAt,
    mappingsDisabled:false,fenceInstalled:false,deletionAuthorized:false};
  const owner:PauseOwner={...key(ownerPk),operationId:id,caseId:op.caseId,
    profile:op.profile,mappingFingerprint:manifest.mappingFingerprint,claimedAt};
  await db.send(new TransactWriteCommand({TransactItems:[
    {Put:{TableName:table(),Item:receipt,ConditionExpression:"attribute_not_exists(pk)"}},
    {Put:{TableName:table(),Item:owner,ConditionExpression:"attribute_not_exists(pk)"}},
    {ConditionCheck:{TableName:table(),Key:key("ORPHAN_DELETE#"+id),
      ConditionExpression:"#phase=:confirmed AND #version=:zero AND caseId=:caseId AND profile=:profile AND side=:side AND targetId=:target AND providerDigest=:digest AND actorSubject=:actor AND caseUpdatedAt=:caseUpdatedAt AND confirmedAt=:confirmedAt AND confirmationExpiresAt=:expiry"
        +(op.side==="calendar"?" AND providerEtag=:etag":" AND attribute_not_exists(providerEtag)"),
      ExpressionAttributeNames:{"#phase":"phase","#version":"version"},
      ExpressionAttributeValues:{":confirmed":"confirmed",":confirmedAt":op.confirmedAt,":zero":0,":caseId":op.caseId,
        ":profile":op.profile,":side":op.side,":target":op.targetId,
        ":digest":op.providerDigest,":actor":op.actorSubject,
        ":caseUpdatedAt":op.caseUpdatedAt,":expiry":op.confirmationExpiresAt,
        ...(op.side==="calendar"?{":etag":op.providerEtag}:{})}}},
    {ConditionCheck:{TableName:table(),Key:key("ORPHAN_FENCE_MANIFEST#"+id),
      ConditionExpression:"#status=:staged AND #version=:zero AND operationId=:id AND caseId=:caseId AND profile=:profile AND side=:side AND targetId=:target AND providerDigest=:digest AND mappingFingerprint=:fingerprint AND targetWorkerFunction=:worker AND #epoch=:epoch",
      ExpressionAttributeNames:{"#status":"status","#version":"version","#epoch":"epoch"},
      ExpressionAttributeValues:{":staged":"staged",":zero":0,":id":id,
        ":caseId":op.caseId,":profile":op.profile,":side":op.side,
        ":target":op.targetId,":digest":op.providerDigest,
        ":fingerprint":manifest.mappingFingerprint,":worker":name,":epoch":manifest.epoch}}},
    {ConditionCheck:{TableName:table(),Key:key("ORPHAN_CASE_LOCK#"+op.caseId),
      ConditionExpression:"operationId=:id AND caseId=:caseId AND profile=:profile AND side=:side AND targetId=:target AND caseUpdatedAt=:caseVersion",
      ExpressionAttributeValues:{":id":id,":caseId":op.caseId,":profile":op.profile,
        ":side":op.side,":target":op.targetId,":caseVersion":op.caseUpdatedAt}}},
    {ConditionCheck:{TableName:table(),Key:key("REVIEW_CASE#"+op.caseId),
      ConditionExpression:"#status=:open AND updatedAt=:caseVersion AND profile=:profile AND attribute_not_exists(operationId)",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":open":"open",":caseVersion":op.caseUpdatedAt,":profile":op.profile}}},
    ...PROFILES.map(profile=>({ConditionCheck:{TableName:table(),
      Key:{pk:"ERASURE#"+profile,sk:"FENCE"},ConditionExpression:"attribute_not_exists(pk)"}})),
    ...PROFILES.map(profile=>epochCondition(profile,epochs[profile])),
  ]}));
  return {operationId:id,caseId:op.caseId,profile:op.profile,
    status:"pause_claimed_no_mappings_modified",mappingCount:manifest.mappingIds.length,
    mappingChanges:0,fenceInstalled:false,deletionAuthorized:false};
}
/**
 * Operator/recovery readback is allowed when claim creation is disabled.
 * A missing owner or fingerprint mismatch must never be "repaired" by
 * automatic lock release or by replaying mapping changes.
 */
export async function readOrphanWorkerPauseClaim(id:string,
  sources:{db?:Db;workerName?:string}={}):Promise<PauseClaimReadback>{
  if(!OP_ID.test(id))throw new OrphanSafetyError("Invalid orphan pause claim ID");
  const db=sources.db??documentClient;
  const name=sources.workerName??process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim()??"";
  const digest=workerDigest(name);
  const [receipt,owner,manifest]=await Promise.all([
    stronglyConsistent(db,PAUSE_PREFIX+id),
    stronglyConsistent(db,OWNER_PREFIX+digest),
    stronglyConsistent(db,"ORPHAN_FENCE_MANIFEST#"+id),
  ]);
  const claimed=receipt?.operationId===id&&receipt.phase==="claimed_no_mappings_modified"
    &&receipt.version===0&&receipt.mappingsDisabled===false
    &&receipt.fenceInstalled===false&&receipt.deletionAuthorized===false
    &&receipt.workerNameDigest===digest&&receipt.mappingFingerprint===manifest?.mappingFingerprint;
  const owned=Boolean(claimed&&owner?.operationId===id&&owner.caseId===receipt?.caseId
    &&owner.profile===receipt?.profile&&owner.mappingFingerprint===receipt?.mappingFingerprint
    &&manifest?.operationId===id&&manifest.caseId===receipt?.caseId
    &&manifest.profile===receipt?.profile&&manifest.status==="staged");
  return {operationId:id,found:Boolean(receipt),owned,
    ...(claimed?{phase:"claimed_no_mappings_modified" as const}:{}),
    mappingsDisabled:false,fenceInstalled:false,deletionAuthorized:false};
}
