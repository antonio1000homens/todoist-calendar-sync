import type { Mapping, Profile } from "./types.js";

export const MAPPING_COMMENT_MARKER = "todoist-calendar-sync:mapping:v1";
/** Short-lived post-erasure marker kept beside the deleted task's project mapping. */
export const DELETION_TOMBSTONE_COMMENT_MARKER = "todoist-calendar-sync:deleted:v1";
/** Cover the four-day FIFO source queue plus its 14-day FIFO DLQ retention. */
export const PROJECT_DELETION_TOMBSTONE_RETENTION_MS = 18 * 24 * 60 * 60 * 1000;
export const LEGACY_MAPPING_COMMENT_MARKER = "gcp-app2-sync:mapping:v1";
/** Historical task-comment identities are accepted only for migration/cleanup. */
export const LEGACY_TASK_COMMENT_MARKERS = new Set<string>(["gcp-app2-sync", "todoist-calendar-sync"]);
const ACCEPTED_MAPPING_COMMENT_MARKERS = new Set([MAPPING_COMMENT_MARKER, LEGACY_MAPPING_COMMENT_MARKER]);
const VALID_PROFILES = new Set<Profile>(["home", "antonio", "work"]);

export interface TodoistCommentRecord {
  id: string;
  content?: string;
  project_id?: string;
  task_id?: string;
  is_deleted?: boolean;
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

export interface ProjectDeletionTombstonePayload {
  schemaVersion: 1;
  profile: Profile;
  projectId: string;
  taskId: string;
  eventIds: string[];
  createdAt: string;
  expiresAt: string;
}

export function projectDeletionTombstoneExpiry(createdAt: string): string {
  const milliseconds = Date.parse(createdAt);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== createdAt)
    throw new Error("Invalid project deletion tombstone timestamp");
  return new Date(milliseconds + PROJECT_DELETION_TOMBSTONE_RETENTION_MS).toISOString();
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
  updateComment(commentId: string, content: string): Promise<TodoistCommentRecord>;
  findLegacyTaskComment(taskId: string, eventId: string): Promise<TodoistCommentRecord | undefined>;
  deleteComment(commentId: string): Promise<void>;
  getComment(commentId: string): Promise<TodoistCommentRecord>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value);
}

function laterLogicalStart(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime > leftTime ? right : left;
  return right.localeCompare(left) > 0 ? right : left;
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

export function serializeDeletionTombstoneComment(input: ProjectDeletionTombstonePayload): string {
  const parsed = parseDeletionTombstoneComment({ id: "candidate", content: `${DELETION_TOMBSTONE_COMMENT_MARKER}\n${JSON.stringify(input)}` });
  if (!parsed) throw new Error("Invalid project deletion tombstone");
  return `${DELETION_TOMBSTONE_COMMENT_MARKER}\n${JSON.stringify({
    ...input,
    eventIds: [...new Set(input.eventIds)].sort(),
  })}`;
}

export function parseDeletionTombstoneComment(comment: TodoistCommentRecord): ProjectDeletionTombstonePayload | undefined {
  const [marker, ...payloadLines] = String(comment.content || "").split(/\r?\n/);
  if (marker !== DELETION_TOMBSTONE_COMMENT_MARKER) return undefined;
  try {
    const value = JSON.parse(payloadLines.join("\n")) as Partial<ProjectDeletionTombstonePayload>;
    const validIso = (date: unknown): date is string => typeof date === "string"
      && Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date;
    if (value.schemaVersion !== 1 || !VALID_PROFILES.has(value.profile as Profile)
      || !nonEmptyString(value.projectId) || !nonEmptyString(value.taskId)
      || !Array.isArray(value.eventIds) || value.eventIds.length > 32
      || value.eventIds.some(id => !nonEmptyString(id))
      || new Set(value.eventIds).size !== value.eventIds.length
      || !validIso(value.createdAt) || !validIso(value.expiresAt)
      || Date.parse(value.expiresAt) !== Date.parse(value.createdAt) + PROJECT_DELETION_TOMBSTONE_RETENTION_MS) return undefined;
    return { schemaVersion: 1, profile: value.profile as Profile, projectId: value.projectId,
      taskId: value.taskId, eventIds: value.eventIds as string[], createdAt: value.createdAt,
      expiresAt: value.expiresAt };
  } catch { return undefined; }
}

export function activeProjectDeletionTombstone(
  comments: TodoistCommentRecord[], input: { profile: Profile; projectId: string; taskId?: string; eventIds?: string[] }, now = Date.now(),
): ProjectDeletionTombstonePayload | undefined {
  const events = new Set(input.eventIds || []);
  return comments.map(parseDeletionTombstoneComment).find(value => Boolean(value
    && value.profile === input.profile && value.projectId === input.projectId
    && Date.parse(value.expiresAt) > now
    && ((!input.taskId || value.taskId === input.taskId)
      || [...events].some(id => value!.eventIds.includes(id))))) as ProjectDeletionTombstonePayload | undefined;
}

export function projectDeletionTombstoneExpired(comment: TodoistCommentRecord, now = Date.now()): boolean {
  const value = parseDeletionTombstoneComment(comment);
  return Boolean(value && Date.parse(value.expiresAt) <= now);
}

export async function cleanupExpiredProjectDeletionTombstones(
  client: ProjectCommentClient, profile: Profile, projectId: string,
  options: { apply?: boolean; now?: number } = {},
): Promise<{ eligible: number; deleted: number; skippedChanged: number }> {
  const now = options.now ?? Date.now();
  const comments = await client.listProjectComments(projectId, true);
  const candidates = comments.filter(comment => {
    const value = parseDeletionTombstoneComment(comment);
    return value?.profile === profile && value.projectId === projectId
      && comment.project_id === projectId && !comment.task_id
      && Date.parse(value.expiresAt) <= now;
  });
  let deleted = 0, skippedChanged = 0;
  if (options.apply) for (const candidate of candidates) {
    const expected = parseDeletionTombstoneComment(candidate)!;
    let current: TodoistCommentRecord;
    try { current = await client.getComment(candidate.id); }
    catch (error) {
      if (Number((error as { status?: number }).status) === 404) { skippedChanged++; continue; }
      throw error;
    }
    const fresh = parseDeletionTombstoneComment(current);
    if (!fresh || current.id !== candidate.id || current.project_id !== projectId || current.task_id
      || fresh.profile !== profile || fresh.projectId !== projectId || fresh.taskId !== expected.taskId
      || fresh.createdAt !== expected.createdAt || fresh.expiresAt !== expected.expiresAt
      || JSON.stringify(fresh.eventIds) !== JSON.stringify(expected.eventIds)
      || Date.parse(fresh.expiresAt) > now) { skippedChanged++; continue; }
    await client.deleteComment(current.id);
    try {
      const remaining = await client.getComment(current.id);
      if (remaining.id === current.id) throw new Error("Expired project deletion tombstone remains after deletion readback");
      skippedChanged++;
    } catch (error) {
      if (Number((error as { status?: number }).status) === 404) deleted++;
      else throw error;
    }
  }
  return { eligible: candidates.length, deleted, skippedChanged };
}

/** Replace the exact operation-owned mapping comment and require a provider readback. */
export async function writeProjectDeletionTombstone(
  client: ProjectCommentClient,
  input: { commentId: string; profile: Profile; projectId: string; taskId: string;
    eventIds?: string[]; createdAt?: string },
): Promise<TodoistCommentRecord> {
  if (!nonEmptyString(input.commentId) || !nonEmptyString(input.projectId)
    || !nonEmptyString(input.taskId))
    throw new Error("Project deletion tombstone identity is incomplete");
  const current = await client.getComment(input.commentId);
  if (current.id !== input.commentId || current.project_id !== input.projectId || current.task_id)
    throw new Error("Project deletion comment ownership does not match the confirmed operation");
  const oldTombstone = parseDeletionTombstoneComment(current);
  const eventIds = [...new Set(input.eventIds || [])].sort();
  if (oldTombstone) {
    if (oldTombstone.profile !== input.profile || oldTombstone.projectId !== input.projectId
      || oldTombstone.taskId !== input.taskId || eventIds.some(id => !oldTombstone.eventIds.includes(id)))
      throw new Error("Existing project deletion tombstone does not match the confirmed identity");
    return current;
  }
  const mapping = parseMappingComment(current);
  if (!mapping || "error" in mapping || mapping.payload.profile !== input.profile
    || mapping.payload.projectId !== input.projectId || mapping.payload.taskId !== input.taskId
    || (eventIds.length > 0 && !eventIds.includes(mapping.payload.eventId)))
    throw new Error("Project mapping comment does not match the confirmed deletion identity");
  const tombstoneEventIds = [...new Set([...eventIds, mapping.payload.eventId])].sort();
  if (tombstoneEventIds.length > 32) throw new Error("Project deletion tombstone exceeds the alias limit");
  const createdAt = input.createdAt || new Date().toISOString();
  const payload: ProjectDeletionTombstonePayload = {
    schemaVersion: 1, profile: input.profile, projectId: input.projectId, taskId: input.taskId,
    eventIds: tombstoneEventIds, createdAt, expiresAt: projectDeletionTombstoneExpiry(createdAt),
  };
  // Updating this exact comment is required. `upsertProjectComment` may create
  // a second comment when the target cannot be edited, leaving the old mapping
  // (and its deleted task identity) behind.
  await client.updateComment(input.commentId, serializeDeletionTombstoneComment(payload));
  const readback = await client.getComment(input.commentId);
  const verified = parseDeletionTombstoneComment(readback);
  if (readback.id !== input.commentId || readback.project_id !== input.projectId || readback.task_id
    || !verified || verified.profile !== input.profile || verified.projectId !== input.projectId
    || verified.taskId !== input.taskId || verified.createdAt !== createdAt
    || verified.expiresAt !== payload.expiresAt
    || tombstoneEventIds.some(id => !verified.eventIds.includes(id)))
    throw new Error("Project deletion tombstone was not verified after write");
  return readback;
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

/**
 * Recover recurrence metadata from an exact project-comment breadcrumb without
 * allowing an older comment to roll a live mapping backwards. Existing mapping
 * values win, except the completion watermark is merged monotonically.
 */
export function recoverMappingFromProjectComment(mapping: Mapping, parsed: ParsedMappingComment): Mapping {
  const payload = parsed.payload;
  if (payload.profile !== mapping.profile || payload.taskId !== mapping.taskId || payload.eventId !== mapping.eventId) {
    throw new Error("project mapping comment identity does not match mapping");
  }
  const recurrenceOwner = mapping.recurrenceOwner || payload.recurrenceOwner;
  const completedThroughOriginalStart = recurrenceOwner === "calendar"
    ? laterLogicalStart(mapping.completedThroughOriginalStart, payload.completedThroughOriginalStart)
    : undefined;
  return {
    ...mapping,
    ...(recurrenceOwner ? { recurrenceOwner } : {}),
    ...(mapping.seriesId || payload.seriesId ? { seriesId: mapping.seriesId || payload.seriesId } : {}),
    ...(mapping.masterEventId || payload.masterEventId ? { masterEventId: mapping.masterEventId || payload.masterEventId } : {}),
    ...(mapping.activeInstanceId || payload.activeInstanceId ? { activeInstanceId: mapping.activeInstanceId || payload.activeInstanceId } : {}),
    ...(mapping.originalStart || payload.originalStart ? { originalStart: mapping.originalStart || payload.originalStart } : {}),
    ...(mapping.activeEffectiveStart || payload.activeEffectiveStart ? { activeEffectiveStart: mapping.activeEffectiveStart || payload.activeEffectiveStart } : {}),
    ...(recurrenceOwner === "calendar" && (mapping.calendarProgressVersion === 1 || payload.calendarProgressVersion === 1)
      ? { calendarProgressVersion: 1 as const }
      : {}),
    ...(completedThroughOriginalStart ? { completedThroughOriginalStart } : {}),
  };
}

export function attachProjectCommentReference(mapping: Mapping, projectId: string, projectCommentId: string): Mapping {
  const { commentId, ...withoutLegacyAlias } = mapping;
  const legacyTaskCommentId = mapping.taskCommentId || (commentId && commentId !== projectCommentId ? commentId : undefined);
  return {
    ...withoutLegacyAlias,
    projectId,
    projectCommentId,
    ...(legacyTaskCommentId ? { taskCommentId: legacyTaskCommentId } : {}),
  };
}

export function nextProjectCommentMapping(mapping: Mapping, projectId: string, projectCommentId: string, revision: number): Mapping {
  return {
    ...attachProjectCommentReference(mapping, projectId, projectCommentId),
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

export function isOwnedLegacyTaskMappingComment(comment: TodoistCommentRecord, mapping: Mapping): boolean {
  const lines = String(comment.content || "").split(/\r?\n/);
  return comment.task_id === mapping.taskId
    && LEGACY_TASK_COMMENT_MARKERS.has(lines[0])
    && lines.includes(`calendarEventId=${mapping.eventId}`);
}

/** Delete only comments whose provider payload proves they belong to this mapping. */
export async function deleteMappingComments(client: ProjectCommentClient, mapping: Mapping): Promise<number> {
  let deleted = 0;
  const ids = mappingCommentIds(mapping);
  if (ids.project) {
    try {
      const comment = await client.getComment(ids.project);
      const parsed = parseMappingComment(comment);
      if (parsed && !("error" in parsed)
        && parsed.payload.profile === mapping.profile
        && parsed.payload.taskId === mapping.taskId
        && parsed.payload.eventId === mapping.eventId) {
        await client.deleteComment(ids.project);
        deleted += 1;
      }
    } catch { /* Missing or inaccessible provider comments must not break mapping deletion. */ }
  }
  if (ids.legacyTask && ids.legacyTask !== ids.project) {
    try {
      const comment = await client.getComment(ids.legacyTask);
      if (isOwnedLegacyTaskMappingComment(comment, mapping)) { await client.deleteComment(ids.legacyTask); deleted += 1; }
    } catch { /* Preserve legacy best-effort deletion semantics. */ }
  }
  return deleted;
}

/** Delete every exact app-owned project mapping for a task, and require provider confirmation. */
export async function deleteExactTaskProjectMappingComments(
  client: ProjectCommentClient,
  comments: TodoistCommentRecord[],
  identity: { profile: Profile; projectId: string; taskId: string },
): Promise<number> {
  const candidates = comments.flatMap(comment => {
    const parsed = parseMappingComment(comment);
    return parsed && !("error" in parsed)
      && comment.project_id === identity.projectId && !comment.task_id
      && parsed.payload.profile === identity.profile
      && parsed.payload.projectId === identity.projectId
      && parsed.payload.taskId === identity.taskId
      ? [{comment, payload: parsed.payload}] : [];
  });
  let deleted = 0;
  for (const {comment: candidate, payload} of candidates) {
    let current: TodoistCommentRecord;
    try { current = await client.getComment(candidate.id); }
    catch (error) {
      if (Number((error as { status?: number }).status) === 404) continue;
      throw error;
    }
    const parsed = parseMappingComment(current);
    if (!parsed || "error" in parsed || current.id !== candidate.id
      || current.project_id !== identity.projectId || current.task_id
      || parsed.payload.profile !== identity.profile
      || parsed.payload.projectId !== identity.projectId
      || parsed.payload.taskId !== identity.taskId
      || parsed.payload.eventId !== payload.eventId) {
      throw new Error(`Todoist project mapping comment ${candidate.id} changed before task deletion cleanup`);
    }
    await client.deleteComment(current.id);
    try {
      await client.getComment(current.id);
      throw new Error(`Todoist project mapping comment ${current.id} remains after deletion`);
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 404) throw error;
      deleted++;
    }
  }
  return deleted;
}
