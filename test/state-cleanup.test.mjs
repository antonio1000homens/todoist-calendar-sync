import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  classifyLegacyAudit, inspectMappingIntegrity, expectedMappingKey,
  summarizeUnmappedConflicts, fingerprint,
} from "../scripts/state-cleanup-policy.mjs";

const now = Date.parse("2026-10-12T15:00:00Z");
const DAY = 86400000;

function audit({ ageDays = 10, retentionDays = 30, ...overrides } = {}) {
  const createdMs = now - ageDays * DAY;
  return {
    pk: "AUDIT#home#timestamp#abc", sk: "STATE",
    action: "todoist_snapshot_reconcile_unmapped_conflict",
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: Math.floor((createdMs + retentionDays * DAY) / 1000),
    ...overrides,
  };
}

function mapping(kind, { profile = "home", eventId = "event1", taskId = "task1" } = {}) {
  return { ...expectedMappingKey(kind, profile, eventId, taskId), profile, eventId, taskId };
}

test("only older legacy 30/90-day AUDIT TTL records qualify", () => {
  assert.deepEqual(classifyLegacyAudit(audit(), now), {
    action: "todoist_snapshot_reconcile_unmapped_conflict",
    originalRetentionDays: 30,
  });
  assert.equal(classifyLegacyAudit(audit({ retentionDays: 90 }), now)?.originalRetentionDays, 90);
  assert.equal(classifyLegacyAudit(audit({ retentionDays: 7 }), now), null);
  assert.equal(classifyLegacyAudit(audit({ retentionDays: 10 }), now), null);
  assert.equal(classifyLegacyAudit(audit({ ageDays: 6, retentionDays: 30 }), now), null);
  assert.equal(classifyLegacyAudit(audit({ ageDays: 30, retentionDays: 30 }), now), null);
});

test("audit classifier fails closed for missing or malformed identities and TTL", () => {
  const good = audit();
  assert.equal(classifyLegacyAudit({ ...good, pk: "COMPLETED_EVENT#home#event" }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, pk: "AUDIT#unknown#timestamp#x" }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, sk: "MAP" }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, action: "" }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, createdAt: "invalid" }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, expiresAt: undefined }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, expiresAt: "1790000000" }, now), null);
  assert.equal(classifyLegacyAudit({ ...good, expiresAt: good.expiresAt + 18 * DAY / 1000 }, now), null);
});

test("completed-task state cannot qualify for deletion regardless of timestamps", () => {
  const old = audit();
  for (const pk of [
    "COMPLETED_EVENT#home#event1",
    "COMPLETED_TASK#home#task1",
    "EVENT#home#event1",
    "TASK#home#task1",
    "TASKOWNER#task1",
    "RECURRENCE#home#series",
    "DELIVERY#receipt",
  ]) {
    assert.equal(classifyLegacyAudit({ ...old, pk }, now), null, pk);
  }
});

test("mapping integrity reports incomplete and overwritten triplets without prescribing deletion", () => {
  const good = ["EVENT", "TASK", "TASKOWNER"].map((kind) => mapping(kind));
  const previous = mapping("EVENT", { taskId: "old-task" });
  const result = inspectMappingIntegrity([...good, previous]);
  assert.equal(result.complete, 1);
  assert.equal(result.uniqueMappings, 2);
  assert.equal(result.anomalies.length, 1);
  assert.deepEqual(result.anomalies[0].present, ["EVENT"]);
  assert.deepEqual(result.anomalies[0].missing, ["TASK", "TASKOWNER"]);
  assert.equal(result.malformedRows, 0);
});

test("mapping integrity rejects invalid profile and key mismatch", () => {
  const invalid = mapping("EVENT", { profile: "work" });
  invalid.pk = "EVENT#home#event1";
  const result = inspectMappingIntegrity([invalid, mapping("TASK", { profile: "bogus" })]);
  assert.equal(result.malformedRows, 2);
  assert.equal(result.uniqueMappings, 0);
});

test("conflict summary hashes provider identifiers and counts repeated pairs", () => {
  const pair = { taskId: "task-secret", eventId: "event-secret" };
  const conflicts = [
    { action: "todoist_snapshot_reconcile_unmapped_conflict", detail: pair },
    { action: "todoist_snapshot_reconcile_unmapped_conflict", detail: pair },
    { action: "todoist_snapshot_reconcile_unmapped_conflict", detail: { taskId: "other", eventId: "other" } },
    { action: "todoist_snapshot_reconcile_cancelled_projection_blocked", detail: pair },
  ];
  const result = summarizeUnmappedConflicts(conflicts);
  assert.equal(result.length, 2);
  assert.equal(result[0].count, 2);
  assert.equal(result[0].fingerprint, fingerprint("task-secret", "event-secret"));
  assert.equal(JSON.stringify(result).includes("task-secret"), false);
});


test("production administration script parses without contacting AWS", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/audit-state-retention.mjs", import.meta.url));
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", scriptPath]));
});
