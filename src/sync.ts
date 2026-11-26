import {defaultProviderClientFactory} from "./mutation-budget.js";
import { createHash } from "node:crypto";
import {calendarReplaySourceIds} from "./calendar-provenance.js";
import { profileForTodoistProject, profiles, googleCredentials, todoistToken } from "./config.js";
import { otherProfileCalendarOrganizer } from "./calendar-profile-ownership.js";
import { attachProjectCommentReference, buildProjectMappingIndex,
  deleteExactTaskProjectMappingComments, deleteMappingComments, mappingFromProjectMappingComment,
  upsertProjectMappingComment, serializeMappingComment } from "./mapping-comments.js";
import { GoogleCalendar, Todoist, withTodoistInventoryScope } from "./providers.js";
import { StateRepository } from "./repository.js";
import { ReconciliationItemError } from "./reconciliation-diagnostics.js";
import { normalizedDescription, normalizedStart, normalizedText } from "./security.js";
import {
  calendarRecurrenceMatchesTodoist,
  isTodoistOwnedCalendarRecurrence,
  recurrenceEffectiveStart,
  recurrenceOriginalStart,
  normalizedRecurrenceRule,
  selectNextEffectiveTodoistInstance,
  selectTodoistCurrentInstance,
  todoistRecurrenceKey,
  todoistRecurrenceToRrule,
} from "./todoist-recurrence.js";
import { protectUnmappedCompletedHistory } from "./completed-history-policy.js";
import { providerRecurrenceChanges, providerSyncBaseline } from "./provider-sync-baseline.js";
import { attemptCancelledAnnualRecovery } from "./cancelled-annual-recovery.js";
import { recoveryPolicyForTask, recoveryReceiptMatchesTask, recoverySourceFingerprint } from "./cancelled-mapping-recovery-policy.js";
import { todoistPhaseBCandidate } from "./todoist-calendar-phase-b.js";
import { admitNewTodoistPhaseBNative, verifyInitialPhaseBCalendarWrite } from "./todoist-phase-b-native-admission.js";
import { SafeProviderReplayError } from "./safe-provider-replay.js";
import { calendarPhaseCCandidate, matchesCalendarPhaseCTask } from "./calendar-todoist-phase-c.js";
import {
  calendarOwnedRecurringTaskPayload,
  calendarOwnedRecurringTaskReadback,
  calendarOwnedTodoistRecurrence,
  type CalendarOwnedTodoistRecurrence,
  verifiedCalendarOwnedRecurrence,
  finiteWeeklyCalendarRuleCandidate,
  nativeCalendarRecurrenceCandidate,
  isPhaseCNativeCandidate,
  matchesCalendarOwnedRecurringRule,
  matchesCalendarOwnedRecurringTask,
  resolveCalendarTimeZone,
} from "./calendar-owned-todoist-recurrence.js";
import type { CalendarEvent, CompletedCalendarProjection, Delivery, Mapping, Profile, RecurrenceLink,
  RecurrenceReconciliationOutcome, RecurrenceReconciliationSummary, TodoistTask, TodoistWebhookPayload } from "./types.js";

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

export interface CompatibleTodoistCalendarCandidate {
  task: TodoistTask;
  event: CalendarEvent;
}

/** Match a Calendar series to an existing Todoist recurring task without
 * requiring machine correlation metadata. Search each candidate's due window
 * so the master's historical DTSTART is never compared with current progress. */
export async function discoverCompatibleTodoistRecurringCandidatesForCalendar(
  master: CalendarEvent,
  recurrence: CalendarOwnedTodoistRecurrence,
  timeZone: string | undefined,
  tasks: TodoistTask[],
  profile: Profile,
  calendar: GoogleCalendar,
): Promise<CompatibleTodoistCalendarCandidate[]> {
  const candidates: CompatibleTodoistCalendarCandidate[] = [];
  const potential = tasks.filter(task => task.project_id === profiles[profile].todoistProjectId
    && !task.is_deleted && !task.is_completed && !task.completed_at && task.due?.is_recurring
    && normalizedText(task.content).length > 0);
  for (const task of potential) {
    const due = taskDateTime(task) || task.due?.date;
    if (!due || !matchesCalendarOwnedRecurringRule(task, recurrence, timeZone)) continue;
    const instances = await listBoundedRecurrenceInstances(calendar, master.id, due);
    for (const listed of instances) {
      if (listed.status === "cancelled" || listed.recurringEventId !== master.id || !startsMatch(listed, task)) continue;
      const event = await calendar.getEvent(listed.id);
      if (event.status !== "cancelled" && event.recurringEventId === master.id
        && recurrenceOriginalStart(event) === recurrenceOriginalStart(listed)
        && normalizedText(task.content).toLocaleLowerCase() === normalizedText(event.summary).toLocaleLowerCase()
        && normalizedDescription(task.description) === normalizedDescription(event.description)
        && matchesCalendarOwnedRecurringTask(task, event, recurrence, timeZone)) {
        candidates.push({ task, event });
      }
    }
  }
  return candidates;
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

function boundedRecurrenceWindow(anchor: string | undefined, nowMs = Date.now()): { start: string; end: string } | undefined {
  const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
  const pivot = Number.isFinite(anchorMs) ? anchorMs : nowMs;
  return Number.isFinite(pivot) && Number.isFinite(nowMs)
    ? {
      start: new Date(pivot - 24 * 60 * 60_000).toISOString(),
      end: new Date(Math.max(pivot, nowMs) + 3 * 366 * 24 * 60 * 60_000).toISOString(),
    }
    : undefined;
}

async function listBoundedRecurrenceInstances(
  calendar: GoogleCalendar,
  masterId: string,
  anchor: string | undefined,
): Promise<CalendarEvent[]> {
  const window = boundedRecurrenceWindow(anchor);
  if (!window) throw new Error(`Unable to establish bounded recurrence window for ${masterId}`);
  return calendar.listInstancesInWindow(masterId, window.start, window.end);
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

export interface CompatibleCalendarCandidate {
  /** Calendar master for a series, or the standalone event for a one-off. */
  master: CalendarEvent;
  /** The exact standalone event or active recurrence instance representing the task. */
  event: CalendarEvent;
}

/** Return conflicting identities present in either provider's correlation
 * metadata, including aliases for the series master and active instance. */
export function compatibleCalendarCandidateOwnerConflicts(
  candidate: CompatibleCalendarCandidate,
  mappings: Mapping[],
  taskId: string,
  profile: Profile,
): string[] {
  const events = [...new Map([candidate.master, candidate.event].map(event => [event.id, event])).values()];
  const ids = new Set(events.map(event => event.id));
  const owners = new Set(mappings.filter(mapping => mapping.taskId !== taskId
    && [mapping.eventId, mapping.masterEventId, mapping.activeInstanceId]
      .some(id => Boolean(id && ids.has(id)))).map(mapping => mapping.taskId));
  for (const event of events) {
    const shared = event.extendedProperties?.shared || {};
    for (const id of [shared.taskId, shared.syncTaskId]) if (id && id !== taskId) owners.add(id);
    if (shared.syncProfile && shared.syncProfile !== profile) owners.add(`profile:${shared.syncProfile}`);
    if (shared.syncCalendarId && shared.syncCalendarId !== profiles[profile].calendarId) owners.add(`calendar:${shared.syncCalendarId}`);
  }
  return [...owners].sort();
}

function candidateTextMatches(event: CalendarEvent, task: TodoistTask): boolean {
  return event.status !== "cancelled"
    && normalizedText(event.summary).toLocaleLowerCase() === normalizedText(task.content).toLocaleLowerCase()
    && normalizedDescription(event.description) === normalizedDescription(task.description);
}

/** Discover an unlinked counterpart using portable content and recurrence
 * semantics. This is intentionally separate from hasCanonicalState: linked
 * pairs may use machine baselines, while recovery must work before those
 * properties exist. Every inventory candidate is re-read before it is
 * returned, and incomplete provider reads throw so callers cannot create a
 * duplicate after an uncertain search. */
export async function discoverCompatibleCalendarCandidates(
  task: TodoistTask,
  inventory: CalendarEvent[],
  calendar: GoogleCalendar,
): Promise<CompatibleCalendarCandidate[]> {
  if (!task.due?.is_recurring) {
    const potential = inventory.filter(event => event.status !== "cancelled"
      && !event.recurrence?.length && !event.recurringEventId
      && !event.extendedProperties?.shared?.todoistRecurrence
      && candidateTextMatches(event, task) && startsMatch(event, task));
    const matches: CompatibleCalendarCandidate[] = [];
    for (const listed of potential) {
      const live = await calendar.getEvent(listed.id);
      if (live.status !== "cancelled" && !live.recurrence?.length && !live.recurringEventId
        && !live.extendedProperties?.shared?.todoistRecurrence
        && candidateTextMatches(live, task) && startsMatch(live, task)) {
        matches.push({ master: live, event: live });
      }
    }
    return matches;
  }

  const expectedRule = normalizedRecurrenceRule(todoistRecurrenceToRrule(task));
  if (!expectedRule) return [];
  const recurrenceKey = todoistRecurrenceKey(task);
  const potentialMasters = inventory.filter(master => master.status !== "cancelled"
    && !master.recurringEventId && Boolean(master.recurrence?.length)
    && master.recurrence!.some(rule => normalizedRecurrenceRule(rule) === expectedRule)
    && (!master.extendedProperties?.shared?.todoistRecurrence
      || master.extendedProperties.shared.todoistRecurrence === recurrenceKey));
  const matches: CompatibleCalendarCandidate[] = [];
  for (const listedMaster of potentialMasters) {
    const master = await calendar.getEvent(listedMaster.id);
    if (master.status === "cancelled" || master.recurringEventId || !master.recurrence?.length
      || !master.recurrence.some(rule => normalizedRecurrenceRule(rule) === expectedRule)
      || master.extendedProperties?.shared?.todoistRecurrence
        && master.extendedProperties.shared.todoistRecurrence !== recurrenceKey) continue;
    const instances = await listBoundedRecurrenceInstances(calendar, master.id,
      taskDateTime(task) || task.due?.date);
    const selected = selectTodoistCurrentInstance(instances, task);
    if (!selected || selected.status === "cancelled" || selected.recurringEventId !== master.id) continue;
    const event = await calendar.getEvent(selected.id);
    if (event.status === "cancelled" || event.recurringEventId !== master.id
      || recurrenceOriginalStart(event) !== recurrenceOriginalStart(selected)
      || !candidateTextMatches(event, task)) continue;
    matches.push({ master, event });
  }
  return matches;
}

/** Detect same-content objects that share the task's current occurrence but
 * fail the strict compatibility predicate. Such objects are conflicts, not
 * proof that a counterpart is absent, and must block automatic creation. */
export async function hasConflictingCalendarCandidate(
  task: TodoistTask,
  inventory: CalendarEvent[],
  calendar: GoogleCalendar,
): Promise<boolean> {
  const due = taskDateTime(task) || task.due?.date;
  if (!due) return false;
  const visitedMasters = new Set<string>();
  for (const listed of inventory) {
    if (listed.status === "cancelled") continue;
    if (!listed.recurrence?.length && !listed.recurringEventId) {
      if (!candidateTextMatches(listed, task)) continue;
      const live = await calendar.getEvent(listed.id);
      if (live.status !== "cancelled" && !live.recurrence?.length && !live.recurringEventId
        && candidateTextMatches(live, task) && startsMatch(live, task)) return true;
      continue;
    }
    const masterId = listed.recurringEventId || listed.id;
    if (visitedMasters.has(masterId)) continue;
    visitedMasters.add(masterId);
    const master = masterId === listed.id ? await calendar.getEvent(listed.id) : await calendar.getEvent(masterId);
    if (master.status === "cancelled" || master.recurringEventId || !master.recurrence?.length
      || (task.due?.is_recurring && !candidateTextMatches(master, task))) continue;
    const instances = await listBoundedRecurrenceInstances(calendar, master.id, due);
    const matchingInstances = instances.filter(instance => instance.status !== "cancelled"
      && instance.recurringEventId === master.id && startsMatch(instance, task));
    for (const instance of matchingInstances) {
      const live = await calendar.getEvent(instance.id);
      if (live.status !== "cancelled" && live.recurringEventId === master.id
        && candidateTextMatches(live, task) && startsMatch(live, task)) return true;
    }
  }
  return false;
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

function explicitExceptionFingerprint(events: CalendarEvent[]): string {
  return JSON.stringify(events.map(event => ({
    id: event.id,
    status: event.status,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime,
    start: event.start,
    end: event.end,
    summary: event.summary,
    description: event.description,
    etag: event.etag,
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

export function occurrenceStateMatches(event: CalendarEvent, task: TodoistTask): boolean {
  return event.status !== "cancelled"
    && normalizedText(event.summary) === normalizedText(task.content)
    && normalizedDescription(event.description) === normalizedDescription(task.description)
    && startsMatch(event, task);
}

export function compatibleTodoistOneOffCandidatesForCalendar(
  event: CalendarEvent,
  tasks: TodoistTask[],
  profile?: Profile,
): TodoistTask[] {
  if (event.status === "cancelled" || event.recurrence?.length || event.recurringEventId
    || !(event.start?.date || event.start?.dateTime)) return [];
  return tasks.filter(task => !task.is_deleted && !task.is_completed && !task.completed_at
    && (!profile || task.project_id === profiles[profile].todoistProjectId)
    && task.due && !task.due.is_recurring
    && normalizedText(task.content).toLocaleLowerCase() === normalizedText(event.summary).toLocaleLowerCase()
    && normalizedDescription(task.description) === normalizedDescription(event.description)
    && startsMatch(event, task));
}

export function matchingTask(event: CalendarEvent, tasks: TodoistTask[]): TodoistTask | undefined {
  if (!normalizedText(event.summary) || (!event.start?.date && !event.start?.dateTime)) return undefined;
  const candidates = compatibleTodoistOneOffCandidatesForCalendar(event, tasks);
  return candidates.length === 1 ? candidates[0] : undefined;
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
    description: normalizedDescription(event.description),
    due,
  };
}

/**
 * Phase B does not change the live Calendar projection policy. Add its read-only
 * candidate to existing audit records only, without additional provider calls,
 * DynamoDB writes or a new audit transaction.
 */
function phaseBProjectionPreview(task: TodoistTask, nativeRrule?: string): {
  phaseBFamily?: string;
  phaseBCandidateRrule?: string;
  phaseBReason?: string;
  phaseBDisposition?: string;
} {
  if (nativeRrule || !task.due?.is_recurring) return {};
  const result = todoistPhaseBCandidate(task);
  if (!result.family) return {};
  return {
    phaseBFamily: result.family,
    ...(result.candidateRrule ? { phaseBCandidateRrule: result.candidateRrule } : {}),
    phaseBReason: result.reason,
    phaseBDisposition: result.disposition,
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
    && existingShared?.todoistRecurrence === recurrenceKey
    && existingShared?.todoistAnchorStart
    && existingShared?.todoistAnchorEnd,
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
    description: normalizedDescription(task.description),
    start,
    end,
    recurrence: rrule ? [rrule]
      : (Boolean(existing?.recurrence?.length) || Boolean(existing && !existing.recurringEventId)) ? [] : undefined,
    extendedProperties: {
      shared: {
        taskId: task.id,
        taskUrl: task.url || `https://app.todoist.com/app/task/${task.id}`,
        originalSummary: normalizedText(task.content),
        // An ordinary Todoist edit must not sever the archived history.
        ...(existingShared?.syncHistoryMasterId ? {
          syncHistoryMasterId: existingShared.syncHistoryMasterId,
          ...(existingShared.syncHistoryCutoff ? { syncHistoryCutoff: existingShared.syncHistoryCutoff } : {}),
          ...(existingShared.syncSplitVersion ? { syncSplitVersion: existingShared.syncSplitVersion } : {}),
        } : {}),
        ...(rrule && recurrenceKey ? {
          todoistRecurrence: recurrenceKey,
          todoistAnchorStart: anchorStart,
          todoistAnchorEnd: anchorEnd,
          todoistAnchorAllDay: start.date ? "true" : "false",
          todoistAnchorTimeZone: start.timeZone || "",
          todoistTemplateSummary: normalizedText(task.content),
          todoistTemplateDescription: normalizedDescription(task.description),
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

/** Only confirmed, non-recurring events may bypass historical ownership reads.
 * A cancelled event, master or instance must still run the normal recovery path. */
export function ignorableElapsedStandaloneCalendarEvent(
  event: CalendarEvent, now = Date.now(), timeZone?: string,
): boolean {
  return event.status === "confirmed"
    && !event.recurringEventId
    && !event.recurrence?.length
    && calendarEventHasElapsed(event, now, timeZone);
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
    && normalizedText(event.summary).toLocaleLowerCase() === normalizedText(task.content).toLocaleLowerCase()
    && normalizedDescription(event.description) === normalizedDescription(task.description);
  if (!textMatches) return false;
  if (todoistRecurrenceToRrule(task)) {
    return calendarRecurrenceMatchesTodoist(event, task) && recurrenceAnchorMatches(event);
  }
  return startsMatch(event, task);
}

/** Compare only identity, lifecycle and fields the Calendar writer can change.
 * Provider bookkeeping, labels, priority and timestamps are not sync fields. */
export function sameCalendarDeltaTaskEvidence(before: TodoistTask, current: TodoistTask): boolean {
  const evidence = (task: TodoistTask) => [
    task.id, task.project_id, Boolean(task.is_deleted), Boolean(task.is_completed),
    task.completed_at || null, normalizedText(task.content), normalizedDescription(task.description),
    task.due?.date || null, task.due?.datetime || null, task.due?.timezone || null,
    Boolean(task.due?.is_recurring),
    task.due?.is_recurring ? task.due.string || null : null,
    task.due?.is_recurring ? task.due.lang || null : null,
  ];
  return JSON.stringify(evidence(before)) === JSON.stringify(evidence(current));
}

export async function verifyCalendarDeltaTaskUnchanged(todoist: Pick<Todoist, "getTask">, task: TodoistTask): Promise<void> {
  const changed = () => Object.assign(new Error("Todoist task changed before Calendar delta update"), {
    code: "calendar_delta_task_changed",
  });
  let current: TodoistTask;
  try { current = await todoist.getTask(task.id); }
  catch (error) {
    if (Number((error as {status?: number}).status) === 404) throw changed();
    throw error;
  }
  if (!sameCalendarDeltaTaskEvidence(task, current)) throw changed();
}

type TodoistCalendarAction = "upsert" | "delete_projection" | "complete_projection" | "skip";

export interface TodoistCalendarLifecycle {
  action: TodoistCalendarAction;
  reason: "deleted" | "completed" | "uncompleted" | "due_removed" | "undated" | "eligible";
  dueAdded: boolean;
}

export function todoistCalendarLifecycle(payload: TodoistWebhookPayload): TodoistCalendarLifecycle | undefined {
  const task = payload.event_data;
  if (!task?.id) return undefined;
  const eventName = payload.event_name || "";
  const oldTask = payload.event_data_extra?.old_item;
  const explicitlyDeleted = /deleted/i.test(eventName) || Boolean(task.is_deleted);
  const uncompleted = /uncompleted/i.test(eventName);
  const completed = !uncompleted && (/completed/i.test(eventName) || Boolean(task.is_completed));
  const hadDue = taskHasDue(oldTask);
  const hasDue = taskHasDue(task);
  const dueRemoved = hadDue && !oldTask?.due?.is_recurring && !hasDue;
  const dueAdded = !hadDue && hasDue;
  if (explicitlyDeleted) return { action: "delete_projection", reason: "deleted", dueAdded: false };
  if (completed) return { action: "complete_projection", reason: "completed", dueAdded: false };
  // Completing/uncompleting changes only the mapping's lifecycle, never
  // Calendar metadata or time. Subsequent edits can sync normally.
  if (uncompleted) return { action: "skip", reason: "uncompleted", dueAdded: false };
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
 * Resolve metadata per field against the last mirrored values. Independent
 * edits merge. For a same-field collision, provider timestamps select the
 * latest edit; equal or unavailable timestamps use Calendar as the stable tie-break.
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
  const calendarUpdatedAt = Date.parse(master.updated || "");
  const todoistUpdatedAt = Date.parse(task.updated_at || "");
  function field(initial: string | undefined, calendarValue: string, todoistValue: string): string {
    if (calendarValue === todoistValue) return calendarValue;
    if (initial === undefined) { todoistChanged = true; return calendarValue; }
    if (calendarValue === initial) { calendarChanged = true; return todoistValue; }
    if (todoistValue === initial) { todoistChanged = true; return calendarValue; }
    if (Number.isFinite(calendarUpdatedAt) && Number.isFinite(todoistUpdatedAt)
      && calendarUpdatedAt !== todoistUpdatedAt && todoistUpdatedAt > calendarUpdatedAt) {
      calendarChanged = true;
      return todoistValue;
    }
    todoistChanged = true;
    return calendarValue;
  }
  return {
    summary: field(baseline.syncedTitle, normalizedText(master.summary), normalizedText(task.content)),
    description: field(baseline.syncedDescription, normalizedDescription(master.description), normalizedDescription(task.description)),
    calendarChanged, todoistChanged, conflicts,
  };
}

function taskComment(event: CalendarEvent): string {
  return `todoist-calendar-sync\ncalendarEventId=${event.id}\ncalendarUrl=${event.htmlLink || ""}`;
}

function modeAllowsMutations(delivery: Delivery, allowed: boolean): boolean {
  return delivery.mode === "aws" && allowed;
}

function recurrenceLink(mapping: Mapping): RecurrenceLink {
  if (!mapping.seriesId) throw new Error("Recurring mapping is missing its logical series ID");
  const owner = mapping.seriesId === mapping.taskId ? "todoist" : "calendar";
  return {
    profile: mapping.profile, owner, seriesId: mapping.seriesId,
    masterEventId: mapping.masterEventId, activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart, activeEffectiveStart: mapping.activeEffectiveStart,
    ...(mapping.syncedTitle !== undefined ? { syncedTitle: mapping.syncedTitle } : {}),
    ...(mapping.syncedDescription !== undefined ? { syncedDescription: mapping.syncedDescription } : {}),
    ...(owner === "calendar" && mapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
    ...(owner === "calendar" && mapping.completedThroughOriginalStart
      ? { completedThroughOriginalStart: mapping.completedThroughOriginalStart } : {}),
    taskId: mapping.taskId, eventId: mapping.eventId, updatedAt: mapping.updatedAt,
  };
}

// Determine the provider-native recurrence shape from exact stable IDs. The
// project comment stores seriesId/taskId correlation and the Calendar master
// stores its exact Todoist task ID; normal routing does not depend on an owner
// label or on DynamoDB recurrence rows.
export function nativeRecurrenceShape(mapping: Mapping | undefined): "calendar" | "todoist" | undefined {
  if (!mapping?.seriesId) return undefined;
  // Calendar progress is explicit evidence that occurrence exceptions and
  // completion advancement are represented through Calendar instances. It
  // takes precedence over coincidentally equal provider IDs, so one mapping
  // can never enter both recurrence processing paths.
  if (mapping.calendarProgressVersion === 1) return "calendar";
  return mapping.seriesId === mapping.taskId ? "todoist" : "calendar";
}

function isTodoistNativeSeries(mapping: Mapping | undefined): mapping is Mapping {
  return nativeRecurrenceShape(mapping) === "todoist";
}

function isCalendarNativeSeries(mapping: Mapping | undefined): mapping is Mapping {
  return nativeRecurrenceShape(mapping) === "calendar";
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
    seriesId: taskId,
    masterEventId,
    activeInstanceId: active?.id,
    originalStart: active ? recurrenceOriginalStart(active) : mapping.originalStart,
    activeEffectiveStart: active ? eventEffectiveStart(active) : mapping.activeEffectiveStart,
    calendarProgressVersion: undefined,
    completedThroughOriginalStart: undefined,
    updatedAt: new Date().toISOString(),
  };
}

type ClientPair = { calendar: GoogleCalendar; todoist: Todoist };
type ClientFactory = (profile: Profile) => Promise<ClientPair>;

function todoistStandaloneCalendarEventId(profile: Profile, taskId: string): string {
  return createHash("sha256")
    .update(`todoist-standalone:${profile}:${taskId}`)
    .digest("hex").slice(0, 32);
}

export class Synchronizer {
  constructor(
    private readonly state = new StateRepository(),
    private readonly scheduleOrphan?: (delivery: Delivery, eventId: string, taskId: string) => Promise<void>,
    private readonly clientFactory?: ClientFactory,
    private readonly onCalendarItemCompleted?: (replayVerified: boolean) => void,
  ) {}

  private async clients(profile: Profile): Promise<ClientPair> {
    const clients = this.clientFactory
      ? await this.clientFactory(profile)
      : await defaultProviderClientFactory(profile);
    return clients;
  }

  async persistProviderMapping(mapping: Mapping, todoist?: Todoist): Promise<Mapping> {
    const projectId = mapping.projectId || profiles[mapping.profile].todoistProjectId;
    let next: Mapping = { ...mapping, projectId, calendarId: profiles[mapping.profile].calendarId };
    delete next.recurrenceOwner;
    delete next.calendarNativeRecurring;
    const clients = await this.clients(mapping.profile);
    const commentClient = todoist || clients.todoist;
    const canPersistProviderMapping = Boolean(projectId && this.providerCommentApiAvailable(commentClient));
    if (!canPersistProviderMapping) {
      if (this.isLegacyTestAdapter(commentClient)) {
        await this.state.putMapping(next);
        return next;
      }
      throw new Error("Todoist project comment correlation API unavailable");
    }
    if (typeof commentClient.getTask === "function" && typeof clients.calendar.getEvent === "function") {
      const [baselineTask, event, master] = await Promise.all([
        commentClient.getTask(next.taskId),
        clients.calendar.getEvent(next.eventId),
        next.masterEventId && next.masterEventId !== next.eventId
          ? clients.calendar.getEvent(next.masterEventId) : Promise.resolve(undefined),
      ]);
      const active = next.activeInstanceId && next.activeInstanceId !== next.eventId
        ? await clients.calendar.getEvent(next.activeInstanceId).catch(() => undefined)
        : undefined;
      if (active && (!next.masterEventId || active.recurringEventId !== next.masterEventId
        || active.status === "cancelled")) {
        throw new Error("Active Calendar occurrence does not belong to the correlated series");
      }
      next = { ...next, syncBaseline: providerSyncBaseline(baselineTask, active || event, master || event) };
    }
    const projectIndex = buildProjectMappingIndex(await commentClient.listProjectComments(projectId!));
    const stableSeries = next.seriesId || next.masterEventId;
    const existingSeriesMappings = stableSeries && projectIndex
      ? projectIndex.parsed.filter(entry => entry.payload.profile === next.profile
        && entry.payload.projectId === projectId
        && (entry.payload.seriesId === stableSeries || entry.payload.masterEventId === stableSeries))
      : [];
    const previousTaskIds = new Set(existingSeriesMappings.map(entry => entry.payload.taskId));
    if (previousTaskIds.size > 1)
      throw new Error("Provider-native series correlation is ambiguous across Todoist task IDs");
    const expectedTaskId = previousTaskIds.size === 1 ? [...previousTaskIds][0] : undefined;
    const correlationEventId = next.masterEventId || next.eventId;
    if (correlationEventId && typeof clients.calendar.ensureTaskCorrelation === "function") {
      const event = await clients.calendar.ensureTaskCorrelation(correlationEventId, next.taskId,
        expectedTaskId !== next.taskId ? expectedTaskId : undefined, next);
      const start = event.start?.dateTime || event.start?.date;
      next = {
        ...next,
        ...(event.summary !== undefined ? { syncedTitle: normalizedText(event.summary) } : {}),
        ...(event.description !== undefined ? { syncedDescription: normalizedDescription(event.description) } : {}),
        ...((next.activeEffectiveStart || start) ? { syncedDue: next.activeEffectiveStart || start } : {}),
      };
    }
    next = await upsertProjectMappingComment(commentClient, next, projectId!, undefined, projectIndex);
    return next;
  }

  private async rescheduleMappedRecurringOccurrence(
    delivery: Delivery,
    task: TodoistTask,
    oldTask: TodoistTask | undefined,
    mapping: Mapping,
    calendar: GoogleCalendar,
    todoist: Todoist,
  ): Promise<void> {
    const unsupported = async (reason: string) => this.state.audit(delivery.profile,
      "todoist_recurring_occurrence_reschedule_unsupported", {
        taskId: task.id, masterEventId: mapping.masterEventId, eventId: mapping.activeInstanceId,
        reason, sourceLeftUnchanged: true,
      });
    const oldDue = oldTask?.due?.datetime || oldTask?.due?.date || mapping.activeEffectiveStart;
    const nextDue = task.due?.datetime || task.due?.date;
    const nextRule = todoistRecurrenceToRrule(task);
    if (!mapping.masterEventId || !mapping.activeInstanceId || !mapping.originalStart
      || (oldTask && !oldTask.due?.is_recurring) || !task.due?.is_recurring || !oldDue || !nextDue
      || !nextRule
      || (oldTask && (todoistRecurrenceToRrule(oldTask) !== nextRule
        || todoistRecurrenceKey(oldTask) !== todoistRecurrenceKey(task)
        || oldTask.due?.timezone !== task.due?.timezone))) return unsupported("recurrence_or_identity_changed");
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "todoist_recurring_occurrence_reschedule_suppressed", {
        taskId: task.id, masterEventId: mapping.masterEventId, eventId: mapping.activeInstanceId,
        mode: delivery.mode,
      });
    }

    const master = await calendar.getEvent(mapping.masterEventId);
    const current = await calendar.getEvent(mapping.activeInstanceId);
    const masterTaskId = master.extendedProperties?.shared?.taskId;
    const masterShared = master.extendedProperties?.shared;
    const original = current.originalStartTime?.dateTime || current.originalStartTime?.date;
    const currentStart = current.start?.dateTime || current.start?.date;
    const currentEnd = current.end?.dateTime || current.end?.date;
    const currentIsAllDay = Boolean(current.start?.date && !current.start.dateTime);
    const sameInstant = (left: string | undefined, right: string | undefined) => {
      const a = Date.parse(left || ""), b = Date.parse(right || "");
      return Number.isFinite(a) && Number.isFinite(b) && a === b;
    };
    const sameStart = (left: string | undefined, right: string | undefined) => currentIsAllDay
      ? left === right : sameInstant(left, right);
    const alreadyApplied = sameStart(currentStart, nextDue);
    const stillAtOldStart = sameStart(currentStart, oldDue);
    const mappedStartStillValid = !mapping.activeEffectiveStart
      || sameStart(currentStart, mapping.activeEffectiveStart)
      || sameStart(mapping.activeEffectiveStart, oldDue);
    if (mapping.profile !== delivery.profile || mapping.taskId !== task.id
      || task.project_id !== profiles[delivery.profile].todoistProjectId
      || master.id !== mapping.masterEventId || master.status !== "confirmed" || !master.recurrence?.includes(nextRule)
      || masterTaskId !== task.id
      || (masterShared?.todoistRecurrence && masterShared.todoistRecurrence !== todoistRecurrenceKey(task))
      || (masterShared?.syncProfile && masterShared.syncProfile !== delivery.profile)
      || (masterShared?.syncCalendarId && masterShared.syncCalendarId !== profiles[delivery.profile].calendarId)
      || current.id !== mapping.activeInstanceId || current.status !== "confirmed"
      || current.recurringEventId !== mapping.masterEventId || original !== mapping.originalStart
      || !currentStart || !currentEnd || !mappedStartStillValid
      || (!stillAtOldStart && !alreadyApplied)
      || !current.etag) return unsupported("provider_occurrence_identity_or_version_changed");

    let start: CalendarEvent["start"];
    let end: CalendarEvent["end"];
    const nextIsAllDay = /^\d{4}-\d{2}-\d{2}$/.test(nextDue);
    if (currentIsAllDay && nextIsAllDay && current.start?.date && current.end?.date && !current.end.dateTime) {
      const dayDelta = Math.round((Date.parse(`${current.end.date}T00:00:00Z`)
        - Date.parse(`${current.start.date}T00:00:00Z`)) / 86_400_000);
      if (dayDelta < 1) return unsupported("invalid_all_day_occurrence_boundaries");
      const nextEnd = new Date(Date.parse(`${nextDue}T00:00:00Z`) + dayDelta * 86_400_000)
        .toISOString().slice(0, 10);
      start = { date: nextDue };
      end = { date: nextEnd };
    } else if (!currentIsAllDay && !nextIsAllDay && current.start?.dateTime && current.end?.dateTime
      && hasOffset(nextDue)) {
      const duration = Date.parse(current.end.dateTime) - Date.parse(current.start.dateTime);
      if (!Number.isFinite(duration) || duration <= 0) return unsupported("invalid_timed_occurrence_boundaries");
      start = { dateTime: nextDue, ...(task.due?.timezone || current.start.timeZone
        ? { timeZone: task.due?.timezone || current.start.timeZone } : {}) };
      const nextDueMs = Date.parse(nextDue);
      if (!Number.isFinite(nextDueMs)) return unsupported("invalid_timed_due_boundary");
      end = { dateTime: new Date(nextDueMs + duration).toISOString(),
        ...(task.due?.timezone || current.end.timeZone ? { timeZone: task.due?.timezone || current.end.timeZone } : {}) };
    } else {
      return unsupported("date_shape_conversion_not_supported");
    }

    const unchangedMasterRule = JSON.stringify(master.recurrence);
    const updated = alreadyApplied ? current
      : await calendar.upsertEventIfUnchanged({ ...current, start, end }, current.id, current.etag);
    const [readback, masterReadback] = await Promise.all([
      calendar.getEvent(current.id), calendar.getEvent(master.id),
    ]);
    const actualStart = readback.start?.dateTime || readback.start?.date;
    const actualEnd = readback.end?.dateTime || readback.end?.date;
    const expectedEnd = end?.dateTime || end?.date;
    const startMatches = start?.date ? actualStart === start.date : sameInstant(actualStart, start?.dateTime);
    const endMatches = end?.date ? actualEnd === end.date : sameInstant(actualEnd, end?.dateTime);
    const readbackOriginal = readback.originalStartTime?.dateTime || readback.originalStartTime?.date;
    const currentOriginal = current.originalStartTime?.dateTime || current.originalStartTime?.date;
    if (updated.id !== current.id || readback.id !== current.id || readback.status !== "confirmed"
      || readback.recurringEventId !== master.id || readbackOriginal !== currentOriginal
      || !startMatches || !endMatches || !expectedEnd
      || masterReadback.id !== master.id || JSON.stringify(masterReadback.recurrence) !== unchangedMasterRule) {
      throw new Error("Calendar recurring instance reschedule readback mismatch");
    }
    await this.persistProviderMapping({
      ...mapping,
      activeEffectiveStart: actualStart,
      updatedAt: new Date().toISOString(),
    }, todoist);
    await this.state.recordMutation(delivery.profile);
    return this.state.audit(delivery.profile, "todoist_recurring_occurrence_rescheduled", {
      taskId: task.id, masterEventId: master.id, eventId: current.id,
      originalStart: mapping.originalStart, effectiveStart: actualStart, recoveredAppliedWrite: alreadyApplied,
    });
  }

  async providerMappings(profile: Profile, todoist?: Todoist): Promise<Mapping[]> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (!this.providerCommentReaderAvailable(client)) {
      return await this.state.listMappings?.(profile) || [];
    }
    const providerMappings = await this.providerCommentMappings(profile, client);
    // During cutover, retain old DynamoDB correlations as a read fallback.
    // Provider-owned comments always win for a task or event identity.
    const legacy = await this.state.listMappings?.(profile) || [];
    const providerTasks = new Set(providerMappings.map(mapping => mapping.taskId));
    const providerEvents = new Set(providerMappings.flatMap(mapping =>
      [mapping.eventId, mapping.masterEventId, mapping.activeInstanceId].filter((id): id is string => Boolean(id))));
    return [...providerMappings, ...legacy.filter(mapping =>
      !providerTasks.has(mapping.taskId) && !providerEvents.has(mapping.eventId))];
  }

  async providerMappingByTask(profile: Profile, taskId: string, todoist?: Todoist): Promise<Mapping | undefined> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (!this.providerCommentReaderAvailable(client)) {
      if (this.isLegacyTestAdapter(client)) return this.legacyMappingByTask(profile, taskId);
      throw new Error("Todoist project comment correlation API unavailable");
    }
    const candidates = (await this.providerCommentMappings(profile, client)).filter(mapping => mapping.taskId === taskId);
    if (!candidates.length) return this.legacyMappingByTask(profile, taskId);
    candidates.sort((a, b) => (b.mappingRevision || 0) - (a.mappingRevision || 0)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = candidates[0];
    const peers = candidates.filter(mapping => (mapping.mappingRevision || 0) === (latest.mappingRevision || 0)
      && Date.parse(mapping.updatedAt) === Date.parse(latest.updatedAt));
    const identities = new Set(peers.map(mapping => JSON.stringify([mapping.eventId, mapping.masterEventId, mapping.seriesId])));
    if (identities.size > 1) {
      await this.state.audit(profile, "todoist_provider_mapping_correlation_ambiguous", { taskId, candidateCount: peers.length });
      throw new Error(`Todoist task ${taskId} has conflicting provider mapping comments`);
    }
    return latest;
  }

  private async verifyTodoistSeriesPair(
    profile: Profile, taskId: string, masterEventId: string, calendar: GoogleCalendar, todoist: Todoist,
    previous: { taskUpdatedAt?: string; masterUpdated?: string; mapping?: Mapping } = {},
  ): Promise<RecurrenceReconciliationOutcome> {
    let task: TodoistTask;
    let master: CalendarEvent;
    try {
      [task, master] = await Promise.all([todoist.getTask(taskId), calendar.getEvent(masterEventId)]);
    } catch (error) {
      if ([404, 410].includes(Number((error as { status?: number }).status))) {
        await this.state.audit(profile, "calendar_recurrence_reconciliation_unverified", {
          taskId, masterEventId, reasons: ["provider_object_missing"],
        });
        return "unverified";
      }
      throw error;
    }
    const mapping = await this.providerMappingByTask(profile, taskId, todoist);
    const shared = master.extendedProperties?.shared || {};
    const expectedRule = todoistRecurrenceToRrule(task);
    let activeInstance: CalendarEvent | undefined;
    if (mapping?.activeInstanceId) {
      try { activeInstance = await calendar.getEvent(mapping.activeInstanceId); }
      catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      }
    }
    const projectId = profiles[profile].todoistProjectId;
    const calendarId = profiles[profile].calendarId;
    const exactSeriesId = Boolean(mapping?.seriesId
      && (mapping.seriesId === taskId || mapping.seriesId === (master.iCalUID || master.id)));
    const exactMappingEvent = Boolean(mapping?.eventId === master.id
      || mapping?.eventId === mapping?.activeInstanceId && Boolean(mapping?.activeInstanceId));
    const exactActiveInstance = Boolean(mapping?.activeInstanceId && mapping.originalStart
      && mapping.activeEffectiveStart && activeInstance
      && activeInstance.id === mapping.activeInstanceId && activeInstance.status === "confirmed"
      && activeInstance.recurringEventId === master.id
      && compareLogicalStarts(recurrenceOriginalStart(activeInstance) || "", mapping.originalStart) === 0
      && compareLogicalStarts(eventEffectiveStart(activeInstance) || "", mapping.activeEffectiveStart) === 0);
    const exactMasterCorrelation = Boolean(mapping && shared.syncSchemaVersion === "2"
      && shared.syncProfile === profile && shared.syncCalendarId === calendarId
      && shared.taskId === taskId && shared.syncTaskId === taskId
      && shared.syncEventId === master.id && shared.syncMasterEventId === master.id
      && mapping?.seriesId === shared.syncSeriesId
      && mapping.activeInstanceId && mapping.activeInstanceId === shared.syncActiveInstanceId
      && (!mapping.originalStart || mapping.originalStart === shared.syncOriginalStart)
      && (!mapping.activeEffectiveStart || mapping.activeEffectiveStart === shared.syncActiveEffectiveStart)
      && (mapping.calendarProgressVersion !== 1 || shared.syncProgressVersion === "1")
      && (mapping.completedThroughOriginalStart === undefined
        || mapping.completedThroughOriginalStart === shared.syncCompletedThrough));
    const reasons: string[] = [];
    if (task.project_id !== projectId || mapping?.profile !== profile || mapping?.projectId !== projectId
      || mapping?.taskId !== taskId || mapping?.masterEventId !== masterEventId) reasons.push("mapping_identity_mismatch");
    if (!task.due?.is_recurring || master.status === "cancelled" || !master.recurrence?.length)
      reasons.push("recurrence_object_not_live");
    if (!(calendarRecurrenceMatchesTodoist(master, task)
      || Boolean(expectedRule && master.recurrence?.includes(expectedRule)))) reasons.push("recurrence_rule_mismatch");
    if (!exactSeriesId || !exactMappingEvent || !exactMasterCorrelation) reasons.push("provider_correlation_mismatch");
    if (!exactActiveInstance) reasons.push("active_occurrence_mismatch");
    if (reasons.length) {
      if (task.due?.is_recurring && !expectedRule
        && reasons.length === 1 && reasons[0] === "recurrence_rule_mismatch") {
        await this.state.audit(profile, "todoist_recurrence_unsupported_rule", {
          taskId, masterEventId, existingMirrorPreserved: true,
          outcome: "unsupported", nonBlocking: true,
        });
        return "unsupported";
      }
      await this.state.audit(profile, "calendar_recurrence_reconciliation_unverified", {
        taskId, masterEventId, reasons,
      });
      return "unverified";
    }
    const mappingState = (value: Mapping | undefined): string => value ? JSON.stringify({
      profile: value.profile, projectId: value.projectId, calendarId: value.calendarId,
      taskId: value.taskId, eventId: value.eventId, seriesId: value.seriesId,
      masterEventId: value.masterEventId, activeInstanceId: value.activeInstanceId,
      originalStart: value.originalStart, activeEffectiveStart: value.activeEffectiveStart,
      calendarProgressVersion: value.calendarProgressVersion,
      completedThroughOriginalStart: value.completedThroughOriginalStart,
      todoistPhaseBVersion: value.todoistPhaseBVersion,
      syncedTitle: value.syncedTitle, syncedDescription: value.syncedDescription, syncedDue: value.syncedDue,
      syncBaseline: value.syncBaseline ? {
        version: value.syncBaseline.version, todoist: value.syncBaseline.todoist, calendar: value.syncBaseline.calendar,
      } : undefined,
    }) : "missing";
    const repaired = previous.taskUpdatedAt !== task.updated_at
      || previous.masterUpdated !== master.updated
      || mappingState(previous.mapping) !== mappingState(mapping);
    return repaired ? "repaired" : "converged";
  }

  private async recurrenceControlOutcome(
    profile: Profile, ids: { taskId?: string; eventId?: string },
  ): Promise<RecurrenceReconciliationOutcome> {
    const state = this.state as StateRepository & { explicitlyExcluded?: StateRepository["explicitlyExcluded"] };
    return await state.explicitlyExcluded?.(profile, ids) ? "excluded" : "blocked";
  }

  async providerMappingByEvent(profile: Profile, eventId: string, todoist?: Todoist): Promise<Mapping | undefined> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (!this.providerCommentReaderAvailable(client)) {
      if (this.isLegacyTestAdapter(client)) return this.legacyMappingByEvent(profile, eventId);
      throw new Error("Todoist project comment correlation API unavailable");
    }
    const candidates = (await this.providerCommentMappings(profile, client)).filter(mapping =>
      mapping.eventId === eventId || mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
    if (!candidates.length) {
      return this.legacyMappingByEvent(profile, eventId);
    }
    candidates.sort((a, b) => (b.mappingRevision || 0) - (a.mappingRevision || 0)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = candidates[0];
    const peers = candidates.filter(mapping => (mapping.mappingRevision || 0) === (latest.mappingRevision || 0)
      && Date.parse(mapping.updatedAt) === Date.parse(latest.updatedAt));
    const identities = new Set(peers.map(mapping => JSON.stringify([mapping.taskId, mapping.masterEventId, mapping.seriesId])));
    if (identities.size > 1) {
      await this.state.audit(profile, "calendar_provider_mapping_correlation_ambiguous", { eventId, candidateCount: peers.length });
      throw new Error(`Calendar event ${eventId} has conflicting provider mapping comments`);
    }
    return latest;
  }

  private async providerCommentMappings(profile: Profile, todoist: Todoist): Promise<Mapping[]> {
    const projectId = profiles[profile].todoistProjectId;
    const index = typeof todoist.getProjectMappingIndex === "function"
      ? await todoist.getProjectMappingIndex(projectId)
      : buildProjectMappingIndex(await todoist.listProjectComments(projectId));
    return index.parsed
      .filter(entry => entry.payload.profile === profile
        && entry.payload.projectId === profiles[profile].todoistProjectId)
      .map(mappingFromProjectMappingComment);
  }

  private async legacyMappingByTask(profile: Profile, taskId: string): Promise<Mapping | undefined> {
    if (typeof this.state.getMappingByTask === "function") {
      const mapping = await this.state.getMappingByTask(profile, taskId);
      return mapping?.profile === profile ? mapping : undefined;
    }
    return (await this.state.listMappings?.(profile) || []).find(mapping => mapping.taskId === taskId);
  }

  private async legacyMappingByEvent(profile: Profile, eventId: string): Promise<Mapping | undefined> {
    if (typeof this.state.getMappingByEvent === "function") {
      const direct = await this.state.getMappingByEvent(profile, eventId);
      if (direct?.profile === profile) return direct;
      return (await this.state.listMappings?.(profile) || []).find(mapping =>
        mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
    }
    return (await this.state.listMappings?.(profile) || []).find(mapping =>
      mapping.eventId === eventId || mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
  }

  async providerMappingsForCalendarIdentity(
    currentProfile: Profile, eventIds: string[], currentTodoist?: Todoist,
  ): Promise<Mapping[]> {
    const ids = new Set(eventIds.filter(Boolean));
    const mappings: Mapping[] = [];
    for (const profile of Object.keys(profiles) as Profile[]) {
      const values = await this.providerMappings(profile, profile === currentProfile ? currentTodoist : undefined);
      mappings.push(...values.filter(mapping => [mapping.eventId, mapping.masterEventId, mapping.activeInstanceId]
        .some(id => Boolean(id && ids.has(id)))));
    }
    return mappings;
  }

  mappingFromCalendarCorrelation(profile: Profile, event: CalendarEvent): Mapping | undefined {
    const shared = event.extendedProperties?.shared;
    if (!shared) return undefined;
    const taskId = shared.syncTaskId || shared.taskId;
    if (!taskId) return undefined;
    if (shared.syncSchemaVersion && shared.syncSchemaVersion !== "2") return undefined;
    if (shared.syncProfile && shared.syncProfile !== profile) return undefined;
    if (shared.syncCalendarId && shared.syncCalendarId !== profiles[profile].calendarId) return undefined;
    if (shared.syncTaskId && shared.taskId && shared.syncTaskId !== shared.taskId) return undefined;
    const masterEventId = shared.syncMasterEventId || event.recurringEventId
      || (event.recurrence?.length ? event.id : undefined);
    const eventId = masterEventId || shared.syncEventId || event.id;
    if (!eventId || shared.syncEventId && shared.syncEventId !== eventId && !masterEventId) return undefined;
    const progressVersion = shared.syncProgressVersion === "1" ? 1 : undefined;
    const seriesId = shared.syncSeriesId || masterEventId;
    return {
      profile, calendarId: profiles[profile].calendarId, eventId, taskId,
      ...(seriesId ? { seriesId } : {}),
      ...(masterEventId ? { masterEventId } : {}),
      ...(shared.syncActiveInstanceId ? { activeInstanceId: shared.syncActiveInstanceId } : {}),
      ...(shared.syncOriginalStart ? { originalStart: shared.syncOriginalStart } : {}),
      ...(shared.syncActiveEffectiveStart ? { activeEffectiveStart: shared.syncActiveEffectiveStart } : {}),
      ...(progressVersion ? { calendarProgressVersion: progressVersion as 1 } : {}),
      ...(shared.syncCompletedThrough ? { completedThroughOriginalStart: shared.syncCompletedThrough } : {}),
      ...(shared.syncTodoistPhaseBVersion === "1" ? { todoistPhaseBVersion: 1 as const } : {}),
      ...(event.summary !== undefined ? { syncedTitle: normalizedText(event.summary) } : {}),
      ...(event.description !== undefined ? { syncedDescription: normalizedDescription(event.description) } : {}),
      updatedAt: event.updated || new Date().toISOString(),
    };
  }

  async providerMappingByTaskAnyProfile(taskId: string): Promise<Mapping | undefined> {
    const clients = await this.clients("home");
    if (!this.providerCommentReaderAvailable(clients.todoist)) {
      return this.state.getMappingByTaskAnyProfile(taskId);
    }
    const candidates: Mapping[] = [];
    for (const profile of Object.keys(profiles) as Profile[]) {
      const mapping = await this.providerMappingByTask(profile, taskId);
      if (mapping) candidates.push(mapping);
    }
    if (candidates.length > 1) {
      await this.state.audit(candidates[0].profile, "todoist_provider_mapping_cross_profile_ambiguous", {
        taskId, profiles: candidates.map(mapping => mapping.profile).sort(),
      });
      throw new Error(`Todoist task ${taskId} has provider mapping comments in multiple profiles`);
    }
    if (candidates[0]) return candidates[0];
    if (typeof this.state.listMappings === "function") return this.state.getMappingByTaskAnyProfile(taskId);
    return undefined;
  }

  private providerCommentApiAvailable(client: Todoist): boolean {
    return typeof client.listProjectComments === "function"
      && typeof client.upsertProjectComment === "function"
      && typeof client.updateComment === "function";
  }

  private providerCommentReaderAvailable(client: Todoist): boolean {
    return typeof client.listProjectComments === "function";
  }

  private isLegacyTestAdapter(client: Todoist): boolean {
    // Lightweight legacy fakes in the unit suite still seed StateRepository
    // mappings. Real Todoist clients never take this branch; production fails
    // closed if provider-native correlation APIs are unavailable.
    return process.env.NODE_ENV === "test" && !(client instanceof Todoist);
  }

  async providerSeriesMapping(
    profile: Profile,
    seriesId: string,
    todoist?: Todoist,
    masterEventId?: string,
  ): Promise<Mapping | undefined> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (!this.providerCommentReaderAvailable(client)) {
      if (this.isLegacyTestAdapter(client)) {
        if (typeof this.state.listMappings !== "function") return undefined;
        const mappings = await this.state.listMappings(profile);
        return mappings.find(mapping => mapping.seriesId === seriesId
          && (!masterEventId || mapping.masterEventId === masterEventId));
      }
      throw new Error("Todoist project comment correlation API unavailable");
    }
    const comments = await client.listProjectComments(profiles[profile].todoistProjectId);
    const candidates = buildProjectMappingIndex(comments).parsed
      .filter(entry => entry.payload.profile === profile
        && entry.payload.projectId === profiles[profile].todoistProjectId
        && entry.payload.seriesId && entry.payload.masterEventId
        && (entry.payload.seriesId === seriesId || (masterEventId && entry.payload.masterEventId === masterEventId)))
      .map(mappingFromProjectMappingComment);
    if (!candidates.length) return this.legacyMappingBySeries(profile, seriesId, masterEventId);
    candidates.sort((a, b) => (b.mappingRevision || 0) - (a.mappingRevision || 0)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = candidates[0];
    const latestUpdatedAt = Date.parse(latest.updatedAt);
    const sameVersion = candidates.filter(candidate => (candidate.mappingRevision || 0) === (latest.mappingRevision || 0)
      && Date.parse(candidate.updatedAt) === latestUpdatedAt);
    const identities = new Set(sameVersion.map(candidate => JSON.stringify([
      candidate.taskId, candidate.masterEventId, candidate.seriesId === candidate.taskId ? "todoist-native" : "calendar-native",
    ])));
    if (identities.size > 1) {
      await this.state.audit(profile, "calendar_recurrence_provider_correlation_ambiguous", {
        seriesId, candidateCount: sameVersion.length,
      });
      return undefined;
    }
    return latest;
  }

  private async legacyMappingBySeries(
    profile: Profile, seriesId: string, masterEventId?: string,
  ): Promise<Mapping | undefined> {
    if (typeof this.state.getRecurrenceLink === "function") {
      const link = await this.state.getRecurrenceLink(profile, seriesId);
      if (link) {
        const mapping = await this.legacyMappingByTask(profile, link.taskId);
        if (mapping && (!masterEventId || mapping.masterEventId === masterEventId)) return mapping;
      }
    }
    const byTask = await this.legacyMappingByTask(profile, seriesId);
    if (byTask?.seriesId === seriesId && (!masterEventId || byTask.masterEventId === masterEventId)) return byTask;
    if (masterEventId) {
      const byMaster = await this.legacyMappingByEvent(profile, masterEventId);
      if (byMaster?.seriesId === seriesId && (!byMaster.masterEventId || byMaster.masterEventId === masterEventId)) return byMaster;
    }
    return undefined;
  }

  /** Compatibility adapter for review and verified-deletion workflows.
   * Ordinary synchronization consumes providerSeriesMapping directly. */
  async providerRecurrenceLink(
    profile: Profile, seriesId: string, todoist?: Todoist, masterEventId?: string,
  ): Promise<RecurrenceLink | undefined> {
    const mapping = await this.providerSeriesMapping(profile, seriesId, todoist, masterEventId);
    return mapping ? recurrenceLink(mapping) : undefined;
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
  ): Promise<{ blocked: boolean; changed: boolean; task: TodoistTask; mapping: Mapping }> {
    const resolution = calendarOwnedMetadataResolution(mapping, master, task);
    if (resolution.conflicts.length) {
      await this.state.audit(profile, "calendar_owned_metadata_conflict", {
        seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
        fields: resolution.conflicts, reason: "concurrent_edits_or_missing_baseline",
      });
      return { blocked: true, changed: false, task, mapping };
    }
    const expected = { content: resolution.summary, description: resolution.description };
    if (resolution.calendarChanged && !master.etag) {
      await this.state.audit(profile, "calendar_owned_metadata_conflict", {
        seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
        reason: "calendar_master_etag_missing",
      });
      return { blocked: true, changed: false, task, mapping };
    }
    if (resolution.calendarChanged) {
      if (!await this.state.mutationAllowed(profile)) {
        await this.state.audit(profile, "calendar_owned_metadata_mutation_blocked", { taskId: task.id, masterEventId: master.id });
        return { blocked: true, changed: false, task, mapping };
      }
      const updated = await calendar.patchEventMetadataIfUnchanged(master.id, master.etag!, {
        summary: resolution.summary, description: resolution.description,
      });
      await this.state.recordMutation(profile);
      if (updated.id !== master.id || updated.recurringEventId || updated.status === "cancelled"
        || JSON.stringify(updated.recurrence) !== JSON.stringify(master.recurrence)
        || normalizedText(updated.summary) !== resolution.summary
        || normalizedDescription(updated.description) !== resolution.description) {
        await this.state.audit(profile, "calendar_owned_metadata_readback_mismatch", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id, provider: "calendar",
        });
        return { blocked: true, changed: false, task, mapping };
      }
    }
    let nextTask = task;
    if (resolution.todoistChanged) {
      if (!await this.state.mutationAllowed(profile)) {
        await this.state.audit(profile, "calendar_owned_metadata_mutation_blocked", { taskId: task.id, masterEventId: master.id });
        return { blocked: true, changed: false, task, mapping };
      }
      nextTask = await todoist.updateTaskMetadata(task.id, expected);
      await this.state.recordMutation(profile);
      const dueBefore = task.due, dueAfter = nextTask.due;
      if (nextTask.id !== task.id
        || normalizedText(nextTask.content) !== expected.content
        || normalizedDescription(nextTask.description) !== expected.description
        || Boolean(dueBefore?.is_recurring) !== Boolean(dueAfter?.is_recurring)
        || (dueBefore?.date || dueBefore?.datetime) !== (dueAfter?.date || dueAfter?.datetime)
        || dueBefore?.string !== dueAfter?.string) {
        await this.state.audit(profile, "calendar_owned_metadata_readback_mismatch", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id, provider: "todoist",
        });
        return { blocked: true, changed: false, task, mapping };
      }
    }
    const nextMapping: Mapping = {
      ...mapping, syncedTitle: resolution.summary, syncedDescription: resolution.description,
      updatedAt: new Date().toISOString(),
    };
    // Provider comments are the authoritative baseline. Verify the active
    // series snapshot again before updating its revision; the profile writer
    // lease serializes competing webhook and scheduled mutations.
    if (resolution.calendarChanged || resolution.todoistChanged
      || mapping.syncedTitle !== resolution.summary || mapping.syncedDescription !== resolution.description) {
      const link = mapping.seriesId ? await this.providerSeriesMapping(profile, mapping.seriesId, todoist, master.id) : undefined;
      if (!link || link.seriesId === link.taskId || link.taskId !== task.id
        || link.eventId !== mapping.eventId || link.masterEventId !== master.id
        || link.activeInstanceId !== mapping.activeInstanceId
        || link.originalStart !== mapping.originalStart
        || link.completedThroughOriginalStart !== mapping.completedThroughOriginalStart
        || link.calendarProgressVersion !== mapping.calendarProgressVersion) {
        await this.state.audit(profile, "calendar_owned_metadata_mapping_changed", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
        });
        return { blocked: true, changed: false, task: nextTask, mapping };
      }
      await this.persistProviderMapping(nextMapping, todoist);
      if (resolution.calendarChanged || resolution.todoistChanged) {
        await this.state.audit(profile, "calendar_owned_metadata_propagated", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: master.id,
          toCalendar: resolution.calendarChanged, toTodoist: resolution.todoistChanged,
        });
      }
    }
    return { blocked: false, changed: resolution.calendarChanged || resolution.todoistChanged
      || mapping.syncedTitle !== resolution.summary || mapping.syncedDescription !== resolution.description,
      task: nextTask, mapping: nextMapping };
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
    await this.persistProviderMapping(nextMapping);
    if (mutated) await this.state.recordMutation(profile);
    return { mapping: nextMapping, task: nextTask, mutated };
  }

  private async applyCalendarOwnedInstanceChange(
    delivery: Delivery,
    changedInstance: CalendarEvent,
    mapping: Mapping,
    calendar: GoogleCalendar,
    todoist: Todoist,
  ): Promise<void> {
    if (changedInstance.id !== mapping.activeInstanceId) {
      return this.state.audit(delivery.profile, "calendar_recurrence_future_instance_deferred", {
        masterEventId: mapping.masterEventId, eventId: changedInstance.id,
        activeInstanceId: mapping.activeInstanceId,
      });
    }
    if (!mapping.masterEventId || !mapping.seriesId || !mapping.originalStart) {
      return this.state.audit(delivery.profile, "calendar_recurrence_instance_identity_unverified", {
        taskId: mapping.taskId, eventId: changedInstance.id,
      });
    }
    const current = await calendar.getEvent(changedInstance.id);
    if (current.status === "cancelled") {
      return this.state.audit(delivery.profile, "calendar_recurrence_instance_cancelled_re_read", {
        taskId: mapping.taskId, eventId: current.id, masterEventId: mapping.masterEventId,
      });
    }
    const originalStart = recurrenceOriginalStart(current);
    if (current.id !== changedInstance.id || current.status !== "confirmed"
      || current.recurringEventId !== mapping.masterEventId || !originalStart
      || compareLogicalStarts(originalStart, mapping.originalStart) !== 0) {
      return this.state.audit(delivery.profile, "calendar_recurrence_instance_identity_unverified", {
        taskId: mapping.taskId, eventId: changedInstance.id, masterEventId: mapping.masterEventId,
      });
    }
    const master = await calendar.getEvent(mapping.masterEventId);
    if (master.status !== "confirmed" || master.recurringEventId || !master.recurrence?.length) {
      return this.state.audit(delivery.profile, "calendar_recurrence_master_unavailable", {
        taskId: mapping.taskId, masterEventId: mapping.masterEventId,
      });
    }
    let task: TodoistTask;
    try { task = await todoist.getTask(mapping.taskId); }
    catch (error) {
      if (Number((error as { status?: number }).status) !== 404) throw error;
      return this.state.audit(delivery.profile, "calendar_recurrence_mapped_task_missing", {
        taskId: mapping.taskId, masterEventId: mapping.masterEventId,
      });
    }
    if (task.id !== mapping.taskId || task.project_id !== profiles[delivery.profile].todoistProjectId
      || !task.due?.is_recurring) {
      return this.state.audit(delivery.profile, "calendar_recurrence_task_identity_unverified", {
        taskId: mapping.taskId, masterEventId: mapping.masterEventId,
      });
    }
    const timeZone = await this.verifiedCalendarRecurrenceTimeZone(delivery.profile, calendar, todoist, master, {
      seriesId: mapping.seriesId, masterEventId: master.id, taskId: task.id,
    });
    if (!timeZone) return;
    const instances = finiteWeeklyCalendarRuleCandidate(master)
      ? await calendar.listInstances(master.id)
      : await listBoundedRecurrenceInstances(calendar, master.id, originalStart);
    const listedCurrent = instances.find((instance) => instance.id === current.id);
    if (!listedCurrent || listedCurrent.status !== "confirmed"
      || compareLogicalStarts(recurrenceOriginalStart(listedCurrent) || "", originalStart) !== 0
      || compareLogicalStarts(eventEffectiveStart(listedCurrent) || "", eventEffectiveStart(current) || "") !== 0) {
      return this.state.audit(delivery.profile, "calendar_recurrence_instance_inventory_mismatch", {
        taskId: task.id, eventId: current.id, masterEventId: master.id,
      });
    }
    const recurrence = await verifiedCalendarOwnedRecurrence(master, instances, timeZone,
      calendar.listExplicitSeriesExceptions?.bind(calendar));
    if (!recurrence) {
      return this.state.audit(delivery.profile, "calendar_recurrence_unsupported_rule", {
        taskId: task.id, eventId: current.id, masterEventId: master.id,
        existingMirrorPreserved: true, outcome: "source_left_unchanged",
      });
    }
    const currentStateMatches = calendarOwnedRecurringTaskReadback(task, current, recurrence, timeZone).matches;
    if (!currentStateMatches && !matchesCalendarOwnedRecurringRule(task, recurrence, timeZone)) {
      return this.state.audit(delivery.profile, "calendar_recurrence_unsupported_rule", {
        taskId: task.id, eventId: current.id, masterEventId: master.id,
        existingMirrorPreserved: true, outcome: "source_left_unchanged",
      });
    }
    const metadataMatches = normalizedText(task.content) === (normalizedText(current.summary) || "Untitled calendar event")
      && normalizedDescription(task.description) === normalizedDescription(current.description);
    let nextTask = task;
    if (!currentStateMatches || !metadataMatches) {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "calendar_recurrence_instance_mutation_suppressed", {
          taskId: task.id, eventId: current.id, masterEventId: master.id, mode: delivery.mode,
        });
      }
      const payload = toTodoistTask(current);
      if (payload.due?.datetime) payload.due.timezone = timeZone;
      nextTask = await todoist.updateRecurringOccurrence(task, payload);
      if (nextTask.id !== task.id || !calendarOwnedRecurringTaskReadback(nextTask, current, recurrence, timeZone).matches
        || normalizedText(nextTask.content) !== (normalizedText(current.summary) || "Untitled calendar event")
        || normalizedDescription(nextTask.description) !== normalizedDescription(current.description)) {
        return this.state.audit(delivery.profile, "calendar_recurrence_instance_readback_mismatch", {
          taskId: task.id, eventId: current.id, masterEventId: master.id,
        });
      }
      await this.state.recordMutation(delivery.profile);
    }
    const nextMapping: Mapping = {
      ...mapping,
      eventId: mapping.eventId || master.id,
      taskId: task.id,
      seriesId: mapping.seriesId,
      masterEventId: master.id,
      activeInstanceId: current.id,
      originalStart,
      activeEffectiveStart: eventEffectiveStart(current),
      calendarProgressVersion: 1,
      syncedTitle: normalizedText(current.summary) || "Untitled calendar event",
      syncedDescription: normalizedDescription(current.description),
      ...(eventEffectiveStart(current) ? { syncedDue: eventEffectiveStart(current) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.persistProviderMapping(nextMapping, todoist);
    return this.state.audit(delivery.profile, currentStateMatches && metadataMatches
      ? "calendar_recurrence_active_instance_noop" : "calendar_recurrence_active_exception_applied", {
      taskId: task.id, eventId: current.id, masterEventId: master.id,
      originalStart, effectiveStart: eventEffectiveStart(current),
    });
  }

  async process(delivery: Delivery): Promise<void> {
    return withTodoistInventoryScope(async () => {
      if (delivery.kind === "calendar") return this.processCalendar(delivery);
      if (delivery.kind === "todoist") return this.processTodoist(delivery);
      if (delivery.kind === "reconcile") { await this.reconcile(delivery.profile); return; }
      return this.processOrphan(delivery);
    });
  }

  async reconcile(profile: Profile): Promise<RecurrenceReconciliationSummary> {
    return withTodoistInventoryScope(() => this.reconcileInScope(profile));
  }

  private async reconcileInScope(profile: Profile): Promise<RecurrenceReconciliationSummary> {
    const outcomes: RecurrenceReconciliationSummary = {
      total: 0, converged: 0, repaired: 0, unsupported: 0, excluded: 0, blocked: 0, stale: 0, unverified: 0,
    };
    const recordOutcome = (outcome: RecurrenceReconciliationOutcome): void => {
      outcomes.total += 1;
      outcomes[outcome] += 1;
    };
    const { calendar, todoist } = await this.clients(profile);
    const projectId = profiles[profile].todoistProjectId;
    const projectComments = await todoist.listProjectComments(projectId);
    const providerMappings = buildProjectMappingIndex(projectComments).parsed
      .filter(entry => entry.payload.profile === profile && entry.payload.projectId === projectId)
      .sort((a, b) => a.payload.taskId.localeCompare(b.payload.taskId)
        || b.payload.mappingRevision - a.payload.mappingRevision
        || Date.parse(b.payload.updatedAt) - Date.parse(a.payload.updatedAt));
    const mappedTaskIds = new Set(providerMappings.map(entry => entry.payload.taskId));
    // Reconcile each exact provider series through the same handler used by
    // webhooks. Choose the handler from current Calendar recurrence metadata;
    // mapping owner labels are not part of dispatch.
    const recurrenceMappings = providerMappings.map(mappingFromProjectMappingComment)
      .filter(mapping => mapping.seriesId && mapping.masterEventId);
    const masterIds = [...new Set(recurrenceMappings.map(mapping => mapping.masterEventId!))].sort();
    for (const masterEventId of masterIds) {
      let master: CalendarEvent;
      try { master = await calendar.getEvent(masterEventId); }
      catch (error) {
        if (!calendarEventGoneOnDirectRead(error)) throw error;
        await this.state.audit(profile, "calendar_recurrence_recovery_stale_master", { masterEventId });
        recordOutcome("stale");
        continue;
      }
      if (master.status === "cancelled" || !master.recurrence?.length) {
        await this.state.audit(profile, "calendar_recurrence_recovery_stale_master", { masterEventId });
        recordOutcome("stale");
        continue;
      }
      const shared = master.extendedProperties?.shared || {};
      const mapped = recurrenceMappings.filter(mapping => mapping.masterEventId === masterEventId);
      const taskId = shared.taskId || (new Set(mapped.map(mapping => mapping.taskId)).size === 1
        ? mapped[0]?.taskId : undefined);
      const candidateTaskIds = [...new Set(mapped.map(mapping => mapping.taskId))];
      if (candidateTaskIds.length > 1 || shared.taskId && candidateTaskIds.length === 1
        && candidateTaskIds[0] !== shared.taskId) {
        await this.state.audit(profile, "calendar_recurrence_provider_correlation_ambiguous", {
          masterEventId, taskId: shared.taskId, candidateTaskIds,
        });
        recordOutcome("blocked");
        continue;
      }
      const receivedAt = new Date().toISOString();
      let exactTask: TodoistTask | undefined;
      let exactMapping = taskId ? mapped.find(mapping => mapping.taskId === taskId) : undefined;
      if (taskId) {
        try { exactTask = await todoist.getTask(taskId); }
        catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
        if (exactTask && (exactTask.is_deleted || exactTask.is_completed || exactTask.completed_at
          || profileForTodoistProject(exactTask.project_id) !== profile)) exactTask = undefined;
      }
      if (exactTask) {
        const expectedRule = todoistRecurrenceToRrule(exactTask);
        const activeId = exactMapping?.activeInstanceId;
        let mappedActive: CalendarEvent | undefined;
        if (activeId) {
          try { mappedActive = await calendar.getEvent(activeId); }
          catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
        }
        const canBootstrapProviderBaseline = Boolean(exactMapping && !exactMapping.syncBaseline
          && exactMapping.profile === profile && exactMapping.taskId === exactTask.id
          && exactMapping.masterEventId === master.id && shared.taskId === exactTask.id
          && expectedRule && master.recurrence?.includes(expectedRule)
          && mappedActive?.status === "confirmed" && mappedActive.recurringEventId === master.id
          && startsMatch(mappedActive, exactTask)
          && normalizedText(master.summary) === normalizedText(exactTask.content)
          && normalizedDescription(master.description) === normalizedDescription(exactTask.description));
        if (canBootstrapProviderBaseline) {
          if (await this.state.syncBlocked(profile, { taskId: exactTask.id, eventId: master.id })) {
            recordOutcome(await this.recurrenceControlOutcome(profile, { taskId: exactTask.id, eventId: master.id }));
            continue;
          }
          if (!await this.state.mutationAllowed(profile)) {
            await this.state.audit(profile, "calendar_recurrence_provider_baseline_bootstrap_suppressed", {
              taskId: exactTask.id, masterEventId: master.id,
            });
            recordOutcome("blocked");
            continue;
          }
          const bootstrapped = await this.persistProviderMapping({
            ...exactMapping!, projectId, calendarId: profiles[profile].calendarId,
          }, todoist);
          recordOutcome(await this.verifyTodoistSeriesPair(profile, exactTask.id, master.id, calendar, todoist, {
            taskUpdatedAt: exactTask.updated_at, masterUpdated: master.updated, mapping: bootstrapped,
          }));
          continue;
        }
        const changes = providerRecurrenceChanges(exactTask, master, exactMapping?.syncBaseline);
        if (changes && !changes.todoistChanged && !changes.calendarChanged) {
          recordOutcome(await this.verifyTodoistSeriesPair(profile, exactTask.id, master.id, calendar, todoist, {
            taskUpdatedAt: exactTask.updated_at, masterUpdated: master.updated, mapping: exactMapping,
          }));
          continue;
        }
        if (!changes && calendarRecurrenceMatchesTodoist(master, exactTask)) {
          recordOutcome(await this.verifyTodoistSeriesPair(profile, exactTask.id, master.id, calendar, todoist, {
            taskUpdatedAt: exactTask.updated_at, masterUpdated: master.updated, mapping: exactMapping,
          }));
          continue;
        }
        let routeToTodoist: boolean | undefined;
        if (changes?.todoistChanged && !changes.calendarChanged) routeToTodoist = true;
        else if (changes?.calendarChanged && !changes.todoistChanged) routeToTodoist = false;
        else if (changes?.todoistChanged && changes.calendarChanged) {
          const todoistChangedAt = Date.parse(exactTask.updated_at || "");
          const calendarChangedAt = Date.parse(master.updated || "");
          // Latest provider timestamp wins; Calendar is the deterministic
          // tie-break for an indistinguishable series-rule edit.
          if (Number.isFinite(todoistChangedAt) && Number.isFinite(calendarChangedAt)) {
            routeToTodoist = todoistChangedAt > calendarChangedAt;
          }
        }
        if (routeToTodoist === undefined) {
          if (!nativeCalendarRecurrenceCandidate(master) && !finiteWeeklyCalendarRuleCandidate(master)) {
            const calendarDelivery: Delivery = {
              id: `snapshot-reconcile:${profile}:calendar-series:${masterEventId}:${receivedAt}`,
              kind: "calendar", profile, mode: "aws", receivedAt, headers: {},
              body: JSON.stringify({ kind: "calendar", event: master }),
            };
            try { recordOutcome(await this.applyCalendarSeries(calendarDelivery, master, todoist)); }
            catch (error) {
              throw new ReconciliationItemError(error, { stage: "recurrence", eventId: masterEventId });
            }
            continue;
          }
          if (exactTask.due?.is_recurring && !expectedRule) {
            recordOutcome(await this.verifyTodoistSeriesPair(profile, exactTask.id, master.id, calendar, todoist, {
              taskUpdatedAt: exactTask.updated_at, masterUpdated: master.updated, mapping: exactMapping,
            }));
            continue;
          }
          await this.state.audit(profile, "calendar_recurrence_reconciliation_unverified", {
            taskId: exactTask.id, masterEventId: master.id, reasons: ["provider_recurrence_baseline_missing_or_ambiguous"],
          });
          recordOutcome("unverified");
          continue;
        }
        if (routeToTodoist) {
          const delivery: Delivery = {
            id: `snapshot-reconcile:${profile}:todoist-series:${exactTask.id}:${exactTask.updated_at || receivedAt}`,
            kind: "todoist", profile, mode: "aws", receivedAt,
            headers: { "x-todoist-calendar-sync-reconcile": "true" },
            body: JSON.stringify({ event_name: "item:updated", event_data: exactTask,
              event_data_extra: { old_item: exactTask } }),
          };
          await this.processTodoist(delivery, { reconciliation: true });
          recordOutcome(await this.verifyTodoistSeriesPair(profile, exactTask.id, master.id, calendar, todoist, {
            taskUpdatedAt: exactTask.updated_at, masterUpdated: master.updated, mapping: exactMapping,
          }));
          continue;
        }
      }
      const delivery: Delivery = {
        id: `snapshot-reconcile:${profile}:calendar-series:${masterEventId}:${receivedAt}`,
        kind: "calendar", profile, mode: "aws", receivedAt, headers: {},
        body: JSON.stringify({ kind: "calendar", event: master }),
      };
      try { recordOutcome(await this.applyCalendarSeries(delivery, master, todoist)); }
      catch (error) {
        throw new ReconciliationItemError(error, { stage: "recurrence", eventId: masterEventId });
      }
    }
    // Recover recurring pairs when the project comment was lost but Calendar
    // still carries the exact Todoist task ID. This is deliberately a lookup
    // by provider ID, never by title or date. The live Calendar master tells
    // us which normal provider path to run; the source/owner label is not
    // consulted or recreated.
    if (typeof calendar.listLinkedEventsByTodoistTaskId === "function") {
      const tasks = await todoist.listTasks(projectId);
      for (const task of tasks) {
        if (!task.due?.is_recurring || task.is_deleted || task.is_completed || task.completed_at
          || profileForTodoistProject(task.project_id) !== profile || mappedTaskIds.has(task.id)) continue;
        const linked = await calendar.listLinkedEventsByTodoistTaskId(task.id);
        const masterIds = [...new Set(linked
          .filter(event => event.extendedProperties?.shared?.taskId === task.id && event.status !== "cancelled")
          .map(event => event.recurringEventId || event.id))].sort();
        if (!masterIds.length) {
          const controlOutcome = await this.recurrenceControlOutcome(profile, { taskId: task.id });
          const outcome = controlOutcome === "excluded" ? "excluded"
            : !todoistRecurrenceToRrule(task) ? "unsupported" : "unverified";
          await this.state.audit(profile, "todoist_recurrence_provider_correlation_missing", {
            taskId: task.id, outcome,
          });
          recordOutcome(outcome);
          continue;
        }
        if (masterIds.length > 1) {
          await this.state.audit(profile, "calendar_recurrence_provider_correlation_ambiguous", {
            taskId: task.id, candidateCount: masterIds.length,
          });
          recordOutcome("blocked");
          continue;
        }
        let master: CalendarEvent;
        try { master = await calendar.getEvent(masterIds[0]); }
        catch (error) {
          if (calendarEventGoneOnDirectRead(error)) { recordOutcome("stale"); continue; }
          throw error;
        }
        if (master.status === "cancelled" || !master.recurrence?.length
          || master.extendedProperties?.shared?.taskId !== task.id) { recordOutcome("stale"); continue; }
        const receivedAt = new Date().toISOString();
        if (master.extendedProperties.shared.syncSeriesId === task.id) {
          const delivery: Delivery = {
            id: `snapshot-reconcile:${profile}:todoist-series:${task.id}:${task.updated_at || receivedAt}`,
            kind: "todoist", profile, mode: "aws", receivedAt,
            headers: { "x-todoist-calendar-sync-reconcile": "true" },
            body: JSON.stringify({ event_name: "item:updated", event_data: task,
              event_data_extra: { old_item: task } }),
          };
          await this.processTodoist(delivery, { reconciliation: true });
          recordOutcome(await this.verifyTodoistSeriesPair(profile, task.id, master.id, calendar, todoist, {
            taskUpdatedAt: task.updated_at, masterUpdated: master.updated,
          }));
        } else {
          const delivery: Delivery = {
            id: `snapshot-reconcile:${profile}:calendar-series:${master.id}:${receivedAt}`,
            kind: "calendar", profile, mode: "aws", receivedAt, headers: {},
            body: JSON.stringify({ kind: "calendar", event: master }),
          };
          recordOutcome(await this.applyCalendarSeries(delivery, master, todoist));
        }
      }
    }
    await this.state.audit(profile, "calendar_recurrence_reconciliation_summary", { ...outcomes });
    return outcomes;
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
    for (const event of delta.items) {
      let replayVerified = false;
      try {
        await this.applyCalendarEvent(delivery, event, calendar, todoist, () => { replayVerified = true; });
        // Returning a diagnostic is not proof that a prior mutation converged.
        // Only explicitly verified item outcomes can release an attempted-write
        // boundary; the worker retains uncertainty across subsequent items.
        this.onCalendarItemCompleted?.(replayVerified);
      } catch (error) {
        if (error instanceof ReconciliationItemError) throw error;
        throw new ReconciliationItemError(error, {
          stage: "calendar",
          eventId: event.id,
          taskId: event.extendedProperties?.shared?.taskId,
          seriesId: event.recurringEventId || event.iCalUID,
        });
      }
    }
    // Advance only after every event delta has been processed successfully.
    if (delta.nextSyncToken) await this.state.putSyncToken(delivery.profile, delta.nextSyncToken);
    await this.state.audit(delivery.profile, "calendar_delta_processed", { deliveryId: delivery.id, count: delta.items.length, mode: delivery.mode });
  }

  private async applyCalendarEvent(delivery: Delivery, event: CalendarEvent, calendar: GoogleCalendar,
    todoist: Todoist, markReplayVerified: () => void): Promise<void> {
    // Historical masters and ALL their instances are immutable history. Google
    // instance deltas do not always inherit the parent's shared properties;
    // resolve that identity before any provider mutation.
    let archived = event.extendedProperties?.shared?.syncHistoryOnly === "true";
    if (archived) {
      return this.state.audit(delivery.profile, "calendar_archived_series_delta_ignored", {
        eventId: event.id, masterEventId: event.recurringEventId || event.id,
      });
    }
    // Most historical one-offs are irrelevant. Check the supplied Calendar
    // shape before any event-specific DynamoDB lookup (including a completion
    // marker). The existing elapsed-event policy already ignores these edits.
    if (event.status === "confirmed" && !event.recurringEventId && !event.recurrence?.length) {
      const timeZone = event.end?.date && !event.end.dateTime && calendar.getTimeZone
        ? await calendar.getTimeZone() : undefined;
      if (ignorableElapsedStandaloneCalendarEvent(event, Date.now(), timeZone)) {
        return this.state.audit(delivery.profile, "calendar_elapsed_standalone_event_ignored", {
          eventId: event.id, end: event.end?.dateTime || event.end?.date,
          ...(timeZone ? { timeZone } : {}),
        });
      }
    }
    if (event.status === "cancelled" && !event.recurringEventId && !event.iCalUID) {
      // Cancellation deltas can omit the master pointer. Re-read only this
      // exact Calendar resource and use its returned immutable series ID when
      // Google still exposes it; never infer a series from title/date.
      try {
        const current = await calendar.getEvent(event.id);
        if (current.id === event.id && current.status === "cancelled"
          && (current.recurringEventId || current.iCalUID)) event = current;
      } catch (error) {
        if (!calendarEventGoneOnDirectRead(error)) throw error;
      }
    }
    let ownershipEvent = event;
    const inventoryProjectId = profiles[delivery.profile].todoistProjectId;
    const projectMappingIndex = typeof todoist.getProjectMappingIndex === "function"
      ? await todoist.getProjectMappingIndex(inventoryProjectId)
      : buildProjectMappingIndex(await todoist.listProjectComments(inventoryProjectId));
    const providerCandidates = projectMappingIndex.parsed.filter(entry =>
      entry.payload.profile === delivery.profile
      && entry.payload.projectId === profiles[delivery.profile].todoistProjectId
      && (entry.payload.eventId === event.id
        || Boolean(event.recurringEventId && entry.payload.masterEventId === event.recurringEventId)))
      .sort((a, b) => b.payload.mappingRevision - a.payload.mappingRevision
        || Date.parse(b.payload.updatedAt) - Date.parse(a.payload.updatedAt));
    const providerIdentities = new Set(providerCandidates.map(entry => JSON.stringify([
      entry.payload.taskId, entry.payload.masterEventId || entry.payload.eventId,
    ])));
    if (providerIdentities.size > 1) return this.state.audit(delivery.profile,
      "calendar_provider_mapping_correlation_ambiguous", { eventId: event.id, candidateCount: providerIdentities.size });
    let mapping = providerCandidates[0] ? mappingFromProjectMappingComment(providerCandidates[0])
      : this.mappingFromCalendarCorrelation(delivery.profile, event);
    if (!mapping && event.status === "cancelled" && !event.recurringEventId)
      mapping = await this.providerMappingByEvent(delivery.profile, event.id, todoist);
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
        if (!mapping) mapping = this.mappingFromCalendarCorrelation(delivery.profile, parent);
        if (event.status !== "cancelled" && (parent.status === "cancelled" || !parent.recurrence?.length)) {
          return this.state.audit(delivery.profile,"calendar_stale_series_instance_ignored",{eventId:event.id,masterEventId:parent.id});
        }
        archived = parent.extendedProperties?.shared?.syncHistoryOnly === "true";
      }
    }
    if (event.status === "cancelled" && knownMasterEventId
      && mapping?.activeInstanceId !== event.id) {
      const currentSeries = projectMappingIndex.parsed.filter(entry =>
        entry.payload.profile === delivery.profile
        && entry.payload.projectId === profiles[delivery.profile].todoistProjectId
        && entry.payload.masterEventId === knownMasterEventId)
        .sort((a, b) => b.payload.mappingRevision - a.payload.mappingRevision
          || Date.parse(b.payload.updatedAt) - Date.parse(a.payload.updatedAt));
      const identities = new Set(currentSeries.map(entry => JSON.stringify([
        entry.payload.taskId, entry.payload.masterEventId,
      ])));
      if (identities.size > 1) return this.state.audit(delivery.profile,
        "calendar_project_mapping_master_correlation_ambiguous", { eventId: event.id, masterEventId: knownMasterEventId });
      if (currentSeries[0]) mapping = mappingFromProjectMappingComment(currentSeries[0]);
    }
    if (archived) {
      return this.state.audit(delivery.profile, "calendar_archived_series_delta_ignored", {
        eventId: event.id, masterEventId: event.recurringEventId || event.id,
      });
    }
    mapping ||= await this.providerMappingByEvent(delivery.profile, event.id, todoist);
    if (!mapping) {
      const candidates = (projectMappingIndex.byEventId.get(event.id) || []).filter(entry =>
        entry.payload.profile === delivery.profile
        && entry.payload.projectId === profiles[delivery.profile].todoistProjectId);
      const identities = new Set(candidates.map(entry => JSON.stringify([
        entry.payload.taskId, entry.payload.seriesId || entry.payload.masterEventId || entry.payload.eventId,
      ])));
      if (identities.size > 1) return this.state.audit(delivery.profile,
        "calendar_project_mapping_correlation_ambiguous", { eventId: event.id, candidates: identities.size });
      const candidate = candidates.sort((a,b) => b.payload.mappingRevision - a.payload.mappingRevision
        || Date.parse(b.payload.updatedAt) - Date.parse(a.payload.updatedAt))[0];
      if (candidate) {
        const recovered = mappingFromProjectMappingComment(candidate);
        const shared = event.extendedProperties?.shared || ownershipEvent.extendedProperties?.shared;
        if (recovered.calendarId && recovered.calendarId !== profiles[delivery.profile].calendarId
          || shared?.syncProfile && shared.syncProfile !== delivery.profile
          || shared?.syncCalendarId && shared.syncCalendarId !== profiles[delivery.profile].calendarId
          || shared?.syncTaskId && shared.syncTaskId !== recovered.taskId
          || shared?.taskId && shared.taskId !== recovered.taskId)
          return this.state.audit(delivery.profile, "calendar_project_mapping_provider_mismatch", { eventId: event.id });
        mapping = recovered;
        await this.persistProviderMapping(recovered);
        await this.state.audit(delivery.profile, "calendar_project_mapping_recovered", {
          eventId: event.id, taskId: recovered.taskId, seriesId: recovered.seriesId,
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
    let parentMapping = event.recurringEventId && mapping?.masterEventId === event.recurringEventId
      ? mapping
      : event.recurringEventId
        ? await this.providerMappingByEvent(delivery.profile, event.recurringEventId, todoist)
        : undefined;
    if (!parentMapping && event.recurringEventId) {
      const candidates = projectMappingIndex.parsed.filter(entry =>
        entry.payload.profile === delivery.profile
        && entry.payload.projectId === profiles[delivery.profile].todoistProjectId
        && entry.payload.masterEventId === event.recurringEventId);
      const identities = new Set(candidates.map(entry => JSON.stringify([
        entry.payload.taskId, entry.payload.seriesId || entry.payload.masterEventId,
      ])));
      if (identities.size > 1) return this.state.audit(delivery.profile,
        "calendar_project_mapping_master_correlation_ambiguous", { eventId: event.id, masterEventId: event.recurringEventId });
      const candidate = candidates.sort((a,b) => b.payload.mappingRevision - a.payload.mappingRevision
        || Date.parse(b.payload.updatedAt) - Date.parse(a.payload.updatedAt))[0];
      if (candidate) {
        parentMapping = mappingFromProjectMappingComment(candidate);
        if (parentMapping.calendarId && parentMapping.calendarId !== profiles[delivery.profile].calendarId)
          return this.state.audit(delivery.profile, "calendar_project_mapping_calendar_mismatch", {
            eventId: event.id, masterEventId: event.recurringEventId,
          });
        await this.persistProviderMapping(parentMapping);
      }
    }
    const seriesId = event.iCalUID || event.recurringEventId || event.id;
    const existingRecurrenceLink = event.recurrence?.length || event.recurringEventId
      ? await this.providerSeriesMapping(delivery.profile, seriesId, todoist, event.recurringEventId)
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
    // Calendar occurrence resources do not always inherit the master's shared
    // extended properties. The exact readback master is an authoritative
    // fallback for provider-native task correlation.
    const linkedTaskId = event.extendedProperties?.shared?.taskId
      || ownershipEvent.extendedProperties?.shared?.taskId;
    if (await this.state.syncBlocked(delivery.profile, {
      taskId: mapping?.taskId || parentMapping?.taskId || linkedTaskId,
      eventId: event.id,
    })) {
      return this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", {
        eventId: event.id, taskId: mapping?.taskId || parentMapping?.taskId || linkedTaskId,
      });
    }
    if (!parentMapping && event.recurringEventId && linkedTaskId) {
      const candidate = await this.providerMappingByTask(delivery.profile, linkedTaskId, todoist);
      if (candidate?.masterEventId === event.recurringEventId) parentMapping = candidate;
    }
    const todoistOwnedInstance = Boolean(
      event.recurringEventId
      && (
        Boolean(event.extendedProperties?.shared?.todoistRecurrence)
        || isTodoistNativeSeries(parentMapping)
      ),
    );
    if (todoistOwnedInstance) {
      if (!parentMapping || !isTodoistNativeSeries(parentMapping)) {
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_instance_unbound", { eventId: event.id, masterEventId: event.recurringEventId, taskId: linkedTaskId });
      }
      if (event.id !== parentMapping.activeInstanceId) {
        return this.state.audit(
          delivery.profile,
          event.status === "cancelled" ? "todoist_recurrence_calendar_instance_cancelled_deferred" : "todoist_recurrence_calendar_instance_change_deferred",
          { eventId: event.id, masterEventId: event.recurringEventId, taskId: parentMapping.taskId, originalStart: recurrenceOriginalStart(event), effectiveStart: eventEffectiveStart(event) },
        );
      }
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_exception_suppressed", { eventId: event.id, taskId: parentMapping.taskId, mode: delivery.mode });
      }
      let task: TodoistTask;
      try {
        task = await todoist.getTask(parentMapping.taskId);
      } catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_exception_task_missing", { eventId: event.id, taskId: parentMapping.taskId });
      }
      if (event.status === "cancelled") {
        const { calendar } = await this.clients(delivery.profile);
        const window = boundedRecurrenceWindow(parentMapping.activeEffectiveStart
          || eventEffectiveStart(event) || parentMapping.originalStart);
        if (!calendar.listInstancesInWindow || !window) {
          return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_instance_bounded_inventory_unavailable", {
            eventId: event.id, taskId: task.id, masterEventId: parentMapping.masterEventId,
          });
        }
        const instances = await calendar.listInstancesInWindow(parentMapping.masterEventId!, window.start, window.end);
        const next = selectNextEffectiveTodoistInstance(
          instances,
          parentMapping.activeInstanceId,
          parentMapping.activeEffectiveStart || eventEffectiveStart(event) || parentMapping.originalStart,
        );
        if (!next) {
          return this.state.audit(delivery.profile, "todoist_recurrence_calendar_active_instance_next_outside_bounded_window", {
            eventId: event.id, taskId: task.id, masterEventId: parentMapping.masterEventId,
          });
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
    if (event.recurringEventId && !todoistOwnedInstance && event.status !== "cancelled") {
      const calendarParentMapping = parentMapping?.masterEventId === event.recurringEventId
        ? parentMapping
        : mapping?.masterEventId === event.recurringEventId ? mapping : undefined;
      if (isCalendarNativeSeries(calendarParentMapping)) {
        return this.applyCalendarOwnedInstanceChange(delivery, event, calendarParentMapping, calendar, todoist);
      }
    }
    if (event.recurrence?.length && !event.recurringEventId && event.status !== "cancelled") {
      await this.applyCalendarSeries(delivery, event, todoist);
      return;
    }
    if (event.status === "cancelled") {
      const todoistNativeMaster = Boolean(mapping && mapping.masterEventId === event.id
        && (event.extendedProperties?.shared?.todoistRecurrence
          || event.extendedProperties?.shared?.todoistPhaseBVersion === "1"
          || mapping.seriesId === mapping.taskId));
      if (todoistNativeMaster && mapping) {
        if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
          return this.state.audit(delivery.profile, "calendar_recurrence_master_delete_suppressed", { eventId: event.id, taskId: mapping.taskId, mode: delivery.mode });
        }
        const sharedTaskId = event.extendedProperties?.shared?.taskId;
        if (sharedTaskId && sharedTaskId !== mapping.taskId) {
          return this.state.audit(delivery.profile, "calendar_recurrence_master_delete_identity_conflict", {
            eventId: event.id, taskId: mapping.taskId, correlatedTaskId: sharedTaskId,
          });
        }
        let task: TodoistTask | undefined;
        try { task = await todoist.getTask(mapping.taskId); }
        catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
        if (task) {
          await todoist.deleteTask(task.id);
          await this.state.recordMutation(delivery.profile);
        }
        const projectId = profiles[delivery.profile].todoistProjectId;
        const projectComments = await todoist.listProjectComments(projectId, true);
        await deleteExactTaskProjectMappingComments(todoist, projectComments, {
          profile: delivery.profile,
          projectId,
          taskId: mapping.taskId,
          eventIds: [event.id, mapping.eventId],
        });
        const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, mapping.taskId, calendar, event.id);
        return this.state.audit(delivery.profile, "calendar_recurrence_master_deleted_counterpart", {
          eventId: event.id, taskId: mapping.taskId, removedHistory,
        });
      }

      // Cancelled Google exceptions can omit iCalUID and shared properties.
      // Resolve the persisted series before acting on any occurrence mapping.
      const series = (isCalendarNativeSeries(mapping) && mapping?.seriesId)
        || event.iCalUID || event.recurringEventId || event.id;
      let existingRecurrence = await this.providerSeriesMapping(delivery.profile, series, todoist, event.recurringEventId);
      if (existingRecurrence && existingRecurrence.seriesId !== existingRecurrence.taskId && existingRecurrence.masterEventId) {
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
          // later occurrence still owns the task before changing correlation.
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
          const activeMapping = await this.providerMappingByEvent(delivery.profile, activeInstanceId, todoist);
          if (!activeMapping || activeMapping.taskId !== existingRecurrence.taskId
            || activeMapping.eventId !== activeInstanceId
            || !isCalendarNativeSeries(activeMapping)
            || activeMapping.seriesId !== existingRecurrence.seriesId
            || activeMapping.masterEventId !== existingRecurrence.masterEventId
            || (mapping && (!isCalendarNativeSeries(mapping)
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
          const staleMapping = mapping?.eventId === event.id ? mapping : undefined;
          const removed = staleMapping ? await deleteMappingComments(todoist, staleMapping) : 0;
          if (removed) await this.state.recordMutation(delivery.profile);
          return this.state.audit(delivery.profile,
            removed ? "calendar_recurrence_earlier_instance_cancellation_honored"
              : "calendar_recurrence_earlier_instance_cancellation_noop",
            { seriesId: existingRecurrence.seriesId, eventId: event.id, activeInstanceId,
              taskId: existingRecurrence.taskId, oldStart, activeStart, stateChanged: Boolean(removed) });
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
          if (native && !calendar.listInstancesInWindow) {
            return this.state.audit(delivery.profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
              seriesId: series, masterEventId: master.id,
            });
          }
          const instances = finiteWeekly
            ? await calendar.listInstances(master.id)
            : await listBoundedRecurrenceInstances(calendar, master.id, anchor);
          successorRule = finiteWeekly || native
            ? await verifiedCalendarOwnedRecurrence(master, instances, timeZone,
              calendar.listExplicitSeriesExceptions?.bind(calendar))
            : undefined;
          next = selectCalendarRecurrenceInstance(instances, existingRecurrence, Date.now(), timeZone);
        }
        if (deletingMaster) {
          await todoist.deleteTask(existingRecurrence.taskId).catch((error: unknown) => {
            if (Number((error as { status?: number }).status) !== 404) throw error;
          });
          const projectId = profiles[delivery.profile].todoistProjectId;
          await deleteExactTaskProjectMappingComments(todoist, await todoist.listProjectComments(projectId, true), {
            profile: delivery.profile, projectId, taskId: existingRecurrence.taskId,
            eventIds: [existingRecurrence.eventId, event.id],
          });
          await this.state.recordMutation(delivery.profile);
          return this.state.audit(delivery.profile, "calendar_recurrence_master_deleted", { seriesId: series });
        }
        if (!next) {
          // An empty lookahead is not proof that an open-ended series ended.
          return this.state.audit(delivery.profile, "calendar_recurrence_instance_deleted_no_next", { seriesId: series });
        }
        if (!successorRule) {
          return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
            seriesId: series, eventId: next.id, masterEventId: existingRecurrence.masterEventId,
            taskId: existingRecurrence.taskId, reason: "cancelled_occurrence_cannot_be_represented_natively",
            existingMirrorPreserved: true, outcome: "source_left_unchanged", nonBlocking: true,
          });
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
        const nextTask = previousTask?.due?.is_recurring
          ? await todoist.updateRecurringOccurrence(previousTask, toTodoistTask(next))
          : await todoist.upsertTask(calendarOwnedRecurringTaskPayload(next, successorRule, verifiedTimeZone), previousTask?.id, calendarReplaySourceIds(next));
        if (!matchesCalendarOwnedRecurringTask(nextTask, next, successorRule, verifiedTimeZone)) {
          return this.state.audit(delivery.profile, "calendar_recurrence_todoist_readback_mismatch", {
            seriesId: series, eventId: next.id, taskId: nextTask.id, reason: "cancelled_instance_reanchoring",
          });
        }
        const nextMapping: Mapping = {
          profile: delivery.profile,
          eventId: next.id,
          taskId: nextTask.id,
          seriesId: existingRecurrence.seriesId,
          masterEventId: existingRecurrence.masterEventId,
          activeInstanceId: next.id,
          originalStart: recurrenceOriginalStart(next),
          activeEffectiveStart: eventEffectiveStart(next),
          ...(existingRecurrence.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
          ...(existingRecurrence.completedThroughOriginalStart ? { completedThroughOriginalStart: existingRecurrence.completedThroughOriginalStart } : {}),
          updatedAt: new Date().toISOString(),
        };
        await this.persistProviderMapping(nextMapping);
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "calendar_recurrence_instance_deleted_rolled", { seriesId: series, eventId: next.id, taskId: nextTask.id });
      }
      // An unbound/legacy cancelled series instance must never fall through
      // to the standalone deletion path and delete the still-live Todoist task.
      if (event.recurringEventId && isCalendarNativeSeries(mapping)) {
        return this.state.audit(delivery.profile, "calendar_recurrence_unbound_instance_cancellation_deferred", {
          eventId: event.id, masterEventId: event.recurringEventId, taskId: mapping.taskId,
        });
      }
      if (!mapping) return;
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) return this.state.audit(delivery.profile, "calendar_delete_suppressed", { eventId: event.id, mode: delivery.mode });
      if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
      // #369: a cancelled legacy event must not delete an active annually
      // recurring Todoist task while its source-driven replacement is being
      // created (including late Calendar deltas read before the reset).
      const pending = await this.state.getCancelledAnnualRecoveryReceipt?.(delivery.profile,mapping.taskId);
      let currentTask: TodoistTask | undefined;
      try {currentTask=await todoist.getTask(mapping.taskId);}
      catch(error) {if(Number((error as {status?:number}).status)!==404)throw error;}
      const recoveryLock = currentTask && await this.state.getCancelledAnnualRecoveryLock?.(delivery.profile,mapping.taskId);
      const newerSourceWithProof = Boolean(recoveryLock && currentTask
        && !currentTask.is_completed && !currentTask.is_deleted && !currentTask.completed_at
        && recoveryPolicyForTask(currentTask) && currentTask.updated_at
        && event.updated && Date.parse(currentTask.updated_at)>Date.parse(event.updated)
        && profileForTodoistProject(currentTask.project_id)===delivery.profile);
      // Preserve the previously validated annual backward-compatibility fence.
      const newerAnnual = Boolean(currentTask && !currentTask.is_completed && !currentTask.is_deleted
        && currentTask.due?.is_recurring && todoistRecurrenceToRrule(currentTask)==="RRULE:FREQ=YEARLY"
        && currentTask.updated_at && mapping.updatedAt
        && Date.parse(currentTask.updated_at)>Date.parse(mapping.updatedAt)
        && (!event.updated || Date.parse(currentTask.updated_at)>Date.parse(event.updated)));
      if ((pending && pending.oldEventId===mapping.eventId) || newerAnnual || newerSourceWithProof) {
        return this.state.audit(delivery.profile,"calendar_cancelled_annual_todoist_protected",{
          taskId:mapping.taskId,eventId:mapping.eventId,pendingReset:Boolean(pending),
        });
      }
      try {
        await todoist.deleteTask(mapping.taskId);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        await this.scheduleOrphan?.(delivery, event.id, mapping.taskId);
        return this.state.audit(delivery.profile, "calendar_orphan_recheck_scheduled", { eventId: event.id, taskId: mapping.taskId });
      }
      const projectId = profiles[delivery.profile].todoistProjectId;
      await deleteExactTaskProjectMappingComments(todoist, await todoist.listProjectComments(projectId, true), {
        profile: delivery.profile, projectId, taskId: mapping.taskId,
        eventIds: [mapping.eventId, event.id],
      });
      await this.state.recordMutation?.(delivery.profile);
      return this.state.audit(delivery.profile, "calendar_deleted_task", { eventId: event.id, taskId: mapping.taskId });
    }
    if (event.status && event.status !== "confirmed") return;

    let task: TodoistTask | undefined;
    const mappedTaskId = mapping?.taskId;
    if (mapping) {
      try { task = await todoist.getTask(mapping.taskId, false); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; mapping = undefined; }
    }
    if (!task && linkedTaskId && linkedTaskId !== mappedTaskId) {
      try { task = await todoist.getTask(linkedTaskId, false); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    }
    if (!task && !mapping && !linkedTaskId) {
      const candidates = compatibleTodoistOneOffCandidatesForCalendar(event,
        await todoist.listTasks(profiles[delivery.profile].todoistProjectId), delivery.profile);
      if (candidates.length > 1) {
        return this.state.audit(delivery.profile, "calendar_provider_pair_ambiguous", {
          eventId: event.id, candidateTaskIds: candidates.map(candidate => candidate.id).sort(),
          reason: "multiple_exact_compatible_tasks",
        });
      }
      if (candidates.length === 1) {
        const [liveEvent, liveTask] = await Promise.all([
          calendar.getEvent(event.id), todoist.getTask(candidates[0].id),
        ]);
        const shared = liveEvent.extendedProperties?.shared || {};
        const sharedIds = [shared.taskId, shared.syncTaskId].filter((id): id is string => Boolean(id));
        if (liveEvent.id !== event.id
          || sharedIds.some(id => id !== liveTask.id)
          || compatibleTodoistOneOffCandidatesForCalendar(liveEvent, [liveTask], delivery.profile).length !== 1) {
          return this.state.audit(delivery.profile, "calendar_provider_pair_candidate_changed", {
            eventId: event.id, taskId: candidates[0].id,
          });
        }
        event = liveEvent;
        task = liveTask;
      }
    }
    const policyCandidate = task;
    // A fully bound standalone pair can prove identity in its own project.
    // Legacy, moved, ambiguous, recurring and partially linked pairs retain
    // the existing cross-profile discovery and guarded repair paths.
    const shared = event.extendedProperties?.shared || {};
    const taskEntries = task ? projectMappingIndex.byTaskId.get(task.id) || [] : [];
    // A flattened annual series may retain its moved final occurrence as
    // the exact counterpart of a one-off task. Admit only the all-day,
    // single-rule, explicitly capped shape with no surviving series mapping.
    // The ordinary exact local provider and baseline checks still apply.
    const cappedOriginal = event.originalStartTime?.date;
    const cappedRule = ownershipEvent.recurrence?.[0];
    const capMatch = cappedRule?.match(/^RRULE:FREQ=YEARLY;(?:UNTIL=(\d{8})(?:;INTERVAL=1)?|INTERVAL=1;UNTIL=(\d{8}))$/i);
    const exactCappedOccurrence = Boolean(event.status === "confirmed" && event.recurringEventId
      && ownershipEvent.id === event.recurringEventId && ownershipEvent.status === "confirmed"
      && ownershipEvent.recurrence?.length === 1 && capMatch
      && !ownershipEvent.recurringEventId && !originProfile
      && cappedOriginal && !event.originalStartTime?.dateTime
      && /^\d{4}-\d{2}-\d{2}$/.test(cappedOriginal)
      && cappedOriginal.replace(/-/g, "") === (capMatch[1] || capMatch[2])
      && event.start?.date && !event.start.dateTime
      && event.start.date >= cappedOriginal
      && !parentMapping && !existingRecurrenceLink
      && !shared.todoistRecurrence && !shared.syncSeriesId && !shared.syncMasterEventId
      && !shared.syncActiveInstanceId && !shared.syncProgressVersion && !shared.syncTodoistPhaseBVersion
      && (!ownershipEvent.extendedProperties?.shared?.taskId
        || ownershipEvent.extendedProperties.shared.taskId === task?.id)
      && (!ownershipEvent.extendedProperties?.shared?.syncTaskId
        || ownershipEvent.extendedProperties.shared.syncTaskId === task?.id)
      && (!ownershipEvent.extendedProperties?.shared?.syncProfile
        || ownershipEvent.extendedProperties.shared.syncProfile === delivery.profile)
      && (!ownershipEvent.extendedProperties?.shared?.syncCalendarId
        || ownershipEvent.extendedProperties.shared.syncCalendarId === profiles[delivery.profile].calendarId));
    const exactLocalPair = Boolean(task && mapping && (!event.recurringEventId || exactCappedOccurrence) && !event.recurrence?.length
      && !task.due?.is_recurring && !task.is_deleted && !task.is_completed && !task.completed_at
      && !mapping.masterEventId && !mapping.seriesId && !mapping.activeInstanceId
      && task.project_id === inventoryProjectId && mapping.projectId === inventoryProjectId
      && mapping.calendarId === profiles[delivery.profile].calendarId
      && mapping.taskId === task.id && mapping.eventId === event.id
      && taskEntries.length === 1 && taskEntries[0].payload.schemaVersion === 2
      && taskEntries[0].comment.id === mapping.projectCommentId
      && taskEntries[0].payload.profile === delivery.profile
      && taskEntries[0].payload.projectId === inventoryProjectId
      && shared.syncSchemaVersion === "2" && shared.syncProfile === delivery.profile
      && shared.syncCalendarId === profiles[delivery.profile].calendarId
      && shared.syncEventId === event.id && shared.taskId === task.id && shared.syncTaskId === task.id
      && shared.syncSource === undefined && shared.syncRecurrenceOwner === undefined);
    if (task && !(exactLocalPair && hasCanonicalState(event, task))) {
      const owner = await this.providerMappingByTaskAnyProfile(task.id);
      if (owner && (owner.profile !== delivery.profile || ![owner.eventId,owner.masterEventId,owner.activeInstanceId].includes(event.id))) {
        return this.state.audit(delivery.profile,"calendar_task_link_ambiguous_conflict",{eventId:event.id,taskId:task.id,ownerProfile:owner.profile,mappedEventId:owner.eventId});
      }
    }
    if (policyCandidate && await this.state.syncBlocked(delivery.profile, { taskId:policyCandidate.id, eventId:event.id }, !mapping)) {
      return this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", { eventId:event.id, taskId:policyCandidate.id });
    }
    if (!mapping && await this.state.syncBlocked(delivery.profile, { eventId:event.id }, true)) {
      return this.state.audit(delivery.profile, "calendar_deleted_conflict_review_blocked", { eventId:event.id });
    }
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      return this.state.audit(delivery.profile, "calendar_mutation_suppressed", { eventId: event.id, taskId: task?.id, mode: delivery.mode });
    }
    if (await this.calendarMutationBlockedByCompletion(delivery, event.id)) return;
    if (task && hasCanonicalState(event, task)) {
      const baseline = providerSyncBaseline(task, event);
      if (exactLocalPair && mapping?.syncBaseline
        && JSON.stringify(mapping.syncBaseline.todoist) === JSON.stringify(baseline.todoist)
        && JSON.stringify(mapping.syncBaseline.calendar) === JSON.stringify(baseline.calendar)
        && mapping.syncedTitle === normalizedText(event.summary)
        && mapping.syncedDescription === normalizedDescription(event.description)
        && mapping.syncedDue === (event.start?.dateTime || event.start?.date)) {
        return this.state.audit(delivery.profile, "calendar_noop_canonical_state", { eventId: event.id, taskId: task.id });
      }
      const nextMapping: Mapping = {
        ...(mapping || {}),
        profile: delivery.profile,
        eventId: event.id,
        taskId: task.id,
        projectId: task.project_id || mapping?.projectId || profiles[delivery.profile].todoistProjectId,
        updatedAt: new Date().toISOString(),
      };
      await this.persistProviderMapping(nextMapping);
      await this.state.audit(delivery.profile, "calendar_noop_canonical_state", { eventId: event.id, taskId: task.id });
      markReplayVerified();
      return;
    }
    if (task) {
      // Cached evidence is only sufficient to discard an unchanged echo.
      // Recheck an existing candidate before any provider mutation.
      await verifyCalendarDeltaTaskUnchanged(todoist, task);
    }
    const nextTask = await todoist.upsertTask(toTodoistTask(event), task?.id, calendarReplaySourceIds(event));
    const knownCommentId = mapping?.projectCommentId || mapping?.commentId;
    const existingComment = knownCommentId ? { id: knownCommentId } : await todoist.findComment(nextTask.id, event.id);
    const projectId = nextTask.project_id || mapping?.projectId || profiles[delivery.profile].todoistProjectId;
    const draftMapping: Mapping = {
      ...(mapping || {}),
      profile: delivery.profile,
      calendarId: profiles[delivery.profile].calendarId,
      eventId: event.id,
      taskId: nextTask.id,
      projectId,
      syncedTitle: normalizedText(event.summary),
      syncedDescription: normalizedDescription(event.description),
      updatedAt: new Date().toISOString(),
    };
    const comment = await todoist.upsertComment(nextTask.id, taskComment(event), existingComment?.id, draftMapping);
    const referenceMapping = existingComment?.id && !draftMapping.projectCommentId && !draftMapping.commentId
      ? { ...draftMapping, commentId: existingComment.id }
      : draftMapping;
    const nextMapping = attachProjectCommentReference(referenceMapping, projectId, comment.id);
    await this.persistProviderMapping(nextMapping);
    await this.state.recordMutation(delivery.profile);
    await this.state.audit(delivery.profile, task ? "calendar_updated_task" : "calendar_created_task", { eventId: event.id, taskId: nextTask.id });
    // Both native links have independently verified and mutation accounting
    // has finished. A subsequent delta replay must rediscover this exact pair.
    markReplayVerified();
  }

  /**
   * Recover only an exact, same-cadence all-day weekly Google split. The
   * deterministic Google successor ID alone is NOT authority: require
   * independent provider-native task correlation or reciprocal split lineage,
   * a unique versioned project comment, and a non-overlapping history cap.
   * No provider create/delete or recurrence/date mutation is permitted here.
   */
  private async repairStaleWeeklySplit(
    delivery: Delivery, stale: Mapping, master: CalendarEvent, active: CalendarEvent,
    task: TodoistTask, recurrence: CalendarOwnedTodoistRecurrence, timeZone: string | undefined,
    calendar: GoogleCalendar, todoist: Todoist,
  ): Promise<boolean> {
    const profile = delivery.profile;
    const { calendarId, todoistProjectId: projectId } = profiles[profile];
    const oldId = stale.masterEventId;
    const decline = async (reason: string): Promise<false> => {
      await this.state.audit(profile, "calendar_split_mapping_repair_blocked", {
        taskId: task.id, oldMasterEventId: oldId, masterEventId: master.id, eventId: active.id, reason,
      });
      return false;
    };
    if (!oldId || oldId === master.id || stale.eventId !== oldId
      || stale.profile !== profile || stale.calendarId !== calendarId || stale.projectId !== projectId
      || stale.taskId !== task.id || stale.seriesId !== task.id || !stale.projectCommentId
      || !Number.isSafeInteger(stale.mappingRevision) || !stale.mappingRevision
      || stale.calendarProgressVersion || stale.todoistPhaseBVersion || stale.completedThroughOriginalStart
      || !calendar.listLinkedEventsByTodoistTaskId || !calendar.listExplicitSeriesExceptions
      || !calendar.listInstancesInWindow || !calendar.updateSharedEventPropertiesIfUnchanged
      || !todoist.updateComment || !todoist.updateTaskMetadata) return decline("unsupported_mapping_shape");
    const ids = [oldId, master.id, active.id];
    const allowed = async () => modeAllowsMutations(delivery, await this.state.mutationAllowed(profile))
      && !(await this.state.syncBlocked(profile, { taskId: task.id, eventId: oldId }))
      && !(await this.state.syncBlocked(profile, { taskId: task.id, eventId: master.id }))
      && !(await this.state.syncBlocked(profile, { taskId: task.id, eventId: active.id }))
      && !(await this.calendarMutationBlockedByCompletion(delivery, active.id));
    if (!await allowed()) return decline("sync_control_blocked");
    const [old, current, occurrence, liveTask] = await Promise.all([
      calendar.getEvent(oldId), calendar.getEvent(master.id), calendar.getEvent(active.id), todoist.getTask(task.id),
    ]);
    const date = (s: string | undefined) => {
      if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
      const t = Date.parse(s + "T00:00:00Z");
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : undefined;
    };
    const day = 86_400_000;
    const start = date(current.start?.date), oldStart = date(old.start?.date);
    const original = date(occurrence.originalStartTime?.date), effective = date(occurrence.start?.date);
    const weekly = (event: CalendarEvent, capped: boolean) => {
      if (event.recurrence?.length !== 1 || !event.recurrence[0].startsWith("RRULE:")) return undefined;
      const fields = new Map<string, string>();
      for (const part of event.recurrence[0].slice(6).split(";")) {
        const m = /^([A-Z]+)=([^;=]+)$/.exec(part);
        if (!m || fields.has(m[1]) || !["FREQ", "BYDAY", "INTERVAL", "WKST", "UNTIL"].includes(m[1])) return undefined;
        fields.set(m[1], m[2]);
      }
      const weekday = fields.get("BYDAY"), until = fields.get("UNTIL");
      if (fields.get("FREQ") !== "WEEKLY" || !weekday || !/^(SU|MO|TU|WE|TH|FR|SA)$/.test(weekday)
        || (fields.get("INTERVAL") || "1") !== "1" || (fields.get("WKST") || "MO") !== "MO"
        || (capped ? !until || !/^\d{8}$/.test(until) : until !== undefined)) return undefined;
      return { weekday, until };
    };
    const historicalRule = weekly(old, true), successorRule = weekly(current, false);
    if (old.id !== oldId || current.id !== master.id || occurrence.id !== active.id
      || old.status !== "confirmed" || current.status !== "confirmed" || occurrence.status !== "confirmed"
      || old.recurringEventId || current.recurringEventId || occurrence.recurringEventId !== current.id
      || !old.etag || !current.etag || !occurrence.etag || current.etag !== master.etag
      || !historicalRule || !successorRule || historicalRule.weekday !== successorRule.weekday
      || start === undefined || oldStart === undefined || original === undefined || effective === undefined
      || old.start?.dateTime || old.end?.dateTime || current.start?.dateTime || current.end?.dateTime
      || occurrence.start?.dateTime || occurrence.end?.dateTime || occurrence.originalStartTime?.dateTime
      || date(old.end?.date) !== oldStart + day || date(current.end?.date) !== start + day
      || date(occurrence.end?.date) !== effective + day || original !== effective || original < start
      || oldStart > start - 7 * day || (start - oldStart) % (7 * day) !== 0
      || (original - start) % (7 * day) !== 0
      || ["SU","MO","TU","WE","TH","FR","SA"][new Date(start).getUTCDay()] !== successorRule.weekday
      || historicalRule.until !== new Date(start - day).toISOString().slice(0, 10).replace(/-/g, "")
      || liveTask.id !== task.id || liveTask.project_id !== projectId || liveTask.is_completed
      || liveTask.is_deleted || liveTask.completed_at || !liveTask.due?.is_recurring
      || !sameCalendarDeltaTaskEvidence(task, liveTask)
      || !matchesCalendarOwnedRecurringTask(liveTask, occurrence, recurrence, timeZone)
      || normalizedText(current.summary) !== normalizedText(occurrence.summary)
      || normalizedDescription(current.description) !== normalizedDescription(occurrence.description))
      return decline("split_schedule_or_provider_version_unverified");
    const oldShared = old.extendedProperties?.shared || {};
    const shared = current.extendedProperties?.shared || {};
    const instanceShared = occurrence.extendedProperties?.shared || {};
    const previous = new Date(start - 7 * day).toISOString().slice(0, 10);
    const linked = (s: Record<string, string>) => s.taskId === task.id || s.syncTaskId === task.id;
    const exactHistory = oldShared.syncHistoryOnly === "true" && oldShared.syncHistoryTaskId === task.id
      && oldShared.syncHistorySuccessorId === current.id && oldShared.syncHistoryCutoff === previous;
    const reciprocal = exactHistory && shared.syncHistoryMasterId === oldId && shared.syncSplitVersion === "1";
    const googleSplit = current.id === oldId + "_R" + current.start!.date!.replace(/-/g, "")
      && (linked(oldShared) || exactHistory) && linked(shared);
    const foreign = (s: Record<string, string>) =>
      [s.taskId, s.syncTaskId, s.syncHistoryTaskId].some(id => Boolean(id && id !== task.id))
      || Boolean(s.syncProfile && s.syncProfile !== profile)
      || Boolean(s.syncCalendarId && s.syncCalendarId !== calendarId)
      || Boolean(s.syncSchemaVersion && s.syncSchemaVersion !== "2");
    if ((!reciprocal && !googleSplit) || foreign(oldShared) || foreign(shared) || foreign(instanceShared)
      || otherProfileCalendarOrganizer(profile, old) || otherProfileCalendarOrganizer(profile, current)
      || (oldShared.syncHistoryOnly !== undefined && !exactHistory)
      || (oldShared.syncHistorySuccessorId && oldShared.syncHistorySuccessorId !== current.id)
      || (shared.syncHistoryMasterId && shared.syncHistoryMasterId !== oldId)
      || (shared.syncHistoryCutoff && shared.syncHistoryCutoff !== previous)
      || (shared.syncHistoryOnly === "true")
      || [shared.syncMasterEventId, shared.syncEventId].some(id => Boolean(id && id !== oldId && id !== current.id)))
      return decline("split_lineage_unverified");

    // Without a baseline, the historical master is admissible only when the
    // task still agrees with that field (or already agrees with the successor).
    const content = normalizedText(current.summary), description = normalizedDescription(current.description);
    const safeField = (before: string | undefined, historical: string, actual: string, desired: string) =>
      actual === desired || actual === (before ?? historical);
    if (!safeField(stale.syncedTitle, normalizedText(old.summary), normalizedText(liveTask.content), content)
      || !safeField(stale.syncedDescription, normalizedDescription(old.description), normalizedDescription(liveTask.description), description))
      return decline("concurrent_metadata_edit");

    const [aliases, oldFuture, exceptions, owner, claims] = await Promise.all([
      calendar.listLinkedEventsByTodoistTaskId(task.id),
      calendar.listInstancesInWindow(oldId, new Date(start).toISOString(), new Date(Math.max(effective, start) + 8 * day).toISOString()),
      calendar.listExplicitSeriesExceptions(oldId),
      this.providerMappingByTaskAnyProfile(task.id),
      this.providerMappingsForCalendarIdentity(profile, ids, todoist),
    ]);
    const notHistorical = (e: CalendarEvent) => {
      const originalDate = date(e.originalStartTime?.date), effectiveDate = date(e.start?.date);
      return e.recurringEventId !== oldId || originalDate === undefined || originalDate >= start
        || (e.status !== "cancelled" && (effectiveDate === undefined || effectiveDate >= start));
    };
    const sameMapping = (m: Mapping | undefined) => Boolean(m && m.profile === profile
      && m.taskId === task.id && m.masterEventId === oldId && m.eventId === stale.eventId
      && m.projectCommentId === stale.projectCommentId && m.mappingRevision === stale.mappingRevision
      && m.updatedAt === stale.updatedAt);
    if (!sameMapping(owner) || claims.some(m => !sameMapping(m))
      || aliases.some(e => e.status !== "cancelled" && !ids.includes(e.id)
        && e.recurringEventId !== oldId && e.recurringEventId !== current.id)
      || oldFuture.some(notHistorical) || exceptions.some(notHistorical))
      return decline("competing_claim_or_future_history");
    const loadExact = async () => {
      const index = buildProjectMappingIndex(await todoist.listProjectComments(projectId, true));
      const entries = index.parsed.filter(e => e.payload.taskId === task.id
        || [e.payload.eventId, e.payload.masterEventId, e.payload.activeInstanceId].some(id => id && ids.includes(id)));
      if (entries.length !== 1 || entries[0].payload.schemaVersion !== 2
        || !sameMapping(mappingFromProjectMappingComment(entries[0]))
        || index.malformed.some(e => [task.id, ...ids].some(id => e.comment.content?.includes(id)))) return undefined;
      return entries[0];
    };
    const entry = await loadExact();
    if (!entry || !await allowed()) return decline("mapping_revision_or_controls_changed");
    const [oldCheck, newCheck, activeCheck, taskCheck] = await Promise.all([
      calendar.getEvent(oldId), calendar.getEvent(current.id), calendar.getEvent(occurrence.id), todoist.getTask(task.id),
    ]);
    if (oldCheck.etag !== old.etag || newCheck.etag !== current.etag || activeCheck.etag !== occurrence.etag
      || !sameCalendarDeltaTaskEvidence(liveTask, taskCheck)) return decline("provider_version_changed");

    // First stamp the successor (conditional PATCH), then archive the capped
    // history, then update metadata and the SAME project comment. A retry
    // after either PATCH still has the exact reciprocal lineage to resume.
    const nextShared: Record<string, string | null> = {
      taskId: task.id, syncTaskId: task.id, syncSchemaVersion: "2", syncProfile: profile,
      syncCalendarId: calendarId, syncEventId: current.id, syncSeriesId: task.id,
      syncMasterEventId: current.id, syncActiveInstanceId: occurrence.id,
      syncOriginalStart: occurrence.originalStartTime!.date!, syncActiveEffectiveStart: occurrence.start!.date!,
      syncHistoryMasterId: oldId, syncHistoryCutoff: previous, syncSplitVersion: "1",
      syncSource: null, syncRecurrenceOwner: null, syncCalendarNative: null,
    };
    const historyShared: Record<string, string | null> = {
      syncHistoryOnly: "true", syncHistoryTaskId: task.id, syncHistorySuccessorId: current.id,
      syncHistoryCutoff: previous, syncHistoryOriginalRule: current.recurrence![0],
    };
    for (const key of ["taskId", "syncTaskId", "taskUrl", "syncEventId", "syncSeriesId", "syncMasterEventId",
      "syncActiveInstanceId", "syncOriginalStart", "syncActiveEffectiveStart", "syncProgressVersion",
      "syncCompletedThrough", "syncTodoistPhaseBVersion", "todoistRecurrence", "todoistAnchorStart",
      "todoistAnchorEnd", "todoistAnchorAllDay", "todoistAnchorTimeZone", "todoistTemplateSummary",
      "todoistTemplateDescription", "todoistPhaseBVersion", "syncSource", "syncRecurrenceOwner", "syncCalendarNative"])
      historyShared[key] = null;
    const patch = async (event: CalendarEvent, desired: Record<string, string | null>) => {
      const props = event.extendedProperties?.shared || {};
      const changes = Object.fromEntries(Object.entries(desired).filter(([k,v]) => v === null ? props[k] !== undefined : props[k] !== v));
      if (Object.keys(changes).length) {
        await calendar.updateSharedEventPropertiesIfUnchanged(event.id, event.etag!, changes);
        await this.state.recordMutation(profile);
      }
      const read = await calendar.getEvent(event.id);
      if (read.id !== event.id || read.status !== "confirmed"
        || JSON.stringify(read.recurrence) !== JSON.stringify(event.recurrence)
        || JSON.stringify(read.start) !== JSON.stringify(event.start) || JSON.stringify(read.end) !== JSON.stringify(event.end)
        || normalizedText(read.summary) !== normalizedText(event.summary)
        || normalizedDescription(read.description) !== normalizedDescription(event.description)
        || Object.entries(desired).some(([k,v]) => v === null ? read.extendedProperties?.shared?.[k] !== undefined
          : read.extendedProperties?.shared?.[k] !== v))
        throw new Error("Weekly split correlation PATCH did not verify");
      return read;
    };
    const nextMaster = await patch(newCheck, nextShared);
    await patch(oldCheck, historyShared);
    if (!await allowed()) return decline("sync_control_changed_after_correlation");
    const beforeMetadata = await todoist.getTask(task.id);
    if (!sameCalendarDeltaTaskEvidence(liveTask, beforeMetadata)) return decline("task_changed_after_correlation");
    let nextTask = beforeMetadata;
    if (normalizedText(nextTask.content) !== content || normalizedDescription(nextTask.description) !== description) {
      nextTask = await todoist.updateTaskMetadata(task.id, { content, description });
      await this.state.recordMutation(profile);
      if (!sameCalendarDeltaTaskEvidence({ ...beforeMetadata, content, description }, nextTask))
        throw new Error("Weekly split Todoist metadata write did not verify");
    }
    const [latest, finalMaster, finalActive, finalTask] = await Promise.all([
      loadExact(), calendar.getEvent(current.id), calendar.getEvent(occurrence.id), todoist.getTask(task.id),
    ]);
    if (!latest || latest.comment.content !== entry.comment.content || finalMaster.etag !== nextMaster.etag
      || finalActive.recurringEventId !== current.id || finalActive.status !== "confirmed"
      || recurrenceOriginalStart(finalActive) !== recurrenceOriginalStart(occurrence)
      || eventEffectiveStart(finalActive) !== eventEffectiveStart(occurrence)
      || !sameCalendarDeltaTaskEvidence(nextTask, finalTask) || !await allowed())
      return decline("provider_or_mapping_changed_before_commit");
    const next: Mapping = {
      profile, calendarId, projectId, taskId: task.id, eventId: current.id, seriesId: task.id,
      masterEventId: current.id, activeInstanceId: occurrence.id,
      originalStart: occurrence.originalStartTime!.date, activeEffectiveStart: occurrence.start!.date,
      projectCommentId: stale.projectCommentId, mappingRevision: stale.mappingRevision! + 1,
      syncedTitle: content, syncedDescription: description, syncedDue: occurrence.start!.date,
      syncBaseline: providerSyncBaseline(finalTask, finalActive, finalMaster), updatedAt: new Date().toISOString(),
    };
    // Use exact comment update, not a create-on-403/404 compatibility fallback.
    await todoist.updateComment(stale.projectCommentId!, serializeMappingComment(next, projectId));
    await this.state.recordMutation(profile);
    const committed = buildProjectMappingIndex(await todoist.listProjectComments(projectId, true));
    const matches = committed.parsed.filter(e => e.payload.taskId === task.id);
    if (matches.length !== 1 || matches[0].comment.id !== stale.projectCommentId
      || matches[0].payload.mappingRevision !== next.mappingRevision || matches[0].payload.masterEventId !== current.id
      || matches[0].payload.eventId !== current.id || matches[0].payload.activeInstanceId !== occurrence.id)
      throw new Error("Weekly split mapping comment did not verify");
    await this.state.audit(profile, "calendar_split_mapping_repaired", {
      taskId: task.id, oldMasterEventId: oldId, masterEventId: current.id, eventId: occurrence.id,
    });
    return true;
  }

  private async applyCalendarSeries(delivery: Delivery, master: CalendarEvent, todoist: Todoist): Promise<RecurrenceReconciliationOutcome> {
    const { calendar } = await this.clients(delivery.profile);
    let providerChanged = false;
    // A queued delta can outlive a cancellation or a recurrence flattening.
    // Confirm the master still exists as a live series before recovering it.
    try { master = await calendar.getEvent(master.id); }
    catch (error) {
      if (!calendarEventGoneOnDirectRead(error)) throw error;
      await this.state.audit(delivery.profile, "calendar_recurrence_recovery_stale_master", { masterEventId: master.id });
      return "stale";
    }
    if (master.status === "cancelled" || !master.recurrence?.length || master.extendedProperties?.shared?.syncHistoryOnly === "true") {
      await this.state.audit(delivery.profile, "calendar_recurrence_recovery_stale_master", { masterEventId: master.id });
      return "stale";
    }
    if (await this.state.syncBlocked(delivery.profile, { eventId: master.id }, true)) {
      await this.state.audit(delivery.profile, "calendar_deleted_conflict_review_blocked", { masterEventId: master.id });
      return this.recurrenceControlOutcome(delivery.profile, { eventId: master.id });
    }
    const observedSeriesId = master.iCalUID || master.id;
    const existing = await this.providerSeriesMapping(delivery.profile, observedSeriesId, todoist, master.id);
    // Some provider reads omit iCalUID even though the exact master ID still
    // resolves its project-comment correlation. Keep the provider's stable
    // series identity when that happens instead of deriving a second series.
    const seriesId = existing?.seriesId || observedSeriesId;
    const finiteWeekly = finiteWeeklyCalendarRuleCandidate(master);
    // Supported rules are admitted from the current provider representation,
    // including exact legacy mirrors whose Calendar master is now representable.
    const nativeRecurrence = nativeCalendarRecurrenceCandidate(master);
    // Native unbounded recurrences must not expand forever. Preserve the
    // current mapped occurrence (which can be overdue) within a bounded lookahead.
    const from = existing?.activeEffectiveStart || existing?.originalStart
      || master.start?.dateTime || master.start?.date;
    if (nativeRecurrence && !calendar.listInstancesInWindow) {
      await this.state.audit(delivery.profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
        seriesId, masterEventId: master.id,
      });
      return "blocked";
    }
    const instances = finiteWeekly
      ? await calendar.listInstances(master.id)
      : await listBoundedRecurrenceInstances(calendar, master.id, from);
    const hasAllDayInstances = instances.some((instance) => instance.end?.date && !instance.end.dateTime);
    let calendarTimeZone = master.start?.timeZone;
    if (finiteWeekly || nativeRecurrence || hasAllDayInstances) {
      calendarTimeZone = await this.verifiedCalendarRecurrenceTimeZone(delivery.profile, calendar, todoist, master, {
        seriesId, masterEventId: master.id,
      });
      if (!calendarTimeZone) return "blocked";
    }
    const calendarRecurrence = (finiteWeekly || nativeRecurrence) && calendarTimeZone
      ? await verifiedCalendarOwnedRecurrence(master, instances, calendarTimeZone,
        calendar.listExplicitSeriesExceptions?.bind(calendar))
      : undefined;
    if (!calendarRecurrence) {
      await this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, reason: finiteWeekly
          ? "finite_weekly_rule_or_instance_inventory_not_representable" : nativeRecurrence ? "native_rule_or_complete_exception_inventory_not_representable" : "rrule_outside_supported_native_subset",
        existingMirrorPreserved: Boolean(existing || master.extendedProperties?.shared?.taskId),
        outcome: "source_left_unchanged",
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
    let active = selectCalendarRecurrenceInstance(instances, existing, Date.now(), calendarTimeZone);
    if (active && await this.state.syncBlocked(delivery.profile, { eventId: active.id }, true)) {
      await this.state.audit(delivery.profile, "calendar_deleted_conflict_review_blocked", { masterEventId: master.id, eventId: active.id });
      return this.recurrenceControlOutcome(delivery.profile, { eventId: active.id });
    }
    if (active && await this.state.syncBlocked(delivery.profile, { taskId:existing?.taskId, eventId:active.id })) {
      await this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", { eventId:active.id, taskId:existing?.taskId, masterEventId:master.id });
      return this.recurrenceControlOutcome(delivery.profile, { taskId: existing?.taskId, eventId: active.id });
    }
    if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      await this.state.audit(delivery.profile, "calendar_recurrence_mutation_suppressed", { seriesId, mode: delivery.mode });
      return "blocked";
    }
    const progressAware = existing?.calendarProgressVersion === 1;
    let task: TodoistTask | undefined;
    if (existing?.taskId) {
      try { task = await todoist.getTask(existing.taskId); }
      catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        await this.state.audit(delivery.profile, "calendar_recurrence_mapped_task_unavailable", {
          seriesId, masterEventId: master.id, taskId: existing.taskId,
          reason: "exact_correlated_task_missing; recreation_suppressed",
        });
        return "stale";
      }
      if (task.project_id !== profiles[delivery.profile].todoistProjectId) {
        await this.state.audit(delivery.profile, "calendar_recurrence_mapped_task_project_mismatch", {
          seriesId, masterEventId: master.id, taskId: task.id,
        });
        return "blocked";
      }
      if (task.is_deleted || task.is_completed || task.completed_at) {
        await this.state.audit(delivery.profile, "calendar_recurrence_mapped_task_terminal", {
          seriesId, masterEventId: master.id, taskId: task.id,
          completed: Boolean(task.is_completed || task.completed_at), deleted: Boolean(task.is_deleted),
        });
        return "stale";
      }
    }
    const sharedTaskIds = [...new Set([
      master.extendedProperties?.shared?.taskId, master.extendedProperties?.shared?.syncTaskId,
      active?.extendedProperties?.shared?.taskId, active?.extendedProperties?.shared?.syncTaskId,
    ].filter((id): id is string => Boolean(id)))];
    // The Calendar master or exact active instance can repair a missing
    // Todoist project mapping. Read only the task ID carried by that provider
    // object; never infer a replacement from title/date when correlation is
    // absent or disagrees.
    if (!task && sharedTaskIds.length === 1) {
      try {
        const linked = await todoist.getTask(sharedTaskIds[0]);
        if (linked.project_id === profiles[delivery.profile].todoistProjectId) task = linked;
      } catch (error) {
        if (Number((error as { status?: number }).status) !== 404) throw error;
      }
    }
    const projectTasks = await todoist.listTasks(profiles[delivery.profile].todoistProjectId);
    let discoveredTaskCandidate = false;
    if (!task && !existing && !sharedTaskIds.length && calendarRecurrence) {
      const compatible = await discoverCompatibleTodoistRecurringCandidatesForCalendar(master,
        calendarRecurrence, calendarTimeZone, projectTasks, delivery.profile, calendar);
      if (compatible.length > 1) {
        await this.state.audit(delivery.profile, "calendar_provider_pair_ambiguous", {
          masterEventId: master.id, eventId: active?.id || master.id,
          candidateTaskIds: compatible.map(candidate => candidate.task.id).sort(),
          reason: "multiple_exact_compatible_recurring_tasks",
        });
        return "blocked";
      }
      if (compatible.length === 1) {
        task = compatible[0].task;
        active = compatible[0].event;
        discoveredTaskCandidate = true;
      }
    }
    if (!active) {
      const currentInstances = finiteWeekly ? instances
        : await listBoundedRecurrenceInstances(calendar, master.id, new Date().toISOString());
      active = selectCalendarRecurrenceInstance(currentInstances, existing, Date.now(), calendarTimeZone);
    }
    if (!active) {
      await this.state.audit(delivery.profile, "calendar_recurrence_no_active_instance", { seriesId, masterEventId: master.id });
      return "blocked";
    }
    const candidates = recurringTaskIdentityCandidates(active, projectTasks);
    // An exact provider identity must never silently become a different task,
    // even when it belongs to another project/profile or is now a one-off.
    const conflictingIds = [...new Set(candidates.filter((id) => id !== task?.id).concat(sharedTaskIds.filter((id) => id !== task?.id)))];
    const exactCalendarRuleEdit = Boolean(task?.due?.is_recurring && task.due.string && calendarRecurrence
      && existing?.taskId === task.id && existing.masterEventId === master.id
      && (existing.seriesId === seriesId
        || existing.seriesId === task.id)
      && startsMatch(active, task)
      && !conflictingIds.length
      && !matchesCalendarOwnedRecurringRule(task, calendarRecurrence, calendarTimeZone));
    if (exactCalendarRuleEdit && task) {
      const providerMapping = await this.providerMappingByTask(delivery.profile, task.id, todoist);
      const linkVerified = providerMapping?.profile === delivery.profile
        && providerMapping.taskId === task.id
        && (providerMapping.seriesId === seriesId
          || isTodoistNativeSeries(providerMapping) && providerMapping.seriesId === task.id)
        && providerMapping.masterEventId === master.id
        && providerMapping.eventId === existing?.eventId;
      if (!linkVerified) {
        await this.state.audit(delivery.profile, "calendar_recurrence_rule_edit_identity_unverified", {
          seriesId, masterEventId: master.id, eventId: active.id, taskId: task.id,
        });
        return "blocked";
      }
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        await this.state.audit(delivery.profile, "calendar_recurrence_rule_edit_suppressed", {
          seriesId, masterEventId: master.id, taskId: task.id, mode: delivery.mode,
        });
        return "blocked";
      }
      const priorTask = task;
      const updated = await todoist.upsertTask(
        calendarOwnedRecurringTaskPayload(active, calendarRecurrence!, calendarTimeZone), task.id,
      );
      await this.state.recordMutation(delivery.profile);
      providerChanged = true;
      if (updated.id !== task.id
        || !calendarOwnedRecurringTaskReadback(updated, active, calendarRecurrence!, calendarTimeZone).matches) {
        await todoist.upsertTask(priorTask, priorTask.id);
        await this.state.recordMutation(delivery.profile);
        await this.state.audit(delivery.profile, "calendar_recurrence_rule_edit_readback_mismatch", {
          seriesId, masterEventId: master.id, eventId: active.id, taskId: task.id,
        });
        return "blocked";
      }
      task = updated;
      await this.state.audit(delivery.profile, "calendar_recurrence_rule_updated_todoist", {
        seriesId, masterEventId: master.id, eventId: active.id, taskId: task.id,
      });
    }
    if (task?.due?.is_recurring && !calendarRecurrence && existing?.taskId === task.id
      && existing.masterEventId === master.id && !conflictingIds.length) {
      const providerMapping = await this.providerMappingByTask(delivery.profile, task.id, todoist);
      const exactMapping = providerMapping?.profile === delivery.profile
        && providerMapping.projectId === profiles[delivery.profile].todoistProjectId
        && providerMapping.taskId === task.id
        && providerMapping.eventId === existing.eventId
        && providerMapping.masterEventId === master.id
        && (providerMapping.seriesId === seriesId || providerMapping.seriesId === task.id);
      const nextOriginalStart = recurrenceOriginalStart(active);
      const nextEffectiveStart = eventEffectiveStart(active);
      const activeOccurrenceMatches = active.status === "confirmed" && active.recurringEventId === master.id
        && Boolean(nextOriginalStart && nextEffectiveStart) && startsMatch(active, task);
      if (exactMapping && activeOccurrenceMatches) {
        const activeMappingNeedsRepair = providerMapping.activeInstanceId !== active.id
          || existing.activeInstanceId !== active.id
          || !existing.originalStart || compareLogicalStarts(existing.originalStart, nextOriginalStart || "") !== 0
          || !existing.activeEffectiveStart || compareLogicalStarts(existing.activeEffectiveStart, nextEffectiveStart || "") !== 0;
        if (activeMappingNeedsRepair) {
          await this.persistProviderMapping({
            ...existing, activeInstanceId: active.id, originalStart: nextOriginalStart,
            activeEffectiveStart: nextEffectiveStart, updatedAt: new Date().toISOString(),
          }, todoist);
          await this.state.recordMutation(delivery.profile);
          await this.state.audit(delivery.profile, "calendar_recurrence_active_occurrence_mapping_repaired", {
            seriesId, masterEventId: master.id, eventId: active.id, taskId: task.id,
          });
        }
        await this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
          seriesId, masterEventId: master.id, eventId: active.id, taskId: task.id,
          reason: "existing_calendar_rule_outside_supported_subset",
          existingMirrorPreserved: true, outcome: "unsupported", nonBlocking: true,
        });
        return "unsupported";
      }
    }
    // A native recurring task may already have been advanced by Todoist before
    // we process its completion webhook. Validate the RULE independently of
    // the due date and metadata, otherwise a legitimate advance looks like an
    // identity collision and a Calendar rename never propagates.
    const mappedRecurringMatches = Boolean(calendarRecurrence && task
      && (task.id === existing?.taskId || sharedTaskIds.includes(task.id) || discoveredTaskCandidate)
      && matchesCalendarOwnedRecurringRule(task, calendarRecurrence, calendarTimeZone));
    if ((task?.due?.is_recurring && !mappedRecurringMatches) || conflictingIds.length) {
      await this.state.audit(delivery.profile, "calendar_snapshot_recurring_identity_conflict", {
        seriesId, masterEventId: master.id, eventId: active.id,
        candidateTaskIds: [...new Set([...conflictingIds, ...(task?.due?.is_recurring ? [task.id] : [])])].sort(),
      });
      return "blocked";
    }
    if (task?.due?.is_recurring && !calendarRecurrence) {
      await this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, taskId: task.id, reason: "existing_native_recurrence_cannot_be_safely_flattened",
      });
      return "unsupported";
    }
    // Keep any existing mirror intact while the rule is unsupported. Never
    // project an unsupported series as a one-off, even when its old mapped
    // task is missing: that would silently flatten recurrence and create a
    // false mirror that cannot be advanced correctly.
    if (!calendarRecurrence) return "unsupported";
    if (await this.state.syncBlocked(delivery.profile, { eventId:master.id, taskId:task?.id }, !existing)) {
      await this.state.audit(delivery.profile, "calendar_event_sync_control_blocked", { eventId:master.id, taskId:task?.id });
      return this.recurrenceControlOutcome(delivery.profile, { taskId: task?.id, eventId: master.id });
    }
    // A provider-confirmed split can leave a unique stale project comment.
    // Repair only after independent lineage, history and current-due proof;
    // the ordinary conflict guard remains unchanged for every other mismatch.
    if (!existing && task?.due?.is_recurring && calendarRecurrence) {
      const stale = await this.providerMappingByTask(delivery.profile, task.id, todoist);
      if (stale?.masterEventId && stale.masterEventId !== master.id) {
        if (await this.repairStaleWeeklySplit(delivery, stale, master, active, task,
          calendarRecurrence, calendarTimeZone, calendar, todoist)) return "repaired";
        await this.state.audit(delivery.profile, "calendar_snapshot_recurring_identity_conflict", {
          seriesId, masterEventId: master.id, eventId: active.id, candidateTaskIds: [task.id],
          reason: "durable_mapping_missing_or_changed",
        });
        return "blocked";
      }
    }
    if (discoveredTaskCandidate && task && calendarRecurrence) {
      const [liveTask, liveMaster, liveActive] = await Promise.all([
        todoist.getTask(task.id), calendar.getEvent(master.id), calendar.getEvent(active.id),
      ]);
      const liveRecurrence = liveMaster.status === "confirmed" && liveMaster.id === master.id
        && liveMaster.recurrence?.length && !liveMaster.recurringEventId
        ? await verifiedCalendarOwnedRecurrence(liveMaster, instances, calendarTimeZone!,
          calendar.listExplicitSeriesExceptions?.bind(calendar))
        : undefined;
      const liveSharedIds = [...new Set([
        liveMaster.extendedProperties?.shared?.taskId, liveMaster.extendedProperties?.shared?.syncTaskId,
        liveActive.extendedProperties?.shared?.taskId, liveActive.extendedProperties?.shared?.syncTaskId,
      ].filter((id): id is string => Boolean(id)))];
      const refreshedCandidates = liveRecurrence
        ? await discoverCompatibleTodoistRecurringCandidatesForCalendar(liveMaster, liveRecurrence,
          calendarTimeZone, [liveTask], delivery.profile, calendar)
        : [];
      const stillCompatible = liveRecurrence?.rule === calendarRecurrence.rule
        && liveActive.status === "confirmed" && liveActive.recurringEventId === master.id
        && recurrenceOriginalStart(liveActive) === recurrenceOriginalStart(active)
        && refreshedCandidates.length === 1 && refreshedCandidates[0].event.id === liveActive.id
        && (liveSharedIds.length === 0 || liveSharedIds.length === 1 && liveSharedIds[0] === liveTask.id);
      const racedOwner = await this.providerMappingByTaskAnyProfile(liveTask.id);
      if (!stillCompatible || racedOwner) {
        await this.state.audit(delivery.profile, "calendar_provider_pair_candidate_changed", {
          masterEventId: master.id, eventId: active.id, taskId: task.id,
          reason: racedOwner ? "todoist_task_acquired_provider_link" : "provider_candidate_changed",
        });
        return "blocked";
      }
      const mapping: Mapping = {
        profile: delivery.profile, eventId: liveActive.id, taskId: liveTask.id,
        projectId: profiles[delivery.profile].todoistProjectId,
        seriesId, masterEventId: liveMaster.id, activeInstanceId: liveActive.id,
        originalStart: recurrenceOriginalStart(liveActive),
        activeEffectiveStart: eventEffectiveStart(liveActive), calendarProgressVersion: 1,
        updatedAt: new Date().toISOString(),
      };
      await this.persistProviderMapping(mapping, todoist);
      const [verifiedMaster, verifiedMapping] = await Promise.all([
        calendar.getEvent(liveMaster.id), this.providerMappingByTask(delivery.profile, liveTask.id, todoist),
      ]);
      const verifiedShared = verifiedMaster.extendedProperties?.shared;
      if (verifiedShared?.taskId !== liveTask.id || verifiedShared?.syncTaskId !== liveTask.id
        || verifiedShared?.syncProfile !== delivery.profile
        || verifiedShared?.syncCalendarId !== profiles[delivery.profile].calendarId
        || verifiedShared?.syncMasterEventId !== liveMaster.id
        || verifiedMapping?.eventId !== liveActive.id || verifiedMapping.masterEventId !== liveMaster.id
        || verifiedMapping.activeInstanceId !== liveActive.id || verifiedMapping.taskId !== liveTask.id) {
        throw new Error("Recovered Calendar series did not verify both provider-native links");
      }
      await this.state.audit(delivery.profile, "calendar_provider_pair_recovered_by_unique_match", {
        masterEventId: liveMaster.id, eventId: liveActive.id, taskId: liveTask.id,
        tieBreak: "unique_exact_compatible_recurring_task",
      });
      return "repaired";
    }
    if (task?.due?.is_recurring && calendarRecurrence) {
      const mapped = await this.providerMappingByTask(delivery.profile, task.id, todoist);
      const mappingSeriesMatches = mapped?.seriesId === seriesId
        || isTodoistNativeSeries(mapped) && mapped.seriesId === task.id;
      if ((!mapped && !sharedTaskIds.includes(task.id) && !discoveredTaskCandidate)
        || mapped && (mapped.masterEventId !== master.id || !mappingSeriesMatches
          || mapped.eventId !== existing?.eventId)) {
        await this.state.audit(delivery.profile, "calendar_snapshot_recurring_identity_conflict", {
          seriesId, masterEventId: master.id, eventId: active.id, candidateTaskIds: [task.id],
          reason: "durable_mapping_missing_or_changed",
        });
        return "blocked";
      }
      if (!mapped) {
        // The shared Calendar task ID is the surviving exact provider
        // correlation. The common write/readback below recreates the project
        // mapping without manufacturing an alternate task.
      } else if (isCalendarNativeSeries(mapped)) {
      const metadata = await this.reconcileCalendarOwnedMetadata(delivery.profile, mapped, master, task, calendar, todoist);
      if (metadata.blocked) return "blocked";
      task = metadata.task;
      providerChanged ||= metadata.changed;
      const taskOccurrence = instances.find(instance => startsMatch(instance, task!));
      const taskOccurrenceStart = taskOccurrence ? recurrenceOriginalStart(taskOccurrence) : undefined;
      const activeOccurrenceStart = recurrenceOriginalStart(active);
      const providerProgressAtOrBeyondActive = Boolean(taskOccurrenceStart && activeOccurrenceStart
        && compareLogicalStarts(taskOccurrenceStart, activeOccurrenceStart) > 0);
      if (providerProgressAtOrBeyondActive) {
        // An in-flight Todoist completion may have advanced the provider's due
        // date to this or a later occurrence while provider mapping metadata
        // still points at its predecessor. Metadata can sync safely; only a
        // verified completion may advance the monotonic progress watermark.
        await this.state.audit(delivery.profile, "calendar_owned_completion_advance_deferred", {
          seriesId, masterEventId: master.id, taskId: task.id,
          mappedEventId: existing?.eventId, activeEventId: active.id,
          providerDue: task.due?.date || task.due?.datetime,
        });
        return "blocked";
      }
      }
    }
    if (task && existing?.activeInstanceId === active.id
      && (calendarRecurrence ? matchesCalendarOwnedRecurringTask(task, active, calendarRecurrence, calendarTimeZone)
        && normalizedText(active.summary) === normalizedText(task.content)
        && normalizedDescription(active.description) === normalizedDescription(task.description)
        : hasCanonicalState(active, task))) {
      const verifiedMapping: Mapping = {
        ...(existing || {}), profile: delivery.profile,
        projectId: existing?.projectId || profiles[delivery.profile].todoistProjectId,
        calendarId: profiles[delivery.profile].calendarId,
        eventId: active.id, taskId: task.id, seriesId, masterEventId: master.id,
        activeInstanceId: active.id,
        originalStart: recurrenceOriginalStart(active),
        activeEffectiveStart: eventEffectiveStart(active),
        updatedAt: existing?.updatedAt || new Date().toISOString(),
      };
      await this.persistProviderMapping(verifiedMapping, todoist);
      await this.state.audit(delivery.profile, "calendar_recurrence_noop_active_instance", { seriesId, eventId: active.id, taskId: task.id });
      return providerChanged ? "repaired" : "converged";
    }
    if (await this.calendarMutationBlockedByCompletion(delivery, active.id)) return "blocked";
    const nextTask = task?.due?.is_recurring && calendarRecurrence
      && matchesCalendarOwnedRecurringRule(task, calendarRecurrence, calendarTimeZone)
      ? await todoist.updateRecurringOccurrence(task, toTodoistTask(active))
      : await todoist.upsertTask(
        calendarOwnedRecurringTaskPayload(active, calendarRecurrence, calendarTimeZone), task?.id,
        calendarReplaySourceIds(active, master.id),
      );
    const readback = calendarOwnedRecurringTaskReadback(nextTask, active, calendarRecurrence, calendarTimeZone);
    if (!readback.matches) {
      if (!task) {
        await todoist.deleteTask(nextTask.id).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
      } else {
        // Restore the prior Todoist payload, including its original native
        // due string, instead of flattening a failed recurring update.
        await todoist.upsertTask(task, task.id);
      }
      await this.state.audit(delivery.profile, "calendar_recurrence_todoist_readback_mismatch", {
        seriesId, masterEventId: master.id, eventId: active.id, taskId: nextTask.id,
        expected: readback.expected,
        observed: readback.observed,
      });
      return "blocked";
    }
    const mapping: Mapping = {
      profile: delivery.profile,
      eventId: active.id,
      taskId: nextTask.id,
      seriesId,
      masterEventId: master.id,
      activeInstanceId: active.id,
      originalStart: recurrenceOriginalStart(active),
      activeEffectiveStart: eventEffectiveStart(active),
      syncedTitle: normalizedText(active.summary),
      syncedDescription: normalizedDescription(active.description),
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
    await this.persistProviderMapping(mapping);
    await this.state.recordMutation(delivery.profile);
    await this.state.audit(delivery.profile, task ? "calendar_recurrence_updated_task" : "calendar_recurrence_created_task", { seriesId, eventId: active.id, taskId: nextTask.id });
    return "repaired";
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

  /** Preserve an already committed #389 master through Todoist echoes and
   * Calendar reconciliation. Unsupported recurrence text never falls through
   * to the rolling writer, which would flatten the verified series. */
  private async preserveTodoistPhaseBNativeMaster(
    delivery: Delivery,
    task: TodoistTask,
    observedMaster: CalendarEvent,
    mapping: Mapping | undefined,
    todoist: Todoist,
  ): Promise<boolean> {
    const observedShared = observedMaster.extendedProperties?.shared;
    const exactSeriesMapping = Boolean(isTodoistNativeSeries(mapping)
      && mapping.masterEventId === observedMaster.id
      && observedShared?.taskId === task.id && observedShared.syncSeriesId === task.id);
    if (observedShared?.todoistPhaseBVersion !== "1" && !exactSeriesMapping) return false;
    const { calendar } = await this.clients(delivery.profile);
    let master: CalendarEvent;
    try { master = await calendar.getEvent(observedMaster.id); }
    catch (error) {
      if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_requires_review", {
        taskId: task.id, eventId: observedMaster.id, reason: "master_readback_missing",
      });
      throw new SafeProviderReplayError(`Calendar master readback is temporarily missing for Todoist task ${task.id}`, {
        cause: error,
      });
    }
    const shared = master.extendedProperties?.shared;
    if (!master.etag || master.status !== "confirmed" || !master.start?.date
      || master.recurrence?.length !== 1 || !task.due?.is_recurring
      || !shared?.todoistRecurrence
      || shared.todoistPhaseBVersion !== "1" && !exactSeriesMapping
      || shared.taskId !== task.id) {
      await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_requires_review", {
        taskId: task.id, eventId: master.id, reason: "master_or_current_recurrence_unverified",
      });
      return true;
    }
    const [calendarTimeZone, todoistTimeZone] = await Promise.all([
      calendar.getTimeZone(), todoist.getTimeZone(),
    ]);
    const candidate = todoistPhaseBCandidate(task, {
      start: master.start.date, source: "verified_original_schedule", timeZone: calendarTimeZone,
    });
    if (calendarTimeZone !== todoistTimeZone || candidate.candidateRrule !== master.recurrence[0]
      || shared.todoistAnchorStart !== master.start.date) {
      await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_requires_review", {
        taskId: task.id, eventId: master.id, reason: "current_due_or_rule_drift",
      });
      return true;
    }
    const due = task.due.date || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_requires_review", {
        taskId: task.id, eventId: master.id, reason: "all_day_due_unverified",
      });
      return true;
    }
    const instances = await calendar.listInstancesInWindow(master.id,
      `${due}T00:00:00Z`, `${addDays(due, 3)}T00:00:00Z`);
    const active = selectTodoistCurrentInstance(instances, task);
    if (!active || active.status === "cancelled" || !startsMatch(active, task)) {
      await this.state.audit(delivery.profile, "todoist_phase_b_native_write_retryable", {
        taskId: task.id, eventId: master.id, reason: "active_provider_instance_unresolved",
      });
      throw new SafeProviderReplayError(`Calendar has not exposed the active instance for Todoist task ${task.id}`);
    }
    if (master.summary !== (normalizedText(task.content) || "Untitled Todoist task")
      || normalizedDescription(master.description) !== normalizedDescription(task.description)) {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_metadata_write_suppressed", {
          taskId: task.id, eventId: master.id,
        });
        return true;
      }
      const patched = await calendar.patchEventMetadataIfUnchanged(master.id, master.etag, {
        summary: normalizedText(task.content) || "Untitled Todoist task",
        description: normalizedDescription(task.description),
      });
      await this.state.recordMutation(delivery.profile);
      if (patched.id !== master.id || patched.start?.date !== master.start.date
        || JSON.stringify(patched.recurrence) !== JSON.stringify(master.recurrence)
        || patched.extendedProperties?.shared?.todoistPhaseBVersion !== "1"
          && !(patched.extendedProperties?.shared?.taskId === task.id
            && patched.extendedProperties?.shared?.syncSeriesId === task.id)) {
        await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_requires_review", {
          taskId: task.id, eventId: master.id, reason: "metadata_patch_readback_mismatch",
        });
        return true;
      }
    }
    const base = mapping || { profile: delivery.profile, eventId: master.id, taskId: task.id,
      updatedAt: new Date().toISOString() };
    const nextMapping = { ...todoistOwnedMapping({ ...base,
      projectId: task.project_id || base.projectId || profiles[delivery.profile].todoistProjectId,
    }, master.id, task.id, active), todoistPhaseBVersion: 1 as const };
    try {
      const persisted = await this.persistProviderMapping(nextMapping, todoist);
      const [verifiedMaster, verifiedMapping] = await Promise.all([
        calendar.getEvent(master.id),
        this.providerMappingByTask(delivery.profile, task.id, todoist),
      ]);
      const verifiedShared = verifiedMaster.extendedProperties?.shared || {};
      if (verifiedMaster.id !== master.id || verifiedShared.taskId !== task.id
        || verifiedShared.syncTaskId !== task.id || verifiedShared.syncProfile !== delivery.profile
        || verifiedShared.syncCalendarId !== profiles[delivery.profile].calendarId
        || verifiedShared.syncEventId !== master.id || verifiedShared.syncMasterEventId !== master.id
        || verifiedShared.syncActiveInstanceId !== active.id
        || persisted.taskId !== task.id || persisted.masterEventId !== master.id
        || persisted.activeInstanceId !== active.id || !verifiedMapping
        || verifiedMapping.taskId !== task.id || verifiedMapping.masterEventId !== master.id
        || verifiedMapping.activeInstanceId !== active.id) {
        throw new Error("Existing Calendar series and Todoist mapping failed readback verification");
      }
    } catch (error) {
      throw new SafeProviderReplayError(
        `Calendar and Todoist mapping readback needs retry for task ${task.id}`,
        { cause: error },
      );
    }
    await this.state.audit(delivery.profile, "todoist_phase_b_existing_series_preserved", {
      taskId: task.id, eventId: master.id, activeInstanceId: active.id,
    });
    return true;
  }

  private async processTodoist(delivery: Delivery, options: { reconciliation?: boolean } = {}): Promise<void> {
    const payload = JSON.parse(delivery.body) as TodoistWebhookPayload;
    let task = payload.event_data;
    const webhookTask = task;
    let lifecycle = todoistCalendarLifecycle(payload);
    if (!task?.id || !lifecycle) return;
    const projectCommentClient=(await this.clients(delivery.profile)).todoist;
    const projectComments=await projectCommentClient.listProjectComments(profiles[delivery.profile].todoistProjectId);
    // Every Todoist-origin Calendar update/delete holds this task's durable
    // write fence until provider and mapping writes finish. Completion retries
    // rather than committing its immutable marker mid-mutation.
    const writeFence = lifecycle.action === "upsert" || lifecycle.action === "delete_projection"
      ? await this.state.beginTodoistCalendarWrite?.(task.id) : undefined;
    try {
    if (lifecycle.reason === "deleted") {
      try {
        const current = await projectCommentClient.getTask(task.id);
        if (!current.is_deleted) {
          return this.state.audit(delivery.profile, "todoist_stale_delete_replay_suppressed", {
            taskId: task.id, currentUpdatedAt: current.updated_at,
          });
        }
      } catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        // An exact provider 404/410 confirms the deletion before the linked
        // Calendar projection is considered for cleanup.
      }
    }
    // Every mutation is based on this fresh provider read. A stale queued
    // payload is never replayed as current task state.
    if (lifecycle.action === "upsert") {
      let current: TodoistTask;
      try {
        current = await (await this.clients(delivery.profile)).todoist.getTask(task.id);
      } catch (error) {
        if (Number((error as { status?: number }).status) === 404) {
          return this.state.audit(delivery.profile, "todoist_missing_task_delivery_ignored", {
            event: payload.event_name, reason: "provider_task_not_found",
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
      // The webhook may have been delayed until after the task was undated,
      // completed, deleted and recreated, or moved. Use its event name only
      // to preserve an explicit uncompletion transition; all other lifecycle
      // decisions come from the freshly-read task. In particular, a stale
      // `item:updated` payload must not recreate a Calendar projection for a
      // task that no longer has a due date.
      const currentPayload: TodoistWebhookPayload = {
        ...payload,
        event_name: /uncompleted/i.test(payload.event_name || "") ? payload.event_name : "item:updated",
        event_data: current,
      };
      lifecycle = todoistCalendarLifecycle(currentPayload) || lifecycle;
    }
    const projectMappingIndex = buildProjectMappingIndex(projectComments);
    const providerTaskMappings = (projectMappingIndex.byTaskId.get(task.id) || []).filter(entry =>
      entry.payload.profile === delivery.profile
      && entry.payload.projectId === profiles[delivery.profile].todoistProjectId);
    const identities = new Set(providerTaskMappings.map(entry => JSON.stringify([
      entry.payload.profile, entry.payload.projectId, entry.payload.taskId,
      entry.payload.seriesId || entry.payload.masterEventId || entry.payload.eventId,
    ])));
    if (identities.size > 1) return this.state.audit(delivery.profile,
      "todoist_project_mapping_correlation_ambiguous", { taskId: task.id, candidates: identities.size });
    const providerMapping = providerTaskMappings.sort((a,b) => b.payload.mappingRevision - a.payload.mappingRevision
      || Date.parse(b.payload.updatedAt) - Date.parse(a.payload.updatedAt))[0];
    let existingMapping = providerMapping ? mappingFromProjectMappingComment(providerMapping) : undefined;
    if (existingMapping?.calendarId && existingMapping.calendarId !== profiles[delivery.profile].calendarId)
      return this.state.audit(delivery.profile, "todoist_project_mapping_calendar_mismatch", { taskId: task.id });
    // If this project's comments do not contain the task, check every
    // configured project comment index for a cross-profile owner before
    // treating it as an unmapped task.
    if (!existingMapping) existingMapping = await this.providerMappingByTaskAnyProfile(task.id);
    // #369: only a fresh, already-annual Todoist update may propose retiring
    // an unmodified failed validation-only repair with a cancelled projection.
    // The transaction retires only the no-write repair and releases its exact
    // controls; live provider correlation remains authoritative and is updated
    // by the normal projection write below. A blocked candidate stays held.
    if (lifecycle.action==="upsert" && writeFence && existingMapping?.profile===delivery.profile
      && !existingMapping.seriesId
      && !existingMapping.masterEventId && !existingMapping.activeInstanceId
      && recoveryPolicyForTask(task) && task.updated_at && existingMapping.updatedAt
      && Date.parse(task.updated_at)>Date.parse(existingMapping.updatedAt)
      && profileForTodoistProject(task.project_id)===delivery.profile
      && await this.state.mutationAllowed(delivery.profile)
      && modeAllowsMutations(delivery,true)) {
      const operationId=await this.state.getCancelledAnnualRecoveryLock?.(delivery.profile,task.id);
      if (operationId) {
        const providers=await this.clients(delivery.profile);
        const recovered=await attemptCancelledAnnualRecovery({
          profile:delivery.profile,task,mapping:existingMapping,operationId,writeToken:writeFence,
          state:this.state,calendar:providers.calendar,todoist:providers.todoist,
          calendarForProfile:async other=>(await this.clients(other)).calendar,
          todoistForProfile:async other=>(await this.clients(other)).todoist,
        });
        if (recovered) {
          await this.state.audit(delivery.profile,"todoist_cancelled_annual_projection_reset",{
            taskId:task.id,oldEventId:existingMapping.eventId,
          });
          existingMapping=undefined;
        }
      }
    }
    const completedHistory = lifecycle.action !== "upsert" && !existingMapping
      ? await this.state.listCompletedCalendarProjectionsByTask?.(delivery.profile, task.id) || []
      : [];
    if (lifecycle.action !== "upsert" && !existingMapping && !completedHistory.length) {
      try {
        await (await this.clients(delivery.profile)).todoist.getTask(task.id);
      } catch (error) {
        if (Number((error as { status?: number }).status) === 404) {
          let commentsRemoved = 0;
          if (lifecycle.reason === "deleted"
            && modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))
            && !await this.state.syncBlocked(delivery.profile, { taskId: task.id })) {
            commentsRemoved = await deleteExactTaskProjectMappingComments(projectCommentClient, projectComments, {
              profile: delivery.profile, projectId: profiles[delivery.profile].todoistProjectId, taskId: task.id,
            });
          }
          return this.state.audit(delivery.profile,
            commentsRemoved ? "todoist_deleted_task_project_comments_cleaned" : "todoist_missing_task_delivery_ignored",
            commentsRemoved ? { commentsRemoved } : { reason: "provider_task_not_found", event: payload.event_name });
        }
        throw error;
      }
    }
    const controlProfile = existingMapping?.profile || profileForTodoistProject(task.project_id) || delivery.profile;
    if (await this.state.syncBlocked(controlProfile, { taskId: task.id, eventId: existingMapping?.eventId },
      lifecycle.action === "upsert" && !existingMapping)) {
      return this.state.audit(controlProfile, "todoist_task_sync_control_blocked", { taskId: task.id });
    }
    let recurringDateEdit = todoistRecurringDateEdited(payload);
    const orderedLifecycle = lifecycle.action === "upsert" || lifecycle.reason === "completed"
      || lifecycle.reason === "uncompleted" || lifecycle.reason === "due_removed" || lifecycle.reason === "undated";
    if (orderedLifecycle && !options.reconciliation
      && !await this.state.acceptTaskVersion(delivery.profile, task.id, task.updated_at)) {
      return this.state.audit(delivery.profile, "todoist_stale_version_suppressed", { taskId: task.id, event: payload.event_name, taskUpdatedAt: task.updated_at });
    }
    if (lifecycle.reason === "uncompleted") {
      // Within seven days this task still has its original mapping. Release
      // its completion guard, but DO NOT PATCH or recreate the Calendar event.
      // After retirement, no mapping can be reactivated from title/date.
      const mapped = existingMapping?.profile === delivery.profile ? existingMapping : undefined;
      let verifiedVersion: string | undefined;
      if (mapped && !mapped.seriesId) {
        // The webhook can be delayed. Never trust its uncompleted label or
        // timestamp as proof the current task is active.
        let current: TodoistTask | undefined;
        try { current = await (await this.clients(delivery.profile)).todoist.getTask(task.id); }
        catch (error) {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        }
        if (current?.id === task.id && current.is_completed === false
          && !current.is_deleted && current.project_id === profiles[delivery.profile].todoistProjectId) {
          verifiedVersion = current.updated_at;
        }
      }
      const restored = mapped && verifiedVersion
        ? await this.state.reopenRetainedStandaloneMapping?.(mapped, verifiedVersion)
        : false;
      return this.state.audit(delivery.profile, restored ? "todoist_uncompleted_mapping_retained" : "todoist_uncompleted_no_active_mapping", {
        taskId: task.id, eventId: mapped?.eventId,
      });
    }
    if (lifecycle.action === "skip") {
      return this.state.audit(delivery.profile, "todoist_calendar_skipped_undated", { taskId: task.id, event: payload.event_name });
    }

    const { calendar, todoist } = await this.clients(delivery.profile);
    let mapping = existingMapping?.profile === delivery.profile
      ? existingMapping : await this.providerMappingByTask(delivery.profile, task.id, todoist);
    if (!recurringDateEdit && lifecycle.action === "upsert"
      && payload.event_name === "item:updated"
      && payload.event_data_extra?.update_intent === "item_updated"
      && task.due?.is_recurring && mapping?.masterEventId && mapping.activeEffectiveStart) {
      const due = taskDateTime(task) || task.due.date;
      const previous = mapping.activeEffectiveStart;
      const allDay = /^\d{4}-\d{2}-\d{2}$/.test(previous);
      const changed = allDay ? due !== previous : !Number.isFinite(Date.parse(due || ""))
        || Date.parse(due || "") !== Date.parse(previous);
      recurringDateEdit = Boolean(due && changed);
    }
    const pendingAnnualRecovery = lifecycle.action==="upsert"
      ? await this.state.getCancelledAnnualRecoveryReceipt?.(delivery.profile,task.id)
      : undefined;
    if (pendingAnnualRecovery && !recoveryReceiptMatchesTask(pendingAnnualRecovery,task)) {
      return this.state.audit(delivery.profile,"todoist_cancelled_annual_projection_source_changed",{
        taskId:task.id,
      });
    }
    const oldTaskForDateEdit = payload.event_data_extra?.old_item;
    const recurrenceRuleUnchanged = !oldTaskForDateEdit || Boolean(oldTaskForDateEdit.due?.is_recurring
      && task.due?.is_recurring
      && todoistRecurrenceToRrule(oldTaskForDateEdit) === todoistRecurrenceToRrule(task)
      && todoistRecurrenceKey(oldTaskForDateEdit) === todoistRecurrenceKey(task)
      && oldTaskForDateEdit.due?.timezone === task.due?.timezone);
    if (lifecycle.action === "upsert" && recurringDateEdit && recurrenceRuleUnchanged && mapping?.masterEventId) {
      return this.rescheduleMappedRecurringOccurrence(delivery, task,
        oldTaskForDateEdit, mapping, calendar, todoist);
    }
    if (mapping && lifecycle.action === "upsert" && !mapping.seriesId) {
      const completed = await this.getCompletedProjection(delivery.profile, mapping.eventId);
      if (completed?.taskId === task.id) {
        return this.state.audit(delivery.profile, "todoist_completed_mapping_update_ignored", {
          taskId: task.id, eventId: mapping.eventId,
        });
      }
    }
    if (lifecycle.action === "upsert" && isCalendarNativeSeries(mapping) && mapping?.masterEventId
      && (task.due?.is_recurring || mapping.calendarProgressVersion === 1)) {
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
      const previousDue = payload.event_data_extra?.old_item?.due;
      if (payload.event_name === "item:updated" && previousDue?.is_recurring
        && (previousDue.string && previousDue.string !== task.due?.string
          || previousDue.timezone && previousDue.timezone !== task.due?.timezone)) {
        return this.state.audit(delivery.profile, "calendar_owned_todoist_recurrence_requires_review", {
          taskId: task.id, masterEventId: mapping.masterEventId,
          reason: "explicit_todoist_recurrence_change",
        });
      }
      if (nativeCalendarRecurrenceCandidate(master)) {
        // Webhooks can omit old_item. Validate the native rule against the
        // verified Calendar master instead of trusting an unchanged due date:
        // cadence, weekday, month/day, start boundary and local time must
        // still match. Do not expand an infinite Calendar series here.
        let zone: string;
        try { zone = await resolveCalendarTimeZone(master, calendar.getTimeZone?.bind(calendar)); }
        catch {
          return this.state.audit(delivery.profile, "calendar_owned_todoist_recurrence_requires_review", {
            taskId: task.id, masterEventId: mapping.masterEventId, reason: "calendar_timezone_unverified",
          });
        }
        const phaseC = mapping.calendarProgressVersion === 1 && isPhaseCNativeCandidate(master)
          ? calendarPhaseCCandidate(master, zone) : undefined;
        const expectedRule = phaseC ? undefined : calendarOwnedTodoistRecurrence(master, [], zone);
        const matches = phaseC
          ? matchesCalendarPhaseCTask(task, phaseC, master.start?.dateTime || master.start?.date || "", zone)
          : Boolean(expectedRule && matchesCalendarOwnedRecurringRule(task, expectedRule, zone));
        if (!matches) {
          return this.state.audit(delivery.profile, "calendar_owned_todoist_recurrence_requires_review", {
            taskId: task.id, masterEventId: mapping.masterEventId, reason: "native_rule_changed_or_unsupported",
          });
        }
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
    if (lifecycle.reason === "completed" && isCalendarNativeSeries(mapping) && mapping?.masterEventId) {
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
      const finiteWeeklyCompletion = finiteWeeklyCalendarRuleCandidate(completionMaster);
      if (!nativeCompletion && !finiteWeeklyCompletion) {
        return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
          seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
          reason: "calendar_rule_outside_native_subset",
          existingMirrorPreserved: true, outcome: "source_left_unchanged", nonBlocking: true,
        });
      }
      if (nativeCompletion && !calendar.listInstancesInWindow) {
        return this.state.audit(delivery.profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
          seriesId: mapping.seriesId, taskId: task.id, masterEventId: mapping.masterEventId,
        });
      }
      const mappedStart = mapping.activeEffectiveStart || mapping.originalStart;
      const mappedMs = mappedStart ? Date.parse(mappedStart) : Number.NaN;
      const startMs = Number.isFinite(mappedMs) ? mappedMs : Date.now();
      const instances = finiteWeeklyCompletion
        ? await calendar.listInstances(mapping.masterEventId)
        : await listBoundedRecurrenceInstances(calendar, mapping.masterEventId, mappedStart);
      let currentRecurringTask: TodoistTask | undefined;
      let currentCalendarRecurrence: ReturnType<typeof calendarOwnedTodoistRecurrence>;
      let verifiedCalendarTimeZone: string | undefined;
      // Calendar recurrence is the source of truth even while migrating an
      // older rolling Todoist mirror. Verify the full provider rule before
      // advancing completion so an unsupported rule can never be flattened
      // into a standalone successor.
      if (completionMaster.recurrence?.length) {
        try { currentRecurringTask = await todoist.getTask(task.id); }
        catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
        if (!currentRecurringTask) {
          // A missing exact task readback is not permission to create a second
          // task or flatten the Calendar series. Leave the mapping retryable.
          return this.state.audit(delivery.profile, "calendar_recurrence_completed_recurring_readback_missing", {
            seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
          });
        }
        let timeZone: string;
        try { timeZone = await resolveCalendarTimeZone(completionMaster, calendar.getTimeZone?.bind(calendar)); }
        catch (error) {
          return this.state.audit(delivery.profile, "calendar_recurrence_calendar_timezone_unverified", {
            seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        currentCalendarRecurrence = await verifiedCalendarOwnedRecurrence(
          completionMaster, instances, timeZone, calendar.listExplicitSeriesExceptions?.bind(calendar));
        verifiedCalendarTimeZone = timeZone;
        const advancedCalendarInstance = currentRecurringTask.due?.is_recurring
          ? selectTodoistCurrentInstance(instances, currentRecurringTask) : undefined;
        const recurrenceReadbackMatches = Boolean(currentCalendarRecurrence
          && (!currentRecurringTask.due?.is_recurring
            || matchesCalendarOwnedRecurringRule(currentRecurringTask, currentCalendarRecurrence, timeZone)
            || (advancedCalendarInstance
              && calendarOwnedRecurringTaskReadback(currentRecurringTask, advancedCalendarInstance,
                currentCalendarRecurrence, timeZone).matches)));
        if (!currentCalendarRecurrence || !recurrenceReadbackMatches) {
          return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
            seriesId: mapping.seriesId, masterEventId: mapping.masterEventId, taskId: task.id,
            reason: "completed_task_recurrence_does_not_match_supported_calendar_rule",
            calendarRuleVerified: Boolean(currentCalendarRecurrence),
            todoistTaskRecurring: Boolean(currentRecurringTask.due?.is_recurring),
            todoistRuleMatches: Boolean(recurrenceReadbackMatches),
            existingMirrorPreserved: true, outcome: "source_left_unchanged", nonBlocking: true,
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
        // Require a finite RRULE on the fresh Calendar master and retain the
        // verified terminal completion for seven days. If provider proof is
        // unavailable, leave the active mapping retryable.
        let master: CalendarEvent | undefined;
        try { master = await calendar.getEvent?.(mapping.masterEventId); }
        catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
        const finite = master?.status !== "cancelled" && master?.recurrence?.some(
          (rule) => /^RRULE:(?:[^;]*;)*(?:COUNT|UNTIL)=/i.test(rule),
        );
        const link = mapping.seriesId
          ? await this.providerSeriesMapping(delivery.profile, mapping.seriesId, todoist, mapping.masterEventId)
          : undefined;
        if (finite && link && link.masterEventId === mapping.masterEventId
          && await this.state.verifyTerminalCompletedCalendarProjection?.(retained, link)) {
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
      let nextTask: TodoistTask;
      if (alreadyAdvanced && currentRecurringTask) {
        nextTask = currentRecurringTask;
      } else if (currentCalendarRecurrence && currentRecurringTask?.due?.is_recurring) {
        nextTask = await todoist.updateRecurringOccurrence(currentRecurringTask, toTodoistTask(next));
      } else if (currentCalendarRecurrence && currentRecurringTask) {
        // Upgrade a supported legacy rolling mirror in place. Retaining the
        // Todoist task ID avoids a successor chain and keeps provider
        // correlation stable across repeated completions.
        nextTask = await todoist.upsertTask(
          calendarOwnedRecurringTaskPayload(next, currentCalendarRecurrence, verifiedCalendarTimeZone),
          currentRecurringTask.id,
          calendarReplaySourceIds(next, mapping.masterEventId),
        );
      } else {
        return this.state.audit(delivery.profile, "calendar_recurrence_todoist_rule_unsupported", {
          seriesId: mapping.seriesId, eventId: next.id, masterEventId: mapping.masterEventId,
          taskId: task.id, reason: "native_calendar_recurrence_not_verified",
          existingMirrorPreserved: true, outcome: "source_left_unchanged", nonBlocking: true,
        });
      }
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
        seriesId: mapping.seriesId,
        masterEventId: mapping.masterEventId,
        activeInstanceId: next.id,
        originalStart: recurrenceOriginalStart(next),
        activeEffectiveStart: eventEffectiveStart(next),
        ...(progressMapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
        ...(completedThroughOriginalStart ? { completedThroughOriginalStart } : {}),
        ...(mapping.syncedTitle !== undefined ? { syncedTitle: mapping.syncedTitle } : {}),
        ...(mapping.syncedDescription !== undefined ? { syncedDescription: mapping.syncedDescription } : {}),
        updatedAt: new Date().toISOString(),
      };
      const expectedLink = mapping.seriesId
        ? await this.providerSeriesMapping(delivery.profile, mapping.seriesId, todoist, mapping.masterEventId)
        : undefined;
      if (!expectedLink) {
        return this.state.audit(delivery.profile, "calendar_recurrence_mapping_advance_deferred", {
          seriesId: mapping.seriesId, taskId: task.id, eventId: mapping.eventId,
          reason: "current_provider_mapping_missing",
        });
      }
      if (expectedLink.seriesId === expectedLink.taskId || expectedLink.taskId !== mapping.taskId
        || expectedLink.eventId !== mapping.eventId || expectedLink.masterEventId !== mapping.masterEventId
        || expectedLink.activeInstanceId !== mapping.activeInstanceId
        || expectedLink.originalStart !== mapping.originalStart
        || expectedLink.completedThroughOriginalStart !== mapping.completedThroughOriginalStart
        || expectedLink.calendarProgressVersion !== mapping.calendarProgressVersion) {
        await this.state.audit(delivery.profile, "calendar_recurrence_mapping_advance_deferred", {
          seriesId: mapping.seriesId, taskId: task.id, eventId: mapping.eventId,
          reason: "provider_mapping_changed",
        });
        return;
      }
      // The provider-owned series comment records the successor task and
      // occurrence. The profile writer lease serializes this re-read/update.
      await this.persistProviderMapping(nextMapping, todoist);
      await this.putCompletedProjection(retained);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, "calendar_recurrence_completed_rolled", {
        seriesId: mapping.seriesId,
        eventId: next.id,
        taskId: nextTask.id,
        completedThroughOriginalStart,
      });
    }
    if (lifecycle.reason === "completed" && isTodoistNativeSeries(mapping)) {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_recurrence_mutation_suppressed", { taskId: task.id, mode: delivery.mode });
      }
      let current: TodoistTask | undefined;
      try { current = await todoist.getTask(task.id); } catch (error) { if (Number((error as { status?: number }).status) !== 404) throw error; }
      let mappedEvent: CalendarEvent | undefined;
      try { mappedEvent = await calendar.getEvent(mapping.eventId); } catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
      if (!mappedEvent && mapping.masterEventId) {
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "todoist_recurrence_completion_suppressed_missing_calendar_master", {
          taskId: task.id,
          eventId: mapping.eventId,
          projectionSuppressed: true,
        });
      }
      if (mappedEvent?.status === "cancelled") {
        if (!current) return this.state.audit(delivery.profile, "todoist_missing_task_delivery_ignored", {
          event: payload.event_name, reason: "provider_task_not_found",
        });
        return this.state.audit(delivery.profile, "todoist_recurrence_completion_suppressed_cancelled_calendar", { taskId: task.id, eventId: mapping.eventId });
      }

      const hasVerifiedPhaseBNativeMaster = mappedEvent?.extendedProperties?.shared?.todoistPhaseBVersion === "1"
        && mappedEvent.extendedProperties.shared.taskId === task.id;
      if (current?.due?.is_recurring && !todoistRecurrenceToRrule(current) && !hasVerifiedPhaseBNativeMaster) {
        return this.state.audit(delivery.profile, "todoist_recurrence_unsupported_rule", {
          taskId: task.id, eventId: mapping.eventId,
          existingMirrorPreserved: true, outcome: "source_left_unchanged",
        });
      }
      if (current?.due?.is_recurring && (todoistRecurrenceToRrule(current) || hasVerifiedPhaseBNativeMaster)
        && mappedEvent?.recurrence?.length) {
        const completedTask = payload.event_data_extra?.old_item || task;
        let instances: CalendarEvent[];
        if (hasVerifiedPhaseBNativeMaster) {
          const completedDue = taskDateTime(completedTask) || completedTask.due?.date || "";
          const completedMs = Date.parse(completedDue);
          if (!calendar.listInstancesInWindow || !Number.isFinite(completedMs)) {
            return this.state.audit(delivery.profile, "todoist_recurrence_completion_occurrence_unresolved", {
              taskId: task.id, masterEventId: mappedEvent.id, reason: "bounded_instance_window_unavailable",
            });
          }
          instances = await calendar.listInstancesInWindow(mappedEvent.id,
            new Date(completedMs - 24 * 60 * 60_000).toISOString(),
            new Date(completedMs + 3 * 366 * 24 * 60 * 60_000).toISOString());
        } else {
          const completedDue = taskDateTime(completedTask) || completedTask.due?.date || mapping.activeEffectiveStart;
          instances = await listBoundedRecurrenceInstances(calendar, mappedEvent.id, completedDue);
        }
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

      if (!current?.due || !current.due.is_recurring) {
        const retained: CompletedCalendarProjection = {
          ...completedCalendarProjection(mapping, delivery.receivedAt),
          // Only a fresh, explicitly completed provider task with no further
          // recurrence can prove the rolling series was terminal.
          ...(current?.is_completed === true ? { terminalVerified: true as const } : {}),
        };
        await this.putCompletedProjection(retained);
        await this.state.audit(delivery.profile, "todoist_recurrence_completed_calendar_retained", {
          taskId: task.id, eventId: mapping.eventId, recurrenceProjection: "terminal",
        });
        return this.state.audit(delivery.profile, "todoist_recurrence_completed_no_next", { taskId: task.id, eventId: mapping.eventId });
      }
      const projectedRrule = todoistRecurrenceToRrule(current);
      if (!projectedRrule) {
        return this.state.audit(delivery.profile, "todoist_recurrence_unsupported_rule", {
          taskId: task.id, eventId: mapping.eventId,
          existingMirrorPreserved: Boolean(mappedEvent),
          outcome: "source_left_unchanged", nonBlocking: true,
        });
      }
      const stored = await calendar.upsertEvent(toCalendarEvent(current, mappedEvent));
      await this.state.recordMutation(delivery.profile);
      const readback = await calendar.getEvent(stored.id);
      const rollbackUnverifiedWrite = async (): Promise<string> => {
        try {
          if (mappedEvent?.id === stored.id && readback.etag) {
            await calendar.upsertEventIfUnchanged(toCalendarEvent(current, mappedEvent), stored.id, readback.etag);
            await this.state.recordMutation(delivery.profile);
            return "previous_event_restored";
          }
          if (!mappedEvent && readback.etag) {
            await calendar.deleteEventIfUnchanged(stored.id, readback.etag);
            await this.state.recordMutation(delivery.profile);
            return "created_event_deleted";
          }
        } catch {
          return "failed";
        }
        return "not_attempted";
      };
      if (!readback.recurrence?.includes(projectedRrule)) {
        const rollback = await rollbackUnverifiedWrite();
        await this.state.audit(delivery.profile, "todoist_recurrence_completion_readback_mismatch", {
          taskId: task.id, eventId: stored.id, expectedRrule: projectedRrule,
          observedRecurrence: readback.recurrence || [], rollback,
        });
        throw new Error(`Calendar did not retain recurring completion projection for task ${task.id}`);
      }
      const active = selectTodoistCurrentInstance(
        await listBoundedRecurrenceInstances(calendar, readback.id, taskDateTime(current) || current.due?.date), current);
      if (!active) {
        const rollback = await rollbackUnverifiedWrite();
        await this.state.audit(delivery.profile, "todoist_recurrence_completion_occurrence_unresolved", {
          taskId: task.id, masterEventId: readback.id,
          reason: "active_instance_unresolved_after_readback", rollback,
        });
        throw new Error(`Calendar recurring completion projection has no matching active instance for task ${task.id}`);
      }
      const nextMapping: Mapping = {
        profile: delivery.profile,
        eventId: readback.id,
        taskId: task.id,
        seriesId: task.id,
        masterEventId: readback.id,
        activeInstanceId: active.id,
        originalStart: recurrenceOriginalStart(active),
        activeEffectiveStart: eventEffectiveStart(active),
        updatedAt: new Date().toISOString(),
      };
      await this.persistProviderMapping(nextMapping);
      const retained = completedCalendarProjection(mapping, delivery.receivedAt);
      await this.putCompletedProjection(retained);
      await this.state.audit(delivery.profile, "todoist_recurrence_completed_calendar_retained", {
        taskId: task.id, eventId: mapping.eventId, recurrenceProjection: "rrule",
      });
      return this.state.audit(delivery.profile, "todoist_recurrence_completed_calendar_series_created", {
        taskId: task.id, eventId: readback.id, activeInstanceId: active.id,
        ...phaseBProjectionPreview(current, projectedRrule),
      });
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
      // The active mapping remains addressable during the seven-day grace.
      // The scheduled worker, not the completion webhook, retires it once
      // terminality and unchanged ownership have been verified.
      if (mapping.seriesId) {
      }
      return this.state.audit(delivery.profile, "todoist_completed_calendar_retained", {
        taskId: task.id,
        eventId: mapping.eventId,
        completedAt: retained.completedAt,
      });
    }
    // A completed mapping is retained solely for the grace period. Even a
    // delayed provider item:deleted / due-removed webhook must not interpret
    // that retained index as permission to delete the Calendar event.
    if (mapping && !mapping.seriesId && lifecycle.action === "delete_projection") {
      const completed = await this.getCompletedProjection(delivery.profile, mapping.eventId);
      if (completed?.taskId === task.id) {
        return this.state.audit(delivery.profile, "todoist_completed_mapping_deletion_ignored", {
          taskId: task.id, eventId: mapping.eventId,
        });
      }
    }
    if (lifecycle.reason === "due_removed") {
      if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
        return this.state.audit(delivery.profile, "todoist_mutation_suppressed", { taskId: task.id, event: payload.event_name, mode: delivery.mode });
      }
      if (!mapping) {
        return this.state.audit(delivery.profile, "todoist_due_removed_no_calendar", { taskId: task.id, event: payload.event_name });
      }
      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      await deleteMappingComments(todoist, mapping);
      await this.state.recordMutation(delivery.profile);
      return this.state.audit(delivery.profile, "todoist_due_removed_calendar", { taskId: task.id, eventId: mapping.eventId });
    }

    let cancelledCalendarLink = false;
    let cancelledCalendarEvent: CalendarEvent | undefined;
    if (task && pendingAnnualRecovery && pendingAnnualRecovery.sourcePolicy
      && pendingAnnualRecovery.sourcePolicy!=="yearly") {
      for (const other of ["home","antonio","work"] as const) {
        if (other===delivery.profile) continue;
        const aliases=await (await this.clients(other)).calendar.listLinkedEventsByTodoistTaskId(task.id);
        if (!Array.isArray(aliases) || aliases.length) {
          return this.state.audit(delivery.profile,"todoist_cancelled_recovery_cross_profile_alias_blocked",{
            taskId:task.id,otherProfile:other,
          });
        }
      }
    }
    if (!mapping && pendingAnnualRecovery && task) {
      // After a committed reset, old cancelled Calendar aliases deliberately
      // remain with the provider. The durable receipt allows a brand-new
      // projection, or recovery of a POST that succeeded before mapping ACK.
      const aliases=await calendar.listLinkedEventsByTodoistTaskId(task.id);
      // The shared-attribute search may lag a successful POST. Read the
      // receipt's immutable client-generated ID directly before any retry.
      let exactCounterpart:CalendarEvent|undefined;
      if (pendingAnnualRecovery.candidateEventId) {
        try {exactCounterpart=await calendar.getEvent(pendingAnnualRecovery.candidateEventId);}
        catch (error) {if (Number((error as {status?:number}).status)!==404) throw error;}
      }
      const active=[...new Map([
        ...aliases.filter(item=>item.status!=="cancelled"),
        ...(exactCounterpart ? [exactCounterpart] : []),
      ].map(item=>[item.id,item] as const)).values()];
      const standalone = pendingAnnualRecovery.sourcePolicy==="standalone";
      if (active.length>1 || active.some(item=>item.status!=="confirmed"
        || item.extendedProperties?.shared?.taskId!==task!.id
        || (pendingAnnualRecovery.candidateEventId && (
          item.id!==pendingAnnualRecovery.candidateEventId
          || item.extendedProperties?.shared?.syncRecoveryFingerprint!==pendingAnnualRecovery.sourceFingerprint))
        || (standalone
          ? Boolean(item.recurrence?.length || item.recurringEventId
            || item.extendedProperties?.shared?.todoistRecurrence)
          : !item.extendedProperties?.shared?.todoistRecurrence
            || !item.recurrence?.length)
        || !hasCanonicalState(item,task!))) {
        return this.state.audit(delivery.profile,"todoist_cancelled_annual_projection_alias_conflict",{
          taskId:task.id,candidateCount:active.length,
        });
      }
      if (active.length===1) {
        mapping={profile:delivery.profile,eventId:active[0].id,taskId:task.id,
          updatedAt:new Date().toISOString()};
      }
    }
    if (!mapping && !pendingAnnualRecovery) {
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
        cancelledCalendarEvent = linkedEvent;
      } else if (linkedEvent && !retainedLinkedEvent) {
        mapping = { profile: delivery.profile, eventId: linkedEvent.id, taskId: task.id, updatedAt: new Date().toISOString() };
      }
    }
    const deleted = lifecycle.action === "delete_projection";
    const readdingDue = Boolean(cancelledCalendarEvent
      && canRecreateCalendarProjection(lifecycle, task.updated_at, cancelledCalendarEvent.updated || ""));
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
        await deleteExactTaskProjectMappingComments(todoist, projectComments, {
          profile: delivery.profile, projectId: profiles[delivery.profile].todoistProjectId, taskId: task.id,
        });
        const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, task.id, calendar);
        if (!removedHistory) return;
        return this.state.audit(delivery.profile, "todoist_deleted_completed_calendar_history", { taskId: task.id, removedHistory });
      }
      if (isCalendarNativeSeries(mapping) && mapping.masterEventId && lifecycle.reason === "deleted") {
        await calendar.deleteEvent(mapping.masterEventId).catch((error: unknown) => {
          if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        });
        // Keep the provider-native recovery link until the Calendar deletion
        // is confirmed. If this write fails, the webhook retry can still find
        // the exact master and finish cleanup without guessing by title/date.
        await deleteExactTaskProjectMappingComments(todoist, projectComments, {
          profile: delivery.profile, projectId: profiles[delivery.profile].todoistProjectId, taskId: task.id,
        });
        const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, task.id, calendar, mapping.masterEventId);
        await this.state.recordMutation(delivery.profile);
        return this.state.audit(delivery.profile, "todoist_deleted_calendar_recurrence", { taskId: task.id, masterEventId: mapping.masterEventId, removedHistory });
      }
      await calendar.deleteEvent(mapping.eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      // Do not retire the only exact link before Calendar confirms deletion:
      // a provider failure must remain retryable from the same Todoist event.
      await deleteExactTaskProjectMappingComments(todoist, projectComments, {
        profile: delivery.profile, projectId: profiles[delivery.profile].todoistProjectId, taskId: task.id,
      });
      const removedHistory = await this.deleteCompletedCalendarHistory(delivery.profile, task.id, calendar, mapping.eventId);
      await this.state.recordMutation?.(delivery.profile);
      return this.state.audit(delivery.profile, isTodoistNativeSeries(mapping) ? "todoist_deleted_calendar_recurrence_projection" : "todoist_deleted_calendar", { taskId: task.id, eventId: mapping.eventId, removedHistory });
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
    if (!existingEvent && !cancelledCalendarLink && !pendingAnnualRecovery) {
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
    // A one-off create can commit in Calendar before the Todoist mapping
    // comment is visible. Read its deterministic provider ID directly before
    // doing candidate discovery or issuing another POST, so a retry repairs
    // the same pair instead of creating a second event.
    const deterministicStandaloneId = !task.due?.is_recurring && !existingEvent && !mapping
      && !cancelledCalendarLink && !pendingAnnualRecovery
      ? todoistStandaloneCalendarEventId(delivery.profile, task.id)
      : undefined;
    if (deterministicStandaloneId) {
      try {
        const exact = await calendar.getEvent(deterministicStandaloneId);
        const shared = exact.extendedProperties?.shared || {};
        if (exact.status === "cancelled") {
          return this.state.audit(delivery.profile, "todoist_update_suppressed_cancelled_calendar", {
            taskId: task.id, eventId: exact.id,
          });
        }
        if (exact.id !== deterministicStandaloneId || exact.recurrence?.length || exact.recurringEventId
          || shared.taskId !== task.id
          || (shared.syncProfile && shared.syncProfile !== delivery.profile)
          || (shared.syncCalendarId && shared.syncCalendarId !== profiles[delivery.profile].calendarId)) {
          return this.state.audit(delivery.profile, "todoist_deterministic_calendar_identity_conflict", {
            taskId: task.id, eventId: deterministicStandaloneId,
          });
        }
        existingEvent = exact;
        mapping = { profile: delivery.profile, eventId: exact.id, taskId: task.id,
          projectId: task.project_id || profiles[delivery.profile].todoistProjectId,
          updatedAt: new Date().toISOString() };
      } catch (error) {
        if (Number((error as { status?: number }).status) === 410) {
          return this.state.audit(delivery.profile, "todoist_update_suppressed_cancelled_calendar", {
            taskId: task.id, eventId: deterministicStandaloneId,
          });
        }
        if (Number((error as { status?: number }).status) !== 404) throw error;
      }
    }
    const persistDeterministicPairMapping = async (nextMapping: Mapping, client?: Todoist): Promise<Mapping> => {
      try { return await this.persistProviderMapping(nextMapping, client); }
      catch (error) {
        if (!deterministicStandaloneId) throw error;
        throw new SafeProviderReplayError(
          `Calendar and Todoist mapping readback needs retry for task ${task!.id}`,
          { cause: error },
        );
      }
    };
    let candidateInventoryComplete = false;
    if (!existingEvent && !mapping && !cancelledCalendarLink && !pendingAnnualRecovery
      && typeof calendar.listDelta === "function") {
      const inventory = (await calendar.listDelta()).items;
      const candidates = await discoverCompatibleCalendarCandidates(task, inventory, calendar);
      if (candidates.length > 1) {
        return this.state.audit(delivery.profile, "todoist_provider_pair_ambiguous", {
          taskId: task.id, candidateEventIds: candidates.map(candidate => candidate.master.id).sort(),
          reason: "multiple_exact_compatible_calendar_events",
        });
      }
      if (candidates.length === 1) {
        let candidate = candidates[0];
        const refreshedCandidates = await discoverCompatibleCalendarCandidates(task, [candidate.master], calendar);
        if (refreshedCandidates.length !== 1 || refreshedCandidates[0].master.id !== candidate.master.id
          || refreshedCandidates[0].event.id !== candidate.event.id) {
          return this.state.audit(delivery.profile, "todoist_provider_pair_candidate_changed", {
            taskId: task.id, candidateEventIds: [candidate.master.id, candidate.event.id],
          });
        }
        candidate = refreshedCandidates[0];
        const candidateIds = [...new Set([candidate.master.id, candidate.event.id])];
        const ownerMappings = await this.providerMappingsForCalendarIdentity(
          delivery.profile, candidateIds, projectCommentClient,
        );
        const conflictingOwners = compatibleCalendarCandidateOwnerConflicts(candidate, ownerMappings,
          task.id, delivery.profile);
        if (conflictingOwners.length) {
          return this.state.audit(delivery.profile, "todoist_provider_pair_candidate_owned", {
            taskId: task.id, candidateEventIds: candidateIds,
            ownerTaskIds: conflictingOwners,
          });
        }
        if (!modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
          return this.state.audit(delivery.profile, "todoist_provider_pair_recovery_suppressed", {
            taskId: task.id, candidateEventIds: candidateIds, reason: "mutation_gate_closed",
          });
        }
        const discovered: Mapping = candidate.master.recurrence?.length
          ? todoistOwnedMapping({ profile: delivery.profile, eventId: candidate.master.id,
            taskId: task.id, projectId: task.project_id || profiles[delivery.profile].todoistProjectId,
            updatedAt: new Date().toISOString() }, candidate.master.id, task.id, candidate.event)
          : { profile: delivery.profile, eventId: candidate.event.id, taskId: task.id,
            projectId: task.project_id || profiles[delivery.profile].todoistProjectId,
            updatedAt: new Date().toISOString() };
        await persistDeterministicPairMapping(discovered, projectCommentClient);
        const [verifiedMaster, verifiedMapping] = await Promise.all([
          calendar.getEvent(candidate.master.id),
          this.providerMappingByTask(delivery.profile, task.id, projectCommentClient),
        ]);
        const verifiedShared = verifiedMaster.extendedProperties?.shared;
        if (verifiedShared?.taskId !== task.id || verifiedShared?.syncTaskId !== task.id
          || !verifiedMapping || verifiedMapping.eventId !== discovered.eventId
          || verifiedMapping.masterEventId !== discovered.masterEventId
          || verifiedMapping.activeInstanceId !== discovered.activeInstanceId) {
          throw new Error("Recovered Calendar pair did not verify both provider-native links");
        }
        return this.state.audit(delivery.profile, "todoist_provider_pair_recovered_by_unique_match", {
          taskId: task.id, eventId: candidate.event.id, masterEventId: candidate.master.id,
          activeInstanceId: discovered.activeInstanceId,
        });
      }
      if (await hasConflictingCalendarCandidate(task, inventory, calendar)) {
        return this.state.audit(delivery.profile, "todoist_provider_pair_conflict", {
          taskId: task.id, reason: "same_occurrence_has_incompatible_calendar_object",
        });
      }
      candidateInventoryComplete = true;
    }
    if (!existingEvent && !mapping && !cancelledCalendarLink && !pendingAnnualRecovery
      && !task.due?.is_recurring && !candidateInventoryComplete) {
      return this.state.audit(delivery.profile, "todoist_provider_pair_discovery_incomplete", {
        taskId: task.id, reason: "complete_calendar_inventory_required_before_creation",
      });
    }
    if (existingEvent?.status === "cancelled") {
      return this.state.audit(delivery.profile, "todoist_update_suppressed_cancelled_calendar", { taskId: task.id, event: payload.event_name });
    }
    if (await this.state.syncBlocked(delivery.profile, { taskId: task.id, eventId: existingEvent?.id || mapping?.eventId })) {
      return this.state.audit(delivery.profile, "todoist_pair_sync_control_blocked", { taskId: task.id, eventId: existingEvent?.id || mapping?.eventId });
    }
    // Calendar correlation can outlive a missing Todoist project comment. Use
    // the exact task and master IDs on that surviving provider object to
    // restore the recurring mapping, then refresh Calendar's mirrored fields.
    // A recurrence-owner/version label is not needed to establish identity.
    if (existingEvent && task.due?.is_recurring) {
      const masterId = existingEvent.recurringEventId || existingEvent.id;
      const master = masterId === existingEvent.id ? existingEvent : await calendar.getEvent(masterId);
      const shared = master.extendedProperties?.shared;
      const exactCalendarSeries = master.status !== "cancelled" && Boolean(master.recurrence?.length)
        && shared?.taskId === task.id && shared.syncSeriesId === task.id
        && (!shared.syncSchemaVersion || shared.syncSchemaVersion === "2")
        && (!shared.syncProfile || shared.syncProfile === delivery.profile)
        && (!shared.syncCalendarId || shared.syncCalendarId === profiles[delivery.profile].calendarId)
        && (!shared.syncTaskId || shared.syncTaskId === task.id)
        && (!shared.syncEventId || shared.syncEventId === master.id)
        && (!shared.syncMasterEventId || shared.syncMasterEventId === master.id);
      if (exactCalendarSeries && (!isTodoistNativeSeries(mapping)
        || mapping.masterEventId !== master.id || mapping.eventId !== master.id)) {
        const recovered = this.mappingFromCalendarCorrelation(delivery.profile, master);
        if (recovered?.taskId === task.id && recovered.seriesId === task.id
          && recovered.masterEventId === master.id) {
          mapping = {
            ...recovered,
            projectId: task.project_id || profiles[delivery.profile].todoistProjectId,
            updatedAt: new Date().toISOString(),
          };
          existingEvent = master;
          await this.persistProviderMapping(mapping, todoist);
          await this.state.audit(delivery.profile, "todoist_calendar_series_correlation_recovered", {
            taskId: task.id, masterEventId: master.id,
          });
        }
      }
    }
    // Preserve any existing mirror for a recurring rule that the legacy
    // converter cannot prove equivalent. Do not route it through legacy
    // ownership/review branches or flatten it into a rolling task.
    const existingShared = existingEvent?.extendedProperties?.shared;
    const verifiedTodoistNativeMaster = Boolean(existingEvent
      && existingShared?.taskId === task.id
      && (existingShared.todoistPhaseBVersion === "1"
        || isTodoistNativeSeries(mapping) && mapping.masterEventId === existingEvent.id
          && existingShared.syncSeriesId === task.id));
    if (task.due?.is_recurring && !todoistRecurrenceToRrule(task) && (existingEvent || mapping)
      && !verifiedTodoistNativeMaster) {
      return this.state.audit(delivery.profile, "todoist_recurrence_unsupported_rule", {
        taskId: task.id, eventId: existingEvent?.id || mapping?.eventId,
        existingMirrorPreserved: true, outcome: "source_left_unchanged", nonBlocking: true,
      });
    }

    // A provider lookup may recreate a temporary unmarked mapping after a
    // create-before-mapping interruption. Route tagged masters through the
    // native verifier, never through ordinary canonical-state recovery.
    if (lifecycle.action === "upsert" && task.due?.is_recurring && existingEvent && verifiedTodoistNativeMaster) {
      if (existingEvent.extendedProperties?.shared?.taskId !== task.id) {
        return this.state.audit(delivery.profile, "todoist_phase_b_native_identity_conflict", {
          taskId: task.id, eventId: existingEvent.id,
        });
      }
      const nativeMaster = existingEvent.recurringEventId
        ? await calendar.getEvent(existingEvent.recurringEventId) : existingEvent;
      await this.preserveTodoistPhaseBNativeMaster(delivery, task, nativeMaster, mapping, todoist);
      return;
    }

    if (lifecycle.action === "upsert" && task.due?.is_recurring
      && isTodoistNativeSeries(mapping) && mapping?.masterEventId) {
      let phaseBMaster: CalendarEvent | undefined;
      try { phaseBMaster = await calendar.getEvent(mapping.masterEventId); }
      catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; }
      if (phaseBMaster && phaseBMaster.extendedProperties?.shared?.taskId === task.id
        && phaseBMaster.extendedProperties.shared.todoistPhaseBVersion === "1") {
        await this.preserveTodoistPhaseBNativeMaster(delivery, task, phaseBMaster, mapping, todoist);
        return;
      }
    }

    // Revalidate after all remote lookups. The write fence prevents a new
    // completion from racing this check until the provider write is finished.
    if (existingEvent && await this.calendarMutationBlockedByCompletion(delivery, existingEvent.id)) return;
    const desiredRrule = todoistRecurrenceToRrule(task);
    const todoistSeriesRuleEdit = Boolean(isTodoistNativeSeries(mapping)
      && mapping.masterEventId && existingEvent?.id === mapping.masterEventId
      && existingEvent.recurrence?.length && desiredRrule
      && !existingEvent.recurrence.includes(desiredRrule));
    const beforeSeriesExceptions = todoistSeriesRuleEdit && calendar.listExplicitSeriesExceptions
      ? await calendar.listExplicitSeriesExceptions(existingEvent!.id)
      : undefined;
    const phaseBPreview = phaseBProjectionPreview(task, desiredRrule);
    if (!mapping && existingEvent?.extendedProperties?.shared?.taskId === task.id
      && existingEvent.extendedProperties.shared.syncSeriesId === task.id) {
      return this.state.audit(delivery.profile, "todoist_phase_b_orphan_native_master_requires_review", {
        taskId: task.id, eventId: existingEvent.id,
      });
    }
    // A fresh recurring task with no counterpart enters native projection
    // through the same verified writer used during ordinary synchronization.
    if ((payload.event_name === "item:added" || payload.event_name === "item:updated")
      && candidateInventoryComplete && webhookTask && !mapping && !existingEvent
      && !pendingAnnualRecovery
      && modeAllowsMutations(delivery, await this.state.mutationAllowed(delivery.profile))) {
      const projectId = profiles[delivery.profile].todoistProjectId;
      let nativePlan;
      let verifiedCalendarTimeZone: string | undefined;
      try {
        const [calendarTimeZone, todoistTimeZone] = await Promise.all([
          calendar.getTimeZone(), todoist.getTimeZone(),
        ]);
        verifiedCalendarTimeZone = calendarTimeZone;
        nativePlan = admitNewTodoistPhaseBNative({
          source: webhookTask, providerReadback: task, eventName: payload.event_name,
          receivedAt: delivery.receivedAt, projectId, calendarTimeZone,
          todoistTimeZone, hasMapping: Boolean(existingMapping), hasCalendarAlias: false,
          hasPendingRecovery: Boolean(pendingAnnualRecovery),
        });
      } catch (error) {
        await this.state.audit(delivery.profile, "todoist_phase_b_native_admission_rejected", {
          taskId: task.id, reason: "provider_evidence_unavailable",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (nativePlan?.admitted) {
        const phaseBTask = task;
        const nativeEvent = toCalendarEvent(task);
        nativeEvent.id = createHash("sha256")
          .update(`todoist-phase-b:${delivery.profile}:${task.id}`).digest("hex").slice(0, 32);
        nativeEvent.recurrence = [nativePlan.rule];
        nativeEvent.extendedProperties ||= {};
        nativeEvent.extendedProperties.shared ||= {};
        Object.assign(nativeEvent.extendedProperties.shared, {
          todoistRecurrence: todoistRecurrenceKey(task)!,
          todoistAnchorStart: nativePlan.anchor.start,
          todoistAnchorEnd: addDays(nativePlan.anchor.start, 1),
          todoistAnchorAllDay: "true",
          todoistAnchorTimeZone: nativePlan.anchor.timeZone,
          todoistPhaseBVersion: "1",
        });
        // A lost POST response is not proof no master exists. The deterministic
        // event ID and exact provider readback make the next delivery safe to
        // retry without a durable pair quarantine.
        let creation: Awaited<ReturnType<typeof calendar.createTodoistPhaseBNativeMasterOnce>>;
        try {
          creation = await calendar.createTodoistPhaseBNativeMasterOnce(nativeEvent);
        } catch (error) {
          await this.state.audit(delivery.profile, "todoist_phase_b_native_create_retryable", {
            taskId: task.id, eventId: nativeEvent.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // The POST may have committed even when its response was lost. Let
          // SQS retry the same delivery; its deterministic Calendar ID will
          // read back that object and finish correlation instead of acking a
          // half-created pair.
          throw new SafeProviderReplayError(`Calendar master creation needs retry for Todoist task ${task.id}`, { cause: error });
        }
        const rejectCreatedMaster = async (reason: string, preserveForRetry = false): Promise<never> => {
          let rollback = "not_owned";
          const createdShared = creation.event.extendedProperties?.shared;
          const exactUncommittedIdentity = creation.event.id === nativeEvent.id
            && createdShared?.taskId === phaseBTask.id
            && createdShared?.todoistPhaseBVersion === "1"
            && createdShared?.todoistAnchorStart === nativePlan.anchor.start
            && JSON.stringify(creation.event.recurrence) === JSON.stringify(nativeEvent.recurrence);
          // Missing/lagging instances and failed reads are not proof that a
          // valid master is bad. Preserve it and retry the same deterministic
          // identity so delayed Calendar visibility cannot orphan the pair.
          if (preserveForRetry) rollback = "preserved_for_retry";
          // A previous delivery's 409 conflict never authorizes this delivery
          // to delete the pre-existing master, even on verification failure.
          else if (exactUncommittedIdentity && creation.created && creation.event.etag) {
            try {
              await calendar.deleteEventIfUnchanged(nativeEvent.id, creation.event.etag);
              rollback = "deleted";
            } catch (error) {
              rollback = "failed";
            }
            if (rollback === "deleted") {
              try { await this.state.recordMutation(delivery.profile); }
              catch { rollback = "deleted_budget_record_failed"; }
            }
          }
          if (rollback !== "deleted") {
            // Includes 409 conflicts, ETag precondition failures, missing
            // ETags and mutation-budget uncertainty. The next reconciliation
            // re-reads the deterministic ID and either verifies the existing
            // object or retries the same create. Never flatten to a one-off.
          }
          await this.state.audit(delivery.profile, "todoist_phase_b_native_write_retryable", {
            taskId: phaseBTask.id, eventId: nativeEvent.id, reason, rollback,
          });
          throw new SafeProviderReplayError(
            `Calendar native write needs retry for Todoist task ${phaseBTask.id}: ${reason}`,
          );
        };
        if (creation.created) {
          try { await this.state.recordMutation(delivery.profile); }
          catch {
            await rejectCreatedMaster("provider_write_budget_record_failed", true);
          }
        }
        let readback: CalendarEvent;
        let instances: CalendarEvent[];
        let active: CalendarEvent | undefined;
        let explicitExceptions: CalendarEvent[];
        try {
          readback = await calendar.getEvent(nativeEvent.id);
          const windowEnd = addDays(nativePlan.anchor.start, 400);
          const [observedInstances, observedExceptions] = await Promise.all([
            calendar.listInstancesInWindow(nativeEvent.id,
              `${nativePlan.anchor.start}T00:00:00Z`, `${windowEnd}T00:00:00Z`),
            calendar.listExplicitSeriesExceptions(nativeEvent.id),
          ]);
          instances = observedInstances;
          explicitExceptions = observedExceptions;
        } catch {
          await rejectCreatedMaster("provider_readback_failed", true);
        }
        const verification = verifyInitialPhaseBCalendarWrite(nativePlan, task, {
          master: readback!, instances: instances!, explicitExceptions: explicitExceptions!, exceptionInventoryComplete: true,
          calendarTimeZone: verifiedCalendarTimeZone || "",
        });
        if (!verification.accepted) {
          const transientReadback = verification.reason === "calendar_master_or_instances_missing";
          await rejectCreatedMaster(verification.reason, transientReadback);
        }
        active = selectTodoistCurrentInstance(instances!, task);
        if (!active) await rejectCreatedMaster("active_instance_unresolved", true);
        const nextMapping: Mapping = {
          profile: delivery.profile, eventId: readback!.id, taskId: task.id,
          projectId: task.project_id, recurrenceId: active!.recurringEventId,
          seriesId: task.id, masterEventId: readback!.id,
          activeInstanceId: active!.id, originalStart: recurrenceOriginalStart(active!),
          activeEffectiveStart: eventEffectiveStart(active!), todoistPhaseBVersion: 1,
          updatedAt: new Date().toISOString(),
        };
        let persistedMapping: Mapping;
        let verifiedMaster: CalendarEvent;
        try {
          persistedMapping = await this.persistProviderMapping(nextMapping, projectCommentClient);
          verifiedMaster = await calendar.getEvent(readback!.id);
        } catch (error) {
          throw new SafeProviderReplayError(
            `Calendar and Todoist mapping readback needs retry for task ${task.id}`,
            { cause: error },
          );
        }
        const shared = verifiedMaster.extendedProperties?.shared || {};
        if (verifiedMaster.id !== readback!.id || shared.taskId !== task.id || shared.syncTaskId !== task.id
          || shared.syncProfile !== delivery.profile
          || shared.syncCalendarId !== profiles[delivery.profile].calendarId
          || shared.syncEventId !== readback!.id || shared.syncMasterEventId !== readback!.id
          || shared.syncActiveInstanceId !== active!.id
          || persistedMapping.taskId !== task.id || persistedMapping.eventId !== readback!.id
          || persistedMapping.masterEventId !== readback!.id || persistedMapping.activeInstanceId !== active!.id) {
          throw new SafeProviderReplayError(`Calendar and Todoist mapping readback needs retry for task ${task.id}`);
        }
        return this.state.audit(delivery.profile, "todoist_phase_b_native_calendar_created", {
          taskId: task.id, eventId: readback!.id, activeInstanceId: active!.id,
          family: nativePlan.family, rule: nativePlan.rule,
        });
      }
      if (nativePlan && !nativePlan.admitted) {
        await this.state.audit(delivery.profile, "todoist_phase_b_native_admission_rejected", {
          taskId: task.id, reason: nativePlan.reason,
        });
      }
    }
    // A recurring source without an already verified provider counterpart can
    // never enter the ordinary one-off writer. Native recurrence creation
    // above is the only path that may establish its Calendar master; if that
    // admission is unavailable, leave the Todoist source intact for a later
    // supported repair instead of flattening it into a standalone event.
    if (task.due?.is_recurring && !existingEvent && !pendingAnnualRecovery) {
      return this.state.audit(delivery.profile, "todoist_recurrence_unsupported_rule", {
        taskId: task.id, reason: "verified_native_calendar_master_required",
        nonBlocking: true, existingMirrorPreserved: false, outcome: "source_left_unchanged",
      });
    }
    if (task.due?.is_recurring && !todoistRecurrenceToRrule(task)) {
      return this.state.audit(delivery.profile, "todoist_recurrence_unsupported_rule", {
        taskId: task.id, eventId: existingEvent?.id || mapping?.eventId,
        existingMirrorPreserved: Boolean(existingEvent), outcome: "source_left_unchanged",
      });
    }
    // Even when provider mapping correlation is missing, the Calendar master
    // may retain a verified Todoist ownership marker. Never overwrite/delete
    // that master for a still-unverified Phase B cadence.
    if (phaseBPreview.phaseBFamily && !desiredRrule && existingEvent?.recurrence?.length
      && (isTodoistNativeSeries(mapping)
        || Boolean(existingEvent.extendedProperties?.shared?.todoistRecurrence))) {
      return this.state.audit(delivery.profile, "todoist_phase_b_existing_series_requires_review", {
        taskId: task.id, eventId: existingEvent.id, ...phaseBPreview,
      });
    }
    if (!recurringDateEdit && isTodoistNativeSeries(mapping) && mapping?.masterEventId && existingEvent?.recurrence?.length && desiredRrule) {
      const instances = await listBoundedRecurrenceInstances(calendar, existingEvent.id,
        taskDateTime(task) || task.due?.date || mapping.activeEffectiveStart);
      const mappedActive = mapping.activeInstanceId
        ? instances.find((instance) => instance.id === mapping!.activeInstanceId && instance.status !== "cancelled")
        : undefined;
      const active = mappedActive && occurrenceStateMatches(mappedActive, task)
        ? mappedActive
        : selectTodoistCurrentInstance(instances, task);
      if (active && occurrenceStateMatches(active, task) && calendarRecurrenceMatchesTodoist(existingEvent, task) && recurrenceAnchorMatches(existingEvent)) {
        const nextMapping = todoistOwnedMapping(mapping, existingEvent.id, task.id, active);
        await this.persistProviderMapping(nextMapping);
        return this.state.audit(delivery.profile, "todoist_recurrence_active_instance_noop", { taskId: task.id, eventId: existingEvent.id, activeInstanceId: active.id });
      }
    }

    const convertingRecurringMasterToOneOff = Boolean(existingEvent?.recurrence?.length && !task.due?.is_recurring);
    if (!recurringDateEdit && !convertingRecurringMasterToOneOff
      && existingEvent && hasCanonicalState(existingEvent, task)) {
      const todoistRecurring = Boolean(task.due?.is_recurring);
      const todoistRrule = Boolean(desiredRrule && existingEvent.recurrence?.length);
      // A Calendar-owned recurrence may be echoed back by Todoist with an
      // ending-only recurrence phrase that we cannot convert to an RRULE.
      // Preserve its verified master link instead of transferring ownership
      // merely because Todoist marks the due date as recurring.
      const preservedCalendarMapping = isCalendarNativeSeries(mapping) && mapping?.masterEventId ? mapping : undefined;
      let active: CalendarEvent | undefined;
      if (todoistRrule) {
        const instances = await listBoundedRecurrenceInstances(calendar, existingEvent.id,
          taskDateTime(task) || task.due?.date || mapping?.activeEffectiveStart);
        const mappedActive = mapping?.activeInstanceId
          ? instances.find((instance) => instance.id === mapping!.activeInstanceId && instance.status !== "cancelled")
          : undefined;
        active = mappedActive && occurrenceStateMatches(mappedActive, task)
          ? mappedActive
          : selectTodoistCurrentInstance(instances, task);
      }
      if (pendingAnnualRecovery && (existingEvent.status!=="confirmed"
        || (pendingAnnualRecovery.sourcePolicy==="standalone"
          ? Boolean(existingEvent.recurrence?.length || existingEvent.recurringEventId || todoistRecurring)
          : !todoistRrule || !active || !occurrenceStateMatches(active,task)
            || !calendarRecurrenceMatchesTodoist(existingEvent,task)))) {
        return this.state.audit(delivery.profile,"todoist_cancelled_annual_projection_instance_unverified",{
          taskId:task.id,eventId:existingEvent.id,
        });
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
        seriesId: preservedCalendarMapping ? preservedCalendarMapping.seriesId : todoistRecurring ? task.id : undefined,
        masterEventId: preservedCalendarMapping ? preservedCalendarMapping.masterEventId : todoistRrule ? existingEvent.id : undefined,
        activeInstanceId: preservedCalendarMapping ? preservedCalendarMapping.activeInstanceId : todoistRrule ? active?.id : todoistRecurring ? existingEvent.id : undefined,
        originalStart: preservedCalendarMapping ? preservedCalendarMapping.originalStart : todoistRrule ? (active ? recurrenceOriginalStart(active) : mapping?.originalStart) : todoistRecurring ? recurrenceOriginalStart(existingEvent) : undefined,
        activeEffectiveStart: preservedCalendarMapping ? preservedCalendarMapping.activeEffectiveStart : todoistRrule ? (active ? eventEffectiveStart(active) : mapping?.activeEffectiveStart) : todoistRecurring ? eventEffectiveStart(existingEvent) : undefined,
        ...(existingEvent.extendedProperties?.shared?.todoistPhaseBVersion === "1" ? { todoistPhaseBVersion: 1 as const } : {}),
        updatedAt: new Date().toISOString(),
      };
      await persistDeterministicPairMapping(nextMapping);
      if (pendingAnnualRecovery) await this.state.completeCancelledAnnualRecovery?.(delivery.profile,task.id,existingEvent.id);
      // Only the verified uncompletion path can withdraw completion markers.
      return this.state.audit(delivery.profile, "todoist_noop_canonical_state", {
        taskId: task.id, eventId: existingEvent.id, ...phaseBPreview,
      });
    }
    // Re-read the authoritative source immediately before the provider POST.
    // A redelivered webhook must not project a superseded task revision.
    if (pendingAnnualRecovery) {
      const source = await todoist.getTask(task.id);
      if (!source || source.is_completed || source.is_deleted || source.completed_at
        || !recoveryReceiptMatchesTask(pendingAnnualRecovery,source)
        || recoverySourceFingerprint(source)!==recoverySourceFingerprint(task)) {
        return this.state.audit(delivery.profile,"todoist_cancelled_recovery_source_changed_prewrite",{
          taskId:task.id,
        });
      }
    }
    const event = toCalendarEvent(task, existingEvent, !recurringDateEdit);
    if (pendingAnnualRecovery?.candidateEventId) {
      if (mapping?.eventId && mapping.eventId!==pendingAnnualRecovery.candidateEventId) {
        return this.state.audit(delivery.profile,"todoist_cancelled_recovery_unapproved_counterpart",{
          taskId:task.id,
        });
      }
      event.id=pendingAnnualRecovery.candidateEventId;
      event.extendedProperties ||= {};
      event.extendedProperties.shared ||= {};
      event.extendedProperties.shared.syncRecoveryFingerprint=pendingAnnualRecovery.sourceFingerprint!;
    }
    const creatingDeterministicStandalone = Boolean(deterministicStandaloneId && !existingEvent && !mapping);
    if (creatingDeterministicStandalone) event.id = deterministicStandaloneId!;
    let stored:CalendarEvent;
    try {
      stored=await calendar.upsertEvent(event, existingEvent?.id || mapping?.eventId);
    } catch (error) {
      if (creatingDeterministicStandalone) {
        if (Number((error as { status?: number }).status) === 409) {
          try {
            const exact = await calendar.getEvent(deterministicStandaloneId!);
            const shared = exact.extendedProperties?.shared || {};
            if (exact.id === deterministicStandaloneId && exact.status !== "cancelled"
              && !exact.recurrence?.length && !exact.recurringEventId
              && shared.taskId === task.id
              && (!shared.syncProfile || shared.syncProfile === delivery.profile)
              && (!shared.syncCalendarId || shared.syncCalendarId === profiles[delivery.profile].calendarId)) {
              stored = exact;
            } else {
              throw new Error("Deterministic Calendar event ID is owned by a different object");
            }
          } catch (readbackError) {
            if (readbackError instanceof Error
              && readbackError.message === "Deterministic Calendar event ID is owned by a different object") throw readbackError;
            throw new SafeProviderReplayError(
              `Calendar creation needs retry for Todoist task ${task.id}`,
              { cause: readbackError },
            );
          }
        } else {
          throw new SafeProviderReplayError(
            `Calendar creation needs retry for Todoist task ${task.id}`,
            { cause: error },
          );
        }
      } else {
        if (deterministicStandaloneId) {
          throw new SafeProviderReplayError(
            `Calendar update needs retry for Todoist task ${task.id}`,
            { cause: error },
          );
        }
        if (!pendingAnnualRecovery?.candidateEventId || Number((error as {status?:number}).status)!==409)
          throw error;
        // A lost response cannot justify a second provider identity. A 409
        // can only adopt the exact receipt-owned, confirmed canonical object.
        const found=await calendar.getEvent(pendingAnnualRecovery.candidateEventId);
        if (found.id!==pendingAnnualRecovery.candidateEventId || found.status!=="confirmed"
          || found.extendedProperties?.shared?.taskId!==task.id
          || found.extendedProperties?.shared?.syncRecoveryFingerprint!==pendingAnnualRecovery.sourceFingerprint
          || !hasCanonicalState(found,task)) {
          return this.state.audit(delivery.profile,"todoist_cancelled_recovery_duplicate_id_conflict",{taskId:task.id});
        }
        stored=found;
      }
    }
    // Count the Calendar write before any readback can return or retry. A
    // failed recurrence verification may issue a second conditional rollback.
    try { await this.state.recordMutation(delivery.profile); }
    catch (error) {
      if (!deterministicStandaloneId) throw error;
      throw new SafeProviderReplayError(
        `Calendar mutation state recording needs retry for Todoist task ${task.id}`,
        { cause: error },
      );
    }
    const todoistRecurring = Boolean(task.due?.is_recurring);
    let verifiedStored = stored;
    if (todoistRecurring) {
      verifiedStored = await calendar.getEvent(stored.id);
      const phaseBNative = verifiedStored.extendedProperties?.shared?.todoistPhaseBVersion === "1"
        && verifiedStored.extendedProperties.shared.taskId === task.id;
      const recurrenceVerified = desiredRrule
        ? Boolean(verifiedStored.recurrence?.includes(desiredRrule))
        : phaseBNative && Boolean(verifiedStored.recurrence?.length);
      if (!recurrenceVerified) {
        let rollback = "not_attempted";
        try {
          if (existingEvent?.id === stored.id && verifiedStored.etag) {
            await calendar.upsertEventIfUnchanged(existingEvent, stored.id, verifiedStored.etag);
            rollback = "previous_event_restored";
          } else if (!existingEvent && verifiedStored.etag) {
            await calendar.deleteEventIfUnchanged(stored.id, verifiedStored.etag);
            rollback = "created_event_deleted";
          }
          if (rollback !== "not_attempted") await this.state.recordMutation(delivery.profile);
        } catch {
          rollback = "failed";
        }
        await this.state.audit(delivery.profile, "todoist_recurrence_calendar_readback_mismatch", {
          taskId: task.id, eventId: verifiedStored.id, expectedRrule: desiredRrule,
          observedRecurrence: verifiedStored.recurrence || [], rollback,
        });
        throw new Error(`Calendar did not retain recurring projection for task ${task.id}`);
      }
    } else if (existingEvent?.recurrence?.length) {
      verifiedStored = await calendar.getEvent(stored.id);
      const shared = verifiedStored.extendedProperties?.shared || {};
      const staleRecurrenceMetadata = [
        "syncSeriesId", "syncMasterEventId", "syncActiveInstanceId", "syncOriginalStart",
        "syncActiveEffectiveStart", "syncProgressVersion", "syncCompletedThrough",
        "syncTodoistPhaseBVersion", "todoistRecurrence", "todoistAnchorStart", "todoistAnchorEnd",
        "todoistAnchorAllDay", "todoistAnchorTimeZone", "todoistTemplateSummary",
        "todoistTemplateDescription", "todoistPhaseBVersion",
      ].filter((property) => shared[property] !== undefined);
      if (verifiedStored.id !== existingEvent.id || verifiedStored.recurrence?.length || staleRecurrenceMetadata.length) {
        await this.state.audit(delivery.profile, "todoist_recurrence_to_one_off_readback_mismatch", {
          taskId: task.id, eventId: verifiedStored.id,
          observedRecurrence: verifiedStored.recurrence || [], staleRecurrenceMetadata,
        });
        throw new Error(`Calendar did not retain one-off conversion for task ${task.id}`);
      }
    }
    const todoistRrule = Boolean(verifiedStored.recurrence?.length);
    let active: CalendarEvent | undefined;
    if (todoistRrule) {
      const instances = await listBoundedRecurrenceInstances(calendar, verifiedStored.id,
        taskDateTime(task) || task.due?.date || mapping?.activeEffectiveStart);
      const mappedActive = mapping?.activeInstanceId
        ? instances.find((instance) => instance.id === mapping!.activeInstanceId && instance.status !== "cancelled")
        : undefined;
      active = mappedActive && occurrenceStateMatches(mappedActive, task)
        ? mappedActive
        : selectTodoistCurrentInstance(instances, task);
      if (!active) {
        let rollback = "not_attempted";
        try {
          if (existingEvent?.id === verifiedStored.id && verifiedStored.etag) {
            await calendar.upsertEventIfUnchanged(existingEvent, verifiedStored.id, verifiedStored.etag);
            rollback = "previous_event_restored";
          } else if (!existingEvent && verifiedStored.etag) {
            await calendar.deleteEventIfUnchanged(verifiedStored.id, verifiedStored.etag);
            rollback = "created_event_deleted";
          }
          if (rollback !== "not_attempted") await this.state.recordMutation(delivery.profile);
        } catch {
          rollback = "failed";
        }
        await this.state.audit(delivery.profile, "todoist_recurrence_calendar_instance_unresolved", {
          taskId: task.id, eventId: verifiedStored.id, rollback,
        });
        throw new Error(`Calendar recurring projection has no matching active instance for task ${task.id}`);
      }
    }
    if (todoistSeriesRuleEdit) {
      const afterExceptions = beforeSeriesExceptions && calendar.listExplicitSeriesExceptions
        ? await calendar.listExplicitSeriesExceptions(stored.id)
        : undefined;
      const shared = verifiedStored.extendedProperties?.shared;
      const identityVerified = verifiedStored.id === mapping!.masterEventId
        && verifiedStored.status === "confirmed"
        && shared?.taskId === task.id
        && verifiedStored.recurrence?.includes(desiredRrule!)
        && shared.todoistRecurrence === todoistRecurrenceKey(task)
        && Boolean(active && occurrenceStateMatches(active, task));
      const exceptionsVerified = beforeSeriesExceptions === undefined
        || afterExceptions !== undefined
          && explicitExceptionFingerprint(beforeSeriesExceptions) === explicitExceptionFingerprint(afterExceptions);
      if (!identityVerified || !exceptionsVerified) {
        return this.state.audit(delivery.profile, "todoist_series_rule_edit_readback_mismatch", {
          taskId: task.id, eventId: stored.id, expectedRule: desiredRrule,
          identityVerified, exceptionsVerified,
        });
      }
    }
    if (pendingAnnualRecovery && (
      (pendingAnnualRecovery.candidateEventId && (verifiedStored.id!==pendingAnnualRecovery.candidateEventId
        || verifiedStored.extendedProperties?.shared?.syncRecoveryFingerprint!==pendingAnnualRecovery.sourceFingerprint))
      || verifiedStored.status!=="confirmed"
      || (pendingAnnualRecovery.sourcePolicy==="standalone"
        ? Boolean(verifiedStored.recurrence?.length || verifiedStored.recurringEventId || todoistRecurring || !hasCanonicalState(verifiedStored,task))
        : !todoistRrule || !active || !occurrenceStateMatches(active,task)
          || !calendarRecurrenceMatchesTodoist(verifiedStored,task)))) {
      return this.state.audit(delivery.profile,"todoist_cancelled_annual_projection_instance_unverified",{
        taskId:task.id,eventId:verifiedStored.id,
      });
    }
    const nextMapping: Mapping = {
      profile: delivery.profile,
      eventId: verifiedStored.id,
      taskId: task.id,
      projectId: task.project_id || mapping?.projectId,
      projectCommentId: mapping?.projectCommentId,
      taskCommentId: mapping?.taskCommentId,
      commentId: mapping?.commentId,
      mappingRevision: mapping?.mappingRevision,
      recurrenceId: verifiedStored.recurringEventId,
      seriesId: todoistRecurring ? task.id : undefined,
      masterEventId: todoistRrule ? verifiedStored.id : undefined,
      activeInstanceId: todoistRrule ? active?.id : undefined,
      originalStart: todoistRrule ? (active ? recurrenceOriginalStart(active) : recurrenceOriginalStart(verifiedStored)) : undefined,
      activeEffectiveStart: todoistRrule ? (active ? eventEffectiveStart(active) : undefined) : undefined,
      ...(stored.extendedProperties?.shared?.todoistPhaseBVersion === "1" ? { todoistPhaseBVersion: 1 as const } : {}),
      updatedAt: new Date().toISOString(),
    };
    await persistDeterministicPairMapping(nextMapping);
    if (pendingAnnualRecovery) await this.state.completeCancelledAnnualRecovery?.(delivery.profile,task.id,stored.id);
    await this.state.audit(delivery.profile, mapping ? "todoist_updated_calendar" : "todoist_created_calendar", {
      taskId: task.id,
      eventId: verifiedStored.id,
      recurrenceProjection: todoistRrule ? "rrule" : "none",
      activeInstanceId: active?.id,
      recurrenceReanchored: recurringDateEdit && todoistRrule,
      ...phaseBPreview,
    });
    } finally {
      if (writeFence) await this.state.endTodoistCalendarWrite?.(task.id, writeFence);
    }
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
    const mapping = await this.providerMappingByEvent(delivery.profile, orphan.eventId, todoist);
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
    // Both exact provider reads have now established terminal absence. Retire
    // the provider-native correlation only after that proof so a retry can
    // still identify the same pair if Calendar deletion fails or is ambiguous.
    await deleteMappingComments(todoist, mapping);
    await this.state.recordMutation?.(delivery.profile);
    await this.state.audit(delivery.profile, "orphan_confirmed_deleted", {
      ...orphan,
      alreadyDeleted,
    });
  }
}
