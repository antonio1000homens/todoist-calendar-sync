import { profileForTodoistProject, profiles, googleCredentials, todoistToken } from "./config.js";
import { otherProfileCalendarOrganizer } from "./calendar-profile-ownership.js";
import { attachProjectCommentReference, deleteMappingComments } from "./mapping-comments.js";
import { GoogleCalendar, Todoist } from "./providers.js";
import { StateRepository } from "./repository.js";
import { ReconciliationItemError } from "./reconciliation-diagnostics.js";
import { normalizedStart, normalizedText } from "./security.js";
import {
  calendarRecurrenceMatchesTodoist,
  isTodoistOwnedCalendarRecurrence,
  recurrenceEffectiveStart,
  recurrenceOriginalStart,
  selectNextEffectiveTodoistInstance,
  selectTodoistCurrentInstance,
  todoistRecurrenceKey,
  todoistRecurrenceToRrule,
} from "./todoist-recurrence.js";
import { protectUnmappedCompletedHistory } from "./completed-history-policy.js";
import {
  calendarOwnedRecurringTaskPayload,
  calendarOwnedRecurringTaskReadback,
  calendarOwnedTodoistRecurrence,
  verifiedCalendarOwnedRecurrence,
  finiteWeeklyCalendarRuleCandidate,
  nativeCalendarRecurrenceCandidate,
  matchesCalendarOwnedRecurringRule,
  matchesCalendarOwnedRecurringTask,
  resolveCalendarTimeZone,
} from "./calendar-owned-todoist-recurrence.js";
import type { CalendarEvent, CompletedCalendarProjection, Delivery, Mapping, Profile, RecurrenceLink, TodoistTask, TodoistWebhookPayload } from "./types.js";

/**
 * Canonical matching deliberately excludes a recurring Todoist task when
 * considering a Calendar-owned active occurrence. That exclusion must not
 * be interpreted as permission to create a duplicate non-recurring task.
 * This conservative identity collision check is a guard, not a rebind.
 */
export function recurringTaskIdentityCandidates(event: CalendarEvent, tasks: TodoistTask[]): string[] {
  const title = normalizedText(event.summary).toLocaleLowerCase();
  const sharedTaskId = event.extendedProperties?.shared?.taskId;
  if (!sharedTaskId && (!title || !(event.start?.date || event.start?.dateTime))) return [];
  return tasks
    .filter((task) => Boolean(task.due?.is_recurring)
      && (task.id === sharedTaskId
        || (Boolean(title)
          && normalizedText(task.content).toLocaleLowerCase() === title
          && startsMatch(event, task))))
    .map((task) => task.id)
    .sort();
}

export function calendarResourceAlreadyDeleted(error: unknown): boolean {
  const provider = error as { status?: number; body?: string };
  if (Number(provider.status) === 404) return true;
  if (Number(provider.status) !== 410) return false;
  try { return JSON.parse(provider.body || "").error?.errors?.[0]?.reason === "deleted"; }
  catch { return false; }
}

/**
 * A 410 from a direct events.get for the same event is evidence of a gone
 * resource, even when Google omits the structured "deleted" reason. Never use
 * this for events.list / expired sync tokens, or for an unverified DELETE.
 */
export function calendarEventGoneOnDirectRead(error: unknown): boolean {
  if (calendarResourceAlreadyDeleted(error)) return true;
  const provider = error as { status?: number; body?: string };
  if (Number(provider.status) !== 410) return false;
  if (!provider.body?.trim()) return true;
  try {
    const parsed = JSON.parse(provider.body) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    const reasons = parsed.error?.errors?.map((entry) => entry.reason).filter(Boolean) || [];
    if (reasons.length) return reasons.every((reason) => reason === "deleted" || reason === "gone");
    return /(?:deleted|gone|not found)/i.test(parsed.error?.message || "");
  } catch {
    return /(?:deleted|gone|not found)/i.test(provider.body);
  }
}

function taskDateTime(task: TodoistTask): string | undefined {
  const due = task.due;
  return due?.datetime || (due?.date && due.date.includes("T") ? due.date : undefined);
}

function taskHasDue(task: TodoistTask | undefined): boolean {
  return Boolean(task?.due?.date || task?.due?.datetime);
}

function taskIsAllDay(task: TodoistTask): boolean {
  return Boolean(task.due?.date && !taskDateTime(task));
}

function todoistRecurringDateEdited(payload: TodoistWebhookPayload): boolean {
  const task = payload.event_data;
  const oldTask = payload.event_data_extra?.old_item;
  if (payload.event_name !== "item:updated" || payload.event_data_extra?.update_intent !== "item_updated") return false;
  if (!task?.due?.is_recurring || !oldTask?.due?.is_recurring) return false;
  const due = taskDateTime(task) || task.due.date;
  const oldDue = taskDateTime(oldTask) || oldTask.due.date;
  return Boolean(due && oldDue && due !== oldDue);
}

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

export function startsMatch(event: CalendarEvent, task: TodoistTask): boolean {
  const eventDateTime = event.start?.dateTime;
  const eventDate = event.start?.date;
  const dueDateTime = taskDateTime(task);
  if (Boolean(eventDate) !== taskIsAllDay(task) || Boolean(eventDateTime) === taskIsAllDay(task)) return false;
  if (eventDate && task.due?.date) return eventDate.slice(0, 10) === task.due.date.slice(0, 10);
  if (!eventDateTime || !dueDateTime) return false;

  // Todoist represents floating timed dates without an offset. Google returns
  // them with an offset, so compare their wall-clock value in the event zone.
  if (!hasOffset(dueDateTime)) {
    return localDateTime(eventDateTime, event.start?.timeZone || task.due?.timezone || "Europe/London") === localDateTime(dueDateTime, "Europe/London");
  }
  return normalizedStart(eventDateTime, false) === normalizedStart(dueDateTime, false);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function durationMilliseconds(event: CalendarEvent | undefined, expectedAllDay: boolean): number {
  if (!event) return expectedAllDay ? 24 * 60 * 60_000 : 30 * 60_000;
  const wasAllDay = Boolean(event.start?.date && !event.start?.dateTime);
  if (wasAllDay !== expectedAllDay) return expectedAllDay ? 24 * 60 * 60_000 : 30 * 60_000;
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  if (!start || !end) return expectedAllDay ? 24 * 60 * 60_000 : 30 * 60_000;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value > 0 ? value : expectedAllDay ? 24 * 60 * 60_000 : 30 * 60_000;
}

function addMilliseconds(dateTime: string, milliseconds: number): string {
  if (!hasOffset(dateTime)) {
    const parsed = new Date(`${dateTime.slice(0, 19)}Z`);
    return new Date(parsed.getTime() + milliseconds).toISOString().slice(0, 19);
  }
  return new Date(Date.parse(dateTime) + milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function recurrenceAnchorMatches(event: CalendarEvent): boolean {
  const shared = event.extendedProperties?.shared;
  if (!shared?.todoistAnchorStart || !shared.todoistAnchorEnd) return false;
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  return start === shared.todoistAnchorStart && end === shared.todoistAnchorEnd;
}

export function occurrenceStateMatches(event: CalendarEvent, task: TodoistTask): boolean {
  return event.status !== "cancelled"
    && normalizedText(event.summary) === normalizedText(task.content)
    && normalizedText(event.description) === normalizedText(task.description)
    && startsMatch(event, task);
}

function todoistTemplateTask(master: CalendarEvent, task: TodoistTask): TodoistTask {
  const shared = master.extendedProperties?.shared;
  if (shared?.todoistTemplateSummary === undefined) return task;
  return {
    ...task,
    content: shared.todoistTemplateSummary,
    description: shared.todoistTemplateDescription || "",
  };
}

export function matchingTask(event: CalendarEvent, tasks: TodoistTask[]): TodoistTask | undefined {
  const summary = normalizedText(event.summary).toLowerCase();
  if (!summary || (!event.start?.date && !event.start?.dateTime)) return undefined;
  return tasks.find((task) => normalizedText(task.content).toLowerCase().includes(summary) && startsMatch(event, task));
}

export function toTodoistTask(event: CalendarEvent): Omit<TodoistTask, "id"> {
  // Todoist has no duration: a Calendar event contributes its start only.
  // In particular, Google all-day end dates are exclusive and must never
  // become the Todoist due date, even for multi-day events.
  const start = event.start || {};
  const due = start.dateTime
    ? { datetime: start.dateTime, timezone: start.timeZone || "Europe/London" }
    : start.date ? { date: start.date } : undefined;
  return {
    content: normalizedText(event.summary) || "Untitled calendar event",
    description: normalizedText(event.description),
    due,
  };
}

export function toCalendarEvent(task: TodoistTask, existing?: CalendarEvent, preserveRecurrenceAnchor = true): CalendarEvent {
  const due = task.due;
  if (!due || (!due.date && !due.datetime)) {
    throw new Error("Cannot create a Calendar projection for an undated Todoist task");
  }
  // Todoist API v1 can return a timed due value in `due.date` while leaving
  // `due.datetime` empty. Treat that ISO value as timed; sending it as a
  // Google all-day `date` produces a 400 and blocks the FIFO profile queue.
  const dueDateTime = taskDateTime(task);
  const isAllDay = Boolean(due.date && !dueDateTime);
  const duration = durationMilliseconds(existing, isAllDay);
  const taskStart = isAllDay
    ? { date: due.date! }
    : { dateTime: dueDateTime!, timeZone: due.timezone || "Europe/London" };
  // Todoist does not carry a Calendar end/duration. Preserve the exact live
  // end (including all-day multi-day spans and timed offsets) if the logical
  // start has not changed; otherwise shift the previous duration with the
  // newly requested start. Only synthesize a default end for new events or
  // representation changes.
  const taskEnd = existing && (existing.end?.date || existing.end?.dateTime) && startsMatch(existing, task)
    ? existing.end!
    : isAllDay
      ? { date: addDays(due.date!, Math.max(1, Math.round(duration / (24 * 60 * 60_000)))) }
      : { dateTime: addMilliseconds(dueDateTime!, duration), timeZone: due.timezone || "Europe/London" };

  const rrule = todoistRecurrenceToRrule(task);
  const recurrenceKey = todoistRecurrenceKey(task);
  const existingShared = existing?.extendedProperties?.shared;
  const preserveAnchor = preserveRecurrenceAnchor && Boolean(
    rrule
    && recurrenceKey
    && existingShared?.syncRecurrenceOwner === "todoist"
    && existingShared.todoistRecurrence === recurrenceKey
    && existingShared.todoistAnchorStart
    && existingShared.todoistAnchorEnd,
  );
  const anchorAllDay = existingShared?.todoistAnchorAllDay === "true";
  const anchorTimeZone = existingShared?.todoistAnchorTimeZone || due.timezone || "Europe/London";
  const start = preserveAnchor
    ? anchorAllDay
      ? { date: existingShared!.todoistAnchorStart }
      : { dateTime: existingShared!.todoistAnchorStart, timeZone: anchorTimeZone }
    : taskStart;
  const end = preserveAnchor
    ? anchorAllDay
      ? { date: existingShared!.todoistAnchorEnd }
      : { dateTime: existingShared!.todoistAnchorEnd, timeZone: anchorTimeZone }
    : taskEnd;

  const anchorStart = start.dateTime || start.date || "";
  const anchorEnd = end.dateTime || end.date || "";
  return {
    id: "",
    summary: normalizedText(task.content) || "Untitled Todoist task",
    description: normalizedText(task.description),
    start,
    end,
    recurrence: rrule ? [rrule] : undefined,
    extendedProperties: {
      shared: {
        taskId: task.id,
        taskUrl: task.url || `https://app.todoist.com/app/task/${task.id}`,
        originalSummary: normalizedText(task.content),
        syncSource: "todoist-calendar-sync",
        // An ordinary Todoist edit must not sever the archived history.
        ...(existingShared?.syncHistoryMasterId ? {
          syncHistoryMasterId: existingShared.syncHistoryMasterId,
          ...(existingShared.syncHistoryCutoff ? { syncHistoryCutoff: existingShared.syncHistoryCutoff } : {}),
          ...(existingShared.syncSplitVersion ? { syncSplitVersion: existingShared.syncSplitVersion } : {}),
        } : {}),
        ...(rrule && recurrenceKey ? {
          syncRecurrenceOwner: "todoist",
          todoistRecurrence: recurrenceKey,
          todoistAnchorStart: anchorStart,
          todoistAnchorEnd: anchorEnd,
          todoistAnchorAllDay: start.date ? "true" : "false",
          todoistAnchorTimeZone: start.timeZone || "",
          todoistTemplateSummary: normalizedText(task.content),
          todoistTemplateDescription: normalizedText(task.description),
        } : {}),
      },
    },
  };
}

function eventStart(event: CalendarEvent): string | undefined {
  return recurrenceOriginalStart(event);
}

function eventEffectiveStart(event: CalendarEvent): string | undefined {
  return recurrenceEffectiveStart(event);
}

function eventEnd(event: CalendarEvent): string | undefined {
  return event.end?.dateTime || event.end?.date;
}

function localDateAt(now: number, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value("year"), month = value("month"), day = value("day");
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a Calendar event end without confusing all-day dates with UTC
 * instants. Date-only Google ends are exclusive and must be compared with the
 * Calendar's local date; timed ends are RFC3339 instants. Missing or
 * unparseable timezone data fails open so an incomplete response cannot
 * retire a live association. Callers apply their standalone/series policy.
 */
export function calendarEventHasElapsed(event: CalendarEvent, now = Date.now(), timeZone?: string): boolean {
  if (event.end?.date && !event.end.dateTime) {
    const localDate = timeZone ? localDateAt(now, timeZone) : undefined;
    return Boolean(localDate && /^\d{4}-\d{2}-\d{2}$/.test(event.end.date) && event.end.date <= localDate);
  }
  const end = event.end?.dateTime;
  if (!end || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(end)) return false;
  const endTime = Date.parse(end);
  return Number.isFinite(endTime) && endTime <= now;
}

export function calendarOccurrenceHasEnded(event: CalendarEvent, now = Date.now(), timeZone?: string): boolean {
  if (event.status === "cancelled") return true;
  if (event.end?.date && !event.end.dateTime) {
    if (!timeZone) throw new Error("Calendar timezone is required to select an all-day recurrence instance");
    return calendarEventHasElapsed(event, now, timeZone);
  }
  const end = eventEnd(event);
  const endTime = end ? Date.parse(end) : Number.NaN;
  // Missing/invalid end data is treated conservatively: do not advance a live
  // mapping merely because Google returned an incomplete instance.
  return Number.isFinite(endTime) && endTime <= now;
}

function compareLogicalStarts(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return left.localeCompare(right);
}

function latestLogicalStart(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).reduce<string | undefined>((latest, value) => {
    if (!latest) return value;
    return compareLogicalStarts(value, latest) > 0 ? value : latest;
  }, undefined);
}

function logicalStartAfter(value: string, boundary: string): boolean {
  return compareLogicalStarts(value, boundary) > 0;
}

function nextActiveInstance(instances: CalendarEvent[], after?: string, now = Date.now(), timeZone?: string): CalendarEvent | undefined {
  return instances
    .filter((event) => event.status !== "cancelled" && Boolean(eventStart(event)))
    .filter((event) => !calendarOccurrenceHasEnded(event, now, timeZone))
    .filter((event) => !after || logicalStartAfter(eventStart(event) || "", after))
    .sort((a, b) => compareLogicalStarts(eventStart(a) || "", eventStart(b) || ""))[0];
}

export function selectCalendarRecurrenceInstance(
  instances: CalendarEvent[],
  existing?: Pick<RecurrenceLink, "activeInstanceId" | "originalStart" | "calendarProgressVersion" | "completedThroughOriginalStart">,
  now = Date.now(),
  timeZone?: string,
): CalendarEvent | undefined {
  if (instances.some((event) => event.end?.date && !event.end.dateTime) && !timeZone) {
    throw new Error("Calendar timezone is required to select all-day recurrence instances");
  }
  if (existing?.calendarProgressVersion === 1) {
    return nextActiveInstance(instances, existing.completedThroughOriginalStart, now, timeZone);
  }
  if (existing?.activeInstanceId) {
    const current = instances.find((event) => event.id === existing.activeInstanceId);
    if (current && current.status !== "cancelled" && !calendarOccurrenceHasEnded(current, now, timeZone)) return current;
  }
  return nextActiveInstance(instances, existing?.originalStart, now, timeZone);
}

export function suppressedLegacyCalendarRecurrenceCandidate(
  instances: CalendarEvent[],
  existing?: Pick<RecurrenceLink, "activeInstanceId" | "originalStart" | "calendarProgressVersion">,
  now = Date.now(),
  timeZone?: string,
): CalendarEvent | undefined {
  if (instances.some((event) => event.end?.date && !event.end.dateTime) && !timeZone) {
    throw new Error("Calendar timezone is required to select all-day recurrence instances");
  }
  if (!existing?.activeInstanceId || existing.calendarProgressVersion === 1) return undefined;
  const current = instances.find((event) => event.id === existing.activeInstanceId);
  if (!current || current.status === "cancelled" || calendarOccurrenceHasEnded(current, now, timeZone)) return undefined;
  const earliest = nextActiveInstance(instances, undefined, now, timeZone);
  const earliestStart = earliest ? eventStart(earliest) : undefined;
  const currentStart = eventStart(current) || existing.originalStart;
  if (!earliest || earliest.id === current.id || !earliestStart || !currentStart) return undefined;
  return compareLogicalStarts(earliestStart, currentStart) < 0 ? earliest : undefined;
}

// Only compare fields that this synchronizer can faithfully carry in both
// directions. A no-op here is the primary loop guard; the circuit breaker is
// retained only as a last-resort safety net for provider retries or defects.
export function hasCanonicalState(event: CalendarEvent, task: TodoistTask): boolean {
  const textMatches = event.status !== "cancelled"
    && normalizedText(event.summary) === normalizedText(task.content)
    && normalizedText(event.description) === normalizedText(task.description);
  if (!textMatches) return false;
  if (todoistRecurrenceToRrule(task)) {
    return calendarRecurrenceMatchesTodoist(event, task) && recurrenceAnchorMatches(event);
  }
  return startsMatch(event, task);
}

type TodoistCalendarAction = "upsert" | "delete_projection" | "complete_projection" | "skip";

export interface TodoistCalendarLifecycle {
  action: TodoistCalendarAction;
  reason: "deleted" | "completed" | "due_removed" | "undated" | "eligible";
  dueAdded: boolean;
}

export function todoistCalendarLifecycle(payload: TodoistWebhookPayload): TodoistCalendarLifecycle | undefined {
  const task = payload.event_data;
  if (!task?.id) return undefined;
  const eventName = payload.event_name || "";
  const oldTask = payload.event_data_extra?.old_item;
  const explicitlyDeleted = /deleted/i.test(eventName) || Boolean(task.is_deleted);
  const completed = /completed/i.test(eventName) || Boolean(task.is_completed);
  const hadDue = taskHasDue(oldTask);
  const hasDue = taskHasDue(task);
  const dueRemoved = hadDue && !oldTask?.due?.is_recurring && !hasDue;
  const dueAdded = !hadDue && hasDue;
  if (explicitlyDeleted) return { action: "delete_projection", reason: "deleted", dueAdded: false };
  if (completed) return { action: "complete_projection", reason: "completed", dueAdded: false };
  if (dueRemoved) return { action: "delete_projection", reason: "due_removed", dueAdded: false };
  if (!hasDue) return { action: "skip", reason: "undated", dueAdded: false };
  return { action: "upsert", reason: "eligible", dueAdded };
}

function isStrictlyNewer(candidate: string | undefined, baseline: string): boolean {
  const candidateTime = candidate ? Date.parse(candidate) : Number.NaN;
  const baselineTime = Date.parse(baseline);
  return Number.isFinite(candidateTime) && Number.isFinite(baselineTime) && candidateTime > baselineTime;
}

export function canRecreateCalendarProjection(lifecycle: TodoistCalendarLifecycle, taskUpdatedAt: string | undefined, tombstoneUpdatedAt: string): boolean {
  return isStrictlyNewer(taskUpdatedAt, tombstoneUpdatedAt) || (lifecycle.dueAdded && !taskUpdatedAt);
}

/**
 * Resolve metadata per field against the last mirrored values. Recurrence
 * ownership does not make title/description read-only on either side.
 * Missing baselines or simultaneous divergent edits must fail closed.
 */
export function calendarOwnedMetadataResolution(
  baseline: Pick<Mapping, "syncedTitle" | "syncedDescription">,
  master: CalendarEvent,
  task: TodoistTask,
): {
  summary: string; description: string;
  calendarChanged: boolean; todoistChanged: boolean; conflicts: string[];
} {
  const conflicts: string[] = [];
  let calendarChanged = false;
  let todoistChanged = false;
  function field(name: string, initial: string | undefined, calendarValue: string, todoistValue: string): string {
    if (calendarValue === todoistValue) return calendarValue;
    if (initial === undefined) { conflicts.push(name); return calendarValue; }
    if (calendarValue === initial) { calendarChanged = true; return todoistValue; }
    if (todoistValue === initial) { todoistChanged = true; return calendarValue; }
    conflicts.push(name);
    return calendarValue;
  }
  return {
    summary: field("title", baseline.syncedTitle, normalizedText(master.summary), normalizedText(task.content)),
    description: field("description", baseline.syncedDescription, normalizedText(master.description), normalizedText(task.description)),
    calendarChanged, todoistChanged, conflicts,
  };
}

function taskComment(event: CalendarEvent): string {
  return `todoist-calendar-sync\ncalendarEventId=${event.id}\ncalendarUrl=${event.htmlLink || ""}`;
}

function modeAllowsMutations(delivery: Delivery, allowed: boolean): boolean {
  return delivery.mode === "aws" && allowed;
}

function recurrenceLink(mapping: Mapping, owner: RecurrenceLink["owner"]): RecurrenceLink {
  if (!mapping.seriesId) throw new Error("Recurring mapping is missing its logical series ID");
  return {
    profile: mapping.profile,
    owner,
    seriesId: mapping.seriesId,
    masterEventId: mapping.masterEventId,
    activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart,
    ...(mapping.syncedTitle !== undefined ? { syncedTitle: mapping.syncedTitle } : {}),
    ...(mapping.syncedDescription !== undefined ? { syncedDescription: mapping.syncedDescription } : {}),
    ...(mapping.calendarNativeRecurring ? { calendarNativeRecurring: true } : {}),
    ...(owner === "calendar" && mapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
    ...(owner === "calendar" && mapping.completedThroughOriginalStart ? { completedThroughOriginalStart: mapping.completedThroughOriginalStart } : {}),
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    updatedAt: mapping.updatedAt,
  };
}

function recurrenceMapping(link: RecurrenceLink): Mapping {
  return {
    profile: link.profile,
    eventId: link.eventId,
    taskId: link.taskId,
    recurrenceOwner: link.owner,
    seriesId: link.seriesId,
    masterEventId: link.masterEventId,
    activeInstanceId: link.activeInstanceId,
    originalStart: link.originalStart,
    activeEffectiveStart: link.activeEffectiveStart,
    ...(link.syncedTitle !== undefined ? { syncedTitle: link.syncedTitle } : {}),
    ...(link.syncedDescription !== undefined ? { syncedDescription: link.syncedDescription } : {}),
    ...(link.calendarNativeRecurring ? { calendarNativeRecurring: true } : {}),
    ...(link.owner === "calendar" && link.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
    ...(link.owner === "calendar" && link.completedThroughOriginalStart ? { completedThroughOriginalStart: link.completedThroughOriginalStart } : {}),
    updatedAt: link.updatedAt,
  };
}

function completedCalendarProjection(
  mapping: Mapping,
  completedAt: string,
  eventId = mapping.eventId,
  originalStart = mapping.originalStart,
): CompletedCalendarProjection {
  return {
    profile: mapping.profile,
    taskId: mapping.taskId,
    eventId,
    completedAt,
    recurrenceOwner: mapping.recurrenceOwner,
    seriesId: mapping.seriesId,
    masterEventId: mapping.masterEventId,
    originalStart,
  };
}

function todoistOwnedMapping(mapping: Mapping, masterEventId: string, taskId: string, active?: CalendarEvent): Mapping {
  return {
    ...mapping,
    eventId: masterEventId,
    taskId,
    recurrenceOwner: "todoist",
    seriesId: taskId,
    masterEventId,
    activeInstanceId: active?.id,
    originalStart: active ? eventStart(active) : mapping.originalStart,
    activeEffectiveStart: active ? eventEffectiveStart(active) : mapping.activeEffectiveStart,
    calendarProgressVersion: undefined,
    completedThroughOriginalStart: undefined,
    updatedAt: new Date().toISOString(),
  };
}

type ClientPair = { calendar: GoogleCalendar; todoist: Todoist };
type ClientFactory = (profile: Profile) => Promise<ClientPair>;

export class Synchronizer {
  constructor(
    private readonly state = new StateRepository(),
    private readonly scheduleOrphan?: (delivery: Delivery, eventId: string, taskId: string) => Promise<void>,
    private readonly clientFactory?: ClientFactory,
  ) {}

  private async clients(profile: Profile): Promise<ClientPair> {
    if (this.clientFactory) return this.clientFactory(profile);
    return {
      calendar: new GoogleCalendar(await googleCredentials(profile), profiles[profile].calendarId),
      todoist: new Todoist(await todoistToken(profile)),
    };
  }

  private completedState(): Partial<Pick<StateRepository,
    "getCompletedCalendarProjectionByEvent"
    | "listCompletedCalendarProjectionsByTask"
    | "putCompletedCalendarProjection"
    | "deleteCompletedCalendarProjection"
  >> {
    // Several focused unit tests use lightweight state doubles. Keeping the
    // adapter tolerant lets those doubles opt into the new completed state only
    // when the behavior under test needs it, while production always supplies
    // the full StateRepository implementation.
    return this.state as unknown as Partial<Pick<StateRepository,
      "getCompletedCalendarProjectionByEvent"
      | "listCompletedCalendarProjectionsByTask"
      | "putCompletedCalendarProjection"
      | "deleteCompletedCalendarProjection"
    >>;
  }

  private async getCompletedProjection(profile: Profile, eventId: string): Promise<CompletedCalendarProjection | undefined> {
    return this.completedState().getCompletedCalendarProjectionByEvent?.(profile, eventId);
  }

  private async calendarMutationBlockedByCompletion(delivery: Delivery, eventId: string): Promise<boolean> {
    const completedProjection = await this.getCompletedProjection(delivery.profile, eventId);
    if (!completedProjection) return false;
    await this.state.audit(delivery.profile, "calendar_completed_projection_ignored", {
      eventId,
      taskId: completedProjection.taskId,
      completedAt: completedProjection.completedAt,
      recheckedBeforeMutation: true,
    });
    return true;
  }

  private async verifiedCalendarRecurrenceTimeZone(
    profile: Profile,
    calendar: GoogleCalendar,
    todoist: Todoist,
    master: CalendarEvent,
    context: { seriesId: string; masterEventId: string; taskId?: string },
  ): Promise<string | undefined> {
    let calendarTimeZone: string;
    try { calendarTimeZone = await resolveCalendarTimeZone(master, calendar.getTimeZone.bind(calendar)); }
    catch (error) {
      await this.state.audit(profile, "calendar_recurrence_calendar_timezone_unverified", {
        ...context, error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    let todoistTimeZone: string;
    try { todoistTimeZone = await todoist.getTimeZone(); }
    catch (error) {
      await this.state.audit(profile, "calendar_recurrence_todoist_timezone_unverified", {
        ...context, calendarTimeZone, error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    if (todoistTimeZone !== calendarTimeZone) {
      await this.state.audit(profile, "calendar_recurrence_todoist_timezone_mismatch", {
        ...context, calendarTimeZone, todoistTimeZone,
      });
      return undefined;
    }
    return calendarTimeZone;
  }

  private async listCompletedProjections(profile: Profile, taskId: string): Promise<CompletedCalendarProjection[]> {
    return await this.completedState().listCompletedCalendarProjectionsByTask?.(profile, taskId) || [];
  }

  private async putCompletedProjection(projection: CompletedCalendarProjection): Promise<void> {
    await this.completedState().putCompletedCalendarProjection?.(projection);
  }

  private async deleteCompletedProjection(projection: CompletedCalendarProjection): Promise<void> {
    await this.completedState().deleteCompletedCalendarProjection?.(projection);
  }

  /**
   * Compare each editable metadata field with the last confirmed mirror.
   * Apply only changed fields: Calendar PATCH targets the MASTER with If-Match,
   * Todoist POST omits due to avoid a second native recurrence advance.
   */
  private async reconcileCalendarOwnedMetadata(
    profile: Profile,
    mapping: Mapping,
    master: CalendarEvent,
    task: TodoistTask,
    calendar: GoogleCalendar,
    todoist: Todoist,
  ): Promise<{ blocked: boolean; task: TodoistTask; mapping: Mapping }> {
    const resolution = calendarOwnedMetadataResolution(mapping, master, task);
    if (resolution.conflicts.length) {
      await this.state.audit(profile, "calendar_owned_metadata_conflict", {
        seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
        fields: resolution.conflicts, reason: "concurrent_edits_or_missing_baseline",
      });
      return { blocked: true, task, mapping };
    }
    const expected = { content: resolution.summary, description: resolution.description };
    if (resolution.calendarChanged && !master.etag) {
      await this.state.audit(profile, "calendar_owned_metadata_conflict", {
        seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
        reason: "calendar_master_etag_missing",
      });
      return { blocked: true, task, mapping };
    }
    if (resolution.calendarChanged) {
      const updated = await calendar.patchEventMetadataIfUnchanged(master.id, master.etag!, {
        summary: resolution.summary, description: resolution.description,
      });
      if (updated.id !== master.id || updated.recurringEventId || updated.status === "cancelled"
        || JSON.stringify(updated.recurrence) !== JSON.stringify(master.recurrence)
        || normalizedText(updated.summary) !== resolution.summary
        || normalizedText(updated.description) !== resolution.description) {
        await this.state.audit(profile, "calendar_owned_metadata_readback_mismatch", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id, provider: "calendar",
        });
        return { blocked: true, task, mapping };
      }
    }
    let nextTask = task;
    if (resolution.todoistChanged) {
      nextTask = await todoist.updateTaskMetadata(task.id, expected);
      const dueBefore = task.due, dueAfter = nextTask.due;
      if (nextTask.id !== task.id
        || normalizedText(nextTask.content) !== expected.content
        || normalizedText(nextTask.description) !== expected.description
        || Boolean(dueBefore?.is_recurring) !== Boolean(dueAfter?.is_recurring)
        || (dueBefore?.date || dueBefore?.datetime) !== (dueAfter?.date || dueAfter?.datetime)
        || dueBefore?.string !== dueAfter?.string) {
        await this.state.audit(profile, "calendar_owned_metadata_readback_mismatch", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id, provider: "todoist",
        });
        return { blocked: true, task, mapping };
      }
    }
    const nextMapping: Mapping = {
      ...mapping, syncedTitle: resolution.summary, syncedDescription: resolution.description,
      updatedAt: new Date().toISOString(),
    };
    // Only persist baselines for the same mapped pair. Do not resurrect a
    // link concurrently advanced by completion/recovery.
    const current = await this.state.getMappingByTask(profile, task.id);
    if (!current || current.eventId !== mapping.eventId || current.masterEventId !== master.id
      || current.completedThroughOriginalStart !== mapping.completedThroughOriginalStart) {
      await this.state.audit(profile, "calendar_owned_metadata_mapping_changed", {
        seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
      });
      return { blocked: true, task: nextTask, mapping };
    }
    if (resolution.calendarChanged || resolution.todoistChanged
      || mapping.syncedTitle !== resolution.summary || mapping.syncedDescription !== resolution.description) {
      await this.state.putMapping(nextMapping);
      const link = mapping.seriesId ? await this.state.getRecurrenceLink(profile, mapping.seriesId) : undefined;
      if (link && link.taskId === task.id && link.eventId === mapping.eventId && link.owner === "calendar") {
        await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "calendar"));
      }
      if (resolution.calendarChanged || resolution.todoistChanged) {
        await this.state.recordMutation(profile);
        await this.state.audit(profile, "calendar_owned_metadata_propagated", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
          toCalendar: resolution.calendarChanged, toTodoist: resolution.todoistChanged,
        });
      }
    }
    return { blocked: false, task: nextTask, mapping: nextMapping };
  }

  private async bindTodoistOwnedOccurrence(
    profile: Profile,
    mapping: Mapping,
    task: TodoistTask,
    occurrence: CalendarEvent,
    todoist: Todoist,
  ): Promise<{ mapping: Mapping; task: TodoistTask; mutated: boolean }> {
    const mutated = !occurrenceStateMatches(occurrence, task);
    const nextTask = mutated ? await todoist.updateRecurringOccurrence(task, toTodoistTask(occurrence)) : task;
    const masterEventId = mapping.masterEventId || mapping.eventId;
    const nextMapping = todoistOwnedMapping(mapping, masterEventId, task.id, occurrence);
    await this.state.putMapping(nextMapping);
    await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
    if (mutated) await this.state.recordMutation(profile);
    return { mapping: nextMapping, task: nextTask, mutated };
  }

  async process(delivery: Delivery): Promise<void> {
    if (delivery.kind === "calendar") return this.processCalendar(delivery);
    if (delivery.kind === "todoist") return this.processTodoist(delivery);
    if (delivery.kind === "reconcile") return this.reconcile(delivery.profile);
    return this.processOrphan(delivery);
  }

  async reconcile(profile: Profile): Promise<void> {
    const { calendar, todoist } = await this.clients(profile);
    for (const link of await this.state.listRecurrenceLinks(profile)) {
      if (link.owner !== "calendar" || !link.masterEventId) continue;
      if (await this.state.syncBlocked(profile, { taskId: link.taskId, eventId: link.activeInstanceId || link.masterEventId })) continue;
      let master: CalendarEvent;
      try { master = await calendar.getEvent(link.masterEventId); }
      catch (error) {
        if (!calendarEventGoneOnDirectRead(error)) throw error;
        await this.state.audit(profile, "calendar_recurrence_recovery_stale_master", { seriesId: link.seriesId, masterEventId: link.masterEventId });
        continue;
      }
      if (master.status === "cancelled" || !master.recurrence?.length) {
        await this.state.audit(profile, "calendar_recurrence_recovery_stale_master", { seriesId: link.seriesId, masterEventId: link.masterEventId });
        continue;
      }
      const timeZone = await this.verifiedCalendarRecurrenceTimeZone(profile, calendar, todoist, master, {
        seriesId: link.seriesId, masterEventId: link.masterEventId, taskId: link.taskId,
      });
      if (!timeZone) continue;
      const now = Date.now();
      const native = nativeCalendarRecurrenceCandidate(master);
      // Open-ended Google series must never be expanded without an upper bound.
      if (native && !calendar.listInstancesInWindow) {
        await this.state.audit(profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
          seriesId: link.seriesId, masterEventId: master.id, taskId: link.taskId,
        });
        continue;
      }
      let instances: CalendarEvent[];
      try {
        if (native) {
          const anchor = link.activeEffectiveStart || link.originalStart;
          const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
          const fromMs = Number.isFinite(anchorMs) ? Math.min(anchorMs, now) : now;
          instances = await calendar.listInstancesInWindow!(master.id,
            new Date(fromMs - 24 * 60 * 60_000).toISOString(),
            new Date(now + 3 * 366 * 24 * 60 * 60_000).toISOString());
        } else instances = await calendar.listInstances(link.masterEventId);
      } catch (error) {
        throw new ReconciliationItemError(error, {
          stage: "recurrence", taskId: link.taskId,
          eventId: link.activeInstanceId || link.masterEventId, seriesId: link.seriesId,
        });
      }
      const suppressed = suppressedLegacyCalendarRecurrenceCandidate(instances, link, now, timeZone);
      if (suppressed) {
        await this.state.audit(profile, "calendar_recurrence_backward_shift_suppressed_legacy_state", {
          seriesId: link.seriesId,
          currentInstanceId: link.activeInstanceId,
          candidateInstanceId: suppressed.id,
          taskId: link.taskId,
        });
      }
      const active = selectCalendarRecurrenceInstance(instances, link, now, timeZone);
      if (!active || active.id === link.activeInstanceId) continue;
      const progressAware = link.calendarProgressVersion === 1;
      let task: TodoistTask | undefined;
      if (progressAware) {
        try { task = await todoist.getTask(link.taskId); }
        catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
        if (!task) {
          await this.state.audit(profile, "calendar_recurrence_recovery_task_readback_missing", {
            seriesId: link.seriesId, taskId: link.taskId, eventId: active.id,
          });
          continue;
        }
      }
      const recurrence = native || finiteWeeklyCalendarRuleCandidate(master)
        ? await verifiedCalendarOwnedRecurrence(master, instances, timeZone,
          calendar.listExplicitSeriesExceptions?.bind(calendar))
        : undefined;
      if (task?.due?.is_recurring
        && (!recurrence || !matchesCalendarOwnedRecurringRule(task, recurrence, timeZone))) {
        await this.state.audit(profile, "calendar_recurrence_todoist_rule_unsupported", {
          seriesId: link.seriesId, taskId: link.taskId,
          reason: "scheduled_reconciliation_existing_native_recurrence_unverified",
        });
        continue;
      }
      if (await this.state.syncBlocked(profile, { taskId: link.taskId, eventId: active.id })) continue;
      if (!progressAware) {
        await this.state.deleteMapping(recurrenceMapping(link));
        await todoist.deleteTask(link.taskId).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
      }
      // If Todoist itself has already moved to this Calendar occurrence,
      // reconciliation must only advance durable state, not move it twice.
      const providerAlreadyAdvanced = Boolean(task?.due?.is_recurring && startsMatch(active, task));
      const nextTask = providerAlreadyAdvanced && task
        ? task
        : task?.due?.is_recurring
          ? await todoist.updateRecurringOccurrence(task, toTodoistTask(active))
          : await todoist.upsertTask(
            recurrence ? calendarOwnedRecurringTaskPayload(active, recurrence, timeZone) : toTodoistTask(active),
            progressAware ? task?.id : undefined,
          );
      if (providerAlreadyAdvanced) await this.state.audit(profile, "calendar_owned_completion_provider_already_advanced", {
        seriesId: link.seriesId, taskId: link.taskId, nextEventId: active.id, origin: "scheduled_reconcile",
      });
      if (recurrence && !calendarOwnedRecurringTaskReadback(nextTask, active, recurrence, timeZone).matches) {
        await this.state.audit(profile, "calendar_recurrence_todoist_readback_mismatch", {
          seriesId: link.seriesId, masterEventId: master.id, eventId: active.id, taskId: nextTask.id,
          reason: "scheduled_reconciliation",
        });
        continue;
      }
      if (progressAware) await this.state.deleteMapping(recurrenceMapping(link));
      const next: Mapping = {
        profile,
        eventId: active.id,
        taskId: nextTask.id,
        recurrenceOwner: "calendar",
        seriesId: link.seriesId,
        masterEventId: link.masterEventId,
        activeInstanceId: active.id,
        originalStart: eventStart(active),
        activeEffectiveStart: eventEffectiveStart(active),
        ...(link.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
        ...(link.completedThroughOriginalStart ? { completedThroughOriginalStart: link.completedThroughOriginalStart } : {}),
        ...(link.syncedTitle !== undefined ? { syncedTitle: link.syncedTitle } : {}),
        ...(link.syncedDescription !== undefined ? { syncedDescription: link.syncedDescription } : {}),
        ...(link.calendarNativeRecurring ? { calendarNativeRecurring: true } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.state.putMapping(next);
      await this.state.putRecurrenceLink(recurrenceLink(next, "calendar"));
      await this.state.recordMutation(profile);
      await this.state.audit(profile, "calendar_recurrence_reconciled", { seriesId: link.seriesId, eventId: active.id, taskId: nextTask.id });
    }
  }

  private async processCalendar(delivery: Delivery): Promise<void> {
    const { calendar, todoist } = await this.clients(delivery.profile);
    const token = await this.state.getSyncToken(delivery.profile);
    let baseline = !token;
    let delta: { items: CalendarEvent[]; nextSyncToken?: string };
    try {
      delta = await calendar.listDelta(token);
    } catch (error) {
      if ((error as { status?: number }).status !== 410) throw error;
      delivery.headers["x-calendar-sync-cursor-expired"] = "true";
      if (token) await this.state.deleteSyncToken(delivery.profile);
      delta = await calendar.listDelta();
      baseline = true;
    }
    if (baseline) {
      if (delta.nextSyncToken) await this.state.putSyncToken(delivery.profile, delta.nextSyncToken);
      await this.state.audit(delivery.profile, "calendar_sync_baselined", {
        deliveryId: delivery.id,
        count: delta.items.length,
        mode: delivery.mode,
      });
      return;
    }
    for (const event of delta.items) await this.applyCalendarEvent(delivery, event, calendar, todoist);
    if (delta.nextSyncToken) await this.state.putSyncToken(delivery.profile, delta.nextSyncToken);
    await this.state.audit(delivery.profile, "calendar_delta_processed", { deliveryId: delivery.id, count: delta.items.length, mode: delivery.mode });
  }

  private async applyCalendarEvent(delivery: Delivery, event: CalendarEvent, calendar: GoogleCalendar, todoist: Todoist): Promise<void> {
    // Historical masters and ALL their instances are immutable history. Google
    // instance deltas do not always inherit the parent's shared properties;
    // resolve that identity before any provider mutation.
    let archived = event.extendedProperties?.shared?.syncHistoryOnly === "true";
    if (archived) {
      return this.state.audit(delivery.profile, "calendar_archived_series_delta_ignored", {
        eventId: event.id, masterEventId: event.recurringEventId || event.id,
      });
    }
    let ownershipEvent = event;
    let mapping = event.status === "cancelled" && !event.recurringEventId
      ? await this.state.getMappingByEvent(delivery.profile, event.id)
      : undefined;
    const knownMasterEventId = event.recurringEventId || mapping?.masterEventId;
    // Resolve the master for cancellations too: Google may omit organizer
    // metadata and recurrence IDs from a cancelled occurrence. Use the
    // persisted mapping as a fallback source of the master identity.
    if (!archived && knownMasterEventId) {
      let parent: CalendarEvent | undefined;
      try { parent = await calendar.getEvent(knownMasterEventId); }
      catch(error) {
        if (!calendarEventGoneOnDirectRead(error)) throw error;
        if (event.status !== "cancelled") {
          return this.state.audit(delivery.profile,"calendar_stale_series_instance_ignored",{eventId:event.id,masterEventId:knownMasterEventId});
        }
        if (mapping?.masterEventId) {
          return this.state.audit(delivery.profile, "calendar_cancelled_copy_owner_unverified", {
            eventId: event.id, masterEventId: knownMasterEventId, reason: "master_missing",
          });
        }
      }
      if (parent) {
        ownershipEvent = parent;
        if (event.status !== "cancelled" && (parent.status === "cancelled" || !parent.recurrence?.length)) {
          return this.state.audit(delivery.profile,"calendar_stale_series_instance_ignored",{eventId:event.id,masterEventId:parent.id});
        }
        archived = parent.extendedProperties?.shared?.syncHistoryOnly === "true";
      }
    }
    if (archived) {
      return this.state.audit(delivery.profile, "calendar_archived_series_delta_ignored", {
        eventId: event.id, masterEventId: event.recurringEventId || event.id,
      });
    }
    mapping ||= await this.state.getMappingByEvent(delivery.profile, event.id);
    if (!event.recurringEventId && !event.recurrence?.length && event.status !== "cancelled") {
      const endIsAllDay = Boolean(event.end?.date && !event.end.dateTime);
      const calendar = endIsAllDay ? (await this.clients(delivery.profile)).calendar : undefined;
      const timeZone = calendar?.getTimeZone ? await calendar.getTimeZone() : undefined;
      if (calendarEventHasElapsed(event, Date.now(), timeZone)) {
        return this.state.audit(delivery.profile, "calendar_elapsed_standalone_event_ignored", {
          eventId: event.id,
          end: event.end?.dateTime || event.end?.date,
          ...(timeZone ? { timeZone } : {}),
        });
      }
    }
    const completedProjection = await this.getCompletedProjection(delivery.profile, event.id);
    if (completedProjection) {
      return this.state.audit(delivery.profile, "calendar_completed_projection_ignored", {
        eventId: event.id,
        taskId: completedProjection.taskId,
        completedAt: completedProjection.completedAt,
      });
    }
    let parentMapping = event.recurringEventId
      ? await this.state.getMappingByEvent(delivery.profile, event.recurringEventId)
      : undefined;
    const seriesId = event.iCalUID || event.recurringEventId || event.id;
    const existingRecurrenceLink = event.recurrence?.length || event.recurringEventId
      ? await this.state.getRecurrenceLink(delivery.profile, seriesId)
      : undefined;
    const originProfile = otherProfileCalendarOrganizer(delivery.profile, ownershipEvent);
    const suppressCrossProfileCopy = event.status === "cancelled"
      || (!mapping && !parentMapping && !existingRecurrenceLink);
    if (originProfile && suppressCrossProfileCopy) {
      return this.state.audit(delivery.profile, "calendar_cross_profile_copy_ignored", {
        eventId: event.id,
        ...(event.recurringEventId ? { masterEventId: event.recurringEventId } : {}),
        fromProfile: delivery.profile,
        toProfile: originProfile,
      });
    }
    const linkedTaskId = event.extendedProperties?.shared?.taskId;
    if (await this.state.syncBlocked(delivery.profile, {
      taskId: mapping?.taskId || parentMapping?.taskId || linkedTaskId,
      eventId: event.id,
    })) {
      return this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", {
        eventId: event.id, taskId: mapping?.taskId || parentMapping?.taskId || linkedTaskId,
      });
    }
    if (!parentMapping && event.recurringEventId && linkedTaskId) {
      const candidate = await this.state.getMappingByTask(delivery.profile, linkedTaskId);
      if (candidate?.masterEventId === event.recurringEventId) parentMapping = candidate;
    }
    const todoistOwnedInstance = Boolean(
      event.recurringEventId
      && (
        event.extendedProperties?.shared?.syncRecurrenceOwner === "todoist"
        || parentMapping?.recurrenceOwner === "todoist"
      ),
    );
    if (todoistOwnedInstance) {
      if (!parentMapping || parentMapping.recurrenceOwner !== "todoist") {
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_instance_unbound", { eventId: event.id, masterEventId: event.recurringEventId, taskId: linkedTaskId });
      }
      if (event.id !== parentMapping.activeInstanceId) {
        return this.state.audit(
          delivery.profile,
          event.status === "cancelled" ? "todoist_recurrence_calendar_instance_cancelled_deferred" : "todoist_recurrence_calendar_instance_change_deferred",
          { eventId: event.id, masterEventId: event.recurringEventId, taskId: parentMapping.taskId, originalStart: eventStart(event), effectiveStart: eventEffectiveStart(event) },
        );
      }
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_exception_suppressed", { eventId: event.id, taskId: parentMapping.taskId, mode: delivery.mode });
      }
      let task: TodoistTask;
      try {
        task = await todoist.getTask(parentMapping.taskId);
      } catch (error) {
        if (Number((error as { status?: number }).status) !== 404) throw error;
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_exception_task_missing", { eventId: event.id, taskId: parentMapping.taskId });
      }
      if (event.status === "cancelled") {
        const { calendar } = await this.clients(delivery.profile);
        const instances = await calendar.listInstances(parentMapping.masterEventId!);
        const next = selectNextEffectiveTodoistInstance(
          instances,
          parentMapping.activeInstanceId,
          parentMapping.activeEffectiveStart || eventEffectiveStart(event) || parentMapping.originalStart,
        );
        if (!next) {
          return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_instance_deleted_no_next", { eventId: event.id, taskId: task.id });
        }
        if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
        const result = await this.bindTodoistOwnedOccurrence(delivery.profile, parentMapping, task, next, todoist);
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_instance_deleted_skipped", {
          taskId: task.id,
          deletedEventId: event.id,
          nextEventId: next.id,
          nextOriginalStart: result.mapping.originalStart,
          nextEffectiveStart: result.mapping.activeEffectiveStart,
        });
      }
      if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
      const result = await this.bindTodoistOwnedOccurrence(delivery.profile, parentMapping, task, event, todoist);
      return this.state.audit(
        delivery.profile,
        result.mutated ? "todoist_recurrence_calendar_active_exception_applied" : "todoist_recurrence_calendar_active_exception_noop",
        { eventId: event.id, taskId: task.id, originalStart: result.mapping.originalStart, effectiveStart: result.mapping.activeEffectiveStart },
      );
    }
    if (event.recurrence?.length && !event.recurringEventId && event.status !== "cancelled") {
      if (isTodoistOwnedCalendarRecurrence(event) || mapping?.recurrenceOwner === "todoist") {
        return this.applyTodoistOwnedCalendarSeries(delivery, event, todoist, mapping);
      }
      return this.applyCalendarSeries(delivery, event, todoist);
    }
    if (event.status === "cancelled") {
      if (mapping?.recurrenceOwner === "todoist") {
        if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
          return this.state.audit(delivery.profile, "todoist_recurrence_calendar_master_delete_suppressed", { eventId: event.id, taskId: mapping.taskId, mode: delivery.mode });
        }
        await this.state.putCalendarProjectionTombstone(delivery.profile, mapping.taskId, delivery.receivedAt);
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_master_deleted_projection_only", { eventId: event.id, taskId: mapping.taskId, projectionSuppressed: true });
      }

      // Cancelled Google exceptions can omit iCalUID and shared properties.
      // Resolve the persisted series before acting on any occurrence mapping.
      const series = (mapping?.recurrenceOwner === "calendar" && mapping.seriesId)
        || event.iCalUID || event.recurringEventId || event.id;
      let existingRecurrence = await this.state.getRecurrenceLink(delivery.profile, series);
      if (!existingRecurrence && event.recurringEventId) {
        existingRecurrence = (await this.state.listRecurrenceLinks(delivery.profile))
          .find((link) => link.owner === "calendar" && link.masterEventId === event.recurringEventId);
      }
      if (existingRecurrence?.owner === "calendar" && existingRecurrence.masterEventId) {
        // Deltas for cancelled exceptions may omit recurringEventId/iCalUID.
        // Classify strictly by the persisted active/master IDs before allowing
        // any path that deletes or rolls the live Todoist task.
        if (event.id !== existingRecurrence.activeInstanceId
          && event.id !== existingRecurrence.masterEventId) {
          const activeInstanceId = existingRecurrence.activeInstanceId;
          if (!activeInstanceId) {
            return this.state.audit(delivery.profile, "calendar_recurrence_stale_instance_cancellation_ignored", {
              seriesId: existingRecurrence.seriesId, eventId: event.id, reason: "active_instance_unknown",
            });
          }
          // Never infer a deletion from a delayed delta alone. Read back both
          // instances, establish immutable logical ordering, and prove that the
          // later occurrence still owns the task before touching DynamoDB.
          let cancelled: CalendarEvent;
          let active: CalendarEvent;
          try {
            cancelled = await calendar.getEvent(event.id);
            active = await calendar.getEvent(activeInstanceId);
          } catch (error) {
            if (!calendarEventGoneOnDirectRead(error)) throw error;
            return this.state.audit(delivery.profile, "calendar_recurrence_stale_instance_cancellation_ignored", {
              seriesId: existingRecurrence.seriesId, eventId: event.id, activeInstanceId, reason: "provider_read_missing",
            });
          }
          const oldStart = eventStart(cancelled) || eventStart(event);
          const activeStart = eventStart(active);
          const deltaStart = eventStart(event);
          const verified = cancelled.id === event.id && cancelled.status === "cancelled"
            && cancelled.recurringEventId === existingRecurrence.masterEventId
            && active.id === activeInstanceId && active.status === "confirmed"
            && active.recurringEventId === existingRecurrence.masterEventId
            && Boolean(oldStart && activeStart)
            && Number.isFinite(Date.parse(oldStart || ""))
            && Number.isFinite(Date.parse(activeStart || ""))
            && (!deltaStart || !eventStart(cancelled) || compareLogicalStarts(deltaStart, oldStart!) === 0);
          if (!verified || compareLogicalStarts(oldStart!, activeStart!) >= 0) {
            return this.state.audit(delivery.profile, "calendar_recurrence_stale_instance_cancellation_ignored", {
              seriesId: existingRecurrence.seriesId, eventId: event.id, activeInstanceId,
              reason: !verified ? "provider_or_identity_unverified" : "not_earlier_than_active",
            });
          }
          const activeMapping = await this.state.getMappingByEvent(delivery.profile, activeInstanceId);
          if (!activeMapping || activeMapping.taskId !== existingRecurrence.taskId
            || activeMapping.eventId !== activeInstanceId
            || activeMapping.recurrenceOwner !== "calendar"
            || activeMapping.seriesId !== existingRecurrence.seriesId
            || activeMapping.masterEventId !== existingRecurrence.masterEventId
            || (mapping && (mapping.recurrenceOwner !== "calendar"
              || mapping.seriesId !== existingRecurrence.seriesId
              || mapping.masterEventId !== existingRecurrence.masterEventId))) {
            return this.state.audit(delivery.profile, "calendar_recurrence_stale_instance_cancellation_ignored", {
              seriesId: existingRecurrence.seriesId, eventId: event.id, activeInstanceId, reason: "mapping_ownership_unverified",
            });
          }
          if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
            return this.state.audit(delivery.profile, "calendar_recurrence_delete_suppressed", {
              seriesId: existingRecurrence.seriesId, eventId: event.id, mode: delivery.mode,
            });
          }
          if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
          const removed = await this.state.purgeEarlierCancelledCalendarOccurrence(existingRecurrence, event.id, mapping);
          if (removed) await this.state.recordMutation(delivery.profile);
          return this.state.audit(delivery.profile,
            removed ? "calendar_recurrence_earlier_instance_cancellation_honored"
              : "calendar_recurrence_earlier_instance_cancellation_noop",
            { seriesId: existingRecurrence.seriesId, eventId: event.id, activeInstanceId,
              taskId: existingRecurrence.taskId, oldStart, activeStart, stateChanged: removed });
        }
        if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
          return this.state.audit(delivery.profile, "calendar_recurrence_delete_suppressed", { seriesId: series, mode: delivery.mode });
        }
        if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
        const deletingMaster = !event.recurringEventId && event.id === existingRecurrence.masterEventId;
        let next: CalendarEvent | undefined;
        let successorRule: ReturnType<typeof calendarOwnedTodoistRecurrence>;
        let verifiedTimeZone: string | undefined;
        if (!deletingMaster) {
          let master: CalendarEvent;
          try { master = await calendar.getEvent(existingRecurrence.masterEventId); }
          catch (error) {
            if (!calendarEventGoneOnDirectRead(error)) throw error;
            return this.state.audit(delivery.profile, "calendar_recurrence_recovery_stale_master", {
              seriesId: series, masterEventId: existingRecurrence.masterEventId,
            });
          }
          if (master.status === "cancelled" || !master.recurrence?.length) {
            return this.state.audit(delivery.profile, "calendar_recurrence_recovery_stale_master", {
              seriesId: series, masterEventId: existingRecurrence.masterEventId,
            });
          }
          const timeZone = await this.verifiedCalendarRecurrenceTimeZone(delivery.profile, calendar, todoist, master, {
            seriesId: series, masterEventId: existingRecurrence.masterEventId, taskId: existingRecurrence.taskId,
          });
          if (!timeZone) return;
          verifiedTimeZone = timeZone;
          const finiteWeekly = finiteWeeklyCalendarRuleCandidate(master);
          const native = nativeCalendarRecurrenceCandidate(master);
          const anchor = existingRecurrence.activeEffectiveStart || existingRecurrence.originalStart;
          const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
          const fromMs = Number.isFinite(anchorMs) ? Math.min(anchorMs, Date.now()) : Date.now();
          if (native && !calendar.listInstancesInWindow) {
            return this.state.audit(delivery.profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
              seriesId: series, masterEventId: master.id,
            });
          }
          const instances = native
            ? await calendar.listInstancesInWindow!(master.id,
              new Date(fromMs - 24 * 60 * 60_000).toISOString(),
              new Date(Date.now() + 3 * 366 * 24 * 60 * 60_000).toISOString())
            : await calendar.listInstances(master.id);
          successorRule = finiteWeekly || native
            ? await verifiedCalendarOwnedRecurrence(master, instances, timeZone,
              calendar.listExplicitSeriesExceptions?.bind(calendar))
            : undefined;
          next = selectCalendarRecurrenceInstance(instances, existingRecurrence, Date.now(), timeZone);
        }
        const oldMapping = recurrenceMapping(existingRecurrence);
        if (deletingMaster) {
          await todoist.deleteTask(existingRecurrence.taskId).catch((error: unknown) => {
            if (Number((error as { status?: number }).status) !== 404) throw error;
          });
          await this.state.deleteMapping(oldMapping);
          await this.state.deleteRecurrenceLink(delivery.profile, series);
          await this.state.recordMutation(delivery.profile);
          return this.state.audit(delivery.profile, "calendar_recurrence_master_deleted", { seriesId: series });
        }
        if (!next) {
          // An empty lookahead is not proof that an open-ended series ended.
          return this.state.audit(delivery.profile, "calendar_recurrence_instance_deleted_no_next", { seriesId: series });
        }
        let previousTask: TodoistTask | undefined;
        try { previousTask = await todoist.getTask(existingRecurrence.taskId); }
        catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
        if (previousTask?.due?.is_recurring
          && (!successorRule || !matchesCalendarOwnedRecurringRule(previousTask, successorRule, verifiedTimeZone))) {
          return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
            seriesId: series, taskId: previousTask.id, reason: "cancelled_instance_existing_recurrence_unverified",
          });
        }
        const nextTask = successorRule
          ? previousTask?.due?.is_recurring
            ? await todoist.updateRecurringOccurrence(previousTask, toTodoistTask(next))
            : await todoist.upsertTask(calendarOwnedRecurringTaskPayload(next, successorRule, verifiedTimeZone), previousTask?.id)
          : await (async () => {
            if (previousTask) await todoist.deleteTask(previousTask.id);
            return todoist.upsertTask(toTodoistTask(next));
          })();
        if (successorRule && !matchesCalendarOwnedRecurringTask(nextTask, next, successorRule, verifiedTimeZone)) {
          return this.state.audit(delivery.profile, "calendar_recurrence_todoist_readback_mismatch", {
            seriesId: series, eventId: next.id, taskId: nextTask.id, reason: "cancelled_instance_reanchoring",
          });
        }
        await this.state.deleteMapping(oldMapping);
        const nextMapping: Mapping = {
          profile: delivery.profile,
          eventId: next.id,
          taskId: nextTask.id,
          recurrenceOwner: "calendar",
          seriesId: existingRecurrence.seriesId,
          masterEventId: existingRecurrence.masterEventId,
          activeInstanceId: next.id,
          originalStart: eventStart(next),
          activeEffectiveStart: eventEffectiveStart(next),
          ...(existingRecurrence.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
          ...(existingRecurrence.completedThroughOriginalStart ? { completedThroughOriginalStart: existingRecurrence.completedThroughOriginalStart } : {}),
          updatedAt: new Date().toISOString(),
        };
        await this.state.putMapping(nextMapping);
        await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "calendar"));
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "calendar_recurrence_instance_deleted_rolled", { seriesId: series, eventId: next.id, taskId: nextTask.id });
      }
      // An unbound/legacy cancelled series instance must never fall through
      // to the standalone deletion path and delete the still-live Todoist task.
      if (event.recurringEventId && mapping?.recurrenceOwner === "calendar") {
        return this.state.audit(delivery.profile, "calendar_recurrence_unbound_instance_cancellation_deferred", {
          eventId: event.id, masterEventId: event.recurringEventId, taskId: mapping.taskId,
        });
      }
      if (!mapping) return;
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) return this.state.audit(delivery.profile, "calendar_delete_suppressed", { eventId: event.id, mode: delivery.mode });
      if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
      try {
        await todoist.deleteTask(mapping.taskId);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        await this.scheduleOrphan?.(delivery, event.id, mapping.taskId);
        return this.state.audit(delivery.profile, "calendar_orphan_recheck_scheduled", { eventId: event.id, taskId: mapping.taskId });
      }
      await deleteMappingComments(todoist, mapping);
      await this.state.deleteMapping(mapping);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, "calendar_deleted_task", { eventId: event.id, taskId: mapping.taskId });
    }
    if (event.status && event.status !== "confirmed") return;

    let task: TodoistTask | undefined;
    if (mapping) {
      try { task = await todoist.getTask(mapping.taskId); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; mapping = undefined; }
    }
    if (!task && linkedTaskId) {
      try { task = await todoist.getTask(linkedTaskId); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    }
    if (!task) task = matchingTask(event, await todoist.listTasks());
    if (task) {
      const owner = await this.state.getMappingByTaskAnyProfile(task.id);
      if (owner && (owner.profile !== delivery.profile || ![owner.eventId,owner.masterEventId,owner.activeInstanceId].includes(event.id))) {
        return this.state.audit(delivery.profile,"calendar_task_link_ambiguous_conflict",{eventId:event.id,taskId:task.id,ownerProfile:owner.profile,mappedEventId:owner.eventId});
      }
    }
    if (task && await this.state.syncBlocked(delivery.profile, { taskId:task.id, eventId:event.id })) {
      return this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", { eventId:event.id, taskId:task.id });
    }
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "calendar_mutation_suppressed", { eventId: event.id, taskId: task?.id, mode: delivery.mode });
    }
    if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
    if (task && hasCanonicalState(event, task)) {
      const nextMapping: Mapping = {
        ...(mapping || {}),
        profile: delivery.profile,
        eventId: event.id,
        taskId: task.id,
        projectId: task.project_id || mapping?.projectId || profiles[delivery.profile].todoistProjectId,
        updatedAt: new Date().toISOString(),
      };
      await this.state.putMapping(nextMapping);
      return this.state.audit(delivery.profile, "calendar_noop_canonical_state", { eventId: event.id, taskId: task.id });
    }
    const nextTask = await todoist.upsertTask(toTodoistTask(event), task?.id);
    const knownCommentId = mapping?.projectCommentId || mapping?.commentId;
    const existingComment = knownCommentId ? { id: knownCommentId } : await todoist.findComment(nextTask.id, event.id);
    const projectId = nextTask.project_id || mapping?.projectId || profiles[delivery.profile].todoistProjectId;
    const draftMapping: Mapping = {
      ...(mapping || {}),
      profile: delivery.profile,
      eventId: event.id,
      taskId: nextTask.id,
      projectId,
      updatedAt: new Date().toISOString(),
    };
    const comment = await todoist.upsertComment(nextTask.id, taskComment(event), existingComment?.id, draftMapping);
    const referenceMapping = existingComment?.id && !draftMapping.projectCommentId && !draftMapping.commentId
      ? { ...draftMapping, commentId: existingComment.id }
      : draftMapping;
    const nextMapping = attachProjectCommentReference(referenceMapping, projectId, comment.id);
    await this.state.putMapping(nextMapping);
    await this.state.recordRecurrence(delivery.profile, event.id, event.recurrence);
    await this.state.recordMutation(delivery.profile);
    await this.state.audit(delivery.profile, task ? "calendar_updated_task" : "calendar_created_task", { eventId: event.id, taskId: nextTask.id });
  }

  private async applyTodoistOwnedCalendarSeries(
    delivery: Delivery,
    master: CalendarEvent,
    todoist: Todoist,
    mapping?: Mapping,
  ): Promise<void> {
    const taskId = mapping?.taskId || master.extendedProperties?.shared?.taskId;
    if (!taskId) {
      return this.state.audit(delivery.profile, "todoist_recurrence_calendar_master_missing_task", { eventId: master.id });
    }
    let task: TodoistTask;
    try {
      task = await todoist.getTask(taskId);
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 404) throw error;
      return this.state.audit(delivery.profile, "todoist_recurrence_calendar_master_orphaned", { eventId: master.id, taskId });
    }
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "todoist_recurrence_calendar_master_mutation_suppressed", { eventId: master.id, taskId, mode: delivery.mode });
    }

    const { calendar } = await this.clients(delivery.profile);
    const instancesBefore = await calendar.listInstances(master.id);
    const activeBefore = mapping?.activeInstanceId
      ? instancesBefore.find((instance) => instance.id === mapping.activeInstanceId && instance.status !== "cancelled")
      : undefined;
    const templateTask = activeBefore && occurrenceStateMatches(activeBefore, task)
      ? todoistTemplateTask(master, task)
      : task;
    const canonical = hasCanonicalState(master, templateTask);
    const stored = canonical ? master : await calendar.upsertEvent(toCalendarEvent(templateTask, master), master.id);
    const instances = canonical ? instancesBefore : await calendar.listInstances(stored.id);
    let active = mapping?.activeInstanceId
      ? instances.find((instance) => instance.id === mapping.activeInstanceId && instance.status !== "cancelled")
      : undefined;
    if (!active || !occurrenceStateMatches(active, task)) {
      active = selectTodoistCurrentInstance(instances, task);
    }
    if (!active && mapping?.activeEffectiveStart) {
      active = selectNextEffectiveTodoistInstance(instances, undefined, mapping.activeEffectiveStart);
    }
    const base: Mapping = mapping || {
      profile: delivery.profile,
      eventId: stored.id,
      taskId,
      updatedAt: new Date().toISOString(),
    };
    const nextMapping = todoistOwnedMapping(base, stored.id, taskId, active);
    await this.state.putMapping(nextMapping);
    await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
    if (!canonical) await this.state.recordMutation(delivery.profile);
    return this.state.audit(
      delivery.profile,
      canonical ? "todoist_recurrence_calendar_master_noop" : "todoist_recurrence_calendar_master_restored",
      { eventId: stored.id, taskId, activeInstanceId: active?.id },
    );
  }

  private async applyCalendarSeries(delivery: Delivery, master: CalendarEvent, todoist: Todoist): Promise<void> {
    const { calendar } = await this.clients(delivery.profile);
    // A queued delta can outlive a cancellation or a recurrence flattening.
    // Confirm the master still exists as a live series before recovering it.
    try { master = await calendar.getEvent(master.id); }
    catch (error) {
      if (!calendarEventGoneOnDirectRead(error)) throw error;
      return this.state.audit(delivery.profile, "calendar_recurrence_recovery_stale_master", { masterEventId: master.id });
    }
    if (master.status === "cancelled" || !master.recurrence?.length || master.extendedProperties?.shared?.syncHistoryOnly === "true") {
      return this.state.audit(delivery.profile, "calendar_recurrence_recovery_stale_master", { masterEventId: master.id });
    }
    if (isTodoistOwnedCalendarRecurrence(master)) {
      return this.state.audit(delivery.profile, "calendar_snapshot_recurring_identity_conflict", {
        masterEventId: master.id, candidateTaskIds: [master.extendedProperties?.shared?.taskId].filter(Boolean),
      });
    }
    const seriesId = master.iCalUID || master.id;
    const existing = await this.state.getRecurrenceLink(delivery.profile, seriesId);
    const finiteWeekly = finiteWeeklyCalendarRuleCandidate(master);
    const nativeRecurrence = nativeCalendarRecurrenceCandidate(master);
    // Native unbounded recurrences must not expand forever. Preserve the
    // current mapped occurrence (which can be overdue) within a bounded lookahead.
    const from = existing?.activeEffectiveStart || existing?.originalStart;
    const startMs = from ? Math.min(Date.parse(from) || Date.now(), Date.now()) : Date.now();
    const windowStart = new Date(startMs - 24 * 60 * 60_000).toISOString();
    const windowEnd = new Date(Date.now() + 3 * 366 * 24 * 60 * 60_000).toISOString();
    if (nativeRecurrence && !calendar.listInstancesInWindow) {
      return this.state.audit(delivery.profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
        seriesId, masterEventId: master.id,
      });
    }
    const instances = nativeRecurrence
      ? await calendar.listInstancesInWindow!(master.id, windowStart, windowEnd)
      : await calendar.listInstances(master.id);
    const hasAllDayInstances = instances.some((instance) => instance.end?.date && !instance.end.dateTime);
    let calendarTimeZone = master.start?.timeZone;
    if (finiteWeekly || nativeRecurrence || hasAllDayInstances) {
      calendarTimeZone = await this.verifiedCalendarRecurrenceTimeZone(delivery.profile, calendar, todoist, master, {
        seriesId, masterEventId: master.id,
      });
      if (!calendarTimeZone) return;
    }
    const calendarRecurrence = (finiteWeekly || nativeRecurrence) && calendarTimeZone
      ? await verifiedCalendarOwnedRecurrence(master, instances, calendarTimeZone,
        calendar.listExplicitSeriesExceptions?.bind(calendar))
      : undefined;
    if (!calendarRecurrence) {
      await this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, reason: finiteWeekly
          ? "finite_weekly_rule_or_instance_inventory_not_representable" : nativeRecurrence ? "native_rule_or_complete_exception_inventory_not_representable" : "rrule_outside_supported_native_subset",
      });
    }
    const suppressed = suppressedLegacyCalendarRecurrenceCandidate(instances, existing, Date.now(), calendarTimeZone);
    if (suppressed && existing) {
      await this.state.audit(delivery.profile, "calendar_recurrence_backward_shift_suppressed_legacy_state", {
        seriesId,
        currentInstanceId: existing.activeInstanceId,
        candidateInstanceId: suppressed.id,
        taskId: existing.taskId,
      });
    }
    const active = selectCalendarRecurrenceInstance(instances, existing, Date.now(), calendarTimeZone);
    if (!active) return this.state.audit(delivery.profile, "calendar_recurrence_no_active_instance", { seriesId, masterEventId: master.id });
    if (await this.state.syncBlocked(delivery.profile, { taskId:existing?.taskId, eventId:active.id })) {
      return this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", { eventId:active.id, taskId:existing?.taskId, masterEventId:master.id });
    }
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "calendar_recurrence_mutation_suppressed", { seriesId, mode: delivery.mode });
    }
    const progressAware = existing?.calendarProgressVersion === 1;
    let task: TodoistTask | undefined;
    if (existing?.taskId && (existing.activeInstanceId === active.id || progressAware)) {
      try { task = await todoist.getTask(existing.taskId); } catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
    }
    const sharedTaskIds = [...new Set([master.extendedProperties?.shared?.taskId, active.extendedProperties?.shared?.taskId].filter((id): id is string => Boolean(id)))];
    const candidates = recurringTaskIdentityCandidates(active, await todoist.listTasks());
    // An exact provider identity must never silently become a different task,
    // even when it belongs to another project/profile or is now a one-off.
    const conflictingIds = [...new Set(candidates.filter((id) => id !== task?.id).concat(sharedTaskIds.filter((id) => id !== task?.id)))];
    // A native recurring task may already have been advanced by Todoist before
    // we process its completion webhook. Validate the RULE independently of
    // the due date and metadata, otherwise a legitimate advance looks like an
    // identity collision and a Calendar rename never propagates.
    const mappedRecurringMatches = Boolean(calendarRecurrence && task && task.id === existing?.taskId
      && matchesCalendarOwnedRecurringRule(task, calendarRecurrence, calendarTimeZone));
    if ((task?.due?.is_recurring && !mappedRecurringMatches) || conflictingIds.length) {
      return this.state.audit(delivery.profile, "calendar_snapshot_recurring_identity_conflict", {
        seriesId, masterEventId: master.id, eventId: active.id,
        candidateTaskIds: [...new Set([...conflictingIds, ...(task?.due?.is_recurring ? [task.id] : [])])].sort(),
      });
    }
    if (task?.due?.is_recurring && !calendarRecurrence) {
      return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, taskId: task.id, reason: "existing_native_recurrence_cannot_be_safely_flattened",
      });
    }
    if (await this.state.syncBlocked(delivery.profile, { eventId:master.id, taskId:task?.id })) {
      return this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", { eventId:master.id, taskId:task?.id });
    }
    if (task?.due?.is_recurring && calendarRecurrence) {
      const mapped = await this.state.getMappingByTask(delivery.profile, task.id);
      if (!mapped || mapped.recurrenceOwner !== "calendar" || mapped.masterEventId !== master.id
        || mapped.seriesId !== seriesId || mapped.eventId !== existing?.eventId) {
        return this.state.audit(delivery.profile, "calendar_snapshot_recurring_identity_conflict", {
          seriesId, masterEventId: master.id, eventId: active.id, candidateTaskIds: [task.id],
          reason: "durable_mapping_missing_or_changed",
        });
      }
      const metadata = await this.reconcileCalendarOwnedMetadata(delivery.profile, mapped, master, task, calendar, todoist);
      if (metadata.blocked) return;
      task = metadata.task;
      if (!startsMatch(active, task)) {
        // An in-flight Todoist completion may have advanced the provider's due
        // date while DynamoDB still references the old Calendar occurrence.
        // Metadata can still be synced safely; due/progress must await a
        // verified completion, never rewind a native recurring task.
        return this.state.audit(delivery.profile, "calendar_owned_completion_advance_deferred", {
          seriesId, masterEventId: master.id, taskId: task.id,
          mappedEventId: existing?.eventId, activeEventId: active.id,
          providerDue: task.due?.date || task.due?.datetime,
        });
      }
    }
    if (task && existing?.activeInstanceId === active.id
      && (calendarRecurrence ? matchesCalendarOwnedRecurringTask(task, active, calendarRecurrence, calendarTimeZone)
        && normalizedText(active.summary) === normalizedText(task.content)
        && normalizedText(active.description) === normalizedText(task.description)
        : hasCanonicalState(active, task))) {
      return this.state.audit(delivery.profile, "calendar_recurrence_noop_active_instance", { seriesId, eventId: active.id, taskId: task.id });
    }
    if (await this.calendarMutationBlockedByCompletion(delivery, active.id)) return;
    if (existing?.taskId && (!task || existing.activeInstanceId !== active.id)) {
      await this.state.deleteMapping(recurrenceMapping(existing));
      if (existing.activeInstanceId !== active.id && !progressAware) {
        await todoist.deleteTask(existing.taskId).catch((error: unknown) => { if (Number((error as { status?: number }).status) !== 404) throw error; });
      }
    }
    const nextTask = await todoist.upsertTask(
      calendarRecurrence ? calendarOwnedRecurringTaskPayload(active, calendarRecurrence, calendarTimeZone) : toTodoistTask(active), task?.id,
    );
    const readback = calendarRecurrence ? calendarOwnedRecurringTaskReadback(nextTask, active, calendarRecurrence, calendarTimeZone) : undefined;
    if (readback && !readback.matches) {
      if (!task) {
        await todoist.deleteTask(nextTask.id).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
      } else {
        await todoist.upsertTask(toTodoistTask(active), task.id);
      }
      return this.state.audit(delivery.profile, "calendar_recurrence_todoist_readback_mismatch", {
        seriesId, masterEventId: master.id, eventId: active.id, taskId: nextTask.id,
        expected: readback.expected,
        observed: readback.observed,
      });
    }
    const mapping: Mapping = {
      profile: delivery.profile,
      eventId: active.id,
      taskId: nextTask.id,
      recurrenceOwner: "calendar",
      seriesId,
      masterEventId: master.id,
      activeInstanceId: active.id,
      originalStart: eventStart(active),
      activeEffectiveStart: eventEffectiveStart(active),
      syncedTitle: normalizedText(active.summary),
      syncedDescription: normalizedText(active.description),
      ...(calendarRecurrence ? { calendarNativeRecurring: true } : {}),
      ...(existing
        ? existing.calendarProgressVersion === 1
          ? {
              calendarProgressVersion: 1 as const,
              ...(existing.completedThroughOriginalStart ? { completedThroughOriginalStart: existing.completedThroughOriginalStart } : {}),
            }
          : {}
        : { calendarProgressVersion: 1 as const }),
      updatedAt: new Date().toISOString(),
    };
    await this.state.putMapping(mapping);
    await this.state.putRecurrenceLink(recurrenceLink(mapping, "calendar"));
    await this.state.recordMutation(delivery.profile);
    return this.state.audit(delivery.profile, task ? "calendar_recurrence_updated_task" : "calendar_recurrence_created_task", { seriesId, eventId: active.id, taskId: nextTask.id });
  }

  private async deleteCompletedCalendarHistory(
    profile: Profile,
    taskId: string,
    calendar: GoogleCalendar,
    coveredByDeletedEventId?: string,
  ): Promise<number> {
    const completed = await this.listCompletedProjections(profile, taskId);
    let removed = 0;
    for (const projection of completed) {
      const covered = Boolean(coveredByDeletedEventId && (
        projection.eventId === coveredByDeletedEventId
        || projection.masterEventId === coveredByDeletedEventId
      ));
      if (!covered) {
        await calendar.deleteEvent(projection.eventId).catch((error: unknown) => {
          if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        });
        await this.state.recordMutation(profile);
      }
      await this.deleteCompletedProjection(projection);
      removed += 1;
    }
    return removed;
  }

  private async processTodoist(delivery: Delivery): Promise<void> {
    const payload = JSON.parse(delivery.body) as TodoistWebhookPayload;
    let task = payload.event_data;
    const lifecycle = todoistCalendarLifecycle(payload);
    if (!task?.id || !lifecycle) return;
    // Epochs reject messages already admitted before an erasure fence. An old
    // Todoist webhook can also arrive after that fence and receive the new
    // epoch, so upserts must be checked against current provider state too.
    if (lifecycle.action === "upsert") {
      let current: TodoistTask;
      try {
        current = await (await this.clients(delivery.profile)).todoist.getTask(task.id);
      } catch (error) {
        if (Number((error as { status?: number }).status) === 404) {
          return this.state.audit(delivery.profile, "todoist_erased_item_replay_suppressed", {
            event: payload.event_name,
          });
        }
        throw error;
      }
      const currentProfile = profileForTodoistProject(current.project_id);
      if (currentProfile && currentProfile !== delivery.profile) {
        return this.state.audit(delivery.profile, "todoist_stale_profile_replay_suppressed", {
          currentProfile,
        });
      }
      task = current;
    }
    const existingMapping = await this.state.getMappingByTaskAnyProfile(task.id);
    const completedHistory = lifecycle.action !== "upsert" && !existingMapping
      ? await this.state.listCompletedCalendarProjectionsByTask?.(delivery.profile, task.id) || []
      : [];
    if (lifecycle.action !== "upsert" && !existingMapping && !completedHistory.length) {
      try {
        await (await this.clients(delivery.profile)).todoist.getTask(task.id);
      } catch (error) {
        if (Number((error as { status?: number }).status) === 404) {
          return this.state.audit(delivery.profile, "todoist_erased_item_replay_suppressed", {});
        }
        throw error;
      }
    }
    const controlProfile = existingMapping?.profile || profileForTodoistProject(task.project_id) || delivery.profile;
    if (await this.state.syncBlocked(controlProfile, { taskId: task.id, eventId: existingMapping?.eventId })) {
      return this.state.audit(controlProfile, "todoist_task_sync_control_blocked", { taskId: task.id });
    }
    const recurringDateEdit = todoistRecurringDateEdited(payload);
    const orderedLifecycle = lifecycle.action === "upsert" || lifecycle.reason === "due_removed" || lifecycle.reason === "undated";
    if (orderedLifecycle && !await this.state.acceptTaskVersion(delivery.profile, task.id, task.updated_at)) {
      return this.state.audit(delivery.profile, "todoist_stale_version_suppressed", { taskId: task.id, event: payload.event_name, taskUpdatedAt: task.updated_at });
    }
    if (lifecycle.action === "skip") {
      return this.state.audit(delivery.profile, "todoist_calendar_skipped_undated", { taskId: task.id, event: payload.event_name });
    }

    const projectionTombstone = lifecycle.action === "upsert"
      ? await this.state.getCalendarProjectionTombstone(delivery.profile, task.id)
      : undefined;
    const readdingDue = Boolean(projectionTombstone && canRecreateCalendarProjection(lifecycle, task.updated_at, projectionTombstone.sourceUpdatedAt));
    if (projectionTombstone && !readdingDue) {
      return this.state.audit(delivery.profile, "todoist_calendar_stale_due_suppressed", {
        taskId: task.id,
        event: payload.event_name,
        taskUpdatedAt: task.updated_at,
        removedAt: projectionTombstone.sourceUpdatedAt,
      });
    }

    const { calendar, todoist } = await this.clients(delivery.profile);
    let mapping = await this.state.getMappingByTask(delivery.profile, task.id);
    if (lifecycle.action === "upsert" && mapping?.recurrenceOwner === "calendar" && mapping.masterEventId
      && (task.due?.is_recurring || mapping.calendarNativeRecurring)) {
      // A mapped Calendar-origin recurring Todoist task may legitimately have
      // user-edited metadata. Its automatic date advance is not an instruction
      // to rewrite a generated Calendar instance or transfer ownership.
      let master: CalendarEvent;
      try { master = await calendar.getEvent(mapping.masterEventId); }
      catch (error) {
        if (!calendarEventGoneOnDirectRead(error)) throw error;
        return this.state.audit(delivery.profile, "calendar_owned_todoist_master_missing", {
          taskId: task.id, masterEventId: mapping.masterEventId,
        });
      }
      if (master.status === "cancelled" || !master.recurrence?.length || master.recurringEventId
        || !task.due?.is_recurring) {
        return this.state.audit(delivery.profile, "calendar_owned_todoist_recurrence_requires_review", {
          taskId: task.id, masterEventId: mapping.masterEventId,
          reason: "missing_or_changed_recurring_rule",
        });
      }
      const oldRule = payload.event_data_extra?.old_item?.due?.string;
      if (payload.event_name === "item:updated" && oldRule
        && oldRule !== task.due?.string) {
        return this.state.audit(delivery.profile, "calendar_owned_todoist_recurrence_requires_review", {
          taskId: task.id, masterEventId: mapping.masterEventId,
          reason: "explicit_todoist_recurrence_change",
        });
      }
      if (recurringDateEdit) {
        return this.state.audit(delivery.profile, "calendar_owned_todoist_date_edit_requires_review", {
          taskId: task.id, masterEventId: mapping.masterEventId,
          reason: "explicit_todoist_date_change",
        });
      }
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_mutation_suppressed", {
          taskId: task.id, event: payload.event_name, mode: delivery.mode,
        });
      }
      const metadata = await this.reconcileCalendarOwnedMetadata(delivery.profile, mapping, master, task, calendar, todoist);
      if (metadata.blocked) return;
      // An item:added echo or native post-completion due change is not a
      // request to PUT the Calendar instance. Completion alone may move the
      // mapping, after the corresponding completion delivery is validated.
      return this.state.audit(delivery.profile, "calendar_owned_todoist_echo_ignored", {
        taskId: task.id, seriesId: mapping.seriesId,
        due: task.due?.datetime || task.due?.date,
        mappedOccurrence: mapping.eventId, event: payload.event_name,
      });
    }
    if (lifecycle.reason === "completed" && mapping?.recurrenceOwner === "calendar" && mapping.masterEventId) {
      const completedDueStart = task.due?.datetime || task.due?.date;
      if (mapping.calendarProgressVersion === 1 && mapping.completedThroughOriginalStart && completedDueStart
        && compareLogicalStarts(completedDueStart, mapping.completedThroughOriginalStart) <= 0) {
        return this.state.audit(delivery.profile, "calendar_recurrence_stale_completion_replay_suppressed", {
          seriesId: mapping.seriesId, taskId: task.id,
          completedThroughOriginalStart: mapping.completedThroughOriginalStart,
        });
      }
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_recurrence_mutation_suppressed", { taskId: task.id, mode: delivery.mode });
      }
      const completedThroughOriginalStart = latestLogicalStart(mapping.completedThroughOriginalStart, mapping.originalStart);
      const progressMapping: Mapping = {
        ...mapping,
        ...(mapping.originalStart || mapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
        ...(completedThroughOriginalStart ? { completedThroughOriginalStart } : {}),
        updatedAt: new Date().toISOString(),
      };
      // Keep the old active mapping retryable while reading Calendar and
      // verifying/updating Todoist. The completion boundary is committed with
      // the successor mapping only after provider work succeeds below.
      const retained = completedCalendarProjection(progressMapping, delivery.receivedAt);
      await this.putCompletedProjection(retained);
      await this.state.audit(delivery.profile, "calendar_recurrence_completed_occurrence_retained", {
        seriesId: mapping.seriesId,
        taskId: task.id,
        eventId: retained.eventId,
        completedThroughOriginalStart,
      });
      // Never exhaustively expand an indefinitely recurring Calendar master.
      // Keep the mapped occurrence (which may be overdue) in the bounded range.
      let completionMaster: CalendarEvent | undefined;
      try { completionMaster = await calendar.getEvent(mapping.masterEventId); }
      catch (error) { if (!calendarEventGoneOnDirectRead(error)) throw error; }
      if (!completionMaster || completionMaster.status === "cancelled" || !completionMaster.recurrence?.length) {
        return this.state.audit(delivery.profile, "calendar_recurrence_completed_master_unavailable", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: mapping.masterEventId,
        });
      }
      const nativeCompletion = nativeCalendarRecurrenceCandidate(completionMaster);
      if (nativeCompletion && !calendar.listInstancesInWindow) {
        return this.state.audit(delivery.profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: mapping.masterEventId,
        });
      }
      const mappedStart = mapping.activeEffectiveStart || mapping.originalStart;
      const mappedMs = mappedStart ? Date.parse(mappedStart) : Number.NaN;
      const startMs = Number.isFinite(mappedMs) ? Math.min(mappedMs, Date.now()) : Date.now();
      const instances = nativeCompletion
        ? await calendar.listInstancesInWindow!(mapping.masterEventId,
          new Date(startMs - 24 * 60 * 60_000).toISOString(),
          new Date(Date.now() + 3 * 366 * 24 * 60 * 60_000).toISOString())
        : await calendar.listInstances(mapping.masterEventId);
      let currentRecurringTask: TodoistTask | undefined;
      let currentCalendarRecurrence: ReturnType<typeof calendarOwnedTodoistRecurrence>;
      const recurrenceHint = Boolean(task.due?.is_recurring || payload.event_data_extra?.old_item?.due?.is_recurring);
      let verifiedCalendarTimeZone: string | undefined;
      if (recurrenceHint || nativeCompletion) {
        try { currentRecurringTask = await todoist.getTask(task.id); }
        catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
        if (recurrenceHint && !currentRecurringTask?.due?.is_recurring) {
          // Completed native items can disappear from Todoist's active task API.
          // Creating a fresh one-off here would silently flatten the series.
          return this.state.audit(delivery.profile, "calendar_recurrence_completed_recurring_readback_missing", {
            seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
          });
        }
        if (nativeCompletion && !currentRecurringTask) {
          return this.state.audit(delivery.profile, "calendar_recurrence_completed_recurring_readback_missing", {
            seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
          });
        }
        if (currentRecurringTask?.due?.is_recurring) {
          let master: CalendarEvent | undefined;
          try { master = await calendar.getEvent?.(mapping.masterEventId); }
          catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
          let timeZone: string | undefined;
          if (master) {
            try { timeZone = await resolveCalendarTimeZone(master, calendar.getTimeZone?.bind(calendar)); }
            catch (error) {
              return this.state.audit(delivery.profile, "calendar_recurrence_calendar_timezone_unverified", {
                seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (master && timeZone) currentCalendarRecurrence = await verifiedCalendarOwnedRecurrence(
            master, instances, timeZone, calendar.listExplicitSeriesExceptions?.bind(calendar));
          verifiedCalendarTimeZone = timeZone;
          if (!master || !timeZone || !currentCalendarRecurrence
            || !matchesCalendarOwnedRecurringRule(currentRecurringTask, currentCalendarRecurrence, timeZone)) {
            return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
              seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
              reason: "completed_task_recurrence_does_not_match_supported_calendar_rule",
            });
          }
          let todoistTimeZone: string;
          try { todoistTimeZone = await todoist.getTimeZone(); }
          catch (error) {
            return this.state.audit(delivery.profile, "calendar_recurrence_todoist_timezone_unverified", {
              seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, calendarTimeZone: timeZone,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (todoistTimeZone !== timeZone) {
            return this.state.audit(delivery.profile, "calendar_recurrence_todoist_timezone_mismatch", {
              seriesId: mapping.seriesId, masterEventId: mapping.masterEventId,
              calendarTimeZone: timeZone, todoistTimeZone,
            });
          }
        }
      }
      if (!verifiedCalendarTimeZone && instances.some((instance) => instance.end?.date && !instance.end.dateTime)) {
        let master: CalendarEvent | undefined;
        try { master = await calendar.getEvent?.(mapping.masterEventId); }
        catch (error) { if (!calendarEventGoneOnDirectRead(error)) throw error; }
        if (!master) {
          return this.state.audit(delivery.profile, "calendar_recurrence_calendar_timezone_unverified", {
            seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
            error: "Calendar master is unavailable for all-day recurrence timezone verification",
          });
        }
        verifiedCalendarTimeZone = await this.verifiedCalendarRecurrenceTimeZone(delivery.profile, calendar, todoist, master, {
          seriesId: mapping.seriesId || master.iCalUID || master.id, masterEventId: mapping.masterEventId, taskId: task.id,
        });
        if (!verifiedCalendarTimeZone) return;
      }
      const next = progressMapping.calendarProgressVersion === 1
        ? nextActiveInstance(instances, progressMapping.completedThroughOriginalStart, Date.now(), verifiedCalendarTimeZone)
        : nextActiveInstance(instances, mapping.originalStart, Date.now(), verifiedCalendarTimeZone);
      if (!next) {
        // An empty instances window alone is NOT proof of recurrence exhaustion.
        // Require a finite RRULE on the fresh Calendar master and atomically
        // retire exactly the unchanged recurrence link before removing the
        // mapping. If proof is unavailable, leave the old mapping retryable.
        let master: CalendarEvent | undefined;
        try { master = await calendar.getEvent?.(mapping.masterEventId); }
        catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
        const finite = master?.status !== "cancelled" && master?.recurrence?.some(
          (rule) => /^RRULE:(?:[^;]*;)*(?:COUNT|UNTIL)=/i.test(rule),
        );
        const link = mapping.seriesId ? await this.state.getRecurrenceLink?.(delivery.profile, mapping.seriesId) : undefined;
        if (finite && link && link.masterEventId === mapping.masterEventId
          && await this.state.verifyTerminalCompletedCalendarProjection?.(retained, link)) {
          await this.state.deleteMapping(mapping);
          return this.state.audit(delivery.profile, "calendar_finite_recurrence_terminal_verified", {
            seriesId: mapping.seriesId, taskId: task.id, eventId: retained.eventId,
          });
        }
        return this.state.audit(delivery.profile, "calendar_recurrence_completed_no_next", {
          seriesId: mapping.seriesId, taskId: task.id, terminality: "unverified",
        });
      }
      // Todoist automatically advances native recurrence on completion.
      // When that readback already points to the exact next Calendar instance,
      // do not send a second item_update (which could skip an occurrence).
      const alreadyAdvanced = Boolean(currentCalendarRecurrence && currentRecurringTask
        && startsMatch(next, currentRecurringTask));
      const nextTask = alreadyAdvanced && currentRecurringTask
        ? currentRecurringTask
        : currentCalendarRecurrence && currentRecurringTask
          ? await todoist.updateRecurringOccurrence(currentRecurringTask, toTodoistTask(next))
          : await todoist.upsertTask(toTodoistTask(next));
      if (alreadyAdvanced) {
        await this.state.audit(delivery.profile, "calendar_owned_completion_provider_already_advanced", {
          seriesId: mapping.seriesId, taskId: task.id, nextEventId: next.id,
        });
      }
      const readback = currentCalendarRecurrence
        ? calendarOwnedRecurringTaskReadback(nextTask, next, currentCalendarRecurrence, verifiedCalendarTimeZone)
        : undefined;
      if (readback && !readback.matches) {
        return this.state.audit(delivery.profile, "calendar_recurrence_todoist_readback_mismatch", {
          seriesId: mapping.seriesId, masterEventId: mapping.masterEventId,
          eventId: next.id, taskId: nextTask.id,
          expected: readback.expected,
          observed: readback.observed,
        });
      }
      const nextMapping: Mapping = {
        profile: delivery.profile,
        eventId: next.id,
        taskId: nextTask.id,
        ...(nextTask.project_id ? { projectId: nextTask.project_id } : {}),
        recurrenceOwner: "calendar",
        seriesId: mapping.seriesId,
        masterEventId: mapping.masterEventId,
        activeInstanceId: next.id,
        originalStart: eventStart(next),
        activeEffectiveStart: eventEffectiveStart(next),
        ...(progressMapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
        ...(completedThroughOriginalStart ? { completedThroughOriginalStart } : {}),
        ...(mapping.syncedTitle !== undefined ? { syncedTitle: mapping.syncedTitle } : {}),
        ...(mapping.syncedDescription !== undefined ? { syncedDescription: mapping.syncedDescription } : {}),
        ...(mapping.calendarNativeRecurring ? { calendarNativeRecurring: true } : {}),
        updatedAt: new Date().toISOString(),
      };
      const expectedLink = mapping.seriesId
        ? await this.state.getRecurrenceLink(delivery.profile, mapping.seriesId)
        : undefined;
      if (!expectedLink) {
        return this.state.audit(delivery.profile, "calendar_recurrence_mapping_advance_deferred", {
          seriesId: mapping.seriesId, taskId: task.id, eventId: mapping.eventId,
          reason: "current_recurrence_link_missing",
        });
      }
      const advanced = await this.state.advanceCalendarSeriesMapping({
        previous: mapping,
        mapping: nextMapping,
        expectedLink,
        link: recurrenceLink(nextMapping, "calendar"),
      });
      if (!advanced) {
        return this.state.audit(delivery.profile, "calendar_recurrence_mapping_advance_deferred", {
          seriesId: mapping.seriesId, taskId: task.id, eventId: mapping.eventId,
          reason: "mapping_or_recurrence_link_changed",
        });
      }
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, "calendar_recurrence_completed_rolled", {
        seriesId: mapping.seriesId,
        eventId: next.id,
        taskId: nextTask.id,
        completedThroughOriginalStart,
      });
    }
    if (lifecycle.reason === "completed" && mapping?.recurrenceOwner === "todoist") {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_recurrence_mutation_suppressed", { taskId: task.id, mode: delivery.mode });
      }
      let current: TodoistTask | undefined;
      try { current = await todoist.getTask(task.id); } catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }

      let mappedEvent: CalendarEvent | undefined;
      try { mappedEvent = await calendar.getEvent(mapping.eventId); } catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
      if (!mappedEvent && mapping.masterEventId) {
        await this.state.putCalendarProjectionTombstone(delivery.profile, task.id, delivery.receivedAt);
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "todoist_recurrence_completion_suppressed_missing_calendar_master", {
          taskId: task.id,
          eventId: mapping.eventId,
          projectionSuppressed: true,
        });
      }
      if (mappedEvent?.status === "cancelled") {
        return this.state.audit(delivery.profile, "todoist_recurrence_completion_suppressed_cancelled_calendar", { taskId: task.id, eventId: mapping.eventId });
      }

      if (current?.due?.is_recurring && todoistRecurrenceToRrule(current) && mappedEvent?.recurrence?.length) {
        const instances = await calendar.listInstances(mappedEvent.id);
        const completedTask = payload.event_data_extra?.old_item || task;
        const completed = selectTodoistCurrentInstance(instances, completedTask);
        if (!completed) {
          return this.state.audit(delivery.profile, "todoist_recurrence_completion_occurrence_unresolved", {
            taskId: task.id,
            masterEventId: mappedEvent.id,
            webhookDue: completedTask.due?.datetime || completedTask.due?.date,
          });
        }
        const existingCompletion = await this.getCompletedProjection(delivery.profile, completed.id);
        if (existingCompletion?.taskId === task.id) {
          return this.state.audit(delivery.profile, "todoist_recurrence_duplicate_completion_ignored", {
            taskId: task.id,
            masterEventId: mappedEvent.id,
            eventId: completed.id,
            completedAt: existingCompletion.completedAt,
          });
        }
        const retained = completedCalendarProjection(
          mapping,
          delivery.receivedAt,
          completed.id,
          eventStart(completed),
        );
        await this.putCompletedProjection(retained);
        await this.state.audit(delivery.profile, "todoist_recurrence_completed_occurrence_retained", {
          taskId: task.id,
          masterEventId: mappedEvent.id,
          eventId: completed.id,
        });
        const next = selectNextEffectiveTodoistInstance(
          instances,
          completed.id,
          eventEffectiveStart(completed) || eventStart(completed),
        );
        if (!next) {
          return this.state.audit(delivery.profile, "todoist_recurrence_completed_calendar_series_no_next", { taskId: task.id, eventId: mappedEvent.id });
        }
        const result = await this.bindTodoistOwnedOccurrence(delivery.profile, mapping, current, next, todoist);
        return this.state.audit(delivery.profile, "todoist_recurrence_completed_advanced_to_effective_instance", {
          taskId: task.id,
          masterEventId: mappedEvent.id,
          completedEventId: completed.id,
          nextEventId: next.id,
          nextOriginalStart: result.mapping.originalStart,
          nextEffectiveStart: result.mapping.activeEffectiveStart,
        });
      }

      const retained: CompletedCalendarProjection = {
        ...completedCalendarProjection(mapping, delivery.receivedAt),
        // Only a fresh, explicitly completed provider task with no further
        // recurrence can prove the rolling series was terminal.
        ...(current?.is_completed === true && !current.due?.is_recurring
          ? { terminalVerified: true as const } : {}),
      };
      await this.putCompletedProjection(retained);
      await this.state.audit(delivery.profile, "todoist_recurrence_completed_calendar_retained", {
        taskId: task.id,
        eventId: mapping.eventId,
        recurrenceProjection: mapping.masterEventId ? "rrule" : "rolling",
      });
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      if (!current?.due || !current.due.is_recurring) {
        return this.state.audit(delivery.profile, "todoist_recurrence_completed_no_next", { taskId: task.id, eventId: mapping.eventId });
      }
      const stored = await calendar.upsertEvent(toCalendarEvent(current));
      const projectedRrule = todoistRecurrenceToRrule(current);
      let active: CalendarEvent | undefined;
      if (projectedRrule && stored.recurrence?.length) {
        active = selectTodoistCurrentInstance(await calendar.listInstances(stored.id), current);
      }
      const nextMapping: Mapping = {
        profile: delivery.profile,
        eventId: stored.id,
        taskId: task.id,
        recurrenceOwner: "todoist",
        seriesId: task.id,
        masterEventId: projectedRrule ? stored.id : undefined,
        activeInstanceId: projectedRrule ? active?.id : stored.id,
        originalStart: projectedRrule ? (active ? eventStart(active) : eventStart(stored)) : eventStart(stored),
        activeEffectiveStart: projectedRrule ? (active ? eventEffectiveStart(active) : undefined) : eventEffectiveStart(stored),
        updatedAt: new Date().toISOString(),
      };
      await this.state.putMapping(nextMapping);
      await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, projectedRrule ? "todoist_recurrence_completed_calendar_series_created" : "todoist_recurrence_completed_rolled", { taskId: task.id, eventId: stored.id });
    }
    if (lifecycle.action === "complete_projection") {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_completion_retention_suppressed", { taskId: task.id, mode: delivery.mode });
      }
      if (!mapping) {
        const retained = await this.listCompletedProjections(delivery.profile, task.id);
        return this.state.audit(delivery.profile, retained.length ? "todoist_completed_calendar_already_retained" : "todoist_completed_calendar_missing_mapping", {
          taskId: task.id,
          retainedEventIds: retained.map((projection) => projection.eventId),
        });
      }
      const retained = completedCalendarProjection(mapping, delivery.receivedAt);
      await this.putCompletedProjection(retained);
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      return this.state.audit(delivery.profile, "todoist_completed_calendar_retained", {
        taskId: task.id,
        eventId: mapping.eventId,
        completedAt: retained.completedAt,
      });
    }
    if (lifecycle.reason === "due_removed") {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_mutation_suppressed", { taskId: task.id, event: payload.event_name, mode: delivery.mode });
      }
      if (!mapping) {
        await this.state.putCalendarProjectionTombstone(delivery.profile, task.id, task.updated_at || delivery.receivedAt);
        return this.state.audit(delivery.profile, "todoist_due_removed_no_calendar", { taskId: task.id, event: payload.event_name });
      }
      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      await deleteMappingComments(todoist, mapping);
      await this.state.putCalendarProjectionTombstone(delivery.profile, task.id, task.updated_at || delivery.receivedAt);
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, "todoist_due_removed_calendar", { taskId: task.id, eventId: mapping.eventId });
    }

    let cancelledCalendarLink = false;
    if (!mapping) {
      const linkedEvent = await calendar.findByTodoistTaskId(task.id);
      const retainedLinkedEvent = linkedEvent
        ? await this.getCompletedProjection(delivery.profile, linkedEvent.id)
        : undefined;
      if (retainedLinkedEvent?.taskId === task.id && lifecycle.action !== "delete_projection") {
        // Once COMPLETED_TASK has been purged, event-keyed history is still
        // authoritative. Never rediscover that Calendar event or create a
        // replacement Todoist projection in response to a stale update.
        return this.state.audit(delivery.profile, "todoist_historical_projection_update_ignored", {
          taskId: task.id, eventId: retainedLinkedEvent.eventId,
        });
      }
      if (linkedEvent?.status === "cancelled") {
        cancelledCalendarLink = true;
      } else if (linkedEvent && !retainedLinkedEvent) {
        mapping = { profile: delivery.profile, eventId: linkedEvent.id, taskId: task.id, updatedAt: new Date().toISOString() };
      }
    }
    const deleted = lifecycle.action === "delete_projection";
    if (cancelledCalendarLink && !deleted && !readdingDue) {
      return this.state.audit(delivery.profile, "todoist_update_suppressed_cancelled_calendar", { taskId: task.id, event: payload.event_name });
    }
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "todoist_mutation_suppressed", { taskId: task.id, event: payload.event_name, mode: delivery.mode });
    }
    if (deleted) {
      if (!mapping) {
        const history = await this.listCompletedProjections(delivery.profile, task.id);
        // Todoist plan pruning arrives as an ordinary item:deleted webhook.
        // After seven full days historical events must never be deleted, even
        // when the maintenance worker has not yet retired COMPLETED_TASK.
        // Ambiguous recurrence history also fails safe when no live mapping
        // exists; it must not be interpreted as permission to erase history.
        if (lifecycle.reason === "deleted" && protectUnmappedCompletedHistory(history, Number.isFinite(Date.parse(delivery.receivedAt)) ? Date.parse(delivery.receivedAt) : Date.now())) {
          return this.state.audit(delivery.profile, "todoist_late_completed_deletion_ignored", {
            taskId: task.id, retainedHistory: history.length,
          });
        }
        const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, task.id, calendar);
        if (!removedHistory) return;
        return this.state.audit(delivery.profile, "todoist_deleted_completed_calendar_history", { taskId: task.id, removedHistory });
      }
      if (mapping.recurrenceOwner === "calendar" && mapping.masterEventId && lifecycle.reason === "deleted") {
        await calendar.deleteEvent(mapping.masterEventId).catch((error: unknown) => {
          if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        });
        await this.state.deleteMapping(mapping);
        if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
        const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, task.id, calendar, mapping.masterEventId);
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "todoist_deleted_calendar_recurrence", { taskId: task.id, masterEventId: mapping.masterEventId, removedHistory });
      }
      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      await this.state.deleteCalendarProjectionTombstone(delivery.profile, task.id);
      const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, task.id, calendar, mapping.eventId);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, mapping.recurrenceOwner === "todoist" ? "todoist_deleted_calendar_recurrence_projection" : "todoist_deleted_calendar", { taskId: task.id, eventId: mapping.eventId, removedHistory });
    }
    let existingEvent: CalendarEvent | undefined;
    if (mapping) {
      try {
        existingEvent = await calendar.getEvent(mapping.eventId);
      } catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        mapping = undefined;
      }
    }
    if (!existingEvent && !cancelledCalendarLink) {
      const linkedEvent = await calendar.findByTodoistTaskId(task.id);
      if (linkedEvent?.status === "cancelled") {
        if (!readdingDue) {
          return this.state.audit(delivery.profile, "todoist_update_suppressed_cancelled_calendar", { taskId: task.id, event: payload.event_name });
        }
      } else {
        existingEvent = linkedEvent;
        if (linkedEvent) mapping = { profile: delivery.profile, eventId: linkedEvent.id, taskId: task.id, updatedAt: new Date().toISOString() };
      }
    }
    if (existingEvent?.status === "cancelled") {
      return this.state.audit(delivery.profile, "todoist_update_suppressed_cancelled_calendar", { taskId: task.id, event: payload.event_name });
    }
    if (await this.state.syncBlocked(delivery.profile, { taskId: task.id, eventId: existingEvent?.id || mapping?.eventId })) {
      return this.state.audit(delivery.profile, "todoist_pair_sync_control_blocked", { taskId: task.id, eventId: existingEvent?.id || mapping?.eventId });
    }

    const desiredRrule = todoistRecurrenceToRrule(task);
    const previousSeriesId = mapping?.recurrenceOwner === "todoist" ? mapping.seriesId : undefined;
    if (mapping?.recurrenceOwner === "todoist" && existingEvent?.recurrence?.length && !desiredRrule) {
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      await calendar.deleteEvent(existingEvent.id).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      mapping = undefined;
      existingEvent = undefined;
    }

    if (!recurringDateEdit && mapping?.recurrenceOwner === "todoist" && mapping.masterEventId && existingEvent?.recurrence?.length && desiredRrule) {
      const instances = await calendar.listInstances(existingEvent.id);
      const mappedActive = mapping.activeInstanceId
        ? instances.find((instance) => instance.id === mapping!.activeInstanceId && instance.status !== "cancelled")
        : undefined;
      const active = mappedActive && occurrenceStateMatches(mappedActive, task)
        ? mappedActive
        : selectTodoistCurrentInstance(instances, task);
      if (active && occurrenceStateMatches(active, task) && calendarRecurrenceMatchesTodoist(existingEvent, task) && recurrenceAnchorMatches(existingEvent)) {
        const nextMapping = todoistOwnedMapping(mapping, existingEvent.id, task.id, active);
        await this.state.putMapping(nextMapping);
        await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
        return this.state.audit(delivery.profile, "todoist_recurrence_active_instance_noop", { taskId: task.id, eventId: existingEvent.id, activeInstanceId: active.id });
      }
    }

    if (!recurringDateEdit && existingEvent && hasCanonicalState(existingEvent, task)) {
      const todoistRecurring = Boolean(task.due?.is_recurring);
      const todoistRrule = Boolean(desiredRrule && existingEvent.recurrence?.length);
      // A Calendar-owned recurrence may be echoed back by Todoist with an
      // ending-only recurrence phrase that we cannot convert to an RRULE.
      // Preserve its verified master link instead of transferring ownership
      // merely because Todoist marks the due date as recurring.
      const preservedCalendarMapping = mapping?.recurrenceOwner === "calendar" && mapping.masterEventId ? mapping : undefined;
      let active: CalendarEvent | undefined;
      if (todoistRrule) {
        const instances = await calendar.listInstances(existingEvent.id);
        const mappedActive = mapping?.activeInstanceId
          ? instances.find((instance) => instance.id === mapping!.activeInstanceId && instance.status !== "cancelled")
          : undefined;
        active = mappedActive && occurrenceStateMatches(mappedActive, task)
          ? mappedActive
          : selectTodoistCurrentInstance(instances, task);
      }
      const nextMapping: Mapping = {
        ...(preservedCalendarMapping || {}),
        profile: delivery.profile,
        eventId: existingEvent.id,
        taskId: task.id,
        projectId: task.project_id || mapping?.projectId,
        projectCommentId: mapping?.projectCommentId,
        taskCommentId: mapping?.taskCommentId,
        commentId: mapping?.commentId,
        mappingRevision: mapping?.mappingRevision,
        recurrenceId: existingEvent.recurringEventId,
        recurrenceOwner: preservedCalendarMapping ? "calendar" : todoistRecurring ? "todoist" : undefined,
        seriesId: preservedCalendarMapping ? preservedCalendarMapping.seriesId : todoistRecurring ? task.id : undefined,
        masterEventId: preservedCalendarMapping ? preservedCalendarMapping.masterEventId : todoistRrule ? existingEvent.id : undefined,
        activeInstanceId: preservedCalendarMapping ? preservedCalendarMapping.activeInstanceId : todoistRrule ? active?.id : todoistRecurring ? existingEvent.id : undefined,
        originalStart: preservedCalendarMapping ? preservedCalendarMapping.originalStart : todoistRrule ? (active ? eventStart(active) : mapping?.originalStart) : todoistRecurring ? eventStart(existingEvent) : undefined,
        activeEffectiveStart: preservedCalendarMapping ? preservedCalendarMapping.activeEffectiveStart : todoistRrule ? (active ? eventEffectiveStart(active) : mapping?.activeEffectiveStart) : todoistRecurring ? eventEffectiveStart(existingEvent) : undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.state.putMapping(nextMapping);
      if (todoistRecurring && !preservedCalendarMapping) await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
      else if (previousSeriesId) await this.state.deleteRecurrenceLink(delivery.profile, previousSeriesId);
      const completedProjection = await this.getCompletedProjection(delivery.profile, existingEvent.id);
      if (completedProjection?.taskId === task.id) await this.deleteCompletedProjection(completedProjection);
      return this.state.audit(delivery.profile, "todoist_noop_canonical_state", { taskId: task.id, eventId: existingEvent.id });
    }
    const event = toCalendarEvent(task, existingEvent, !recurringDateEdit);
    const stored = await calendar.upsertEvent(event, existingEvent?.id || mapping?.eventId);
    const todoistRecurring = Boolean(task.due?.is_recurring);
    const todoistRrule = Boolean(desiredRrule && stored.recurrence?.length);
    let active: CalendarEvent | undefined;
    if (todoistRrule) {
      const instances = await calendar.listInstances(stored.id);
      const mappedActive = mapping?.activeInstanceId
        ? instances.find((instance) => instance.id === mapping!.activeInstanceId && instance.status !== "cancelled")
        : undefined;
      active = mappedActive && occurrenceStateMatches(mappedActive, task)
        ? mappedActive
        : selectTodoistCurrentInstance(instances, task);
    }
    const nextMapping: Mapping = {
      profile: delivery.profile,
      eventId: stored.id,
      taskId: task.id,
      projectId: task.project_id || mapping?.projectId,
      projectCommentId: mapping?.projectCommentId,
      taskCommentId: mapping?.taskCommentId,
      commentId: mapping?.commentId,
      mappingRevision: mapping?.mappingRevision,
      recurrenceId: stored.recurringEventId,
      recurrenceOwner: todoistRecurring ? "todoist" : undefined,
      seriesId: todoistRecurring ? task.id : undefined,
      masterEventId: todoistRrule ? stored.id : undefined,
      activeInstanceId: todoistRrule ? active?.id : todoistRecurring ? stored.id : undefined,
      originalStart: todoistRrule ? (active ? eventStart(active) : eventStart(stored)) : todoistRecurring ? eventStart(stored) : undefined,
      activeEffectiveStart: todoistRrule ? (active ? eventEffectiveStart(active) : undefined) : todoistRecurring ? eventEffectiveStart(stored) : undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.state.putMapping(nextMapping);
    if (todoistRecurring) await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
    else if (previousSeriesId) await this.state.deleteRecurrenceLink(delivery.profile, previousSeriesId);
    const completedProjection = await this.getCompletedProjection(delivery.profile, stored.id);
    if (completedProjection?.taskId === task.id) await this.deleteCompletedProjection(completedProjection);
    if (projectionTombstone) await this.state.deleteCalendarProjectionTombstone(delivery.profile, task.id);
    await this.state.recordRecurrence(delivery.profile, stored.id, stored.recurrence);
    await this.state.recordMutation(delivery.profile);
    await this.state.audit(delivery.profile, mapping ? "todoist_updated_calendar" : "todoist_created_calendar", {
      taskId: task.id,
      eventId: stored.id,
      recurrenceProjection: todoistRrule ? "rrule" : todoistRecurring ? "rolling" : "none",
      activeInstanceId: active?.id,
      recurrenceReanchored: recurringDateEdit && todoistRrule,
    });
  }

  private async processOrphan(delivery: Delivery): Promise<void> {
    const orphan = delivery.orphan;
    if (!orphan) return;
    const completedProjection = await this.getCompletedProjection(delivery.profile, orphan.eventId);
    if (completedProjection) {
      return this.state.audit(delivery.profile, "orphan_completed_projection_retained", { ...orphan, completedAt: completedProjection.completedAt });
    }
    const { calendar, todoist } = await this.clients(delivery.profile);
    try {
      await todoist.getTask(orphan.taskId);
      return this.state.audit(delivery.profile, "orphan_recheck_recovered", orphan);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    const mapping = await this.state.getMappingByEvent(delivery.profile, orphan.eventId);
    if (!mapping || mapping.taskId !== orphan.taskId) {
      await this.state.audit(delivery.profile, "orphan_recheck_mapping_changed", {
        ...orphan,
        mappedTaskId: mapping?.taskId,
      });
      return;
    }

    let alreadyDeleted = false;
    try {
      await calendar.deleteEvent(orphan.eventId);
    } catch (error) {
      if (calendarResourceAlreadyDeleted(error)) {
        alreadyDeleted = true;
      } else {
        // An unclassified 410 on DELETE is not by itself proof of deletion.
        // Read exactly this event: 404, a deleted/cancelled resource, or 410
        // from events.get confirms it is gone without replaying a mutation.
        if (Number((error as { status?: number }).status) !== 410) throw error;
        let existing: CalendarEvent | undefined;
        try {
          existing = await calendar.getEvent(orphan.eventId);
        } catch (readError) {
          if (!calendarEventGoneOnDirectRead(readError)) throw readError;
          alreadyDeleted = true;
        }
        // A still-live event (or any other unexpected state) must not have
        // its mapping silently discarded; quarantine it for operator review.
        if (existing?.status === "cancelled") alreadyDeleted = true;
        else if (existing) throw error;
      }
    }
    await this.state.deleteMapping(mapping);
    await this.state.audit(delivery.profile, "orphan_confirmed_deleted", {
      ...orphan,
      alreadyDeleted,
    });
  }
}
