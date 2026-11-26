/** Exact identity helpers retained for the legacy cutover and exclusion paths. */
import {GetCommand, TransactWriteCommand, type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import type {Profile} from "./types.js";

export const REPLAY_PROFILES = ["home","antonio","work"] as const satisfies readonly Profile[];
export type ReplayIdentity = {
  profile:Profile;
  taskId?:string;
  eventIds?:readonly string[];
};
type Db=Pick<DynamoDBDocumentClient,"send">;
const ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const CALENDAR_ID=/^[^\u0000-\u001f\u007f]{1,1024}$/;
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
    {Delete:{TableName:table,Key:{pk:`ERASURE#${proof.profile}`,sk:"SCOPED_ADMISSION"},
      ConditionExpression:"exclusiveOwner=:operationId AND (attribute_not_exists(grants) OR size(grants)=:zero)",
      ExpressionAttributeValues:{":operationId":proof.operationId,":zero":0}}},
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
  const [operation,confirmation,fence,epoch,journal,scopedAdmission]=await Promise.all([
    read({pk:`ERASURE_OPERATION#${proof.operationId}`,sk:"STATE"}),
    read({pk:`ERASURE_CONFIRMATION#${proof.operationId}`,sk:"STATE"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"FENCE"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"EPOCH"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"JOURNAL"}),
    read({pk:`ERASURE#${proof.profile}`,sk:"SCOPED_ADMISSION"}),
  ]);
  if(operation||confirmation||fence||journal||scopedAdmission||epoch?.epoch!==proof.epoch)return false;
  return true;
}


/** Explicitly configured retirement exclusions remain independent of sync admission. */
export async function assertReplayAdmissionIfEnabled(identity:ReplayIdentity,db:Db=documentClient):Promise<void> {
  // Legacy call sites are retired. Keep the helper temporarily so rolling
  // migration code can be removed without making provider identity writes
  // depend on permanent per-item markers.
  void identity;
  void db;
}

/** Normalise all exact known Calendar recurrence aliases for callers. */
export function mappingReplayIdentity(mapping:{
  profile:Profile;taskId:string;eventId:string;masterEventId?:string;activeInstanceId?:string;
}):ReplayIdentity {
  return {profile:mapping.profile,taskId:mapping.taskId,
    eventIds:[...new Set([mapping.eventId,mapping.masterEventId,mapping.activeInstanceId]
      .filter((id):id is string=>typeof id==="string"&&id.length>0))]};
}
