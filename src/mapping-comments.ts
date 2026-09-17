import type { Mapping, Profile } from "./types.js";

export const MAPPING_COMMENT_MARKER = "todoist-calendar-sync:mapping:v1";
export const LEGACY_MAPPING_COMMENT_MARKER = "gcp-app2-sync:mapping:v1";
const ACCEPTED_MAPPING_COMMENT_MARKERS = new Set([MAPPING_COMMENT_MARKER, LEGACY_MAPPING_COMMENT_MARKER]);
const VALID_PROFILES = new Set<Profile>(["home", "antonio", "work"]);

export interface TodoistCommentRecord {
  id: string;
  content?: string;
  project_id?: string;
  task_id?: string;
  posted_at?: string;
}

export interface ProjectMappingCommentPayload {
  schemaVersion: 1;
  profile: Profile;
  projectId: string;
  taskId: string;
  eventId: string;
  calendarUrl?: string;
  recurrenceOwner?: "calendar" | "todoist";
  seriesId?: string;
  masterEventId?: string;
  activeInstanceId?: string;
  originalStart?: string;
  activeEffectiveStart?: string;
  calendarProgressVersion?: 1;
  completedThroughOriginalStart?: string;
  mappingRevision: number;
  updatedAt: string;
}

export interface ParsedMappingComment {
  comment: TodoistCommentRecord;
  payload: ProjectMappingCommentPayload;
}

export interface MalformedMappingComment {
  comment: TodoistCommentRecord;
  error: string;
}

export interface ProjectMappingIndex {
  byTaskId: Map<string, ParsedMappingComment[]>;
  byEventId: Map<string, ParsedMappingComment[]>;
  bySeriesId: Map<string, ParsedMappingComment[]>;
  parsed: ParsedMappingComment[];
  malformed: MalformedMappingComment[];
}

export interface ProjectCommentClient {
  listProjectComments(projectId: string, refresh?: boolean): Promise<TodoistCommentRecord[]>;
  upsertProjectComment(projectId: string, content: string, existingId?: string): Promise<TodoistCommentRecord>;
  findLegacyTaskComment(taskId: string, eventId: string): Promise<TodoistCommentRecord | undefined>;
  deleteComment(commentId: string): Promise<void>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value);
}

export function mappingProjectId(mapping: Mapping, configuredProjectId: string): string {
  return mapping.projectId || configuredProjectId;
}

export function serializeMappingComment(
  mapping: Mapping,
  projectId: string,
  calendarUrl?: string,
  revision = Math.max(1, mapping.mappingRevision || 1),
): string {
  const payload: ProjectMappingCommentPayload = {
    schemaVersion: 1,
    profile: mapping.profile,
    projectId,
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    ...(calendarUrl ? { calendarUrl } : {}),
    ...(mapping.recurrenceOwner ? { recurrenceOwner: mapping.recurrenceOwner } : {}),
    ...(mapping.seriesId ? { seriesId: mapping.seriesId } : {}),
    ...(mapping.masterEventId ? { masterEventId: mapping.masterEventId } : {}),
    ...(mapping.activeInstanceId ? { activeInstanceId: mapping.activeInstanceId } : {}),
    ...(mapping.originalStart ? { originalStart: mapping.originalStart } : {}),
    ...(mapping.activeEffectiveStart ? { activeEffectiveStart: mapping.activeEffectiveStart } : {}),
    ...(mapping.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
    ...(mapping.completedThroughOriginalStart ? { completedThroughOriginalStart: mapping.completedThroughOriginalStart } : {}),
    mappingRevision: revision,
    updatedAt: mapping.updatedAt || new Date().toISOString(),
  };
  return `${MAPPING_COMMENT_MARKER}\n${JSON.stringify(payload)}`;
}

export function parseMappingComment(comment: TodoistCommentRecord): ParsedMappingComment | MalformedMappingComment | undefined {
  const content = String(comment.content || "");
  const [marker, ...payloadLines] = content.split(/\r?\n/);
  if (!ACCEPTED_MAPPING_COMMENT_MARKERS.has(marker)) return undefined;
  try {
    const value = JSON.parse(payloadLines.join("\n")) as Partial<ProjectMappingCommentPayload>;
    if (value.schemaVersion !== 1) throw new Error("unsupported schema version");
    if (!nonEmptyString(value.profile) || !VALID_PROFILES.has(value.profile as Profile)) throw new Error("invalid profile");
    if (!nonEmptyString(value.projectId)) throw new Error("missing projectId");
    if (!nonEmptyString(value.taskId)) throw new Error("missing taskId");
    if (!nonEmptyString(value.eventId)) throw new Error("missing eventId");
    if (!Number.isInteger(value.mappingRevision) || Number(value.mappingRevision) < 1) throw new Error("invalid mappingRevision");
    if (!nonEmptyString(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("invalid updatedAt");
    if (value.recurrenceOwner !== undefined && !["calendar", "todoist"].includes(value.recurrenceOwner)) throw new Error("invalid recurrenceOwner");
    if (value.calendarProgressVersion !== undefined && value.calendarProgressVersion !== 1) throw new Error("invalid calendarProgressVersion");
    for (const field of ["calendarUrl", "seriesId", "masterEventId", "activeInstanceId", "originalStart", "activeEffectiveStart", "completedThroughOriginalStart"] as const) {
      if (!optionalString(value[field])) throw new Error(`invalid ${field}`);
    }
    return { comment, payload: value as ProjectMappingCommentPayload };
  } catch (error) {
    return { comment, error: error instanceof Error ? error.message : String(error) };
  }
}

function addIndex(map: Map<string, ParsedMappingComment[]>, key: string | undefined, parsed: ParsedMappingComment): void {
  if (!key) return;
  const values = map.get(key) || [];
  values.push(parsed);
  map.set(key, values);
}

export function buildProjectMappingIndex(comments: TodoistCommentRecord[]): ProjectMappingIndex {
  const index: ProjectMappingIndex = {
    byTaskId: new Map(),
    byEventId: new Map(),
    bySeriesId: new Map(),
    parsed: [],
    malformed: [],
  };
  for (const comment of comments) {
    const parsed = parseMappingComment(comment);
    if (!parsed) continue;
    if ("error" in parsed) {
      index.malformed.push(parsed);
      continue;
    }
    index.parsed.push(parsed);
    addIndex(index.byTaskId, parsed.payload.taskId, parsed);
    addIndex(index.byEventId, parsed.payload.eventId, parsed);
    addIndex(index.bySeriesId, parsed.payload.seriesId, parsed);
  }
  return index;
}

function newest(left: ParsedMappingComment, right: ParsedMappingComment): number {
  if (left.payload.mappingRevision !== right.payload.mappingRevision) {
    return right.payload.mappingRevision - left.payload.mappingRevision;
  }
  return Date.parse(right.payload.updatedAt) - Date.parse(left.payload.updatedAt);
}

export function findProjectMappingComment(index: ProjectMappingIndex, mapping: Pick<Mapping, "taskId" | "eventId" | "projectCommentId">): ParsedMappingComment | undefined {
  if (mapping.projectCommentId) {
    const referenced = index.parsed.find((entry) => (
      entry.comment.id === mapping.projectCommentId
      && entry.payload.taskId === mapping.taskId
      && entry.payload.eventId === mapping.eventId
    ));
    if (referenced) return referenced;
  }
  const exact = (index.byTaskId.get(mapping.taskId) || [])
    .filter((entry) => entry.payload.eventId === mapping.eventId)
    .sort(newest);
  return exact[0];
}

export function nextProjectCommentMapping(mapping: Mapping, projectId: string, projectCommentId: string, revision: number): Mapping {
  const { commentId, ...withoutLegacyAlias } = mapping;
  const legacyTaskCommentId = mapping.taskCommentId || (commentId && commentId !== projectCommentId ? commentId : undefined);
  return {
    ...withoutLegacyAlias,
    projectId,
    projectCommentId,
    ...(legacyTaskCommentId ? { taskCommentId: legacyTaskCommentId } : {}),
    mappingRevision: revision,
    updatedAt: new Date().toISOString(),
  };
}

export function mappingCommentIds(mapping: Mapping): { project?: string; legacyTask?: string } {
  return {
    project: mapping.projectCommentId,
    legacyTask: mapping.taskCommentId || (mapping.commentId && mapping.commentId !== mapping.projectCommentId ? mapping.commentId : undefined),
  };
}

export async function loadProjectMappingIndex(client: ProjectCommentClient, projectId: string): Promise<ProjectMappingIndex> {
  return buildProjectMappingIndex(await client.listProjectComments(projectId));
}

export async function resolvePreferredMappingComment(
  client: ProjectCommentClient,
  mapping: Mapping,
  projectId: string,
  index?: ProjectMappingIndex,
): Promise<{ source: "project" | "legacy_task"; comment: TodoistCommentRecord; parsed?: ParsedMappingComment } | undefined> {
  const projectIndex = index || await loadProjectMappingIndex(client, projectId);
  const projectComment = findProjectMappingComment(projectIndex, mapping);
  if (projectComment) return { source: "project", comment: projectComment.comment, parsed: projectComment };

  const legacyId = mapping.taskCommentId || (mapping.commentId && mapping.commentId !== mapping.projectCommentId ? mapping.commentId : undefined);
  if (legacyId) return { source: "legacy_task", comment: { id: legacyId } };
  const legacy = await client.findLegacyTaskComment(mapping.taskId, mapping.eventId);
  return legacy ? { source: "legacy_task", comment: legacy } : undefined;
}

export async function upsertProjectMappingComment(
  client: ProjectCommentClient,
  mapping: Mapping,
  projectId: string,
  calendarUrl?: string,
  index?: ProjectMappingIndex,
): Promise<Mapping> {
  const projectIndex = index || await loadProjectMappingIndex(client, projectId);
  const existing = findProjectMappingComment(projectIndex, mapping);
  const revision = Math.max(mapping.mappingRevision || 0, existing?.payload.mappingRevision || 0) + 1;
  const draft: Mapping = { ...mapping, projectId, mappingRevision: revision, updatedAt: new Date().toISOString() };
  const comment = await client.upsertProjectComment(projectId, serializeMappingComment(draft, projectId, calendarUrl, revision), existing?.comment.id);
  const migrated = nextProjectCommentMapping(draft, projectId, comment.id, revision);

  const parsed = parseMappingComment({ ...comment, content: serializeMappingComment(migrated, projectId, calendarUrl, revision) });
  if (parsed && !("error" in parsed)) {
    projectIndex.parsed = projectIndex.parsed.filter((entry) => entry.comment.id !== comment.id);
    for (const values of [projectIndex.byTaskId, projectIndex.byEventId, projectIndex.bySeriesId]) {
      for (const [key, entries] of values.entries()) {
        values.set(key, entries.filter((entry) => entry.comment.id !== comment.id));
      }
    }
    projectIndex.parsed.push(parsed);
    addIndex(projectIndex.byTaskId, parsed.payload.taskId, parsed);
    addIndex(projectIndex.byEventId, parsed.payload.eventId, parsed);
    addIndex(projectIndex.bySeriesId, parsed.payload.seriesId, parsed);
  }
  return migrated;
}

export async function deleteMappingComments(client: ProjectCommentClient, mapping: Mapping): Promise<void> {
  const ids = mappingCommentIds(mapping);
  if (ids.project) await client.deleteComment(ids.project).catch(() => undefined);
  if (ids.legacyTask && ids.legacyTask !== ids.project) await client.deleteComment(ids.legacyTask).catch(() => undefined);
}
