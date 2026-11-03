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
  | "occurrence_mismatch";

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

const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const dayNames: Record<string, string> = {
  mon:"MO", monday:"MO", tue:"TU", tues:"TU", tuesday:"TU",
  wed:"WE", weds:"WE", wednesday:"WE", thu:"TH", thur:"TH",
  thurs:"TH", thursday:"TH", fri:"FR", friday:"FR", sat:"SA",
  saturday:"SA", sun:"SU", sunday:"SU",
};
const frequencies: RecurrenceFrequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const knownFields = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL", "WKST"]);
const pad = (value: number): string => String(value).padStart(2, "0");

function validDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function localAnchor(context: RecurrenceContext): { date: string; time?: string } | RecurrenceReason {
  const start = context.start;
  if (validDate(start)) return { date: start };
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(start);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59
    || (match[4] && Number(match[4]) > 59)) return "invalid_start";
  if (!context.timeZone) return "timezone_not_verified";
  try {
    // Reject invalid timezones and convert offset timestamps to their actual
    // Calendar-local civil day. A floating local time is already wall-clock.
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: context.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    if (!match[5]) return { date: match[1], time: match[2] + ":" + match[3] };
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

function finish(semantic: RecurrenceSemantics, context: RecurrenceContext,
  limitation?: RecurrenceReason): RecurrenceClassification {
  const canonicalRrule = canonical(semantic);
  const evidence = context.evidence;
  const complete = Boolean(evidence?.calendarReadback && evidence.todoistReadback
    && evidence.anchorVerified && evidence.progressionVerified && evidence.exceptionInventoryComplete);
  const reason: RecurrenceReason = context.exceptionPresent ? "calendar_exception"
    : limitation || (!evidence?.anchorVerified ? "anchor_not_verified" : "provider_readback_required");
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
    byDay = [...new Set(values)].sort((a, b) => days.indexOf(a.slice(-2) as typeof days[number])
      - days.indexOf(b.slice(-2) as typeof days[number]));
  }
  if ((fields.FREQ === "DAILY" && (byDay || byMonthDay || byMonth))
    || (fields.FREQ === "WEEKLY" && (byMonthDay || byMonth || byDay?.some((value) => value.length !== 2)))
    || (fields.FREQ === "MONTHLY" && byMonth)
    || (byDay && byMonthDay)) return decline("compound_rule_not_verified");
  const count = fields.COUNT ? positive(fields.COUNT, 1000) : undefined;
  if (fields.COUNT && !count) return decline("invalid_component");
  if (fields.COUNT && fields.UNTIL) return decline("invalid_component");
  if (fields.UNTIL && !/^\d{8}(?:T\d{6}Z)?$/.test(fields.UNTIL)) return decline("invalid_component");
  const until = fields.UNTIL;
  if (until && !validDate(until.slice(0, 4) + "-" + until.slice(4, 6) + "-" + until.slice(6, 8)))
    return decline("invalid_component");
  const semantic: RecurrenceSemantics = {
    frequency: fields.FREQ as RecurrenceFrequency, interval,
    startDate: anchor.date,
    ...(anchor.time ? { localTime: anchor.time, timeZone: context.timeZone } : {}),
    ...(byDay ? { byDay } : {}), ...(byMonthDay ? { byMonthDay } : {}),
    ...(byMonth ? { byMonth } : {}), ...(count ? { count } : {}), ...(until ? { until } : {}),
  };
  return finish(semantic, context, fields.COUNT || fields.UNTIL ? "finite_provider_validation_required"
    : fields.FREQ === "YEARLY" && byDay ? "compound_rule_not_verified"
      : fields.FREQ === "MONTHLY" && byDay ? "compound_rule_not_verified"
        : byDay?.some((value) => value.length !== 2) ? "compound_rule_not_verified" : undefined);
}

/** Parse precisely-known Todoist idioms; all other phrases retain the rolling path. */
export function classifyTodoistRule(phrase: string, context: RecurrenceContext): RecurrenceClassification {
  const anchor = localAnchor(context);
  if (typeof anchor === "string") return decline(anchor);
  const value = phrase.toLowerCase().trim().replace(/\s+/g, " ");
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
  const every = expression.replace(/^every\s+/, "");
  const monthDays = every.match(/^\d{1,2}(?:\s*,\s*\d{1,2})+$/);
  const alternate = every.match(/^other\s+([a-z]+)$/);
  const quantity = every.match(/^(\d+)\s+(day|week|month|year)s?$/);
  if (["day", "daily"].includes(every)) frequency = "DAILY";
  else if (["week", "weekly"].includes(every)) frequency = "WEEKLY";
  else if (["month", "monthly"].includes(every)) frequency = "MONTHLY";
  else if (["year", "yearly", "annual", "annually"].includes(every)) frequency = "YEARLY";
  else if (["quarter", "quarterly"].includes(every)) { frequency = "MONTHLY"; interval = 3; }
  else if (["weekday", "workday", "weekdays"].includes(every)) {
    frequency = "WEEKLY"; byDay = ["MO", "TU", "WE", "TH", "FR"];
  } else if (monthDays) {
    byMonthDay = [...new Set(every.split(",").map((day) => Number(day.trim())))].sort((a, b) => a - b);
    if (byMonthDay.some((day) => day < 1 || day > 31)) return decline("invalid_component");
    frequency = "MONTHLY";
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
  };
  return finish(semantic, context);
}

/** Deterministic civil-date expansion: no UTC-hour additions across DST. */
export function occurrenceDates(rule: RecurrenceSemantics, limit = 12): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid occurrence limit");
  if (!validDate(rule.startDate) || !Number.isSafeInteger(rule.interval) || rule.interval < 1)
    throw new Error("invalid recurrence anchor or interval");
  const start = new Date(rule.startDate + "T00:00:00Z");
  const startMonday = new Date(start);
  startMonday.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const occurrences: string[] = [];
  const dayCode = (date: Date): string => days[(date.getUTCDay() + 6) % 7];
  const anchorDay = start.getUTCDate();
  const anchorMonth = start.getUTCMonth() + 1;
  const horizonDays = Math.min(366 * 50, 366 * Math.max(8, rule.interval * 3));
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
  const equivalent = left.localTime === right.localTime && left.timeZone === right.timeZone
    && leftDates.length === rightDates.length
    && leftDates.every((value, index) => value === rightDates[index])
    && left.count === right.count && left.until === right.until;
  return { equivalent, reason: equivalent ? "verified_equivalent" : "occurrence_mismatch", leftDates, rightDates };
}
