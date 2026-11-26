import { normalizedText, sha256 } from "./security.js";
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
  const recurrence = task.due?.is_recurring ? normalizedText(task.due.string) || null : null;
  const calendarRecurrence = seriesMaster.recurrence?.length ? [...seriesMaster.recurrence] : null;
  return {
    version: 1,
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
  const todoistRule = task.due?.is_recurring ? normalizedText(task.due.string) || null : null;
  const calendarRule = master.recurrence?.length ? [...master.recurrence] : null;
  return {
    todoistChanged: hash(todoistRule) !== baseline.todoist.recurrence,
    calendarChanged: hash(calendarRule) !== baseline.calendar.recurrence,
  };
}
