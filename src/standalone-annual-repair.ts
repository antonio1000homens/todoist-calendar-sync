import { createHash } from "node:crypto";
import { normalizedText } from "./security.js";
import { calendarLocalDay } from "./recurrence-split.js";
import { calendarRecurrenceMatchesTodoist, selectTodoistCurrentInstance, todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import { hasCanonicalState, toCalendarEvent } from "./sync.js";
import type { ProviderClients } from "./mutation-budget.js";
import type { StateRepository } from "./repository.js";
import type { CalendarEvent, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";

/** A standalone event has no RRULE to cap. Never move a historical DTSTART. */
export interface StandaloneAnnualPlan {
  sourceId: string;
  sourceEtag: string;
  masterId: string;
  activeInstanceId?: string;
  mode: "keep-history" | "annualize-in-place" | "reuse-existing";
  rule: string;
  start: string;
  end: string;
  originalStart: string;
  originalEnd: string;
  timeZone: string;
  taskFingerprint: string;
}
const day = (value: string): number => {
  const stamp = Date.parse(value + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(stamp)
    || new Date(stamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Standalone annual repair requires valid all-day dates");
  }
  return stamp;
};
const normalize = (value?: string) => normalizedText(value).toLowerCase();
const hashTask = (task: TodoistTask) => createHash("sha256").update(JSON.stringify([
  task.id, task.project_id, task.content, task.description, task.updated_at,
  task.is_deleted, task.is_completed, task.due,
])).digest("hex");
const addDays = (date: string, n: number) => new Date(day(date) + n * 86400000).toISOString().slice(0, 10);

export function planStandaloneAnnualRepair(
  profile: Profile, task: TodoistTask, source: CalendarEvent, timeZone: string, now = new Date(), existingMasterId?: string, activeInstanceId?: string,
): StandaloneAnnualPlan {
  if (!source.id || !source.etag || source.status !== "confirmed" || source.recurringEventId || source.recurrence?.length) {
    throw new Error("Select a confirmed standalone Calendar event without a recurrence or parent");
  }
  if (task.is_deleted || task.is_completed || !task.due?.is_recurring || !task.due.date
    || task.due.datetime || task.due.date.includes("T")
    || !source.start?.date || source.start.dateTime || !source.end?.date || source.end.dateTime) {
    throw new Error("Standalone annual repair supports an active all-day recurring Todoist task and all-day Calendar event only");
  }
  const rule = todoistRecurrenceToRrule(task);
  if (!rule || !/^RRULE:FREQ=YEARLY(?:;INTERVAL=[1-9]\d{0,2})?$/.test(rule)) {
    throw new Error("Todoist recurrence is not an unambiguous YEARLY rule; resolve this recurrence manually");
  }
  const due = task.due.date, start = source.start.date, end = source.end.date;
  if (day(due) < day(calendarLocalDay(now, timeZone))) throw new Error("The active recurring Todoist due date is in the past");
  if (day(start) > day(due) || day(end) <= day(start)) {
    throw new Error("Standalone Calendar history is after the selected Todoist due date or has an invalid duration");
  }
  if (normalize(source.summary) !== normalize(task.content)) {
    throw new Error("Standalone Calendar title differs from the recurring task; verify the exact historical identity first");
  }
  const linked = source.extendedProperties?.shared?.taskId;
  if (linked && linked !== task.id) throw new Error("Standalone Calendar event already claims a different Todoist task");
  if (source.extendedProperties?.shared?.syncHistoryOnly === "true") {
    throw new Error("Calendar event is already archived history; use its recorded successor instead");
  }
  const sameDay = start === due;
  const duration = Math.round((day(end) - day(start)) / 86400000);
  const mode = sameDay ? "annualize-in-place" : existingMasterId ? "reuse-existing" : "keep-history";
  const masterId = sameDay ? source.id : existingMasterId || createHash("sha256")
    .update(`standalone-annual-v1:${profile}:${task.id}:${source.id}:${due}:${rule}`)
    .digest("hex").slice(0, 32);
  return {
    sourceId: source.id, sourceEtag: source.etag, masterId, activeInstanceId, mode, rule,
    start: due, end: addDays(due, duration), originalStart: start, originalEnd: end,
    timeZone, taskFingerprint: hashTask(task),
  };
}

/** A preflight shared by preview and execution; no title-only ownership guesses. */
export async function verifyStandaloneAnnualOwnership(
  profile: Profile, task: TodoistTask, source: CalendarEvent,
  plan: StandaloneAnnualPlan, pair: ProviderClients, state: StateRepository,
  allowApprovedResume = false,
): Promise<void> {
  const [taskMapping, sourceMapping, link, tombstone, completed, history, otherTasks, occurrences, linked] = await Promise.all([
    state.getMappingByTaskAnyProfile(task.id), state.getMappingByEvent(profile, source.id),
    state.getRecurrenceLink(profile, task.id),
    state.getCalendarProjectionTombstone(profile, task.id),
    state.getCompletedCalendarProjectionByEvent(profile, source.id),
    state.listCompletedCalendarProjectionsByTaskAnyProfile(task.id),
    pair.todoist.listTasks(),
    pair.calendar.listOccurrencesInWindow(addDays(plan.start, -2) + "T00:00:00Z", addDays(plan.start, 3) + "T00:00:00Z"),
    pair.calendar.findByTodoistTaskId(task.id),
  ]);
  if (taskMapping || sourceMapping || link || tombstone || completed || history.length) {
    throw new Error("The selected task or historical event already has a mapping, recurrence owner or completed-history record; use a guarded ownership transfer, not a new-series repair");
  }
  if (linked && linked.id !== source.id && !(allowApprovedResume && linked.id === plan.masterId)) {
    throw new Error(`Another Calendar projection already claims this task (${linked.id}); select its recurring master or resolve duplicates`);
  }
  if (otherTasks.some(other => other.id !== task.id && !other.is_deleted && !other.is_completed
    && normalize(other.content) === normalize(task.content))) {
    throw new Error("Another active Todoist task has the same title; resolve the competing mirror before annualizing");
  }
  if (plan.mode === "reuse-existing") {
    const active = occurrences.find(item => item.status !== "cancelled" && item.recurringEventId === plan.masterId
      && item.start?.date === plan.start && normalize(item.summary) === normalize(task.content));
    if (!active) throw new Error("The existing annual Calendar series no longer has the selected Todoist occurrence");
    const master = await pair.calendar.getEvent(plan.masterId);
    const shared = master.extendedProperties?.shared;
    if (!calendarRecurrenceMatchesTodoist(master, task) || normalize(master.summary) !== normalize(task.content)
      || (shared?.taskId && shared.taskId !== task.id)) {
      throw new Error("The matching Calendar recurrence is not already a verified Todoist-owned series; use a guarded ownership transfer");
    }
  }
  const conflicting = occurrences.find(item => item.status !== "cancelled"
    && item.id !== source.id && item.recurringEventId !== source.id
    && !(plan.mode === "reuse-existing" && item.recurringEventId === plan.masterId)
    && !(allowApprovedResume && (item.id === plan.masterId || item.recurringEventId === plan.masterId))
    && normalize(item.summary) === normalize(task.content));
  if (conflicting) {
    throw new Error(conflicting.recurringEventId
      ? `Existing Calendar recurrence ${conflicting.recurringEventId} already has an occurrence ${conflicting.id}; select that master and transfer its owner rather than creating a second series`
      : `Calendar event ${conflicting.id} is a competing same-date reminder; resolve its disposition before creating a series`);
  }
}

export function assertStandaloneHistory(source: CalendarEvent | null, plan: StandaloneAnnualPlan, taskId: string): void {
  if (!source || source.id !== plan.sourceId || source.status !== "confirmed"
    || source.start?.date !== plan.originalStart || source.end?.date !== plan.originalEnd
    || source.recurrence?.length || source.recurringEventId
    || source.extendedProperties?.shared?.taskId
    || source.extendedProperties?.shared?.syncHistoryOnly !== "true"
    || source.extendedProperties?.shared?.syncHistoryTaskId !== taskId
    || source.extendedProperties?.shared?.syncHistorySuccessorId !== plan.masterId) {
    throw new Error("Historical standalone Calendar event changed; preserve the repair barrier and inspect lineage");
  }
}

/** Creates no Todoist object and installs EVENT/TASK/TASKOWNER/RECURRENCE atomically. */
export async function applyStandaloneAnnualRepair(
  profile: Profile, approvedTask: TodoistTask, approvedSource: CalendarEvent,
  plan: StandaloneAnnualPlan, pair: ProviderClients, state: StateRepository,
): Promise<{ mapping: Mapping; master: CalendarEvent }> {
  const [task, source, zone] = await Promise.all([
    pair.todoist.getTask(approvedTask.id),
    pair.calendar.getEvent(approvedSource.id),
    pair.calendar.getTimeZone(),
  ]);
  if (zone !== plan.timeZone || hashTask(task) !== plan.taskFingerprint || source.id !== approvedSource.id) {
    throw new Error("Todoist or Calendar provider state changed after preview; refresh before applying an annual repair");
  }
  const started = source.etag !== plan.sourceEtag;
  if (started) {
    const marker = await state.getFutureSeriesSplitAnyProfile(task.id);
    if (!marker || marker.status !== "pending" || marker.profile !== profile
      || marker.taskId !== task.id || marker.oldMasterId !== plan.sourceId
      || marker.newMasterId !== plan.masterId
      || marker.previousOccurrence !== (plan.mode !== "annualize-in-place" ? plan.originalStart : undefined)) {
      throw new Error("Annual repair provider was modified without its exact pending split guard; manual review required");
    }
    if (plan.mode !== "annualize-in-place") {
      assertStandaloneHistory(source, plan, task.id);
      if (source.summary !== approvedSource.summary || source.description !== approvedSource.description) {
        throw new Error("Historical standalone fields changed after the approved repair");
      }
    } else if (source.id !== plan.masterId || source.status !== "confirmed"
      || source.start?.date !== plan.start || source.end?.date !== plan.end
      || !calendarRecurrenceMatchesTodoist(source, task) || !hasCanonicalState(source, task)) {
      throw new Error("Already annualized standalone master differs from the approved recurring task");
    }
    // A previous attempt may have committed the four mapping indexes before
    // losing the completion acknowledgement. Only the same exact ownership can resume.
    const previous = await state.getMappingByTaskAnyProfile(task.id);
    if (previous) {
      const link = await state.getRecurrenceLink(profile,task.id);
      if (previous.profile !== profile || previous.eventId !== plan.masterId
        || previous.masterEventId !== plan.masterId || previous.seriesId !== task.id
        || previous.recurrenceOwner !== "todoist" || link?.taskId !== task.id
        || link.masterEventId !== plan.masterId || link.activeInstanceId !== previous.activeInstanceId) {
        throw new Error("Another mapping owns the partial annual repair; manual recovery required");
      }
      const complete = await pair.calendar.getEvent(plan.masterId);
      if (!calendarRecurrenceMatchesTodoist(complete, task) || !hasCanonicalState(complete,task)) {
        throw new Error("Annual series differs from the committed mapping");
      }
      await state.completeFutureSeriesSplit(profile, task.id, plan.masterId);
      return {mapping:previous,master:complete};
    }
  } else {
    const recalculated = planStandaloneAnnualRepair(profile, task, source, zone, new Date(),
      plan.mode === "reuse-existing" ? plan.masterId : undefined,
      plan.mode === "reuse-existing" ? plan.activeInstanceId : undefined);
    for (const field of ["masterId", "mode", "rule", "start", "end", "originalStart", "originalEnd"] as const) {
      if (recalculated[field] !== plan[field]) throw new Error(`Approved annual repair changed (${field}); refresh the preview`);
    }
  }
  await verifyStandaloneAnnualOwnership(profile, task, source, plan, pair, state, started);
  // Fence Todoist deliveries before Calendar becomes a visible recurring master.
  await state.beginFutureSeriesSplit(profile, task.id, source.id, plan.masterId,
    plan.mode !== "annualize-in-place" ? plan.originalStart : undefined);
  let master: CalendarEvent;
  if (plan.mode !== "annualize-in-place") {
    const shared = { ...(source.extendedProperties?.shared || {}) };
    delete shared.taskId; delete shared.taskUrl; delete shared.syncRecurrenceOwner;
    delete shared.todoistRecurrence; delete shared.todoistAnchorStart; delete shared.todoistAnchorEnd;
    if (!started) {
      const preserved = await pair.calendar.upsertEventIfUnchanged({
        ...source, extendedProperties: {
          ...source.extendedProperties, shared: {
            ...shared, syncHistoryOnly: "true", syncHistoryTaskId: task.id,
            syncHistorySuccessorId: plan.masterId,
          },
        },
      }, plan.sourceId, source.etag!);
      assertStandaloneHistory(preserved, plan, task.id);
    }
    const projected = toCalendarEvent(task);
    master = plan.mode === "reuse-existing" ? await pair.calendar.getEvent(plan.masterId) : await pair.calendar.createFutureMasterOnce({
      ...projected, id: plan.masterId, start: { date:plan.start }, end:{ date:plan.end },
      extendedProperties: { ...projected.extendedProperties, shared: {
        ...projected.extendedProperties?.shared, syncHistoryMasterId:source.id,
        syncSplitVersion:"standalone-1", todoistAnchorEnd:plan.end,
        todoistAnchorTimeZone:zone,
      } },
    }, plan.sourceId);
  } else if (started) {
    master = source;
  } else {
    const shared = { ...(source.extendedProperties?.shared || {}) };
    for (const key of ["syncHistoryMasterId", "syncHistoryCutoff", "syncHistoryOnly", "syncHistoryTaskId",
      "syncHistorySuccessorId", "syncHistoryOriginalRule", "syncRecurrenceOwner", "todoistRecurrence",
      "todoistAnchorStart", "todoistAnchorEnd", "todoistAnchorAllDay", "todoistAnchorTimeZone",
      "todoistTemplateSummary", "todoistTemplateDescription", "syncSplitVersion"]) delete shared[key];
    const cleanSource = { ...source, extendedProperties: { ...source.extendedProperties, shared } };
    const projected = toCalendarEvent(task, cleanSource);
    master = await pair.calendar.upsertEventIfUnchanged({
      ...cleanSource, ...projected, id:source.id, status:"confirmed",
      start:{date:plan.start}, end:{date:plan.end},
      extendedProperties:{...cleanSource.extendedProperties,shared:{
        ...cleanSource.extendedProperties?.shared,...projected.extendedProperties?.shared,
        todoistAnchorEnd:plan.end, todoistAnchorTimeZone:zone,
      }},
    }, plan.sourceId, source.etag!);
  }
  if (master.id !== plan.masterId || (plan.mode !== "reuse-existing" && (master.start?.date !== plan.start
    || master.end?.date !== plan.end)) || !calendarRecurrenceMatchesTodoist(master, task)
    || !hasCanonicalState(master, task)) {
    throw new Error("Created Calendar recurrence differs from approved annual master; manual review is required");
  }
  const occurrences = await pair.calendar.listInstancesInWindow(master.id,
    addDays(plan.start,-1)+"T00:00:00Z",addDays(plan.start,2)+"T00:00:00Z");
  const active = selectTodoistCurrentInstance(occurrences, task);
  if (!active || active.status !== "confirmed" || active.recurringEventId !== master.id
    || active.start?.date !== plan.start) {
    throw new Error("Calendar did not return the approved current yearly occurrence");
  }
  const currentTask = await pair.todoist.getTask(task.id);
  if (hashTask(currentTask) !== plan.taskFingerprint) throw new Error("Todoist changed before recurrence mapping commit");
  const timestamp = new Date().toISOString();
  const mapping: Mapping = {
    profile, projectId:task.project_id, taskId:task.id, eventId:master.id,
    recurrenceOwner:"todoist", seriesId:task.id, masterEventId:master.id,
    activeInstanceId:active.id, originalStart:active.originalStartTime?.date || active.start?.date,
    activeEffectiveStart:active.start?.date, updatedAt:timestamp,
  };
  const link: RecurrenceLink = {
    profile, owner:"todoist", seriesId:task.id, taskId:task.id,
    eventId:master.id, masterEventId:master.id, activeInstanceId:active.id,
    originalStart:mapping.originalStart, activeEffectiveStart:mapping.activeEffectiveStart, updatedAt:timestamp,
  };
  if (!await state.putNewRecurrenceMappingIfUnowned(mapping, link)) {
    throw new Error("A competing Calendar or Todoist owner appeared during the annual repair; no mapping was overwritten");
  }
  await state.completeFutureSeriesSplit(profile,task.id,master.id);
  return {mapping,master};
}
