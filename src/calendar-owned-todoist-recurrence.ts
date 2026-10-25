import type { CalendarEvent, TodoistTask } from "./types.js";

export interface CalendarOwnedTodoistRecurrence {
  dueString: string;
  endDate: string;
  weekday: string;
  rule: string;
}

export interface CalendarOwnedRecurringTaskReadback {
  matches: boolean;
  expected: {
    frequency: "weekly";
    weekday?: string;
    time?: string;
    startDate?: string;
    endDate?: string;
  };
  observed: {
    recurring: boolean;
    dueDate?: string;
    recurrenceParsed: boolean;
    frequency?: "weekly";
    weekday?: string;
    time?: string;
    startDate?: string;
    endDate?: string;
    startYearOmitted?: boolean;
    endYearOmitted?: boolean;
  };
}

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longMonthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const weekdayCodes: Record<string, string> = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };
const weekdayLookup = new Map(weekdayNames.flatMap((name) => [[name.toLowerCase(), name], [name.slice(0, 3).toLowerCase(), name]]));
const monthLookup = new Map(monthNames.flatMap((name, index) => [
  [name.toLowerCase(), index + 1],
  [longMonthNames[index].toLowerCase(), index + 1],
]));

interface ParsedDate {
  day: number;
  month: number;
  year?: number;
}

interface ParsedWeeklySchedule {
  weekday: string;
  time?: string;
  start: ParsedDate;
  end: ParsedDate;
}

type WeeklyPhraseKind = "starting_ending" | "from_until" | "starting_only" | "ending_only" | "other";

interface WeeklyScheduleParseDiagnostics {
  phraseKind: WeeklyPhraseKind;
  weekdayRecognized: boolean;
  startDateParsed: boolean;
  endDateParsed: boolean;
  timePresent: boolean;
  timeParsed: boolean;
}

interface WeeklyScheduleParseResult {
  schedule?: ParsedWeeklySchedule;
  diagnostics: WeeklyScheduleParseDiagnostics;
}

function parseNaturalDate(value: string): ParsedDate | undefined {
  const normalized = value.trim().toLowerCase().replace(/,/g, "").replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const iso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const dayFirst = normalized.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
  const monthFirst = normalized.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  const match = dayFirst || monthFirst;
  if (!match) return undefined;
  const day = Number(dayFirst ? match[1] : match[2]);
  const monthText = (dayFirst ? match[2] : match[1]).replace(/\.$/, "");
  const month = monthLookup.get(monthText);
  const yearText = dayFirst ? match[3] : match[3];
  const year = yearText ? Number(yearText) : undefined;
  if (!month || day < 1 || day > 31 || (year !== undefined && (!Number.isInteger(year) || year < 1))) return undefined;
  return { day, month, ...(year ? { year } : {}) };
}

function parseTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  if (minute > 59) return undefined;
  if (match[3]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
  } else if (hour > 23) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseWeeklyScheduleDetailed(value: string | undefined): WeeklyScheduleParseResult {
  const emptyDiagnostics: WeeklyScheduleParseDiagnostics = {
    phraseKind: "other", weekdayRecognized: false,
    startDateParsed: false, endDateParsed: false, timePresent: false, timeParsed: true,
  };
  if (!value) return { diagnostics: emptyDiagnostics };
  const normalized = value.trim().replace(/\s+/g, " ");
  const weekdayMatch = normalized.match(/^every\s+([a-z]+)\b/i);
  const weekday = weekdayMatch ? weekdayLookup.get(weekdayMatch[1].toLowerCase()) : undefined;
  const hasStarting = /\bstarting\b/i.test(normalized);
  const hasEnding = /\bending\b/i.test(normalized);
  const hasFrom = /\bfrom\b/i.test(normalized);
  const hasUntil = /\b(?:until|to)\b/i.test(normalized);
  const phraseKind: WeeklyPhraseKind = hasStarting && hasEnding ? "starting_ending"
    : hasFrom && hasUntil ? "from_until"
      : hasStarting ? "starting_only"
        : hasEnding ? "ending_only" : "other";
  const beforeDates = normalized.split(/\b(?:starting|from)\b/i, 1)[0];
  const timePresent = Boolean(weekdayMatch && /\bat\b/i.test(beforeDates.slice(weekdayMatch[0].length)));
  const match = normalized.match(/^every\s+([a-z]+)(?:\s+at\s+(.+?))?\s+starting\s+(.+?)\s+(?:and\s+)?ending\s+(.+)$/i);
  const startText = match?.[3];
  const endText = match?.[4];
  const start = startText ? parseNaturalDate(startText) : undefined;
  const end = endText ? parseNaturalDate(endText) : undefined;
  const time = match?.[2] === undefined ? undefined : parseTime(match[2]);
  const diagnostics: WeeklyScheduleParseDiagnostics = {
    phraseKind,
    weekdayRecognized: Boolean(weekday),
    startDateParsed: Boolean(start),
    endDateParsed: Boolean(end),
    timePresent,
    timeParsed: !timePresent || Boolean(time),
  };
  if (!match || !weekday || !start || !end || (match[2] !== undefined && !time)) return { diagnostics };
  return { schedule: { weekday, ...(time ? { time } : {}), start, end }, diagnostics };
}

function parseWeeklySchedule(value: string | undefined): ParsedWeeklySchedule | undefined {
  return parseWeeklyScheduleDetailed(value).schedule;
}

function sameDate(expected: ParsedDate, observed: ParsedDate, allowYearOmission: boolean): boolean {
  return expected.day === observed.day && expected.month === observed.month
    && (observed.year === expected.year || (allowYearOmission && observed.year === undefined));
}

function formatParsedDate(date: ParsedDate): string {
  return `${date.year ? `${date.year}-` : ""}${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export async function resolveCalendarTimeZone(
  master: CalendarEvent,
  readCalendarTimeZone?: () => Promise<string>,
): Promise<string> {
  const timeZone = master.start?.timeZone || (readCalendarTimeZone ? await readCalendarTimeZone() : undefined);
  if (!timeZone) throw new Error("Calendar timezone is unavailable");
  try { new Intl.DateTimeFormat("en-GB", { timeZone }); }
  catch { throw new Error("Calendar timezone is invalid"); }
  return timeZone;
}

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
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${Number(day)} ${monthNames[Number(month) - 1]} ${year}`;
  }
  const parts = localParts(value, timeZone);
  const month = monthNames.find((name) => name.toLowerCase().startsWith(parts.month.toLowerCase().slice(0, 3))) || parts.month;
  return `${parts.day} ${month} ${parts.year}`;
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
  const endDate = localDate(endStart, timeZone);
  const dueString = `every ${weekday}${time} starting ${startDate} and ending ${endDate}`;
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
  return calendarOwnedRecurringTaskReadback(task, event, recurrence).matches;
}

export function matchesCalendarOwnedRecurringRule(
  task: TodoistTask,
  recurrence: CalendarOwnedTodoistRecurrence,
): boolean {
  const expected = parseWeeklySchedule(recurrence.dueString);
  const observed = parseWeeklySchedule(task.due?.string);
  const allowYearOmission = Boolean(expected?.start.year && expected.start.year === expected.end.year);
  return Boolean(task.due?.is_recurring && expected && observed
    && expected.weekday === observed.weekday
    && expected.time === observed.time
    && sameDate(expected.start, observed.start, allowYearOmission)
    && sameDate(expected.end, observed.end, allowYearOmission));
}

/**
 * Verify the structured recurrence meaning of Todoist's human-readable due
 * string. Todoist documents `due.string` as a human-readable representation,
 * not an echo of the exact request text. Accept its harmless month/year
 * formatting normalization while requiring cadence and inclusive boundaries
 * to remain the same. Omitted years are resolved against the expected dates;
 * explicit different years remain a mismatch.
 */
export function calendarOwnedRecurringTaskReadback(
  task: TodoistTask,
  event: CalendarEvent,
  recurrence: CalendarOwnedTodoistRecurrence,
): CalendarOwnedRecurringTaskReadback {
  const expectedSchedule = parseWeeklySchedule(recurrence.dueString);
  const observedParse = parseWeeklyScheduleDetailed(task.due?.string);
  const observedSchedule = observedParse.schedule;
  const allowYearOmission = Boolean(expectedSchedule?.start.year
    && expectedSchedule.start.year === expectedSchedule.end.year);
  const expected = {
    frequency: "weekly" as const,
    ...(expectedSchedule ? {
      weekday: expectedSchedule.weekday,
      ...(expectedSchedule.time ? { time: expectedSchedule.time } : {}),
      startDate: formatParsedDate(expectedSchedule.start),
      endDate: formatParsedDate(expectedSchedule.end),
    } : {}),
  };
  const observed = {
    recurring: Boolean(task.due?.is_recurring),
    ...(task.due?.date || task.due?.datetime ? { dueDate: task.due.date || task.due.datetime } : {}),
    recurrenceParsed: Boolean(observedSchedule),
    ...observedParse.diagnostics,
    ...(observedSchedule ? {
      frequency: "weekly" as const,
      weekday: observedSchedule.weekday,
      ...(observedSchedule.time ? { time: observedSchedule.time } : {}),
      startDate: formatParsedDate(observedSchedule.start),
      endDate: formatParsedDate(observedSchedule.end),
      startYearOmitted: observedSchedule.start.year === undefined,
      endYearOmitted: observedSchedule.end.year === undefined,
    } : {}),
  };
  const matches = Boolean(task.due?.is_recurring && expectedSchedule && observedSchedule
    && expectedSchedule.weekday === observedSchedule.weekday
    && expectedSchedule.time === observedSchedule.time
    && sameDate(expectedSchedule.start, observedSchedule.start, allowYearOmission)
    && sameDate(expectedSchedule.end, observedSchedule.end, allowYearOmission)
    && startsMatchCalendarEvent(event, task));
  return { matches, expected, observed };
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
