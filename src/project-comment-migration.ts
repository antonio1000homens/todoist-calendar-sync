import { pacedScan } from "./dynamodb-capacity.js";
import { profiles } from "./config.js";
import {
  buildProjectMappingIndex,
  findProjectMappingComment,
  nextProjectCommentMapping,
  recoverMappingFromProjectComment,
  upsertProjectMappingComment,
  type ProjectCommentClient,
  type ProjectMappingIndex,
  type TodoistCommentRecord,
} from "./mapping-comments.js";
import { defaultProviderClientFactory, type ProviderClientFactory } from "./mutation-budget.js";
import { StateRepository, type CalendarProjectionTombstone } from "./repository.js";
import type { CalendarEvent, Mapping, Profile, TodoistTask } from "./types.js";

const tableName = process.env.STATE_TABLE_NAME || "";

export interface ProjectCommentMigrationState {
  putMapping(mapping: Mapping): Promise<void>;
  getCalendarProjectionTombstone(profile: Profile, taskId: string): Promise<CalendarProjectionTombstone | undefined>;
  audit(profile: Profile, action: string, detail: Record<string, unknown>): Promise<void>;
}

export interface ProjectCommentMigrationClients {
  todoist: ProjectCommentClient & {
    getTask(taskId: string): Promise<TodoistTask>;
  };
  calendar: {
    getEvent(eventId: string): Promise<CalendarEvent>;
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
  missingCalendarEvents: number;
  tombstonedMappings: number;
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
    missingCalendarEvents: 0,
    tombstonedMappings: 0,
    projectMismatches: 0,
    duplicateProjectComments: 0,
    failures: 0,
  };
}

function providerMissing(error: unknown): boolean {
  return [404, 410].includes(Number((error as { status?: number }).status));
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

/** Never trust a stored legacy ID without verifying the actual Todoist comment. */
function isOwnedLegacyTaskMappingComment(comment: TodoistCommentRecord, mapping: Mapping): boolean {
  const lines = String(comment.content || "").split(/\r?\n/);
  return comment.task_id === mapping.taskId
    && ["gcp-app2-sync", "todoist-calendar-sync"].includes(lines[0])
    && lines.includes(`calendarEventId=${mapping.eventId}`);
}

async function validateMapping(
  profile: Profile,
  projectId: string,
  mapping: Mapping,
  state: ProjectCommentMigrationState,
  clients: ProjectCommentMigrationClients,
  summary: ProjectCommentMigrationSummary,
): Promise<{ task: TodoistTask; event: CalendarEvent } | undefined> {
  if (await state.getCalendarProjectionTombstone(profile, mapping.taskId)) {
    summary.tombstonedMappings += 1;
    return undefined;
  }

  let task: TodoistTask;
  try {
    task = await clients.todoist.getTask(mapping.taskId);
  } catch (error) {
    if (!providerMissing(error)) throw error;
    summary.missingTasks += 1;
    return undefined;
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
): Promise<ProjectCommentMigrationSummary> {
  const projectId = profiles[profile].todoistProjectId;
  const index = buildProjectMappingIndex(await clients.todoist.listProjectComments(projectId));
  const summary = emptySummary(apply, index);

  for (const mapping of mappings) {
    summary.mappingsScanned += 1;
    try {
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

        let cleanupValidated = false;
        let legacyCommentPresent = false;
        if (cleanupLegacy && explicitLegacyId) {
          const valid = await validateMapping(profile, projectId, mapping, state, clients, summary);
          if (valid) {
            try {
              const legacyComment = await clients.todoist.getComment(explicitLegacyId);
              if (!isOwnedLegacyTaskMappingComment(legacyComment, mapping)) {
                summary.legacyTaskCommentsCleanupRejected += 1;
                await state.audit(profile, "project_comment_migration_legacy_cleanup_rejected", {
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
            await clients.todoist.deleteComment(explicitLegacyId);
            summary.legacyTaskCommentsDeleted += 1;
          } catch (error) {
            if (!providerMissing(error)) throw error;
            summary.legacyTaskCommentsAlreadyMissing += 1;
          }
        }

        if (apply && needsNormalization) {
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
          await state.putMapping(normalized);
          summary.migratedMappings += 1;
        }
        continue;
      }

      summary.projectCommentsMissing += 1;
      const legacy = await findLegacyComment(clients.todoist, mapping);
      if (legacy) summary.legacyTaskCommentsFound += 1;
      const valid = await validateMapping(profile, projectId, mapping, state, clients, summary);
      if (!valid || !apply) continue;

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
      await state.putMapping(migrated);
      summary.projectCommentsCreated += 1;
      summary.migratedMappings += 1;
    } catch (error) {
      summary.failures += 1;
      await state.audit(profile, "project_comment_migration_mapping_failed", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await state.audit(profile, "project_comment_migration_completed", { summary });
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
): Promise<ProjectCommentMigrationSummary> {
  const mappings = await listMappingsForProjectCommentMigration(profile);
  const clients = await clientFactory(profile);
  return migrateProjectComments(profile, mappings, state, clients, apply, cleanupLegacy);
}
