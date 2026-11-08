/**
 * Phase B of #290: conservative Todoist -> Calendar native-recurrence candidates.
 *
 * The candidate parser is not permission to write a Calendar recurring master.
 * For newly supported families an independently established original anchor,
 * both provider readbacks, a verified completion advance and an exception-free
 * Calendar instance inventory are required. The existing rolling path remains
 * the production default until a caller explicitly supplies that proof.
 */
import {
  classifyCalendarRule, classifyTodoistRule, compareOccurrenceSemantics,
  occurrenceDates,
  type RecurrenceSemantics,
} from "./recurrence-semantics.js";
import { todoistRecurrenceKey } from "./todoist-recurrence.js";
import type { CalendarEvent, TodoistTask } from "./types.js";

export type TodoistPhaseBFamily = "multi_month_day" | "alternate_weekday" | "quarterly";
export type TodoistPhaseBDisposition = "unsupported" | "rolling_required" | "native_exact";

export interface TodoistPhaseBAnchor {
  /** Original recurrence DTSTART from an independently verified provider/history record. */
  start: string;
  timeZone?: string;
  source: "verified_original_schedule";
}

export interface TodoistPhaseBResult {
  disposition: TodoistPhaseBDisposition;
  reason: string;
  family?: TodoistPhaseBFamily;
  candidateRrule?: string;
  semantic?: RecurrenceSemantics;
}

export interface TodoistPhaseBProviderReadback {
  /** Todoist task fetched just before completing a recurring iteration. */
  beforeCompletion: TodoistTask;
  /** Same Todoist task freshly fetched after provider completion advancement. */
  afterCompletion: TodoistTask;
  /** Calendar master fetched after the proposed native rule was persisted. */
  calendarMaster: CalendarEvent;
  /** Independently fetched Calendar instances, not a calculated local projection. */
  calendarInstances: CalendarEvent[];
  /** Caller has inventoried the complete applicable Calendar exceptions. */
  exceptionInventoryComplete: boolean;
  /** Both providers independently confirmed the same IANA timezone for timed rules. */
  timeZoneVerified: boolean;
}

const clockSuffix = /\s+(?:at\s+)?(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]m)?|(?:0?[1-9]|1[0-2])\s*[ap]m)$/i;
const weekdays = "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday|s)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";

function familyFor(key: string): TodoistPhaseBFamily | undefined {
  const phrase = key.replace(clockSuffix, "").trim();
  if (/^every\s+\d{1,2}(?:\s*,\s*\d{1,2})+$/.test(phrase)) return "multi_month_day";
  if (new RegExp("^every\\s+other\\s+" + weekdays + "$").test(phrase)) return "alternate_weekday";
  if (phrase === "every quarter" || phrase === "quarterly" || phrase === "every quarterly"
    || phrase === "every 3 months") return "quarterly";
  return undefined;
}

function localDue(task: TodoistTask, timeZone?: string, allowFloating = false): { date: string; time?: string } | undefined {
  const value = task.due?.datetime || task.due?.date;
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (!timeZone || (task.due?.timezone && task.due.timezone !== timeZone)) return undefined;
  // Todoist REST can persist a timed date in due.date, or expose it as a
  // floating value (without UTC offset). Accept floating only when a fresh
  // independent profile timezone was verified and matches Todoist.
  const floating = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(value);
  if (floating) return allowFloating ? { date: floating[1], time: floating[2] + ":" + floating[3] } : undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCMilliseconds() !== 0) return undefined;
  try {
    const fields = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(parsed).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    if (fields.second !== "00") return undefined;
    return { date: fields.year + "-" + fields.month + "-" + fields.day,
      time: fields.hour + ":" + fields.minute };
  } catch { return undefined; }
}

function candidate(task: TodoistTask, anchor?: TodoistPhaseBAnchor): TodoistPhaseBResult {
  const key = todoistRecurrenceKey(task);
  if (!key) return { disposition: "unsupported", reason: "not_recurring" };
  const family = familyFor(key);
  if (!family) return { disposition: "unsupported", reason: "not_phase_b_family" };
  const due = localDue(task, anchor?.timeZone || task.due?.timezone,
    Boolean(anchor?.timeZone && anchor.timeZone === task.due?.timezone));
  if (!due) return { disposition: "rolling_required", reason: "invalid_or_unverified_due", family };
  // A current Todoist due date is only a parser hint, never the original
  // DTSTART for a newly promoted recurrence.
  const context = { start: anchor?.start || (due.time ? (task.due?.datetime || task.due?.date || "") : due.date),
    timeZone: anchor?.timeZone || task.due?.timezone };
  const classified = classifyTodoistRule(key, context);
  if (!classified.semantic || !classified.canonicalRrule)
    return { disposition: classified.disposition === "unsupported" ? "unsupported" : "rolling_required",
      reason: classified.reason, family };
  const provisional: TodoistPhaseBResult = {
    disposition: "rolling_required", reason: "anchor_not_verified", family,
    candidateRrule: classified.canonicalRrule, semantic: classified.semantic,
  };
  if (!anchor || anchor.source !== "verified_original_schedule") return provisional;
  // Live Todoist provider evidence: "every 29,30,31" fills February with its
  // last day, and quarterly Jan31 -> Apr30 -> Jul30, whereas RFC5545 skips
  // nonexistent BYMONTHDAY. These are deliberately not native equivalents.
  if (family === "multi_month_day"
      && classified.semantic.byMonthDay?.some((day) => day > 28))
    return { ...provisional, reason: "month_end_provider_drift" };
  if (family === "quarterly"
      && Number(classified.semantic.startDate.slice(-2)) > 28)
    return { ...provisional, reason: "month_end_provider_drift" };
  const dates = occurrenceDates(classified.semantic, 100);
  if (!dates.length || dates[0] !== classified.semantic.startDate || !dates.includes(due.date)
    || (classified.semantic.localTime || undefined) !== (due.time || undefined))
    return { ...provisional, reason: "anchor_or_occurrence_mismatch" };
  return { ...provisional, reason: "provider_readback_required" };
}

/** Read-only candidate. By design it never returns native_exact. */
export function todoistPhaseBCandidate(task: TodoistTask, anchor?: TodoistPhaseBAnchor): TodoistPhaseBResult {
  return candidate(task, anchor);
}

function matchingLocalTime(value: { date?: string; dateTime?: string; timeZone?: string } | undefined,
  semantic: RecurrenceSemantics): string | undefined {
  return value ? localDue({ id: "calendar", content: "", due: {
    ...(value.date ? { date: value.date } : {}),
    ...(value.dateTime ? { datetime: value.dateTime } : {}),
  } }, semantic.timeZone, Boolean(semantic.timeZone))?.date : undefined;
}

function sameLocalOccurrence(value: { date?: string; dateTime?: string; timeZone?: string } | undefined,
  semantic: RecurrenceSemantics, expectedDate: string): boolean {
  if (!value) return false;
  const actual = localDue({ id: "calendar", content: "", due: {
    ...(value.date ? { date: value.date } : {}),
    ...(value.dateTime ? { datetime: value.dateTime } : {}),
  } }, semantic.timeZone, Boolean(semantic.timeZone));
  return Boolean(actual && actual.date === expectedDate
    && (actual.time || undefined) === (semantic.localTime || undefined));
}

/**
 * Return native_exact ONLY after fresh, independent Todoist and Calendar
 * provider observations. The result can be used by an explicitly gated
 * mutation workflow; ordinary production translation does not call this.
 */
export function verifyTodoistPhaseBReadback(
  task: TodoistTask,
  anchor: TodoistPhaseBAnchor,
  readback: TodoistPhaseBProviderReadback,
): TodoistPhaseBResult {
  const result = candidate(task, anchor);
  if (!result.semantic || !result.candidateRrule || result.reason !== "provider_readback_required")
    return result;
  const reject = (reason: string): TodoistPhaseBResult =>
    ({ ...result, disposition: "rolling_required", reason });
  const { beforeCompletion: before, afterCompletion: after, calendarMaster: master,
    calendarInstances: instances } = readback;
  if (task.id !== before.id || task.id !== after.id
    || !before.due?.is_recurring || !after.due?.is_recurring
    || !todoistRecurrenceKey(before) || !todoistRecurrenceKey(after))
    return reject("todoist_identity_or_recurrence_unverified");
  const beforeCandidate = candidate(before, anchor);
  const afterCandidate = candidate(after, anchor);
  if (beforeCandidate.candidateRrule !== result.candidateRrule
    || afterCandidate.candidateRrule !== result.candidateRrule
    || beforeCandidate.reason !== "provider_readback_required"
    || afterCandidate.reason !== "provider_readback_required")
    return reject("todoist_normalization_mismatch");
  if (result.semantic.localTime
    && (!readback.timeZoneVerified || !result.semantic.timeZone
      || before.due?.timezone !== result.semantic.timeZone
      || after.due?.timezone !== result.semantic.timeZone
      || master.start?.timeZone !== result.semantic.timeZone))
    return reject("timezone_not_verified");

  const dates = occurrenceDates(result.semantic, 100);
  const independentlyTimed = Boolean(readback.timeZoneVerified && result.semantic.timeZone);
  const priorDue = localDue(before, result.semantic.timeZone, independentlyTimed);
  const nextDue = localDue(after, result.semantic.timeZone, independentlyTimed);
  const previousIndex = priorDue ? dates.indexOf(priorDue.date) : -1;
  if (previousIndex < 0 || !nextDue || dates[previousIndex + 1] !== nextDue.date
    || (priorDue?.time || undefined) !== (result.semantic.localTime || undefined)
    || (nextDue.time || undefined) !== (result.semantic.localTime || undefined))
    return reject("completion_progression_mismatch");

  const shared = master.extendedProperties?.shared;
  if (!master.id || !master.etag || master.status !== "confirmed" || master.recurringEventId
    || shared?.taskId !== task.id || shared.syncRecurrenceOwner !== "todoist"
    || shared.todoistRecurrence !== todoistRecurrenceKey(before)
    || shared.todoistAnchorStart !== anchor.start
    || master.recurrence?.length !== 1 || !readback.exceptionInventoryComplete)
    return reject("calendar_master_or_exception_inventory_unverified");
  const persisted = classifyCalendarRule(master.recurrence[0], {
    start: master.start?.dateTime || master.start?.date || "",
    timeZone: master.start?.timeZone,
  });
  if (!persisted.semantic || !persisted.canonicalRrule
    || persisted.canonicalRrule !== result.candidateRrule
    || !sameLocalOccurrence(master.start, result.semantic, result.semantic.startDate)
    || !compareOccurrenceSemantics(result.semantic, persisted.semantic).equivalent)
    return reject("calendar_master_semantics_mismatch");

  // A provider query that returns only an empty or truncated list does not
  // prove the absence of exceptions or the intended sequence.
  if (instances.length < 3) return reject("calendar_instances_insufficient");
  let previous = -1;
  const ids = new Set<string>();
  for (const instance of instances) {
    if (!instance.id || ids.has(instance.id) || instance.recurringEventId !== master.id
      || instance.status !== "confirmed" || instance.recurrence?.length
      || instance.originalStartTime === undefined
      || (result.semantic.timeZone && ((instance.start?.timeZone && instance.start.timeZone !== result.semantic.timeZone)
        || (instance.originalStartTime.timeZone && instance.originalStartTime.timeZone !== result.semantic.timeZone))))
      return reject("calendar_instance_identity_or_exception_mismatch");
    ids.add(instance.id);
    const original = instance.originalStartTime;
    const day = matchingLocalTime(original, result.semantic);
    const index = day ? dates.indexOf(day) : -1;
    if (index < 0 || !sameLocalOccurrence(original, result.semantic, day!)
      || !sameLocalOccurrence(instance.start, result.semantic, day!)
      || (previous >= 0 && index !== previous + 1))
      return reject("calendar_instance_sequence_or_exception_mismatch");
    previous = index;
  }
  return { ...result, disposition: "native_exact", reason: "verified_equivalent" };
}
