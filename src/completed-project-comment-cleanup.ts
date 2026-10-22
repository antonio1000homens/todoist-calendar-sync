/**
 * Operator-only retirement of a verified, terminal Todoist project mapping comment.
 *
 * Deliberately separate from the DynamoDB-only scheduled completed-history cleanup:
 * this operation reads Todoist and can delete ONE project comment after approval.
 * It never deletes a Calendar event, task, completion marker or mapping row.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { profiles, todoistToken } from "./config.js";
import { Todoist } from "./providers.js";
import { parseMappingComment, type TodoistCommentRecord } from "./mapping-comments.js";
import { terminalCompletionDecision, type VerifiedTerminalSeries } from "./completed-history-policy.js";
import type { CompletedCalendarProjection, Profile } from "./types.js";

export interface CompletedCommentTarget {
  profile: Profile;
  taskId: string;
  eventId: string;
  commentId: string;
  projectId: string;
}
export type CompletedCommentStatus = "eligible" | "retired" | "too_recent" | "skipped_active" | "skipped_ambiguous";
export interface CompletedCommentReport extends CompletedCommentTarget {
  status: CompletedCommentStatus;
  reason: string;
}
export interface CompletedCommentAdapter {
  get(pk: string, sk?: string): Promise<Record<string, unknown> | undefined>;
  getComment(id: string): Promise<TodoistCommentRecord>;
  /** True only when Todoist confirms a task is absent (404). Other errors abort. */
  taskAbsent(id: string): Promise<boolean>;
  deleteComment(id: string): Promise<void>;
}
const allProfiles: Profile[] = ["home", "antonio", "work"];
const grace = 7 * 24 * 60 * 60 * 1000;
const report = (target: CompletedCommentTarget, status: CompletedCommentStatus, reason: string): CompletedCommentReport =>
  ({ ...target, status, reason });

/** No reads may be skipped on apply: the second inspection narrows provider races. */
async function inspect(target: CompletedCommentTarget, adapter: CompletedCommentAdapter, nowMs: number): Promise<CompletedCommentReport> {
  if (!allProfiles.includes(target.profile) || ![target.taskId,target.eventId,target.commentId,target.projectId].every(x => typeof x === "string" && x.length > 0)) {
    return report(target, "skipped_ambiguous", "Invalid explicit identity or profile");
  }
  const comment = await adapter.getComment(target.commentId);
  const parsed = parseMappingComment(comment);
  if (!parsed || "error" in parsed || comment.id !== target.commentId || comment.project_id !== target.projectId
    || comment.task_id || parsed.payload.profile !== target.profile
    || parsed.payload.projectId !== target.projectId
    || parsed.payload.taskId !== target.taskId || parsed.payload.eventId !== target.eventId) {
    return report(target, "skipped_ambiguous", "Project comment identity, scope or schema is not verified");
  }
  const historical = await adapter.get(`COMPLETED_EVENT#${target.profile}#${target.eventId}`);
  if (!historical || historical.profile !== target.profile
    || historical.taskId !== target.taskId || historical.eventId !== target.eventId
    || !Number.isFinite(Date.parse(String(historical.completedAt || "")))) {
    return report(target, "skipped_ambiguous", "Missing or mismatched immutable event-side completed-history guard");
  }
  const marker = historical as unknown as CompletedCalendarProjection;
  // Strongly read all known mapping copies, including cross-profile task and
  // Calendar identities. An incomplete triplet is still an active owner.
  const eventIds = new Set([target.eventId, marker.masterEventId, parsed.payload.masterEventId,
    parsed.payload.activeInstanceId].filter((id): id is string => Boolean(id)));
  const activeKeys: Array<[string,string]> = [[`TASKOWNER#${target.taskId}`,"MAP"]];
  for (const profile of allProfiles) {
    activeKeys.push([`TASK#${profile}#${target.taskId}`,"MAP"]);
    for (const eventId of eventIds) activeKeys.push([`EVENT#${profile}#${eventId}`,"MAP"]);
  }
  const seriesId = marker.seriesId || parsed.payload.seriesId;
  if (seriesId) for (const profile of allProfiles) activeKeys.push([`RECURRENCE#${profile}#${seriesId}`,"STATE"]);
  for (const [pk,sk] of activeKeys) {
    if (await adapter.get(pk,sk)) return report(target,"skipped_active",`Live ownership at ${pk}`);
  }
  if (!await adapter.taskAbsent(target.taskId)) {
    return report(target,"skipped_active","Todoist still exposes this task; completion or deletion is not independently verified");
  }
  let certificate: VerifiedTerminalSeries | undefined;
  if (marker.recurrenceOwner || parsed.payload.recurrenceOwner) {
    if (!marker.recurrenceOwner || !marker.seriesId
      || marker.recurrenceOwner !== parsed.payload.recurrenceOwner
      || marker.seriesId !== parsed.payload.seriesId
      || marker.masterEventId !== parsed.payload.masterEventId) {
      return report(target,"skipped_ambiguous","Recurring comment and historical projection ownership differ");
    }
    const record = await adapter.get(`COMPLETED_SERIES#${target.profile}#${marker.seriesId}`);
    if (!record) return report(target,"skipped_ambiguous","No immutable terminal-series certificate");
    certificate = record as unknown as VerifiedTerminalSeries;
    if (certificate.profile !== target.profile || certificate.seriesId !== marker.seriesId
      || certificate.recurrenceOwner !== marker.recurrenceOwner
      || certificate.masterEventId !== marker.masterEventId) {
      return report(target,"skipped_ambiguous","Terminal-series certificate does not match the projection");
    }
  } else if (parsed.payload.seriesId || parsed.payload.masterEventId || parsed.payload.activeInstanceId) {
    return report(target,"skipped_ambiguous","Unverified recurrence identifiers remain on the comment");
  }
  const decision = terminalCompletionDecision([marker],nowMs,certificate);
  if (decision === "ambiguous") return report(target,"skipped_ambiguous","Completion or recurrence terminality cannot be proved");
  if (decision === "too_recent") return report(target,"too_recent","Seven full days have not elapsed since terminal completion");
  // Extra minimum-time check: no provider comment is retired before the exact
  // persistent completion instant, even if the series certificate differs.
  if (nowMs - Date.parse(marker.completedAt) < grace) return report(target,"too_recent","Completed-event marker is too recent");
  return report(target,"eligible","Project comment belongs to an absent, terminal completed task with no active ownership");
}

export async function retireCompletedProjectMappingComment(
  target: CompletedCommentTarget, adapter: CompletedCommentAdapter,
  options: { apply?: boolean; nowMs?: number } = {},
): Promise<CompletedCommentReport> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("nowMs must be a finite epoch-millisecond value");
  const first = await inspect(target,adapter,nowMs);
  if (first.status !== "eligible" || options.apply !== true) return first;
  // Re-read the provider payload, immutable completion guard and every ownership
  // row immediately before the irreversible provider-only delete.
  const second = await inspect(target,adapter,nowMs);
  if (second.status !== "eligible") return second;
  await adapter.deleteComment(target.commentId);
  return report(target,"retired","Deleted one verified obsolete Todoist project comment; Calendar history and DynamoDB unchanged");
}

export async function completedProjectCommentAdapter(profile: Profile): Promise<CompletedCommentAdapter> {
  if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required");
  const table = process.env.STATE_TABLE_NAME;
  const todoist = new Todoist(await todoistToken(profile));
  return {
    async get(pk,sk="STATE") {
      const result = await documentClient.send(new GetCommand({
        TableName:table,Key:{pk,sk},ConsistentRead:true,
      }));
      return result.Item;
    },
    getComment: id => todoist.getComment(id),
    async taskAbsent(id) {
      try { await todoist.getTask(id); return false; }
      catch(error) { if (Number((error as {status?:number}).status) === 404) return true; throw error; }
    },
    deleteComment: id => todoist.deleteComment(id),
  };
}

export function completedCommentProjectId(profile: Profile): string {
  return profiles[profile].todoistProjectId;
}
