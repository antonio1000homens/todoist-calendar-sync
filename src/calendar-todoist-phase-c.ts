/**
 * Issue #290, Phase C: Calendar -> Todoist candidate and semantic readback.
 *
 * This module is intentionally not called by production sync/reconciliation.
 * It NEVER grants write/migration authority. A Calendar-owned native mirror
 * needs independent provider evidence, a verified identity link, and proven
 * Todoist completion advancement before a future gated writer can use it.
 */
import {
  classifyCalendarRule, classifyTodoistRule, compareOccurrenceSemantics,
  occurrenceDates, type RecurrenceSemantics,
} from "./recurrence-semantics.js";
import type { CalendarEvent, TodoistTask } from "./types.js";

export type CalendarPhaseCFamily =
  "multi_weekday" | "multi_month_day" | "alternate_weekday" | "monthly_interval";
export interface CalendarPhaseCCandidate {
  disposition: "unsupported" | "rolling_required" | "native_exact";
  reason: string;
  family?: CalendarPhaseCFamily;
  todoistPhrase?: string;
  candidateRrule?: string;
  semantic?: RecurrenceSemantics;
}
export interface CalendarPhaseCReadback {
  /** Fresh GET, not the response to an attempted Calendar write. */
  persistedMaster: CalendarEvent;
  /** Exact task returned by Todoist before/after a real completion. */
  beforeCompletion: TodoistTask;
  afterCompletion: TodoistTask;
  /** Independently fetched, consecutive instances with originalStartTime. */
  calendarInstances: CalendarEvent[];
  /** All explicit provider exceptions, not just the bounded instance page. */
  explicitExceptions: CalendarEvent[];
  exceptionInventoryComplete: boolean;
  timeZoneVerified: boolean;
  /** Independently established canonical recurrence link, never a title match. */
  verifiedLink: {
    masterEventId: string;
    taskId: string;
    projectId: string;
    owner: "calendar";
  };
}
const weekdayOrder = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const weekdayLabels: Record<string, string> = {
  MO: "mon", TU: "tue", WE: "wed", TH: "thu", FR: "fri", SA: "sat", SU: "sun",
};
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const offsetDateTime = /(?:Z|[+-]\d{2}:\d{2})$/i;

function decline(reason: string, family?: CalendarPhaseCFamily): CalendarPhaseCCandidate {
  return { disposition: "rolling_required", reason, ...(family ? { family } : {}) };
}
function timePhrase(time?: string): string {
  if (!time) return "";
  const [hours, minutes] = time.split(":").map(Number);
  return " at " + String(hours % 12 || 12) + ":" + String(minutes).padStart(2, "0")
    + (hours >= 12 ? "pm" : "am");
}
function localOccurrence(value: {date?: string; dateTime?: string; timeZone?: string} | undefined,
  zone?: string): { date: string; time?: string } | undefined {
  if (!value) return undefined;
  if (value.date && dateOnly.test(value.date) && !value.dateTime) return { date: value.date };
  if (!value.dateTime || !offsetDateTime.test(value.dateTime) || !zone
    || (value.timeZone && value.timeZone !== zone)) return undefined;
  const instant = new Date(value.dateTime);
  if (!Number.isFinite(instant.getTime()) || instant.getUTCMilliseconds()) return undefined;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(instant).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    if (parts.second !== "00") return undefined;
    return { date: parts.year + "-" + parts.month + "-" + parts.day,
      time: parts.hour + ":" + parts.minute };
  } catch { return undefined; }
}
function taskOccurrence(task: TodoistTask, semantic: RecurrenceSemantics) {
  if (semantic.localTime && task.due?.timezone !== semantic.timeZone) return undefined;
  return localOccurrence(task.due ? {
    date: task.due.datetime ? undefined : task.due.date,
    dateTime: task.due.datetime,
    timeZone: task.due.timezone,
  } : undefined, semantic.timeZone);
}
function sameOccurrence(actual: { date: string; time?: string } | undefined,
  expectedDate: string, semantic: RecurrenceSemantics): boolean {
  return Boolean(actual && actual.date === expectedDate
    && actual.time === semantic.localTime);
}
function phraseTime(value: string): string | undefined {
  const ending = /\s+(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\s*$/i.exec(value);
  if (!ending) return undefined;
  const hour = Number(ending[1]);
  if (hour < 1 || hour > 12) return undefined;
  return String(hour % 12 + (ending[3].toLowerCase() === "pm" ? 12 : 0)).padStart(2, "0")
    + ":" + (ending[2] || "00");
}
function normalizedTaskMatches(task: TodoistTask, candidate: CalendarPhaseCCandidate,
  anchor: string, zone?: string): boolean {
  const semantic = candidate.semantic;
  if (!semantic || !task.due?.is_recurring || !task.due.string) return false;
  const normalized = task.due.string.trim().replace(/\s+/g, " ");
  if (semantic.localTime) {
    if (phraseTime(normalized) !== semantic.localTime) return false;
  } else if (/\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(normalized)) return false;
  const parsed = classifyTodoistRule(normalized, { start: anchor, timeZone: zone });
  return Boolean(parsed.semantic && parsed.canonicalRrule === candidate.candidateRrule
    && compareOccurrenceSemantics(semantic, parsed.semantic).equivalent);
}

/** Describe a safe candidate; NEVER return native_exact or authorize a write. */
export function calendarPhaseCCandidate(master: CalendarEvent, timeZone?: string): CalendarPhaseCCandidate {
  if (!master.id || master.recurringEventId || master.status === "cancelled"
    || master.recurrence?.length !== 1 || master.extendedProperties?.shared?.syncRecurrenceOwner === "todoist")
    return { disposition: "unsupported", reason: "invalid_or_other_owned_master" };
  const start = master.start?.dateTime || master.start?.date;
  if (!start) return decline("original_start_missing");
  if (master.start?.dateTime && (!master.start.timeZone || master.start.timeZone !== timeZone))
    return decline("timezone_not_verified");
  const parsed = classifyCalendarRule(master.recurrence[0], { start, timeZone });
  if (!parsed.semantic || !parsed.canonicalRrule) return decline(parsed.reason);
  const s = parsed.semantic;
  if (s.count || s.until) return decline("finite_provider_validation_required");
  let family: CalendarPhaseCFamily | undefined;
  let phrase: string | undefined;
  if (s.frequency === "WEEKLY" && s.interval === 1 && s.byDay?.length && s.byDay.length >= 2) {
    family = "multi_weekday";
    phrase = "every " + s.byDay.map((d) => weekdayLabels[d]).join(", ");
  } else if (s.frequency === "MONTHLY" && s.interval === 1 && s.byMonthDay && s.byMonthDay.length >= 2) {
    family = "multi_month_day";
    phrase = "every " + s.byMonthDay.join(", ");
  } else if (s.frequency === "WEEKLY" && s.interval === 2 && s.byDay?.length === 1) {
    family = "alternate_weekday";
    phrase = "every other " + weekdayLabels[s.byDay[0]];
  } else if (s.frequency === "MONTHLY" && s.interval >= 2 && s.interval <= 12
    && !s.byDay?.length && !s.byMonthDay?.length && !s.byMonth?.length) {
    family = "monthly_interval";
    phrase = "every " + s.interval + " months";
  }
  if (!family || !phrase || !parsed.canonicalRrule)
    return { disposition: "unsupported", reason: "not_phase_c_family" };
  const dates = occurrenceDates(s, 20);
  if (dates.length < 12 || dates[0] !== s.startDate)
    return decline("anchor_or_occurrence_mismatch", family);
  const todoistPhrase = phrase + timePhrase(s.localTime);
  const reverse = classifyTodoistRule(todoistPhrase, { start, timeZone });
  if (!reverse.semantic || reverse.canonicalRrule !== parsed.canonicalRrule
    || !compareOccurrenceSemantics(s, reverse.semantic).equivalent)
    return decline("reverse_translation_not_equivalent", family);
  return {
    disposition: "rolling_required", reason: "provider_readback_required", family,
    todoistPhrase, candidateRrule: parsed.canonicalRrule, semantic: s,
  };
}

/**
 * Verify both provider readbacks and advancement of the SAME Todoist identity.
 * native_exact is an observation, never a production-write approval. A caller
 * must separately prove evidence provenance and use a guarded writer/rollback.
 */
export function verifyCalendarPhaseCReadback(master: CalendarEvent, timeZone: string | undefined,
  evidence: CalendarPhaseCReadback): CalendarPhaseCCandidate {
  const candidate = calendarPhaseCCandidate(master, timeZone);
  if (candidate.reason !== "provider_readback_required" || !candidate.semantic)
    return candidate;
  const reject = (reason: string) => ({ ...candidate, disposition: "rolling_required" as const, reason });
  const s = candidate.semantic;
  const persisted = evidence.persistedMaster;
  const link = evidence.verifiedLink;
  const before = evidence.beforeCompletion;
  const after = evidence.afterCompletion;
  if (!link || link.owner !== "calendar" || link.masterEventId !== master.id
    || !link.taskId || !link.projectId || before.id !== link.taskId || after.id !== link.taskId
    || before.project_id !== link.projectId || after.project_id !== link.projectId
    || before.is_deleted || after.is_deleted || before.is_completed || after.is_completed)
    return reject("recurrence_identity_or_owner_unverified");
  if (!persisted.id || persisted.id !== master.id || !persisted.etag || persisted.status !== "confirmed"
    || persisted.recurringEventId || persisted.recurrence?.length !== 1
    || persisted.extendedProperties?.shared?.syncRecurrenceOwner === "todoist")
    return reject("calendar_master_readback_mismatch");
  const persistedCandidate = calendarPhaseCCandidate(persisted, timeZone);
  if (!persistedCandidate.semantic || persistedCandidate.candidateRrule !== candidate.candidateRrule
    || !compareOccurrenceSemantics(s, persistedCandidate.semantic).equivalent)
    return reject("calendar_master_readback_mismatch");
  if (!evidence.exceptionInventoryComplete || !Array.isArray(evidence.explicitExceptions)
    || evidence.explicitExceptions.length !== 0
    || evidence.calendarInstances.some((item) => item.status === "cancelled"))
    return reject("calendar_exception_inventory_unverified");
  if (s.localTime && (!evidence.timeZoneVerified || !timeZone
    || persisted.start?.timeZone !== timeZone))
    return reject("timezone_not_verified");
  if (!normalizedTaskMatches(before, candidate, master.start?.dateTime || master.start?.date || "", timeZone)
    || !normalizedTaskMatches(after, candidate, master.start?.dateTime || master.start?.date || "", timeZone))
    return reject("todoist_normalized_rule_mismatch");
  const dates = occurrenceDates(s, 100);
  const previous = taskOccurrence(before, s);
  const next = taskOccurrence(after, s);
  const previousIndex = previous ? dates.indexOf(previous.date) : -1;
  if (previousIndex < 0 || previousIndex + 1 >= dates.length
    || !sameOccurrence(previous, dates[previousIndex], s)
    || !sameOccurrence(next, dates[previousIndex + 1], s))
    return reject("todoist_completion_progression_mismatch");
  if (!Array.isArray(evidence.calendarInstances) || evidence.calendarInstances.length < 3)
    return reject("calendar_instances_insufficient");
  const ids = new Set<string>();
  let priorIndex = -1;
  for (const instance of evidence.calendarInstances) {
    const original = localOccurrence(instance.originalStartTime, timeZone);
    const effective = localOccurrence(instance.start, timeZone);
    const index = original ? dates.indexOf(original.date) : -1;
    if (!instance.id || ids.has(instance.id) || instance.recurringEventId !== master.id
      || instance.status !== "confirmed" || instance.recurrence?.length
      || index < 0 || (priorIndex >= 0 && index !== priorIndex + 1)
      || !sameOccurrence(original, dates[index], s)
      || !sameOccurrence(effective, dates[index], s))
      return reject("calendar_instance_sequence_or_exception_mismatch");
    ids.add(instance.id);
    priorIndex = index;
  }
  return { ...candidate, disposition: "native_exact", reason: "verified_equivalent" };
}
