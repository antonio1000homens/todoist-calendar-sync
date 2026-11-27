import { normalizedText } from "./security.js";
import {
  classifyCalendarRule, classifyTodoistRule, compareOccurrenceSemantics, recurrenceCadenceMatchesAtDate,
  recurrenceCivilAnchor,
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
  const key = todoistRecurrenceKey(task);
  const start = task.due?.datetime || task.due?.date;
  if (!key || !start || /\b(until|starting|ending)\b/.test(key)) return undefined;
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
  const key = todoistRecurrenceKey(task);
  if (!key) return !event.recurrence?.length;
  const todoistStart = task.due?.datetime || task.due?.date;
  const calendarStart = event.start?.dateTime || event.start?.date;
  const zone = event.start?.timeZone || task.due?.timezone;
  if (!todoistStart || !calendarStart) return false;
  const todoist = classifyTodoistRule(key, { start: todoistStart, timeZone: zone }).semantic;
  const dueDate = recurrenceCivilAnchor(todoistStart, zone)?.date;
  if (!todoist || !dueDate || !event.recurrence?.length) return false;
  const compatible = event.recurrence.some(rule => {
    const calendar = classifyCalendarRule(rule, { start: calendarStart, timeZone: zone }).semantic;
    return Boolean(calendar && recurrenceCadenceMatchesAtDate(calendar, todoist, dueDate));
  });
  return compatible && (!event.extendedProperties?.shared?.todoistRecurrence
    || event.extendedProperties.shared.todoistRecurrence === key);
}

/** Compare a provider RRULE readback to an expected rule using the shared
 * semantic parser and the event's own DTSTART/timezone context. */
export function calendarRuleMatches(event: {
  recurrence?: string[];
  start?: { date?: string; dateTime?: string; timeZone?: string };
}, expectedRule: string): boolean {
  const start = event.start?.dateTime || event.start?.date;
  if (!start || !event.recurrence?.length) return false;
  const context = { start, timeZone: event.start?.timeZone };
  const expected = classifyCalendarRule(expectedRule, context).semantic;
  if (!expected) return false;
  return event.recurrence.some((rule) => {
    const actual = classifyCalendarRule(rule, context).semantic;
    return Boolean(actual && compareOccurrenceSemantics(expected, actual).equivalent);
  });
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
