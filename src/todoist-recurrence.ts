import { normalizedText } from "./security.js";
import {
  classifyCalendarRule, classifyTodoistRule, compareOccurrenceSemantics, recurrenceCadenceMatchesAtDate,
  recurrenceCivilAnchor, recurrenceIncludesDate,
} from "./recurrence-semantics.js";
import type { CalendarEvent, TodoistTask } from "./types.js";

function hasOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function localDateTime(value: string, timeZone: string): string {
  if (!hasOffset(value)) return value.slice(0, 19);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

export function todoistRecurrenceKey(task: TodoistTask): string | undefined {
  if (!task.due?.is_recurring) return undefined;
  const value = normalizedText(task.due.string).toLowerCase();
  return value || undefined;
}

const recurrenceMonths = new Map("january february march april may june july august september october november december"
  .split(" ").flatMap((name, index) => [[name, index + 1], [name.slice(0, 3), index + 1] as const]));

function recurrenceStartClause(value: string): { expression: string; startDate?: string; startMonthDay?: string; invalid: boolean } {
  const match = /^(.*?)\s+starting(?:\s+on)?\s+(.+)$/i.exec(value.trim());
  if (!match) return { expression: value, invalid: false };
  const suffix = match[2].trim().replace(/,/g, "").replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
  let date: string | undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(suffix);
  const named = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/i.exec(suffix);
  if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (named) {
    const month = recurrenceMonths.get(named[2].toLowerCase().replace(/\.$/, ""));
    if (month && !named[3]) {
      const day = Number(named[1]);
      if (day >= 1 && day <= 31) return { expression: match[1],
        startMonthDay: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, invalid: false };
    }
    if (month && named[3]) date = `${named[3]}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
  }
  if (!date) return { expression: match[1], invalid: true };
  const [year, month, day] = date.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    return { expression: match[1], invalid: true };
  return { expression: match[1], startDate: date, invalid: false };
}

/**
 * Translate only recurrence expressions that have an unambiguous RFC5545
 * equivalent. Todoist completion-relative `every!` rules and richer natural
 * language expressions deliberately fall back to the rolling projection.
 * A trailing time is safe to ignore here because DTSTART carries the
 * authoritative occurrence time and timezone. Todoist may expose timed
 * recurrence strings either as `every day at 9am` or as the normalized API
 * form `every week 09:30`.
 */
export function todoistRecurrenceToRrule(task: TodoistTask, anchor?: { start: string; timeZone?: string }): string | undefined {
  const rawKey = todoistRecurrenceKey(task);
  const start = task.due?.datetime || task.due?.date;
  if (!rawKey || !start || /\b(until|ending)\b/.test(rawKey)) return undefined;
  const projection = recurrenceStartClause(rawKey);
  if (projection.invalid) return undefined;
  const key = projection.expression;
  // Todoist's "every other Monday" idiom remains Phase B gated until its
  // completion progression has been verified from provider readback.
  if (/^every other (?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i.test(key)) return undefined;
  const anchorDate = recurrenceCivilAnchor(start, anchor?.timeZone || task.due?.timezone)?.date;
  if (anchorDate && Number(anchorDate.slice(-2)) > 28
    && (/^(?:every\s+)?quarter(?:ly)?$/.test(key)
      || /^every\s+\d{1,2}(?:\s*,\s*\d{1,2})+$/.test(key))) return undefined;
  // Natural-language translation is owned by the shared semantic parser.
  // Native projection eligibility remains here: only a task with a verified
  // provider anchor and a parseable, non-bounded rule can become an RRULE.
  const context = anchor || { start, timeZone: task.due?.timezone };
  const classified = classifyTodoistRule(key, context);
  if ((projection.startDate || projection.startMonthDay) && (!anchor || !classified.semantic)) return undefined;
  if (projection.startDate && anchor) {
    const dueDate = recurrenceCivilAnchor(start, anchor.timeZone || task.due?.timezone)?.date;
    if (!dueDate || projection.startDate > dueDate || !recurrenceIncludesDate(classified.semantic!, projection.startDate)) return undefined;
  }
  if (projection.startMonthDay && anchor) {
    const dueDate = recurrenceCivilAnchor(start, anchor.timeZone || task.due?.timezone)?.date;
    const anchorDate = recurrenceCivilAnchor(anchor.start, anchor.timeZone)?.date;
    const throughYear = Number(dueDate?.slice(0, 4));
    if (!anchorDate || !dueDate) return undefined;
    const fromYear = Number(anchorDate.slice(0, 4));
    let validProjection = false;
    for (let year = fromYear; year <= throughYear; year++) {
      const candidate = `${year}-${projection.startMonthDay}`;
      if (candidate <= dueDate && recurrenceIncludesDate(classified.semantic!, candidate)) validProjection = true;
    }
    if (!validProjection) return undefined;
  }
  if (!anchor && classified.semantic?.localTime) {
    const dueAnchor = recurrenceCivilAnchor(start, task.due?.timezone);
    if (!dueAnchor || dueAnchor.time !== classified.semantic.localTime) return undefined;
  }
  return classified.canonicalRrule;
}

export function isTodoistOwnedCalendarRecurrence(event: { recurrence?: string[]; extendedProperties?: { shared?: Record<string, string> } }): boolean {
  return Boolean(
    event.recurrence?.length
    && Boolean(event.extendedProperties?.shared?.todoistRecurrence),
  );
}

export function calendarRecurrenceMatchesTodoist(event: {
  recurrence?: string[];
  start?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { shared?: Record<string, string> };
}, task: TodoistTask): boolean {
  const rawKey = todoistRecurrenceKey(task);
  if (!rawKey) return !event.recurrence?.length;
  const key = recurrenceStartClause(rawKey);
  if (key.invalid) return false;
  const todoistStart = task.due?.datetime || task.due?.date;
  const calendarStart = event.start?.dateTime || event.start?.date;
  const zone = event.start?.timeZone || task.due?.timezone;
  if (!todoistStart || !calendarStart || !hasSingleRrule(event.recurrence)) return false;
  const todoist = classifyTodoistRule(key.expression, { start: todoistStart, timeZone: zone }).semantic;
  const dueDate = recurrenceCivilAnchor(todoistStart, zone)?.date;
  if (!todoist || !dueDate || !event.recurrence?.length) return false;
  const calendar = classifyCalendarRule(event.recurrence![0], { start: calendarStart, timeZone: zone }).semantic;
  let projectedStartMatches = !key.startDate && !key.startMonthDay;
  if (calendar && key.startDate) projectedStartMatches = key.startDate <= dueDate && recurrenceIncludesDate(calendar, key.startDate);
  if (calendar && key.startMonthDay) {
    const fromYear = Number(calendar.startDate.slice(0, 4));
    const throughYear = Number(dueDate.slice(0, 4));
    for (let year = fromYear; year <= throughYear; year++) {
      const candidate = `${year}-${key.startMonthDay}`;
      if (candidate <= dueDate && recurrenceIncludesDate(calendar, candidate)) projectedStartMatches = true;
    }
  }
  const compatible = Boolean(calendar && recurrenceCadenceMatchesAtDate(calendar, todoist, dueDate)
    && projectedStartMatches);
  return compatible && (!event.extendedProperties?.shared?.todoistRecurrence
    || event.extendedProperties.shared.todoistRecurrence === rawKey);
}

/** Compare a provider RRULE readback to an expected rule using the shared
 * semantic parser and the event's own DTSTART/timezone context. */
export function calendarRuleMatches(event: {
  recurrence?: string[];
  start?: { date?: string; dateTime?: string; timeZone?: string };
}, expectedRule: string): boolean {
  const start = event.start?.dateTime || event.start?.date;
  if (!start || !hasSingleRrule(event.recurrence)) return false;
  const context = { start, timeZone: event.start?.timeZone };
  const expected = classifyCalendarRule(expectedRule, context).semantic;
  if (!expected) return false;
  const actual = classifyCalendarRule(event.recurrence![0], context).semantic;
  return Boolean(actual && compareOccurrenceSemantics(expected, actual).equivalent);
}

/** Google stores a series schedule as recurrence components. A rule match is
 * only sufficient when the entire stored schedule consists of that one RRULE;
 * RDATE/EXDATE/EXRULE or extra RRULE components need explicit handling. */
function hasSingleRrule(recurrence: string[] | undefined): recurrence is [string] {
  return Boolean(recurrence?.length === 1 && /^RRULE:/i.test(recurrence[0].trim()));
}

/** Immutable logical identity for a Google recurring instance. */
export function recurrenceOriginalStart(event: CalendarEvent): string | undefined {
  return event.originalStartTime?.dateTime || event.originalStartTime?.date || event.start?.dateTime || event.start?.date;
}

/** Actual scheduled time after a Google per-instance exception has been applied. */
export function recurrenceEffectiveStart(event: CalendarEvent): string | undefined {
  return event.start?.dateTime || event.start?.date;
}

function taskDueValue(task: TodoistTask): string | undefined {
  return task.due?.datetime || task.due?.date;
}

function logicalStartMatchesTask(event: CalendarEvent, task: TodoistTask): boolean {
  const logical = recurrenceOriginalStart(event);
  const due = taskDueValue(task);
  if (!logical || !due) return false;
  const logicalAllDay = /^\d{4}-\d{2}-\d{2}$/.test(logical);
  const dueAllDay = /^\d{4}-\d{2}-\d{2}$/.test(due);
  if (logicalAllDay || dueAllDay) return logicalAllDay && dueAllDay && logical.slice(0, 10) === due.slice(0, 10);
  if (!hasOffset(due)) {
    return localDateTime(logical, event.originalStartTime?.timeZone || event.start?.timeZone || task.due?.timezone || "Europe/London") === due.slice(0, 19);
  }
  const left = Date.parse(logical);
  const right = Date.parse(due);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * Resolve the Google instance represented by Todoist's current recurring due
 * iteration. Existing binding wins because a moved exception's effective date
 * no longer matches its immutable logical start.
 */
export function selectTodoistCurrentInstance(
  instances: CalendarEvent[],
  task: TodoistTask,
  activeInstanceId?: string,
): CalendarEvent | undefined {
  if (activeInstanceId) {
    const active = instances.find((event) => event.id === activeInstanceId && event.status !== "cancelled");
    if (active) return active;
  }
  return instances.find((event) => event.status !== "cancelled" && logicalStartMatchesTask(event, task));
}

function effectiveTime(event: CalendarEvent): number {
  const value = recurrenceEffectiveStart(event);
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Select by effective Calendar time, not recurrence logical order. This is
 * important when a future exception is moved across another occurrence.
 * Cancelled exceptions are omitted, which makes Calendar deletion a deferred
 * "skip this occurrence" instruction for the Todoist recurrence.
 */
export function selectNextEffectiveTodoistInstance(
  instances: CalendarEvent[],
  activeInstanceId?: string,
  activeEffectiveStart?: string,
): CalendarEvent | undefined {
  const ordered = instances
    .filter((event) => event.status !== "cancelled" && Boolean(recurrenceEffectiveStart(event)))
    .sort((a, b) => {
      const time = effectiveTime(a) - effectiveTime(b);
      if (time) return time;
      const logical = (recurrenceOriginalStart(a) || "").localeCompare(recurrenceOriginalStart(b) || "");
      return logical || a.id.localeCompare(b.id);
    });
  if (activeInstanceId) {
    const index = ordered.findIndex((event) => event.id === activeInstanceId);
    if (index >= 0) return ordered[index + 1];
  }
  const after = activeEffectiveStart ? Date.parse(activeEffectiveStart) : Number.NaN;
  if (Number.isFinite(after)) return ordered.find((event) => effectiveTime(event) > after);
  return ordered[0];
}
