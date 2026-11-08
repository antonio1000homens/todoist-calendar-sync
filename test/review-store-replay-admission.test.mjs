import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureReplayBlockedError } from "../dist/erasure-replay-barrier.js";
import { assertRepairPreviewReplayAdmission, ReviewStore, reviewHash, SyncControls } from "../dist/review-store.js";

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

test("manual decision candidate object IDs are checked before review seeding", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-candidate-object")) return {Item:{markerVersion:1}};
    return {};
  });
  await assert.rejects(new ReviewStore().observeDecision(decision({context:{candidates:[
    {id:"erased-candidate-object",content:"opaque fixture",due:""},
  ]}})),ErasureReplayBlockedError);
  assert.equal(calls.length,1,"the erased candidate is rejected before any review state access");
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
  assert.equal(calls.length, 5, "task, source, and legacy/current master markers are checked before persistence is blocked");
});

test("queued repair admission walks embedded decision and review aliases", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "EVENT", "erased-embedded-master")) return { Item: { markerVersion: 1 } };
    return {};
  });
  const preview = {
    intent: {profile:"home",action:"link",taskId:"safe-task",eventId:"safe-event"},
    snapshots: [], itemPlan: [],
    case: {decision:{profile:"home",mappingSnapshot:{profile:"home",taskId:"safe-task",eventId:"safe-event",
      masterEventId:"erased-embedded-master"}}},
  };
  await assert.rejects(assertRepairPreviewReplayAdmission(preview), ErasureReplayBlockedError);
  assert.equal(calls.length, 5, "embedded historical aliases are checked before the operation can resume");
});

for (const [field, erasedId] of [
  ["calendarProjectionId", "erased-calendar-projection"],
  ["syncHistoryMasterId", "erased-sync-history-master"],
]) test(`queued repair admission checks nested ${field}`, async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "EVENT", erasedId)) return { Item: { markerVersion: 1 } };
    return {};
  });
  const preview = {
    intent: {profile:"home",action:"link",taskId:"safe-task",eventId:"safe-event"},
    snapshots: [{ref:{profile:"home",side:"todoist",id:"safe-task"},[field]:erasedId}], itemPlan: [],
  };
  await assert.rejects(assertRepairPreviewReplayAdmission(preview), ErasureReplayBlockedError);
  assert.ok(calls.some(command => command.constructor.name === "GetCommand"
    && command.input.Key.sk === markerKey("home", "EVENT", erasedId)));
});

test("review admission checks recurring master aliases carried by history plans", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "EVENT", "erased-history-master")) return { Item: { markerVersion: 1 } };
    return {};
  });
  const preview = {intent:{profile:"home",action:"link",taskId:"safe-task",eventId:"safe-event"},snapshots:[],itemPlan:[],
    case:{decision:{profile:"home",elapsedCalendarHistoryPlan:{taskId:"safe-task",eventId:"safe-event",
      recurringMasterId:"erased-history-master"}}}};
  await assert.rejects(assertRepairPreviewReplayAdmission(preview),ErasureReplayBlockedError);
  assert.equal(calls.length,5,"the erased historical master is admitted before any repair state is read or written");
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

test("dismissal refuses to mutate a review case that references an erased identity", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",taskId:"erased-dismiss-task",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-dismiss-task")) return {Item:{markerVersion:1}};
    return {};
  });
  await assert.rejects(store.dismissCase("case-1","acknowledged"),ErasureReplayBlockedError);
  assert.equal(calls.length,1,"the case is not read or mutated after the marker hit");
});

test("case status transitions refuse to mutate a case that references an erased identity", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",eventId:"erased-update-event",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "EVENT", "erased-update-event")) return {Item:{markerVersion:1}};
    return {};
  });
  await assert.rejects(store.updateCase("case-1","dismissed","acknowledged"),ErasureReplayBlockedError);
  assert.equal(calls.length,2,"no case status write follows the legacy marker hit");
});

test("deferred deletion cleanup refuses to update a case that references an erased identity", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",masterEventId:"erased-cleanup-master",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "EVENT", "erased-cleanup-master")) return {Item:{markerVersion:1}};
    return {};
  });
  await assert.rejects(store.noteVerifiedDeletionCleanupDeferred("case-1",new Date().toISOString()),ErasureReplayBlockedError);
  assert.equal(calls.length,2,"no deferred-cleanup status write follows the legacy marker hit");
});

test("verified-deleted case closure refuses an erased identity before cleanup reads", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",taskId:"erased-closure-task",
    eventId:"safe-event",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-closure-task")) return {Item:{markerVersion:1}};
    return {};
  });
  await assert.rejects(store.resolveVerifiedDeletedCase("case-1",{profile:"home",taskIds:["erased-closure-task"],eventIds:["safe-event"]}),ErasureReplayBlockedError);
  assert.equal(calls.length,1,"no deletion evidence or review state is read after the marker hit");
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

const syncControlWrites = [
  ["pair rejection", controls => controls.reject("home", "erased-control-task", "safe-event", "repair-1")],
  ["pair allowance", controls => controls.allow("home", "erased-control-task", "safe-event")],
  ["repair claim", controls => controls.claim([{profile:"home",side:"todoist",id:"erased-control-task"}], "repair-1")],
  ["unapplied release", controls => controls.releaseUnapplied([{profile:"home",side:"todoist",id:"erased-control-task"}], "repair-1",
    [{ref:{profile:"home",side:"todoist",id:"erased-control-task"},control:{}}], {error:"failed",nextAction:"refresh"})],
  ["exclusion update", controls => controls.exclude({profile:"home",side:"todoist",id:"erased-control-task"}, true, "repair-1")],
  ["repair release", controls => controls.release({profile:"home",side:"todoist",id:"erased-control-task"}, "repair-1")],
  ["pending refresh clear", controls => controls.clearPendingRefresh([{profile:"home",side:"todoist",id:"erased-control-task",pendingRefreshAt:"token"}])],
  ["blocked control update", controls => controls.blocked("home", {taskId:"erased-control-task"})],
];
for (const [name, invoke] of syncControlWrites) test(`SyncControls refuses ${name} for an erased identity`, async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand"
      && command.input.Key.sk === markerKey("home", "TASK", "erased-control-task")) return { Item: { markerVersion: 1 } };
    return {};
  });
  await assert.rejects(invoke(new SyncControls()), ErasureReplayBlockedError);
  assert.equal(calls.length, 1, "only the strongly consistent replay-marker lookup may run");
});
