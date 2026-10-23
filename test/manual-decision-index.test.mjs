import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ManualDecisionStore } from "../dist/manual-intervention.js";
import { ReviewStore } from "../dist/review-store.js";
import { checkReconciliationHealth } from "../dist/reconcile.js";

const readyMarker = { Item: { ready: true, version: 3 } };

function decision(profile, id, status = "pending") {
  return {
    profile,
    decisionId: id,
    status,
    createdAt: `2026-10-23T10:00:${String(id).padStart(2, "0")}.000Z`,
  };
}

test("pending decision query isolates profiles and excludes terminal decisions across pages", async (t) => {
  const originalSend = documentClient.send;
  const calls = [];
  documentClient.send = async command => {
    calls.push(command);
    if (command.constructor.name === "GetCommand") return readyMarker;
    assert.equal(command.constructor.name, "QueryCommand");
    assert.equal(command.input.IndexName, "ProfileLookupIndex");
    assert.match(command.input.KeyConditionExpression, /lookupPk = :lookupPk/);
    assert.equal(command.input.FilterExpression, "#profile = :profile AND #status = :pending");
    if (command.input.ExpressionAttributeValues[":profile"] === "home") {
      if (!command.input.ExclusiveStartKey) return {
        Items: Array.from({ length: 25 }, (_, index) => decision("home", `h${String(index).padStart(2, "0")}`)),
        ScannedCount: 26,
        LastEvaluatedKey: { pk: "MANUAL#next", sk: "STATE" },
      };
      return { Items: Array.from({ length: 26 }, (_, index) => decision("home", `h${String(index + 25).padStart(2, "0")}`)), ScannedCount: 26 };
    }
    if (command.input.ExpressionAttributeValues[":profile"] === "antonio") return { Items: [], ScannedCount: 0 };
    return { Items: [decision("work", "4")], ScannedCount: 1 };
  };
  t.after(() => { documentClient.send = originalSend; });

  const home = await new ManualDecisionStore().listPending("home", { requestId: "req-home" });
  assert.equal(home.length, 51);
  assert.ok(home.every(item => item.profile === "home" && item.status === "pending"));
  assert.equal(calls.filter(command => command.constructor.name === "QueryCommand").length, 2);
  assert.equal(calls.every(command => command.constructor.name !== "ScanCommand"), true);
  assert.deepEqual(await new ManualDecisionStore().listPending("antonio"), []);
});

test("5,000 unrelated history rows do not increase pending-decision query work", async (t) => {
  const originalSend = documentClient.send;
  const unrelatedHistory = Array.from({ length: 5_000 }, (_, index) => ({ pk: `AUDIT#${index}`, sk: "2026-10-23T00:00:00.000Z" }));
  let queries = 0;
  let scans = 0;
  documentClient.send = async command => {
    if (command.constructor.name === "GetCommand") return readyMarker;
    if (command.constructor.name === "ScanCommand") { scans++; throw new Error("full-table Scan is forbidden"); }
    queries++;
    assert.equal(command.input.Limit, 25);
    return { Items: [decision("work", "1")], Count: 1, ScannedCount: 1 };
  };
  t.after(() => { documentClient.send = originalSend; });

  const found = await new ManualDecisionStore().listPending("work", { requestId: "req-load" });
  assert.equal(unrelatedHistory.length, 5_000);
  assert.equal(found.length, 1);
  assert.equal(queries, 1);
  assert.equal(scans, 0);
});

test("health passes one shared request/deadline budget to exactly one pending lookup per selected profile", async () => {
  const calls = [];
  const state = { async getReconciliationState(profile) { return { generation: profile, pending: false }; } };
  const manual = {
    enabled: false,
    async retireStaleReconciliationIncidents(profile, generation, pending, options) { calls.push({ profile, generation, pending, options }); },
  };
  const budget = { deadlineAtMs: Date.now() + 3_000, requestId: "health-request" };
  await checkReconciliationHealth(state, manual, ["home", "work"], budget);
  assert.deepEqual(calls.map(call => call.profile), ["home", "work"]);
  assert.ok(calls.every(call => call.options === budget));
});

test("pending decision pagination reports incomplete rather than returning a partial empty result", async (t) => {
  const originalSend = documentClient.send;
  documentClient.send = async command => {
    if (command.constructor.name === "GetCommand") return readyMarker;
    return { Items: [], ScannedCount: 25, LastEvaluatedKey: { pk: "MANUAL#later", sk: "STATE" } };
  };
  t.after(() => { documentClient.send = originalSend; });

  await assert.rejects(
    new ManualDecisionStore().listPending("home", { maxPagesPerProfile: 1, requestId: "req-page-cap" }),
    /lookup incomplete/,
  );
});

test("pending writes add the lookup key and terminal transitions remove it", async (t) => {
  const originalSend = documentClient.send;
  const previousTable = process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME = "test-state";
  const store = new ManualDecisionStore();
  let storedDecision;
  const get = t.mock.method(ManualDecisionStore.prototype, "get", async () => storedDecision);
  t.mock.method(ReviewStore.prototype, "observeDecision", async () => {});
  t.mock.method(ReviewStore.prototype, "updateCase", async () => {});
  const commands = [];
  documentClient.send = async command => { commands.push(command); return {}; };
  t.after(() => {
    documentClient.send = originalSend;
    if (previousTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = previousTable;
  });

  const input = {
    decisionId: "home-pending-1", profile: "home", type: "operational_dlq", severity: "warning",
    context: {}, fingerprint: "fingerprint", permittedActions: [],
  };
  const { decision } = await store.putPending(input);
  assert.equal(get.mock.callCount(), 1);
  const put = commands.find(command => command.constructor.name === "PutCommand");
  assert.equal(put.input.Item.lookupPk, "PROFILE#home");
  assert.match(put.input.Item.lookupSk, /^MANUAL#PENDING#.*#home-pending-1$/);

  storedDecision = { ...decision, status: "resolved" };
  await store.finish("home-pending-1", "resolved", "resolved in test");
  const update = commands.find(command => command.constructor.name === "UpdateCommand");
  assert.match(update.input.UpdateExpression, /REMOVE lookupPk, lookupSk/);
});

test("deadline and throttling outcomes fail closed instead of reporting an empty inbox", async (t) => {
  const originalSend = documentClient.send;
  let queries = 0;
  documentClient.send = async command => {
    if (command.constructor.name === "GetCommand") return readyMarker;
    queries++;
    const error = new Error("throttled");
    error.name = "ProvisionedThroughputExceededException";
    throw error;
  };
  t.after(() => { documentClient.send = originalSend; });

  await assert.rejects(new ManualDecisionStore().listPending("home", { deadlineAtMs: 1 }), /deadline exhausted/);
  assert.equal(queries, 0);
  await assert.rejects(new ManualDecisionStore().listPending("home", { requestId: "req-throttle" }), /throttled/);
  assert.equal(queries, 1);
});

test("a delayed indexed query is aborted at the caller deadline and cannot report an empty inbox", async (t) => {
  const originalSend = documentClient.send;
  let querySignal;
  documentClient.send = async (command, options = {}) => {
    if (command.constructor.name === "GetCommand") return readyMarker;
    assert.equal(command.constructor.name, "QueryCommand");
    querySignal = options.abortSignal;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("request timed out"), { name: "TimeoutError" }));
      if (querySignal.aborted) onAbort();
      else querySignal.addEventListener("abort", onAbort, { once: true });
      const safetyTimer = setTimeout(() => reject(new Error("deadline signal was not delivered")), 1_000);
      querySignal.addEventListener("abort", () => clearTimeout(safetyTimer), { once: true });
    });
  };
  t.after(() => { documentClient.send = originalSend; });

  await assert.rejects(
    new ManualDecisionStore().listPending("home", { deadlineAtMs: Date.now() + 100, requestId: "req-slow-query" }),
    /deadline exhausted/,
  );
  assert.ok(querySignal);
  assert.equal(querySignal.aborted, true);
});

