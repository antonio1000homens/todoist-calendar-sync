/**
 * #243 staged provider mutation boundary. Once enabled, a write must prove its
 * complete identity BEFORE invoking the provider. A missing identity fails
 * closed; notably anonymous task/comment creation cannot be approved yet.
 *
 * Callers must hold the applicable erasure writer leases; these checks alone
 * do not make external HTTP mutations transactional with marker installation.
 */
import {parseMappingComment} from "./mapping-comments.js";
import {
  assertReplayAdmission, ErasureReplayUnavailableError, mappingReplayIdentity, replayAdmissionEnabled,
  type ReplayIdentity,
} from "./erasure-replay-barrier.js";
import type {CalendarEvent, Mapping, Profile, TodoistTask} from "./types.js";

type Side="calendar"|"todoist";
const calendarWrites=new Set([
  "createFutureMasterOnce","upsertEvent","patchEventMetadataIfUnchanged",
  "createRepairEventOnce","upsertEventIfUnchanged",
  "updateSharedEventPropertiesIfUnchanged","deleteEvent","deleteEventIfUnchanged",
]);
const todoistWrites=new Set([
  "upsertTask","updateTaskMetadata","createTaskOnce","moveTask",
  "updateRecurringOccurrence","deleteTask","createProjectComment",
  "updateComment","upsertProjectComment","upsertComment","deleteComment",
]);
const active=new WeakSet<object>();
function ids(values:unknown[]):string[] {
  return [...new Set(values.filter((value):value is string=>typeof value==="string"&&value.length>0))];
}
function eventIdentity(profile:Profile,method:string,args:unknown[]):ReplayIdentity {
  const objectMethods=new Set(["createFutureMasterOnce","upsertEvent","createRepairEventOnce","upsertEventIfUnchanged"]);
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
  const parsed=parseMappingComment({id:"replay-admission",content});
  if(!parsed||"error" in parsed||parsed.payload.profile!==profile)
    throw new ErasureReplayUnavailableError("Unidentifiable or wrong-profile project comment mutation");
  return mappingReplayIdentity(parsed.payload);
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
    const task=args[0] as (TodoistTask|undefined);
    return {profile,taskId:typeof args[1]==="string" ? args[1] : task?.id};
  }
  if(method==="createTaskOnce") {
    // Request IDs and timestamps are not Todoist task IDs. The *source*
    // Calendar identity must be passed explicitly by the future repair API.
    return {profile};
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
        if(replayAdmissionEnabled()) {
          const identity=replayMutationIdentity(profile,side,method,args);
          await assertReplayAdmission(identity);
        }
        return Reflect.apply(value,current,args);
      };
    },
  });
  active.add(proxy);
  return proxy;
}
/** Wrap BOTH production and injected/mock factories; repeated wrapping is idempotent. */
export function guardReplayProviderClients<T extends {calendar:object;todoist:object}>(profile:Profile,clients:T):T {
  return {...clients,calendar:guardClient(profile,"calendar",clients.calendar),
    todoist:guardClient(profile,"todoist",clients.todoist)};
}
