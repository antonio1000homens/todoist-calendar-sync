import { profiles } from "./config.js";
import { otherProfileCalendarOrganizer } from "./calendar-profile-ownership.js";
import { attachProjectCommentReference } from "./mapping-comments.js";
import {
  createBudgetedClientFactory,
  defaultProviderClientFactory,
  isMutationBudgetExhausted,
  ReconciliationMutationBudget,
  type ProviderClientFactory,
} from "./mutation-budget.js";
import {
  calendarCanonicalIdentity,
  CanonicalIdentityStore,
  sameCanonicalIdentity,
  todoistCanonicalIdentity,
  type CanonicalIdentity,
  type CanonicalIdentityRepository,
} from "./canonical-identity.js";
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
import { ReconciliationItemError, reconciliationFailureDetails } from "./reconciliation-diagnostics.js";
import { logEvent } from "./observability.js";
import { calendarEventHasElapsed, calendarOwnedMetadataResolution, hasCanonicalState, selectCalendarRecurrenceInstance, recurringTaskIdentityCandidates, toTodoistTask } from "./sync.js";
import type { CalendarEvent, Mapping, Profile, ReconciliationContinuation, RecurrenceLink, TodoistTask } from "./types.js";

const MAX_PROVIDER_MUTATIONS = 10;
const DEFAULT_CALENDAR_RECOVERY_CANDIDATE_LIMIT = 20;

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

function isTodoistOwnedProjection(event: CalendarEvent): boolean {
  const shared = event.extendedProperties?.shared;
  return Boolean(
    shared?.syncSource === "todoist-calendar-sync"
    || shared?.syncRecurrenceOwner === "todoist"
    || shared?.taskId,
  );
}

function recurrenceLink(mapping: Mapping): RecurrenceLink {
  return {
    profile: mapping.profile,
    owner: "calendar",
    seriesId: mapping.seriesId!,
    masterEventId: mapping.masterEventId,
    activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart,
    ...(mapping.syncedTitle !== undefined ? { syncedTitle: mapping.syncedTitle } : {}),
    ...(mapping.syncedDescription !== undefined ? { syncedDescription: mapping.syncedDescription } : {}),
    ...(mapping.calendarNativeRecurring ? { calendarNativeRecurring: true } : {}),
    ...(mapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
    ...(mapping.completedThroughOriginalStart ? { completedThroughOriginalStart: mapping.completedThroughOriginalStart } : {}),
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    updatedAt: mapping.updatedAt,
  };
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
  identities: CanonicalIdentityRepository | undefined = state instanceof StateRepository ? new CanonicalIdentityStore() : undefined,
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
  const tasks = await pair.todoist.listTasks();
  const snapshot = await pair.calendar.listDelta();
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
    for (const eventId of eventIds) if (await state.syncBlocked(profile,{eventId,taskId})) {
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
      await state.putMapping(fallback);
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
      const existing = await state.getMappingByTaskAnyProfile(candidate.id);
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

  const findCanonicalTask = async (event: CalendarEvent, eventIds = [event.id]) => {
    return eligibleUniqueTask(tasks.filter((task) => hasCanonicalState(event, task)),eventIds);
  };

  const findIdentityTask = async (identity: CanonicalIdentity, eventIds: string[]) => {
    return eligibleUniqueTask(tasks.filter((task) => sameCanonicalIdentity(todoistCanonicalIdentity(task), identity)),eventIds);
  };

  const rememberStandaloneIdentity = async (event: CalendarEvent, task: TodoistTask): Promise<void> => {
    if (!identities) return;
    const eventIdentity = calendarCanonicalIdentity(event);
    const taskIdentity = todoistCanonicalIdentity(task);
    if (eventIdentity) await identities.put(profile, "calendar", event.id, eventIdentity);
    if (taskIdentity) await identities.put(profile, "todoist", task.id, taskIdentity);
  };

  const createOrBindStandalone = async (event: CalendarEvent): Promise<void> => {
    if (await controlsBlockRecovery([event.id])) return;
    if (await completionBlocksRecovery(event.id)) return;
    if (await state.getMappingByEvent(profile, event.id)) {
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
    const match = await findCanonicalTask(event);
    if (match.blocked) return;
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
    let recoveredPreviousIdentity = false;
    const currentIdentity = calendarCanonicalIdentity(event);

    if (!task && currentIdentity && identities) {
      const previousIdentity = (await identities.get(profile, "calendar", event.id))?.identity;
      if (previousIdentity && !sameCanonicalIdentity(previousIdentity, currentIdentity)) {
        const historical = await findIdentityTask(previousIdentity,[event.id]);
        if (historical.blocked) return;
        if (historical.ambiguous) {
          summary.conflicts += 1;
          await state.audit(profile, "calendar_snapshot_unmapped_ambiguous", {
            eventId: event.id,
            source: "snapshot_previous_identity",
            candidateTaskIds: historical.candidateTaskIds,
            eligibleCandidateTaskIds: historical.eligibleCandidateTaskIds,
            mappedCandidateTaskIds: historical.mappedCandidateTaskIds,
            reservedCandidateTaskIds: historical.reservedCandidateTaskIds,
            previousIdentity,
            currentIdentity,
          });
          return;
        }
        if (historical.task) {
          if (await controlsBlockRecovery([event.id],historical.task.id)) return;
          if (!await canMutate(event.id,historical.task.id)) return;
          if (await completionBlocksRecovery(event.id, true)) return;
          if (await controlsBlockRecovery([event.id],historical.task.id)) return;
          task = await pair.todoist.upsertTask(toTodoistTask(event), historical.task.id);
          await state.recordMutation(profile);
          recoveredPreviousIdentity = true;
        }
      }
    }

    if (!task) {
      if (await controlsBlockRecovery([event.id])) return;
      if (!await canMutate(event.id)) return;
      if (await completionBlocksRecovery(event.id, true)) return;
      if (await controlsBlockRecovery([event.id])) return;
      task = await pair.todoist.upsertTask(toTodoistTask(event));
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
          catch (error) { await state.putMapping(mapping); await state.audit(profile,"calendar_snapshot_import_cleanup_deferred",{eventId:event.id,taskId:task.id,commentId:comment.id,stage:"after_comment_write",error:error instanceof Error?error.message:String(error)}); }
        } else await state.putMapping(mapping);
        return;
      }
    }

    if (await controlsBlockRecovery([event.id],task.id)) {
      if (created) await rollbackCreatedTask(event,task,mapping,"before_mapping_write");
      return;
    }
    await state.putMapping(mapping);
    await rememberStandaloneIdentity(event, task);
    if (created) summary.imported += 1;
    else summary.rebound += 1;
    const action = created
      ? "calendar_snapshot_imported_task"
      : recoveredPreviousIdentity
        ? "calendar_orphan_todoist_rebound_previous_identity"
        : "calendar_snapshot_rebound_mapping";
    await state.audit(profile, action, {
      eventId: event.id,
      taskId: task.id,
      projectCommentId: mapping.projectCommentId,
    });
  };

  const createOrBindSeries = async (master: CalendarEvent): Promise<void> => {
    if (await controlsBlockRecovery([master.id])) return;
    const seriesId = master.iCalUID || master.id;
    const existingLink = await state.getRecurrenceLink(profile, seriesId);
    const originProfile = otherProfileCalendarOrganizer(profile, master);
    if (originProfile) {
      summary.skipped += 1;
      await state.audit(profile, "calendar_cross_profile_copy_ignored", {
        seriesId, masterEventId: master.id, fromProfile: profile, toProfile: originProfile,
      });
      return;
    }
    const boundedFiniteWeekly = finiteWeeklyCalendarRuleCandidate(master);
    const nativeRecurrence = nativeCalendarRecurrenceCandidate(master);
    // Only explicitly Calendar-owned existing mappings can be upgraded.
    if (existingLink && !nativeRecurrence && !boundedFiniteWeekly) {
      summary.skipped += 1;
      return;
    }
    const mappedStart = existingLink?.activeEffectiveStart || existingLink?.originalStart;
    const mappedMs = mappedStart ? Date.parse(mappedStart) : Number.NaN;
    const fromMs = Number.isFinite(mappedMs) ? Math.min(mappedMs, now) : now;
    const windowStart = new Date(fromMs - 24 * 60 * 60_000).toISOString();
    const windowEnd = new Date(now + 3 * 366 * 24 * 60 * 60_000).toISOString();
    if (nativeRecurrence && !pair.calendar.listInstancesInWindow) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_recurrence_recovery_bounded_inventory_unavailable", {
        seriesId, masterEventId: master.id,
      });
      return;
    }
    const instances = boundedFiniteWeekly
      ? await pair.calendar.listInstances(master.id)
      : nativeRecurrence
        ? await pair.calendar.listInstancesInWindow!(master.id, windowStart, windowEnd)
        : await pair.calendar.listInstances(master.id, windowStart);
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
    if (await controlsBlockRecovery([master.id,active.id])) return;
    const existingMapping = await state.getMappingByEvent(profile, active.id);
    if (existingMapping && !existingLink) {
      summary.skipped += 1;
      return;
    }
    if (await completionBlocksRecovery(active.id)) return;

    const recurrence = (boundedFiniteWeekly || nativeRecurrence) && seriesTimeZone
      ? await verifiedCalendarOwnedRecurrence(master, instances, seriesTimeZone,
        pair.calendar.listExplicitSeriesExceptions?.bind(pair.calendar))
      : undefined;
    if (!recurrence) {
      await state.audit(profile, "calendar_recurrence_todoist_rule_unsupported", {
        seriesId, masterEventId: master.id, reason: boundedFiniteWeekly
          ? "finite_weekly_rule_or_instance_inventory_not_representable" : nativeRecurrence ? "native_rule_or_complete_exception_inventory_not_representable" : "rrule_outside_supported_native_subset",
      });
    }
    if (boundedFiniteWeekly || nativeRecurrence || hasAllDayInstances) {
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
      // A regular snapshot must not silently re-own a series or adopt an
      // unrelated task. Upgrade only the exact one-off mirror already mapped
      // to this Calendar master and active instance.
      if (!recurrence || existingLink.owner !== "calendar" || existingLink.masterEventId !== master.id
        || existingLink.activeInstanceId !== active.id || !existingMapping
        || existingMapping.taskId !== existingLink.taskId || existingMapping.eventId !== active.id
        || existingMapping.recurrenceOwner !== "calendar" || existingMapping.masterEventId !== master.id
        || existingMapping.seriesId !== seriesId) {
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
          summary.conflicts += 1;
          await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
            seriesId, masterEventId: master.id, eventId: active.id, candidateTaskIds: [currentTask.id],
          });
          return;
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
          calendarNativeRecurring: true, updatedAt: new Date().toISOString(),
        };
        if (existingMapping.syncedTitle !== baseline.syncedTitle
          || existingMapping.syncedDescription !== baseline.syncedDescription
          || !existingMapping.calendarNativeRecurring || requiresProviderWrite) {
          if (!await state.updateCalendarOwnedMetadataIfUnchanged(existingMapping, existingLink, baseline)) {
            summary.conflicts += 1;
            await state.audit(profile, "calendar_owned_metadata_mapping_changed", { seriesId, taskId: currentTask.id });
            return;
          }
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
        // persist recurrence semantics. Revert to the pre-migration one-off.
        await pair.todoist.upsertTask(toTodoistTask(active), currentTask.id);
        await state.recordMutation(profile);
        summary.conflicts += 1;
        await state.audit(profile, "calendar_recurrence_todoist_readback_mismatch", {
          seriesId, masterEventId: master.id, eventId: active.id, taskId: currentTask.id,
        });
        return;
      }
      const migratedMapping: Mapping = {
        ...existingMapping, calendarNativeRecurring: true,
        syncedTitle: normalizedText(active.summary),
        syncedDescription: normalizedDescription(active.description),
        updatedAt: new Date().toISOString(),
      };
      await state.putMapping(migratedMapping);
      await state.putRecurrenceLink(recurrenceLink(migratedMapping));
      summary.rebound += 1;
      await state.audit(profile, "calendar_snapshot_migrated_native_recurring_task", {
        seriesId, masterEventId: master.id, eventId: active.id, taskId: currentTask.id,
      });
      return;
    }

    const match = await findCanonicalTask(active,[master.id,active.id]);
    if (match.blocked) return;
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

    const sharedTaskIds = [...new Set([master.extendedProperties?.shared?.taskId, active.extendedProperties?.shared?.taskId].filter((id): id is string => Boolean(id)))];
    if (match.task?.due?.is_recurring || sharedTaskIds.some((id) => id !== match.task?.id)) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_recurring_identity_conflict", {
        seriesId, masterEventId: master.id, eventId: active.id,
        candidateTaskIds: [...new Set([...sharedTaskIds, ...(match.task?.due?.is_recurring ? [match.task.id] : [])])].sort(),
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
      task = await pair.todoist.upsertTask(recurrence ? calendarOwnedRecurringTaskPayload(active, recurrence, seriesTimeZone) : toTodoistTask(active));
      tasks.push(task);
      await state.recordMutation(profile);
      created = true;
    } else if (recurrence) {
      task = await pair.todoist.upsertTask(calendarOwnedRecurringTaskPayload(active, recurrence, seriesTimeZone), task.id);
      await state.recordMutation(profile);
    }
    const readback = recurrence ? calendarOwnedRecurringTaskReadback(task, active, recurrence, seriesTimeZone) : undefined;
    if (readback && !readback.matches) {
      summary.conflicts += 1;
      if (created) await rollbackCreatedTask(active, task, {
        profile, eventId: active.id, taskId: task.id, projectId: task.project_id,
        recurrenceOwner: "calendar", seriesId, masterEventId: master.id, activeInstanceId: active.id,
        originalStart: originalStart(active), updatedAt: new Date().toISOString(),
      }, "recurring_task_readback_mismatch");
      else {
        try {
          await pair.todoist.upsertTask(toTodoistTask(active), task.id);
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
      eventId: active.id,
      taskId: task.id,
      projectId: task.project_id,
      recurrenceOwner: "calendar",
      seriesId,
      masterEventId: master.id,
      activeInstanceId: active.id,
      originalStart: start,
      activeEffectiveStart: active.start?.dateTime || active.start?.date || start,
      calendarProgressVersion: 1,
      syncedTitle: normalizedText(active.summary),
      syncedDescription: normalizedDescription(active.description),
      ...(recurrence ? { calendarNativeRecurring: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (await controlsBlockRecovery([master.id,active.id],task.id)) {
      if (created) await rollbackCreatedTask(active,task,mapping,"after_series_task_create");
      return;
    }
    await state.putMapping(mapping);
    await state.putRecurrenceLink(recurrenceLink(mapping));
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
  const candidates = snapshot.items
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((event) => !afterEventId || event.id > afterEventId);

  for (let index = 0; index < candidates.length; index += 1) {
    const event = candidates[index];
    summary.scanned += 1;
    try {
      if (event.status === "cancelled" || (event.status && event.status !== "confirmed")) {
        summary.skipped += 1;
      } else if (isTodoistOwnedProjection(event) || event.recurringEventId) {
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
