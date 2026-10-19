import assert from "node:assert/strict";
import test from "node:test";

import { auditExpiresAt, AUDIT_RETENTION_DAYS, classifyAuditAction, retainedConflictIdentity } from "../dist/audit-policy.js";
import { logEvent, sanitizeTelemetryDetail } from "../dist/observability.js";

test("new audit expiry is seven days and does not alter the other TTL policies", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  assert.equal(AUDIT_RETENTION_DAYS, 7);
  assert.equal(auditExpiresAt(now), Math.floor(now / 1000) + 7 * 24 * 60 * 60);
});

test("routine and significant audit classifications are deterministic", () => {
  assert.equal(classifyAuditAction("todoist_snapshot_reconcile_converged"), "routine");
  assert.equal(classifyAuditAction("calendar_delta_processed"), "routine");
  assert.equal(classifyAuditAction("todoist_snapshot_reconcile_conflict_both_sides_changed"), "significant");
  assert.equal(classifyAuditAction("calendar_snapshot_unmapped_ambiguous"), "significant");
  assert.equal(classifyAuditAction("future_unreviewed_action"), "significant");
});

test("telemetry sanitization retains correlation metadata and drops content/payloads", () => {
  assert.deepEqual(sanitizeTelemetryDetail({
    profile: "home",
    taskId: "task-1",
    eventId: "event-1",
    calendarStatus: "cancelled",
    changedFields: ["description", "due.date", "not safe value"],
    title: "private task title",
    description: "private description",
    error: "provider response with a secret",
    providerBody: "raw provider payload",
    response: { access_token: "secret" },
  }), {
    profile: "home",
    taskId: "task-1",
    eventId: "event-1",
    calendarStatus: "cancelled",
    changedFields: ["description", "due.date"],
  });
  assert.deepEqual(sanitizeTelemetryDetail({
    summary: { scanned: 12, conflicts: 1, providerMutations: 2, title: "drop me" },
    mutationBudget: { used: 2, limit: 10, exhausted: false, payload: "drop me" },
  }), {
    summary: { scanned: 12, conflicts: 1, providerMutations: 2 },
    mutationBudget: { used: 2, limit: 10, exhausted: false },
  });
});

test("logEvent emits one valid structured JSON record without unsafe fields", () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    logEvent("todoist_snapshot_reconcile_converged", {
      profile: "antonio",
      taskId: "task-2",
      body: "raw provider payload",
    }, "reconciliation");
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    level: "info",
    event: "todoist_snapshot_reconcile_converged",
    component: "reconciliation",
    profile: "antonio",
    taskId: "task-2",
  });
});

test("retained conflict fingerprint is stable for repeats and sensitive to changed candidates", () => {
  const action = "todoist_snapshot_reconcile_unmapped_conflict";
  assert.equal(retainedConflictIdentity(action, { taskId: "task", eventId: "event" }),
    retainedConflictIdentity(action, { eventId: "event", taskId: "task" }));
  assert.notEqual(retainedConflictIdentity(action, { taskId: "task", eventId: "event" }),
    retainedConflictIdentity(action, { taskId: "task", eventId: "other" }));
  assert.equal(retainedConflictIdentity(action, { taskId: "task", eventId: "event", title: "secret" }),
    retainedConflictIdentity(action, { taskId: "task", eventId: "event" }));
  assert.equal(retainedConflictIdentity("todoist_snapshot_reconcile_completed", { taskId: "task" }), undefined);
  assert.equal(retainedConflictIdentity(action, {}), undefined);
  assert.equal(retainedConflictIdentity("todoist_snapshot_reconcile_unmapped_ambiguous", {
    taskId: "task", candidateEventIds: ["a", "b"],
  }), retainedConflictIdentity("todoist_snapshot_reconcile_unmapped_ambiguous", {
    taskId: "task", candidateEventIds: ["b", "a"],
  }));
  assert.notEqual(retainedConflictIdentity("todoist_snapshot_reconcile_unmapped_ambiguous", {
    taskId: "task", candidateEventIds: ["a", "b"],
  }), retainedConflictIdentity("todoist_snapshot_reconcile_unmapped_ambiguous", {
    taskId: "task", candidateEventIds: ["c", "a"],
  }));
});

test("candidate event/task IDs survive sanitization without raw provider content", () => {
  assert.deepEqual(sanitizeTelemetryDetail({
    taskId: "task-1",
    candidateEventIds: ["event_1", "event_2", "https://malicious.test/token"],
    candidateTaskIds: ["task_1", "task_2"],
    title: "private title",
  }), {
    taskId: "task-1",
    candidateEventIds: ["event_1", "event_2"],
    candidateTaskIds: ["task_1", "task_2"],
  });
});
