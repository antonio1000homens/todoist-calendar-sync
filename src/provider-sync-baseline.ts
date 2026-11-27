import { normalizedText, sha256 } from "./security.js";
import {
  classifyCalendarRule, classifyTodoistRule, parseTodoistStartBoundary,
  recurrenceCivilAnchor, recurrenceStartBoundaryMatches,
} from "./recurrence-semantics.js";
import type { CalendarEvent, ProviderSyncBaseline, TodoistTask } from "./types.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function hash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function normalizedRuleShape(semantic: NonNullable<ReturnType<typeof classifyTodoistRule>["semantic"]>) {
  const date = new Date(semantic.startDate + "T00:00:00Z");
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][date.getUTCDay()];
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return [semantic.frequency, semantic.interval,
    semantic.byDay?.length ? semantic.byDay : semantic.frequency === "WEEKLY" ? [weekday] : [],
    semantic.byMonthDay?.length ? semantic.byMonthDay
      : (semantic.frequency === "MONTHLY" || semantic.frequency === "YEARLY") && !semantic.byDay ? [day] : [],
    semantic.byMonth?.length ? semantic.byMonth : semantic.frequency === "YEARLY" ? [month] : [],
    semantic.count || null, semantic.until || null];
}

function semanticTodoistRecurrence(task: TodoistTask, seriesMaster?: CalendarEvent): unknown {
  if (!task.due?.is_recurring) return null;
  const start = task.due.datetime || task.due.date;
  if (!start) return normalizedText(task.due.string) || null;
  const boundary = parseTodoistStartBoundary(task.due.string || "");
  if (boundary.invalid) return { invalidProjectionBoundary: normalizedText(task.due.string) };
  const parsed = classifyTodoistRule(boundary.expression, {
    start, timeZone: task.due.timezone,
  }).semantic;
  if (!parsed) return normalizedText(task.due.string) || null;
  const anchor = recurrenceCivilAnchor(start, task.due.timezone);
  if (boundary.hasBoundary) {
    const masterStart = seriesMaster?.start?.dateTime || seriesMaster?.start?.date;
    const calendar = masterStart && seriesMaster?.recurrence?.length === 1
      ? classifyCalendarRule(seriesMaster.recurrence[0], {
        start: masterStart, timeZone: seriesMaster.start?.timeZone || task.due.timezone,
      }).semantic : undefined;
    if (!anchor || !calendar || !recurrenceStartBoundaryMatches(boundary, calendar, anchor.date))
      return { invalidProjectionBoundary: normalizedText(task.due.string) };
  }
  return { rule: normalizedRuleShape(parsed),
    dateOnly: Boolean(anchor && !anchor.time), localTime: parsed.localTime || null,
    timeZone: parsed.timeZone || null };
}

function todoistMatchesCalendarCadence(task: TodoistTask, master: CalendarEvent): boolean {
  if (!task.due?.is_recurring || !master.recurrence || master.recurrence.length !== 1) return false;
  const due = task.due.datetime || task.due.date;
  const masterStart = master.start?.dateTime || master.start?.date;
  if (!due || !masterStart) return false;
  const boundary = parseTodoistStartBoundary(task.due.string || "");
  if (boundary.invalid) return false;
  const anchor = recurrenceCivilAnchor(due, master.start?.timeZone || task.due.timezone);
  const calendar = classifyCalendarRule(master.recurrence[0], {
    start: masterStart, timeZone: master.start?.timeZone || task.due.timezone,
  }).semantic;
  const todoist = classifyTodoistRule(boundary.expression, {
    start: due, timeZone: master.start?.timeZone || task.due.timezone,
  }).semantic;
  if (!anchor || !calendar || !todoist
    || !recurrenceStartBoundaryMatches(boundary, calendar, anchor.date)) return false;
  return JSON.stringify({
    rule: normalizedRuleShape(todoist), dateOnly: !todoist.localTime,
    localTime: todoist.localTime || null, timeZone: todoist.timeZone || null,
  }) === JSON.stringify({
    rule: normalizedRuleShape(calendar), dateOnly: !calendar.localTime,
    localTime: calendar.localTime || null, timeZone: calendar.timeZone || null,
  });
}

function semanticCalendarRecurrence(master: CalendarEvent): unknown {
  if (!master.recurrence?.length) return null;
  const start = master.start?.dateTime || master.start?.date;
  if (!start) return [...master.recurrence];
  const context = { start, timeZone: master.start?.timeZone };
  const values = master.recurrence.map((rule) => {
    const parsed = classifyCalendarRule(rule, context).semantic;
    return parsed ? { rule: normalizedRuleShape(parsed),
      dateOnly: !parsed.localTime, localTime: parsed.localTime || null,
      timeZone: parsed.timeZone || null } : rule;
  });
  return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Hash only the minimal state needed to recognize provider edits and echoes. */
export function providerSyncBaseline(
  task: TodoistTask,
  event: CalendarEvent,
  seriesMaster: CalendarEvent = event,
): ProviderSyncBaseline {
  const due = task.due && (task.due.date || task.due.datetime) ? {
    date: task.due.date || null,
    datetime: task.due.datetime || null,
    timezone: task.due.timezone || null,
    isRecurring: Boolean(task.due.is_recurring),
  } : null;
  const start = event.start ? {
    date: event.start.date || null,
    dateTime: event.start.dateTime || null,
    timeZone: event.start.timeZone || null,
  } : null;
  const recurrence = semanticTodoistRecurrence(task, seriesMaster);
  const calendarRecurrence = semanticCalendarRecurrence(seriesMaster);
  return {
    version: 2,
    todoist: {
      content: hash(normalizedText(task.content)),
      description: hash(normalizedText(task.description)),
      due: hash(due),
      recurrence: hash(recurrence),
    },
    calendar: {
      status: hash(event.status || "confirmed"),
      summary: hash(normalizedText(event.summary)),
      description: hash(normalizedText(event.description)),
      start: hash(start),
      recurrence: hash(calendarRecurrence),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Identify which provider changed the recurring rule since the last shared read. */
export function providerRecurrenceChanges(
  task: TodoistTask,
  master: CalendarEvent,
  baseline: ProviderSyncBaseline | undefined,
): { todoistChanged: boolean; calendarChanged: boolean } | undefined {
  if (!baseline?.todoist.recurrence || !baseline.calendar.recurrence) return undefined;
  const todoistRule = baseline.version === 1
    ? task.due?.is_recurring ? normalizedText(task.due.string) || null : null
    : semanticTodoistRecurrence(task, master);
  const calendarRule = baseline.version === 1
    ? master.recurrence?.length ? [...master.recurrence] : null
    : semanticCalendarRecurrence(master);
  const calendarChanged = hash(calendarRule) !== baseline.calendar.recurrence;
  let todoistChanged = hash(todoistRule) !== baseline.todoist.recurrence;
  // Older v2 baselines sometimes hashed a raw start phrase because the
  // semantic parser did not yet understand provider projection boundaries.
  // If Calendar itself is unchanged and the current task proves that exact
  // canonical cadence, treat it as normalization and migrate on convergence.
  if (todoistChanged && !calendarChanged && baseline.version === 2
    && todoistMatchesCalendarCadence(task, master)) todoistChanged = false;
  return { todoistChanged, calendarChanged };
}
