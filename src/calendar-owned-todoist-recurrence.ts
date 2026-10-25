import type { CalendarEvent, TodoistTask } from "./types.js";

export interface CalendarOwnedTodoistRecurrence {
  dueString: string;
  endDate: string;
  weekday: string;
  rule: string;
}

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayCodes: Record<string, string> = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };

function localParts(value: string, timeZone: string): Record<string, string> {
  const date = value.length === 10 ? new Date(`${value}T00:00:00Z`) : new Date(value);
  const zone = value.length === 10 ? "UTC" : timeZone;
  if (!Number.isFinite(date.getTime())) throw new Error("Calendar recurrence start is not a valid date-time");
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric",
    ...(value.includes("T") ? { hour: "numeric", minute: "2-digit", hourCycle: "h12" as const } : {}),
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function localDate(value: string, timeZone: string): string {
  const parts = localParts(value, timeZone);
  return `${parts.day} ${parts.month} ${parts.year}`;
}

function ruleFields(rule: string): Record<string, string> | undefined {
  const match = rule.match(/^RRULE:(.+)$/i);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const component of match[1].split(";")) {
    const separator = component.indexOf("=");
    if (separator < 1) return undefined;
    const key = component.slice(0, separator).toUpperCase();
    if (fields[key] !== undefined) return undefined;
    fields[key] = component.slice(separator + 1).toUpperCase();
  }
  return fields;
}

export function finiteWeeklyCalendarRuleCandidate(master: CalendarEvent): boolean {
  if (master.recurrence?.length !== 1) return false;
  const fields = ruleFields(master.recurrence[0]);
  const count = Number(fields?.COUNT);
  return Boolean(fields?.FREQ === "WEEKLY" && !fields.INTERVAL && !fields.UNTIL
    && Number.isInteger(count) && count >= 2 && count <= 1000);
}

/**
 * Convert only finite weekly Google rules to a Todoist recurrence. A caller
 * must verify the Todoist account timezone matches the Calendar timezone.
 * COUNT is represented by an inclusive ending date from the expanded series.
 */
export function calendarOwnedTodoistRecurrence(
  master: CalendarEvent,
  instances: CalendarEvent[],
  timeZone: string,
): CalendarOwnedTodoistRecurrence | undefined {
  if (master.recurrence?.length !== 1) return undefined;
  const rule = master.recurrence[0];
  const fields = ruleFields(rule);
  const count = Number(fields?.COUNT);
  if (!fields || fields.FREQ !== "WEEKLY" || fields.INTERVAL
    || !Number.isInteger(count) || count < 2 || count > 1000 || fields.UNTIL || fields.BYMONTHDAY || fields.BYSETPOS
    || fields.BYYEARDAY || fields.BYWEEKNO || fields.BYMONTH || fields.BYHOUR || fields.BYMINUTE
    || fields.BYSECOND || fields.BYSETPOS) return undefined;

  const startValue = master.start?.dateTime || master.start?.date;
  if (!startValue) return undefined;
  const startParts = localParts(startValue, timeZone);
  const startWeekday = weekdayNames.find((name) => name.toLowerCase().startsWith(startParts.weekday.toLowerCase()));
  if (!startWeekday) return undefined;
  const byDay = fields.BYDAY?.split(",");
  const weekday = byDay?.length === 1 && weekdayCodes[byDay[0]]
    ? weekdayCodes[byDay[0]] : !byDay ? startWeekday : undefined;
  if (!weekday || weekday !== startWeekday) return undefined;

  // Google returns canceled exceptions in this inventory. They still count
  // toward the RRULE's finite COUNT, and their immutable start is the proper
  // inclusive end bound for Todoist.
  const scheduled = instances
    .filter((event) => event.recurringEventId === master.id)
    .filter((event) => event.originalStartTime?.dateTime || event.originalStartTime?.date)
    .sort((a, b) => (a.originalStartTime?.dateTime || a.originalStartTime?.date || "").localeCompare(b.originalStartTime?.dateTime || b.originalStartTime?.date || ""));
  if (scheduled.length !== count) return undefined;
  const end = scheduled.at(-1);
  const endStart = end?.originalStartTime?.dateTime || end?.originalStartTime?.date;
  if (!endStart) return undefined;

  const time = startParts.hour ? ` at ${startParts.hour}:${startParts.minute}${(startParts.dayPeriod || "").toLowerCase()}` : "";
  const startDate = localDate(startValue, timeZone);
  const endDate = endStart.length === 10 ? endStart : localDate(endStart, timeZone);
  const dueString = `every ${weekday}${time} starting ${startDate} ending ${endDate}`;
  return { dueString, endDate, weekday, rule };
}

export function calendarOwnedRecurringTaskPayload(
  event: CalendarEvent,
  recurrence: CalendarOwnedTodoistRecurrence,
): Omit<TodoistTask, "id"> {
  const start = event.start || {};
  return {
    content: event.summary || "Untitled calendar event",
    description: event.description || "",
    due: {
      ...(start.dateTime ? { datetime: start.dateTime, timezone: start.timeZone || "Europe/London" } : {}),
      ...(start.date ? { date: start.date } : {}),
      string: recurrence.dueString,
      lang: "en",
      is_recurring: true,
    },
  };
}

export function matchesCalendarOwnedRecurringTask(
  task: TodoistTask,
  event: CalendarEvent,
  recurrence: CalendarOwnedTodoistRecurrence,
): boolean {
  return matchesCalendarOwnedRecurringRule(task, recurrence)
    && startsMatchCalendarEvent(event, task);
}

export function matchesCalendarOwnedRecurringRule(
  task: TodoistTask,
  recurrence: CalendarOwnedTodoistRecurrence,
): boolean {
  if (!task.due?.is_recurring || !task.due.string || !task.due.string.toLowerCase().includes("ending")) return false;
  const normalized = task.due.string.toLowerCase().replace(/\s+/g, " ");
  const expected = recurrence.dueString.toLowerCase().replace(/\s+/g, " ");
  return normalized === expected;
}

function startsMatchCalendarEvent(event: CalendarEvent, task: TodoistTask): boolean {
  if (event.start?.date && task.due?.date) return event.start.date === task.due.date;
  const eventStart = event.start?.dateTime;
  const taskStart = task.due?.datetime || task.due?.date;
  if (!eventStart || !taskStart) return false;
  const left = Date.parse(eventStart);
  const right = Date.parse(taskStart);
  return Number.isFinite(left) && Number.isFinite(right) ? left === right : eventStart.slice(0, 19) === taskStart.slice(0, 19);
}
