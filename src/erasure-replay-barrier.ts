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
/**
 * Prospective post-write release transaction inputs.
 *
 * This shape is deliberately stronger than the reviewed-fenced token created
 * by #304. A future privileged worker must independently re-read every
 * provider/profile and obtain a complete, strongly verified alias manifest
 * before it may construct this proof. It is NOT an authorization to execute.
 */
export type PostWriteReleaseProof = {
  operationId:string;
  epoch:number;
  confirmationId:string;
  /** Matched with the persisted postwriteReview and single-use consumed token. */
  inspectedFingerprint:string;
  postflightFingerprint:string;
  originalPreviewFingerprint:string;
  /** The original atomic review timestamp also becomes operation.updatedAt. */
  reviewedAt:string;
  identity:ReplayIdentity & {taskId:string;eventIds:readonly string[]};
  /** Exhaustive per-profile Calendar aliases, independently verified by a
   * future privileged worker. Empty arrays require proof of absence, not
   * merely missing keys. Aliases for the source profile must match eventIds. */
  calendarAliases:Record<Profile,readonly string[]>;
  journalPresent:boolean;
};
const SHA256=/^[a-f0-9]{64}$/;
const OPERATION_ID=/^[A-Za-z0-9_-]{1,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatedPostWriteAliases(proof:PostWriteReleaseProof):Array<{profile:Profile;eventId:string}> {
  const aliases=proof.calendarAliases;
  if(!aliases||typeof aliases!=="object"||Array.isArray(aliases)
    ||Object.keys(aliases).length!==REPLAY_PROFILES.length
    ||Object.keys(aliases).some(key=>!REPLAY_PROFILES.includes(key as Profile)))
    throw new ErasureReplayUnavailableError("Complete Calendar alias inventory is required for every profile");
  const all:Array<{profile:Profile;eventId:string}>=[];
  for(const profile of REPLAY_PROFILES) {
    const items=aliases[profile];
    if(!Array.isArray(items)||items.length>MAX_EVENT_ALIASES
      ||items.some(id=>typeof id!=="string"||!ID.test(id))
      ||new Set(items).size!==items.length)
      throw new ErasureReplayUnavailableError("Invalid Calendar replay aliases");
    for(const eventId of items)all.push({profile,eventId});
  }
  const selected=new Set(proof.identity.eventIds);
  const supplied=new Set(aliases[proof.identity.profile]);
  if(!selected.size||selected.size!==supplied.size
    ||[...selected].some(id=>!supplied.has(id)))
    throw new ErasureReplayUnavailableError("Selected Calendar aliases differ from the reviewed source inventory");
  return all;
}

/**
 * Construct a transaction WITHOUT EXECUTING IT. This is a staged contract;
 * the production worker must not call it before independently proving replay
 * admission on every live/qualified writer, action-time full deletion,
 * cross-profile alias completeness, privacy approval and staged failure tests.
 *
 * No executor, API route, queue command or deployment switch currently calls
 * this function. All markers, proof removal and fence cleanup are atomic.
 */
export function atomicReplayRelease(proof:PostWriteReleaseProof):TransactWriteCommand {
  validate(proof.identity);
  if(!OPERATION_ID.test(proof.operationId)||!UUID.test(proof.confirmationId)
    ||!Number.isSafeInteger(proof.epoch)||proof.epoch<1
    ||![proof.inspectedFingerprint,proof.postflightFingerprint,
      proof.originalPreviewFingerprint].every(value=>typeof value==="string"&&SHA256.test(value))
    ||typeof proof.reviewedAt!=="string"
    ||!Number.isFinite(Date.parse(proof.reviewedAt))
    ||new Date(proof.reviewedAt).toISOString()!==proof.reviewedAt
    ||typeof proof.journalPresent!=="boolean"
    ||!proof.identity.taskId||!proof.identity.eventIds.length)
    throw new ErasureReplayUnavailableError("Post-write release proof is incomplete");
  const aliases=validatedPostWriteAliases(proof);
  const ring=keyRing(),secret=ring.keys.get(ring.current)!;
  const keys:ReplayKey[]=[];
  // Todoist IDs are protected across all sync profiles. Calendar aliases are
  // scoped to their own profile to avoid blocking an unrelated calendar.
  for(const profile of REPLAY_PROFILES)
    keys.push(marker(profile,"TASK",proof.identity.taskId,ring.current,secret));
  for(const {profile,eventId} of aliases)
    keys.push(marker(profile,"EVENT",eventId,ring.current,secret));
  const table=tableName();
  const profileKey=(sk:string)=>({pk:"ERASURE#"+proof.identity.profile,sk});
  const operationValues={
    ":required":"review_required",":reviewed":"reviewed_fenced",":mode":"post_write",
    ":epoch":proof.epoch,":token":proof.confirmationId,":inspected":proof.inspectedFingerprint,
    ":postflight":proof.postflightFingerprint,":original":proof.originalPreviewFingerprint,
    ":reviewedAt":proof.reviewedAt,":profile":proof.identity.profile,":yes":true,
  };
  const tokenValues={
    ":consumed":"consumed",":mode":"post_write",":id":proof.operationId,
    ":profile":proof.identity.profile,":token":proof.confirmationId,
    ":inspected":proof.inspectedFingerprint,":postflight":proof.postflightFingerprint,
    ":original":proof.originalPreviewFingerprint,":epoch":proof.epoch,
  };
  const tx:any[]=[
    ...keys.map(key=>({Put:{TableName:table,Item:{...key,markerVersion:1},
      ConditionExpression:"attribute_not_exists(pk)"}})),
    // #304 atomically writes postwriteReview, NOT recovery. Check precisely
    // the saved reviewed_fenced fields and original selection before deletion.
    {Delete:{TableName:table,Key:{pk:"ERASURE_OPERATION#"+proof.operationId,sk:"STATE"},
      ConditionExpression:"#status=:required AND profile=:profile AND postwriteReview.#status=:reviewed AND postwriteReview.mode=:mode AND postwriteReview.epoch=:epoch AND postwriteReview.confirmationId=:token AND postwriteReview.inspectedFingerprint=:inspected AND postwriteReview.postflightFingerprint=:postflight AND postwriteReview.reviewedAt=:reviewedAt AND previewFingerprint=:original AND updatedAt=:reviewedAt AND selectedActions.deleteTodoist=:yes AND selectedActions.deleteCalendar=:yes AND target.deleteCalendar=:yes AND attribute_exists(actionPlan.todoistTask) AND attribute_exists(actionPlan.calendarEvent) AND attribute_not_exists(recovery)",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:operationValues}},
    // Consumed token (including operator field and TTL already removed) must
    // still match the exact operation, epoch and originally reviewed evidence.
    {Delete:{TableName:table,Key:{pk:"ERASURE_POSTWRITE_CONFIRMATION#"+proof.operationId,sk:"STATE"},
      ConditionExpression:"#status=:consumed AND mode=:mode AND operationId=:id AND profile=:profile AND confirmationId=:token AND inspectedFingerprint=:inspected AND postflightFingerprint=:postflight AND originalPreviewFingerprint=:original AND epoch=:epoch AND attribute_not_exists(expiresAtMs)",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:tokenValues}},
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
  // DynamoDB transactions max out at 100 actions. Never fall back to a
  // partially committed batch or release a fence in multiple requests.
  if(tx.length>100)throw new ErasureReplayUnavailableError("Replay release exceeds the atomic transaction limit");
  return new TransactWriteCommand({TransactItems:tx});
}
