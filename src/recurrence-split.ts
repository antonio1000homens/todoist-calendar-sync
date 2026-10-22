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
  /** Last actual Calendar occurrence kept; absent if the expired rule generated none. */
  previousOccurrence?: string;
  nextOldOccurrence: string;
  newStart: string;
  calendarTimeZone?: string;
  approvedAt?: string;
  /** Expired DATE UNTIL on the original series; never extend this historical rule. */
  expiredUntil?: string;
  /** Last actually generated occurrence when the original RRULE has expired. */
  historicalLastOccurrence?: string;
  /** Binds a proposal to the approved Todoist task, including full due shape. */
  approvedTaskFingerprint: string;
}
export function calendarLocalDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(now);
  const take = (type: string) => parts.find((part) => part.type === type)?.value;
  const date = `${take("year")}-${take("month")}-${take("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Calendar local date could not be determined");
  return date;
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
/**
 * Google Calendar may reorder RRULE components on a successful PUT. Compare
 * only the supported all-day YEARLY subset semantically; unknown clauses,
 * duplicate keys and malformed values must fail closed, not be ignored.
 *
 * FREQ=YEARLY and INTERVAL=1 (implicit or explicit) are equivalent, as are
 * distinct serialisations of a rule with exactly the same DATE UNTIL.
 */
export function sameSafeYearlyRecurrenceRule(left: string | undefined, right: string | undefined): boolean {
  const parse = (input: string | undefined): string | undefined => {
    if (!input?.startsWith("RRULE:")) return undefined;
    const parameters = new Map<string, string>();
    for (const component of input.slice("RRULE:".length).split(";")) {
      const match = /^(FREQ|INTERVAL|UNTIL)=([^;=]+)$/.exec(component);
      if (!match || parameters.has(match[1])) return undefined;
      parameters.set(match[1], match[2]);
    }
    if (parameters.get("FREQ") !== "YEARLY") return undefined;
    const rawInterval = parameters.get("INTERVAL") || "1";
    if (!/^[1-9]\d{0,2}$/.test(rawInterval)) return undefined;
    const until = parameters.get("UNTIL") || "";
    if (until && !/^\d{8}$/.test(until)) return undefined;
    if (until) {
      const value = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}`;
      try { day(value); } catch { return undefined; }
    }
    return `FREQ=YEARLY;INTERVAL=${Number(rawInterval)};UNTIL=${until}`;
  };
  const normalizedLeft = parse(left);
  return normalizedLeft !== undefined && normalizedLeft === parse(right);
}

function annualRule(rule: string): { interval: number; until?: string } {
  // Reject any component whose semantics we cannot preserve (COUNT, BYxxx,
  // RDATE, EXDATE, duplicate keys, timed UNTIL, etc). DATE UNTIL is safe
  // only when it has already expired: the existing master is left unchanged.
  if (!sameSafeYearlyRecurrenceRule(rule, rule)) {
    throw new Error("Future-only split requires a plain YEARLY RRULE with optional INTERVAL and expired DATE UNTIL; COUNT, BYxxx, RDATE and EXDATE need manual review");
  }
  const components = new Map(rule.slice("RRULE:".length).split(";").map(part => part.split("=") as [string, string]));
  const untilValue = components.get("UNTIL");
  return {
    interval: Number(components.get("INTERVAL") || 1),
    ...(untilValue ? { until: `${untilValue.slice(0, 4)}-${untilValue.slice(4, 6)}-${untilValue.slice(6)}` } : {}),
  };
}
function approvedTaskFingerprint(task: TodoistTask): string {
  const due = task.due;
  return createHash("sha256").update(JSON.stringify([
    task.id, task.project_id ?? null, task.content, task.description ?? null,
    task.updated_at ?? null, task.is_completed ?? false, task.is_deleted ?? false,
    due ? [due.date ?? null, due.datetime ?? null, due.timezone ?? null,
      due.string ?? null, due.lang ?? null, due.is_recurring ?? false] : null,
  ])).digest("hex");
}

export function planFutureSeriesSplit(
  profile: Profile,
  task: TodoistTask,
  old: CalendarEvent,
  now = new Date(),
  timeZone = "UTC",
  expectedPreviousTaskId?: string,
): FutureSeriesSplitPlan {
  if (old.status !== "confirmed" || !old.etag || !old.id || old.recurringEventId) {
    throw new Error("A live recurring master with a stable ETag is required");
  }
  if (old.recurrence?.length !== 1) throw new Error("Future-only split requires exactly one Calendar RRULE; RDATE, EXDATE and extra recurrence entries need manual review");
  if (!old.start?.date || old.start.dateTime || !old.end?.date || old.end.dateTime
    || !task.due?.date || task.due.datetime || !task.due.is_recurring) {
    throw new Error("Future-only split supports all-day recurring task and Calendar master only");
  }
  const previousTaskMatches = expectedPreviousTaskId
    ? old.extendedProperties?.shared?.taskId === expectedPreviousTaskId
      && old.extendedProperties?.shared?.syncRecurrenceOwner === "calendar"
    : old.extendedProperties?.shared?.taskId === task.id
      && old.extendedProperties?.shared?.syncRecurrenceOwner !== "calendar";
  if ((!previousTaskMatches
      && !(old.extendedProperties?.shared?.syncHistoryOnly === "true"
        && old.extendedProperties?.shared?.syncHistoryTaskId === task.id))
    || normalizedText(old.summary).toLowerCase() !== normalizedText(task.content).toLowerCase()) {
    throw new Error("Existing Calendar series does not prove this Todoist task's identity");
  }
  const start = old.start.date;
  const startMs = day(start), today = calendarLocalDay(now, timeZone);
  const due = task.due.date;
  day(due);
  if (day(due) < day(today)) throw new Error("The new Todoist occurrence is in the past");
  if (startMs >= day(today)) throw new Error("No prior occurrences exist to preserve");
  const archived = old.extendedProperties?.shared?.syncHistoryOnly === "true";
  const priorRule = archived
    ? old.extendedProperties?.shared?.syncHistoryOriginalRule
    : old.recurrence[0];
  if (!priorRule) throw new Error("Cannot verify the original historical recurrence");
  const { interval, until } = annualRule(priorRule);
  if (until && day(until) >= day(today)) {
    throw new Error("Calendar UNTIL is not yet expired; review the still-active series and its occurrences separately");
  }
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
  // An expired Calendar rule is already historical. Replacing UNTIL with a
  // later cutoff would CREATE old occurrences that never existed (including
  // when UNTIL precedes DTSTART); leave it byte-for-byte unchanged.
  const truncatedRule = until ? originalRule
    : `${originalRule};UNTIL=${previous.replace(/-/g, "")}`;
  let historicalLastOccurrence: string | undefined;
  if (until) {
    for (let i = 0; i <= 300; i++) {
      const candidate = yearlyOccurrence(start, startYear + i * interval);
      if (day(candidate) > day(until)) break;
      historicalLastOccurrence = candidate;
    }
  }
  if (archived && (!sameSafeYearlyRecurrenceRule(old.recurrence[0], truncatedRule)
    || old.extendedProperties?.shared?.syncHistorySuccessorId !== newMasterId
    || old.extendedProperties?.shared?.syncHistoryTaskId !== task.id)) {
    throw new Error("Already archived Calendar master does not match this split");
  }
  return {
    oldMasterId: old.id, oldEtag: old.etag, newMasterId,
    originalRule, truncatedRule, newRule,
    ...(until ? (historicalLastOccurrence ? { previousOccurrence: historicalLastOccurrence } : {})
      : { previousOccurrence: previous }),
    nextOldOccurrence: upcoming, newStart: due,
    calendarTimeZone: timeZone, approvedAt: now.toISOString(),
    approvedTaskFingerprint: approvedTaskFingerprint(task),
    ...(until ? { expiredUntil: until, ...(historicalLastOccurrence ? { historicalLastOccurrence } : {}) } : {}),
  };
}

/** Existing Calendar instance overrides are not rewritten by a series split. */
export function assertUnmodifiedHistoricalOccurrences(
  master: CalendarEvent,
  instances: CalendarEvent[],
  plan: FutureSeriesSplitPlan,
): void {
  const last = plan.expiredUntil ? plan.historicalLastOccurrence : plan.previousOccurrence;
  if (last ? !instances.some((item) => (item.originalStartTime?.date || item.start?.date) === last)
    : instances.length !== 0) {
    throw new Error("Last historical occurrence could not be verified");
  }
  for (const instance of instances) {
    const original = instance.originalStartTime?.date || instance.start?.date;
    if (!original || !instance.start?.date || instance.status !== "confirmed"
      || instance.recurringEventId !== master.id || instance.start.date !== original
      || normalizedText(instance.summary) !== normalizedText(master.summary)
      || normalizedText(instance.description) !== normalizedText(master.description)
      || instance.end?.date !== new Date(Date.parse(original + "T12:00:00Z") + 86400000).toISOString().slice(0, 10)) {
      throw new Error("Historical occurrence exception or change needs separate review");
    }
  }
}
