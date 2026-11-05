import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureReplayBlockedError } from "../dist/erasure-replay-barrier.js";
import { ManualDecisionStore } from "../dist/manual-intervention.js";

const secret = Buffer.alloc(32, 73);

function markerKey(profile, kind, id) {
  const digest = createHmac("sha256", secret)
    .update(JSON.stringify(["erasure-replay-v1", profile, kind, id])).digest("hex");
  return { pk: `ERASURE_REPLAY#${profile}`, sk: `${kind}#v1#${digest}` };
}

function enableBarrier(t) {
  const previous = Object.fromEntries([
    "ERASURE_REPLAY_BARRIER_VERSION", "ERASURE_PROTOCOL_VERSION",
    "ERASURE_REPLAY_HMAC_KEYS", "ERASURE_REPLAY_HMAC_CURRENT_KEY",
  ].map(key => [key, process.env[key]]));
  process.env.ERASURE_REPLAY_BARRIER_VERSION = "1";
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  process.env.ERASURE_REPLAY_HMAC_KEYS = JSON.stringify({ v1: secret.toString("base64") });
  process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY = "v1";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function storedDecision(overrides = {}) {
  return {
    decisionId: "decision-1", profile: "home", type: "todoist_unmapped_conflict",
    severity: "warning", status: "pending", createdAt: "2026-11-04T12:00:00.000Z",
    decisionDeadline: "2026-11-11T12:00:00.000Z", context: {},
    fingerprint: "decision-fingerprint", permittedActions: [], ...overrides,
  };
}

function stubStoreReads(t, { current, erasedId, erasedKind = "TASK" }) {
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name !== "GetCommand") return {};
    const key = command.input.Key;
    if (key.pk === "MANUAL#decision-1") return { Item: current };
    const blocked = markerKey("home", erasedKind, erasedId);
    return key.pk === blocked.pk && key.sk === blocked.sk ? { Item: { markerVersion: 1 } } : {};
  });
  return calls;
}

function assertNoWrites(calls) {
  assert.ok(calls.some(command => command.constructor.name === "GetCommand"), "the test must reach replay admission");
  assert.equal(calls.some(command => ["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"]
    .includes(command.constructor.name)), false, "a marker hit must prevent every DynamoDB write");
}

test("putPending rejects an erased identity before the first decision write", async t => {
  enableBarrier(t);
  const calls = stubStoreReads(t, { erasedId: "erased-new-task" });

  await assert.rejects(new ManualDecisionStore().putPending({
    decisionId: "decision-1", profile: "home", type: "todoist_unmapped_conflict",
    severity: "warning", taskId: "erased-new-task", context: {}, fingerprint: "new",
    permittedActions: [],
  }), ErasureReplayBlockedError);
  assertNoWrites(calls);
});

test("refreshPendingContext checks the replacement context before updating", async t => {
  enableBarrier(t);
  const calls = stubStoreReads(t, {
    current: storedDecision({ context: { providerTaskId: "safe-existing-task" } }),
    erasedId: "erased-replacement-event", erasedKind: "EVENT",
  });

  await assert.rejects(new ManualDecisionStore().refreshPendingContext("decision-1", {
    providerEventId: "erased-replacement-event",
  }), ErasureReplayBlockedError);
  assertNoWrites(calls);
  assert.ok(calls.some(command => command.constructor.name === "GetCommand"
    && command.input.Key.sk === markerKey("home", "EVENT", "erased-replacement-event").sk));
});

test("refreshPendingContext checks stored context identities before updating", async t => {
  enableBarrier(t);
  const calls = stubStoreReads(t, {
    current: storedDecision({ context: { providerTaskId: "erased-existing-task" } }),
    erasedId: "erased-existing-task",
  });

  await assert.rejects(new ManualDecisionStore().refreshPendingContext("decision-1", {
    providerTaskId: "safe-replacement-task",
  }), ErasureReplayBlockedError);
  assertNoWrites(calls);
  assert.ok(calls.some(command => command.constructor.name === "GetCommand"
    && command.input.Key.sk === markerKey("home", "TASK", "erased-existing-task").sk));
});

test("setSlackLocation checks stored identities before updating Slack coordinates", async t => {
  enableBarrier(t);
  const calls = stubStoreReads(t, {
    current: storedDecision({ context: { providerTaskId: "erased-slack-task" } }),
    erasedId: "erased-slack-task",
  });

  await assert.rejects(new ManualDecisionStore().setSlackLocation("decision-1", "C123", "1712345678.000001"),
    ErasureReplayBlockedError);
  assertNoWrites(calls);
});

test("finish checks stored identities before changing terminal status", async t => {
  enableBarrier(t);
  const calls = stubStoreReads(t, {
    current: storedDecision({ context: { providerTaskId: "erased-finish-task" } }),
    erasedId: "erased-finish-task",
  });

  await assert.rejects(new ManualDecisionStore().finish("decision-1", "resolved", "acknowledged"),
    ErasureReplayBlockedError);
  assertNoWrites(calls);
});
