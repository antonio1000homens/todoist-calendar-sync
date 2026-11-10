import { profiles } from "./config.js";
import { buildProjectMappingIndex, attachProjectCommentReference } from "./mapping-comments.js";
import { classifyCalendarRule, occurrenceDates } from "./recurrence-semantics.js";
import { phaseBNativeMoveStage, type PhaseBNativeMoveStage } from "./todoist-phase-b-move-handoff.js";
import {
  acquireCrossProfileWriterLeases, instancesAreExact, newNativeMaster,
  plusDays, sameTask, verifyDestinationMaster, verifyHistoryMaster,
} from "./todoist-phase-b-native-move-executor.js";
import type { PhaseBNativeMovePlan } from "./todoist-phase-b-native-move.js";
import type { ProviderClients } from "./mutation-budget.js";
import type { StateRepository } from "./repository.js";
import type { CalendarEvent, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";

/**
 * An interrupted native Calendar split has FOUR durable per-identity fences.
 * Repeated webhooks must remain blocked, even after a lost commit response.
 *
 * The inspector is strictly read-only, including when the Phase B creation
 * switch is disabled. The opt-in finalizer ONLY commits a split whose source
 * history, destination master, occurrences, project comments, stage and all
 * controls already prove an entirely completed provider cutover. It never
 * creates/updates/deletes either provider's events or comments, never releases
 * a partial stage, and never acts on the Work erasure fence.
 *
 * Other partial stages require a separate reviewed provider-recovery plan.
 */
export type PhaseBNativeRecoveryState = Pick<StateRepository,
  "getPhaseBNativeMoveStage" | "phaseBNativeMoveControlsMatch"
  | "getMappingByTaskAnyProfile" | "getRecurrenceLink"
  | "getCalendarProjectionTombstone" | "mutationAllowed"
  | "commitPhaseBNativeMoveIfUnchanged" | "audit">;

export interface PhaseBNativeRecoveryRequest {
  taskId: string;
  expectedOperationId: string;
  sourceProfile: Profile;
  destinationProfile: Profile;
  state: PhaseBNativeRecoveryState;
  source: ProviderClients;
  destination: ProviderClients;
  /** Used only by isolated tests; production must acquire real erasure leases. */
  acquireWriterLeases?: (from: Profile, to: Profile) => Promise<() => Promise<void>>;
}
export interface PhaseBNativeRecoveryReady {
  status: "ready_to_commit";
  stage: PhaseBNativeMoveStage;
  plan: PhaseBNativeMovePlan;
  sourceMapping: Mapping;
  sourceLink: RecurrenceLink;
  destinationMapping: Mapping;
  destinationLink: RecurrenceLink;
  sourceEtag: string;
  destinationEtag: string;
  task: TodoistTask;
}
export type PhaseBNativeRecoveryInspection =
  | PhaseBNativeRecoveryReady
  | { status: "quarantined"; operationId: string; reason: string };

function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function equalStage(before: PhaseBNativeMoveStage, after: PhaseBNativeMoveStage | undefined): boolean {
  return Boolean(after && Object.entries(before).every(([field, value]) =>
    (after as unknown as Record<string, unknown>)[field] === value));
}
function stageMatchedMapping(stage: PhaseBNativeMoveStage, m: Mapping, l: RecurrenceLink): boolean {
  return m.profile === stage.sourceProfile && m.projectId === profiles[stage.sourceProfile].todoistProjectId
    && m.taskId === stage.taskId && m.eventId === stage.sourceMasterId
    && m.masterEventId === stage.sourceMasterId
    && m.recurrenceOwner === "todoist" && m.todoistPhaseBVersion === 1
    && m.seriesId === stage.taskId && m.updatedAt === stage.sourceMappingUpdatedAt
    && Boolean(m.activeInstanceId && m.projectCommentId)
    && m.originalStart === stage.destinationStart && m.activeEffectiveStart === stage.destinationStart
    && l.profile === stage.sourceProfile && l.owner === "todoist"
    && l.taskId === stage.taskId && l.eventId === m.eventId
    && l.masterEventId === m.masterEventId && l.seriesId === stage.taskId
    && l.activeInstanceId === m.activeInstanceId
    && l.originalStart === stage.destinationStart && l.activeEffectiveStart === stage.destinationStart
    && l.updatedAt === stage.sourceLinkUpdatedAt;
}
function exactHistoryLineage(master: CalendarEvent, stage: PhaseBNativeMoveStage): boolean {
  const s=master.extendedProperties?.shared;
  return Boolean(master.id===stage.sourceMasterId
    && master.status==="confirmed" && master.etag && master.etag!==stage.sourceEtag
    && !master.recurringEventId && master.start?.date && !master.start?.dateTime
    && master.end?.date===plusDays(master.start.date,1) && !master.end?.dateTime
    && master.recurrence?.length===1 && master.recurrence[0]===stage.historyRule
    && s?.syncHistoryOnly==="true" && s.syncHistoryTaskId===stage.taskId
    && s.syncHistoryOriginalRule===stage.sourceRule
    && s.syncHistorySuccessorId===stage.successorMasterId
    && s.syncHistoryCutoff===stage.historicalLastOccurrence
    && !s.taskId && !s.syncRecurrenceOwner && !s.todoistPhaseBVersion
    && !s.todoistRecurrence && !s.todoistAnchorStart
    && !s.todoistAnchorEnd && !s.todoistAnchorAllDay && !s.todoistAnchorTimeZone);
}

/** No fences, Calendar masters, Todoist comments or mappings are mutated. */
export async function inspectInterruptedPhaseBNativeMove(
  input: PhaseBNativeRecoveryRequest,
): Promise<PhaseBNativeRecoveryInspection> {
  const {taskId, expectedOperationId, sourceProfile, destinationProfile,
    source, destination, state}=input;
  try {
    requireEvidence(taskId && expectedOperationId && sourceProfile!==destinationProfile,
      "exact_task_operation_and_distinct_profiles_required");
    const stage=await state.getPhaseBNativeMoveStage(taskId);
    requireEvidence(stage && stage.taskId===taskId
      && stage.operationId===expectedOperationId
      && stage.sourceProfile===sourceProfile && stage.destinationProfile===destinationProfile,
      "missing_or_mismatched_immutable_stage");
    requireEvidence(await state.phaseBNativeMoveControlsMatch(stage),
      "stage_controls_incomplete_or_owned_by_another_operation");
    const [allowedFrom,allowedTo,mapping,link,existingDestinationLink,sourceTombstone,destinationTombstone]=await Promise.all([
      state.mutationAllowed(sourceProfile),state.mutationAllowed(destinationProfile),
      state.getMappingByTaskAnyProfile(taskId),state.getRecurrenceLink(sourceProfile,taskId),
      state.getRecurrenceLink(destinationProfile,taskId),
      state.getCalendarProjectionTombstone(sourceProfile,taskId),
      state.getCalendarProjectionTombstone(destinationProfile,taskId),
    ]);
    requireEvidence(allowedFrom && allowedTo && !sourceTombstone && !destinationTombstone,
      "erasure_or_tombstone_prevents_stage_recovery");
    requireEvidence(mapping && link && !existingDestinationLink && stageMatchedMapping(stage,mapping,link),
      "source_mapping_or_recurrence_link_version_drift");
    const [task,sourceMaster,destinationMaster,sourceZone,destinationZone,todoistZone,
      sourceComments,destinationComments]=await Promise.all([
        destination.todoist.getTask(taskId),
        source.calendar.getEvent(stage.sourceMasterId),
        destination.calendar.getEvent(stage.successorMasterId),
        source.calendar.getTimeZone(),destination.calendar.getTimeZone(),
        destination.todoist.getTimeZone(),
        source.todoist.listProjectComments(profiles[sourceProfile].todoistProjectId,true),
        destination.todoist.listProjectComments(profiles[destinationProfile].todoistProjectId,true),
      ]);
    requireEvidence(task?.id===taskId && task.project_id===profiles[destinationProfile].todoistProjectId
      && !task.is_deleted && !task.is_completed && !task.completed_at
      && task.due?.date===stage.destinationStart && !task.due.datetime && task.due.is_recurring,
      "todoist_current_due_or_destination_project_changed");
    requireEvidence(sourceZone && sourceZone===destinationZone && sourceZone===todoistZone,
      "unverified_cross_provider_timezones");
    requireEvidence(sourceMaster && exactHistoryLineage(sourceMaster,stage),
      "source_master_not_verified_as_exact_history_only_cap");
    requireEvidence(sourceMaster.summary===task.content
      && (sourceMaster.description||"")===(task.description||""),
      "task_metadata_changed_after_stage");
    const sourceRule=classifyCalendarRule(stage.sourceRule,{
      start:sourceMaster.start!.date!,timeZone:sourceZone,
    });
    requireEvidence(sourceRule.semantic && sourceRule.canonicalRrule===stage.sourceRule
      && stage.destinationRule===stage.sourceRule
      && stage.historyRule===stage.sourceRule+";UNTIL="+stage.historicalLastOccurrence.replace(/-/g,""),
      "original_rrule_or_cap_mismatch");
    const dates=occurrenceDates(sourceRule.semantic,100);
    const cutover=dates.indexOf(stage.destinationStart);
    requireEvidence(cutover>0 && cutover<dates.length-3
      && dates[cutover-1]===stage.historicalLastOccurrence,
      "historical_cutoff_or_future_progression_unverified");
    const targetRule=classifyCalendarRule(stage.destinationRule,{
      start:stage.destinationStart,timeZone:destinationZone,
    });
    const next=targetRule.semantic?occurrenceDates(targetRule.semantic,3):[];
    requireEvidence(next.length===3 && next.every((day,i)=>day===dates[cutover+i]),
      "destination_reanchor_progression_mismatch");
    const plan: PhaseBNativeMovePlan={
      taskId,sourceProfile,destinationProfile,sourceMasterId:stage.sourceMasterId,
      sourceEtag:stage.sourceEtag,successorMasterId:stage.successorMasterId,
      originalAnchor:sourceMaster.start!.date!,sourceRule:stage.sourceRule,
      historyRule:stage.historyRule,historicalLastOccurrence:stage.historicalLastOccurrence,
      destinationStart:stage.destinationStart,destinationRule:stage.destinationRule,
      firstThreeDestinationOccurrences:next as [string,string,string],historyTaskId:taskId,
    };
    requireEvidence(equalStage(stage,phaseBNativeMoveStage({plan,sourceMapping:mapping,sourceLink:link})),
      "stage_operation_fingerprint_differs_from_verified_handoff");
    verifyHistoryMaster(sourceMaster,sourceMaster,plan);
    const intended=newNativeMaster(task,plan,destinationZone);
    verifyDestinationMaster(destinationMaster,intended);
    const [sourceHistory,sourceFuture,sourceExceptions,destinationInstances,destinationExceptions]=await Promise.all([
      source.calendar.listInstancesInWindow(stage.sourceMasterId,
        `${sourceMaster.start!.date}T00:00:00Z`,`${stage.destinationStart}T00:00:00Z`),
      source.calendar.listInstancesInWindow(stage.sourceMasterId,
        `${stage.destinationStart}T00:00:00Z`,`${plusDays(stage.destinationStart,400)}T00:00:00Z`),
      source.calendar.listExplicitSeriesExceptions(stage.sourceMasterId),
      destination.calendar.listInstancesInWindow(stage.successorMasterId,
        `${stage.destinationStart}T00:00:00Z`,`${plusDays(stage.destinationStart,400)}T00:00:00Z`),
      destination.calendar.listExplicitSeriesExceptions(stage.successorMasterId),
    ]);
    requireEvidence(!sourceExceptions.length && !sourceFuture.length && !destinationExceptions.length
      && instancesAreExact(sourceHistory,stage.sourceMasterId,dates.slice(0,cutover),
        task.content,task.description||""),
      "source_history_inventory_not_exact_or_has_future_instances");
    const ordered=[...destinationInstances].sort((a,b)=>
      (a.originalStartTime?.date||"").localeCompare(b.originalStartTime?.date||""));
    requireEvidence(ordered.length>=3
      && instancesAreExact(ordered.slice(0,3),stage.successorMasterId,next,
        task.content,task.description||""),
      "destination_three_instance_or_exception_inventory_invalid");
    const active=ordered.find(e=>e.originalStartTime?.date===stage.destinationStart);
    requireEvidence(active?.id,"destination_active_instance_missing");
    const srcIndex=buildProjectMappingIndex(sourceComments);
    const dstIndex=buildProjectMappingIndex(destinationComments);
    const src=srcIndex.byTaskId.get(taskId)||[];
    const dst=dstIndex.byTaskId.get(taskId)||[];
    requireEvidence(!src.length && dst.length===1
      && !srcIndex.malformed.some(e=>String(e.comment.content||"").includes(taskId))
      && !dstIndex.malformed.some(e=>String(e.comment.content||"").includes(taskId))
      && dst[0].payload.profile===destinationProfile
      && dst[0].payload.eventId===stage.successorMasterId
      && dst[0].comment.id!==mapping.projectCommentId,
      "project_breadcrumb_handoff_not_complete_or_ambiguous");
    const timestamp=new Date().toISOString();
    const draft:Mapping={
      ...mapping,profile:destinationProfile,projectId:profiles[destinationProfile].todoistProjectId,
      eventId:stage.successorMasterId,masterEventId:stage.successorMasterId,
      seriesId:taskId,activeInstanceId:active.id,
      originalStart:stage.destinationStart,activeEffectiveStart:stage.destinationStart,
      todoistPhaseBVersion:1,updatedAt:timestamp,
    };
    const destinationMapping=attachProjectCommentReference(draft,
      profiles[destinationProfile].todoistProjectId,dst[0].comment.id);
    const destinationLink:RecurrenceLink={
      ...link,profile:destinationProfile,eventId:stage.successorMasterId,
      masterEventId:stage.successorMasterId,seriesId:taskId,activeInstanceId:active.id,
      originalStart:stage.destinationStart,activeEffectiveStart:stage.destinationStart,
      updatedAt:timestamp,
    };
    requireEvidence(equalStage(stage,await state.getPhaseBNativeMoveStage(taskId))
      && await state.phaseBNativeMoveControlsMatch(stage)
      && sameTask(task,await destination.todoist.getTask(taskId))
      && sourceMaster.etag===(await source.calendar.getEvent(stage.sourceMasterId)).etag
      && destinationMaster.etag===(await destination.calendar.getEvent(stage.successorMasterId)).etag,
      "stage_or_provider_changed_during_read_only_verification");
    return {status:"ready_to_commit",stage,plan,sourceMapping:mapping,sourceLink:link,
      destinationMapping,destinationLink,sourceEtag:sourceMaster.etag!,
      destinationEtag:destinationMaster.etag!,task};
  } catch(error) {
    return {status:"quarantined",operationId:expectedOperationId,
      reason:error instanceof Error?error.message:String(error)};
  }
}

/** Explicit operator-only CAS repair of a FULLY finished provider move.
 * Not wired to webhooks, reconciliation, reviews or unattended Lambda jobs. */
export async function completeVerifiedPhaseBNativeMoveStage(
  input: PhaseBNativeRecoveryRequest,
): Promise<PhaseBNativeRecoveryReady> {
  if(process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED!=="true")
    throw new Error("Exact-stage native recovery requires explicit operator approval");
  const release=await (input.acquireWriterLeases||acquireCrossProfileWriterLeases)(
    input.sourceProfile,input.destinationProfile);
  try {
    const inspected=await inspectInterruptedPhaseBNativeMove(input);
    if(inspected.status!=="ready_to_commit")
      throw new Error("Phase B interrupted move remains quarantined: "+inspected.reason);
    const verifiedAgain=await inspectInterruptedPhaseBNativeMove(input);
    if(verifiedAgain.status!=="ready_to_commit"
      || !equalStage(inspected.stage,verifiedAgain.stage)
      || inspected.sourceEtag!==verifiedAgain.sourceEtag
      || inspected.destinationEtag!==verifiedAgain.destinationEtag
      || !sameTask(inspected.task,verifiedAgain.task))
      throw new Error("Phase B provider or staged identities changed before conditional commit");
    const committed=await input.state.commitPhaseBNativeMoveIfUnchanged({
      plan:verifiedAgain.plan,sourceMapping:verifiedAgain.sourceMapping,
      sourceLink:verifiedAgain.sourceLink,
      destinationMapping:verifiedAgain.destinationMapping,
      destinationLink:verifiedAgain.destinationLink,
    });
    if(!committed)throw new Error("Exact-stage atomic owner handoff CAS failed");
    await input.state.audit(input.destinationProfile,
      "todoist_phase_b_native_staged_handoff_verified_and_committed",{
        taskId:input.taskId,operationId:input.expectedOperationId,
        sourceMasterId:inspected.stage.sourceMasterId,
        successorMasterId:inspected.stage.successorMasterId,
      });
    return verifiedAgain;
  }catch(error){
    // Only audit on failure; NEVER clear a partially completed stage or
    // rollback/delete either provider's master. The fence remains live.
    await input.state.audit(input.sourceProfile,"todoist_phase_b_native_stage_recovery_quarantined",{
      taskId:input.taskId,operationId:input.expectedOperationId,
      reason:error instanceof Error?error.message:String(error),
    });
    throw error;
  }finally{
    await release();
  }
}
