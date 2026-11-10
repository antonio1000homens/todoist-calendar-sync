import { createHash } from "node:crypto";
import { classifyCalendarRule, compareOccurrenceSemantics, occurrenceDates } from "./recurrence-semantics.js";
import { todoistPhaseBCandidate } from "./todoist-calendar-phase-b.js";
import { todoistRecurrenceKey } from "./todoist-recurrence.js";
import type { CalendarEvent, Mapping, Profile, TodoistTask } from "./types.js";

/**
 * #389: read-only, fail-closed planning for a FUTURE-ONLY move of a Phase B
 * Todoist-owned recurring series between separate Google calendars.
 *
 * A Google events.insert cannot move an existing recurrence's historical
 * instances to a new calendar. Copy+delete would erase history. This module
 * admits only a split which keeps the historical source master in place,
 * removes the source's future projection via a conditional RRULE cap, and
 * starts an independently verified successor at Todoist's current due date.
 *
 * No writes or mapping changes may be performed using this plan alone.
 * A later executor must persist a durable two-profile write fence and
 * verify conditional provider writes and ownership before release.
 */
export interface PhaseBNativeMoveEvidence {
  task: TodoistTask;
  mapping: Mapping;
  sourceMaster: CalendarEvent;
  sourceProfile: Profile;
  destinationProfile: Profile;
  /** Exact configured managed Todoist project for the destination profile. */
  destinationProjectId: string;
  /** Independently read IANA timezones for both Google calendars and Todoist. */
  sourceTimeZone: string;
  destinationTimeZone: string;
  todoistTimeZone: string;
  /** Source calendar's local TODAY, independently derived in that timezone. */
  today: string;
  /** Complete, bounded provider history from source DTSTART up to cutover. */
  historicalInstances: CalendarEvent[];
  historyInventoryComplete: boolean;
  /** A complete explicit exception inventory, not just visible occurrences. */
  explicitExceptions: CalendarEvent[];
  exceptionInventoryComplete: boolean;
  /** Source/destination mapping and provider ambiguity checks completed. */
  destinationHasLinkedEvent: boolean;
  destinationHasMapping: boolean;
  destinationHasTombstone: boolean;
  activeRepairOrErasure: boolean;
}
export interface PhaseBNativeMovePlan {
  taskId: string;
  sourceProfile: Profile;
  destinationProfile: Profile;
  sourceMasterId: string;
  sourceEtag: string;
  successorMasterId: string;
  originalAnchor: string;
  sourceRule: string;
  historyRule: string;
  historicalLastOccurrence: string;
  destinationStart: string;
  destinationRule: string;
  firstThreeDestinationOccurrences: [string,string,string];
  /** The old master must become history-only, not stay task-linked. */
  historyTaskId: string;
}
export type PhaseBNativeMoveDecision =
  | { accepted: false; reason: string }
  | { accepted: true; reason: "verified_future_only_cutover"; plan: PhaseBNativeMovePlan };

function date(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d=new Date(value+"T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10)===value;
}
function nextDate(value: string): string {
  const d=new Date(value+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}
function validInstance(
  instance: CalendarEvent, source: CalendarEvent, expectedDate: string,
): boolean {
  return Boolean(instance.id && instance.status==="confirmed"
    && instance.recurringEventId===source.id
    && instance.originalStartTime?.date===expectedDate
    && instance.start?.date===expectedDate
    && instance.end?.date===nextDate(expectedDate)
    && !instance.start?.dateTime && !instance.end?.dateTime
    && !instance.recurrence?.length
    && instance.summary===source.summary
    && (instance.description||"")===(source.description||""));
}

export function planPhaseBNativeFutureOnlyMove(
  e: PhaseBNativeMoveEvidence,
): PhaseBNativeMoveDecision {
  const reject=(reason:string):PhaseBNativeMoveDecision=>({accepted:false,reason});
  const {task,mapping,sourceMaster:master}=e;
  const shared=master.extendedProperties?.shared;
  const current=task.due?.date;
  if (e.sourceProfile===e.destinationProfile || !e.sourceProfile || !e.destinationProfile)
    return reject("distinct_profiles_required");
  if (e.activeRepairOrErasure || e.destinationHasLinkedEvent
    || e.destinationHasMapping || e.destinationHasTombstone)
    return reject("move_identity_or_recovery_conflict");
  if (!e.sourceTimeZone || e.sourceTimeZone!==e.destinationTimeZone
    || e.sourceTimeZone!==e.todoistTimeZone)
    return reject("cross_profile_timezone_not_verified");
  if (!date(e.today) || !date(current) || current<e.today
    || !task.due?.is_recurring || task.is_completed || task.is_deleted || task.completed_at
    || !e.destinationProjectId || task.project_id!==e.destinationProjectId)
    return reject("active_future_todoist_due_not_verified");
  if (mapping.todoistPhaseBVersion!==1 || mapping.profile!==e.sourceProfile
    || mapping.taskId!==task.id || mapping.recurrenceOwner!=="todoist"
    || mapping.seriesId!==task.id || mapping.masterEventId!==master.id
    || mapping.eventId!==master.id || !mapping.activeInstanceId
    || mapping.originalStart!==current || mapping.activeEffectiveStart!==current)
    return reject("source_mapping_not_native_owned");
  if (!master.id || !master.etag || master.status!=="confirmed"
    || master.recurringEventId || master.recurrence?.length!==1
    || !date(master.start?.date) || !date(master.end?.date)
    || master.end!.date!==nextDate(master.start!.date!)
    || master.start?.dateTime || master.end?.dateTime
    || shared?.taskId!==task.id || shared?.syncRecurrenceOwner!=="todoist"
    || shared?.todoistPhaseBVersion!=="1"
    || shared?.todoistAnchorStart!==master.start?.date
    || shared?.todoistAnchorEnd!==master.end?.date
    || shared?.todoistAnchorTimeZone!==e.sourceTimeZone
    || shared?.todoistRecurrence!==todoistRecurrenceKey(task)
    || master.summary!==task.content
    || (master.description||"")!==(task.description||""))
    return reject("source_master_identity_or_anchor_drift");

  const candidate=todoistPhaseBCandidate(task,{
    start:master.start!.date!,source:"verified_original_schedule",timeZone:e.sourceTimeZone,
  });
  const classified=classifyCalendarRule(master.recurrence[0],{
    start:master.start!.date!,timeZone:e.sourceTimeZone,
  });
  if (!candidate.family || candidate.reason!=="provider_readback_required"
    || !candidate.semantic || !classified.semantic || !candidate.candidateRrule
    || candidate.candidateRrule!==master.recurrence[0]
    || classified.canonicalRrule!==master.recurrence[0]
    || !compareOccurrenceSemantics(candidate.semantic,classified.semantic).equivalent)
    return reject("source_rule_or_current_cadence_unverified");

  // Never guess a cutover beyond the 100-occurrence bounded verifier.
  // A second, independently admitted destination will start at this same
  // occurrence, not at the original DTSTART or an inferred first iteration.
  const occurrences=occurrenceDates(classified.semantic,100);
  const next=occurrences.indexOf(current);
  if (next<=0 || next>=occurrences.length-3)
    return reject("cutover_without_proven_history_or_future");
  // A destination with the same RRULE but a new DTSTART can change interval
  // phase. Independently expand the re-anchored rule before allowing a split.
  const successor=classifyCalendarRule(master.recurrence[0],{
    start:current,timeZone:e.destinationTimeZone,
  });
  const destinationOccurrences=successor.semantic
    ? occurrenceDates(successor.semantic,3) : [];
  if (destinationOccurrences.length!==3 || !destinationOccurrences.every((value,i)=>
    value===occurrences[next+i]))
    return reject("destination_reanchor_progression_mismatch");
  const past=occurrences.slice(0,next);
  const previous=past[past.length-1];
  // Only genuinely elapsed occurrences may remain on the old calendar as
  // history. Never mislabel a still-future occurrence as a completed cutover.
  if (previous>=e.today) return reject("source_history_not_yet_elapsed");
  if (!e.historyInventoryComplete || !e.exceptionInventoryComplete
    || !Array.isArray(e.historicalInstances) || !Array.isArray(e.explicitExceptions)
    || e.explicitExceptions.length)
    return reject("incomplete_history_or_explicit_exceptions");
  // A partial provider instance list cannot justify a source cap.
  const actual=e.historicalInstances.slice().sort((a,b)=>
    (a.originalStartTime?.date||"").localeCompare(b.originalStartTime?.date||""));
  if (actual.length!==past.length || !actual.every((v,i)=>
    validInstance(v,master,past[i])))
    return reject("historical_occurrence_mismatch");

  // Google DATE UNTIL is inclusive. The last actual occurrence remains in the
  // source calendar. The destination starts from the next Todoist occurrence.
  const historyRule=master.recurrence[0]+";UNTIL="+previous.replace(/-/g,"");
  const successorMasterId=createHash("sha256")
    .update(JSON.stringify(["phase-b-native-move-v1",e.sourceProfile,e.destinationProfile,
      task.id,master.id,current,master.recurrence[0]])).digest("hex").slice(0,32);
  return {accepted:true,reason:"verified_future_only_cutover",plan:{
    taskId:task.id,sourceProfile:e.sourceProfile,destinationProfile:e.destinationProfile,
    sourceMasterId:master.id,sourceEtag:master.etag,successorMasterId,
    originalAnchor:master.start!.date!,sourceRule:master.recurrence[0],
    historyRule,historicalLastOccurrence:previous,
    destinationStart:current,destinationRule:master.recurrence[0],
    firstThreeDestinationOccurrences:occurrences.slice(next,next+3) as [string,string,string],
    historyTaskId:task.id,
  }};
}
