import { normalizedText } from "./security.js";
import type { CalendarEvent, TodoistTask } from "./types.js";

const weekdays: Record<string, string> = {
  mon: "MO",
  monday: "MO",
  tue: "TU",
  tues: "TU",
  tuesday: "TU",
  wed: "WE",
  weds: "WE",
  wednesday: "WE",
  thu: "TH",
  thur: "TH",
  thurs: "TH",
  thursday: "TH",
  fri: "FR",
  friday: "FR",
  sat: "SA",
  saturday: "SA",
  sun: "SU",
  sunday: "SU",
};

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
export function todoistRecurrenceToRrule(task: TodoistTask): string | undefined {
  const key = todoistRecurrenceKey(task);
  if (!key || key.includes("every!")) return undefined;
  if (/\b(until|starting|ending)\b/.test(key)) return undefined;
  const value = key
    .replace(/\s+at\s+.+$/, "")
    .replace(/\s+(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]m)?|(?:0?[1-9]|1[0-2])\s*[ap]m)$/i, "")
    .trim();

  if (value === "every day" || value === "daily") return "RRULE:FREQ=DAILY";
  if (value === "every weekday" || value === "every workday" || value === "weekdays") {
    return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  }
  if (value === "every week" || value === "weekly") return "RRULE:FREQ=WEEKLY";
  if (value === "every month" || value === "monthly") return "RRULE:FREQ=MONTHLY";
  if (value === "every year" || value === "yearly" || value === "annually" || value === "annual") {
    return "RRULE:FREQ=YEARLY";
  }

  const interval = value.match(/^every\s+(\d+)\s+(days?|weeks?|months?|years?)$/);
  if (interval) {
    const count = Number(interval[1]);
    if (!Number.isInteger(count) || count < 1) return undefined;
    const unit = interval[2].replace(/s$/, "");
    const frequency = unit === "day" ? "DAILY"
      : unit === "week" ? "WEEKLY"
        : unit === "month" ? "MONTHLY"
          : unit === "year" ? "YEARLY"
            : undefined;
    return frequency ? `RRULE:FREQ=${frequency};INTERVAL=${count}` : undefined;
  }

  const dayExpression = value.match(/^every\s+(.+)$/)?.[1];
  if (dayExpression) {
    const tokens = dayExpression
      .replace(/,/g, " ")
      .replace(/\band\b/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length && tokens.every((token) => Boolean(weekdays[token]))) {
      const days = [...new Set(tokens.map((token) => weekdays[token]))];
      return `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")}`;
    }
  }

  return undefined;
}

export function isTodoistOwnedCalendarRecurrence(event: { recurrence?: string[]; extendedProperties?: { shared?: Record<string, string> } }): boolean {
  return Boolean(
    event.recurrence?.length
    && event.extendedProperties?.shared?.syncRecurrenceOwner === "todoist",
  );
}

export function calendarRecurrenceMatchesTodoist(event: { recurrence?: string[]; extendedProperties?: { shared?: Record<string, string> } }, task: TodoistTask): boolean {
  const rrule = todoistRecurrenceToRrule(task);
  if (!rrule) return !event.recurrence?.length;
  return Boolean(
    event.recurrence?.includes(rrule)
    && event.extendedProperties?.shared?.syncRecurrenceOwner === "todoist"
    && event.extendedProperties?.shared?.todoistRecurrence === todoistRecurrenceKey(task),
  );
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
