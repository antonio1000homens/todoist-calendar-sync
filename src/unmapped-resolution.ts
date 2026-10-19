import { normalizedText } from "./security.js";
import { startsMatch } from "./sync.js";
import type { CalendarEvent, TodoistTask } from "./types.js";

const title = (value: unknown): string => normalizedText(value).toLocaleLowerCase();

/** Only simple, unowned standalone projections are eligible for manual conversion. */
export function unresolvedStandalonePair(task: TodoistTask, event: CalendarEvent): boolean {
  return event.status === "confirmed"
    && !event.recurrence?.length
    && !event.recurringEventId
    && event.extendedProperties?.shared?.taskId === task.id
    && event.extendedProperties.shared.syncRecurrenceOwner !== "calendar"
    && title(event.summary) === title(task.content)
    && startsMatch(event, task)
    && Boolean(task.due?.is_recurring);
}

/**
 * A nearby recurring occurrence can belong to a master created years earlier.
 * Checking only events linked by Todoist taskId misses that duplicate.
 */
export function competingUnmappedIdentities(
  task: TodoistTask,
  target: CalendarEvent,
  todoistTasks: TodoistTask[],
  nearbyOccurrences: CalendarEvent[],
): { taskIds: string[]; eventIds: string[]; sawTarget: boolean } {
  const titleKey = title(task.content);
  const taskIds = todoistTasks.filter((other) => other.id !== task.id
    && title(other.content) === titleKey)
    .map((other) => other.id).sort();
  const matching = nearbyOccurrences.filter((other) => other.status !== "cancelled"
    && title(other.summary) === titleKey
    && startsMatch(other, task));
  return {
    taskIds: [...new Set(taskIds)],
    eventIds: [...new Set(matching.filter((other) => other.id !== target.id).map((other) => other.id))].sort(),
    sawTarget: matching.some((other) => other.id === target.id),
  };
}

export function manualConflictWindow(task: TodoistTask): { start: string; end: string } {
  const due = task.due?.datetime || task.due?.date;
  if (!due) throw new Error("Todoist task has no due date");
  // A two-day margin covers all-day dates, floating local times, offset
  // transitions and recurrence instances without loading the whole calendar.
  const instant = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00:00Z` : due);
  if (!Number.isFinite(instant)) throw new Error("Todoist due date could not be parsed");
  return {
    start: new Date(instant - 2 * 24 * 60 * 60_000).toISOString(),
    end: new Date(instant + 2 * 24 * 60 * 60_000).toISOString(),
  };
}
