/**
 * Conservative recurrence semantics for #290.
 *
 * This module is read-only until both providers have proved that their native
 * representations advance through the same anchored schedule. In particular,
 * a Todoist current due date is NOT proof of the original cadence anchor.
 * Existing production translators and fallback policy remain unchanged.
 */
export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type RecurrenceDisposition = "native_exact" | "rolling_required" | "unsupported";
export type RecurrenceReason =
  | "verified_equivalent" | "provider_readback_required" | "anchor_not_verified"
  | "completion_relative" | "finite_provider_validation_required"
  | "calendar_exception" | "unsupported_component" | "duplicate_component"
  | "invalid_component" | "invalid_start" | "timezone_not_verified"
  | "unknown_todoist_phrase" | "compound_rule_not_verified"
  | "occurrence_mismatch" | "subminute_precision_not_supported"
  | "timed_until_requires_instant_expansion";

export interface RecurrenceSemantics {
  frequency: RecurrenceFrequency;
  interval: number;
  startDate: string;
  /** Calendar-local wall clock, not UTC or a shifted calendar day. */
  localTime?: string;
  timeZone?: string;
  byDay?: string[];
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number;
  until?: string;
}

export interface RecurrenceEvidence {
  calendarReadback: boolean;
  todoistReadback: boolean;
  anchorVerified: boolean;
  progressionVerified: boolean;
  exceptionInventoryComplete: boolean;
  /** Independently read back from both providers for timed recurring rules. */
  timeZoneVerified: boolean;
}

export interface RecurrenceClassification {
  disposition: RecurrenceDisposition;
  reason: RecurrenceReason;
  semantic?: RecurrenceSemantics;
  canonicalRrule?: string;
}

export interface RecurrenceContext {
  /** Calendar DTSTART or independently verified Todoist original anchor. */
  start: string;
  /** An IANA zone is required for timed recurrence, including offset timestamps. */
  timeZone?: string;
  exceptionPresent?: boolean;
  evidence?: Partial<RecurrenceEvidence>;
}

export interface TodoistStartBoundary {
  expression: string;
  hasBoundary: boolean;
  startDate?: string;
  startMonthDay?: string;
  invalid: boolean;
}

const monthNumbers = new Map("january february march april may june july august september october november december"
  .split(" ").flatMap((name, index) => [[name, index + 1], [name.slice(0, 3), index + 1] as const]));
monthNumbers.set("sept", 9);

/** Parse a Todoist projection boundary once for translation, comparison and baselines. */
export function parseTodoistStartBoundary(value: string): TodoistStartBoundary {
  const match = /^(.*?)\s+starting(?:\s+on)?\s+(.+?)(?=\s+and\s+ending\b|$)(?:\s+and\s+ending\b.*)?$/i.exec(value.trim());
  if (!match) return { expression: value, hasBoundary: false, invalid: false };
  const suffix = match[2].trim().replace(/,/g, "").replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(suffix);
  const dayFirst = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/i.exec(suffix);
  const monthFirst = /^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/i.exec(suffix);
  let date: string | undefined;
  let monthDay: string | undefined;
  if (iso) date = iso[1] + "-" + iso[2] + "-" + iso[3];
  else {
    const named = dayFirst || monthFirst;
    if (named) {
      const monthName = (dayFirst ? named[2] : named[1]).toLowerCase().replace(/\.$/, "");
      const month = monthNumbers.get(monthName);
      const dayText = dayFirst ? named[1] : named[2];
      const yearText = named[3];
      if (month && !yearText && Number(dayText) >= 1 && Number(dayText) <= 31)
        monthDay = String(month).padStart(2, "0") + "-" + String(Number(dayText)).padStart(2, "0");
      else if (month && yearText && Number(dayText) >= 1 && Number(dayText) <= 31)
        date = yearText + "-" + String(month).padStart(2, "0") + "-" + String(Number(dayText)).padStart(2, "0");
    }
  }
  if (monthDay) return { expression: match[1], hasBoundary: true, startMonthDay: monthDay, invalid: false };
  if (!date || !validDate(date)) return { expression: match[1], hasBoundary: true, invalid: true };
  return { expression: match[1], hasBoundary: true, startDate: date, invalid: false };
}

const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const dayNames: Record<string, string> = {
  mon:"MO", monday:"MO", tue:"TU", tues:"TU", tuesday:"TU",
  wed:"WE", weds:"WE", wednesday:"WE", thu:"TH", thur:"TH",
  thurs:"TH", thursday:"TH", fri:"FR", friday:"FR", sat:"SA",
  saturday:"SA", sun:"SU", sunday:"SU",
};
const monthNames: Record<string, number> = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
};
/** Shared annual phrase grammar. The date-less aliases require a verified
 * provider due anchor when comparing cadence, not the other provider's date. */
export function parseAnnualCadence(name: string): { month?: number; dayOfMonth?: number } | undefined {
  const value = name.trim().toLowerCase();
  if (["year", "yearly", "annual", "annually"].includes(value)) return {};
  const match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$|^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(value);
  if (!match) return undefined;
  const monthName = match[2] || match[3];
  const month = monthNames[monthName] || Object.entries(monthNames).find(([key]) => key.slice(0, 3) === monthName)?.[1];
  const dayOfMonth = Number(match[1] || match[4]);
  if (!month || dayOfMonth < 1 || dayOfMonth > new Date(Date.UTC(2000, month, 0)).getUTCDate()) return undefined;
  return { month, dayOfMonth };
}

/** Resolve a provider's own civil anchor, refusing unverified timed dates. */
export function recurrenceCivilAnchor(start: string | undefined, timeZone?: string): { date: string; time?: string } | undefined {
  if (!start) return undefined;
  const result = localAnchor({ start, timeZone });
  return typeof result === "string" ? undefined : result;
}

const frequencies: RecurrenceFrequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const knownFields = new Set(["FREQ", "INTERVAL", "BYDAY", "BYSETPOS", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL", "WKST"]);
const pad = (value: number): string => String(value).padStart(2, "0");

function validDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function localAnchor(context: RecurrenceContext): { date: string; time?: string } | RecurrenceReason {
  const start = context.start;
  if (validDate(start)) return { date: start };
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(start);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59
    || (match[4] && Number(match[4]) > 59)) return "invalid_start";
  // This date-only expander cannot represent different sub-minute instants.
  // Reject them instead of claiming that 09:00:30 is equivalent to 09:00:00.
  if (Number(match[4] || "0") !== 0 || (match[5] && /[1-9]/.test(match[5])))
    return "subminute_precision_not_supported";
  if (!context.timeZone) return "timezone_not_verified";
  try {
    // Reject invalid timezones and convert offset timestamps to their actual
    // Calendar-local civil day. A floating local time is already wall-clock.
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: context.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    if (!match[6]) return { date: match[1], time: match[2] + ":" + match[3] };
    const date = new Date(start);
    if (Number.isNaN(date.getTime())) return "invalid_start";
    const parts = Object.fromEntries(formatter.formatToParts(date)
      .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute };
  } catch { return "timezone_not_verified"; }
}

function decline(reason: RecurrenceReason): RecurrenceClassification {
  return { disposition: "unsupported", reason };
}

function canonical(semantic: RecurrenceSemantics): string {
  const result = ["RRULE:FREQ=" + semantic.frequency];
  if (semantic.interval !== 1) result.push("INTERVAL=" + semantic.interval);
  if (semantic.byDay?.length) result.push("BYDAY=" + semantic.byDay.join(","));
  if (semantic.byMonthDay?.length) result.push("BYMONTHDAY=" + semantic.byMonthDay.join(","));
  if (semantic.byMonth?.length) result.push("BYMONTH=" + semantic.byMonth.join(","));
  if (semantic.count) result.push("COUNT=" + semantic.count);
  if (semantic.until) result.push("UNTIL=" + semantic.until);
  return result.join(";");
}

function recurrencePhraseTime(value: string): string | undefined | null {
  const match = value.match(/\s+(?:at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|(\d{1,2}:\d{2}))$/i);
  if (!match) return undefined;
  const raw = (match[1] || match[2]).trim().toLowerCase();
  const parts = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (!parts) return null;
  let hour = Number(parts[1]);
  const minute = Number(parts[2] || 0);
  if (minute > 59) return null;
  if (parts[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (parts[3] === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function finish(semantic: RecurrenceSemantics, context: RecurrenceContext,
  limitation?: RecurrenceReason): RecurrenceClassification {
  const canonicalRrule = canonical(semantic);
  const evidence = context.evidence;
  const timeZoneVerified = !semantic.localTime || Boolean(evidence?.timeZoneVerified);
  const complete = Boolean(evidence?.calendarReadback && evidence.todoistReadback
    && evidence.anchorVerified && evidence.progressionVerified && evidence.exceptionInventoryComplete
    && timeZoneVerified);
  const reason: RecurrenceReason = context.exceptionPresent ? "calendar_exception"
    : limitation || (!evidence?.anchorVerified ? "anchor_not_verified"
      : !timeZoneVerified ? "timezone_not_verified" : "provider_readback_required");
  return { semantic, canonicalRrule,
    disposition: !context.exceptionPresent && !limitation && complete ? "native_exact" : "rolling_required",
    reason: !context.exceptionPresent && !limitation && complete ? "verified_equivalent" : reason };
}

/** Parse a bounded RRULE with strict duplicate, value and unknown-key rejection. */
export function classifyCalendarRule(rule: string, context: RecurrenceContext): RecurrenceClassification {
  const anchor = localAnchor(context);
  if (typeof anchor === "string") return decline(anchor);
  if (!rule.startsWith("RRULE:")) return decline("invalid_component");
  const fields: Record<string, string> = {};
  for (const field of rule.slice(6).split(";")) {
    const match = /^([A-Za-z]+)=([^;]+)$/.exec(field);
    if (!match) return decline("invalid_component");
    const key = match[1].toUpperCase();
    if (!knownFields.has(key)) return decline("unsupported_component");
    if (Object.hasOwn(fields, key)) return decline("duplicate_component");
    fields[key] = match[2].toUpperCase();
  }
  if (!frequencies.includes(fields.FREQ as RecurrenceFrequency)) return decline("invalid_component");
  const positive = (input: string | undefined, max: number): number | undefined => {
    if (!input || !/^[1-9]\d*$/.test(input)) return undefined;
    const value = Number(input);
    return Number.isSafeInteger(value) && value <= max ? value : undefined;
  };
  const interval = fields.INTERVAL ? positive(fields.INTERVAL, 1000) : 1;
  if (!interval) return decline("invalid_component");
  if (fields.WKST && fields.WKST !== "MO") return decline("compound_rule_not_verified");
  const parseList = (input: string | undefined, max: number): number[] | undefined => {
    if (!input) return undefined;
    const values = input.split(",").map((part) => positive(part, max));
    if (values.some((value) => value === undefined) || !values.length) return undefined;
    return [...new Set(values as number[])].sort((a, b) => a - b);
  };
  const byMonthDay = parseList(fields.BYMONTHDAY, 31);
  const byMonth = parseList(fields.BYMONTH, 12);
  if ((fields.BYMONTHDAY && !byMonthDay) || (fields.BYMONTH && !byMonth)) return decline("invalid_component");
  let byDay: string[] | undefined;
  if (fields.BYDAY) {
    const values = fields.BYDAY.split(",");
    if (!values.every((value) => /^(?:-1|[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)$/.test(value)))
      return decline("invalid_component");
    byDay = [...new Set(values)].sort((a, b) => {
      const weekdayOrder = days.indexOf(a.slice(-2) as typeof days[number])
        - days.indexOf(b.slice(-2) as typeof days[number]);
      return weekdayOrder || Number(a.slice(0, -2) || "0") - Number(b.slice(0, -2) || "0");
    });
  }
  let bySetPos: number | undefined;
  if (fields.BYSETPOS) {
    if (!/^(?:-1|[1-5])$/.test(fields.BYSETPOS)) return decline("invalid_component");
    bySetPos = Number(fields.BYSETPOS);
    if (fields.FREQ !== "MONTHLY" || !byDay || byDay.length !== 1 || byDay[0].length !== 2)
      return decline("compound_rule_not_verified");
    byDay = [`${bySetPos}${byDay[0]}`];
  }
  if ((fields.FREQ === "DAILY" && (byDay || byMonthDay || byMonth))
    || (fields.FREQ === "WEEKLY" && (byMonthDay || byMonth || byDay?.some((value) => value.length !== 2)))
    || (fields.FREQ === "MONTHLY" && byMonth)
    || (fields.BYSETPOS && fields.FREQ !== "MONTHLY")
    || (byDay && byMonthDay)) return decline("compound_rule_not_verified");
  const count = fields.COUNT ? positive(fields.COUNT, 1000) : undefined;
  if (fields.COUNT && !count) return decline("invalid_component");
  if (fields.COUNT && fields.UNTIL) return decline("invalid_component");
  const until = fields.UNTIL;
  if (until) {
    const cutoff = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(until);
    if (!cutoff || !validDate(`${cutoff[1]}-${cutoff[2]}-${cutoff[3]}`)
      || (cutoff[4] && (Number(cutoff[4]) > 23 || Number(cutoff[5]) > 59 || Number(cutoff[6]) > 59)))
      return decline("invalid_component");
    // A UTC UNTIL needs full instant conversion including DST. Do not silently
    // compare only the civil date or turn a timed finite rule into a native one.
    if (cutoff[4]) return decline("timed_until_requires_instant_expansion");
    if (anchor.time) return decline("invalid_component");
  }
  const semantic: RecurrenceSemantics = {
    frequency: fields.FREQ as RecurrenceFrequency, interval,
    startDate: anchor.date,
    ...(anchor.time ? { localTime: anchor.time, timeZone: context.timeZone } : {}),
    ...(byDay ? { byDay } : {}), ...(byMonthDay ? { byMonthDay } : {}),
    ...(byMonth ? { byMonth } : {}), ...(count ? { count } : {}), ...(until ? { until } : {}),
  };
  return finish(semantic, context, fields.COUNT || fields.UNTIL ? "finite_provider_validation_required"
    : fields.FREQ === "YEARLY" && byDay ? "compound_rule_not_verified"
    : fields.FREQ === "MONTHLY" && byDay && !bySetPos ? "compound_rule_not_verified"
        : byDay?.some((value) => value.length !== 2) ? "compound_rule_not_verified" : undefined);
}

/** Parse precisely-known Todoist idioms; all other phrases retain the rolling path. */
export function classifyTodoistRule(phrase: string, context: RecurrenceContext): RecurrenceClassification {
  const anchor = localAnchor(context);
  if (typeof anchor === "string") return decline(anchor);
  const value = phrase.toLowerCase().trim().replace(/\s+/g, " ");
  const phraseTime = recurrencePhraseTime(value);
  if (phraseTime === null) return decline("invalid_component");
  if (phraseTime && (!anchor.time || anchor.time !== phraseTime)) return decline("occurrence_mismatch");
  if (/every!/.test(value)) return { disposition: "rolling_required", reason: "completion_relative" };
  if (/\b(starting|ending|until|from)\b/.test(value))
    return { disposition: "rolling_required", reason: "finite_provider_validation_required" };
  let expression = value.replace(/\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/, "").trim();
  // Todoist may normalize "at 9am" to "09:00", but its persisted
  // due datetime remains the authoritative time, never the phrase.
  expression = expression.replace(/\s+(?:[01]?\d|2[0-3]):[0-5]\d$/, "").trim();
  let frequency: RecurrenceFrequency | undefined;
  let interval = 1;
  let byDay: string[] | undefined;
  let byMonthDay: number[] | undefined;
  let byMonth: number[] | undefined;
  const every = expression.replace(/^every\s+/, "");
  const monthDays = every.match(/^\d{1,2}(?:\s*,\s*\d{1,2})+$/);
  const monthDay = every.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  const alternate = every.match(/^other\s+([a-z]+)$/);
  const quantity = every.match(/^(\d+)\s+(day|week|month|year)s?$/);
  const annual = parseAnnualCadence(every);
  const ordinalWeekday = every.match(/^(1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|last)\s+([a-z]+)(?:\s+of\s+(?:the\s+)?month)?$/);
  if (["day", "daily"].includes(every)) frequency = "DAILY";
  else if (["week", "weekly"].includes(every)) frequency = "WEEKLY";
  else if (["month", "monthly"].includes(every)) frequency = "MONTHLY";
  else if (annual && annual.month === undefined) frequency = "YEARLY";
  else if (["quarter", "quarterly"].includes(every)) { frequency = "MONTHLY"; interval = 3; }
  else if (["weekday", "workday", "weekdays"].includes(every)) {
    frequency = "WEEKLY"; byDay = ["MO", "TU", "WE", "TH", "FR"];
  } else if (monthDays) {
    byMonthDay = [...new Set(every.split(",").map((day) => Number(day.trim())))].sort((a, b) => a - b);
    if (byMonthDay.some((day) => day < 1 || day > 31)) return decline("invalid_component");
    frequency = "MONTHLY";
  } else if (monthDay) {
    const day = Number(monthDay[1]);
    if (day < 1 || day > 28 || Number(anchor.date.slice(8, 10)) !== day) return decline("invalid_component");
    byMonthDay = [day];
    frequency = "MONTHLY";
  } else if (annual?.month !== undefined && annual.dayOfMonth !== undefined) {
    const { month, dayOfMonth: day } = annual;
    if (Number(anchor.date.slice(5, 7)) !== month
      || Number(anchor.date.slice(8, 10)) !== day) return decline("invalid_component");
    frequency = "YEARLY"; byMonth = [month]; byMonthDay = [day];
  } else if (ordinalWeekday) {
    const weekday = dayNames[ordinalWeekday[2]];
    const position = ordinalWeekday[1] === "last" ? -1
      : ["1st", "2nd", "3rd", "4th", "5th"].includes(ordinalWeekday[1])
        ? ["1st", "2nd", "3rd", "4th", "5th"].indexOf(ordinalWeekday[1]) + 1
        : ["first", "second", "third", "fourth", "fifth"].indexOf(ordinalWeekday[1]) + 1;
    if (!weekday || !["MO", "TU", "WE", "TH", "FR"].includes(weekday)
      || !(position === -1 || position >= 1 && position <= 5)) return decline("unknown_todoist_phrase");
    const anchorDate = new Date(anchor.date + "T00:00:00Z");
    const weekdayIndex = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(weekday);
    if (anchorDate.getUTCDay() !== weekdayIndex
      || (position === -1 ? anchorDate.getUTCDate() + 7 <= new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + 1, 0)).getUTCDate()
        : Math.floor((anchorDate.getUTCDate() - 1) / 7) + 1 !== position)) return decline("invalid_component");
    frequency = "MONTHLY"; byDay = [`${position}${weekday}`];
  } else if (alternate && dayNames[alternate[1]]) {
    frequency = "WEEKLY"; interval = 2; byDay = [dayNames[alternate[1]]];
  } else if (quantity) {
    interval = Number(quantity[1]);
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1000)
      return decline("invalid_component");
    frequency = ({ day:"DAILY", week:"WEEKLY", month:"MONTHLY", year:"YEARLY" } as const)[quantity[2] as "day" | "week" | "month" | "year"];
  } else {
    const tokens = every.replace(/,\s*|\s+and\s+/g, " ").split(/\s+/);
    if (tokens.length && tokens.every((token) => Boolean(dayNames[token]))) {
      frequency = "WEEKLY";
      byDay = [...new Set(tokens.map((token) => dayNames[token]))].sort((a, b) =>
        days.indexOf(a as typeof days[number]) - days.indexOf(b as typeof days[number]));
    }
  }
  if (!frequency) return decline("unknown_todoist_phrase");
  const semantic: RecurrenceSemantics = {
    frequency, interval, startDate: anchor.date,
    ...(anchor.time ? { localTime: anchor.time, timeZone: context.timeZone } : {}),
    ...(byDay ? { byDay } : {}), ...(byMonthDay ? { byMonthDay } : {}),
    ...(byMonth ? { byMonth } : {}),
  };
  return finish(semantic, context);
}

/** Deterministic civil-date expansion: no UTC-hour additions across DST. */
export function occurrenceDates(rule: RecurrenceSemantics, limit = 12): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid occurrence limit");
  if (!validDate(rule.startDate) || !Number.isSafeInteger(rule.interval) || rule.interval < 1)
    throw new Error("invalid recurrence anchor or interval");
  if (rule.until?.includes("T")) throw new Error("timed UNTIL requires instant-aware expansion");
  const start = new Date(rule.startDate + "T00:00:00Z");
  const startMonday = new Date(start);
  startMonday.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const occurrences: string[] = [];
  const dayCode = (date: Date): string => days[(date.getUTCDay() + 6) % 7];
  const anchorDay = start.getUTCDate();
  const anchorMonth = start.getUTCMonth() + 1;
  // Scale from the requested number of dates, not a fixed eight-year window.
  // Sparse rules (fifth weekday, leap day) require a longer civil-date horizon.
  // Hard-cap at 160 years; insufficient evidence fails closed in comparison.
  const leapDay = rule.frequency === "YEARLY" && (
    (rule.byMonth?.length === 1 && rule.byMonth[0] === 2
      && rule.byMonthDay?.length === 1 && rule.byMonthDay[0] === 29)
    || (!rule.byMonth?.length && !rule.byMonthDay?.length && anchorMonth === 2 && anchorDay === 29));
  const sparsity = leapDay ? 4 : rule.frequency === "MONTHLY" && rule.byDay?.some((day) => day.length > 2) ? 6
    : rule.frequency === "MONTHLY" && (anchorDay > 28 || rule.byMonthDay?.some((day) => day > 28)) ? 2 : 1;
  const periodDays = rule.frequency === "YEARLY" ? 366 : rule.frequency === "MONTHLY" ? 31
    : rule.frequency === "WEEKLY" ? 7 : 1;
  const horizonDays = Math.min(366 * 160, Math.ceil(periodDays * rule.interval * (limit + 1) * sparsity));
  for (let offset = 0; offset < horizonDays && occurrences.length < limit; offset++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    const iso = date.toISOString().slice(0, 10);
    if (rule.until && iso.replace(/-/g, "") > rule.until.slice(0, 8)) break;
    const monthDistance = (date.getUTCFullYear() - start.getUTCFullYear()) * 12
      + date.getUTCMonth() - start.getUTCMonth();
    const weekDistance = Math.floor((date.getTime() - startMonday.getTime()) / 604800000);
    const matchingInterval = rule.frequency === "DAILY" ? offset % rule.interval === 0
      : rule.frequency === "WEEKLY" ? weekDistance % rule.interval === 0
      : rule.frequency === "MONTHLY" ? monthDistance % rule.interval === 0
      : (date.getUTCFullYear() - start.getUTCFullYear()) % rule.interval === 0;
    const weekday = dayCode(date);
    const matchesDay = rule.byDay?.length
      ? rule.byDay.some((entry) => {
        if (entry.slice(-2) !== weekday) return false;
        const ordinal = entry.slice(0, -2);
        if (!ordinal) return true;
        if (ordinal === "-1") return date.getUTCDate() + 7 > new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        return Math.floor((date.getUTCDate() - 1) / 7) + 1 === Number(ordinal);
      })
      : rule.frequency === "WEEKLY" ? weekday === dayCode(start) : true;
    const matchesMonth = rule.byMonth?.length ? rule.byMonth.includes(date.getUTCMonth() + 1)
      : rule.frequency === "YEARLY" ? date.getUTCMonth() + 1 === anchorMonth : true;
    const matchesMonthDay = rule.byMonthDay?.length ? rule.byMonthDay.includes(date.getUTCDate())
      : ["MONTHLY", "YEARLY"].includes(rule.frequency) && !rule.byDay?.length
        ? date.getUTCDate() === anchorDay : true;
    if (matchingInterval && matchesDay && matchesMonth && matchesMonthDay) {
      occurrences.push(iso);
      if (rule.count && occurrences.length >= rule.count) break;
    }
  }
  return occurrences;
}

export function compareOccurrenceSemantics(left: RecurrenceSemantics, right: RecurrenceSemantics,
  limit = 12): { equivalent: boolean; reason: RecurrenceReason; leftDates: string[]; rightDates: string[] } {
  const leftDates = occurrenceDates(left, limit);
  const rightDates = occurrenceDates(right, limit);
  // Inadequate horizons must not look equivalent merely because both rules
  // yielded one distant occurrence. Finite families stay in rolling fallback.
  const fullWindow = leftDates.length === limit && rightDates.length === limit;
  const equivalent = fullWindow && left.localTime === right.localTime && left.timeZone === right.timeZone
    && leftDates.length === rightDates.length
    && leftDates.every((value, index) => value === rightDates[index])
    && left.count === right.count && left.until === right.until;
  return { equivalent, reason: equivalent ? "verified_equivalent" : "occurrence_mismatch", leftDates, rightDates };
}

function cadenceFields(rule: RecurrenceSemantics): string {
  const anchor = new Date(rule.startDate + "T00:00:00Z");
  const weekday = days[(anchor.getUTCDay() + 6) % 7];
  const month = anchor.getUTCMonth() + 1;
  const day = anchor.getUTCDate();
  const byDay = rule.byDay?.length ? [...rule.byDay].sort().join(",")
    : rule.frequency === "WEEKLY" ? weekday : "";
  const byMonthDay = rule.byMonthDay?.length ? [...rule.byMonthDay].sort((a,b)=>a-b).join(",")
    : rule.frequency === "MONTHLY" && !rule.byDay?.length || rule.frequency === "YEARLY" && !rule.byDay?.length
      ? String(day) : "";
  const byMonth = rule.byMonth?.length ? [...rule.byMonth].sort((a,b)=>a-b).join(",")
    : rule.frequency === "YEARLY" ? String(month) : "";
  return [rule.frequency, rule.interval, byDay, byMonthDay, byMonth,
    rule.localTime || "", rule.timeZone || ""].join("|");
}

/** Check one civil due date against an independently parsed anchored RRULE. */
export function recurrenceIncludesDate(rule: RecurrenceSemantics, iso: string): boolean {
  if (!validDate(iso) || !validDate(rule.startDate) || iso < rule.startDate || rule.until && iso > rule.until.slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")) return false;
  const date = new Date(iso + "T00:00:00Z");
  const start = new Date(rule.startDate + "T00:00:00Z");
  const offset = (date.getTime() - start.getTime()) / 86_400_000;
  const weekday = days[(date.getUTCDay() + 6) % 7];
  const startWeekday = days[(start.getUTCDay() + 6) % 7];
  const monthDistance = (date.getUTCFullYear() - start.getUTCFullYear()) * 12
    + date.getUTCMonth() - start.getUTCMonth();
  const weekDistance = Math.floor((date.getTime() - (start.getTime() - ((start.getUTCDay() + 6) % 7) * 86_400_000)) / 604_800_000);
  const intervalMatch = rule.frequency === "DAILY" ? offset % rule.interval === 0
    : rule.frequency === "WEEKLY" ? weekDistance % rule.interval === 0
      : rule.frequency === "MONTHLY" ? monthDistance % rule.interval === 0
        : (date.getUTCFullYear() - start.getUTCFullYear()) % rule.interval === 0;
  if (!intervalMatch) return false;
  if (rule.frequency === "WEEKLY" && !(rule.byDay?.length ? rule.byDay.some(day=>day.slice(-2)===weekday) : weekday===startWeekday)) return false;
  if (rule.frequency === "MONTHLY" && rule.byDay?.length) {
    if (!rule.byDay.some(entry => {
      if (entry.slice(-2) !== weekday) return false;
      const ordinal = entry.slice(0,-2);
      return !ordinal || (ordinal === "-1"
        ? date.getUTCDate()+7>new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate()
        : Math.floor((date.getUTCDate()-1)/7)+1===Number(ordinal));
    })) return false;
  } else if ((rule.frequency === "MONTHLY" || rule.frequency === "YEARLY")
    && !(rule.byMonthDay?.length ? rule.byMonthDay.includes(date.getUTCDate()) : date.getUTCDate()===start.getUTCDate())) return false;
  if (rule.frequency === "YEARLY" && !(rule.byMonth?.length
    ? rule.byMonth.includes(date.getUTCMonth()+1) : date.getUTCMonth()===start.getUTCMonth())) return false;
  if (rule.byDay?.length && rule.frequency !== "WEEKLY" && rule.frequency !== "MONTHLY") return false;
  return true;
}

/** Validate an explicit Todoist start against the canonical RRULE phase and current due. */
export function recurrenceStartBoundaryMatches(
  boundary: TodoistStartBoundary, rule: RecurrenceSemantics, dueDate: string,
): boolean {
  if (boundary.invalid) return false;
  if (!boundary.hasBoundary) return true;
  if (boundary.startDate)
    return boundary.startDate <= dueDate && recurrenceIncludesDate(rule, boundary.startDate);
  if (!boundary.startMonthDay) return false;
  const firstYear = Number(rule.startDate.slice(0, 4));
  const lastYear = Number(dueDate.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year++) {
    const candidate = String(year) + "-" + boundary.startMonthDay;
    if (candidate <= dueDate && recurrenceIncludesDate(rule, candidate)) return true;
  }
  return false;
}

/** Compare the rule shapes while proving that Todoist's current due is an
 * occurrence in the Calendar series. DTSTART is context: it supplies omitted
 * weekday/month/day fields but does not require both providers to share a year. */
export function recurrenceCadenceMatchesAtDate(
  calendar: RecurrenceSemantics, todoist: RecurrenceSemantics, dueDate: string,
): boolean {
  return cadenceFields(calendar) === cadenceFields(todoist)
    && recurrenceIncludesDate(calendar, dueDate) && recurrenceIncludesDate(todoist, dueDate)
    && calendar.count === todoist.count && calendar.until === todoist.until;
}
