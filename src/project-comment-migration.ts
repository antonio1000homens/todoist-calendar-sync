import { pacedScan } from "./dynamodb-capacity.js";
import { profiles } from "./config.js";
import {
  buildProjectMappingIndex,
  findProjectMappingComment,
  nextProjectCommentMapping,
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

function legacyCommentId(mapping: Mapping): string | undefined {
  return mapping.taskCommentId || (mapping.commentId && mapping.commentId !== mapping.projectCommentId ? mapping.commentId : undefined);
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
 * mode creates/updates only project comments; it never writes or deletes a
 * task comment. Re-running apply is idempotent because an existing exact v1
 * project mapping is reused and only the DynamoDB shape is normalised.
 */
export async function migrateProjectComments(
  profile: Profile,
  mappings: Mapping[],
  state: ProjectCommentMigrationState,
  clients: ProjectCommentMigrationClients,
  apply = false,
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
        const explicitLegacyId = legacyCommentId(mapping);
        if (explicitLegacyId) summary.legacyTaskCommentsFound += 1;
        if (apply && (
          mapping.projectCommentId !== projectEntry.comment.id
          || mapping.commentId !== undefined
          || mapping.mappingRevision !== projectEntry.payload.mappingRevision
        )) {
          const normalized = nextProjectCommentMapping(
            {
              ...mapping,
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
  state: ProjectCommentMigrationState = new StateRepository(),
  clientFactory: ProviderClientFactory = defaultProviderClientFactory,
): Promise<ProjectCommentMigrationSummary> {
  const mappings = await listMappingsForProjectCommentMigration(profile);
  const clients = await clientFactory(profile);
  return migrateProjectComments(profile, mappings, state, clients, apply);
}
