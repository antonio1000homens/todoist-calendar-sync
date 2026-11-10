/**
 * Current exceptional erasure retains a bounded Todoist project-comment
 * tombstone and writes no permanent DynamoDB replay markers (#349).
 * Keep the existing, disabled HMAC admission reader for compatibility with
 * possible historical marker rows until #347's writer/invocation and rollback
 * boundaries have been independently verified. No HMAC marker writer or staged
 * marker-based fence-release path remains in this module.
 */
import {createHmac} from "node:crypto";
import {GetCommand, TransactWriteCommand, type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import type {Profile} from "./types.js";
import {profiles} from "./config.js";
import { assertRetirementAdmissionIfEnabled } from "./recurrence-retirement-disposition.js";

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
const CALENDAR_ID=/^[^\u0000-\u001f\u007f]{1,1024}$/;
const KEY_ID=/^[A-Za-z0-9_-]{1,32}$/;
const MAX_EVENT_ALIASES=32;
const SHA256=/^[a-f0-9]{64}$/;
const OPERATION_ID=/^[A-Za-z0-9_-]{1,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
function marker(profile:Profile,kind:"TASK"|"EVENT",id:string,keyId:string,secret:Buffer,
  calendarId?:string):ReplayKey {
  // Domain separation prevents a task/event cross-type collision. IDs are never stored or logged.
  if(kind==="EVENT"&&(!calendarId||!CALENDAR_ID.test(calendarId)))
    throw new ErasureReplayUnavailableError("Calendar-scoped replay identity is required");
  const digest=createHmac("sha256",secret)
    .update(JSON.stringify(kind==="EVENT"
      ?["erasure-replay-v2",profile,kind,calendarId,id]
      :["erasure-replay-v1",profile,kind,id])).digest("hex");
  return {pk:`ERASURE_REPLAY#${profile}`,sk:`${kind}#${keyId}#${digest}`};
}
function legacyEventMarker(profile:Profile,id:string,keyId:string,secret:Buffer):ReplayKey {
  const digest=createHmac("sha256",secret)
    .update(JSON.stringify(["erasure-replay-v1",profile,"EVENT",id])).digest("hex");
  return {pk:`ERASURE_REPLAY#${profile}`,sk:`EVENT#${keyId}#${digest}`};
}
function checkKeys(identity:ReplayIdentity,ring:KeyRing):ReplayKey[] {
  const keys:ReplayKey[]=[];
  for(const [kid,secret] of ring.keys) {
    if(identity.taskId)keys.push(marker(identity.profile,"TASK",identity.taskId,kid,secret));
    for(const eventId of identity.eventIds||[]) {
      const calendarId=profiles[identity.profile].calendarId;
      keys.push(marker(identity.profile,"EVENT",eventId,kid,secret,calendarId));
      // Read pre-calendar-scope markers as a compatibility guard. New releases
      // only write the calendar-scoped v2 key.
      keys.push(legacyEventMarker(identity.profile,eventId,kid,secret));
    }
  }
  return keys;
}

export type ConfirmedErasureCompletionProof={
  operationId:string;profile:Profile;taskId:string;deleteCalendar:boolean;
  eventId?:string;calendarId?:string;
  knownCalendarAliases?:readonly {profile:Profile;calendarId:string;eventId:string}[];
  knownCalendarAliasesComplete?:boolean;
  projectCommentIds?:readonly string[];
  confirmationId:string;previewFingerprint:string;epoch:number;
};

/** Atomically retire the operation/fence after the original project comments have been deleted and verified absent. */
export function atomicConfirmedErasureCompletion(proof:ConfirmedErasureCompletionProof):TransactWriteCommand {
  if(!OPERATION_ID.test(proof.operationId)||!REPLAY_PROFILES.includes(proof.profile)
    ||!ID.test(proof.taskId)||!UUID.test(proof.confirmationId)
    ||!Number.isSafeInteger(proof.epoch)||proof.epoch<1||!SHA256.test(proof.previewFingerprint))
    throw new ErasureReplayUnavailableError("Confirmed erasure completion proof is incomplete");
  const table=tableName();
  const commentIds=proof.projectCommentIds||[];
  if(!commentIds.length||commentIds.length>32||commentIds.some(id=>typeof id!=="string"
    ||id.length<1||id.length>256||/[\u0000-\u001f\u007f]/.test(id))
    ||new Set(commentIds).size!==commentIds.length)
    throw new ErasureReplayUnavailableError("An exact original project mapping comment inventory is required before erasure completion");
  const aliases=proof.knownCalendarAliases||[];
  if(proof.deleteCalendar) {
    if(!proof.eventId||!ID.test(proof.eventId)||!proof.calendarId||!CALENDAR_ID.test(proof.calendarId)
      ||proof.knownCalendarAliasesComplete!==true||!aliases.length||aliases.length>MAX_EVENT_ALIASES
      ||aliases.some(alias=>!alias||!REPLAY_PROFILES.includes(alias.profile)
        ||!CALENDAR_ID.test(alias.calendarId)||!ID.test(alias.eventId))
      ||new Set(aliases.map(alias=>JSON.stringify([alias.profile,alias.calendarId,alias.eventId]))).size!==aliases.length
      ||!aliases.some(alias=>alias.profile===proof.profile&&alias.calendarId===proof.calendarId
        &&alias.eventId===proof.eventId))
      throw new ErasureReplayUnavailableError("Complete exact Calendar aliases are required before erasure completion");
  }

  const operationValues:Record<string,unknown>={":verifying":"verifying",":release":"release_fence",":ready":true,
    ":fingerprint":proof.previewFingerprint,":taskId":proof.taskId,":deleteCalendar":proof.deleteCalendar};
  const operationCondition=["#status=:verifying","lifecycle.#phase=:release","providerDeletionReady=:ready",
    "previewFingerprint=:fingerprint","target.taskId=:taskId","selectedActions.deleteTodoist=:ready",
    "selectedActions.deleteCalendar=:deleteCalendar","target.deleteCalendar=:deleteCalendar"];
  if(proof.deleteCalendar) {
    operationValues[":eventId"]=proof.eventId;
    operationValues[":calendarId"]=proof.calendarId;
    operationCondition.push("target.eventId=:eventId","actionPlan.calendarEvent.id=:eventId",
      "actionPlan.calendarEvent.calendarId=:calendarId","actionPlan.knownCalendarAliasesComplete=:ready");
  }
  commentIds.forEach((id,index)=>{
    operationValues[`:comment${index}`]=id;
    operationCondition.push(`contains(actionPlan.projectCommentIds, :comment${index})`);
  });
  const tx:any[]=[
    {Delete:{TableName:table,Key:{pk:`ERASURE_OPERATION#${proof.operationId}`,sk:"STATE"},
      ConditionExpression:operationCondition.join(" AND "),
      ExpressionAttributeNames:{"#status":"status","#phase":"phase"},ExpressionAttributeValues:operationValues}},
    {Delete:{TableName:table,Key:{pk:`ERASURE_CONFIRMATION#${proof.operationId}`,sk:"STATE"},
      ConditionExpression:"#status=:consumed AND operationId=:operationId AND confirmationId=:confirmationId AND consumedBy=:operationId AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":consumed":"consumed",
        ":operationId":proof.operationId,":confirmationId":proof.confirmationId,":fingerprint":proof.previewFingerprint}}},
    {ConditionCheck:{TableName:table,Key:{pk:`ERASURE#${proof.profile}`,sk:"EPOCH"},
      ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":proof.epoch}}},
    {Delete:{TableName:table,Key:{pk:`ERASURE#${proof.profile}`,sk:"FENCE"},
      ConditionExpression:"operationId=:operationId AND #state=:active",
      ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":operationId":proof.operationId,":active":"active"}}},
    {ConditionCheck:{TableName:table,Key:{pk:`ERASURE#${proof.profile}`,sk:"JOURNAL"},
      ConditionExpression:"attribute_not_exists(pk)"}},
  ];
  if(tx.length>100)throw new ErasureReplayUnavailableError("Erasure completion exceeds the atomic transaction limit");
  return new TransactWriteCommand({TransactItems:tx});
}

/** Resolve a lost commit acknowledgement without repeating any provider delete. */
export async function verifyConfirmedErasureCompletion(proof:ConfirmedErasureCompletionProof,
  db:Db=documentClient):Promise<boolean> {
  const command=atomicConfirmedErasureCompletion(proof);
  const table=tableName();
  const read=async(key:{pk:string;sk:string})=>{
    try{return (await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}))).Item;}
    catch {throw new ErasureReplayUnavailableError("Erasure completion readback is unavailable");}
  };
  const [operation,confirmation,fence,epoch,journal]=await Promise.all([
    read({pk:`ERASURE_OPERATION#${proof.operationId}`,sk:"STATE"}),
    read({pk:`ERASURE_CONFIRMATION#${proof.operationId}`,sk:"STATE"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"FENCE"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"EPOCH"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"JOURNAL"}),
  ]);
  if(operation||confirmation||fence||journal||epoch?.epoch!==proof.epoch)return false;
  return true;
}
/** Deployment gate is intentionally OFF until all producer/worker versions
 * participate. Enabling with absent keys never degrades to allow. This gate
 * MUST become permanently ON before any markers/fence releases go live.
 */
export function replayAdmissionEnabled():boolean {
  const version=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  if(version===undefined||version===""||version==="0")return false;
  if(version==="1") {
    if(process.env.ERASURE_PROTOCOL_VERSION!=="1")
      throw new ErasureReplayUnavailableError("Erasure replay admission requires the profile writer/admission lease protocol");
    return true;
  }
  throw new ErasureReplayUnavailableError("Unrecognised erasure replay barrier version");
}
/**
 * Staged integration hook. With protocol v1 enabled, every indicated identity
 * is checked, including existing-state mutations (not only object creation).
 * Never swallow a marker or a missing-key error as a nonmatching identity.
 */
export async function assertReplayAdmissionIfEnabled(identity:ReplayIdentity,db:Db=documentClient):Promise<void> {
  // Retirement exclusions are independent of the staged erasure barrier.
  // Enforce them on ALL state mutations even if erasure replay is disabled.
  await assertRetirementAdmissionIfEnabled(identity,db);
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
  if(process.env.ERASURE_PROTOCOL_VERSION!=="1")
    throw new ErasureReplayUnavailableError("Erasure replay admission requires the profile writer/admission lease protocol");
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
