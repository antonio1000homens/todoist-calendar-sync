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
  if (semantic.localTime && task.due?.timezone && task.due.timezone !== semantic.timeZone) return undefined;
  const due = task.due;
  // Todoist can persist floating local due.datetime when its project/account
  // timezone was verified separately. Never feed this through Date.parse().
  const floating = due?.datetime?.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::00)?$/);
  if (floating && semantic.timeZone)
    return { date: floating[1], time: floating[2] + ":" + floating[3] };
  return localOccurrence(due ? {
    date: due.datetime ? undefined : due.date,
    dateTime: due.datetime,
    timeZone: due.timezone,
  } : undefined, semantic.timeZone);
}
function sameOccurrence(actual: { date: string; time?: string } | undefined,
  expectedDate: string, semantic: RecurrenceSemantics): boolean {
  return Boolean(actual && actual.date === expectedDate
    && actual.time === semantic.localTime);
}
function phraseTime(value: string): string | undefined {
  const ending = /\s+(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\s*$/i.exec(value);
  if (!ending) {
    const clock24 = /\s+(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\s*$/i.exec(value);
    return clock24 ? String(Number(clock24[1])).padStart(2, "0") + ":" + clock24[2] : undefined;
  }
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
  } else if (/\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(normalized)
    || /\s+(?:at\s+)?(?:[01]?\d|2[0-3]):[0-5]\d$/i.test(normalized)) return false;
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
 * Post-write provider readback for the *already independently validated* Phase C
 * subset. Validates the provider-normalized recurrence, anchored due date, wall
 * clock and timezone. This is a single-write guard, not completion provenance.
 */
export function matchesCalendarPhaseCTask(
  task: TodoistTask, candidate: CalendarPhaseCCandidate, anchor: string, timeZone?: string,
): boolean {
  if (!candidate.semantic || candidate.reason !== "provider_readback_required" || !anchor) return false;
  // The provider may expose a floating local datetime. Normalize Todoist's
  // due text against the Calendar-local DTSTART, not a date-only anchor that
  // would silently lose the 09:00 wall clock across DST.
  const localAnchor = candidate.semantic.startDate
    + (candidate.semantic.localTime ? "T" + candidate.semantic.localTime + ":00" : "");
  if (!normalizedTaskMatches(task, candidate, localAnchor, timeZone)) return false;
  const due = taskOccurrence(task, candidate.semantic);
  return Boolean(due && phaseCDateMatches(candidate.semantic, due.date)
    && due.time === candidate.semantic.localTime);
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const DAY_MS = 86_400_000;
/** Calendar-date membership without unbounded RRULE expansion or DST arithmetic.
 * The four Phase C families only use weekly BYDAY or fixed monthly days. */
function phaseCDateMatches(semantic: RecurrenceSemantics, iso: string): boolean {
  if (!dateOnly.test(iso)) return false;
  const anchor = new Date(semantic.startDate + "T00:00:00Z");
  const date = new Date(iso + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso
    || date.getTime() < anchor.getTime()) return false;
  if (semantic.frequency === "WEEKLY") {
    const firstMonday = anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * DAY_MS;
    const thisMonday = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS;
    const weeks = (thisMonday - firstMonday) / (DAY_MS * 7);
    return Number.isInteger(weeks) && weeks % semantic.interval === 0
      && Boolean(semantic.byDay?.includes(DAY_CODES[date.getUTCDay()]));
  }
  if (semantic.frequency === "MONTHLY") {
    const months = (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12
      + date.getUTCMonth() - anchor.getUTCMonth();
    return months >= 0 && months % semantic.interval === 0
      && (semantic.byMonthDay?.length
        ? semantic.byMonthDay.includes(date.getUTCDate())
        : date.getUTCDate() === anchor.getUTCDate());
  }
  return false;
}
function phaseCNextDate(semantic: RecurrenceSemantics, iso: string): string | undefined {
  const start = Date.parse(iso + "T00:00:00Z");
  // Every whitelisted pattern has a successor in <= 370 civil days.
  for (let offset = 1; offset <= 370; offset++) {
    const next = new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
    if (phaseCDateMatches(semantic, next)) return next;
  }
  return undefined;
}

/** Every returned Google instance must agree with the anchored RRULE sequence.
 * A complete *explicit exception inventory* is checked separately. */
export function calendarPhaseCInstancesConform(
  master: CalendarEvent, instances: CalendarEvent[],
  candidate: CalendarPhaseCCandidate, timeZone?: string,
): boolean {
  if (!candidate.semantic || candidate.reason !== "provider_readback_required"
    || instances.length < 3) return false;
  const ids = new Set<string>();
  let previousDate: string | undefined;
  for (const item of instances) {
    const original = localOccurrence(item.originalStartTime, timeZone);
    const actual = localOccurrence(item.start, timeZone);
    if (!item.id || ids.has(item.id) || item.recurringEventId !== master.id
      || item.status !== "confirmed" || item.recurrence?.length
      || !original || !actual || !phaseCDateMatches(candidate.semantic, original.date)
      || (previousDate && phaseCNextDate(candidate.semantic, previousDate) !== original.date)
      || original.date !== actual.date || original.time !== actual.time
      || original.time !== candidate.semantic.localTime)
      return false;
    ids.add(item.id);
    previousDate = original.date;
  }
  return true;
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
    || evidence.explicitExceptions.length !== 0 || !Array.isArray(evidence.calendarInstances)
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
