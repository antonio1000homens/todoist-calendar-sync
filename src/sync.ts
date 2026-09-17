import { profiles, googleCredentials, todoistToken } from "./config.js";
import { GoogleCalendar, Todoist } from "./providers.js";
import { StateRepository } from "./repository.js";
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
import type { CalendarEvent, Delivery, Mapping, Profile, RecurrenceLink, TodoistTask, TodoistWebhookPayload } from "./types.js";

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

function startsMatch(event: CalendarEvent, task: TodoistTask): boolean {
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

function occurrenceStateMatches(event: CalendarEvent, task: TodoistTask): boolean {
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
  const taskEnd = isAllDay
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

export function calendarOccurrenceHasEnded(event: CalendarEvent, now = Date.now()): boolean {
  if (event.status === "cancelled") return true;
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

function nextActiveInstance(instances: CalendarEvent[], after?: string, now = Date.now()): CalendarEvent | undefined {
  return instances
    .filter((event) => event.status !== "cancelled" && Boolean(eventStart(event)))
    .filter((event) => !calendarOccurrenceHasEnded(event, now))
    .filter((event) => !after || logicalStartAfter(eventStart(event) || "", after))
    .sort((a, b) => compareLogicalStarts(eventStart(a) || "", eventStart(b) || ""))[0];
}

export function selectCalendarRecurrenceInstance(
  instances: CalendarEvent[],
  existing?: Pick<RecurrenceLink, "activeInstanceId" | "originalStart" | "calendarProgressVersion" | "completedThroughOriginalStart">,
  now = Date.now(),
): CalendarEvent | undefined {
  if (existing?.calendarProgressVersion === 1) {
    return nextActiveInstance(instances, existing.completedThroughOriginalStart, now);
  }
  if (existing?.activeInstanceId) {
    const current = instances.find((event) => event.id === existing.activeInstanceId);
    if (current && current.status !== "cancelled" && !calendarOccurrenceHasEnded(current, now)) return current;
  }
  return nextActiveInstance(instances, existing?.originalStart, now);
}

export function suppressedLegacyCalendarRecurrenceCandidate(
  instances: CalendarEvent[],
  existing?: Pick<RecurrenceLink, "activeInstanceId" | "originalStart" | "calendarProgressVersion">,
  now = Date.now(),
): CalendarEvent | undefined {
  if (!existing?.activeInstanceId || existing.calendarProgressVersion === 1) return undefined;
  const current = instances.find((event) => event.id === existing.activeInstanceId);
  if (!current || current.status === "cancelled" || calendarOccurrenceHasEnded(current, now)) return undefined;
  const earliest = nextActiveInstance(instances, undefined, now);
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

type TodoistCalendarAction = "upsert" | "delete_projection" | "skip";

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
  if (completed) return { action: "delete_projection", reason: "completed", dueAdded: false };
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
    ...(link.owner === "calendar" && link.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
    ...(link.owner === "calendar" && link.completedThroughOriginalStart ? { completedThroughOriginalStart: link.completedThroughOriginalStart } : {}),
    updatedAt: link.updatedAt,
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
      const instances = await calendar.listInstances(link.masterEventId);
      const suppressed = suppressedLegacyCalendarRecurrenceCandidate(instances, link);
      if (suppressed) {
        await this.state.audit(profile, "calendar_recurrence_backward_shift_suppressed_legacy_state", {
          seriesId: link.seriesId,
          currentInstanceId: link.activeInstanceId,
          candidateInstanceId: suppressed.id,
          taskId: link.taskId,
        });
      }
      const active = selectCalendarRecurrenceInstance(instances, link);
      if (!active || active.id === link.activeInstanceId) continue;
      const progressAware = link.calendarProgressVersion === 1;
      let task: TodoistTask | undefined;
      if (progressAware) {
        try { task = await todoist.getTask(link.taskId); } catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
      }
      await this.state.deleteMapping(recurrenceMapping(link));
      if (!progressAware) {
        await todoist.deleteTask(link.taskId).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
      }
      const nextTask = await todoist.upsertTask(toTodoistTask(active), progressAware ? task?.id : undefined);
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
    for (const event of delta.items) await this.applyCalendarEvent(delivery, event, todoist);
    if (delta.nextSyncToken) await this.state.putSyncToken(delivery.profile, delta.nextSyncToken);
    await this.state.audit(delivery.profile, "calendar_delta_processed", { deliveryId: delivery.id, count: delta.items.length, mode: delivery.mode });
  }

  private async applyCalendarEvent(delivery: Delivery, event: CalendarEvent, todoist: Todoist): Promise<void> {
    let mapping = await this.state.getMappingByEvent(delivery.profile, event.id);
    let parentMapping = event.recurringEventId
      ? await this.state.getMappingByEvent(delivery.profile, event.recurringEventId)
      : undefined;
    const linkedTaskId = event.extendedProperties?.shared?.taskId;
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
        const result = await this.bindTodoistOwnedOccurrence(delivery.profile, parentMapping, task, next, todoist);
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_instance_deleted_skipped", {
          taskId: task.id,
          deletedEventId: event.id,
          nextEventId: next.id,
          nextOriginalStart: result.mapping.originalStart,
          nextEffectiveStart: result.mapping.activeEffectiveStart,
        });
      }
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

      const series = event.iCalUID || event.recurringEventId || event.id;
      const existingRecurrence = await this.state.getRecurrenceLink(delivery.profile, series);
      if (existingRecurrence?.owner === "calendar" && existingRecurrence.masterEventId) {
        if (
          event.recurringEventId
          && existingRecurrence.activeInstanceId
          && event.id !== existingRecurrence.activeInstanceId
        ) {
          return this.state.audit(
            delivery.profile,
            "calendar_recurrence_stale_instance_cancellation_ignored",
            {
              seriesId: series,
              eventId: event.id,
              activeInstanceId: existingRecurrence.activeInstanceId,
            },
          );
        }
        if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
          return this.state.audit(delivery.profile, "calendar_recurrence_delete_suppressed", { seriesId: series, mode: delivery.mode });
        }
        const oldMapping = recurrenceMapping(existingRecurrence);
        await this.state.deleteMapping(oldMapping);
        await todoist.deleteTask(existingRecurrence.taskId).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
        if (!event.recurringEventId && event.id === existingRecurrence.masterEventId) {
          await this.state.deleteRecurrenceLink(delivery.profile, series);
          await this.state.recordMutation(delivery.profile);
          return this.state.audit(delivery.profile, "calendar_recurrence_master_deleted", { seriesId: series });
        }
        const { calendar } = await this.clients(delivery.profile);
        const next = selectCalendarRecurrenceInstance(await calendar.listInstances(existingRecurrence.masterEventId), existingRecurrence);
        if (!next) return this.state.audit(delivery.profile, "calendar_recurrence_instance_deleted_no_next", { seriesId: series });
        const nextTask = await todoist.upsertTask(toTodoistTask(next));
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
      if (!mapping) return;
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) return this.state.audit(delivery.profile, "calendar_delete_suppressed", { eventId: event.id, mode: delivery.mode });
      try {
        await todoist.deleteTask(mapping.taskId);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        await this.scheduleOrphan?.(delivery, event.id, mapping.taskId);
        return this.state.audit(delivery.profile, "calendar_orphan_recheck_scheduled", { eventId: event.id, taskId: mapping.taskId });
      }
      if (mapping.commentId) await todoist.deleteComment(mapping.commentId).catch(() => undefined);
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
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "calendar_mutation_suppressed", { eventId: event.id, taskId: task?.id, mode: delivery.mode });
    }
    if (task && hasCanonicalState(event, task)) {
      const nextMapping: Mapping = {
        profile: delivery.profile,
        eventId: event.id,
        taskId: task.id,
        commentId: mapping?.commentId,
        updatedAt: new Date().toISOString(),
      };
      await this.state.putMapping(nextMapping);
      return this.state.audit(delivery.profile, "calendar_noop_canonical_state", { eventId: event.id, taskId: task.id });
    }
    const nextTask = await todoist.upsertTask(toTodoistTask(event), task?.id);
    const existingComment = mapping?.commentId ? { id: mapping.commentId } : await todoist.findComment(nextTask.id, event.id);
    const comment = await todoist.upsertComment(nextTask.id, taskComment(event), existingComment?.id);
    const nextMapping: Mapping = { profile: delivery.profile, eventId: event.id, taskId: nextTask.id, commentId: comment.id, updatedAt: new Date().toISOString() };
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
    const seriesId = master.iCalUID || master.id;
    const existing = await this.state.getRecurrenceLink(delivery.profile, seriesId);
    const instances = await calendar.listInstances(master.id);
    const suppressed = suppressedLegacyCalendarRecurrenceCandidate(instances, existing);
    if (suppressed && existing) {
      await this.state.audit(delivery.profile, "calendar_recurrence_backward_shift_suppressed_legacy_state", {
        seriesId,
        currentInstanceId: existing.activeInstanceId,
        candidateInstanceId: suppressed.id,
        taskId: existing.taskId,
      });
    }
    const active = selectCalendarRecurrenceInstance(instances, existing);
    if (!active) return this.state.audit(delivery.profile, "calendar_recurrence_no_active_instance", { seriesId, masterEventId: master.id });
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "calendar_recurrence_mutation_suppressed", { seriesId, mode: delivery.mode });
    }
    const progressAware = existing?.calendarProgressVersion === 1;
    let task: TodoistTask | undefined;
    if (existing?.taskId && (existing.activeInstanceId === active.id || progressAware)) {
      try { task = await todoist.getTask(existing.taskId); } catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
    }
    if (task && existing?.activeInstanceId === active.id && hasCanonicalState(active, task)) {
      return this.state.audit(delivery.profile, "calendar_recurrence_noop_active_instance", { seriesId, eventId: active.id, taskId: task.id });
    }
    if (existing?.taskId && (!task || existing.activeInstanceId !== active.id)) {
      await this.state.deleteMapping(recurrenceMapping(existing));
      if (existing.activeInstanceId !== active.id && !progressAware) {
        await todoist.deleteTask(existing.taskId).catch((error: unknown) => { if (Number((error as { status?: number }).status) !== 404) throw error; });
      }
    }
    const nextTask = await todoist.upsertTask(toTodoistTask(active), task?.id);
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

  private async processTodoist(delivery: Delivery): Promise<void> {
    const payload = JSON.parse(delivery.body) as TodoistWebhookPayload;
    const task = payload.event_data;
    const lifecycle = todoistCalendarLifecycle(payload);
    if (!task?.id || !lifecycle) return;
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
    if (lifecycle.reason === "completed" && mapping?.recurrenceOwner === "calendar" && mapping.masterEventId) {
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
      // Persist the completion boundary before mutating Calendar or binding a
      // successor. A retry can then never roll the logical series backwards.
      await this.state.putMapping(progressMapping);
      if (progressMapping.seriesId) await this.state.putRecurrenceLink(recurrenceLink(progressMapping, "calendar"));

      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      const instances = await calendar.listInstances(mapping.masterEventId);
      const next = progressMapping.calendarProgressVersion === 1
        ? nextActiveInstance(instances, progressMapping.completedThroughOriginalStart)
        : nextActiveInstance(instances, mapping.originalStart);
      if (!next) {
        await this.state.deleteMapping(progressMapping);
        return this.state.audit(delivery.profile, "calendar_recurrence_completed_no_next", { seriesId: mapping.seriesId, taskId: task.id });
      }
      const nextTask = await todoist.upsertTask(toTodoistTask(next));
      const nextMapping: Mapping = {
        profile: delivery.profile,
        eventId: next.id,
        taskId: nextTask.id,
        recurrenceOwner: "calendar",
        seriesId: mapping.seriesId,
        masterEventId: mapping.masterEventId,
        activeInstanceId: next.id,
        originalStart: eventStart(next),
        activeEffectiveStart: eventEffectiveStart(next),
        ...(progressMapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
        ...(completedThroughOriginalStart ? { completedThroughOriginalStart } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.state.deleteMapping(progressMapping);
      await this.state.putMapping(nextMapping);
      await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "calendar"));
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
        let completed = mapping.activeInstanceId
          ? instances.find((instance) => instance.id === mapping!.activeInstanceId)
          : undefined;
        if (!completed) {
          const previousTask = payload.event_data_extra?.old_item || task;
          completed = selectTodoistCurrentInstance(instances, previousTask);
        }
        const next = selectNextEffectiveTodoistInstance(
          instances,
          completed?.id || mapping.activeInstanceId,
          mapping.activeEffectiveStart || (completed ? eventEffectiveStart(completed) : undefined) || mapping.originalStart,
        );
        if (!next) {
          return this.state.audit(delivery.profile, "todoist_recurrence_completed_calendar_series_no_next", { taskId: task.id, eventId: mappedEvent.id });
        }
        const result = await this.bindTodoistOwnedOccurrence(delivery.profile, mapping, current, next, todoist);
        return this.state.audit(delivery.profile, "todoist_recurrence_completed_advanced_to_effective_instance", {
          taskId: task.id,
          masterEventId: mappedEvent.id,
          completedEventId: completed?.id || mapping.activeInstanceId,
          nextEventId: next.id,
          nextOriginalStart: result.mapping.originalStart,
          nextEffectiveStart: result.mapping.activeEffectiveStart,
        });
      }

      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      if (!current?.due || !current.due.is_recurring) {
        await this.state.recordMutation(delivery.profile);
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
      if (mapping.commentId) await todoist.deleteComment(mapping.commentId).catch(() => undefined);
      await this.state.putCalendarProjectionTombstone(delivery.profile, task.id, task.updated_at || delivery.receivedAt);
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, "todoist_due_removed_calendar", { taskId: task.id, eventId: mapping.eventId });
    }

    let cancelledCalendarLink = false;
    if (!mapping) {
      const linkedEvent = await calendar.findByTodoistTaskId(task.id);
      if (linkedEvent?.status === "cancelled") {
        cancelledCalendarLink = true;
      } else if (linkedEvent) {
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
      if (!mapping) return;
      if (mapping.recurrenceOwner === "calendar" && mapping.masterEventId && lifecycle.reason === "deleted") {
        await calendar.deleteEvent(mapping.masterEventId).catch((error: unknown) => {
          if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        });
        await this.state.deleteMapping(mapping);
        if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "todoist_deleted_calendar_recurrence", { taskId: task.id, masterEventId: mapping.masterEventId });
      }
      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      await this.state.deleteMapping(mapping);
      if (mapping.seriesId) await this.state.deleteRecurrenceLink(delivery.profile, mapping.seriesId);
      await this.state.deleteCalendarProjectionTombstone(delivery.profile, task.id);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, mapping.recurrenceOwner === "todoist" ? "todoist_deleted_calendar_recurrence_projection" : "todoist_deleted_calendar", { taskId: task.id, eventId: mapping.eventId });
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
        profile: delivery.profile,
        eventId: existingEvent.id,
        taskId: task.id,
        commentId: mapping?.commentId,
        recurrenceId: existingEvent.recurringEventId,
        recurrenceOwner: todoistRecurring ? "todoist" : undefined,
        seriesId: todoistRecurring ? task.id : undefined,
        masterEventId: todoistRrule ? existingEvent.id : undefined,
        activeInstanceId: todoistRrule ? active?.id : todoistRecurring ? existingEvent.id : undefined,
        originalStart: todoistRrule ? (active ? eventStart(active) : mapping?.originalStart) : todoistRecurring ? eventStart(existingEvent) : undefined,
        activeEffectiveStart: todoistRrule ? (active ? eventEffectiveStart(active) : mapping?.activeEffectiveStart) : todoistRecurring ? eventEffectiveStart(existingEvent) : undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.state.putMapping(nextMapping);
      if (todoistRecurring) await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
      else if (previousSeriesId) await this.state.deleteRecurrenceLink(delivery.profile, previousSeriesId);
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
      commentId: mapping?.commentId,
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
    const { calendar, todoist } = await this.clients(delivery.profile);
    try {
      await todoist.getTask(orphan.taskId);
      return this.state.audit(delivery.profile, "orphan_recheck_recovered", orphan);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    const mapping = await this.state.getMappingByEvent(delivery.profile, orphan.eventId);
    if (!mapping || mapping.taskId !== orphan.taskId) return;
    await calendar.deleteEvent(orphan.eventId).catch((error: unknown) => { if ((error as { status?: number }).status !== 404) throw error; });
    await this.state.deleteMapping(mapping);
    await this.state.audit(delivery.profile, "orphan_confirmed_deleted", orphan);
  }
}
