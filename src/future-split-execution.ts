import { attachProjectCommentReference } from "./mapping-comments.js";
import { planFutureSeriesSplit, assertUnmodifiedHistoricalOccurrences, type FutureSeriesSplitPlan } from "./recurrence-split.js";
import { hasCanonicalState, toCalendarEvent } from "./sync.js";
import { selectTodoistCurrentInstance } from "./todoist-recurrence.js";
import { normalizedText } from "./security.js";
import { profiles } from "./config.js";
import type { ProviderClients } from "./mutation-budget.js";
import type { StateRepository } from "./repository.js";
import type { CalendarEvent, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";

function addDays(date: string, days: number): string {
  const value = new Date(Date.parse(date + "T12:00:00Z") + days * 86400000);
  return value.toISOString().slice(0, 10);
}
function safeDate(value: string): number {
  return Date.parse(value + "T00:00:00Z");
}
function isUnmodifiedInstance(event: CalendarEvent, masterId: string): boolean {
  const original = event.originalStartTime?.date || event.start?.date;
  return Boolean(original && event.status === "confirmed" && event.recurringEventId === masterId
    && event.start?.date === original && event.end?.date === addDays(original, 1));
}
function sameTitle(a: string | undefined, b: string | undefined): boolean {
  return normalizedText(a).toLowerCase() === normalizedText(b).toLowerCase();
}
export interface FutureSplitResult {
  plan: FutureSeriesSplitPlan;
  mapping: Mapping;
  resumed: boolean;
}
/**
 * This operation is explicitly requested by a destructive, confirmed Slack
 * action. It never updates the old master DTSTART or deletes an occurrence.
 *
 * Ordering is deliberate:
 * 1. Validate identities, state, unchanged history and planned cutover.
 * 2. End only the FUTURE portion of the old RRULE, keeping past instances.
 * 3. Create a deterministic future master (409 = verify exact identity).
 * 4. Atomically install the new mapping and link after uniqueness checks.
 *
 * A retry can resume only the same verifiable archived lineage. Failures
 * leave the manual decision pending rather than silently restoring an old rule.
 */
export async function applyApprovedFutureSeriesSplit(
  profile: Profile, task: TodoistTask, old: CalendarEvent,
  pair: ProviderClients, state: StateRepository,
  options: { now?: Date; expectedRule?: string; expectedDue?: string } = {},
): Promise<FutureSplitResult> {
  const now = options.now || new Date();
  const plan = planFutureSeriesSplit(profile, task, old, now);
  const originalTaskId = old.extendedProperties?.shared?.syncHistoryTaskId;
  const archived = old.extendedProperties?.shared?.syncHistoryOnly === "true";
  if (task.project_id !== profiles[profile].todoistProjectId
    || task.is_deleted || task.is_completed || task.due?.date !== plan.newStart
    || (options.expectedDue && options.expectedDue !== plan.newStart)
    || (options.expectedRule && options.expectedRule !== plan.originalRule)) {
    throw new Error("Future split approval no longer matches the current task or Calendar schedule");
  }
  if (!archived && old.extendedProperties?.shared?.taskId !== task.id) {
    throw new Error("Legacy recurring Calendar master is not linked to the approved task");
  }
  if (archived && originalTaskId !== task.id) {
    throw new Error("Previously split Calendar series is not owned by this task");
  }
  const [owner, oldEventMapping, tombstone, completed, history, taskLink, oldLink, tasks, linked] = await Promise.all([
    state.getMappingByTaskAnyProfile(task.id),
    state.getMappingByEvent(profile, old.id),
    state.getCalendarProjectionTombstone(profile, task.id),
    state.getCompletedCalendarProjectionByEvent(profile, old.id),
    state.listCompletedCalendarProjectionsByTaskAnyProfile(task.id),
    state.getRecurrenceLink(profile, task.id),
    state.getRecurrenceLink(profile, old.iCalUID || old.id),
    pair.todoist.listTasks(),
    pair.calendar.findByTodoistTaskId(task.id),
  ]);
  if (tombstone || completed || history.length || oldEventMapping || oldLink) {
    throw new Error("A tombstone, completed occurrence or old-series owner blocks automatic history splitting");
  }
  if (owner && (owner.profile !== profile || owner.taskId !== task.id
    || owner.eventId !== plan.newMasterId || owner.recurrenceOwner !== "todoist")) {
    throw new Error("Task is already owned by another Calendar mapping");
  }
  if (taskLink && (taskLink.owner !== "todoist" || taskLink.taskId !== task.id
    || taskLink.masterEventId !== plan.newMasterId)) {
    throw new Error("An existing recurrence link has different ownership");
  }
  if (tasks.some((other) => other.id !== task.id && sameTitle(other.content, task.content))) {
    throw new Error("Another Todoist task has the same title; cannot prove unique recurring identity");
  }
  if (!archived && (!linked || linked.id !== old.id)) {
    throw new Error("The Calendar task-link search does not uniquely identify the historical master");
  }
  if (archived && linked && linked.id !== plan.newMasterId) {
    throw new Error("Archived master has another live Todoist-linked Calendar identity");
  }

  // Inspect explicit historical and upcoming instance ranges, not an open-ended
  // Google series expansion. A moved/cancelled occurrence needs human review.
  const historical = await pair.calendar.listInstancesInWindow(
    old.id, old.start!.date! + "T00:00:00Z", now.toISOString(),
  );
  assertUnmodifiedHistoricalOccurrences(old, historical, plan);
  // Annual recurrence exception discovery is bounded but extends a decade
  // beyond the first affected date, not only the next single occurrence.
  const nextWindowEnd = addDays(plan.nextOldOccurrence, 10 * 366) + "T00:00:00Z";
  const oldFuture = await pair.calendar.listInstancesInWindow(old.id, now.toISOString(), nextWindowEnd);
  if (!archived && oldFuture.some((item) =>
    !isUnmodifiedInstance(item, old.id)
    || !sameTitle(item.summary, old.summary)
    || normalizedText(item.description) !== normalizedText(old.description))) {
    throw new Error("Upcoming old-series occurrence overrides must be reviewed individually");
  }
  if (archived && oldFuture.length) {
    throw new Error("Archived Calendar history still has future occurrences");
  }

  const nearby = await pair.calendar.listOccurrencesInWindow(
    addDays(plan.newStart, -2) + "T00:00:00Z",
    addDays(plan.newStart, 3) + "T00:00:00Z",
  );
  const conflicts = nearby.filter((item) => item.status !== "cancelled"
    && sameTitle(item.summary, task.content)
    && item.id !== plan.newMasterId
    && item.recurringEventId !== plan.newMasterId
    && item.recurringEventId !== old.id && item.id !== old.id);
  if (conflicts.length) throw new Error("Another nearby Calendar occurrence may represent the same reminder");

  // Persist the split guard BEFORE the first provider write. If the worker
  // crashes after capping the master, hourly reconciliation and Todoist
  // webhooks must not create a competing recurrence while this remains pending.
  await state.beginFutureSeriesSplit(profile, task.id, old.id, plan.newMasterId);
  if (!archived) {
    const shared = { ...(old.extendedProperties?.shared || {}) };
    delete shared.taskId; // prevents old history + new master appearing as two linked identities
    delete shared.syncRecurrenceOwner;
    delete shared.todoistRecurrence;
    Object.assign(shared, {
      syncSource: "todoist-calendar-sync",
      syncHistoryOnly: "true", syncHistoryTaskId: task.id,
      syncHistoryOriginalRule: plan.originalRule,
      syncHistorySuccessorId: plan.newMasterId,
      syncHistoryCutoff: plan.previousOccurrence,
    });
    await pair.calendar.upsertEventIfUnchanged({
      ...old,
      recurrence: [plan.truncatedRule],
      extendedProperties: { ...old.extendedProperties, shared },
    }, old.id, plan.oldEtag);
  }
  const capped = await pair.calendar.getEvent(old.id);
  if (!sameTitle(capped.summary, old.summary)
    || normalizedText(capped.description) !== normalizedText(old.description)
    || capped.status !== "confirmed" || capped.recurrence?.[0] !== plan.truncatedRule
    || capped.extendedProperties?.shared?.syncHistoryOnly !== "true"
    || capped.extendedProperties?.shared?.syncHistorySuccessorId !== plan.newMasterId
    || capped.extendedProperties?.shared?.taskId) {
    throw new Error("Old Calendar history cap was not verified; future master will not be created");
  }
  const remainingFuture = await pair.calendar.listInstancesInWindow(old.id, now.toISOString(), nextWindowEnd);
  if (remainingFuture.length) throw new Error("Historical Calendar series still projects obsolete future occurrences");

  // A concrete ID makes retries safe even if the first request succeeded but
  // its response was lost; 409 is accepted only for the exact approved series.
  const requested = toCalendarEvent(task);
  const future = await pair.calendar.createFutureMasterOnce({
    ...requested,
    id: plan.newMasterId,
    extendedProperties: {
      ...requested.extendedProperties,
      shared: {
        ...(requested.extendedProperties?.shared || {}),
        syncHistoryMasterId: old.id,
        syncHistoryCutoff: plan.previousOccurrence,
        syncSplitVersion: "1",
      },
    },
  }, old.id);
  if (!hasCanonicalState(future, task) || future.id !== plan.newMasterId) {
    throw new Error("Future Calendar master does not match the approved Todoist recurrence");
  }
  const [currentTask, linkedNow, occurrences] = await Promise.all([
    pair.todoist.getTask(task.id),
    pair.calendar.findByTodoistTaskId(task.id),
    pair.calendar.listInstancesInWindow(
      future.id, addDays(plan.newStart, -1) + "T00:00:00Z",
      addDays(plan.newStart, 2) + "T00:00:00Z",
    ),
  ]);
  if (!currentTask.due?.is_recurring || currentTask.due.date !== task.due?.date
    || currentTask.due.string !== task.due?.string
    || currentTask.content !== task.content || currentTask.updated_at !== task.updated_at
    || linkedNow?.id !== future.id) {
    throw new Error("Todoist task or Calendar linked identity changed before mapping");
  }
  const active = selectTodoistCurrentInstance(occurrences, currentTask);
  if (!active || active.status !== "confirmed"
    || active.recurringEventId !== future.id
    || active.start?.date !== plan.newStart) {
    throw new Error("New recurring master has no verifiable first Todoist occurrence");
  }
  const existing = await state.getMappingByTaskAnyProfile(task.id);
  if (existing) {
    const currentLink = await state.getRecurrenceLink(profile, task.id);
    if (existing.eventId !== future.id || existing.recurrenceOwner !== "todoist"
      || currentLink?.masterEventId !== future.id || currentLink.taskId !== task.id) {
      throw new Error("Ownership changed during the series split");
    }
    await state.completeFutureSeriesSplit(profile, task.id, future.id);
    return { mapping: existing, plan, resumed: true };
  }

  const draft: Mapping = {
    profile, projectId: task.project_id, taskId: task.id, eventId: future.id,
    recurrenceOwner: "todoist", seriesId: task.id, masterEventId: future.id,
    activeInstanceId: active.id, originalStart: active.originalStartTime?.date || active.start?.date,
    activeEffectiveStart: active.start?.date, updatedAt: new Date().toISOString(),
  };
  const existingComment = await pair.todoist.findComment(task.id, future.id)
    || await pair.todoist.findComment(task.id, old.id);
  const comment = await pair.todoist.upsertComment(
    task.id, `todoist-calendar-sync\ncalendarEventId=${future.id}\ncalendarUrl=${future.htmlLink || ""}`,
    existingComment?.id, draft,
  );
  const reference = existingComment?.id ? { ...draft, commentId: existingComment.id } : draft;
  const mapping = attachProjectCommentReference(reference, task.project_id!, comment.id);
  const link: RecurrenceLink = {
    profile, owner: "todoist", seriesId: task.id, masterEventId: future.id,
    activeInstanceId: active.id, originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart, taskId: task.id,
    eventId: future.id, updatedAt: mapping.updatedAt,
  };
  const committed = await state.putNewRecurrenceMappingIfUnowned(mapping, link);
  if (!committed) throw new Error("A concurrent mapping or tombstone claimed the task before commit");
  await state.completeFutureSeriesSplit(profile, task.id, future.id);
  await state.audit(profile, "manual_future_series_split_applied", {
    taskId: task.id, oldMasterId: old.id, newMasterId: future.id,
    priorOccurrence: plan.previousOccurrence, newStart: plan.newStart,
    priorRule: plan.originalRule, newRule: plan.newRule,
  });
  return { mapping, plan, resumed: archived };
}
