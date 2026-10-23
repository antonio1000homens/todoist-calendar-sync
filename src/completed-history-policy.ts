import type { CompletedCalendarProjection } from "./types.js";

export const COMPLETED_TASK_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface VerifiedTerminalSeries {
  profile: string;
  seriesId: string;
  recurrenceOwner: "calendar" | "todoist";
  terminalCompletedAt: string;
  masterEventId?: string;
}

/** A historical occurrence is not evidence that its recurring SERIES ended. */
export function terminalCompletionDecision(
  projections: CompletedCalendarProjection[],
  nowMs = Date.now(),
  terminalSeries?: VerifiedTerminalSeries,
): "eligible" | "too_recent" | "ambiguous" {
  if (!projections.length || !Number.isFinite(nowMs)) return "ambiguous";
  const first = projections[0];
  if (!first || !["home", "antonio", "work"].includes(first.profile) || !first.taskId) return "ambiguous";
  if (projections.some((p) => p.profile !== first.profile || p.taskId !== first.taskId
    || !p.eventId || typeof p.completedAt !== "string"
    || !Number.isFinite(Date.parse(p.completedAt))
    || Date.parse(p.completedAt) > nowMs)) return "ambiguous";
  // This is persisted input, so do not rely on the TypeScript union or
  // truthiness. Unknown owners and empty-but-present recurrence identifiers
  // are malformed/partial state, not proof of a standalone task.
  const recurrenceOwners = new Set(["calendar", "todoist"]);
  const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
  for (const p of projections) {
    const ownerPresent = hasOwn(p, "recurrenceOwner");
    const terminalBitPresent = hasOwn(p, "terminalVerified");
    if (ownerPresent && !recurrenceOwners.has(p.recurrenceOwner as string)) return "ambiguous";
    if (terminalBitPresent && p.terminalVerified !== true) return "ambiguous";
    const hasRecurrenceIdentity = ["seriesId", "masterEventId", "originalStart"]
      .some((field) => hasOwn(p, field));
    if (!ownerPresent && (hasRecurrenceIdentity || terminalBitPresent)) return "ambiguous";
    if (p.recurrenceOwner && (typeof p.seriesId !== "string" || !p.seriesId.trim())) return "ambiguous";
    for (const field of ["seriesId", "masterEventId", "originalStart"] as const) {
      if (hasOwn(p, field)) {
        const value = p[field];
        if (typeof value !== "string" || !value.trim()) return "ambiguous";
      }
    }
  }
  const newest = projections.reduce((a, b) =>
    Date.parse(a.completedAt) >= Date.parse(b.completedAt) ? a : b);
  // A rolling / RRULE occurrence has *not* ended the series. Only an explicit
  // terminal verification made at provider completion can qualify a recurrence.
  let finalAt = Date.parse(newest.completedAt);
  if (projections.some((p) => p.recurrenceOwner)) {
    const confirmedByOccurrence = newest.terminalVerified === true && Boolean(newest.recurrenceOwner);
    const confirmedBySeries = terminalSeries?.profile === first.profile
      && terminalSeries.seriesId === newest.seriesId
      && terminalSeries.recurrenceOwner === newest.recurrenceOwner
      && Number.isFinite(Date.parse(terminalSeries.terminalCompletedAt))
      && Date.parse(terminalSeries.terminalCompletedAt) >= finalAt
      && Date.parse(terminalSeries.terminalCompletedAt) <= nowMs
      && projections.every((p) => p.masterEventId === terminalSeries.masterEventId);
    if (!confirmedByOccurrence && !confirmedBySeries) return "ambiguous";
    if (projections.some((p) => p.recurrenceOwner !== newest.recurrenceOwner
      || p.seriesId !== newest.seriesId)) return "ambiguous";
    if (confirmedBySeries) finalAt = Date.parse(terminalSeries.terminalCompletedAt);
  }
  return nowMs - finalAt >= COMPLETED_TASK_GRACE_MS
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
