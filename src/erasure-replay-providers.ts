/**
 * #243 staged provider mutation boundary. Once enabled, a write must prove its
 * complete identity BEFORE invoking the provider. A missing identity fails
 * closed; notably anonymous task/comment creation cannot be approved yet.
 *
 * Callers must hold the applicable erasure writer leases; these checks alone
 * do not make external HTTP mutations transactional with marker installation.
 */
import {LEGACY_TASK_COMMENT_MARKERS,parseDeletionTombstoneComment, parseMappingComment,
  type TodoistCommentRecord} from "./mapping-comments.js";
import { assertRetirementAdmissionIfEnabled, retirementDispositionEnabled } from "./recurrence-retirement-disposition.js";
import {
  assertReplayAdmission, ErasureReplayUnavailableError, mappingReplayIdentity, replayAdmissionEnabled,
  type ReplayIdentity,
} from "./erasure-replay-barrier.js";
import type {CalendarEvent, Mapping, Profile, TodoistTask} from "./types.js";

type Side="calendar"|"todoist";
/** Identity-bearing provider mutation surface reviewed for replay admission. */
export const REPLAY_GUARDED_PROVIDER_WRITES={
  calendar:[
  "createFutureMasterOnce","createTodoistPhaseBNativeMasterOnce","upsertEvent","patchEventMetadataIfUnchanged",
  "createRepairEventOnce","upsertEventIfUnchanged",
  "updateSharedEventPropertiesIfUnchanged","deleteEvent","deleteEventIfUnchanged",
  ],
  todoist:[
  "upsertTask","updateTaskMetadata","createTaskOnce","moveTask",
  "updateRecurringOccurrence","deleteTask","createProjectComment",
  "updateComment","upsertProjectComment","upsertComment","deleteComment",
  ],
} as const;
const calendarWrites=new Set<string>(REPLAY_GUARDED_PROVIDER_WRITES.calendar);
const todoistWrites=new Set<string>(REPLAY_GUARDED_PROVIDER_WRITES.todoist);
const active=new WeakSet<object>();
function ids(values:unknown[]):string[] {
  return [...new Set(values.filter((value):value is string=>typeof value==="string"&&value.length>0))];
}
function eventIdentity(profile:Profile,method:string,args:unknown[]):ReplayIdentity {
  const objectMethods=new Set(["createFutureMasterOnce","createTodoistPhaseBNativeMasterOnce","upsertEvent","createRepairEventOnce","upsertEventIfUnchanged"]);
  const event=objectMethods.has(method) ? args[0] as CalendarEvent|undefined : undefined;
  const shared=method==="updateSharedEventPropertiesIfUnchanged"
    ? args[2] as Record<string,string|null>|undefined
    : event?.extendedProperties?.shared;
  const taskId=typeof shared?.taskId==="string"&&shared.taskId ? shared.taskId : undefined;
  const eventIds=ids([
    event?.id,event?.recurringEventId,event?.extendedProperties?.shared?.syncHistoryMasterId,
    method==="createFutureMasterOnce" ? args[1] : undefined,
    method==="upsertEvent"||method==="upsertEventIfUnchanged" ? args[1] : undefined,
    ["patchEventMetadataIfUnchanged","updateSharedEventPropertiesIfUnchanged","deleteEvent","deleteEventIfUnchanged"].includes(method)
      ? args[0] : undefined,
  ]);
  return {profile,...(taskId?{taskId}:{}),...(eventIds.length?{eventIds}:{})};
}
function commentIdentity(profile:Profile,content:unknown):ReplayIdentity {
  if(typeof content!=="string")throw new ErasureReplayUnavailableError("Unidentifiable Todoist comment mutation");
  const comment={id:"replay-admission",content};
  const tombstone=parseDeletionTombstoneComment(comment);
  if(tombstone) {
    if(tombstone.profile!==profile)
      throw new ErasureReplayUnavailableError("Unidentifiable or wrong-profile project comment mutation");
    return {profile,taskId:tombstone.taskId,eventIds:tombstone.eventIds};
  }
  const parsed=parseMappingComment(comment);
  if(!parsed||"error" in parsed||parsed.payload.profile!==profile)
    throw new ErasureReplayUnavailableError("Unidentifiable or wrong-profile project comment mutation");
  return mappingReplayIdentity(parsed.payload);
}
/** Prove a comment's owning identity from a fresh Todoist read before admitting
 * its deletion. Bare comment IDs carry no task/event identity and remain
 * fail-closed. Active project tombstones are replay fences, so only expired
 * markers may be retired by the tombstone cleanup path. */
async function verifiedCommentDeletionIdentity(profile:Profile,target:object,commentId:unknown):Promise<ReplayIdentity> {
  if(typeof commentId!=="string"||!commentId)
    throw new ErasureReplayUnavailableError("Comment deletion requires verified owner identity");
  const getComment=Reflect.get(target,"getComment");
  if(typeof getComment!=="function")
    throw new ErasureReplayUnavailableError("Comment deletion requires a provider read to verify owner identity");
  let comment:TodoistCommentRecord;
  try { comment=await Reflect.apply(getComment,target,[commentId]) as TodoistCommentRecord; }
  catch { throw new ErasureReplayUnavailableError("Comment deletion owner identity could not be verified"); }
  if(!comment||comment.id!==commentId||typeof comment.content!=="string"||comment.is_deleted===true)
    throw new ErasureReplayUnavailableError("Comment deletion requires verified owner identity");
  const tombstone=parseDeletionTombstoneComment(comment);
  if(tombstone) {
    if(tombstone.profile!==profile||comment.project_id!==tombstone.projectId||comment.task_id)
      throw new ErasureReplayUnavailableError("Comment deletion requires verified owner identity");
    const expiresAt=Date.parse(tombstone.expiresAt);
    if(!Number.isFinite(expiresAt)||expiresAt>Date.now())
      throw new ErasureReplayUnavailableError("Active project deletion tombstones are retained as replay fences");
    return {profile,taskId:tombstone.taskId,eventIds:tombstone.eventIds};
  }
  const parsed=parseMappingComment(comment);
  if(parsed&&!('error' in parsed)) {
    if(parsed.payload.profile!==profile||comment.project_id!==parsed.payload.projectId||comment.task_id)
      throw new ErasureReplayUnavailableError("Comment deletion requires verified owner identity");
    return mappingReplayIdentity(parsed.payload);
  }
  const lines=comment.content.split(/\r?\n/);
  const eventLines=lines.filter(line=>line.startsWith("calendarEventId="));
  const eventId=eventLines.length===1?eventLines[0].slice("calendarEventId=".length):"";
  if(LEGACY_TASK_COMMENT_MARKERS.has(lines[0])&&typeof comment.task_id==="string"&&comment.task_id
    &&eventId&&!/[\u0000-\u001f\u007f]/.test(eventId))
    return {profile,taskId:comment.task_id,eventIds:[eventId]};
  throw new ErasureReplayUnavailableError("Comment deletion requires verified owner identity");
}
/** Derive complete Calendar provenance from a provider-read event and its known
 * recurrence aliases. Never use task payload.id or a Todoist request ID here. */
export function calendarReplaySourceIds(event:Pick<CalendarEvent,"id"|"recurringEventId">,...aliases:(string|undefined)[]):string[] {
  if(!event || !event.id)throw new ErasureReplayUnavailableError("Calendar provenance is required for task creation");
  const values=[event.id,event.recurringEventId,...aliases];
  if(values.some(value=>value!==undefined&&(typeof value!=="string"||!value)))
    throw new ErasureReplayUnavailableError("Malformed Calendar provenance alias");
  const unique=[...new Set(values.filter((value):value is string=>typeof value==="string"&&value.length>0))];
  if(unique.length>32)throw new ErasureReplayUnavailableError("Calendar provenance alias limit exceeded");
  return unique;
}
function sourceEventIds(value:unknown):string[] {
  if(!Array.isArray(value)||value.length===0||value.length>32
    ||value.some(id=>typeof id!=="string"||!id)
    ||new Set(value).size!==value.length)
    throw new ErasureReplayUnavailableError("A complete, unique Calendar source identity is required");
  return value as string[];
}
function taskIdentity(profile:Profile,method:string,args:unknown[]):ReplayIdentity {
  if(["createProjectComment","upsertProjectComment"].includes(method))return commentIdentity(profile,args[1]);
  if(method==="updateComment")return commentIdentity(profile,args[1]);
  if(method==="deleteComment")
    throw new ErasureReplayUnavailableError("Comment deletion requires verified owner identity");
  if(method==="upsertComment") {
    const details=args[3] as Mapping|undefined;
    if(details) {
      if(details.profile!==profile||details.taskId!==args[0])
        throw new ErasureReplayUnavailableError("Mapping comment identity disagrees with caller");
      return mappingReplayIdentity(details);
    }
    return {profile,taskId:args[0] as string};
  }
  if(method==="updateRecurringOccurrence")return {profile,taskId:(args[0] as TodoistTask)?.id};
  if(method==="upsertTask") {
    // Todoist POST /tasks creates a NEW ID and ignores task.id. The only
    // allowed creation proof is the provider-read Calendar source/aliases.
    const existingId=args[1];
    const eventIds=args[2]===undefined?undefined:sourceEventIds(args[2]);
    return {profile,...(typeof existingId==="string"&&existingId
      ?{taskId:existingId}:{}),...(eventIds?{eventIds}:{})};
  }
  if(method==="createTaskOnce") {
    // The request key is idempotency-only: it does not identify an erased
    // Todoist task. Require provider-read Calendar provenance instead.
    return {profile,eventIds:sourceEventIds(args[2])};
  }
  return {profile,taskId:args[0] as string};
}
export function replayMutationIdentity(profile:Profile,side:Side,method:string,args:unknown[]):ReplayIdentity {
  return side==="calendar" ? eventIdentity(profile,method,args) : taskIdentity(profile,method,args);
}
function guardClient<T extends object>(profile:Profile,side:Side,target:T):T {
  if(active.has(target))return target;
  const methods=side==="calendar"?calendarWrites:todoistWrites;
  const proxy=new Proxy(target,{
    get(current,property,receiver) {
      const value=Reflect.get(current,property,receiver);
      if(typeof value!=="function")return value;
      const method=String(property);
      if(!methods.has(method))return value.bind(current);
      return async (...args:unknown[])=>{
        if(replayAdmissionEnabled() || retirementDispositionEnabled()) {
          const identity=side==="todoist"&&method==="deleteComment"
            ?await verifiedCommentDeletionIdentity(profile,current,args[0])
            :replayMutationIdentity(profile,side,method,args);
          await assertRetirementAdmissionIfEnabled(identity);
          if(replayAdmissionEnabled())await assertReplayAdmission(identity);
        }
        return Reflect.apply(value,current,args);
      };
    },
  });
  active.add(proxy);
  return proxy;
}
export function guardReplayCalendarClient<T extends object>(profile:Profile,target:T):T {
  return guardClient(profile,"calendar",target);
}
/** Wrap BOTH production and injected/mock factories; repeated wrapping is idempotent. */
export function guardReplayProviderClients<T extends {calendar:object;todoist:object}>(profile:Profile,clients:T):T {
  return {...clients,calendar:guardReplayCalendarClient(profile,clients.calendar),
    todoist:guardClient(profile,"todoist",clients.todoist)};
}
