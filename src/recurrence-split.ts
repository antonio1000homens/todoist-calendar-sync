import { createHash } from "node:crypto";
import { normalizedText } from "./security.js";
import { todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import type { CalendarEvent, Profile, TodoistTask } from "./types.js";

/**
 * Narrow, deliberately conservative implementation of a future-only series
 * split. Unsupported RRULEs, timed events, exceptions and unproven ownership
 * require human investigation, never a rewrite of historical occurrences.
 */
export interface FutureSeriesSplitPlan {
  oldMasterId: string;
  oldEtag: string;
  newMasterId: string;
  originalRule: string;
  truncatedRule: string;
  newRule: string;
  previousOccurrence: string;
  nextOldOccurrence: string;
  newStart: string;
}
function day(value: string): number {
  const stamp = Date.parse(value + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Future-only split requires a valid all-day date");
  }
  return stamp;
}
function yearlyOccurrence(anchor: string, year: number): string {
  const candidate = String(year).padStart(4, "0") + anchor.slice(4);
  day(candidate); // Reject leap-day shifts rather than guessing.
  return candidate;
}
function annualInterval(rule: string): number {
  const match = /^RRULE:FREQ=YEARLY(?:;INTERVAL=([1-9]\d{0,2}))?$/.exec(rule);
  if (!match) throw new Error("Future-only split supports only plain yearly RRULEs without COUNT, UNTIL, RDATE or EXDATE");
  return Number(match[1] || 1);
}
export function planFutureSeriesSplit(
  profile: Profile,
  task: TodoistTask,
  old: CalendarEvent,
  now = new Date(),
): FutureSeriesSplitPlan {
  if (old.status !== "confirmed" || !old.etag || !old.id || old.recurringEventId) {
    throw new Error("A live recurring master with a stable ETag is required");
  }
  if (old.recurrence?.length !== 1) throw new Error("Only a single unchanged Calendar recurrence can be split");
  if (!old.start?.date || old.start.dateTime || !old.end?.date || old.end.dateTime
    || !task.due?.date || task.due.datetime || !task.due.is_recurring) {
    throw new Error("Future-only split supports all-day recurring task and Calendar master only");
  }
  if ((old.extendedProperties?.shared?.taskId !== task.id
      && !(old.extendedProperties?.shared?.syncHistoryOnly === "true"
        && old.extendedProperties?.shared?.syncHistoryTaskId === task.id))
    || old.extendedProperties?.shared?.syncRecurrenceOwner === "calendar"
    || normalizedText(old.summary).toLowerCase() !== normalizedText(task.content).toLowerCase()) {
    throw new Error("Existing Calendar series does not prove this Todoist task's identity");
  }
  const start = old.start.date;
  const startMs = day(start), today = now.toISOString().slice(0, 10);
  const due = task.due.date;
  day(due);
  if (day(due) < day(today)) throw new Error("The new Todoist occurrence is in the past");
  if (startMs >= day(today)) throw new Error("No prior occurrences exist to preserve");
  const archived = old.extendedProperties?.shared?.syncHistoryOnly === "true";
  const priorRule = archived
    ? old.extendedProperties?.shared?.syncHistoryOriginalRule
    : old.recurrence[0];
  if (!priorRule) throw new Error("Cannot verify the original historical recurrence");
  const interval = annualInterval(priorRule);
  const newRule = todoistRecurrenceToRrule(task);
  if (!newRule || !newRule.startsWith("RRULE:FREQ=YEARLY")) {
    throw new Error("The Todoist future schedule must be a supported yearly recurrence");
  }
  const duration = day(old.end.date) - startMs;
  if (duration !== 86400000) throw new Error("Historical series must consist of one-day all-day events");
  let previous = start;
  let upcoming: string | undefined;
  const startYear = Number(start.slice(0, 4));
  for (let i = 1; i <= 300; i++) {
    const next = yearlyOccurrence(start, startYear + i * interval);
    if (day(next) >= day(today)) { upcoming = next; break; }
    previous = next;
  }
  if (!upcoming) throw new Error("Unable to determine the next historical occurrence");
  // An already-capped series may be resumed only when its lineage and exact
  // cap match this same deterministic successor; no new split is inferred.
  const newMasterId = createHash("sha256")
    .update(`split-v1:${profile}:${task.id}:${old.id}:${due}:${newRule}`)
    .digest("hex").slice(0, 32);
  const originalRule = priorRule;
  const truncatedRule = `${originalRule};UNTIL=${previous.replace(/-/g, "")}`;
  if (archived && (old.recurrence[0] !== truncatedRule
    || old.extendedProperties?.shared?.syncHistorySuccessorId !== newMasterId
    || old.extendedProperties?.shared?.syncHistoryTaskId !== task.id)) {
    throw new Error("Already archived Calendar master does not match this split");
  }
  return {
    oldMasterId: old.id, oldEtag: old.etag, newMasterId,
    originalRule, truncatedRule, newRule,
    previousOccurrence: previous, nextOldOccurrence: upcoming, newStart: due,
  };
}

/** Existing Calendar instance overrides are not rewritten by a series split. */
export function assertUnmodifiedHistoricalOccurrences(
  master: CalendarEvent,
  instances: CalendarEvent[],
  plan: FutureSeriesSplitPlan,
): void {
  if (!instances.some((item) => (item.originalStartTime?.date || item.start?.date) === plan.previousOccurrence)) {
    throw new Error("Last historical occurrence could not be verified");
  }
  for (const instance of instances) {
    const original = instance.originalStartTime?.date || instance.start?.date;
    if (!original || !instance.start?.date || instance.status !== "confirmed"
      || instance.recurringEventId !== master.id || instance.start.date !== original
      || normalizedText(instance.summary) !== normalizedText(master.summary)) {
      throw new Error("Historical occurrence exception or change needs separate review");
    }
  }
}
