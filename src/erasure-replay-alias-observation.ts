/**
 * #307: independently observe ALL profile Calendar task links before a future
 * post-write release verifier is constructed. This is NOT a complete alias
 * manifest and MUST NOT be passed to any fence-release transaction.
 *
 * Unknown historical mapping/comment provenance, untagged series and full
 * provider-deletion confirmation are deliberately left as blockers.
 */
import type {CalendarEvent,Profile} from "./types.js";
import {REPLAY_PROFILES} from "./erasure-replay-barrier.js";

export type ReadOnlyLinkedCalendar = {
  listLinkedEventsByTodoistTaskId(taskId:string):Promise<CalendarEvent[]>;
  /** Optional only so older callers remain read-only but explicitly incomplete. */
  getEvent?(eventId:string):Promise<CalendarEvent>;
  listEventInstances?(masterEventId:string):Promise<CalendarEvent[]>;
};

export type ObservedCalendarAliasInventory = {
  phase:"read_only_observation";
  identityUnverified:true;
  eligibleForPostWriteRelease:false;
  allProfilesQueried:true;
  observedEventIds:Record<Profile,readonly string[]>;
  recurringMasterHints:Record<Profile,readonly string[]>;
  /** Directly read masters and listed occurrences; never release-authoritative. */
  recurrenceClosureEventIds:Record<Profile,readonly string[]>;
  cancelledEventIds:Record<Profile,readonly string[]>;
  /** These blockers remain even when each list is empty. */
  missingProof:readonly string[];
};

const VALID_ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const MAX_EVENTS=32;
function sameObservedVersion(left:CalendarEvent,right:CalendarEvent):boolean {
  return left.id===right.id&&left.etag===right.etag&&left.status===right.status
    &&left.recurringEventId===right.recurringEventId
    &&JSON.stringify(left.originalStartTime)===JSON.stringify(right.originalStartTime)
    &&left.extendedProperties?.shared?.taskId===right.extendedProperties?.shared?.taskId;
}

/**
 * A profile-specific reader must load that profile's independently configured
 * Calendar credentials. Do not reuse a single source Calendar across profiles.
 * Fail CLOSED on unknown identity, missing client, incomplete queries, duplicate
 * identities with incompatible evidence or >32 aliases.
 */
export async function observeCrossProfileCalendarAliases(
  taskId:string,
  readerForProfile:(profile:Profile)=>Promise<ReadOnlyLinkedCalendar>,
):Promise<ObservedCalendarAliasInventory> {
  if(typeof taskId!=="string"||!VALID_ID.test(taskId)||
    typeof readerForProfile!=="function")
    throw new Error("Exact task identity and read-only profile readers are required");
  const observedEventIds={} as Record<Profile,readonly string[]>;
  const recurringMasterHints={} as Record<Profile,readonly string[]>;
  const recurrenceClosureEventIds={} as Record<Profile,readonly string[]>;
  const cancelledEventIds={} as Record<Profile,readonly string[]>;
  const unresolved=new Set<string>();
  for(const profile of REPLAY_PROFILES) {
    const client=await readerForProfile(profile);
    if(!client||typeof client.listLinkedEventsByTodoistTaskId!=="function")
      throw new Error("Missing independent Calendar reader for "+profile);
    const events=await client.listLinkedEventsByTodoistTaskId(taskId);
    if(!Array.isArray(events)||events.length>MAX_EVENTS)
      throw new Error("Incomplete or oversized Calendar alias inventory for "+profile);
    const eventIds=new Set<string>(),parents=new Set<string>(),cancelled=new Set<string>();
    for(const event of events) {
      const linked=event?.extendedProperties?.shared?.taskId;
      if(!event||typeof event.id!=="string"||!VALID_ID.test(event.id)||
        linked!==taskId||eventIds.has(event.id))
        throw new Error("Unattributable or duplicated Calendar alias in "+profile);
      eventIds.add(event.id);
      if(event.status==="cancelled")cancelled.add(event.id);
      if(event.recurringEventId) {
        if(typeof event.recurringEventId!=="string"||!VALID_ID.test(event.recurringEventId))
          throw new Error("Malformed recurring master alias in "+profile);
        parents.add(event.recurringEventId);
      }
      if(event.recurrence?.length)parents.add(event.id);
      if(event.recurrence?.length) {
        if(!Array.isArray(event.recurrence)||event.recurrence.some(r=>typeof r!=="string"))
          throw new Error("Malformed recurrence evidence in "+profile);
        unresolved.add("Recurring rule and override consistency still requires independent provider review");
      }
    }
    if(eventIds.size+parents.size>MAX_EVENTS)
      throw new Error("Calendar aliases exceed replay marker bound in "+profile);
    const closure=new Set<string>();
    if(parents.size&&(!client.getEvent||!client.listEventInstances)) {
      unresolved.add("Recurring master/instance IDs lack direct readback in "+profile);
    } else {
      for(const parentId of parents) {
        const master=await client.getEvent!(parentId);
        if(!master||master.id!==parentId||!Array.isArray(master.recurrence)||master.recurrence.length===0)
          throw new Error("Calendar recurring master readback is incomplete in "+profile);
        closure.add(parentId);
        const instances=await client.listEventInstances!(parentId);
        if(!Array.isArray(instances))
          throw new Error("Calendar recurring instance inventory is incomplete in "+profile);
        for(const instance of instances) {
          if(!instance||typeof instance.id!=="string"||!VALID_ID.test(instance.id)
            ||instance.recurringEventId!==parentId)
            throw new Error("Unattributable Calendar recurrence instance in "+profile);
          closure.add(instance.id);
          if(instance.status==="cancelled")cancelled.add(instance.id);
          if(eventIds.has(instance.id)) {
            const linked=events.find(candidate=>candidate.id===instance.id);
            if(linked&&!sameObservedVersion(linked,instance))
              throw new Error("Calendar recurrence snapshot changed during observation in "+profile);
          }
          if(eventIds.size+closure.size>MAX_EVENTS)
            throw new Error("Calendar recurrence closure exceeds replay marker bound in "+profile);
        }
      }
    }
    for(const id of closure)eventIds.add(id);
    observedEventIds[profile]=[...eventIds].sort();
    recurringMasterHints[profile]=[...parents].sort();
    recurrenceClosureEventIds[profile]=[...closure].sort();
    cancelledEventIds[profile]=[...cancelled].sort();
  }
  return {
    phase:"read_only_observation",identityUnverified:true,
    eligibleForPostWriteRelease:false,allProfilesQueried:true,
    observedEventIds,recurringMasterHints,cancelledEventIds,
    missingProof:[
      "Empty profile search is not proof that historic/untagged Calendar aliases are absent",
      "Cross-profile DynamoDB mapping, recurrence link, comment and audit inventory is not verified",
      "Provider task/event/master/instance absence and stable ETag readback are not verified",
      "No source/destination fenced lease or epoch review was made",
      ...unresolved,
    ],
    recurrenceClosureEventIds,
  };
}
