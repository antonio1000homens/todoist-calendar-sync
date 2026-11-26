import { pacedScan } from "./dynamodb-capacity.js";
import { profiles } from "./config.js";
import {
  buildProjectMappingIndex,
  findProjectMappingComment,
  isOwnedLegacyTaskMappingComment,
  nextProjectCommentMapping,
  recoverMappingFromProjectComment,
  upsertProjectMappingComment,
  type ProjectCommentClient,
  type ProjectMappingIndex,
  type TodoistCommentRecord,
} from "./mapping-comments.js";
import { defaultProviderClientFactory, type ProviderClientFactory } from "./mutation-budget.js";
import { assertReplayAdmissionIfEnabled, mappingReplayIdentity } from "./erasure-replay-barrier.js";
import { acquireErasureProtocolLease, getErasureEpoch } from "./erasure-protocol.js";
import { StateRepository } from "./repository.js";
import type { CalendarEvent, CompletedCalendarProjection, Mapping, Profile, TodoistTask } from "./types.js";

const tableName = process.env.STATE_TABLE_NAME || "";
const MIGRATION_PROVIDER_OPTIONS = { readRetries: 7, rateLimitRetries: 12, maxRetryDelayMs: 10_000 } as const;

export interface ProjectCommentMigrationState {
  retireMigratedMappingCorrelation?(mapping: Mapping): Promise<boolean>;
  putCompletedCalendarProjection?(projection: CompletedCalendarProjection): Promise<void>;
  audit(profile: Profile, action: string, detail: Record<string, unknown>): Promise<void>;
}

export interface ProjectCommentMigrationClients {
  todoist: ProjectCommentClient & {
    getTask(taskId: string): Promise<TodoistTask>;
  };
  calendar: {
    getEvent(eventId: string): Promise<CalendarEvent>;
    ensureTaskCorrelation?(eventId: string, taskId: string, expectedTaskId?: string,
      mapping?: Partial<Mapping>): Promise<CalendarEvent>;
  };
}

export interface ProjectCommentMigrationSummary {
  mode: "report" | "apply";
  mappingsScanned: number;
  projectCommentsIndexed: number;
  malformedProjectComments: number;
  projectCommentsMissing: number;
  migratedMappings: number;
  projectCommentsCreated: number;
  existingProjectCommentsReused: number;
  legacyTaskCommentsFound: number;
  legacyTaskCommentsCleanupEligible: number;
  legacyTaskCommentsDeleted: number;
  legacyTaskCommentsAlreadyMissing: number;
  legacyTaskCommentsCleanupRejected: number;
  missingTasks: number;
  completedTasks: number;
  deletedTasks: number;
  missingCalendarEvents: number;
  legacyCorrelationRowsRetired: number;
  legacyCorrelationRetirementRejected: number;
  projectMismatches: number;
  duplicateProjectComments: number;
  failures: number;
}

function emptySummary(apply: boolean, index: ProjectMappingIndex): ProjectCommentMigrationSummary {
  return {
    mode: apply ? "apply" : "report",
    mappingsScanned: 0,
    projectCommentsIndexed: index.parsed.length,
    malformedProjectComments: index.malformed.length,
    projectCommentsMissing: 0,
    migratedMappings: 0,
    projectCommentsCreated: 0,
    existingProjectCommentsReused: 0,
    legacyTaskCommentsFound: 0,
    legacyTaskCommentsCleanupEligible: 0,
    legacyTaskCommentsDeleted: 0,
    legacyTaskCommentsAlreadyMissing: 0,
    legacyTaskCommentsCleanupRejected: 0,
    missingTasks: 0,
    completedTasks: 0,
    deletedTasks: 0,
    missingCalendarEvents: 0,
    legacyCorrelationRowsRetired: 0,
    legacyCorrelationRetirementRejected: 0,
    projectMismatches: 0,
    duplicateProjectComments: 0,
    failures: 0,
  };
}

function providerMissing(error: unknown): boolean {
  return [404, 410].includes(Number((error as { status?: number }).status));
}

async function ensureCalendarCorrelation(
  profile: Profile, mapping: Mapping, event: CalendarEvent,
  calendar: ProjectCommentMigrationClients["calendar"],
): Promise<void> {
  if (typeof calendar.ensureTaskCorrelation !== "function")
    throw new Error("Calendar conditional correlation writer unavailable");
  const eventId = mapping.masterEventId || mapping.eventId;
  const current = await calendar.getEvent(eventId);
  const shared = current.extendedProperties?.shared || {};
  if (shared.taskId && shared.taskId !== mapping.taskId)
    throw new Error("Calendar event already names a different Todoist task");
  await calendar.ensureTaskCorrelation(eventId, mapping.taskId, undefined, mapping);
  const readback = await calendar.getEvent(eventId);
  const observed = readback.extendedProperties?.shared || {};
  const expected = {
    taskId: mapping.taskId,
    syncTaskId: mapping.taskId,
    syncSchemaVersion: "2",
    syncProfile: profile,
    syncCalendarId: profiles[profile].calendarId,
    syncEventId: eventId,
    ...(mapping.seriesId ? { syncSeriesId: mapping.seriesId } : {}),
    ...(mapping.masterEventId ? { syncMasterEventId: mapping.masterEventId } : {}),
    ...(mapping.activeInstanceId ? { syncActiveInstanceId: mapping.activeInstanceId } : {}),
    ...(mapping.originalStart ? { syncOriginalStart: mapping.originalStart } : {}),
    ...(mapping.activeEffectiveStart ? { syncActiveEffectiveStart: mapping.activeEffectiveStart } : {}),
    ...(mapping.calendarProgressVersion === 1 ? { syncProgressVersion: "1" } : {}),
    ...(mapping.completedThroughOriginalStart ? { syncCompletedThrough: mapping.completedThroughOriginalStart } : {}),
  };
  if (readback.id !== eventId
    || (event.id !== eventId && event.recurringEventId !== eventId)
    || Object.entries(expected).some(([key, value]) => observed[key] !== value))
    throw new Error("Calendar provider correlation readback did not match the exact Todoist mapping");
}

function exactProjectComments(index: ProjectMappingIndex, mapping: Mapping): TodoistCommentRecord[] {
  return (index.byTaskId.get(mapping.taskId) || [])
    .filter((entry) => entry.payload.eventId === mapping.eventId)
    .map((entry) => entry.comment);
}

function legacyCommentId(mapping: Mapping, canonicalProjectCommentId?: string): string | undefined {
  const projectCommentId = mapping.projectCommentId || canonicalProjectCommentId;
  if (mapping.taskCommentId && mapping.taskCommentId !== projectCommentId) return mapping.taskCommentId;
  return mapping.commentId && mapping.commentId !== projectCommentId ? mapping.commentId : undefined;
}

function recurrenceStateChanged(before: Mapping, after: Mapping): boolean {
  return before.recurrenceOwner !== after.recurrenceOwner
    || before.seriesId !== after.seriesId
    || before.masterEventId !== after.masterEventId
    || before.activeInstanceId !== after.activeInstanceId
    || before.originalStart !== after.originalStart
    || before.activeEffectiveStart !== after.activeEffectiveStart
    || before.calendarProgressVersion !== after.calendarProgressVersion
    || before.completedThroughOriginalStart !== after.completedThroughOriginalStart;
}

async function findLegacyComment(
  client: ProjectCommentClient,
  mapping: Mapping,
): Promise<TodoistCommentRecord | undefined> {
  const explicit = legacyCommentId(mapping);
  if (explicit) return { id: explicit };
  return client.findLegacyTaskComment(mapping.taskId, mapping.eventId);
}

async function validateMapping(
  profile: Profile,
  projectId: string,
  mapping: Mapping,
  state: ProjectCommentMigrationState,
  clients: ProjectCommentMigrationClients,
  summary: ProjectCommentMigrationSummary,
  allowCompleted = false,
): Promise<{ task: TodoistTask; event: CalendarEvent } | undefined> {
  let task: TodoistTask;
  try {
    task = await clients.todoist.getTask(mapping.taskId);
  } catch (error) {
    if (!providerMissing(error)) throw error;
    summary.missingTasks += 1;
    return undefined;
  }
  // Completed tasks may retain Calendar history but must not be re-indexed as live mappings.
  const taskState = task as TodoistTask & { checked?: boolean; completed_at?: string };
  if (task.is_deleted) {
    summary.deletedTasks += 1;
    return undefined;
  }
  if (task.is_completed || taskState.checked || taskState.completed_at) {
    summary.completedTasks += 1;
    if (!allowCompleted) return undefined;
  }
  if (task.project_id && task.project_id !== projectId) {
    summary.projectMismatches += 1;
    return undefined;
  }

  let event: CalendarEvent;
  try {
    event = await clients.calendar.getEvent(mapping.eventId);
  } catch (error) {
    if (!providerMissing(error)) throw error;
    summary.missingCalendarEvents += 1;
    return undefined;
  }
  if (event.status === "cancelled") {
    summary.missingCalendarEvents += 1;
    return undefined;
  }
  return { task, event };
}

/**
 * Report or progressively backfill one Todoist project's mapping index.
 *
 * Read priority is deliberately project comment -> legacy task comment. Apply
 * mode creates/updates only project comments by default. When cleanupLegacy is
 * enabled, a task comment is eligible for deletion only after an exact project
 * mapping exists and the live task/project, Calendar event, and tombstone checks
 * all pass. Missing project mappings are never created and cleaned in the same
 * pass, making cleanup explicitly two-phase and re-runnable.
 */
export async function migrateProjectComments(
  profile: Profile,
  mappings: Mapping[],
  state: ProjectCommentMigrationState,
  clients: ProjectCommentMigrationClients,
  apply = false,
  cleanupLegacy = false,
  retireLegacyCorrelation = false,
): Promise<ProjectCommentMigrationSummary> {
  const projectId = profiles[profile].todoistProjectId;
  const index = buildProjectMappingIndex(await clients.todoist.listProjectComments(projectId));
  const summary = emptySummary(apply, index);
  const retireVerifiedCorrelation = async (mapping: Mapping, task?: TodoistTask): Promise<void> => {
    const observed = buildProjectMappingIndex(await clients.todoist.listProjectComments(projectId, true));
    const verified = findProjectMappingComment(observed, mapping);
    if (!verified || verified.payload.profile !== profile || verified.payload.projectId !== projectId
      || verified.payload.taskId !== mapping.taskId || verified.payload.eventId !== mapping.eventId) {
      summary.legacyCorrelationRetirementRejected += 1;
      await state.audit(profile, "project_comment_migration_correlation_retirement_rejected", {
        taskId: mapping.taskId, eventId: mapping.eventId,
        reason: "provider_project_comment_readback_mismatch",
      });
      return;
    }
    if (task && (task.is_completed || task.completed_at)) {
      const completedAt = task.completed_at || task.updated_at;
      if (!completedAt || !state.putCompletedCalendarProjection) {
        summary.legacyCorrelationRetirementRejected += 1;
        await state.audit(profile, "project_comment_migration_correlation_retirement_rejected", {
          taskId: mapping.taskId, eventId: mapping.eventId,
          reason: "completed_history_retention_marker_unavailable",
        });
        return;
      }
      await state.putCompletedCalendarProjection({
        profile, taskId: mapping.taskId, eventId: mapping.eventId, completedAt,
        ...(mapping.seriesId ? { seriesId: mapping.seriesId } : {}),
        ...(mapping.masterEventId ? { masterEventId: mapping.masterEventId } : {}),
        ...(mapping.originalStart ? { originalStart: mapping.originalStart } : {}),
      });
    }
    const retired = await state.retireMigratedMappingCorrelation?.(mapping) ?? false;
    if (retired) summary.legacyCorrelationRowsRetired += 1;
    else {
      summary.legacyCorrelationRetirementRejected += 1;
      await state.audit(profile, "project_comment_migration_correlation_retirement_rejected", {
        taskId: mapping.taskId, eventId: mapping.eventId,
        reason: "legacy_rows_changed_or_cross_profile_owner_conflict",
      });
    }
  };
  const rejectCorrelationRetirement = async (mapping: Mapping, reason: string): Promise<void> => {
    summary.legacyCorrelationRetirementRejected += 1;
    await state.audit(profile, "project_comment_migration_correlation_retirement_rejected", {
      taskId: mapping.taskId, eventId: mapping.eventId, reason,
    });
  };

  for (const mapping of mappings) {
    summary.mappingsScanned += 1;
    let releaseWriterLease: () => Promise<void> = async () => {};
    let migrationStage = "mapping_validation";
    try {
      if (mapping.profile !== profile) throw new Error("project-comment migration mapping belongs to another profile");
      if (apply && process.env.ERASURE_PROTOCOL_VERSION === "1") {
        releaseWriterLease = await acquireErasureProtocolLease(profile, "writer", undefined, await getErasureEpoch(profile));
      }
      if (apply) await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
      const exact = exactProjectComments(index, mapping);
      const referenced = mapping.projectCommentId
        ? exact.find((comment) => comment.id === mapping.projectCommentId)
        : undefined;
      if (exact.length > 1 && !referenced) {
        summary.duplicateProjectComments += 1;
        continue;
      }

      const projectEntry = findProjectMappingComment(index, mapping);
      if (projectEntry) {
        summary.existingProjectCommentsReused += 1;
        // A project mapping is sufficient evidence. Never fan out to a task
        // comment GET merely to discover optional migration metadata.
        const explicitLegacyId = legacyCommentId(mapping, projectEntry.comment.id);
        if (explicitLegacyId) summary.legacyTaskCommentsFound += 1;
        const recovered = recoverMappingFromProjectComment(mapping, projectEntry);

        let validatedPair: { task: TodoistTask; event: CalendarEvent } | undefined;
        if (apply) {
          migrationStage = "provider_pair_validation";
          validatedPair = await validateMapping(profile, projectId, recovered, state, clients, summary, true);
          if (!validatedPair) continue;
          migrationStage = "calendar_correlation_write";
          await ensureCalendarCorrelation(profile, recovered, validatedPair.event, clients.calendar);
        }

        let correlationRetirementValidated = false;
        let retirementTask: TodoistTask | undefined;
        if (retireLegacyCorrelation) {
          migrationStage = "provider_pair_validation";
          const valid = validatedPair
            || await validateMapping(profile, projectId, recovered, state, clients, summary, true);
          if (!valid) {
            await rejectCorrelationRetirement(mapping, "provider_pair_not_eligible_for_verified_retirement");
            continue;
          }
          correlationRetirementValidated = true;
          retirementTask = valid.task;
        }

        let cleanupValidated = false;
        let legacyCommentPresent = false;
        if (cleanupLegacy && explicitLegacyId) {
          const pairTaskCompleted = validatedPair?.task.is_completed || validatedPair?.task.completed_at;
          const valid = pairTaskCompleted ? undefined : validatedPair
            || await validateMapping(profile, projectId, recovered, state, clients, summary);
          if (valid) {
            try {
              migrationStage = "legacy_comment_read";
              const legacyComment = await clients.todoist.getComment(explicitLegacyId);
              if (!isOwnedLegacyTaskMappingComment(legacyComment, mapping)) {
                summary.legacyTaskCommentsCleanupRejected += 1;
                if (apply) await state.audit(profile, "project_comment_migration_legacy_cleanup_rejected", {
                  taskId: mapping.taskId,
                  legacyCommentId: explicitLegacyId,
                  reason: "comment_owner_or_mapping_identity_mismatch",
                });
                continue;
              }
              cleanupValidated = true;
              legacyCommentPresent = true;
              summary.legacyTaskCommentsCleanupEligible += 1;
            } catch (error) {
              if (!providerMissing(error)) throw error;
              // Nothing remains to delete; remove the stale reference in apply mode.
              cleanupValidated = true;
              summary.legacyTaskCommentsAlreadyMissing += 1;
            }
          }
        }

        const needsNormalization = (
          mapping.projectCommentId !== projectEntry.comment.id
          || mapping.commentId !== undefined
          || mapping.mappingRevision !== projectEntry.payload.mappingRevision
          || recurrenceStateChanged(mapping, recovered)
          || Boolean(cleanupLegacy && cleanupValidated && mapping.taskCommentId)
        );

        if (apply && cleanupLegacy && cleanupValidated && explicitLegacyId && legacyCommentPresent) {
          try {
            migrationStage = "legacy_comment_delete";
            await clients.todoist.deleteComment(explicitLegacyId);
            summary.legacyTaskCommentsDeleted += 1;
          } catch (error) {
            if (!providerMissing(error)) throw error;
            summary.legacyTaskCommentsAlreadyMissing += 1;
          }
        }

        if (apply && needsNormalization) {
          migrationStage = "project_comment_write";
          const { commentId: _commentId, taskCommentId: _taskCommentId, ...withoutLegacyAliases } = recovered;
          const normalized = nextProjectCommentMapping(
            cleanupLegacy && cleanupValidated
              ? withoutLegacyAliases
              : {
                  ...withoutLegacyAliases,
                  ...(explicitLegacyId ? { taskCommentId: explicitLegacyId } : {}),
                },
            projectId,
            projectEntry.comment.id,
            projectEntry.payload.mappingRevision,
          );
          await upsertProjectMappingComment(clients.todoist, normalized, projectId,
            projectEntry.payload.calendarUrl, index);
          summary.migratedMappings += 1;
        }
        if (apply && retireLegacyCorrelation && correlationRetirementValidated) {
          migrationStage = "correlation_retirement";
          await retireVerifiedCorrelation(mapping, retirementTask);
        }
        continue;
      }

      summary.projectCommentsMissing += 1;
      const legacy = await findLegacyComment(clients.todoist, mapping);
      if (legacy) summary.legacyTaskCommentsFound += 1;
      const valid = await validateMapping(profile, projectId, mapping, state, clients, summary, retireLegacyCorrelation);
      if (!valid) {
        if (retireLegacyCorrelation) await rejectCorrelationRetirement(mapping,
          "provider_pair_not_eligible_for_verified_retirement");
        continue;
      }
      if (!apply) continue;

      migrationStage = "calendar_correlation_write";
      await ensureCalendarCorrelation(profile, mapping, valid.event, clients.calendar);

      migrationStage = "project_comment_write";
      const migrated = await upsertProjectMappingComment(
        clients.todoist,
        {
          ...mapping,
          projectId,
          commentId: undefined,
          ...(legacy ? { taskCommentId: legacy.id } : {}),
        },
        projectId,
        valid.event.htmlLink,
        index,
      );
      summary.projectCommentsCreated += 1;
      summary.migratedMappings += 1;
      if (retireLegacyCorrelation) {
        migrationStage = "correlation_retirement";
        await retireVerifiedCorrelation(mapping, valid.task);
      }
    } catch (error) {
      const providerError = error as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        $metadata?: { httpStatusCode?: unknown };
      };
      const providerCode = typeof providerError.code === "string"
        && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(providerError.code)
        ? providerError.code : undefined;
      const errorName = typeof providerError.name === "string"
        && providerError.name !== "Error"
        && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(providerError.name)
        ? providerError.name : undefined;
      const status = Number(providerError.status || providerError.$metadata?.httpStatusCode
        || (typeof providerError.code === "number" ? providerError.code : undefined));
      summary.failures += 1;
      if (apply) await state.audit(profile, "project_comment_migration_mapping_failed", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        stage: migrationStage,
        providerStatus: Number.isInteger(status) && status > 0 && status <= 599 ? status : undefined,
        code: errorName || providerCode || "ProviderError",
      });
    } finally {
      await releaseWriterLease();
    }
  }

  if (apply) await state.audit(profile, "project_comment_migration_completed", { summary });
  return summary;
}

export async function listMappingsForProjectCommentMigration(profile: Profile): Promise<Mapping[]> {
  if (!tableName) throw new Error("STATE_TABLE_NAME is not configured");
  const result = await pacedScan<Mapping>({
    TableName: tableName,
    FilterExpression: "begins_with(pk, :prefix) AND sk = :map",
    ExpressionAttributeValues: {
      ":prefix": `TASK#${profile}#`,
      ":map": "MAP",
    },
  }, {
    operation: "list_project_comment_migration_mappings",
    profile,
  });
  return result.items;
}

/** Report-only by default. Pass apply=true for the idempotent backfill phase. */
export async function runProjectCommentMigration(
  profile: Profile,
  apply = false,
  cleanupLegacy = false,
  state: ProjectCommentMigrationState = new StateRepository(),
  clientFactory: ProviderClientFactory = defaultProviderClientFactory,
  retireLegacyCorrelation = false,
): Promise<ProjectCommentMigrationSummary> {
  const mappings = await listMappingsForProjectCommentMigration(profile);
  // Project comments are a rate-limited Todoist endpoint. A multi-profile
  // cutover can encounter a 429 after substantial successful work; honor the
  // provider retry_after hint and retry reads in place so the idempotent
  // migration resumes without discarding earlier progress.
  const clients = await clientFactory(profile, MIGRATION_PROVIDER_OPTIONS);
  return migrateProjectComments(profile, mappings, state, clients, apply, cleanupLegacy, retireLegacyCorrelation);
}

export interface AutomaticProjectCommentMigrationResult {
  mode: "automatic-post-deployment";
  status: "completed" | "failed";
  phases: Record<string, Partial<Record<Profile, ProjectCommentMigrationSummary>>>;
}

/** Backfill every profile, then clean verified task-comment fallbacks. A
 * bounded second cleanup pass handles mappings created during the first one.
 * The runner is injectable so ordering and retry behavior stay testable. */
export async function runAutomaticProjectCommentMigration(
  run: (profile: Profile, apply: boolean, cleanupLegacy: boolean, retireLegacyCorrelation?: boolean) => Promise<ProjectCommentMigrationSummary> =
    (profile, apply, cleanupLegacy, retireLegacyCorrelation = false) =>
      runProjectCommentMigration(profile, apply, cleanupLegacy, undefined, undefined, retireLegacyCorrelation),
  selectedProfiles: Profile[] = ["antonio", "home", "work"],
): Promise<AutomaticProjectCommentMigrationResult> {
  const profilesToRun = [...new Set(selectedProfiles)];
  const phases: AutomaticProjectCommentMigrationResult["phases"] = {
    backfill: {}, cleanup: {}, cleanupRetry: {}, correlationRetirement: {},
  };
  for (const profile of profilesToRun)
    phases.backfill[profile] = await run(profile, true, false);
  for (const profile of profilesToRun)
    phases.cleanup[profile] = await run(profile, true, true);
  const retryProfiles = profilesToRun.filter(profile =>
    (phases.cleanup[profile]?.projectCommentsCreated || 0) > 0);
  for (const profile of retryProfiles)
    phases.cleanupRetry[profile] = await run(profile, true, true);
  for (const profile of profilesToRun)
    phases.correlationRetirement[profile] = await run(profile, true, true, true);

  const allSummaries = Object.values(phases).flatMap(phase => Object.values(phase));
  const unresolvedCleanupCreation = retryProfiles.some(profile =>
    (phases.cleanupRetry[profile]?.projectCommentsCreated || 0) > 0);
  const status = allSummaries.some(summary => summary.failures > 0
    || summary.malformedProjectComments > 0 || summary.duplicateProjectComments > 0
    || summary.legacyCorrelationRetirementRejected > 0) || unresolvedCleanupCreation
    ? "failed" : "completed";
  return { mode: "automatic-post-deployment", status, phases };
}
