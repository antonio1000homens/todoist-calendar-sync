import type { CalendarEvent, TodoistTask } from "./types.js";

export interface CalendarOwnedTodoistRecurrence {
  dueString: string;
  endDate?: string;
  weekday?: string;
  rule: string;
  /** Native Todoist cadence; omitted for legacy finite-weekly rules. */
  frequency?: "weekly" | "monthly" | "yearly";
  dayOfMonth?: number;
  month?: number;
  time?: string;
  startDate?: string;
}

export interface CalendarOwnedRecurringTaskReadback {
  matches: boolean;
  expected: {
    frequency: "weekly" | "monthly" | "yearly";
    weekday?: string;
    dayOfMonth?: number;
    month?: number;
    time?: string;
    startDate?: string;
    endDate?: string;
  };
  observed: {
    recurring: boolean;
    dueDate?: string;
    recurrenceParsed: boolean;
    frequency?: "weekly" | "monthly" | "yearly";
    weekday?: string;
    dayOfMonth?: number;
    month?: number;
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

type WeeklyPhraseKind = "starting_ending" | "starting_on_ending_on" | "from_until" | "starting_only" | "ending_only" | "other";

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

function parseWeeklyScheduleDetailed(value: string | undefined, currentDueDate?: string, timeZone?: string): WeeklyScheduleParseResult {
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
  const startEndMatch = normalized.match(/\bstarting\s+(on\s+)?[\s\S]+?\s+(?:and\s+)?ending\s+(on\s+)?/i);
  const phraseKind: WeeklyPhraseKind = hasStarting && hasEnding
    ? (startEndMatch?.[1] || startEndMatch?.[2] ? "starting_on_ending_on" : "starting_ending")
    : hasFrom && hasUntil ? "from_until"
      : hasStarting ? "starting_only"
        : hasEnding ? "ending_only" : "other";
  const beforeDates = normalized.split(/\b(?:starting|from)\b/i, 1)[0];
  const timePresent = Boolean(weekdayMatch && /\bat\b/i.test(beforeDates.slice(weekdayMatch[0].length)));
  const timeCandidate = timePresent
    ? beforeDates.slice(weekdayMatch?.[0].length || 0).match(/\bat\s+(.+)$/i)?.[1]?.trim()
    : undefined;
  const parsedTime = timeCandidate ? parseTime(timeCandidate) : undefined;
  const match = normalized.match(/^every\s+([a-z]+)(?:\s+at\s+(.+?))?\s+starting\s+(.+?)\s+(?:and\s+)?ending\s+(.+)$/i);
  // Todoist normalizes some finite rules to an ending-only phrase. Its Help
  // Center defines that form as starting today and ending inclusively; the
  // API's due.date is the current iteration, so use that date as the anchor.
  // All-day Calendar tasks use a date-only due value. Timed Todoist tasks can
  // return a local datetime in `due.date`; its calendar date is safe to use as
  // the anchor because the caller verifies the provider and Calendar zones.
  const endingOnly = normalized.match(/^every\s+([a-z]+)(?:\s+at\s+(.+?))?\s+ending\s+(.+)$/i);
  const localDueMatch = currentDueDate?.match(/^(\d{4}-\d{2}-\d{2})(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$)/);
  const zonedDueMatch = currentDueDate?.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  let currentDueText = localDueMatch?.[1];
  if (!currentDueText && zonedDueMatch && timeZone) {
    const instant = new Date(currentDueDate!);
    if (Number.isFinite(instant.getTime())) {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
          timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
        currentDueText = `${parts.year}-${parts.month}-${parts.day}`;
      } catch {
        // An invalid or unavailable zone must fail closed rather than throw.
      }
    }
  }
  const currentDue = currentDueText
    && new Date(`${currentDueText}T00:00:00Z`).toISOString().slice(0, 10) === currentDueText
    ? parseNaturalDate(currentDueText) : undefined;
  const endingOnlyEnd = endingOnly ? parseNaturalDate(endingOnly[3]) : undefined;
  const startText = match?.[3];
  const endText = match?.[4];
  const boundedDates = normalized.match(/\b(?:starting|from)\s+(.+?)\s+(?:and\s+)?(?:ending|until|to)\s+(.+)$/i);
  const parseDateCandidate = (candidate: string | undefined): ParsedDate | undefined => candidate
    ? parseNaturalDate(candidate.trim().replace(/^on\s+/i, ""))
    : undefined;
  const start = parseDateCandidate(boundedDates?.[1] || startText);
  const end = parseDateCandidate(boundedDates?.[2] || endText);
  const time = match?.[2] === undefined ? undefined : parseTime(match[2]);
  const diagnostics: WeeklyScheduleParseDiagnostics = {
    phraseKind,
    weekdayRecognized: Boolean(weekday),
    startDateParsed: Boolean(phraseKind === "ending_only" ? currentDue : start),
    endDateParsed: Boolean(phraseKind === "ending_only" ? endingOnlyEnd : end),
    timePresent,
    timeParsed: phraseKind === "ending_only"
      ? !endingOnly || endingOnly[2] === undefined || Boolean(parseTime(endingOnly[2]))
      : !timePresent || Boolean(parsedTime),
  };
  if (phraseKind === "ending_only") {
    const endingWeekday = endingOnly ? weekdayLookup.get(endingOnly[1].toLowerCase()) : undefined;
    const endingTime = endingOnly?.[2] === undefined ? undefined : parseTime(endingOnly[2]);
    if (!endingOnly || !endingWeekday || !currentDue || !endingOnlyEnd
      || (endingOnly[2] !== undefined && !endingTime)) return { diagnostics };
    return { schedule: { weekday: endingWeekday, ...(endingTime ? { time: endingTime } : {}), start: currentDue, end: endingOnlyEnd }, diagnostics };
  }
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

function endingOnlyAnchorMatchesSeries(expected: ParsedWeeklySchedule, observed: ParsedWeeklySchedule): boolean {
  if (expected.start.year === undefined || expected.end.year === undefined || observed.start.year === undefined) return false;
  const dateOrdinal = (date: ParsedDate): number | undefined => {
    if (date.year === undefined) return undefined;
    const value = Date.UTC(date.year, date.month - 1, date.day);
    const roundTrip = new Date(value);
    if (roundTrip.getUTCFullYear() !== date.year || roundTrip.getUTCMonth() !== date.month - 1 || roundTrip.getUTCDate() !== date.day) return undefined;
    return value / 86_400_000;
  };
  const first = dateOrdinal(expected.start);
  const current = dateOrdinal(observed.start);
  const last = dateOrdinal(expected.end);
  if (first === undefined || current === undefined || last === undefined) return false;
  const offset = current - first;
  return offset >= 0 && current <= last && offset % 7 === 0;
}

function scheduleStartMatches(
  expected: ParsedWeeklySchedule,
  observed: ParsedWeeklySchedule,
  allowYearOmission: boolean,
  phraseKind: WeeklyPhraseKind,
): boolean {
  return sameDate(expected.start, observed.start, allowYearOmission)
    || (phraseKind === "ending_only" && endingOnlyAnchorMatchesSeries(expected, observed));
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


/** Only exact, indefinitely repeating Gregorian rules can be expressed with these
 * Todoist natural-language patterns.  Finite non-weekly/UNTIL and exceptional
 * rules deliberately stay on the Calendar-owned rolling mirror path. */
export function nativeCalendarRecurrenceCandidate(master: CalendarEvent): boolean {
  if (master.recurrence?.length !== 1) return false;
  const fields = ruleFields(master.recurrence[0]);
  return Boolean(fields && ["WEEKLY", "MONTHLY", "YEARLY"].includes(fields.FREQ)
    && !fields.COUNT && !fields.UNTIL && (!fields.INTERVAL || fields.INTERVAL === "1")
    && Object.keys(fields).every((key) => ["FREQ", "INTERVAL", "BYDAY", "BYMONTH", "BYMONTHDAY"].includes(key)));
}

function openCalendarRecurrence(master: CalendarEvent, timeZone: string): CalendarOwnedTodoistRecurrence | undefined {
  if (!nativeCalendarRecurrenceCandidate(master)) return undefined;
  const rule = master.recurrence![0];
  const fields = ruleFields(rule)!;
  const start = master.start?.dateTime || master.start?.date;
  if (!start) return undefined;
  let parts: Record<string, string>;
  try { parts = localParts(start, timeZone); } catch { return undefined; }
  const weekday = weekdayNames.find((name) => name.toLowerCase().startsWith(parts.weekday.toLowerCase()));
  // en-GB abbreviates September as "Sept"; normalize to the three-letter key.
  const month = monthLookup.get(parts.month.toLowerCase().slice(0, 3));
  const day = Number(parts.day);
  if (!weekday || !month || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  // Enforce a single calendar date. Complex BYDAY and positional/31st patterns
  // can skip or rearrange months and must not be silently approximated.
  const time = parts.hour ? parseTime(`${parts.hour}:${parts.minute}${(parts.dayPeriod || "").toLowerCase()}`) : undefined;
  if (parts.hour && !time) return undefined;
  const timePhrase = parts.hour ? ` at ${parts.hour}:${parts.minute}${(parts.dayPeriod || "").toLowerCase()}` : "";
  const startPhrase = localDate(start, timeZone);
  // The UTC date of an offset timestamp can differ from its Calendar-local day.
  const localIsoDate = `${parts.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const base = { rule, startDate: localIsoDate, ...(time ? { time } : {}) };
  if (fields.FREQ === "WEEKLY") {
    if (fields.BYMONTH || fields.BYMONTHDAY
      || (fields.BYDAY && fields.BYDAY !== Object.keys(weekdayCodes).find((code) => weekdayCodes[code] === weekday))) return undefined;
    return { ...base, frequency: "weekly", weekday, dueString: `every ${weekday}${timePhrase} starting ${startPhrase}` };
  }
  if (fields.FREQ === "MONTHLY") {
    if (fields.BYDAY || fields.BYMONTH || day > 28
      || (fields.BYMONTHDAY && fields.BYMONTHDAY !== String(day))) return undefined;
    return { ...base, frequency: "monthly", dayOfMonth: day,
      dueString: `every ${day}${day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}${timePhrase} starting ${startPhrase}` };
  }
  if (fields.FREQ === "YEARLY") {
    if (fields.BYDAY || (month === 2 && day === 29)
      || (fields.BYMONTH && fields.BYMONTH !== String(month))
      || (fields.BYMONTHDAY && fields.BYMONTHDAY !== String(day))) return undefined;
    return { ...base, frequency: "yearly", dayOfMonth: day, month,
      dueString: `every ${day} ${monthNames[month - 1]}${timePhrase} starting ${startPhrase}` };
  }
  return undefined;
}

/** Parse Todoist's normalized, possibly start-date-free representation.
 * Only a single cadence is accepted; unrecognized modifiers fail closed. */
function parseOpenTodoistRule(value: string | undefined): {
  frequency: "weekly" | "monthly" | "yearly"; weekday?: string;
  dayOfMonth?: number; month?: number; time?: string; start?: ParsedDate;
} | undefined {
  if (!value) return undefined;
  const match = value.trim().replace(/\s+/g, " ").match(/^every\s+(.+?)(?:\s+starting(?:\s+on)?\s+(.+))?$/i);
  if (!match) return undefined;
  const withTime = match[1].match(/^(.+?)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?$/i);
  if (!withTime) return undefined;
  const name = withTime[1].trim().toLowerCase();
  const time = withTime[2] ? parseTime(withTime[2]) : undefined;
  if (withTime[2] && !time) return undefined;
  const start = match[2] ? parseNaturalDate(match[2]) : undefined;
  if (match[2] && !start) return undefined;
  const extra = { ...(time ? { time } : {}), ...(start ? { start } : {}) };
  const weekday = weekdayLookup.get(name);
  if (weekday) return { frequency: "weekly", weekday, ...extra };
  const monthly = name.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (monthly && Number(monthly[1]) >= 1 && Number(monthly[1]) <= 28)
    return { frequency: "monthly", dayOfMonth: Number(monthly[1]), ...extra };
  const yearly = name.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$|^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (yearly) {
    const day = Number(yearly[1] || yearly[4]);
    const month = monthLookup.get((yearly[2] || yearly[3]).toLowerCase());
    if (month && day >= 1 && day <= 31 && !(month === 2 && day === 29))
      return { frequency: "yearly", dayOfMonth: day, month, ...extra };
  }
  return undefined;
}

function openRuleMatches(task: TodoistTask, recurrence: CalendarOwnedTodoistRecurrence): {
  matches: boolean; parsed: ReturnType<typeof parseOpenTodoistRule>;
} {
  const parsed = parseOpenTodoistRule(task.due?.string);
  const expectedStart = recurrence.startDate ? parseNaturalDate(recurrence.startDate) : undefined;
  const anchor = parsed?.start;
  const correctStart = !anchor || Boolean(expectedStart && anchor.day === expectedStart.day
    && anchor.month === expectedStart.month && (!anchor.year || anchor.year === expectedStart.year));
  const due = task.due?.date || task.due?.datetime;
  const current = due?.match(/^(\d{4}-\d{2}-\d{2})/);
  const expectedCadenceDate = !current || (() => {
    const parsedDate = parseNaturalDate(current[1]);
    if (!parsedDate) return false;
    if (recurrence.frequency === "monthly") return parsedDate.day === recurrence.dayOfMonth;
    if (recurrence.frequency === "yearly") return parsedDate.day === recurrence.dayOfMonth && parsedDate.month === recurrence.month;
    const instant = new Date(current[1] + "T12:00:00Z");
    return weekdayNames[instant.getUTCDay()] === recurrence.weekday;
  })();
  return { parsed, matches: Boolean(task.due?.is_recurring && parsed && correctStart && expectedCadenceDate
    && parsed.frequency === recurrence.frequency
    && parsed.weekday === recurrence.weekday
    && parsed.dayOfMonth === recurrence.dayOfMonth
    && parsed.month === recurrence.month
    && parsed.time === recurrence.time) };
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
  const open = openCalendarRecurrence(master, timeZone);
  if (open) return open;
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
  verifiedTimeZone?: string,
): boolean {
  return calendarOwnedRecurringTaskReadback(task, event, recurrence, verifiedTimeZone).matches;
}

export function matchesCalendarOwnedRecurringRule(
  task: TodoistTask,
  recurrence: CalendarOwnedTodoistRecurrence,
  verifiedTimeZone?: string,
): boolean {
  if (recurrence.frequency) return openRuleMatches(task, recurrence).matches;
  const expected = parseWeeklySchedule(recurrence.dueString);
  const observedParse = parseWeeklyScheduleDetailed(task.due?.string, task.due?.date || task.due?.datetime, verifiedTimeZone);
  const observed = observedParse.schedule;
  const allowYearOmission = Boolean(expected?.start.year && expected.start.year === expected.end.year);
  return Boolean(task.due?.is_recurring && expected && observed
    && expected.weekday === observed.weekday
    && expected.time === observed.time
    && scheduleStartMatches(expected, observed, allowYearOmission, observedParse.diagnostics.phraseKind)
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
  verifiedTimeZone?: string,
): CalendarOwnedRecurringTaskReadback {
  if (recurrence.frequency) {
    const { parsed, matches } = openRuleMatches(task, recurrence);
    return {
      matches: matches && startsMatchCalendarEvent(event, task, verifiedTimeZone),
      expected: { frequency: recurrence.frequency, ...(recurrence.weekday ? { weekday: recurrence.weekday } : {}),
        ...(recurrence.dayOfMonth ? { dayOfMonth: recurrence.dayOfMonth } : {}),
        ...(recurrence.month ? { month: recurrence.month } : {}),
        ...(recurrence.time ? { time: recurrence.time } : {}),
        ...(recurrence.startDate ? { startDate: recurrence.startDate } : {}) },
      observed: { recurring: Boolean(task.due?.is_recurring),
        ...(task.due?.date || task.due?.datetime ? { dueDate: task.due.date || task.due.datetime } : {}),
        recurrenceParsed: Boolean(parsed),
        ...(parsed ? { frequency: parsed.frequency,
          ...(parsed.weekday ? { weekday: parsed.weekday } : {}),
          ...(parsed.dayOfMonth ? { dayOfMonth: parsed.dayOfMonth } : {}),
          ...(parsed.month ? { month: parsed.month } : {}),
          ...(parsed.time ? { time: parsed.time } : {}),
          ...(parsed.start ? { startDate: formatParsedDate(parsed.start) } : {}) } : {}) },
    };
  }
  const expectedSchedule = parseWeeklySchedule(recurrence.dueString);
  const observedParse = parseWeeklyScheduleDetailed(task.due?.string, task.due?.date || task.due?.datetime, verifiedTimeZone);
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
    && scheduleStartMatches(expectedSchedule, observedSchedule, allowYearOmission, observedParse.diagnostics.phraseKind)
    && sameDate(expectedSchedule.end, observedSchedule.end, allowYearOmission)
    && startsMatchCalendarEvent(event, task, verifiedTimeZone));
  return { matches, expected, observed };
}

function startsMatchCalendarEvent(event: CalendarEvent, task: TodoistTask, verifiedTimeZone?: string): boolean {
  if (event.start?.date && task.due?.date) return event.start.date === task.due.date;
  const eventStart = event.start?.dateTime;
  const taskStart = task.due?.datetime || task.due?.date;
  if (!eventStart || !taskStart) return false;
  const localTaskTime = taskStart.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/);
  if (localTaskTime && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(taskStart)) {
    const eventTimeZone = event.start?.timeZone;
    if (!verifiedTimeZone || !eventTimeZone || verifiedTimeZone !== eventTimeZone
      || (task.due?.timezone && task.due.timezone !== verifiedTimeZone)) return false;
    const instant = Date.parse(eventStart);
    if (!Number.isFinite(instant)) return false;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: verifiedTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const part = (type: string) => parts.find((value) => value.type === type)?.value;
    const eventLocalTime = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
    const taskWallTime = localTaskTime[1].length === 16 ? `${localTaskTime[1]}:00` : localTaskTime[1];
    return eventLocalTime === taskWallTime;
  }
  const left = Date.parse(eventStart);
  const right = Date.parse(taskStart);
  return Number.isFinite(left) && Number.isFinite(right) ? left === right : eventStart.slice(0, 19) === taskStart.slice(0, 19);
}
