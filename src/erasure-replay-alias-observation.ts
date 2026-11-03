/**
 * #307: independently observe ALL profile Calendar task links before a future
 * post-write release verifier is constructed. This is NOT a complete alias
 * manifest and MUST NOT be given to atomicReplayRelease().
 *
 * Unknown historical mapping/comment provenance, untagged series and full
 * provider-deletion confirmation are deliberately left as blockers.
 */
import type {CalendarEvent,Profile} from "./types.js";
import {REPLAY_PROFILES} from "./erasure-replay-barrier.js";

export type ReadOnlyLinkedCalendar = {
  listLinkedEventsByTodoistTaskId(taskId:string):Promise<CalendarEvent[]>;
};

export type ObservedCalendarAliasInventory = {
  phase:"read_only_observation";
  identityUnverified:true;
  eligibleForPostWriteRelease:false;
  allProfilesQueried:true;
  observedEventIds:Record<Profile,readonly string[]>;
  recurringMasterHints:Record<Profile,readonly string[]>;
  cancelledEventIds:Record<Profile,readonly string[]>;
  /** These blockers remain even when each list is empty. */
  missingProof:readonly string[];
};

const VALID_ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const MAX_EVENTS=32;

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
        unresolved.add("Recurring parent and occurrence identity requires full direct master/instance readback");
      }
      if(event.recurrence?.length) {
        if(!Array.isArray(event.recurrence)||event.recurrence.some(r=>typeof r!=="string"))
          throw new Error("Malformed recurrence evidence in "+profile);
        unresolved.add("Recurring series rules, overrides and cancellations require full provider inventory");
      }
    }
    if(eventIds.size+parents.size>MAX_EVENTS)
      throw new Error("Calendar aliases exceed replay marker bound in "+profile);
    observedEventIds[profile]=[...eventIds].sort();
    recurringMasterHints[profile]=[...parents].sort();
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
  };
}
