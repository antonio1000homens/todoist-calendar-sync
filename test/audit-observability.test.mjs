import assert from "node:assert/strict";
import test from "node:test";

import { auditExpiresAt, AUDIT_RETENTION_DAYS, classifyAuditAction, retainedConflictIdentity, retainedConflictIncidentId } from "../dist/audit-policy.js";
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

test("telemetry retains classified candidate task IDs without accepting arbitrary arrays", () => {
  assert.deepEqual(sanitizeTelemetryDetail({
    candidateTaskIds: ["task-a", "task-b"],
    eligibleCandidateTaskIds: ["task-a"],
    mappedCandidateTaskIds: ["task-b"],
    reservedCandidateTaskIds: ["task-c", "not a safe id"],
    taskTitles: ["private task title"],
  }), {
    candidateTaskIds: ["task-a", "task-b"],
    eligibleCandidateTaskIds: ["task-a"],
    mappedCandidateTaskIds: ["task-b"],
    reservedCandidateTaskIds: ["task-c"],
  });
});

test("telemetry retains only safe expected and observed recurrence scalars", () => {
  const sanitized = sanitizeTelemetryDetail({
    eventId: "event-1",
    expected: {
      frequency: "weekly", weekday: "Wednesday", time: "09:00",
      startDate: "2026-11-04", endDate: "2026-11-25",
      dueString: "private task recurrence", title: "private task title", unexpected: { nested: "secret" },
    },
    observed: {
      recurring: true, dueDate: "2026-11-04", recurrenceParsed: true,
      frequency: "weekly", weekday: "Wednesday", time: "09:00",
      startDate: "11-04", endDate: "11-25", startYearOmitted: true, endYearOmitted: true,
      dueString: "every Wednesday with private notes", taskTitle: "private task title", payload: { token: "secret" },
    },
    title: "private task title",
    dueString: "raw private due string",
  });
  assert.deepEqual(sanitized, {
    eventId: "event-1",
    expected: {
      frequency: "weekly", weekday: "Wednesday", time: "09:00",
      startDate: "2026-11-04", endDate: "2026-11-25",
    },
    observed: {
      recurring: true, dueDate: "2026-11-04", recurrenceParsed: true,
      frequency: "weekly", weekday: "Wednesday", time: "09:00",
      startDate: "11-04", endDate: "11-25", startYearOmitted: true, endYearOmitted: true,
    },
  });

  assert.deepEqual(sanitizeTelemetryDetail({
    expected: { frequency: "daily", weekday: "private", time: "the task says 9", startDate: "2030-02-30" },
    observed: { dueDate: "private event notes", startDate: "raw due string", recurring: "yes", surprise: "secret" },
  }), {});
  assert.deepEqual(sanitizeTelemetryDetail({ observed: { dueDate: "2026-11-04T09:00:00Z" } }), {
    observed: { dueDate: "2026-11-04T09:00:00Z" },
  });
});

test("logEvent preserves safe recurrence diagnostics while excluding raw due strings and task text", () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    logEvent("calendar_recurrence_todoist_readback_mismatch", {
      expected: { frequency: "weekly", weekday: "Wednesday", startDate: "2026-11-04", endDate: "2026-11-25" },
      observed: { recurring: true, dueDate: "2026-11-04", recurrenceParsed: false },
      dueString: "raw Todoist recurrence text",
      taskTitle: "private task title",
    }, "state-repository");
  } finally {
    console.log = original;
  }
  assert.deepEqual(JSON.parse(lines[0]), {
    level: "info",
    event: "calendar_recurrence_todoist_readback_mismatch",
    component: "state-repository",
    expected: { frequency: "weekly", weekday: "Wednesday", startDate: "2026-11-04", endDate: "2026-11-25" },
    observed: { recurring: true, dueDate: "2026-11-04", recurrenceParsed: false },
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


test("conflict fingerprints distinguish mismatch categories and preserve long candidate IDs", () => {
  const action = "todoist_snapshot_reconcile_unmapped_conflict";
  const base = { taskId: "task", eventId: "event", taskUpdatedAt:"2026-10-22T10:00:00Z", calendarEtag:"etag-1" };
  assert.notEqual(
    retainedConflictIdentity(action, { ...base, mismatchCategories: ["title_mismatch"] }),
    retainedConflictIdentity(action, { ...base, mismatchCategories: ["start_mismatch"] }),
  );
  const longIdA = "a".repeat(260);
  const longIdB = "b".repeat(260);
  const longCandidatesA = { ...base, mismatchCategories:["title_mismatch"], candidateEventIds:["abcde", longIdA] };
  const longCandidatesB = { ...base, mismatchCategories:["title_mismatch"], candidateEventIds:["abcde", longIdB] };
  assert.notEqual(
    retainedConflictIdentity(action, longCandidatesA),
    retainedConflictIdentity(action, longCandidatesB),
    "distinct long provider IDs must remain distinct in the pre-sanitized fingerprint",
  );
  assert.deepEqual(
    sanitizeTelemetryDetail(longCandidatesA),
    sanitizeTelemetryDetail(longCandidatesB),
    "long candidate IDs remain excluded from persisted/logged telemetry",
  );
  assert.equal(retainedConflictIdentity("todoist_snapshot_reconcile_unmapped_ambiguous", {
    taskId: "task", candidateEventIds: ["abcde", longIdA], taskUpdatedAt:"2026-10-22T10:00:00Z",
  }), undefined, "candidate-only observations have no revision for every ambiguous candidate");
  const stablePair = { taskId:"task", eventId:"event", mismatchCategories:["title_mismatch"], taskUpdatedAt:"2026-10-22T10:00:00Z", calendarEtag:"etag-1" };
  assert.equal(retainedConflictIdentity(action, stablePair), retainedConflictIdentity(action, { ...stablePair }));
  assert.notEqual(retainedConflictIdentity(action, stablePair), retainedConflictIdentity(action, { ...stablePair, taskUpdatedAt:"2026-10-23T10:00:00Z" }));
  assert.notEqual(retainedConflictIdentity(action, stablePair), retainedConflictIdentity(action, { ...stablePair, calendarEtag:"etag-2" }));
  assert.equal(retainedConflictIdentity(action, { ...stablePair, taskUpdatedAt:undefined }), undefined);
  assert.equal(retainedConflictIdentity(action, { ...stablePair, mismatchCategories:[] }), undefined);
  const cancelledAction = "todoist_snapshot_reconcile_cancelled_projection_blocked";
  const cancelled = { taskId:"task", eventId:"event", taskUpdatedAt:"2026-10-22T10:00:00Z",
    calendarEtag:"etag-1", tombstoneReason:"user_deleted" };
  assert.notEqual(retainedConflictIdentity(cancelledAction,cancelled),
    retainedConflictIdentity(cancelledAction,{...cancelled,tombstoneReason:"project_exit"}));
});

test("a resolved conflict reappearing unchanged receives a new retained incident ID", () => {
  const fingerprint = retainedConflictIdentity("todoist_snapshot_reconcile_unmapped_conflict", {
    taskId: "task-1", eventId: "event-1", mismatchCategories: ["title_mismatch"],
    taskUpdatedAt:"2026-10-22T10:00:00Z", calendarEtag:"etag-1",
  });
  assert.ok(fingerprint);
  const first = retainedConflictIncidentId(undefined, fingerprint, "incident-1");
  const repeatedWhileActive = retainedConflictIncidentId({
    active: true, fingerprint, incidentId: first,
  }, fingerprint, "incident-ignored");
  assert.equal(repeatedWhileActive, first);

  const afterResolution = retainedConflictIncidentId({
    active: false, fingerprint, incidentId: first,
  }, fingerprint, "incident-2");
  assert.equal(afterResolution, "incident-2");
  assert.notEqual(afterResolution, first);
});
