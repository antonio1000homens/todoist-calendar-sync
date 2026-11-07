/**
 * #369 Guarded recovery from a failed, unapplied repair of a deleted Calendar
 * projection. Not a generic audit/repair purge. No task or Calendar deletes.
 */
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { ReviewStore } from "./review-store.js";
import { operationHasWriteEvidence, entityKey, type RepairOperation, type ReviewCase, type EntityRef } from "./review-types.js";
import { assertReplayAdmissionIfEnabled } from "./erasure-replay-barrier.js";
import { todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import type { Profile, Mapping, TodoistTask, CalendarEvent } from "./types.js";
import type { StateRepository } from "./repository.js";
import type { GoogleCalendar, Todoist } from "./providers.js";

const profiles: Profile[] = ["home","antonio","work"];
const key = (pk:string, sk="STATE") => ({pk,sk});
const typed = (r:EntityRef) => entityKey(r);
const validDate = (v:unknown) => typeof v==="string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v+"T00:00:00Z"));
const conditionConflict = (error:unknown) => (error as {name?:string}).name==="TransactionCanceledException"
  || (error as {name?:string}).name==="ConditionalCheckFailedException";

export function annualRecoveryCandidate(
  profile:Profile, task:TodoistTask, mapping:Mapping, operation:RepairOperation, reviewCase:ReviewCase,
): boolean {
  if (!profiles.includes(profile) || task.is_deleted || task.is_completed
    || task.due?.is_recurring !== true || !validDate(task.due.date)
    || task.due.datetime || todoistRecurrenceToRrule(task)!=="RRULE:FREQ=YEARLY"
    || !task.updated_at || !Number.isFinite(Date.parse(task.updated_at))
    || task.id!==mapping.taskId || mapping.profile!==profile
    || mapping.recurrenceOwner || mapping.seriesId || mapping.masterEventId || mapping.activeInstanceId
    || !mapping.updatedAt || !(Date.parse(task.updated_at)>Date.parse(mapping.updatedAt))) return false;
  if (operation.status!=="failed" || operation.abandoned || operation.nonResumable
    || operation.writeStarted || operationHasWriteEvidence(operation)
    || operation.steps?.validated?.status!=="done"
    || Object.keys(operation.steps||{}).some(step=>step!=="validated")
    || !operation.updatedAt || Date.parse(task.updated_at)<=Date.parse(operation.updatedAt)
    || operation.preview?.intent?.profile!==profile
    || operation.preview.intent.taskId!==task.id
    || operation.preview.intent.caseId!==reviewCase.id
    || operation.preview.case?.id!==reviewCase.id
    || reviewCase.status!=="dismissed" || reviewCase.profile!==profile
    || reviewCase.operationId!==operation.id) return false;
  const snapshots=operation.preview.snapshots;
  if (!Array.isArray(snapshots) || snapshots.length<2 || snapshots.length>15
    || snapshots.some(s=>!s?.ref?.id || s.ref.profile!==profile || s.lookupError)
    || new Set(snapshots.map(s=>typed(s.ref))).size!==snapshots.length
    || !snapshots.some(s=>s.ref.side==="todoist" && s.ref.id===task.id
      && s.object && (s.object as TodoistTask).due?.is_recurring!==true)
    || !snapshots.some(s=>s.ref.side==="calendar"
      && s.ref.id===operation.preview.intent.eventId)) return false;
  return true;
}

/** A fully approved plan is bound to the caller-owned task write fence. */
export interface AnnualRecoveryInput {
  profile:Profile; task:TodoistTask; mapping:Mapping; operationId:string; writeToken:string;
  state:StateRepository;
  calendar:Pick<GoogleCalendar,"getEvent"|"listLinkedEventsByTodoistTaskId"|"listExplicitSeriesExceptions">;
  todoist:Pick<Todoist,"getTask">;
}
export async function attemptCancelledAnnualRecovery(
  input:AnnualRecoveryInput,
  deps: {db?:Pick<typeof documentClient,"send">; review?:ReviewStore; now?:()=>Date}={},
):Promise<boolean> {
  const {profile,task,mapping,operationId,writeToken,state,calendar,todoist}=input;
  const db=deps.db||documentClient, review=deps.review||new ReviewStore(db);
  if (!process.env.STATE_TABLE_NAME || !operationId || !writeToken || !mapping || mapping.profile!==profile) return false;
  const table=process.env.STATE_TABLE_NAME;
  const operation=await review.getOperation(operationId);
  const reviewCase=operation?.preview?.intent?.caseId
    ? await review.getCase(operation.preview.intent.caseId) : undefined;
  if (!operation || !reviewCase || !annualRecoveryCandidate(profile,task,mapping,operation,reviewCase)) return false;
  const refs=operation.preview.snapshots.map(s=>s.ref);
  const oldCalendarIds=[...new Set([...refs.filter(r=>r.side==="calendar").map(r=>r.id),mapping.eventId])];
  if (oldCalendarIds.length>15) return false;
  // A stale source webhook, active completed history, third-party mapping,
  // explicit exclusion, pending erasure or a surviving Calendar identity stop.
  await assertReplayAdmissionIfEnabled({profile,taskId:task.id,eventIds:oldCalendarIds});
  if (await state.isRetired({profile,taskId:task.id,eventIds:oldCalendarIds})) return false;
  if (await state.getCalendarProjectionTombstone(profile,task.id)) return false;
  if (await state.getRecurrenceLinkByTaskAnyProfile(task.id)) return false;
  if ((await state.listCompletedCalendarProjectionsByTaskAnyProfile(task.id)).length) return false;
  if (await review.hasActiveDeletionGuard(profile,"todoist",task.id)) return false;
  // An independent open review case may own the same identity even without a
  // DELETION_REVIEW guard. Check every bounded open-case page, never title/date.
  let caseCursor:Record<string,unknown>|undefined;
  let openCaseComplete=false;
  for(let pageNum=0;pageNum<20;pageNum++) {
    const page=await review.listCases(profile,caseCursor,false,50);
    if(page.items.some(item=>(item.status==="open"||item.status==="repairing")
      && (item.taskId===task.id || (item.eventId!==undefined && oldCalendarIds.includes(item.eventId))))) return false;
    caseCursor=page.cursor as Record<string,unknown>|undefined;
    if(!caseCursor){openCaseComplete=true;break;}
  }
  if(!openCaseComplete) return false;
  for (const other of profiles) {
    const current=await state.getMappingByTask(other,task.id);
    if (other!==profile && current) return false;
    if (other===profile && (!current || current.eventId!==mapping.eventId || current.updatedAt!==mapping.updatedAt)) return false;
  }
  for (const id of oldCalendarIds) {
    if (await state.getCompletedCalendarProjectionByEvent(profile,id)) return false;
    if (await review.hasActiveDeletionGuard(profile,"calendar",id)) return false;
  }

  // Full typed source inventory: this method pages even cancelled events.
  const linked=await calendar.listLinkedEventsByTodoistTaskId(task.id);
  if (!Array.isArray(linked) || linked.some(e=>e.status!=="cancelled")) return false;
  const observed=new Map<string,CalendarEvent>();
  for (const id of oldCalendarIds) {
    const item=await calendar.getEvent(id); // 404/410 and provider errors fail closed
    if (!item || item.id!==id || item.status!=="cancelled") return false;
    observed.set(id,item);
  }
  // A cancelled master can still have a separately confirmed future exception.
  for (const id of oldCalendarIds) {
    const original=operation.preview.snapshots.find(s=>s.ref.side==="calendar"&&s.ref.id===id)?.object as CalendarEvent|undefined;
    if (!original?.recurrence?.length) continue;
    const exceptions=await calendar.listExplicitSeriesExceptions(id);
    if (!Array.isArray(exceptions) || exceptions.some(e=>
      e.status!=="cancelled" && (!e.originalStartTime
        || !("date" in e.originalStartTime || "dateTime" in e.originalStartTime)
        || !Number.isFinite(Date.parse(e.originalStartTime.dateTime || e.originalStartTime.date || ""))
        || Date.parse(e.originalStartTime.dateTime || e.originalStartTime.date || "")>=Date.now()-86400000))) return false;
  }
  // One final source read before the guarded transaction; never apply an old
  // due/recurrence from a webhook after the user changes the task again.
  const current=await todoist.getTask(task.id);
  if (!current || current.id!==task.id || current.updated_at!==task.updated_at
    || current.project_id!==task.project_id || current.due?.date!==task.due?.date
    || !current.due?.is_recurring || todoistRecurrenceToRrule(current)!=="RRULE:FREQ=YEARLY"
    || current.is_completed || current.is_deleted) return false;
  const read=async (pk:string,sk="STATE") => (await db.send(new GetCommand({TableName:table,Key:key(pk,sk),ConsistentRead:true}))).Item as Record<string,unknown>|undefined;
  const [taskMap,ownerMap,eventMap,baseline,reset,otherReceipt]=await Promise.all([
    read("TASK#"+profile+"#"+task.id,"MAP"),read("TASKOWNER#"+task.id,"MAP"),
    read("EVENT#"+profile+"#"+mapping.eventId,"MAP"),
    read("BASELINE#"+profile+"#TASK#"+task.id,"RECONCILE"),
    read("ANNUAL_RECOVERY#"+profile+"#"+task.id),read("REJECTED_PAIR#"+profile+"#"+task.id+"#"+mapping.eventId),
  ]);
  if (reset || otherReceipt || !taskMap || !ownerMap || !eventMap) return false;
  const maps=[taskMap,ownerMap,eventMap];
  if (maps.some(row=>row.taskId!==task.id || row.eventId!==mapping.eventId
    || row.profile!==profile || row.updatedAt!==mapping.updatedAt
    || row.recurrenceOwner || row.seriesId || row.masterEventId)) return false;
  const mappedControl=await read("SYNC_CONTROL#"+profile+":calendar:"+mapping.eventId);
  if (mappedControl?.activeRepair || mappedControl?.excluded) return false;
  const controls=await Promise.all(refs.map(async ref=>{
    const row=await read("SYNC_CONTROL#"+typed(ref));
    return {ref,row};
  }));
  if (controls.some(({row})=>!row || row.activeRepair!==operation.id || row.excluded===true)) return false;
  // A queued refresh token is included in the conditional release; it stays
  // pending after reset instead of being silently acknowledged/lost.
  const now=(deps.now||(()=>new Date()))().toISOString();
  const exactMap=(sk:string)=>({
    Delete:{TableName:table,Key:key(sk==="owner"?"TASKOWNER#"+task.id
      :sk==="task"?"TASK#"+profile+"#"+task.id:"EVENT#"+profile+"#"+mapping.eventId,"MAP"),
      ConditionExpression:"#p = :p AND taskId = :task AND eventId = :event AND updatedAt = :at AND attribute_not_exists(recurrenceOwner) AND attribute_not_exists(seriesId)",
      ExpressionAttributeNames:{"#p":"profile"},
      ExpressionAttributeValues:{":p":profile,":task":task.id,":event":mapping.eventId,":at":mapping.updatedAt}}
  });
  const tx:Array<Record<string,unknown>>=[
    {ConditionCheck:{TableName:table,Key:key("CALENDAR_WRITE#"+task.id),
      ConditionExpression:"#leaseToken = :leaseToken AND leaseUntilMs > :now",
      ExpressionAttributeNames:{"#leaseToken":"token"},
      ExpressionAttributeValues:{":leaseToken":writeToken,":now":Date.now()}}},
    {ConditionCheck:{TableName:table,Key:key("REVIEW_CASE#"+reviewCase.id),
      ConditionExpression:"#s = :dismissed AND operationId = :op AND updatedAt = :at",
      ExpressionAttributeNames:{"#s":"status"},
      ExpressionAttributeValues:{":dismissed":"dismissed",":op":operation.id,":at":reviewCase.updatedAt}}},
    {Update:{TableName:table,Key:key("REPAIR#"+operation.id),
      UpdateExpression:"SET abandoned = :yes, #s = :failed, updatedAt = :now, nextAction = :next",
      ConditionExpression:"#s = :failed AND updatedAt = :at AND attempt = :attempt AND steps = :steps AND preview = :preview AND (attribute_not_exists(creations) OR creations = :creations) AND attribute_not_exists(abandoned) AND attribute_not_exists(writeStarted) AND attribute_not_exists(outcomes) AND attribute_not_exists(verified) AND attribute_not_exists(recurrenceBindings)",
      ExpressionAttributeNames:{"#s":"status"},
      ExpressionAttributeValues:{":yes":true,":failed":"failed",":now":now,":next":"No-write repair superseded by guarded annual projection reset; do not resume",":at":operation.updatedAt,":attempt":operation.attempt,":steps":operation.steps,":preview":operation.preview,":creations":operation.creations||{}}}},
    ...controls.map(({ref,row})=>{
      const conditions=["activeRepair = :op","(attribute_not_exists(excluded) OR excluded = :false)"];
      const values:Record<string,unknown>={":op":operation.id,":now":now,":false":false};
      for(const field of ["pendingRefreshAt","fencedAt","providerUpdatedAt"] as const){
        if (row?.[field]===undefined) conditions.push("attribute_not_exists("+field+")");
        else {conditions.push(field+" = :"+field);values[":"+field]=row[field];}
      }
      return {Update:{TableName:table,Key:key("SYNC_CONTROL#"+typed(ref)),
        UpdateExpression:"SET fencedAt = :now REMOVE activeRepair",
        ConditionExpression:conditions.join(" AND "),ExpressionAttributeValues:values}};
    }),
    {ConditionCheck:{TableName:table,Key:key("SYNC_CONTROL#"+profile+":calendar:"+mapping.eventId),
      ConditionExpression:"attribute_not_exists(activeRepair) AND (attribute_not_exists(excluded) OR excluded = :no)",
      ExpressionAttributeValues:{":no":false}}},
    {ConditionCheck:{TableName:table,Key:key("REJECTED_PAIR#"+profile+"#"+task.id+"#"+mapping.eventId),
      ConditionExpression:"attribute_not_exists(pk)"}},
    exactMap("owner"),exactMap("task"),exactMap("event"),
    {Delete:{TableName:table,Key:key("BASELINE#"+profile+"#TASK#"+task.id,"RECONCILE"),
      ConditionExpression:baseline ? "updatedAt = :at" : "attribute_not_exists(pk)",
      ...(baseline?{ExpressionAttributeValues:{":at":baseline.updatedAt}}:{})}},
    {ConditionCheck:{TableName:table,Key:key("PROJECTION#"+profile+"#TASK#"+task.id,"TOMBSTONE"),
      ConditionExpression:"attribute_not_exists(pk)"}},
    ...oldCalendarIds.map(id=>({ConditionCheck:{TableName:table,Key:key("COMPLETED_EVENT#"+profile+"#"+id),
      ConditionExpression:"attribute_not_exists(pk)"}})),
    {Put:{TableName:table,Item:{...key("ANNUAL_RECOVERY#"+profile+"#"+task.id),
      profile,taskId:task.id,oldEventId:mapping.eventId,operationId:operation.id,
      sourceUpdatedAt:task.updated_at,sourceDueDate:task.due!.date,createdAt:now,status:"pending"},
      ConditionExpression:"attribute_not_exists(pk)"}},
  ];
  try {await db.send(new TransactWriteCommand({TransactItems:tx as never}));return true;}
  catch(error){if(conditionConflict(error))return false;throw error;}
}
