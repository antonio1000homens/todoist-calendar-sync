export const AUDIT_RETENTION_DAYS = 7;

export type AuditDisposition = "routine" | "significant";

// These categories are deliberately conservative. Unknown action names are
// retained until they have been reviewed, so adding a new safety event cannot
// silently turn it into logs-only telemetry.
const SIGNIFICANT_ACTION_RE = /(?:ambiguous|conflict|blocked|suppressed|stale|failed|failure|orphan|missing|unbound|deferred|circuit_open|mutation_budget_exhausted|tombstone|no_next|deleted|delete|removed|due_removed)/;

const SIGNIFICANT_EXACT_ACTIONS = new Set([
  "calendar_snapshot_imported_task",
  "calendar_snapshot_rebound_mapping",
  "calendar_snapshot_imported_recurring_task",
  "calendar_snapshot_rebound_recurring_mapping",
  "todoist_project_projection_reset",
  "manual_decision_requested",
  "manual_action_deferred_safety",
  "manual_detector_disabled",
  "manual_detector_observed_no_mutation",
  "orphan_recheck_recovered",
  "orphan_recheck_task_moved_project",
  "orphan_confirmed_deleted",
]);

const ROUTINE_EXACT_ACTIONS = new Set([
  "todoist_snapshot_reconcile_baseline_established",
]);

const REVIEWED_ROUTINE_ACTION_RE = /(?:^|_)(?:started|completed|queued|requested|coalesced|processed|reconciled|baselined|converged|created|updated|moved|written_back|rejoined|noop)(?:$|_)/;

export function classifyAuditAction(action: string): AuditDisposition {
  if (ROUTINE_EXACT_ACTIONS.has(action)) return "routine";
  if (SIGNIFICANT_EXACT_ACTIONS.has(action) || SIGNIFICANT_ACTION_RE.test(action)) return "significant";
  if (REVIEWED_ROUTINE_ACTION_RE.test(action)) return "routine";
  // Retain new/unreviewed events until their storage classification is explicit.
  return "significant";
}

export function auditExpiresAt(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + AUDIT_RETENTION_DAYS * 24 * 60 * 60;
}


/** Only these recurring snapshot conflicts are collapsed while the same
 * provider state remains unresolved. Their CloudWatch observations are never deduplicated. */
const DEDUPED_CONFLICT_ACTIONS = new Set([
  "todoist_snapshot_reconcile_unmapped_conflict",
  "todoist_snapshot_reconcile_unmapped_ambiguous",
  "todoist_snapshot_reconcile_cancelled_projection_blocked",
  "calendar_snapshot_recurring_identity_conflict",
  "calendar_task_link_ambiguous_conflict",
]);

export function retainedConflictEntity(detail: Record<string, unknown>): string | undefined {
  for (const field of ["taskId", "eventId", "seriesId"] as const) {
    const value = detail[field];
    if (typeof value === "string" && value.length > 0 && value.length <= 10_000) return `${field}:${value}`;
  }
  return undefined;
}

export function retainedConflictIdentity(action: string, detail: Record<string, unknown>): string | undefined {
  if (!DEDUPED_CONFLICT_ACTIONS.has(action) || !retainedConflictEntity(detail)) return undefined;
  const ids = (field: string): string[] => Array.isArray(detail[field])
    ? [...new Set((detail[field] as unknown[]).filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 10_000 && /^[A-Za-z0-9_.-]+$/.test(value)))].sort()
    : [];
  const categories = Array.isArray(detail.mismatchCategories)
    ? [...new Set((detail.mismatchCategories as unknown[]).filter((value): value is string => typeof value === "string" && /^[a-z0-9_.-]{1,80}$/.test(value)))].sort()
    : [];
  return JSON.stringify({
    action,
    taskId: typeof detail.taskId === "string" ? detail.taskId : "",
    eventId: typeof detail.eventId === "string" ? detail.eventId : "",
    seriesId: typeof detail.seriesId === "string" ? detail.seriesId : "",
    calendarStatus: typeof detail.calendarStatus === "string" ? detail.calendarStatus : "",
    mismatchCategories: categories,
    candidateEventIds: ids("candidateEventIds"),
    candidateTaskIds: ids("candidateTaskIds"),
  });
}

export interface RetainedConflictLifecycle {
  active: boolean;
  fingerprint: string;
  incidentId: string;
}

/** Reuse an incident only while the same fingerprint is still active. */
export function retainedConflictIncidentId(
  current: RetainedConflictLifecycle | undefined,
  fingerprint: string,
  nextIncidentId: string,
): string {
  return current?.active && current.fingerprint === fingerprint && current.incidentId
    ? current.incidentId
    : nextIncidentId;
}
