import { normalizedText, sha256 } from "./security.js";
import { classifyCalendarRule, classifyTodoistRule } from "./recurrence-semantics.js";
import { recurrenceCivilAnchor } from "./recurrence-semantics.js";
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

function semanticTodoistRecurrence(task: TodoistTask): unknown {
  if (!task.due?.is_recurring) return null;
  const start = task.due.datetime || task.due.date;
  if (!start) return normalizedText(task.due.string) || null;
  const parsed = classifyTodoistRule(task.due.string || "", {
    start, timeZone: task.due.timezone,
  }).semantic;
  if (!parsed) return normalizedText(task.due.string) || null;
  const anchor = recurrenceCivilAnchor(start, task.due.timezone);
  return { rule: normalizedRuleShape(parsed),
    dateOnly: Boolean(anchor && !anchor.time), localTime: parsed.localTime || null,
    timeZone: parsed.timeZone || null };
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
  const recurrence = semanticTodoistRecurrence(task);
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
    : semanticTodoistRecurrence(task);
  const calendarRule = baseline.version === 1
    ? master.recurrence?.length ? [...master.recurrence] : null
    : semanticCalendarRecurrence(master);
  return {
    todoistChanged: hash(todoistRule) !== baseline.todoist.recurrence,
    calendarChanged: hash(calendarRule) !== baseline.calendar.recurrence,
  };
}
