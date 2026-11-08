/**
 * Issue #243: privacy-minimised replay markers and a transaction boundary for
 * a FUTURE operator-confirmed post-write recovery. This module does not
 * authorize recovery on its own. The existing recovery path must remain fenced
 * until every caller of provider/state mutations uses assertReplayAdmission.
 */
import {createHash,createHmac} from "node:crypto";
import {GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import type {Profile} from "./types.js";
import {profiles} from "./config.js";
import { assertRetirementAdmissionIfEnabled } from "./recurrence-retirement-disposition.js";
import type {OrphanDeletionOperation} from "./orphan-deletion-executor.js";

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
const MAX_POSTWRITE_WORKER_MAPPINGS=100;

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
  confirmationId:string;previewFingerprint:string;epoch:number;
};

/** Build marker installation and successful erasure cleanup as one transaction. */
export function atomicConfirmedErasureCompletion(proof:ConfirmedErasureCompletionProof):TransactWriteCommand {
  if(!replayAdmissionEnabled())
    throw new ErasureReplayUnavailableError("Successful erasure cannot release its fence before replay admission is enabled");
  if(!OPERATION_ID.test(proof.operationId)||!REPLAY_PROFILES.includes(proof.profile)
    ||!ID.test(proof.taskId)||!UUID.test(proof.confirmationId)
    ||!Number.isSafeInteger(proof.epoch)||proof.epoch<1||!SHA256.test(proof.previewFingerprint))
    throw new ErasureReplayUnavailableError("Confirmed erasure completion proof is incomplete");
  const ring=keyRing(),table=tableName(),markers:ReplayKey[]=[];
  for(const profile of REPLAY_PROFILES)
    markers.push(marker(profile,"TASK",proof.taskId,ring.current,ring.keys.get(ring.current)!));
  const aliases=proof.knownCalendarAliases||[];
  if(proof.deleteCalendar) {
    if(!proof.eventId||!ID.test(proof.eventId)||!proof.calendarId||!CALENDAR_ID.test(proof.calendarId)
      ||proof.knownCalendarAliasesComplete!==true||!aliases.length||aliases.length>MAX_EVENT_ALIASES
      ||aliases.some(alias=>!alias||!REPLAY_PROFILES.includes(alias.profile)
        ||!CALENDAR_ID.test(alias.calendarId)||!ID.test(alias.eventId))
      ||new Set(aliases.map(alias=>JSON.stringify([alias.profile,alias.calendarId,alias.eventId]))).size!==aliases.length
      ||!aliases.some(alias=>alias.profile===proof.profile&&alias.calendarId===proof.calendarId
        &&alias.eventId===proof.eventId))
      throw new ErasureReplayUnavailableError("Complete exact Calendar aliases are required before replay-safe erasure completion");
    for(const alias of aliases)
      markers.push(marker(alias.profile,"EVENT",alias.eventId,ring.current,ring.keys.get(ring.current)!,alias.calendarId));
  } else if(aliases.length)
    throw new ErasureReplayUnavailableError("Calendar aliases cannot be tombstoned when Calendar deletion was not confirmed");

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
  const tx:any[]=[
    ...markers.map(key=>({Put:{TableName:table,Item:{...key,markerVersion:1},
      ConditionExpression:"attribute_not_exists(pk)"}})),
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

/** Before the first provider delete, require the permanent marker gate and prove
 * no task or explicitly recorded Calendar alias was already erased. */
export async function assertConfirmedErasureReplayAdmission(proof:ConfirmedErasureCompletionProof,
  db:Db=documentClient):Promise<void> {
  atomicConfirmedErasureCompletion(proof); // validates the existing gate, keyring, and complete identity manifest
  const ring=keyRing(),keys:ReplayKey[]=[];
  for(const profile of REPLAY_PROFILES)
    for(const [keyId,secret] of ring.keys)keys.push(marker(profile,"TASK",proof.taskId,keyId,secret));
  if(proof.deleteCalendar)for(const alias of proof.knownCalendarAliases||[])
    for(const [keyId,secret] of ring.keys) {
      keys.push(marker(alias.profile,"EVENT",alias.eventId,keyId,secret,alias.calendarId));
      keys.push(legacyEventMarker(alias.profile,alias.eventId,keyId,secret));
    }
  const unique=[...new Map(keys.map(key=>[`${key.pk}\0${key.sk}`,key])).values()];
  for(const key of unique) {
    let result;
    try {result=await db.send(new GetCommand({TableName:tableName(),Key:key,ConsistentRead:true}));}
    catch {throw new Error("Existing erasure marker readback is unavailable");}
    if(result.Item)throw new ErasureReplayBlockedError();
  }
}

/** Resolve a lost commit acknowledgement without repeating any provider delete. */
export async function verifyConfirmedErasureCompletion(proof:ConfirmedErasureCompletionProof,
  db:Db=documentClient):Promise<boolean> {
  const command=atomicConfirmedErasureCompletion(proof);
  const table=tableName(),ring=keyRing();
  const read=async(key:ReplayKey)=>{
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
  const identities=REPLAY_PROFILES.map(profile=>[...ring.keys].map(([keyId,secret])=>
    marker(profile,"TASK",proof.taskId,keyId,secret)));
  for(const alias of proof.knownCalendarAliases||[])
    identities.push([...ring.keys].map(([keyId,secret])=>
      marker(alias.profile,"EVENT",alias.eventId,keyId,secret,alias.calendarId)));
  for(const candidates of identities) {
    let found=false;
    for(const candidate of candidates) {
      if(await read(candidate)){found=true;break;}
    }
    if(!found)return false;
  }
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
  /** Bounded set of Calendar identities explicitly recorded by this operation.
   * The selected target uses its action-time Calendar ID; other entries may
   * name explicitly recorded historical/profile-move Calendars. This is not
   * a global per-profile inventory. */
  selectedEventId:string;
  selectedCalendarId:string;
  knownCalendarAliases:readonly {profile:Profile;calendarId:string;eventId:string}[];
  /** Complete action-time SQS mapping inventory rechecked by the future
   * privileged worker. Only enabledMappingIds may be resumed; both lists are
   * retained in a separate durable retry record. */
  workerMappings:{mappingIds:readonly string[];enabledMappingIds:readonly string[]};
  journalPresent:boolean;
};
const SHA256=/^[a-f0-9]{64}$/;
const OPERATION_ID=/^[A-Za-z0-9_-]{1,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function postWriteWorkerMappingManifest(value:PostWriteReleaseProof["workerMappings"]):{
  mappingIds:string[];enabledMappingIds:string[];fingerprint:string;
} {
  if(!value||!Array.isArray(value.mappingIds)||!Array.isArray(value.enabledMappingIds)
    ||value.mappingIds.length===0||value.mappingIds.length>MAX_POSTWRITE_WORKER_MAPPINGS
    ||value.mappingIds.some(id=>typeof id!=="string"||!UUID.test(id))
    ||value.enabledMappingIds.some(id=>typeof id!=="string"||!UUID.test(id))
    ||new Set(value.mappingIds).size!==value.mappingIds.length
    ||new Set(value.enabledMappingIds).size!==value.enabledMappingIds.length
    ||value.enabledMappingIds.some(id=>!value.mappingIds.includes(id)))
    throw new ErasureReplayUnavailableError("Complete original worker mapping inventory is required");
  const mappingIds=[...value.mappingIds].sort();
  const enabledMappingIds=[...value.enabledMappingIds].sort();
  const fingerprint=createHash("sha256").update(JSON.stringify({mappingIds,enabledMappingIds})).digest("hex");
  return {mappingIds,enabledMappingIds,fingerprint};
}

export type PostWriteMappingRestoreCompletionProof={
  operationId:string;profile:Profile;epoch:number;mappingIds:readonly string[];
  enabledMappingIds:readonly string[];observedStates:readonly {id:string;state:string}[];verifiedAt:string;
};

/**
 * Build the durable completion receipt only after a fresh AWS read confirms
 * every original mapping has its recorded state. A failed/partial restore
 * leaves the atomic-release retry record in `pending` for a later attempt.
 * This builder does not read or write AWS and is not connected to an executor.
 */
export function completePostWriteMappingRestore(proof:PostWriteMappingRestoreCompletionProof):UpdateCommand {
  if(!proof||!OPERATION_ID.test(proof.operationId)||!REPLAY_PROFILES.includes(proof.profile)
    ||!Number.isSafeInteger(proof.epoch)||proof.epoch<1
    ||typeof proof.verifiedAt!=="string"||!Number.isFinite(Date.parse(proof.verifiedAt))
    ||new Date(proof.verifiedAt).toISOString()!==proof.verifiedAt
    ||!Array.isArray(proof.observedStates))
    throw new ErasureReplayUnavailableError("Worker mapping restoration proof is incomplete");
  const manifest=postWriteWorkerMappingManifest({mappingIds:proof.mappingIds,
    enabledMappingIds:proof.enabledMappingIds});
  if(proof.observedStates.length!==manifest.mappingIds.length
    ||proof.observedStates.some(item=>!item||!manifest.mappingIds.includes(item.id)
      ||!(["Enabled","Disabled"] as string[]).includes(item.state))
    ||new Set(proof.observedStates.map(item=>item.id)).size!==proof.observedStates.length)
    throw new ErasureReplayUnavailableError("Worker mapping verification is incomplete or transitional");
  const enabled=new Set(manifest.enabledMappingIds);
  if(manifest.mappingIds.some(id=>proof.observedStates.find(item=>item.id===id)?.state
    !==(enabled.has(id)?"Enabled":"Disabled")))
    throw new ErasureReplayUnavailableError("Worker mappings do not match their original enabled states");
  return new UpdateCommand({TableName:tableName(),Key:{pk:`ERASURE_POSTWRITE_RESTORE#${proof.operationId}`,sk:"STATE"},
    UpdateExpression:"SET #state=:complete,verifiedAt=:verifiedAt",
    ConditionExpression:"#state=:pending AND operationId=:operationId AND profile=:profile AND epoch=:epoch AND mappingFingerprint=:fingerprint AND mappingIds=:mappingIds AND enabledMappingIds=:enabledMappingIds AND attribute_not_exists(verifiedAt)",
    ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":complete":"complete",
      ":pending":"pending",":verifiedAt":proof.verifiedAt,":operationId":proof.operationId,
      ":profile":proof.profile,":epoch":proof.epoch,":fingerprint":manifest.fingerprint,
      ":mappingIds":manifest.mappingIds,":enabledMappingIds":manifest.enabledMappingIds}});
}

function validatedPostWriteAliases(proof:PostWriteReleaseProof):Array<{profile:Profile;calendarId:string;eventId:string}> {
  const all=proof.knownCalendarAliases;
  if(!Array.isArray(all)||all.length===0||all.length>MAX_EVENT_ALIASES
    ||typeof proof.selectedCalendarId!=="string"||!CALENDAR_ID.test(proof.selectedCalendarId)
    ||all.some(alias=>!alias||!REPLAY_PROFILES.includes(alias.profile as Profile)
      ||typeof alias.calendarId!=="string"||!CALENDAR_ID.test(alias.calendarId)
      ||typeof alias.eventId!=="string"||!ID.test(alias.eventId)))
    throw new ErasureReplayUnavailableError("Bounded known Calendar alias set is required");
  const identities=all.map(alias=>`${alias.profile}\0${alias.calendarId}\0${alias.eventId}`);
  if(new Set(identities).size!==identities.length)
    throw new ErasureReplayUnavailableError("Duplicate known Calendar replay alias");
  const selected=new Set(proof.identity.eventIds);
  const supplied=new Set(all.filter(alias=>alias.profile===proof.identity.profile
    &&alias.calendarId===proof.selectedCalendarId).map(alias=>alias.eventId));
  if(!selected.size||[...selected].some(id=>!supplied.has(id)))
    throw new ErasureReplayUnavailableError("Known Calendar aliases omit a selected source event");
  return [...all];
}

/**
 * Construct a transaction WITHOUT EXECUTING IT. This is a staged contract;
 * the production worker must not call it before independently proving replay
 * admission on every live/qualified writer, action-time full deletion,
 * known-alias completeness, privacy approval and staged failure tests.
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
    ||!proof.identity.taskId||!proof.identity.eventIds.length
    ||typeof proof.selectedEventId!=="string"||!ID.test(proof.selectedEventId)
    ||!proof.identity.eventIds.includes(proof.selectedEventId))
    throw new ErasureReplayUnavailableError("Post-write release proof is incomplete");
  const aliases=validatedPostWriteAliases(proof);
  const workerMappings=postWriteWorkerMappingManifest(proof.workerMappings);
  const ring=keyRing(),secret=ring.keys.get(ring.current)!;
  const keys:ReplayKey[]=[];
  // Todoist IDs are protected across all sync profiles. Calendar aliases are
  // scoped to their own profile to avoid blocking an unrelated calendar.
  for(const profile of REPLAY_PROFILES)
    keys.push(marker(profile,"TASK",proof.identity.taskId,ring.current,secret));
  for(const {profile,eventId,calendarId} of aliases)
    keys.push(marker(profile,"EVENT",eventId,ring.current,secret,calendarId));
  const table=tableName();
  const profileKey=(sk:string)=>({pk:"ERASURE#"+proof.identity.profile,sk});
  const operationValues={
    ":required":"review_required",":reviewed":"reviewed_fenced",":mode":"post_write",
    ":epoch":proof.epoch,":token":proof.confirmationId,":inspected":proof.inspectedFingerprint,
    ":postflight":proof.postflightFingerprint,":original":proof.originalPreviewFingerprint,
    ":reviewedAt":proof.reviewedAt,":profile":proof.identity.profile,":yes":true,
    ":taskId":proof.identity.taskId,":eventId":proof.selectedEventId,":calendarId":proof.selectedCalendarId,
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
      ConditionExpression:"#status=:required AND profile=:profile AND postwriteReview.#status=:reviewed AND postwriteReview.mode=:mode AND postwriteReview.epoch=:epoch AND postwriteReview.confirmationId=:token AND postwriteReview.inspectedFingerprint=:inspected AND postwriteReview.postflightFingerprint=:postflight AND postwriteReview.reviewedAt=:reviewedAt AND previewFingerprint=:original AND updatedAt=:reviewedAt AND selectedActions.deleteTodoist=:yes AND selectedActions.deleteCalendar=:yes AND target.taskId=:taskId AND target.deleteCalendar=:yes AND target.eventId=:eventId AND attribute_exists(actionPlan.todoistTask) AND actionPlan.todoistTask.id=:taskId AND attribute_exists(actionPlan.calendarEvent) AND actionPlan.calendarEvent.id=:eventId AND actionPlan.calendarEvent.calendarId=:calendarId AND attribute_not_exists(recovery)",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:operationValues}},
    // Consumed token (including operator field and TTL already removed) must
    // still match the exact operation, epoch and originally reviewed evidence.
    {Delete:{TableName:table,Key:{pk:"ERASURE_POSTWRITE_CONFIRMATION#"+proof.operationId,sk:"STATE"},
      ConditionExpression:"#status=:consumed AND mode=:mode AND operationId=:id AND profile=:profile AND confirmationId=:token AND inspectedFingerprint=:inspected AND postflightFingerprint=:postflight AND originalPreviewFingerprint=:original AND epoch=:epoch AND attribute_not_exists(expiresAtMs)",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:tokenValues}},
    // Marker installation, fence release and the durable mapping retry record
    // commit atomically. After commit, only originally-enabled mappings may be
    // restored. A failed restore leaves this item pending.
    {Put:{TableName:table,Item:{pk:"ERASURE_POSTWRITE_RESTORE#"+proof.operationId,sk:"STATE",
      schemaVersion:1,operationId:proof.operationId,profile:proof.identity.profile,epoch:proof.epoch,
      state:"pending",mappingIds:workerMappings.mappingIds,
      enabledMappingIds:workerMappings.enabledMappingIds,mappingFingerprint:workerMappings.fingerprint,
      markerKeyId:ring.current,
      createdAt:proof.reviewedAt},ConditionExpression:"attribute_not_exists(pk)"}},
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

/**
 * Resolve an ambiguous TransactWrite acknowledgement without repeating the
 * release. Every read is strongly consistent. `true` means the complete
 * marker/restore/fence transaction committed; partial evidence is never
 * accepted as success. This deliberately does not repair or mutate state.
 */
export async function verifyAtomicReplayRelease(proof:PostWriteReleaseProof,db:Db=documentClient):Promise<boolean> {
  const command=atomicReplayRelease(proof);
  const tx=command.input.TransactItems||[];
  const table=tableName();
  const keys=tx.flatMap(action=>{
    const item=action.Put?.Item||action.Delete?.Key||action.ConditionCheck?.Key;
    if(action.Put?.Item?.pk?.startsWith("ERASURE_REPLAY#"))return [];
    return item?[{pk:String(item.pk),sk:String(item.sk)}]:[];
  });
  // The transaction may have committed immediately before a key rotation.
  // Read its signing key ID from the atomic restore receipt, then verify only
  // that complete key generation instead of probing every historical key.
  const unique=[...new Map(keys.map(key=>[`${key.pk}\0${key.sk}`,key])).values()];
  const rows=new Map<string,Record<string,unknown>>();
  for(const key of unique) {
    let result;
    try { result=await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true})); }
    catch { throw new ErasureReplayUnavailableError("Atomic replay release readback is unavailable"); }
    if(result.Item)rows.set(`${key.pk}\0${key.sk}`,result.Item as Record<string,unknown>);
  }
  const restoreKey=`ERASURE_POSTWRITE_RESTORE#${proof.operationId}\0STATE`;
  const restore=rows.get(restoreKey);
  const manifest=postWriteWorkerMappingManifest(proof.workerMappings);
  if(!restore||restore.operationId!==proof.operationId||restore.profile!==proof.identity.profile
    ||restore.epoch!==proof.epoch||restore.mappingFingerprint!==manifest.fingerprint
    ||JSON.stringify(restore.mappingIds)!==JSON.stringify(manifest.mappingIds)
    ||JSON.stringify(restore.enabledMappingIds)!==JSON.stringify(manifest.enabledMappingIds)
    ||!(restore.state==="pending"||restore.state==="complete")
    ||typeof restore.markerKeyId!=="string")return false;
  const signingKey=keyRing().keys.get(restore.markerKeyId);
  if(!signingKey)return false;
  const markerKeys:ReplayKey[]=REPLAY_PROFILES.map(profile=>
    marker(profile,"TASK",proof.identity.taskId!,restore.markerKeyId as string,signingKey));
  for(const alias of validatedPostWriteAliases(proof))
    markerKeys.push(marker(alias.profile,"EVENT",alias.eventId,restore.markerKeyId as string,
      signingKey,alias.calendarId));
  for(const key of markerKeys) {
    let result;
    try { result=await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true})); }
    catch { throw new ErasureReplayUnavailableError("Atomic replay marker readback is unavailable"); }
    if((result.Item as Record<string,unknown>|undefined)?.markerVersion!==1)return false;
  }
  const absent=[`ERASURE_OPERATION#${proof.operationId}\0STATE`,
    `ERASURE_POSTWRITE_CONFIRMATION#${proof.operationId}\0STATE`,
    `ERASURE#${proof.identity.profile}\0FENCE`];
  if(proof.journalPresent)absent.push(`ERASURE#${proof.identity.profile}\0JOURNAL`);
  if(absent.some(key=>rows.has(key)))return false;
  const epoch=rows.get(`ERASURE#${proof.identity.profile}\0EPOCH`);
  return epoch?.epoch===proof.epoch;
}


/**
 * #287 (staged): a singleton orphan requires its own replay marker transaction.
 * The original post-write two-provider release cannot represent one-sided
 * deletion. Only standalone, exact case-bound targets may be included here.
 *
 * This builder performs NO DDB writes, disables NO workers, and is not connected
 * to the review API or queue. An eventual privileged executor must acquire the
 * profile fence, drain all admissions/writers, recheck provider/state proof and
 * inspect existing markers BEFORE executing the returned transaction.
 *
 * Todoist IDs are global across the configured profiles and are marked in all
 * three. Calendar event IDs are calendar-scoped: only the selected case profile
 * is marked, avoiding collateral suppression of an unrelated calendar.
 */
const ORPHAN_MARKER_PHASES=new Set([
  "fenced","delete_started","provider_absent","state_cleaned",
  "workers_resume_started","observing","succeeded",
]);
function orphanReplayReady():void {
  if(process.env.ORPHAN_DELETION_EXECUTION_ENABLED!=="true" ||
    process.env.ERASURE_PROTOCOL_VERSION!=="1" || !replayAdmissionEnabled())
    throw new ErasureReplayUnavailableError(
      "Orphan replay installation requires independently enabled deletion, protocol and replay-admission gates");
}
function validateOrphanIdentity(op:OrphanDeletionOperation):void {
  if(!OPERATION_ID.test(op.id)||typeof op.caseId!=="string"||!op.caseId.trim()||
    !REPLAY_PROFILES.includes(op.profile)||!["todoist","calendar"].includes(op.side)||
    !ID.test(op.targetId)||!SHA256.test(op.providerDigest)||
    typeof op.actorSubject!=="string"||!op.actorSubject.trim()||
    typeof op.caseUpdatedAt!=="string"||!op.caseUpdatedAt.trim()||
    !Number.isInteger(op.version)||op.version<1||
    (op.side==="calendar" ? !op.providerEtag : op.providerEtag!==undefined))
    throw new ErasureReplayUnavailableError("Incomplete, malformed or cross-provider orphan identity");
}
function orphanKeys(op:OrphanDeletionOperation,kid:string,secret:Buffer):ReplayKey[] {
  return op.side==="todoist"
    ? REPLAY_PROFILES.map(profile=>marker(profile,"TASK",op.targetId,kid,secret))
    : [marker(op.profile,"EVENT",op.targetId,kid,secret,profiles[op.profile].calendarId)];
}
function orphanGuardKey(op:OrphanDeletionOperation):ReplayKey {
  return {pk:"ORPHAN_REPLAY_GUARD#"+op.id,sk:"STATE"};
}
function orphanGuardMatches(guard:Record<string,unknown>|undefined,op:OrphanDeletionOperation,
  ring:KeyRing):guard is Record<string,unknown> {
  return Boolean(guard&&guard.operationId===op.id&&guard.profile===op.profile&&
    guard.side===op.side&&guard.caseId===op.caseId&&
    guard.providerDigest===op.providerDigest&&guard.caseUpdatedAt===op.caseUpdatedAt&&
    guard.markerVersion===1&&guard.markerCount===(op.side==="todoist"?3:1)&&
    typeof guard.keyId==="string"&&ring.keys.has(guard.keyId));
}
/**
 * Construct the complete, single atomic marker install. The transaction
 * checks operation phase/version, case lock, unchanged alert, active profile
 * fence and epoch; it cannot run against a missing or already-retired fence.
 * Marker rows contain NO plaintext provider identities or operation IDs.
 */
export function orphanReplayInstallTransaction(
  op:OrphanDeletionOperation,epoch:number,
):TransactWriteCommand {
  orphanReplayReady();
  validateOrphanIdentity(op);
  if(op.phase!=="fenced"||!Number.isSafeInteger(epoch)||epoch<1)
    throw new ErasureReplayUnavailableError("Orphan marker install requires a fenced operation and a positive epoch");
  const ring=keyRing(),secret=ring.keys.get(ring.current)!;
  const keys=orphanKeys(op,ring.current,secret),table=tableName();
  const tx:any[]=[
    ...keys.map(key=>({Put:{TableName:table,
      Item:{...key,markerVersion:1},ConditionExpression:"attribute_not_exists(pk)"}})),
    {Put:{TableName:table,Item:{...orphanGuardKey(op),
      operationId:op.id,caseId:op.caseId,profile:op.profile,side:op.side,
      caseUpdatedAt:op.caseUpdatedAt,providerDigest:op.providerDigest,
      keyId:ring.current,markerVersion:1,markerCount:keys.length},
      ConditionExpression:"attribute_not_exists(pk)"}},
    {ConditionCheck:{TableName:table,Key:{pk:"ORPHAN_DELETE#"+op.id,sk:"STATE"},
      ConditionExpression:"#phase=:fenced AND #version=:version AND caseId=:case AND profile=:profile AND side=:side AND targetId=:target AND providerDigest=:digest AND actorSubject=:actor AND caseUpdatedAt=:caseVersion"
        +(op.side==="calendar"?" AND providerEtag=:etag":" AND attribute_not_exists(providerEtag)"),
      ExpressionAttributeNames:{"#phase":"phase","#version":"version"},
      ExpressionAttributeValues:{":fenced":"fenced",":version":op.version,
        ":case":op.caseId,":profile":op.profile,":side":op.side,
        ":target":op.targetId,":digest":op.providerDigest,
        ":actor":op.actorSubject,":caseVersion":op.caseUpdatedAt,
        ...(op.side==="calendar"?{":etag":op.providerEtag}:{})}}},
    {ConditionCheck:{TableName:table,Key:{pk:"ORPHAN_CASE_LOCK#"+op.caseId,sk:"STATE"},
      ConditionExpression:"operationId=:id AND caseId=:case AND profile=:profile AND side=:side AND targetId=:target AND caseUpdatedAt=:caseVersion",
      ExpressionAttributeValues:{":id":op.id,":case":op.caseId,":profile":op.profile,
        ":side":op.side,":target":op.targetId,":caseVersion":op.caseUpdatedAt}}},
    {ConditionCheck:{TableName:table,Key:{pk:"REVIEW_CASE#"+op.caseId,sk:"STATE"},
      ConditionExpression:"#status=:open AND updatedAt=:caseVersion AND profile=:profile AND attribute_not_exists(operationId)",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":open":"open",":caseVersion":op.caseUpdatedAt,":profile":op.profile}}},
    {ConditionCheck:{TableName:table,Key:{pk:"ERASURE#"+op.profile,sk:"FENCE"},
      ConditionExpression:"operationId=:id AND #state=:active",
      ExpressionAttributeNames:{"#state":"state"},
      ExpressionAttributeValues:{":id":op.id,":active":"active"}}},
    {ConditionCheck:{TableName:table,Key:{pk:"ERASURE#"+op.profile,sk:"EPOCH"},
      ConditionExpression:"epoch=:epoch",
      ExpressionAttributeValues:{":epoch":epoch}}},
  ];
  if(tx.length>100)throw new ErasureReplayUnavailableError("Orphan replay install exceeds atomic transaction limit");
  return new TransactWriteCommand({TransactItems:tx});
}

/** Strong, read-only replay-guard verification used after the future
 * install transaction, including after worker resumption. It checks the
 * recorded historical key ID so HMAC key rotation cannot invalidate an
 * existing fence. A missing or malformed guard/marker always blocks. */
export async function assertOrphanReplayGuard(op:OrphanDeletionOperation,
  db:Db=documentClient):Promise<void> {
  orphanReplayReady();
  validateOrphanIdentity(op);
  if(!ORPHAN_MARKER_PHASES.has(op.phase))
    throw new ErasureReplayUnavailableError("Orphan replay guard is not available in this operation phase");
  const ring=keyRing(),table=tableName();
  let guard:Record<string,unknown>|undefined;
  try {
    const result=await db.send(new GetCommand({TableName:table,
      Key:orphanGuardKey(op),ConsistentRead:true}));
    guard=result.Item as Record<string,unknown>|undefined;
  } catch {throw new ErasureReplayUnavailableError();}
  if(!orphanGuardMatches(guard,op,ring))
    throw new ErasureReplayUnavailableError("The durable orphan replay guard is missing or mismatched");
  const keyId=guard.keyId as string,secret=ring.keys.get(keyId)!;
  for(const key of orphanKeys(op,keyId,secret)) {
    let row:Record<string,unknown>|undefined;
    try {
      const result=await db.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}));
      row=result.Item as Record<string,unknown>|undefined;
    } catch {throw new ErasureReplayUnavailableError();}
    if(row?.pk!==key.pk||row.sk!==key.sk||row.markerVersion!==1)
      throw new ErasureReplayUnavailableError("The immutable orphan replay marker is missing or malformed");
  }
}
