import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { assertManualDecisionReplayAdmission, assertRepairPreviewReplayAdmission, ReviewStore } from "../dist/review-store.js";

const decision = (overrides = {}) => ({
  decisionId: "decision-1", profile: "home", type: "todoist_unmapped_conflict",
  severity: "warning", status: "pending", createdAt: new Date().toISOString(),
  decisionDeadline: new Date(Date.now() + 60_000).toISOString(), context: {},
  fingerprint: "decision-fingerprint", permittedActions: [], ...overrides,
});

test("ordinary review-state admission ignores retained deletion comments and uses current provider state", async t => {
  const names = ["ERASURE_PROTOCOL_VERSION", "ERASURE_REPLAY_BARRIER_VERSION", "STATE_TABLE_NAME"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    ERASURE_PROTOCOL_VERSION: "1", ERASURE_REPLAY_BARRIER_VERSION: "1",
    STATE_TABLE_NAME: "test-state",
  });
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });

  let providerCommentReads = 0;
  const clientFactory = async () => ({ todoist: {
    async listProjectComments() { providerCommentReads += 1; return [{
      id: "old-deletion-comment", content: "todoist-calendar-sync:deleted:v1",
    }]; },
  } });
  const writes = [];
  t.mock.method(documentClient, "send", async command => { writes.push(command.constructor.name); return {}; });

  await assert.doesNotReject(assertManualDecisionReplayAdmission(
    decision({ taskId: "previously-deleted-task" }), clientFactory));
  await assert.doesNotReject(assertRepairPreviewReplayAdmission({
    intent: { profile: "home", action: "link", taskId: "previously-deleted-task", eventId: "old-event" },
    snapshots: [], itemPlan: [],
  }, clientFactory));
  await assert.doesNotReject(new ReviewStore().observeDecision(decision({ taskId: "previously-deleted-task" })));

  assert.equal(providerCommentReads, 0);
  assert.ok(writes.includes("PutCommand"));
});
