/**
 * Issue #243: privacy-minimised replay markers and a transaction boundary for
 * a FUTURE operator-confirmed post-write recovery. This module does not
 * authorize recovery on its own. The existing recovery path must remain fenced
 * until every caller of provider/state mutations uses assertReplayAdmission.
 */
import {createHmac} from "node:crypto";
import {GetCommand, TransactWriteCommand, type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import type {Profile} from "./types.js";

export const REPLAY_PROFILES = ["home","antonio","work"] as const satisfies readonly Profile[];
export type ReplayIdentity = {
  profile:Profile;
  taskId?:string;
  eventIds?:readonly string[];
};
type Db = Pick<DynamoDBDocumentClient,"send">;
type ReplayKey = {pk:string;sk:string};
type KeyRing = {current:string;keys:Map<string,Buffer>};
const ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const KEY_ID=/^[A-Za-z0-9_-]{1,32}$/;
const MAX_EVENT_ALIASES=32;

export class ErasureReplayBlockedError extends Error {
  constructor() {
    super("Erasure replay admission refused; an immutable erasure marker is present");
    this.name="ErasureReplayBlockedError";
  }
}
export class ErasureReplayUnavailableError extends Error {
  constructor(message="Erasure replay admission is unavailable; provider and mapping writes must fail closed") {
    super(message);
    this.name="ErasureReplayUnavailableError";
  }
}
function tableName():string {
  if(!process.env.STATE_TABLE_NAME)throw new ErasureReplayUnavailableError();
  return process.env.STATE_TABLE_NAME;
}
/** Old verification keys must NOT be retired: historical HMAC digests cannot be re-keyed without erased IDs. */
function keyRing():KeyRing {
  const current=process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY;
  const encoded=process.env.ERASURE_REPLAY_HMAC_KEYS;
  if(!current||!KEY_ID.test(current)||!encoded)throw new ErasureReplayUnavailableError();
  let parsed:unknown;
  try { parsed=JSON.parse(encoded); } catch { throw new ErasureReplayUnavailableError(); }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new ErasureReplayUnavailableError();
  const entries=Object.entries(parsed);
  if(!entries.length||entries.length>16)throw new ErasureReplayUnavailableError();
  const keys=new Map<string,Buffer>();
  for(const [id,base64] of entries) {
    if(!KEY_ID.test(id)||typeof base64!=="string")throw new ErasureReplayUnavailableError();
    const decoded=Buffer.from(base64,"base64");
    if(decoded.length<32||decoded.length>128
      ||decoded.toString("base64").replace(/=+$/,"")!==base64.replace(/=+$/,""))
      throw new ErasureReplayUnavailableError();
    keys.set(id,decoded);
  }
  if(!keys.has(current))throw new ErasureReplayUnavailableError();
  return {current,keys};
}
function validate(identity:ReplayIdentity):void {
  if(!REPLAY_PROFILES.includes(identity.profile)
    ||(!identity.taskId&&!identity.eventIds?.length)
    ||(identity.taskId!==undefined&&!ID.test(identity.taskId))
    ||(identity.eventIds?.length||0)>MAX_EVENT_ALIASES
    ||identity.eventIds?.some(id=>!ID.test(id))
    ||new Set(identity.eventIds||[]).size!==(identity.eventIds?.length||0))
    throw new ErasureReplayUnavailableError("Unresolved or malformed identity; replay admission refused");
}
function marker(profile:Profile,kind:"TASK"|"EVENT",id:string,keyId:string,secret:Buffer):ReplayKey {
  // Domain separation prevents a task/event cross-type collision. IDs are never stored or logged.
  const digest=createHmac("sha256",secret)
    .update(JSON.stringify(["erasure-replay-v1",profile,kind,id])).digest("hex");
  return {pk:`ERASURE_REPLAY#${profile}`,sk:`${kind}#${keyId}#${digest}`};
}
function checkKeys(identity:ReplayIdentity,ring:KeyRing):ReplayKey[] {
  const keys:ReplayKey[]=[];
  for(const [kid,secret] of ring.keys) {
    if(identity.taskId)keys.push(marker(identity.profile,"TASK",identity.taskId,kid,secret));
    for(const eventId of identity.eventIds||[])keys.push(marker(identity.profile,"EVENT",eventId,kid,secret));
  }
  return keys;
}
/** Deployment gate is intentionally OFF until all producer/worker versions
 * participate. Enabling with absent keys never degrades to allow. This gate
 * MUST become permanently ON before any markers/fence releases go live.
 */
export function replayAdmissionEnabled():boolean {
  const version=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  if(version===undefined||version===""||version==="0")return false;
  if(version==="1")return true;
  throw new ErasureReplayUnavailableError("Unrecognised erasure replay barrier version");
}
/**
 * Staged integration hook. With protocol v1 enabled, every indicated identity
 * is checked, including existing-state mutations (not only object creation).
 * Never swallow a marker or a missing-key error as a nonmatching identity.
 */
export async function assertReplayAdmissionIfEnabled(identity:ReplayIdentity,db:Db=documentClient):Promise<void> {
  if(!replayAdmissionEnabled())return;
  await assertReplayAdmission(identity,db);
}
/** Resolved recurrence aliases are protected alongside primary event IDs. */
export function mappingReplayIdentity(mapping:{
  profile:Profile;taskId:string;eventId:string;masterEventId?:string;activeInstanceId?:string;
}):ReplayIdentity {
  return {profile:mapping.profile,taskId:mapping.taskId,
    eventIds:[...new Set([mapping.eventId,mapping.masterEventId,mapping.activeInstanceId]
      .filter((id):id is string=>typeof id==="string"&&id.length>0))]};
}

/**
 * Strongly consistent admission check for a known task/event/series alias.
 * Every provider mutation, durable mapping write and fresh ingress path must
 * call this with ALL known identities, while holding its profile writer lease.
 * An unconfigured keyring or failed DynamoDB read MUST reject the operation.
 */
export async function assertReplayAdmission(identity:ReplayIdentity,db:Db=documentClient):Promise<void> {
  validate(identity);
  const ring=keyRing(),table=tableName();
  const keys=checkKeys(identity,ring);
  // Sequential reads are intentional: stop immediately on a marker; there is
  // never a permissive cache or an eventually-consistent batch lookup.
  for(const key of keys) {
    let result;
    try { result=await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true})); }
    catch { throw new ErasureReplayUnavailableError(); }
    if(result.Item)throw new ErasureReplayBlockedError();
  }
}
export type PostWriteReleaseProof = {
  operationId:string;
  epoch:number;
  /** Must be produced by a distinct, consumed, operator-approved post-write flow. */
  confirmationId:string;
  recoveryFingerprint:string;
  postflightFingerprint:string;
  /** Exact reviewed alias inventory; all selected Calendar aliases must have been deleted. */
  identity:ReplayIdentity & {taskId:string};
  journalPresent:boolean;
};
function proofText(value:string):boolean {return typeof value==="string"&&value.length>=8&&value.length<=256;}
/**
 * Constructs (but does not execute) the ONLY valid marker + fence release
 * transaction for fully deleted post-write operations.
 *
 * All external postflight, alias, mapping and lease verification is the
 * responsibility of the future trusted recovery worker. The transaction
 * deliberately requires NEW post-write state/confirmation attributes absent
 * from the existing pre-write recovery, so it cannot be used to bypass it.
 */
export function atomicReplayRelease(proof:PostWriteReleaseProof):TransactWriteCommand {
  validate(proof.identity);
  if(!proofText(proof.operationId)||!Number.isSafeInteger(proof.epoch)||proof.epoch<1
    ||![proof.confirmationId,proof.recoveryFingerprint,proof.postflightFingerprint].every(proofText)
    ||proof.identity.eventIds?.length===0)
    throw new ErasureReplayUnavailableError("Post-write release proof is incomplete");
  const ring=keyRing(),secret=ring.keys.get(ring.current)!;
  const pairs:ReplayKey[]=[];
  // Every profile is fenced against re-admission of this Todoist task, including
  // cross-project/profile moves. Event IDs are scoped to their calendar profile
  // so an unrelated profile's coincidentally equal Calendar ID is not removed.
  for(const profile of REPLAY_PROFILES)
    pairs.push(marker(profile,"TASK",proof.identity.taskId,ring.current,secret));
  for(const eventId of proof.identity.eventIds||[])
    pairs.push(marker(proof.identity.profile,"EVENT",eventId,ring.current,secret));
  const table=tableName();
  const profileKey=(sk:string)=>({pk:`ERASURE#${proof.identity.profile}`,sk});
  const values={":id":proof.operationId,":epoch":proof.epoch,":review":"review_required",
    ":verifying":"verifying",":mode":"post_write",
    ":confirmationId":proof.confirmationId,":fingerprint":proof.recoveryFingerprint,
    ":postflight":proof.postflightFingerprint};
  const tx:any[]=[
    ...pairs.map(key=>({Put:{TableName:table,Item:{...key,markerVersion:1},
      ConditionExpression:"attribute_not_exists(pk)"}})),
    // Preserve immutable review_required evidence until the independently verified
    // postflight. Then remove the identity-bearing operation and consumed token
    // in the SAME transaction that installs markers and drops the fence.
    {Delete:{TableName:table,Key:{pk:`ERASURE_OPERATION#${proof.operationId}`,sk:"STATE"},
      ConditionExpression:"#status=:review AND recovery.#status=:verifying AND recovery.mode=:mode AND recovery.epoch=:epoch AND recovery.confirmationId=:confirmationId AND recovery.fingerprint=:fingerprint AND recovery.postflightFingerprint=:postflight",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:values}},
    {Delete:{TableName:table,Key:{pk:`ERASURE_POSTWRITE_CONFIRMATION#${proof.operationId}`,sk:"STATE"},
      ConditionExpression:"#status=:consumed AND operationId=:id AND confirmationId=:confirmationId AND inspectedFingerprint=:fingerprint AND postflightFingerprint=:postflight",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{...values,":consumed":"consumed"}}},
    {ConditionCheck:{TableName:table,Key:profileKey("EPOCH"),
      ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":proof.epoch}}},
    {Delete:{TableName:table,Key:profileKey("FENCE"),
      ConditionExpression:"operationId=:id AND #state=:active",
      ExpressionAttributeNames:{"#state":"state"},
      ExpressionAttributeValues:{":id":proof.operationId,":active":"active"}}},
    proof.journalPresent
      ?{Delete:{TableName:table,Key:profileKey("JOURNAL"),
        ConditionExpression:"operationId=:id",ExpressionAttributeValues:{":id":proof.operationId}}}
      :{ConditionCheck:{TableName:table,Key:profileKey("JOURNAL"),
        ConditionExpression:"attribute_not_exists(pk)"}},
  ];
  // A single DynamoDB transaction is required: never write markers and release
  // the fence in separate requests or accept a partially successful page.
  if(tx.length>100)throw new ErasureReplayUnavailableError();
  return new TransactWriteCommand({TransactItems:tx});
}
