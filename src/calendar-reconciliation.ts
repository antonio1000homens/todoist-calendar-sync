import { profiles } from "./config.js";
import {calendarReplaySourceIds} from "./calendar-provenance.js";
import { otherProfileCalendarOrganizer } from "./calendar-profile-ownership.js";
import { attachProjectCommentReference, deleteMappingComments } from "./mapping-comments.js";
import {
  createBudgetedClientFactory,
  defaultProviderClientFactory,
  isMutationBudgetExhausted,
  ReconciliationMutationBudget,
  type ProviderClientFactory,
} from "./mutation-budget.js";
import { StateRepository } from "./repository.js";
import {
  calendarOwnedRecurringTaskPayload,
  calendarOwnedRecurringTaskReadback,
  matchesCalendarOwnedRecurringTask,
  matchesCalendarOwnedRecurringRule,
  calendarOwnedTodoistRecurrence,
  verifiedCalendarOwnedRecurrence,
  finiteWeeklyCalendarRuleCandidate,
  nativeCalendarRecurrenceCandidate,
  resolveCalendarTimeZone,
} from "./calendar-owned-todoist-recurrence.js";
import { normalizedDescription, normalizedText } from "./security.js";
import { providerRecurrenceChanges, providerSyncBaseline } from "./provider-sync-baseline.js";
import { ReconciliationItemError, reconciliationFailureDetails } from "./reconciliation-diagnostics.js";
import { logEvent } from "./observability.js";
import { calendarEventHasElapsed, calendarOwnedMetadataResolution, hasCanonicalState, startsMatch, ignorableElapsedStandaloneCalendarEvent, selectCalendarRecurrenceInstance, recurringTaskIdentityCandidates, Synchronizer, toTodoistTask } from "./sync.js";
import { calendarRecurrenceMatchesTodoist } from "./todoist-recurrence.js";
import type { CalendarEvent, Mapping, Profile, ReconciliationContinuation, TodoistTask } from "./types.js";

const MAX_PROVIDER_MUTATIONS = 10;
const DEFAULT_CALENDAR_RECOVERY_CANDIDATE_LIMIT = 20;

function boundedRecurrenceWindow(anchor: string | undefined, nowMs: number): { start: string; end: string } | undefined {
  const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
  const pivot = Number.isFinite(anchorMs) ? anchorMs : nowMs;
  return Number.isFinite(pivot) && Number.isFinite(nowMs)
    ? {
      start: new Date(pivot - 24 * 60 * 60_000).toISOString(),
      end: new Date(Math.max(pivot, nowMs) + 3 * 366 * 24 * 60 * 60_000).toISOString(),
    }
    : undefined;
}

export interface CalendarRecoverySummary {
  scanned: number;
  skipped: number;
  imported: number;
  rebound: number;
  conflicts: number;
  blocked: number;
  providerMutations: number;
  mutationCapReached: boolean;
  continuation?: ReconciliationContinuation;
}

function candidateLimit(): number {
  const configured = Number(process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CALENDAR_RECOVERY_CANDIDATE_LIMIT;
}

function taskComment(event: CalendarEvent): string {
  return `todoist-calendar-sync\ncalendarEventId=${event.id}\ncalendarUrl=${event.htmlLink || ""}`;
}

function todoistTaskMatchesCalendarRecurrence(master: CalendarEvent, task: TodoistTask): boolean {
  return calendarRecurrenceMatchesTodoist(master, task);
}


function originalStart(event: CalendarEvent): string | undefined {
  return event.originalStartTime?.dateTime
    || event.originalStartTime?.date
    || event.start?.dateTime
    || event.start?.date;
}

async function completedProjection(
  state: StateRepository,
  profile: Profile,
  eventId: string,
) {
  const completionState = state as unknown as Partial<Pick<StateRepository, "getCompletedCalendarProjectionByEvent">>;
  return completionState.getCompletedCalendarProjectionByEvent?.(profile, eventId);
}

/**
 * Snapshot-style Calendar recovery independent of the incremental sync token.
 * listDelta(undefined) is used only as a read-only full listing here; its
 * nextSyncToken is deliberately ignored so recovery can never advance the
 * incremental cursor.
 *
 * Candidate processing is bounded independently from the provider mutation
 * budget. A mostly-no-op Calendar with many events can otherwise issue many
 * DynamoDB ownership/mapping reads in one tight loop even with Lambda
 * concurrency fixed at one.
 */
export async function reconcileUnmappedCalendar(
  profile: Profile,
  state = new StateRepository(),
  clientFactory: ProviderClientFactory = defaultProviderClientFactory,
  mutationBudget = new ReconciliationMutationBudget(MAX_PROVIDER_MUTATIONS),
  continuation?: ReconciliationContinuation,
  maxCandidates = candidateLimit(),
): Promise<CalendarRecoverySummary> {
  if (continuation && continuation.phase !== "calendar") {
    throw new Error(`Calendar recovery cannot resume continuation phase ${continuation.phase}`);
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("Calendar recovery candidate limit must be a positive integer");
  }

  const startMutationCount = mutationBudget.used;
  const summary: CalendarRecoverySummary = {
    scanned: 0,
    skipped: 0,
    imported: 0,
    rebound: 0,
    conflicts: 0,
    blocked: 0,
    providerMutations: 0,
    mutationCapReached: mutationBudget.exhausted,
  };

  const finishSummary = (): CalendarRecoverySummary => {
    summary.providerMutations = mutationBudget.used - startMutationCount;
    // Preserve a cap detected by a rejected worst-case reservation. In that
    // case used may still be below limit even though continuing is unsafe.
    summary.mutationCapReached = summary.mutationCapReached || mutationBudget.exhausted;
    return summary;
  };

  if (!await state.mutationAllowed(profile)) {
    summary.blocked += 1;
    finishSummary();
    await state.audit(profile, "calendar_snapshot_reconcile_circuit_open", { summary });
    return summary;
  }

  if (mutationBudget.exhausted) {
    finishSummary();
    await state.audit(profile, "calendar_snapshot_reconcile_mutation_budget_exhausted", {
      reason: "mutation_budget_exhausted", summary, mutationBudget: mutationBudget.snapshot(),
    });
    return summary;
  }

  const pair = await createBudgetedClientFactory(mutationBudget, clientFactory)(profile);
  const mappingSync = new Synchronizer(state, undefined, async () => pair);
  const tasks = await pair.todoist.listTasks();
  const snapshot = await pair.calendar.listDelta();
  const eventsById = new Map(snapshot.items.map((event) => [event.id, event]));
  // Snapshot recovery can import an unmapped Calendar event after confirmed
  // erasure deliberately removed its DynamoDB mapping. Read the bounded
  const now = Date.now();
  let calendarTimeZone: string | undefined;
  if (snapshot.items.some((event) => event.end?.date && !event.end.dateTime) && pair.calendar.getTimeZone) {
    try { calendarTimeZone = await pair.calendar.getTimeZone(); }
    catch { /* Per-item recurrence handling retries and records an actionable diagnostic. */ }
  }
  const reservedTaskIds = new Set<string>();

  const canMutate = async (eventId?:string, taskId?:string): Promise<boolean> => {
    if (!await state.mutationAllowed(profile)) {
      summary.blocked += 1;
      await state.audit(profile,"calendar_snapshot_reconcile_mutation_gate_blocked",{
        eventId,taskId,reason:"mutation_gate_closed",
      });
      return false;
    }
    return true;
  };
  const controlsBlockRecovery = async (eventIds: string[], taskId?: string): Promise<boolean> => {
    for (const eventId of eventIds) if (await state.syncBlocked(profile,{eventId,taskId}, true)) {
      summary.blocked += 1;
      await state.audit(profile,"calendar_snapshot_sync_control_blocked",{eventId,taskId});
      return true;
    }
    return false;
  };
  const rollbackCreatedTask = async (event: CalendarEvent, task: TodoistTask, fallback: Mapping, stage: string): Promise<void> => {
    try {
      if (!await canMutate(event.id,task.id)) throw new Error("Mutation circuit is open; task rollback is deferred");
      await pair.todoist.deleteTask(task.id);
      await state.recordMutation(profile);
    } catch (error) {
      // Keep a durable association when cleanup itself is unavailable so a
      // later sync or operator review can find the object instead of losing it.
      await mappingSync.persistProviderMapping(fallback, pair.todoist);
      await state.audit(profile,"calendar_snapshot_import_cleanup_deferred",{eventId:event.id,taskId:task.id,stage,error:error instanceof Error?error.message:String(error)});
    }
  };

  const completionBlocksRecovery = async (eventId: string, recheckedBeforeMutation = false): Promise<boolean> => {
    const completed = await completedProjection(state, profile, eventId);
    if (!completed) return false;
    summary.skipped += 1;
    await state.audit(profile, "calendar_snapshot_completed_projection_ignored", {
      eventId,
      taskId: completed.taskId,
      completedAt: completed.completedAt,
      ...(recheckedBeforeMutation ? { recheckedBeforeMutation: true } : {}),
    });
    return true;
  };

  const eligibleUniqueTask = async (matches: TodoistTask[], eventIds: string[]): Promise<{
    task?: TodoistTask;
    ambiguous: boolean;
    blocked?: boolean;
    candidateTaskIds: string[];
    eligibleCandidateTaskIds: string[];
    mappedCandidateTaskIds: string[];
    reservedCandidateTaskIds: string[];
  }> => {
    const eligible: TodoistTask[] = [];
    const mapped: string[] = [];
    const reserved: string[] = [];
    let ownershipConflict = false;
    for (const candidate of matches) {
      if (await controlsBlockRecovery(eventIds,candidate.id)) return {
        ambiguous: false,
        blocked: true,
        candidateTaskIds: matches.map((task) => task.id).sort(),
        eligibleCandidateTaskIds: [],
        mappedCandidateTaskIds: [],
        reservedCandidateTaskIds: [],
      };
      const isReserved = reservedTaskIds.has(candidate.id);
      const existing = await mappingSync.providerMappingByTaskAnyProfile(candidate.id);
      if (isReserved) reserved.push(candidate.id);
      if (existing) mapped.push(candidate.id);
      if (isReserved || existing) {
        ownershipConflict = true;
        continue;
      }
      eligible.push(candidate);
    }
    return {
      task: eligible.length === 1 && !ownershipConflict ? eligible[0] : undefined,
      ambiguous: eligible.length > 1 || ownershipConflict,
      candidateTaskIds: matches.map((task) => task.id).sort(),
      eligibleCandidateTaskIds: eligible.map((task) => task.id).sort(),
      mappedCandidateTaskIds: mapped.sort(),
      reservedCandidateTaskIds: reserved.sort(),
    };
  };

  type SharedTaskMatch = {
    task?: TodoistTask;
    ambiguous: boolean;
    blocked?: boolean;
    deletedProviderTask?: boolean;
    inactiveProviderTask?: boolean;
    foreignProviderTask?: boolean;
    candidateTaskIds: string[];
    eligibleCandidateTaskIds: string[];
    mappedCandidateTaskIds: string[];
    reservedCandidateTaskIds: string[];
  };
  const findSharedTask = async (eventIds: string[]): Promise<SharedTaskMatch> => {
    const sharedTaskIds = [...new Set(eventIds.flatMap((id) => {
      const event = eventsById.get(id);
      const taskId = event?.extendedProperties?.shared?.taskId;
      return taskId ? [taskId] : [];
    }))];
    if (sharedTaskIds.length !== 1) return {
      task: undefined, ambiguous: sharedTaskIds.length > 1,
      candidateTaskIds: sharedTaskIds.sort(), eligibleCandidateTaskIds: [],
      mappedCandidateTaskIds: [], reservedCandidateTaskIds: [],
    };
    const taskId = sharedTaskIds[0];
    let current: TodoistTask;
    try {
      current = await pair.todoist.getTask(taskId);
    } catch (error) {
      const status = Number((error as { status?: number }).status);
      if (status === 404 || status === 410) return {
        task: undefined, ambiguous: false, deletedProviderTask: true,
        candidateTaskIds: [taskId], eligibleCandidateTaskIds: [],
        mappedCandidateTaskIds: [], reservedCandidateTaskIds: [],
      };
      throw error;
    }
    if (current.is_deleted || current.is_completed || current.completed_at) return {
      task: undefined, ambiguous: false, inactiveProviderTask: true,
      candidateTaskIds: [taskId], eligibleCandidateTaskIds: [],
      mappedCandidateTaskIds: [], reservedCandidateTaskIds: [],
    };
    if (current.project_id !== profiles[profile].todoistProjectId) return {
      task: undefined, ambiguous: false, foreignProviderTask: true,
      candidateTaskIds: [taskId], eligibleCandidateTaskIds: [],
      mappedCandidateTaskIds: [], reservedCandidateTaskIds: [],
    };
    const listedIndex = tasks.findIndex((task) => task.id === taskId);
    if (listedIndex >= 0) tasks[listedIndex] = current;
    else tasks.push(current);
    return eligibleUniqueTask([current], eventIds);
  };

  const findPotentialCollision = async (
    event: CalendarEvent,
    eventIds = [event.id],
    compatible: (task: TodoistTask) => boolean = task => hasCanonicalState(event, task),
  ) => {
    // Recover a missing provider link only when all portable fields, including
    // recurrence, match exactly and ownership checks leave one eligible task.
    const candidates = tasks.filter(compatible);
    if (!candidates.length) return {
      task: undefined, ambiguous: false, candidateTaskIds: [],
      eligibleCandidateTaskIds: [], mappedCandidateTaskIds: [], reservedCandidateTaskIds: [],
    };
    return eligibleUniqueTask(candidates, eventIds);
  };

  const createOrBindStandalone = async (event: CalendarEvent): Promise<void> => {
    if (await controlsBlockRecovery([event.id])) return;
    if (await completionBlocksRecovery(event.id)) return;
    if (await mappingSync.providerMappingByEvent(profile, event.id, pair.todoist)) {
      summary.skipped += 1;
      return;
    }
    const originProfile = otherProfileCalendarOrganizer(profile, event);
    if (originProfile) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_cross_profile_copy_ignored", {
        eventId: event.id, fromProfile: profile, toProfile: originProfile,
      });
      return;
    }
    const match = await findSharedTask([event.id]);
    const collision = match.candidateTaskIds.length ? match : await findPotentialCollision(event);
    if (!match.candidateTaskIds.length) Object.assign(match, collision);
    if (match.blocked) return;
    if ("deletedProviderTask" in match && match.deletedProviderTask) {
      if (!await canMutate(event.id, match.candidateTaskIds[0])) return;
      const staleMapping = await mappingSync.providerMappingByTask(profile, match.candidateTaskIds[0], pair.todoist);
      if (staleMapping && [staleMapping.eventId, staleMapping.masterEventId, staleMapping.activeInstanceId].includes(event.id)) {
        await deleteMappingComments(pair.todoist, staleMapping);
      }
      await pair.calendar.deleteEvent(event.id).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      if(staleMapping && !await state.purgeDeletedPair({profile,taskId:staleMapping.taskId,
        eventIds:[staleMapping.eventId,staleMapping.masterEventId,staleMapping.activeInstanceId,event.id].filter((id):id is string=>Boolean(id)),
        seriesIds:[staleMapping.seriesId,staleMapping.masterEventId].filter((id):id is string=>Boolean(id))}))
        throw new Error(`Deleted Calendar projection cleanup changed concurrently for task ${staleMapping.taskId}; retry or review`);
      await state.recordMutation(profile);
      summary.skipped += 1;
      await state.audit(profile, "calendar_snapshot_deleted_task_projection_removed", {
        eventId: event.id, taskId: match.candidateTaskIds[0],
      });
      return;
    }
    if (("inactiveProviderTask" in match && match.inactiveProviderTask)
      || ("foreignProviderTask" in match && match.foreignProviderTask)) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_snapshot_inactive_or_foreign_task_ignored", {
        eventId: event.id, taskId: match.candidateTaskIds[0],
        inactive: "inactiveProviderTask" in match && Boolean(match.inactiveProviderTask),
      });
      return;
    }
    if (match.ambiguous) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_unmapped_ambiguous", {
        eventId: event.id,
        candidateTaskIds: match.candidateTaskIds,
        eligibleCandidateTaskIds: match.eligibleCandidateTaskIds,
        mappedCandidateTaskIds: match.mappedCandidateTaskIds,
        reservedCandidateTaskIds: match.reservedCandidateTaskIds,
      });
      return;
    }

    let task = match.task;
    let created = false;
    if (!task) {
      if (await controlsBlockRecovery([event.id])) return;
      if (!await canMutate(event.id)) return;
      if (await completionBlocksRecovery(event.id, true)) return;
      if (await controlsBlockRecovery([event.id])) return;
      task = await pair.todoist.upsertTask(toTodoistTask(event), undefined, calendarReplaySourceIds(event));
      tasks.push(task);
      await state.recordMutation(profile);
      created = true;
    }
    reservedTaskIds.add(task.id);
    if (await controlsBlockRecovery([event.id],task.id)) {
      if (created) await rollbackCreatedTask(event,task,{profile,eventId:event.id,taskId:task.id,projectId:task.project_id,updatedAt:new Date().toISOString()},"after_task_create");
      return;
    }

    const projectId = task.project_id || profiles[profile].todoistProjectId;
    const draftMapping: Mapping = {
      profile,
      eventId: event.id,
      taskId: task.id,
      projectId,
      updatedAt: new Date().toISOString(),
    };
    let mapping = draftMapping;
    if (await canMutate(event.id,task.id)) {
      if (await completionBlocksRecovery(event.id, true)) return;
      const existingComment = await pair.todoist.findComment(task.id, event.id);
      if (await controlsBlockRecovery([event.id],task.id)) {
        if (created) await rollbackCreatedTask(event,task,draftMapping,"before_comment_write");
        return;
      }
      const comment = await pair.todoist.upsertComment(task.id, taskComment(event), existingComment?.id, draftMapping);
      const referenceMapping = existingComment?.id ? { ...draftMapping, commentId: existingComment.id } : draftMapping;
      mapping = attachProjectCommentReference(referenceMapping, projectId, comment.id);
      await state.recordMutation(profile);
      if (await controlsBlockRecovery([event.id],task.id)) {
        if (created) await rollbackCreatedTask(event,task,mapping,"after_comment_write");
        else if (!existingComment) {
          try { if (!await canMutate(event.id,task.id)) throw new Error("Mutation circuit is open; comment rollback is deferred"); await pair.todoist.deleteComment(comment.id); await state.recordMutation(profile); }
          catch (error) { await mappingSync.persistProviderMapping(mapping, pair.todoist); await state.audit(profile,"calendar_snapshot_import_cleanup_deferred",{eventId:event.id,taskId:task.id,commentId:comment.id,stage:"after_comment_write",error:error instanceof Error?error.message:String(error)}); }
        } else await mappingSync.persistProviderMapping(mapping, pair.todoist);
        return;
      }
    }

    if (await controlsBlockRecovery([event.id],task.id)) {
      if (created) await rollbackCreatedTask(event,task,mapping,"before_mapping_write");
      return;
    }
    await mappingSync.persistProviderMapping(mapping, pair.todoist);
    if (created) summary.imported += 1;
    else summary.rebound += 1;
    const action = created ? "calendar_snapshot_imported_task" : "calendar_snapshot_rebound_mapping";
    await state.audit(profile, action, {
      eventId: event.id,
      taskId: task.id,
      projectCommentId: mapping.projectCommentId,
    });
  };

  const createOrBindSeries = async (master: CalendarEvent): Promise<void> => {
    const seriesId = master.iCalUID || master.id;
    if (await controlsBlockRecovery([master.id])) return;
    // Prefer the stable series correlation, then recover an exact standalone
    // mirror when its Calendar event was converted to a recurring master.
    const existingLink = await mappingSync.providerSeriesMapping(profile, seriesId, pair.todoist)
      || await mappingSync.providerMappingByEvent(profile, master.id, pair.todoist);
    const originProfile = otherProfileCalendarOrganizer(profile, master);
    if (originProfile) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_cross_profile_copy_ignored", {
        seriesId, masterEventId: master.id, fromProfile: profile, toProfile: originProfile,
      });
      return;
    }
    const boundedFiniteWeekly = finiteWeeklyCalendarRuleCandidate(master);
    // Upgrade an exact legacy one-off mirror in place when the provider rule
    // can now be represented natively. Unsupported schedules remain intact.
    const nativeRecurrence = nativeCalendarRecurrenceCandidate(master);
    const finiteWeekly = boundedFiniteWeekly;
    if (!nativeRecurrence && !finiteWeekly) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, existingMirrorPreserved: Boolean(existingLink),
        outcome: "source_left_unchanged", nonBlocking: true,
      });
      return;
    }
    const mappedStart = existingLink?.activeEffectiveStart || existingLink?.originalStart;
    if (nativeRecurrence && !pair.calendar.listInstancesInWindow) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
        seriesId, masterEventId: master.id,
      });
      return;
    }
    const window = boundedRecurrenceWindow(mappedStart, now);
    if (!window) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
        seriesId, masterEventId: master.id, reason: "invalid_bounded_window",
      });
      return;
    }
    const instances = finiteWeekly
      ? await pair.calendar.listInstances(master.id)
      : await pair.calendar.listInstancesInWindow!(master.id, window.start, window.end);
    const hasAllDayInstances = instances.some((instance) => instance.end?.date && !instance.end.dateTime);
    let seriesTimeZone = master.start?.timeZone || calendarTimeZone;
    let calendarTimeZoneError: string | undefined;
    if (boundedFiniteWeekly || nativeRecurrence || hasAllDayInstances) {
      try { seriesTimeZone = await resolveCalendarTimeZone(master, pair.calendar.getTimeZone?.bind(pair.calendar)); }
      catch (error) {
        seriesTimeZone = undefined;
        calendarTimeZoneError = error instanceof Error ? error.message : String(error);
      }
      if (!seriesTimeZone) {
        summary.conflicts += 1;
        await state.audit(profile, "calendar_recurrence_calendar_timezone_unverified", {
          seriesId, masterEventId: master.id, error: calendarTimeZoneError || "Calendar timezone is unavailable",
        });
        return;
      }
    }
    const active = selectCalendarRecurrenceInstance(instances, existingLink, now, seriesTimeZone);
    if (!active || active.status === "cancelled" || calendarEventHasElapsed(active, now, seriesTimeZone)) {
      summary.skipped += 1;
      return;
    }
    const activeOriginal = active.originalStartTime?.dateTime || active.originalStartTime?.date;
    const activeEffective = active.start?.dateTime || active.start?.date;
    const activeMoved = Boolean(activeOriginal && activeEffective && (activeOriginal.includes("T") || activeEffective.includes("T")
      ? !Number.isFinite(Date.parse(activeOriginal)) || !Number.isFinite(Date.parse(activeEffective))
        || Date.parse(activeOriginal) !== Date.parse(activeEffective)
      : activeOriginal !== activeEffective));
    if (finiteWeekly && activeMoved) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_recurrence_todoist_moved_occurrence_requires_review", {
        seriesId, masterEventId: master.id, eventId: active.id,
        reason: "active_moved_occurrence_cannot_anchor_finite_todoist_projection",
        calendarUpdatedAt: active.updated || master.updated,
        calendarEtag: active.etag || master.etag,
      });
      return;
    }
    eventsById.set(active.id, active);
    if (await controlsBlockRecovery([master.id,active.id])) return;
    const existingMapping = await mappingSync.providerMappingByEvent(profile, active.id, pair.todoist)
      || await mappingSync.providerMappingByEvent(profile, master.id, pair.todoist);
    if (existingMapping && !existingLink) {
      summary.skipped += 1;
      return;
    }
    if (await completionBlocksRecovery(active.id)) return;

    const recurrence = (finiteWeekly || nativeRecurrence) && seriesTimeZone
      ? await verifiedCalendarOwnedRecurrence(master, instances, seriesTimeZone,
        pair.calendar.listExplicitSeriesExceptions?.bind(pair.calendar))
      : undefined;
    if (!recurrence) {
      await state.audit(profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, reason: boundedFiniteWeekly
          ? "finite_weekly_rule_or_instance_inventory_not_representable" : nativeRecurrence ? "native_rule_or_complete_exception_inventory_not_representable" : "rrule_outside_supported_native_subset",
      });
      // A Calendar series without a proven equivalent Todoist rule must remain
      // untouched. Creating a standalone task here would flatten the series.
      summary.skipped += 1;
      return;
    }
    if (finiteWeekly || nativeRecurrence || hasAllDayInstances) {
      let todoistTimeZone: string;
      try { todoistTimeZone = await pair.todoist.getTimeZone(); }
      catch (error) {
        summary.conflicts += 1;
        await state.audit(profile, "calendar_recurrence_todoist_timezone_unverified", {
          seriesId, masterEventId: master.id, calendarTimeZone: seriesTimeZone, error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (todoistTimeZone !== seriesTimeZone) {
        summary.conflicts += 1;
        await state.audit(profile, "calendar_recurrence_todoist_timezone_mismatch", {
          seriesId, masterEventId: master.id, calendarTimeZone: seriesTimeZone, todoistTimeZone,
        });
        return;
      }
    }

    if (existingLink) {
      // Rebind only the exact standalone/master pair. The provider IDs prove
      // identity; an old ownership marker or recurrence row is unnecessary.
      const exactMappedPair = Boolean(recurrence && existingMapping
        && existingMapping.profile === profile
        && (!existingMapping.projectId || existingMapping.projectId === profiles[profile].todoistProjectId)
        && (!existingMapping.calendarId || existingMapping.calendarId === profiles[profile].calendarId)
        && existingMapping.taskId === existingLink.taskId
        && [active.id, master.id].includes(existingMapping.eventId)
        && (!existingMapping.masterEventId || existingMapping.masterEventId === master.id)
        && (!existingMapping.seriesId || existingMapping.seriesId === seriesId)
        && (!existingLink.masterEventId || existingLink.masterEventId === master.id)
        && (!existingLink.seriesId || existingLink.seriesId === seriesId));
      if (!exactMappedPair || !existingMapping) {
        summary.skipped += 1;
        return;
      }
      let currentTask: TodoistTask;
      try { currentTask = await pair.todoist.getTask(existingLink.taskId); }
      catch (error) {
        if (Number((error as { status?: number }).status) === 404) {
          summary.skipped += 1;
          return;
        }
        throw error;
      }
      if (currentTask.due?.is_recurring) {
        // Native recurrence belongs to this exact link, including after
        // Todoist itself advanced its due. Reconcile metadata and persist a
        // durable baseline, not just the recurrence rule.
        if (!matchesCalendarOwnedRecurringRule(currentTask, recurrence, seriesTimeZone)) {
          const baseline = existingMapping.syncBaseline;
          const observed = providerSyncBaseline(currentTask, active, master);
          const recurrenceChanges = providerRecurrenceChanges(currentTask, master, baseline);
          const competing = recurringTaskIdentityCandidates(active, tasks).filter(id => id !== currentTask.id);
          if (!baseline?.todoist.due || !baseline.todoist.recurrence || !recurrenceChanges
            || recurrenceChanges.todoistChanged
            || observed.todoist.due !== baseline.todoist.due
            || competing.length) {
            summary.conflicts += 1;
            await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
              seriesId, masterEventId: master.id, eventId: active.id,
              candidateTaskIds: [...new Set([currentTask.id, ...competing])].sort(),
              reason: competing.length ? "competing_recurring_task" : "todoist_recurrence_changed_since_verified_baseline",
            });
            return;
          }
          if (await controlsBlockRecovery([master.id, active.id], currentTask.id)) return;
          if (!await canMutate(master.id, currentTask.id)) return;
          const liveTask = await pair.todoist.getTask(currentTask.id);
          const liveObserved = providerSyncBaseline(liveTask, active, master);
          const liveRecurrenceChanges = providerRecurrenceChanges(liveTask, master, baseline);
          if (liveTask.updated_at !== currentTask.updated_at
            || liveObserved.todoist.due !== observed.todoist.due
            || !liveRecurrenceChanges || liveRecurrenceChanges.todoistChanged) {
            summary.conflicts += 1;
            await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
              seriesId, masterEventId: master.id, eventId: active.id,
              candidateTaskIds: [currentTask.id], reason: "todoist_recurrence_changed_before_guarded_repair",
            });
            return;
          }
          const repaired = await pair.todoist.upsertTask(
            calendarOwnedRecurringTaskPayload(active, recurrence, seriesTimeZone), currentTask.id,
          );
          await state.recordMutation(profile);
          if (repaired.id !== currentTask.id
            || !calendarOwnedRecurringTaskReadback(repaired, active, recurrence, seriesTimeZone).matches) {
            await pair.todoist.upsertTask(currentTask, currentTask.id);
            await state.recordMutation(profile);
            summary.conflicts += 1;
            await state.audit(profile, "calendar_recurrence_todoist_readback_mismatch", {
              seriesId, masterEventId: master.id, eventId: active.id, taskId: currentTask.id,
            });
            return;
          }
          currentTask = repaired;
        }
        const metadata = calendarOwnedMetadataResolution(existingMapping, master, currentTask);
        if (metadata.conflicts.length || metadata.calendarChanged && !master.etag) {
          summary.conflicts += 1;
          await state.audit(profile, "calendar_owned_metadata_conflict", {
            seriesId, taskId: currentTask.id, masterEventId: master.id,
            fields: metadata.conflicts, reason: master.etag ? "concurrent_edits_or_missing_baseline" : "master_etag_missing",
          });
          return;
        }
        const requiresProviderWrite = metadata.calendarChanged || metadata.todoistChanged;
        if (requiresProviderWrite) {
          if (await controlsBlockRecovery([master.id, active.id], currentTask.id)) return;
          if (!await canMutate(master.id, currentTask.id)) return;
        }
        if (metadata.calendarChanged) {
          const result = await pair.calendar.patchEventMetadataIfUnchanged(master.id, master.etag!, {
            summary: metadata.summary, description: metadata.description,
          });
          await state.recordMutation(profile);
          if (result.id !== master.id || JSON.stringify(result.recurrence) !== JSON.stringify(master.recurrence)
            || normalizedText(result.summary) !== metadata.summary
            || normalizedDescription(result.description) !== metadata.description) {
            summary.conflicts += 1;
            await state.audit(profile, "calendar_owned_metadata_readback_mismatch", { seriesId, taskId: currentTask.id, provider: "calendar" });
            return;
          }
        }
        if (metadata.todoistChanged) {
          if (!await canMutate(master.id,currentTask.id)) return;
          const updated = await pair.todoist.updateTaskMetadata(currentTask.id, {
            content: metadata.summary, description: metadata.description,
          });
          await state.recordMutation(profile);
          if (updated.id !== currentTask.id || normalizedText(updated.content) !== metadata.summary
            || normalizedDescription(updated.description) !== metadata.description
            || JSON.stringify(updated.due) !== JSON.stringify(currentTask.due)) {
            summary.conflicts += 1;
            await state.audit(profile, "calendar_owned_metadata_readback_mismatch", { seriesId, taskId: currentTask.id, provider: "todoist" });
            return;
          }
        }
        const baseline: Mapping = {
          ...existingMapping, syncedTitle: metadata.summary, syncedDescription: metadata.description,
          eventId: master.id, seriesId, masterEventId: master.id,
          activeInstanceId: active.id, originalStart: originalStart(active),
          activeEffectiveStart: active.start?.dateTime || active.start?.date || originalStart(active),
          calendarProgressVersion: 1, updatedAt: new Date().toISOString(),
        };
        if (existingMapping.syncedTitle !== baseline.syncedTitle
          || existingMapping.syncedDescription !== baseline.syncedDescription
          || existingMapping.eventId !== master.id || existingMapping.seriesId !== seriesId
          || existingMapping.masterEventId !== master.id || existingMapping.activeInstanceId !== active.id
          || existingMapping.calendarProgressVersion !== 1 || requiresProviderWrite) {
          await mappingSync.persistProviderMapping(baseline, pair.todoist);
        }
        summary.skipped += 1;
        return;
      }
      const competing = recurringTaskIdentityCandidates(active, await pair.todoist.listTasks())
        .filter((id) => id !== currentTask.id);
      if (!hasCanonicalState(active, currentTask) || competing.length) {
        summary.conflicts += 1;
        await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
          seriesId, masterEventId: master.id, eventId: active.id,
          candidateTaskIds: [...new Set([currentTask.id, ...competing])].sort(),
        });
        return;
      }
      if (await controlsBlockRecovery([master.id, active.id], currentTask.id)) return;
      if (!await canMutate(master.id)) return;
      const migrated = await pair.todoist.upsertTask(calendarOwnedRecurringTaskPayload(active, recurrence, seriesTimeZone), currentTask.id);
      await state.recordMutation(profile);
      if (!calendarOwnedRecurringTaskReadback(migrated, active, recurrence, seriesTimeZone).matches) {
        // Do not alter durable Calendar mapping when the provider fails to
        // persist recurrence semantics. Restore the exact prior task payload.
        await pair.todoist.upsertTask(currentTask, currentTask.id);
        await state.recordMutation(profile);
        summary.conflicts += 1;
        await state.audit(profile, "calendar_recurrence_todoist_readback_mismatch", {
          seriesId, masterEventId: master.id, eventId: active.id, taskId: currentTask.id,
        });
        return;
      }
      const migratedMapping: Mapping = {
        ...existingMapping, eventId: master.id, seriesId, masterEventId: master.id,
        activeInstanceId: active.id, originalStart: originalStart(active),
        activeEffectiveStart: active.start?.dateTime || active.start?.date || originalStart(active),
        calendarProgressVersion: 1,
        syncedTitle: normalizedText(active.summary),
        syncedDescription: normalizedDescription(active.description),
        updatedAt: new Date().toISOString(),
      };
      await mappingSync.persistProviderMapping(migratedMapping, pair.todoist);
      summary.rebound += 1;
      await state.audit(profile, "calendar_snapshot_migrated_native_recurring_task", {
        seriesId, masterEventId: master.id, eventId: active.id, taskId: currentTask.id,
      });
      return;
    }

    const match = await findSharedTask([master.id,active.id]);
    const collision = match.candidateTaskIds.length ? match : await findPotentialCollision(active,[master.id,active.id], task =>
      normalizedText(active.summary).toLocaleLowerCase() === normalizedText(task.content).toLocaleLowerCase()
      && normalizedDescription(active.description) === normalizedDescription(task.description)
      && startsMatch(active, task)
      && (task.due?.is_recurring
        ? todoistTaskMatchesCalendarRecurrence(master, task)
        : matchesCalendarOwnedRecurringRule(task, recurrence, seriesTimeZone)));
    if (!match.candidateTaskIds.length) Object.assign(match, collision);
    if (match.blocked) return;
    if (!match.candidateTaskIds.length) {
      // Similar title/description/date with an incompatible recurrence is not
      // eligible for binding. Keep it as a collision guard so recovery does
      // not create a second series beside a likely counterpart.
      const nearMatches = tasks.filter(task =>
        normalizedText(active.summary).toLocaleLowerCase() === normalizedText(task.content).toLocaleLowerCase()
        && normalizedDescription(active.description) === normalizedDescription(task.description)
        && startsMatch(active, task));
      if (nearMatches.length) {
        const guarded = await eligibleUniqueTask(nearMatches, [master.id, active.id]);
        if (guarded.blocked) return;
        const ownershipConflict = guarded.eligibleCandidateTaskIds.length > 1
          || (guarded.mappedCandidateTaskIds.length > 0 && guarded.eligibleCandidateTaskIds.length > 0);
        summary.conflicts += ownershipConflict ? 1 : 0;
        summary.skipped += ownershipConflict ? 0 : 1;
        await state.audit(profile, ownershipConflict
          ? "calendar_snapshot_recurring_ambiguous" : "calendar_recurrence_identity_unverified", {
          seriesId, masterEventId: master.id, eventId: active.id,
          candidateTaskIds: guarded.candidateTaskIds,
          eligibleCandidateTaskIds: guarded.eligibleCandidateTaskIds,
          mappedCandidateTaskIds: guarded.mappedCandidateTaskIds,
          reservedCandidateTaskIds: guarded.reservedCandidateTaskIds,
          outcome: "preserve_independent_objects",
        });
        return;
      }
    }
    const sharedTaskIds = [...new Set([master.extendedProperties?.shared?.taskId, active.extendedProperties?.shared?.taskId].filter((id): id is string => Boolean(id)))];
    const exactSharedRecurring = tasks.find((task) => sharedTaskIds.includes(task.id) && task.due?.is_recurring);
    if (exactSharedRecurring && (!todoistTaskMatchesCalendarRecurrence(master, exactSharedRecurring)
      || !matchesCalendarOwnedRecurringRule(exactSharedRecurring, recurrence, seriesTimeZone))) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, taskId: exactSharedRecurring.id,
        reason: "exactly_correlated_todoist_rule_not_equivalent",
        existingMirrorPreserved: true, outcome: "source_left_unchanged",
      });
      return;
    }
    if (match.ambiguous && !sharedTaskIds.length) {
      const recurringCandidates = tasks.filter((task) => task.due?.is_recurring && hasCanonicalState(active, task));
      if (recurringCandidates.length) {
        summary.skipped += 1;
        await state.audit(profile, "calendar_recurrence_identity_unverified", {
          seriesId, masterEventId: master.id, eventId: active.id,
          candidateTaskIds: recurringCandidates.map((task) => task.id).sort(),
          outcome: "preserve_independent_objects",
        });
        return;
      }
    }
    if (match.ambiguous && sharedTaskIds.length) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
        seriesId, masterEventId: master.id, eventId: active.id,
        candidateTaskIds: [...new Set([...sharedTaskIds, ...match.candidateTaskIds])].sort(),
      });
      return;
    }
    if (match.ambiguous) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_recurring_ambiguous", {
        seriesId,
        masterEventId: master.id,
        eventId: active.id,
        candidateTaskIds: match.candidateTaskIds,
        eligibleCandidateTaskIds: match.eligibleCandidateTaskIds,
        mappedCandidateTaskIds: match.mappedCandidateTaskIds,
        reservedCandidateTaskIds: match.reservedCandidateTaskIds,
      });
      return;
    }

    if (match.task?.due?.is_recurring && !todoistTaskMatchesCalendarRecurrence(master, match.task)) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, taskId: match.task.id,
        reason: "existing_todoist_recurrence_not_equivalent",
        existingMirrorPreserved: true, outcome: "source_left_unchanged",
      });
      return;
    }

    if (sharedTaskIds.some((id) => id !== match.task?.id)) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
        seriesId, masterEventId: master.id, eventId: active.id,
        candidateTaskIds: [...new Set([...sharedTaskIds, ...(match.task ? [match.task.id] : [])])].sort(),
      });
      return;
    }
    let task = match.task;
    let created = false;
    if (!task) {
      const competingRecurringTaskIds = recurringTaskIdentityCandidates(active, tasks);
      if (competingRecurringTaskIds.length) {
        summary.conflicts += 1;
        await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
          seriesId, masterEventId: master.id, eventId: active.id,
          candidateTaskIds: competingRecurringTaskIds,
        });
        return;
      }
      if (await controlsBlockRecovery([master.id,active.id])) return;
      if (!await canMutate(master.id)) return;
      if (await completionBlocksRecovery(active.id, true)) return;
      if (await controlsBlockRecovery([master.id,active.id])) return;
      task = await pair.todoist.upsertTask(calendarOwnedRecurringTaskPayload(active, recurrence, seriesTimeZone), undefined, calendarReplaySourceIds(active, master.id));
      tasks.push(task);
      await state.recordMutation(profile);
      created = true;
    } else {
      task = await pair.todoist.upsertTask(calendarOwnedRecurringTaskPayload(active, recurrence, seriesTimeZone), task.id);
      await state.recordMutation(profile);
    }
    const readback = calendarOwnedRecurringTaskReadback(task, active, recurrence, seriesTimeZone);
    if (!readback.matches) {
      summary.conflicts += 1;
      if (created) await rollbackCreatedTask(active, task, {
        profile, eventId: active.id, taskId: task.id, projectId: task.project_id,
        seriesId, masterEventId: master.id, activeInstanceId: active.id,
        originalStart: originalStart(active), updatedAt: new Date().toISOString(),
      }, "recurring_task_readback_mismatch");
      else {
        try {
          await pair.todoist.upsertTask(match.task!, match.task!.id);
          await state.recordMutation(profile);
        } catch (error) {
          await state.audit(profile, "calendar_recurrence_todoist_restore_deferred", {
            seriesId, masterEventId: master.id, taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await state.audit(profile, "calendar_recurrence_todoist_readback_mismatch", {
        seriesId, masterEventId: master.id, eventId: active.id, taskId: task.id,
        expected: readback.expected,
        observed: readback.observed,
      });
      return;
    }
    reservedTaskIds.add(task.id);

    const start = originalStart(active);
    const mapping: Mapping = {
      profile,
      eventId: master.id,
      taskId: task.id,
      projectId: task.project_id,
      seriesId,
      masterEventId: master.id,
      activeInstanceId: active.id,
      originalStart: start,
      activeEffectiveStart: active.start?.dateTime || active.start?.date || start,
      calendarProgressVersion: 1,
      syncedTitle: normalizedText(active.summary),
      syncedDescription: normalizedDescription(active.description),
      updatedAt: new Date().toISOString(),
    };
    if (await controlsBlockRecovery([master.id,active.id],task.id)) {
      if (created) await rollbackCreatedTask(active,task,mapping,"after_series_task_create");
      return;
    }
    await mappingSync.persistProviderMapping(mapping, pair.todoist);
    if (created) summary.imported += 1;
    else summary.rebound += 1;
    await state.audit(profile, created ? "calendar_snapshot_imported_recurring_task" : "calendar_snapshot_rebound_recurring_mapping", {
      seriesId,
      masterEventId: master.id,
      eventId: active.id,
      taskId: task.id,
    });
  };

  const afterEventId = continuation?.afterEventId;
  // Do not let known historical standalone events consume the bounded
  // reconciliation candidate window or trigger per-event DynamoDB work.
  // Keep cancelled events, recurrence masters/instances and unknown dates.
  const candidates = snapshot.items
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((event) => (!afterEventId || event.id > afterEventId)
      && !ignorableElapsedStandaloneCalendarEvent(event, now, calendarTimeZone));

  for (let index = 0; index < candidates.length; index += 1) {
    const event = candidates[index];
    summary.scanned += 1;
    try {
      if (event.status === "cancelled" || (event.status && event.status !== "confirmed")) {
        summary.skipped += 1;
      } else if (event.recurringEventId) {
        summary.skipped += 1;
      } else if (event.recurrence?.length) {
        await createOrBindSeries(event);
      } else if (event.end?.date && !event.end.dateTime && !calendarTimeZone) {
        summary.skipped += 1;
        await state.audit(profile, "calendar_snapshot_calendar_timezone_unverified", {
          eventId: event.id, reason: "Calendar resource timezone is unavailable for all-day event classification",
        });
      } else if (calendarEventHasElapsed(event, now, calendarTimeZone)) {
        summary.skipped += 1;
      } else {
        await createOrBindStandalone(event);
      }
    } catch (error) {
      if (!isMutationBudgetExhausted(error)) {
        const failure = new ReconciliationItemError(error, { stage: "calendar", eventId: event.id });
        const detail = reconciliationFailureDetails(failure);
        logEvent("calendar_snapshot_reconcile_item_failed", { profile, ...detail }, "reconciliation");
        try {
          await state.audit(profile, "calendar_snapshot_reconcile_item_failed", detail);
        } catch {
          logEvent("calendar_snapshot_reconcile_failure_audit_failed", { profile, ...detail }, "reconciliation");
        }
        throw failure;
      }
      summary.mutationCapReached = true;
      await state.audit(profile, "calendar_snapshot_reconcile_mutation_budget_exhausted", {
        eventId: event.id,
        reason: "mutation_budget_exhausted",
        error: error.message,
        mutationBudget: mutationBudget.snapshot(),
      });
      break;
    }

    if (mutationBudget.exhausted) {
      summary.mutationCapReached = true;
      break;
    }

    if (summary.scanned >= maxCandidates && index < candidates.length - 1) {
      summary.continuation = {
        sequence: (continuation?.sequence || 0) + 1,
        phase: "calendar",
        afterEventId: event.id,
      };
      break;
    }
  }

  finishSummary();
  await state.audit(
    profile,
    summary.continuation ? "calendar_snapshot_reconcile_chunk_completed" : "calendar_snapshot_reconcile_completed",
    { summary, mutationBudget: mutationBudget.snapshot() },
  );
  return summary;
}

export { recurringTaskIdentityCandidates } from "./sync.js";
