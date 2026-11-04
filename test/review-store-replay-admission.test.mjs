import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureReplayBlockedError } from "../dist/erasure-replay-barrier.js";
import { ReviewStore, reviewHash } from "../dist/review-store.js";

const secret = Buffer.alloc(32, 41);
function markerKey(profile, kind, id) {
  const digest = createHmac("sha256", secret)
    .update(JSON.stringify(["erasure-replay-v1", profile, kind, id])).digest("hex");
  return `${kind}#v1#${digest}`;
}
function enableBarrier(t) {
  const previous = {
    barrier: process.env.ERASURE_REPLAY_BARRIER_VERSION,
    protocol: process.env.ERASURE_PROTOCOL_VERSION,
    keys: process.env.ERASURE_REPLAY_HMAC_KEYS,
    current: process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
    table: process.env.STATE_TABLE_NAME,
  };
  process.env.ERASURE_REPLAY_BARRIER_VERSION = "1";
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  process.env.ERASURE_REPLAY_HMAC_KEYS = JSON.stringify({ v1: secret.toString("base64") });
  process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY = "v1";
  process.env.STATE_TABLE_NAME = "review-replay-admission-test";
  t.after(() => {
    for (const [key, value] of Object.entries({
      ERASURE_REPLAY_BARRIER_VERSION: previous.barrier,
      ERASURE_PROTOCOL_VERSION: previous.protocol,
      ERASURE_REPLAY_HMAC_KEYS: previous.keys,
      ERASURE_REPLAY_HMAC_CURRENT_KEY: previous.current,
      STATE_TABLE_NAME: previous.table,
    })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
}
function decision(overrides = {}) {
  return {
    decisionId: "decision-1", profile: "home", type: "todoist_unmapped_conflict",
    severity: "warning", status: "pending", createdAt: new Date().toISOString(),
    decisionDeadline: new Date(Date.now() + 60_000).toISOString(), context: {},
    fingerprint: "decision-fingerprint", permittedActions: [], ...overrides,
  };
}

test("decision context provider IDs are checked before a review case can be seeded", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-context-task")) return { Item: { markerVersion: 1 } };
    return {};
  });
  await assert.rejects(new ReviewStore().observeDecision(decision({context: {providerTaskId: "erased-context-task"}})), ErasureReplayBlockedError);
  assert.equal(calls.length, 1, "no review state read or write may follow the marker hit");
});

test("mapping snapshot recurrence aliases are checked before a decision is persisted", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "EVENT", "erased-master-alias")) return { Item: { markerVersion: 1 } };
    return {};
  });
  const mapping = {profile:"home",taskId:"safe-task",eventId:"safe-occurrence",masterEventId:"erased-master-alias",
    activeInstanceId:"safe-occurrence",seriesId:"erased-master-alias",updatedAt:new Date().toISOString()};
  await assert.rejects(new ReviewStore().observeDecision(decision({mappingSnapshot:mapping})), ErasureReplayBlockedError);
  assert.equal(calls.length, 3, "both task and occurrence are checked before the erased master blocks persistence");
});

test("candidate IDs in conflict audit arrays are checked before an incident case is seeded", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-candidate-task")) return { Item: { markerVersion: 1 } };
    return {};
  });
  const audit = { pk: "AUDIT#conflict", action: "todoist_snapshot_reconcile_unmapped_conflict",
    detail: { candidateTaskIds: ["erased-candidate-task"] }, createdAt: new Date().toISOString() };
  await assert.rejects(new ReviewStore().observeConflictIncident("home", "fingerprint", "incident", audit), ErasureReplayBlockedError);
  assert.equal(calls.length, 1, "no incident case or pointer may be written after the marker hit");
});

test("coalescing refuses to close an open case that references an erased candidate", async t => {
  enableBarrier(t);
  const conflictKey = reviewHash("conflict");
  const keeper = { id: "decision-1", profile: "home", status: "open", conflictKey,
    taskId: "safe-task", createdAt: "2026-11-04T12:00:00.000Z", updatedAt: "2026-11-04T12:00:00.000Z" };
  const candidate = { id: "incident-old", profile: "home", status: "open", conflictKey,
    taskId: "erased-case-task", eventId: "safe-event", createdAt: "2026-11-04T11:00:00.000Z" };
  const store = new ReviewStore();
  store.getCase = async id => id === keeper.id ? keeper : id === candidate.id ? candidate : undefined;
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-case-task")) return { Item: { markerVersion: 1 } };
    if (command.constructor.name === "QueryCommand" && command.input.KeyConditionExpression.startsWith("pk ="))
      return { Items: [{ incidentId: candidate.id }] };
    return {};
  });
  await assert.rejects(store.observeDecision(decision({
    context: { conflictKey }, taskId: "safe-task",
  })), ErasureReplayBlockedError);
  assert.equal(calls.some(command => command.constructor.name === "UpdateCommand"), false,
    "the conflict case must remain open when its erased identity is encountered");
});
