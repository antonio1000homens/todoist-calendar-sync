import { profiles } from "./config.js";
import { buildProjectMappingIndex, attachProjectCommentReference } from "./mapping-comments.js";
import { calendarLocalDay } from "./recurrence-split.js";
import { planPhaseBNativeFutureOnlyMove, type PhaseBNativeMovePlan } from "./todoist-phase-b-native-move.js";
import { phaseBNativeMoveStage } from "./todoist-phase-b-move-handoff.js";
import { todoistRecurrenceKey } from "./todoist-recurrence.js";
import type { ProviderClients } from "./mutation-budget.js";
import type { StateRepository } from "./repository.js";
import type { CalendarEvent, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";

/**
 * #389: guarded Phase B cross-profile provider-side cutover.
 *
 * This executor is NOT wired into the worker and DOES NOT enable the default-
 * off Phase B flag. It exists for isolated fault-injection tests before the
 * runtime routing and independent live-provider acceptance are reviewed.
 *
 * A crash after the durable stage deliberately stays BLOCKED; this code never
 * automatically releases a fence, guesses the next operation, rewinds a source
 * Calendar master, or deletes an existing event. A separately reviewed,
 * exact-stage recovery is required before replay.
 */
export type PhaseBNativeMoveState = Pick<StateRepository,
  "getMappingByTaskAnyProfile" | "getRecurrenceLink"
  | "getCalendarProjectionTombstone" | "syncBlocked" | "mutationAllowed"
  | "getPhaseBNativeMoveStage" | "beginPhaseBNativeMove"
  | "commitPhaseBNativeMoveIfUnchanged" | "recordMutation" | "audit">;

export interface PhaseBNativeMoveExecution {
  task: TodoistTask;
  sourceProfile: Profile;
  destinationProfile: Profile;
  sourceMapping: Mapping;
  sourceLink: RecurrenceLink;
  source: ProviderClients;
  destination: ProviderClients;
  state: PhaseBNativeMoveState;
  now?: Date;
}
export interface PhaseBNativeMoveResult {
  plan: PhaseBNativeMovePlan;
  mapping: Mapping;
  operationId: string;
}

function plusDays(value: string, days: number): string {
  const epoch = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(epoch)) throw new Error("Invalid all-day Phase B move date");
  const date = new Date(epoch + 86400000 * days);
  return date.toISOString().slice(0, 10);
}
function sameTask(left: TodoistTask, right: TodoistTask): boolean {
  return JSON.stringify([
    left.id, left.project_id, left.content, left.description || "",
    left.updated_at, left.is_completed || false, left.is_deleted || false,
    left.due?.date, left.due?.datetime, left.due?.string,
    left.due?.timezone, left.due?.is_recurring,
  ]) === JSON.stringify([
    right.id, right.project_id, right.content, right.description || "",
    right.updated_at, right.is_completed || false, right.is_deleted || false,
    right.due?.date, right.due?.datetime, right.due?.string,
    right.due?.timezone, right.due?.is_recurring,
  ]);
}
function equivalentMapping(before: Mapping, after: Mapping | undefined): boolean {
  return Boolean(after && before.profile === after.profile
    && before.taskId === after.taskId && before.eventId === after.eventId
    && before.masterEventId === after.masterEventId
    && before.updatedAt === after.updatedAt
    && before.todoistPhaseBVersion === after.todoistPhaseBVersion);
}
function instancesAreExact(
  instances: CalendarEvent[], masterId: string, expected: string[],
  title: string, description: string,
): boolean {
  const sorted = [...instances].sort((a, b) =>
    (a.originalStartTime?.date || "").localeCompare(b.originalStartTime?.date || ""));
  return sorted.length === expected.length && sorted.every((instance, i) => (
    Boolean(instance.id && instance.recurringEventId === masterId
      && instance.originalStartTime?.date === expected[i]
      && instance.start?.date === expected[i]
      && instance.end?.date === plusDays(expected[i], 1)
      && instance.status === "confirmed"
      && !instance.start?.dateTime && !instance.end?.dateTime
      && !instance.recurrence?.length
      && instance.summary === title && (instance.description || "") === description)
  ));
}
function newNativeMaster(task: TodoistTask, plan: PhaseBNativeMovePlan, zone: string): CalendarEvent {
  const key = todoistRecurrenceKey(task);
  if (!key) throw new Error("Todoist recurring rule disappeared after preflight");
  return {
    id: plan.successorMasterId, summary: task.content, description: task.description || "",
    start: { date: plan.destinationStart },
    end: { date: plusDays(plan.destinationStart, 1) },
    recurrence: [plan.destinationRule],
    extendedProperties: { shared: {
      syncSource: "todoist-calendar-sync",
      taskId: task.id,
      syncRecurrenceOwner: "todoist",
      todoistRecurrence: key,
      todoistAnchorStart: plan.destinationStart,
      todoistAnchorEnd: plusDays(plan.destinationStart, 1),
      todoistAnchorAllDay: "true",
      todoistAnchorTimeZone: zone,
      todoistPhaseBVersion: "1",
      syncHistoryMasterId: plan.sourceMasterId,
      syncHistoryCutoff: plan.historicalLastOccurrence,
      syncSplitVersion: "phase-b-native-move-v1",
    } },
  };
}
function historyOnlySource(master: CalendarEvent, plan: PhaseBNativeMovePlan): CalendarEvent {
  const shared = { ...(master.extendedProperties?.shared || {}) };
  for (const field of ["taskId", "syncRecurrenceOwner", "todoistPhaseBVersion",
    "todoistRecurrence", "todoistAnchorStart", "todoistAnchorEnd",
    "todoistAnchorAllDay", "todoistAnchorTimeZone"]) delete shared[field];
  Object.assign(shared, {
    syncHistoryOnly: "true", syncHistoryTaskId: plan.historyTaskId,
    syncHistoryOriginalRule: plan.sourceRule,
    syncHistorySuccessorId: plan.successorMasterId,
    syncHistoryCutoff: plan.historicalLastOccurrence,
  });
  return { ...master, recurrence: [plan.historyRule],
    extendedProperties: { ...master.extendedProperties, shared } };
}
function verifyDestinationMaster(master: CalendarEvent, intended: CalendarEvent): void {
  const shared = master.extendedProperties?.shared;
  const target = intended.extendedProperties!.shared!;
  if (!master.etag || master.status !== "confirmed"
    || master.id !== intended.id || master.recurringEventId
    || master.start?.date !== intended.start?.date
    || master.end?.date !== intended.end?.date
    || master.start?.dateTime || master.end?.dateTime
    || JSON.stringify(master.recurrence) !== JSON.stringify(intended.recurrence)
    || master.summary !== intended.summary
    || (master.description || "") !== intended.description
    || Object.keys(target).some(field => shared?.[field] !== target[field]))
    throw new Error("Destination Calendar master readback does not prove exact Phase B migration lineage");
}
function verifyHistoryMaster(master: CalendarEvent, original: CalendarEvent, plan: PhaseBNativeMovePlan): void {
  const s = master.extendedProperties?.shared;
  if (!master.etag || master.status !== "confirmed"
    || master.id !== plan.sourceMasterId
    || master.start?.date !== original.start?.date
    || master.end?.date !== original.end?.date
    || master.summary !== original.summary
    || (master.description || "") !== (original.description || "")
    || master.recurrence?.length !== 1 || master.recurrence[0] !== plan.historyRule
    || s?.syncHistoryOnly !== "true" || s.syncHistoryTaskId !== plan.taskId
    || s.syncHistoryOriginalRule !== plan.sourceRule
    || s.syncHistorySuccessorId !== plan.successorMasterId
    || s.syncHistoryCutoff !== plan.historicalLastOccurrence
    || s.taskId || s.syncRecurrenceOwner || s.todoistPhaseBVersion)
    throw new Error("Source Calendar history cap readback is incomplete or changed");
}

/** Read-only provider verification, before creating any durable stage. */
export async function inspectPhaseBNativeMove(input: PhaseBNativeMoveExecution): Promise<{
  plan: PhaseBNativeMovePlan; master: CalendarEvent; task: TodoistTask;
  historicalInstances: CalendarEvent[];
}> {
  const { task, sourceProfile, destinationProfile, sourceMapping, sourceLink,
    source, destination, state } = input;
  if (process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED !== "true")
    throw new Error("Phase B native writer remains disabled");
  if (sourceProfile === destinationProfile
    || !sourceMapping.projectCommentId
    || sourceMapping.projectId !== profiles[sourceProfile].todoistProjectId
    || task.project_id !== profiles[destinationProfile].todoistProjectId)
    throw new Error("Native move requires exact mapped source and managed destination projects");
  if (await state.getPhaseBNativeMoveStage(task.id))
    throw new Error("A Phase B native move stage exists; manual exact-stage recovery required");
  const [blockedFrom, blockedTo, fromAllowed, toAllowed, currentMapping, currentLink, tombstone] = await Promise.all([
    state.syncBlocked(sourceProfile, {taskId:task.id, eventId:sourceMapping.masterEventId}),
    state.syncBlocked(destinationProfile, {taskId:task.id}),
    state.mutationAllowed(sourceProfile), state.mutationAllowed(destinationProfile),
    state.getMappingByTaskAnyProfile(task.id),
    state.getRecurrenceLink(sourceProfile, task.id),
    state.getCalendarProjectionTombstone(destinationProfile, task.id),
  ]);
  if (blockedFrom || blockedTo || !fromAllowed || !toAllowed || tombstone
    || !equivalentMapping(sourceMapping, currentMapping)
    || !currentLink || currentLink.updatedAt !== sourceLink.updatedAt
    || currentLink.masterEventId !== sourceLink.masterEventId)
    throw new Error("Phase B move state ownership, suppression, or repair evidence changed");
  const [liveTask, master, sourceZone, destinationZone, todoistZone,
    destinationAlias, existingDestinationMapping, sourceComments, destinationComments] = await Promise.all([
      destination.todoist.getTask(task.id),
      source.calendar.getEvent(sourceMapping.masterEventId!),
      source.calendar.getTimeZone(), destination.calendar.getTimeZone(),
      destination.todoist.getTimeZone(),
      destination.calendar.findByTodoistTaskId(task.id),
      state.getCalendarProjectionTombstone(sourceProfile, task.id),
      source.todoist.listProjectComments(profiles[sourceProfile].todoistProjectId, true),
      destination.todoist.listProjectComments(profiles[destinationProfile].todoistProjectId, true),
    ]);
  if (!sameTask(task, liveTask))
    throw new Error("Todoist source changed since project move delivery");
  const sourceIndex=buildProjectMappingIndex(sourceComments);
  const matchingSource=(sourceIndex.byTaskId.get(task.id)||[]).filter(x=>
    x.payload.eventId === sourceMapping.eventId
    && x.payload.profile===sourceProfile
    && x.comment.id===sourceMapping.projectCommentId);
  const destinationIndex=buildProjectMappingIndex(destinationComments);
  if (matchingSource.length!==1
    || (sourceIndex.byTaskId.get(task.id)||[]).length!==1
    || (destinationIndex.byTaskId.get(task.id)||[]).length
    || destinationAlias || existingDestinationMapping)
    throw new Error("Phase B native move source or destination project breadcrumb conflicts");
  const historicalInstances = await source.calendar.listInstancesInWindow(
    master.id, `${master.start?.date}T00:00:00Z`, `${task.due?.date}T00:00:00Z`,
  );
  const exceptions = await source.calendar.listExplicitSeriesExceptions(master.id);
  const decision=planPhaseBNativeFutureOnlyMove({
    task:liveTask, mapping:sourceMapping, sourceMaster:master,
    sourceProfile,destinationProfile,
    destinationProjectId:profiles[destinationProfile].todoistProjectId,
    sourceTimeZone:sourceZone,destinationTimeZone:destinationZone,
    todoistTimeZone:todoistZone,
    today:calendarLocalDay(input.now || new Date(),sourceZone),
    historicalInstances, historyInventoryComplete:true,
    explicitExceptions:exceptions,exceptionInventoryComplete:true,
    destinationHasLinkedEvent:Boolean(destinationAlias),
    destinationHasMapping:false,destinationHasTombstone:Boolean(tombstone),
    activeRepairOrErasure:Boolean(blockedFrom || blockedTo),
  });
  if (!decision.accepted) throw new Error(`Phase B move denied: ${decision.reason}`);
  return {plan:decision.plan,master,task:liveTask,historicalInstances};
}

/**
 * Side effects must be serial: durable two-profile locks, destination create
 * and independent readback, source ETag cap, independent history readback,
 * project-comment handoff, and finally atomic DynamoDB ownership transfer.
 *
 * Any failure after the stage is claimed leaves the stage and BOTH profile
 * controls active. There is no automatic rollback of a successful source cap.
 * This function refuses to resume; recovery is a separately approved flow.
 */
export async function executePhaseBNativeMove(input: PhaseBNativeMoveExecution): Promise<PhaseBNativeMoveResult> {
  const observed=await inspectPhaseBNativeMove(input);
  const {plan, master, historicalInstances}=observed;
  const {sourceProfile, destinationProfile, sourceMapping, sourceLink,
    state, source, destination, task}=input;
  const stage=phaseBNativeMoveStage({plan,sourceMapping,sourceLink});
  const result=await state.beginPhaseBNativeMove({plan,sourceMapping,sourceLink});
  if (result!=="claimed")
    throw new Error("Native move stage is already owned; operator-reviewed recovery required");
  try {
    // Recheck provider identity after the durable fence is established.
    const [prior, current] = await Promise.all([
      source.calendar.getEvent(master.id),destination.todoist.getTask(task.id),
    ]);
    if (prior.etag !== master.etag || !sameTask(current, observed.task))
      throw new Error("Phase B source changed after durable stage admission");
    const wanted = newNativeMaster(current,plan,await destination.calendar.getTimeZone());
    await destination.calendar.createTodoistPhaseBNativeMasterOnce(wanted);
    await state.recordMutation(destinationProfile);
    const [destinationReadback, destinationInstances, destinationExceptions] = await Promise.all([
      destination.calendar.getEvent(plan.successorMasterId),
      destination.calendar.listInstancesInWindow(plan.successorMasterId,
        `${plan.destinationStart}T00:00:00Z`,`${plusDays(plan.destinationStart,400)}T00:00:00Z`),
      destination.calendar.listExplicitSeriesExceptions(plan.successorMasterId),
    ]);
    verifyDestinationMaster(destinationReadback,wanted);
    if (destinationExceptions.length
      || destinationInstances.length < 3
      || !instancesAreExact(destinationInstances.slice(0,3),plan.successorMasterId,
        plan.firstThreeDestinationOccurrences,current.content,current.description||""))
      throw new Error("Destination provider did not prove the next three exact native occurrences");
    if (!sameTask(await destination.todoist.getTask(task.id),observed.task))
      throw new Error("Todoist recurrence changed before capping source history");

    await source.calendar.upsertEventIfUnchanged(historyOnlySource(prior,plan),plan.sourceMasterId,plan.sourceEtag);
    await state.recordMutation(sourceProfile);
    const [retained,retainedInstances,sourceExceptions,upcoming] = await Promise.all([
      source.calendar.getEvent(master.id),
      source.calendar.listInstancesInWindow(master.id,
        `${master.start!.date}T00:00:00Z`,`${plan.destinationStart}T00:00:00Z`),
      source.calendar.listExplicitSeriesExceptions(master.id),
      source.calendar.listInstancesInWindow(master.id,
        `${plan.destinationStart}T00:00:00Z`,`${plusDays(plan.destinationStart,400)}T00:00:00Z`),
    ]);
    verifyHistoryMaster(retained,master,plan);
    if (sourceExceptions.length || upcoming.length
      || !instancesAreExact(retainedInstances,master.id,
        historicalInstances.map(x=>x.originalStartTime?.date||""),
        master.summary||"",master.description||""))
      throw new Error("Source provider did not preserve exact elapsed history or remove future projections");
    verifyDestinationMaster(await destination.calendar.getEvent(plan.successorMasterId),wanted);
    if (!sameTask(await destination.todoist.getTask(task.id),observed.task))
      throw new Error("Todoist changed before mapping handoff");

    const timestamp=new Date().toISOString();
    const draft:Mapping={
      ...sourceMapping,profile:destinationProfile,taskId:task.id,
      projectId:profiles[destinationProfile].todoistProjectId,
      eventId:plan.successorMasterId,masterEventId:plan.successorMasterId,
      seriesId:task.id,activeInstanceId:destinationInstances[0].id,
      originalStart:plan.destinationStart,activeEffectiveStart:plan.destinationStart,
      todoistPhaseBVersion:1,updatedAt:timestamp,
    };
    const newComment=await destination.todoist.upsertComment(task.id,
      `todoist-calendar-sync\ncalendarEventId=${plan.successorMasterId}\ncalendarUrl=${destinationReadback.htmlLink||""}`,
      undefined,draft);
    await state.recordMutation(destinationProfile);
    const projectId=profiles[destinationProfile].todoistProjectId;
    const indexed=buildProjectMappingIndex(await destination.todoist.listProjectComments(projectId,true));
    const entries=indexed.byTaskId.get(task.id)||[];
    if (entries.length!==1 || entries[0].comment.id!==newComment.id
      || entries[0].payload.eventId!==plan.successorMasterId
      || entries[0].payload.profile!==destinationProfile)
      throw new Error("New destination Todoist project mapping comment did not verify");
    const updated=attachProjectCommentReference(draft,projectId,newComment.id);
    const link:RecurrenceLink={
      ...sourceLink,profile:destinationProfile,taskId:task.id,
      eventId:plan.successorMasterId,masterEventId:plan.successorMasterId,
      seriesId:task.id,activeInstanceId:destinationInstances[0].id,
      originalStart:plan.destinationStart,activeEffectiveStart:plan.destinationStart,
      updatedAt:timestamp,
    };
    await source.todoist.deleteComment(sourceMapping.projectCommentId!);
    await state.recordMutation(sourceProfile);
    const oldIndex=buildProjectMappingIndex(await source.todoist.listProjectComments(
      profiles[sourceProfile].todoistProjectId,true));
    if ((oldIndex.byTaskId.get(task.id)||[]).length)
      throw new Error("Source Todoist project still advertises the old Calendar ownership");
    const committed=await state.commitPhaseBNativeMoveIfUnchanged({
      plan,sourceMapping,sourceLink,destinationMapping:updated,destinationLink:link,
    });
    if (!committed) throw new Error("Phase B mapping owner CAS failed after provider cutover");
    await state.audit(destinationProfile,"todoist_phase_b_native_future_only_move_succeeded",{
      taskId:task.id,sourceProfile,destinationProfile,oldMasterId:master.id,
      successorMasterId:plan.successorMasterId,historyCutoff:plan.historicalLastOccurrence,
      operationId:stage.operationId,
    });
    return {plan,mapping:updated,operationId:stage.operationId};
  }catch(error){
    await state.audit(sourceProfile,"todoist_phase_b_native_move_quarantined",{
      taskId:task.id,sourceProfile,destinationProfile,
      sourceMasterId:master.id,successorMasterId:plan.successorMasterId,
      operationId:stage.operationId,reason:error instanceof Error?error.message:String(error),
    });
    throw error;
  }
}
