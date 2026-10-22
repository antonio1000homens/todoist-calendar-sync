import { attachProjectCommentReference, buildProjectMappingIndex, deleteMappingComments } from "./mapping-comments.js";
import { planFutureSeriesSplit, assertUnmodifiedHistoricalOccurrences, sameSafeYearlyRecurrenceRule, type FutureSeriesSplitPlan } from "./recurrence-split.js";
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
export function assertApprovedHistoryCap(master: CalendarEvent | null, plan: FutureSeriesSplitPlan, taskId: string): void {
  const shared = master?.extendedProperties?.shared;
  if (!master || master.id !== plan.oldMasterId || master.status !== "confirmed" || master.recurrence?.length !== 1
    || !sameSafeYearlyRecurrenceRule(master.recurrence[0], plan.truncatedRule)
    || shared?.syncHistoryOnly !== "true" || shared.syncHistorySuccessorId !== plan.newMasterId
    || shared.syncHistoryTaskId !== taskId || shared.syncHistoryCutoff !== plan.previousOccurrence
    || !sameSafeYearlyRecurrenceRule(shared.syncHistoryOriginalRule, plan.originalRule) || shared.taskId) {
    throw new Error("Old Calendar history cap or approved lineage changed; review the future split before releasing its barriers");
  }
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
  options: {
    now?: Date; expectedRule?: string; expectedDue?: string;
    approvedPlan?: FutureSeriesSplitPlan; approvedEtag?: string;
    consolidation?: {
      retainedTaskId: string;
      discardedTask: TodoistTask;
      previousMapping: Mapping;
      previousLink: RecurrenceLink;
      cancelledEventId: string;
      decisionId: string;
      tombstone?: import("./repository.js").CalendarProjectionTombstone;
    };
  } = {},
): Promise<FutureSplitResult> {
  const now = options.now || new Date();
  const timeZone = await pair.calendar.getTimeZone();
  const archived = old.extendedProperties?.shared?.syncHistoryOnly === "true";
  if (options.approvedPlan?.calendarTimeZone !== undefined
    && options.approvedPlan.calendarTimeZone !== timeZone) {
    throw new Error("Calendar timezone changed after approval");
  }
  if (!archived && options.approvedEtag && options.approvedEtag !== old.etag) {
    throw new Error("Calendar ETag changed after the approved preview");
  }
  const planningDate = archived && options.approvedPlan?.approvedAt
    ? new Date(options.approvedPlan.approvedAt) : now;
  const plan = planFutureSeriesSplit(profile, task, old, planningDate, timeZone, options.consolidation?.discardedTask.id);
  if (options.approvedPlan) {
    for (const field of ["oldMasterId", "newMasterId", "originalRule", "truncatedRule",
      "newRule", "previousOccurrence", "nextOldOccurrence", "newStart",
      "calendarTimeZone", "expiredUntil", "historicalLastOccurrence"] as const) {
      if (plan[field] !== options.approvedPlan[field]) {
        throw new Error(`Approved future-series cutover changed (${field}); new approval required`);
      }
    }
  }
  const originalTaskId = old.extendedProperties?.shared?.syncHistoryTaskId;
  if (task.project_id !== profiles[profile].todoistProjectId
    || task.is_deleted || task.is_completed || task.due?.date !== plan.newStart
    || (options.expectedDue && options.expectedDue !== plan.newStart)
    || (options.expectedRule && options.expectedRule !== plan.originalRule)) {
    throw new Error("Future split approval no longer matches the current task or Calendar schedule");
  }
  if (!archived && old.extendedProperties?.shared?.taskId !== task.id
    && old.extendedProperties?.shared?.taskId !== options.consolidation?.discardedTask.id) {
    throw new Error("Legacy recurring Calendar master is not linked to the approved task");
  }
  if (archived && originalTaskId !== task.id) {
    throw new Error("Previously split Calendar series is not owned by this task");
  }
  const [owner, oldEventMapping, tombstone, completed, history, taskLink, oldLink, tasks, linked, discardedHistory] = await Promise.all([
    state.getMappingByTaskAnyProfile(task.id),
    state.getMappingByEvent(profile, old.id),
    state.getCalendarProjectionTombstone(profile, task.id),
    state.getCompletedCalendarProjectionByEvent(profile, old.id),
    state.listCompletedCalendarProjectionsByTaskAnyProfile(task.id),
    state.getRecurrenceLink(profile, task.id),
    state.getRecurrenceLink(profile, old.iCalUID || old.id),
    pair.todoist.listTasks(),
    options.consolidation ? Promise.resolve(undefined) : pair.calendar.findByTodoistTaskId(task.id),
    options.consolidation
      ? state.listCompletedCalendarProjectionsByTaskAnyProfile(options.consolidation.discardedTask.id)
      : Promise.resolve([]),
  ]);
  if ((tombstone && !options.consolidation)
    || (tombstone && options.consolidation?.tombstone?.sourceUpdatedAt !== tombstone.sourceUpdatedAt)
    || completed || history.length || oldEventMapping
    || (!options.consolidation && oldLink)
    || (options.consolidation && (oldLink?.owner !== "calendar"
      || oldLink.taskId !== options.consolidation.discardedTask.id
      || oldLink.updatedAt !== options.consolidation.previousLink.updatedAt
      || discardedHistory.length))) {
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
  if (tasks.some((other) => other.id !== task.id
    && other.id !== options.consolidation?.discardedTask.id
    && sameTitle(other.content, task.content))) {
    throw new Error("Another Todoist task has the same title; cannot prove unique recurring identity");
  }
  if (options.consolidation) {
    const discarded = options.consolidation.discardedTask;
    const previous = options.consolidation.previousMapping;
    const link = options.consolidation.previousLink;
    if (discarded.id === task.id || discarded.due?.is_recurring
      || discarded.is_deleted || discarded.is_completed
      || !sameTitle(discarded.content, task.content)
      || discarded.due?.date !== previous.activeEffectiveStart
      || previous.taskId !== discarded.id || previous.recurrenceOwner !== "calendar"
      || previous.masterEventId !== old.id || previous.activeInstanceId !== previous.eventId
      || link.taskId !== discarded.id || link.owner !== "calendar"
      || link.masterEventId !== old.id || link.activeInstanceId !== previous.activeInstanceId
      || link.seriesId !== (old.iCalUID || old.id)
      || !tasks.some((candidate) => candidate.id === discarded.id && candidate.is_deleted !== true)) {
      throw new Error("The proposed duplicate is no longer the mapped active one-off occurrence");
    }
  } else if (!archived && (!linked || linked.id !== old.id)) {
    throw new Error("The Calendar task-link search does not uniquely identify the historical master");
  }
  if (archived && linked && linked.id !== plan.newMasterId) {
    throw new Error("Archived master has another live Todoist-linked Calendar identity");
  }

  // Project-comment records are independent ownership evidence even when
  // DynamoDB's EVENT/TASK indexes are missing. Parse before the first write.
  const comments = buildProjectMappingIndex(await pair.todoist.listProjectComments(task.project_id!, true));
  const related = comments.parsed.filter(({ payload }) =>
    payload.taskId === task.id || payload.eventId === old.id
    || payload.masterEventId === old.id || payload.eventId === plan.newMasterId);
  if (comments.malformed.some(({ comment }) =>
    String(comment.content || "").includes(task.id) || String(comment.content || "").includes(old.id))) {
    throw new Error("Malformed project mapping comments reference the split identity");
  }
  const invalidRelated = related.filter(({ payload }) => {
    const source = options.consolidation?.previousMapping;
    const isDiscardedBreadcrumb = Boolean(source && payload.profile === profile
      && payload.taskId === source.taskId && payload.eventId === source.eventId
      && payload.seriesId === source.seriesId && payload.masterEventId === source.masterEventId
      && payload.recurrenceOwner === "calendar");
    return !isDiscardedBreadcrumb && (payload.profile !== profile || payload.taskId !== task.id
      || ![old.id, plan.newMasterId].includes(payload.eventId)
      || payload.recurrenceOwner === "calendar"
      || (payload.masterEventId && ![old.id, plan.newMasterId].includes(payload.masterEventId))
      || (payload.seriesId && payload.seriesId !== task.id)
      || payload.completedThroughOriginalStart || payload.calendarProgressVersion);
  });
  if (related.length > (options.consolidation ? 2 : 1) || invalidRelated.length) {
    throw new Error("Existing project mapping comments conflict with future-series ownership");
  }
  const legacy = await pair.todoist.listTaskComments(task.id);
  if (legacy.some((item) => String(item.content || "").includes("sync:mapping:")
    || String(item.content || "").includes("calendarEventId="))) {
    throw new Error("Legacy task mapping comment requires manual ownership investigation");
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
  const [oldFuture, explicitExceptions] = await Promise.all([
    pair.calendar.listInstancesInWindow(old.id, now.toISOString(), nextWindowEnd),
    pair.calendar.listExplicitSeriesExceptions(old.id),
  ]);
  if (explicitExceptions.length) {
    throw new Error("An explicit Calendar recurrence exception exists; full-series split requires manual review");
  }
  await state.assertHistoricalSeriesUnowned(old.id, [
    ...historical.map((item) => item.id),
    ...oldFuture.map((item) => item.id),
  ], options.consolidation ? {
    mapping: options.consolidation.previousMapping,
    link: options.consolidation.previousLink,
  } : undefined);
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

  // ETags and stored previews must be checked against the live providers
  // immediately BEFORE the first write, not only when the repair was queued.
  const [liveTask, liveOld] = await Promise.all([
    pair.todoist.getTask(task.id), pair.calendar.getEvent(old.id),
  ]);
  if (liveTask.id !== task.id || liveTask.project_id !== task.project_id
    || liveTask.content !== task.content || liveTask.updated_at !== task.updated_at
    || liveTask.due?.date !== task.due?.date || liveTask.due?.string !== task.due?.string
    || liveTask.due?.is_recurring !== true || liveTask.is_deleted || liveTask.is_completed
    || liveOld.etag !== old.etag || liveOld.status !== old.status
    || liveOld.start?.date !== old.start?.date || liveOld.end?.date !== old.end?.date
    || liveOld.recurrence?.length !== 1 || old.recurrence?.length !== 1
    || !sameSafeYearlyRecurrenceRule(liveOld.recurrence[0], old.recurrence[0])
    || JSON.stringify(liveOld.extendedProperties?.shared || {}) !== JSON.stringify(old.extendedProperties?.shared || {})) {
    throw new Error("Todoist task or Calendar RRULE changed after approval; refresh the future-only preview before applying any changes");
  }

  // Persist the split guard BEFORE the first provider write. If the worker
  // crashes after capping the master, manual reconciliation and Todoist
  // webhooks must not create a competing recurrence while this remains pending.
  if (options.consolidation) {
    await state.putConsolidationGuard(
      profile,
      options.consolidation.discardedTask.id,
      task.id,
      options.consolidation.decisionId,
      options.consolidation.cancelledEventId,
      options.consolidation.previousMapping,
    );
  }
  await state.beginFutureSeriesSplit(profile, task.id, old.id, plan.newMasterId, plan.previousOccurrence);
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
  assertApprovedHistoryCap(capped, plan, task.id);
  if (!sameTitle(capped.summary, old.summary)
    || normalizedText(capped.description) !== normalizedText(old.description)
    || capped.status !== "confirmed" || capped.recurrence?.length !== 1
    || !sameSafeYearlyRecurrenceRule(capped.recurrence[0], plan.truncatedRule)
    || capped.extendedProperties?.shared?.syncHistoryOnly !== "true"
    || capped.extendedProperties?.shared?.syncHistorySuccessorId !== plan.newMasterId
    || capped.extendedProperties?.shared?.taskId) {
    throw new Error("Old Calendar history cap was not verified; future master will not be created");
  }
  const [remainingFuture, postCapExceptions] = await Promise.all([
    pair.calendar.listInstancesInWindow(old.id, now.toISOString(), nextWindowEnd),
    pair.calendar.listExplicitSeriesExceptions(old.id),
  ]);
  if (postCapExceptions.length) throw new Error("Historical Calendar series gained a recurrence exception during the cap");
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
    options.consolidation ? Promise.resolve(undefined) : pair.calendar.findByTodoistTaskId(task.id),
    pair.calendar.listInstancesInWindow(
      future.id, addDays(plan.newStart, -1) + "T00:00:00Z",
      addDays(plan.newStart, 2) + "T00:00:00Z",
    ),
  ]);
  if (!currentTask.due?.is_recurring || currentTask.due.date !== task.due?.date
    || currentTask.due.string !== task.due?.string
    || currentTask.content !== task.content || currentTask.updated_at !== task.updated_at
    || (!options.consolidation && linkedNow?.id !== future.id)) {
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
    if (options.consolidation) await finalizeConsolidation(options.consolidation, pair, state);
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
    existingComment?.id, draft, old.id,
  );
  const reference = existingComment?.id ? { ...draft, commentId: existingComment.id } : draft;
  const mapping = attachProjectCommentReference(reference, task.project_id!, comment.id);
  const link: RecurrenceLink = {
    profile, owner: "todoist", seriesId: task.id, masterEventId: future.id,
    activeInstanceId: active.id, originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart, taskId: task.id,
    eventId: future.id, updatedAt: mapping.updatedAt,
  };
  const committed = options.consolidation
    ? await state.commitRecurrenceConsolidation({
      mapping, link,
      previousMapping: options.consolidation.previousMapping,
      previousLink: options.consolidation.previousLink,
      discardedTaskId: options.consolidation.discardedTask.id,
      decisionId: options.consolidation.decisionId,
      expectedTombstone: options.consolidation.tombstone,
      cancelledEventId: options.consolidation.cancelledEventId,
    })
    : await state.putNewRecurrenceMappingIfUnowned(mapping, link);
  if (!committed) throw new Error("A concurrent mapping or tombstone claimed the task before commit");
  if (options.consolidation) await finalizeConsolidation(options.consolidation, pair, state);
  await state.completeFutureSeriesSplit(profile, task.id, future.id);
  await state.audit(profile, "manual_future_series_split_applied", {
    taskId: task.id, oldMasterId: old.id, newMasterId: future.id,
    priorOccurrence: plan.previousOccurrence, newStart: plan.newStart,
    priorRule: plan.originalRule, newRule: plan.newRule,
  });
  return { mapping, plan, resumed: archived };
}

async function finalizeConsolidation(
  consolidation: NonNullable<NonNullable<Parameters<typeof applyApprovedFutureSeriesSplit>[5]>["consolidation"]>,
  pair: ProviderClients,
  state: StateRepository,
): Promise<void> {
  if (consolidation.previousMapping.projectCommentId || consolidation.previousMapping.commentId
    || consolidation.previousMapping.taskCommentId) {
    await deleteMappingComments(pair.todoist, consolidation.previousMapping);
  }
  const cancelledComment = await pair.todoist.findComment(consolidation.retainedTaskId, consolidation.cancelledEventId);
  if (cancelledComment) {
    const record = await pair.todoist.getComment(cancelledComment.id).catch(() => undefined);
    await deleteMappingComments(pair.todoist, {
      profile: consolidation.previousMapping.profile,
      taskId: consolidation.retainedTaskId,
      eventId: consolidation.cancelledEventId,
      updatedAt: new Date().toISOString(),
      ...(record?.project_id ? { projectCommentId: cancelledComment.id } : { taskCommentId: cancelledComment.id }),
    });
  }
  await pair.calendar.deleteEvent(consolidation.cancelledEventId).catch((error: unknown) => {
    if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
  });
  await pair.todoist.deleteTask(consolidation.discardedTask.id).catch((error: unknown) => {
    if (Number((error as { status?: number }).status) !== 404) throw error;
  });
  await state.recordMutation(consolidation.previousMapping.profile);
}
