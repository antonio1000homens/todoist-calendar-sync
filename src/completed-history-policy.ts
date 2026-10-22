import type { CompletedCalendarProjection } from "./types.js";

export const COMPLETED_TASK_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** A historical occurrence is not evidence that its recurring SERIES ended. */
export function terminalCompletionDecision(
  projections: CompletedCalendarProjection[],
  nowMs = Date.now(),
): "eligible" | "too_recent" | "ambiguous" {
  if (!projections.length || !Number.isFinite(nowMs)) return "ambiguous";
  const first = projections[0];
  if (!first || !["home", "antonio", "work"].includes(first.profile) || !first.taskId) return "ambiguous";
  if (projections.some((p) => p.profile !== first.profile || p.taskId !== first.taskId
    || !p.eventId || typeof p.completedAt !== "string"
    || !Number.isFinite(Date.parse(p.completedAt))
    || Date.parse(p.completedAt) > nowMs)) return "ambiguous";
  const newest = projections.reduce((a, b) =>
    Date.parse(a.completedAt) >= Date.parse(b.completedAt) ? a : b);
  // A rolling / RRULE occurrence has *not* ended the series. Only an explicit
  // terminal verification made at provider completion can qualify a recurrence.
  if (projections.some((p) => p.recurrenceOwner)) {
    if (newest.terminalVerified !== true || !newest.recurrenceOwner) return "ambiguous";
    if (projections.some((p) => p.recurrenceOwner !== newest.recurrenceOwner
      || p.seriesId !== newest.seriesId)) return "ambiguous";
  }
  return nowMs - Date.parse(newest.completedAt) >= COMPLETED_TASK_GRACE_MS
    ? "eligible" : "too_recent";
}

/** Delayed Todoist plan cleanup is not permission to erase completed Calendar history.
 * A task without a live mapping but with historical projections should be
 * treated as completed history after the grace, even if terminality is ambiguous.
 */
export function protectUnmappedCompletedHistory(
  projections: CompletedCalendarProjection[],
  nowMs = Date.now(),
): boolean {
  return projections.some((p) => Number.isFinite(Date.parse(p.completedAt))
    && nowMs - Date.parse(p.completedAt) >= COMPLETED_TASK_GRACE_MS);
}
