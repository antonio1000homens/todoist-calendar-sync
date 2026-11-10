// Calendar history is retained for seven FULL days from completion, not
// until the next calendar date. Use one timeline for policy and sync tests,
// independent of the implementation's configured grace period.
export const COMPLETED_AT = "2026-10-01T12:00:00.000Z";
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
export const COMPLETION_BOUNDARY_MS = Date.parse(COMPLETED_AT) + SEVEN_DAYS_MS;

export function atCompletionBoundary(offsetMs = 0) {
  return new Date(COMPLETION_BOUNDARY_MS + offsetMs).toISOString();
}

export function completedProjection(extra = {}) {
  return {
    profile: "home",
    taskId: "task-1",
    eventId: "event-1",
    completedAt: COMPLETED_AT,
    ...extra,
  };
}
