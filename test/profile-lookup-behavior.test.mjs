import assert from "node:assert/strict";
import test from "node:test";

import {
  mappingLookupSk,
  mappingEventLookupAttributes,
  mappingLookupAttributes,
  mappingOwnerLookupAttributes,
  mappingLookupQueryInput,
  profileLookupParity,
  profileLookupPk,
  PROFILE_LOOKUP_MIGRATION_VERSION,
  PROFILE_LOOKUP_READY_KEY,
  PROFILE_LOOKUP_READY_SORT_KEY,
  readProfileLookup,
  recurrenceLookupSk,
  recurrenceLookupAttributes,
  recurrenceLookupQueryInput,
} from "../dist/profile-lookup.js";

function fakeClient({ readyVersion = PROFILE_LOOKUP_MIGRATION_VERSION, pages = [] } = {}) {
  const calls = [];
  let queryPage = 0;
  return {
    calls,
    async send(command) {
      const input = command.input;
      calls.push(input);
      if (input.Key?.pk === PROFILE_LOOKUP_READY_KEY) {
        return readyVersion === null
          ? {}
          : { Item: { ready: true, version: readyVersion } };
      }
      const page = pages[queryPage] || { Items: [] };
      queryPage += 1;
      return page;
    },
  };
}

async function captureLogs(action) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    return { result: await action(), lines };
  } finally {
    console.log = original;
  }
}

test("profile lookup identity helpers cover mapping and recurrence rows", () => {
  assert.equal(profileLookupPk("home"), "PROFILE#home");
  assert.equal(mappingLookupSk("task", "task-1"), "MAPPING#TASK#task-1");
  assert.equal(mappingLookupSk("event", "event-1"), "MAPPING#EVENT#event-1");
  assert.equal(mappingLookupSk("owner", "task-1"), "MAPPING#OWNER#task-1");
  assert.equal(recurrenceLookupSk("series-1"), "RECURRENCE#series-1");
});

test("production mapping and recurrence write seams emit destination lookup rows", () => {
  const mapping = { profile: "work", eventId: "event-new", taskId: "task-new" };
  assert.deepEqual([
    { pk: "EVENT#work#event-new", sk: "MAP", ...mappingEventLookupAttributes(mapping) },
    { pk: "TASK#work#task-new", sk: "MAP", ...mappingLookupAttributes(mapping) },
    { pk: "TASKOWNER#task-new", sk: "MAP", ...mappingOwnerLookupAttributes(mapping) },
  ].map(({ pk, sk, lookupPk, lookupSk }) => ({ pk, sk, lookupPk, lookupSk })), [
    { pk: "EVENT#work#event-new", sk: "MAP", lookupPk: "PROFILE#work", lookupSk: "MAPPING#EVENT#event-new" },
    { pk: "TASK#work#task-new", sk: "MAP", lookupPk: "PROFILE#work", lookupSk: "MAPPING#TASK#task-new" },
    { pk: "TASKOWNER#task-new", sk: "MAP", lookupPk: "PROFILE#work", lookupSk: "MAPPING#OWNER#task-new" },
  ]);
  assert.deepEqual({ pk: "RECURRENCE#work#series-new", sk: "STATE", ...recurrenceLookupAttributes({ profile: "work", seriesId: "series-new" }) }, {
    pk: "RECURRENCE#work#series-new", sk: "STATE", lookupPk: "PROFILE#work", lookupSk: "RECURRENCE#series-new",
  });
  assert.equal(mappingLookupQueryInput("state", "work").ExpressionAttributeValues[":lookupPk"], "PROFILE#work");
  assert.equal(recurrenceLookupQueryInput("state", "work").ExpressionAttributeValues[":lookupSk"], "RECURRENCE#");
});

test("backfill parity distinguishes equal, missing, unexpected, and both", () => {
  const expected = new Set(["a", "b"]);
  assert.deepEqual(profileLookupParity(expected, new Set(["a", "b"])), { missing: [], unexpected: [] });
  assert.deepEqual(profileLookupParity(expected, new Set(["a"])), { missing: ["b"], unexpected: [] });
  assert.deepEqual(profileLookupParity(expected, new Set(["a", "b", "c"])), { missing: [], unexpected: ["c"] });
  assert.deepEqual(profileLookupParity(expected, new Set(["b", "c"])), { missing: ["a"], unexpected: ["c"] });
});

test("unready or wrong-version lookup uses the scan fallback", async () => {
  for (const readyVersion of [null, 0]) {
    const client = fakeClient({ readyVersion });
    let fallbackCalls = 0;
    const result = await readProfileLookup({
      client,
      tableName: "state",
      profile: "home",
      operation: "list_recurrence_links",
      component: "test",
      queryInput: { TableName: "state", IndexName: "ProfileLookupIndex" },
      fallback: async () => { fallbackCalls += 1; return ["scan-row"]; },
    });
    assert.deepEqual(result, ["scan-row"]);
    assert.equal(fallbackCalls, 1);
    assert.equal(client.calls.length, 1);
  }
});

test("ready mapping lookup paginates in order and emits aggregate query telemetry", async () => {
  const client = fakeClient({
    pages: [
      { Items: [{ taskId: "one" }], ScannedCount: 3, ConsumedCapacity: { CapacityUnits: 1.5 }, LastEvaluatedKey: { lookupSk: "MAPPING#TASK#one" } },
      { Items: [{ taskId: "two" }], ScannedCount: 2, ConsumedCapacity: { CapacityUnits: 2 } },
    ],
  });
  const { result, lines } = await captureLogs(() => readProfileLookup({
    client,
    tableName: "state",
    profile: "home",
    operation: "list_reconciliation_mappings",
    component: "reconciliation",
    queryInput: {
      TableName: "state",
      IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
      ExpressionAttributeValues: { ":lookupPk": "PROFILE#home", ":lookupSk": "MAPPING#TASK#" },
    },
    fallback: async () => { throw new Error("fallback must not run"); },
  }));
  assert.deepEqual(result, [{ taskId: "one" }, { taskId: "two" }]);
  assert.equal(client.calls.filter((call) => call.IndexName === "ProfileLookupIndex").length, 2);
  assert.equal(client.calls[2].ExclusiveStartKey.lookupSk, "MAPPING#TASK#one");
  const telemetry = JSON.parse(lines.find((line) => line.includes("dynamodb_query_complete")));
  assert.equal(telemetry.pages, 2);
  assert.equal(telemetry.accessMethod, "query");
  assert.equal(telemetry.returnedCount, 2);
  assert.equal(telemetry.evaluatedCount, 5);
  assert.equal(telemetry.consumedCapacityUnits, 3.5);
  assert.equal(typeof telemetry.durationMs, "number");
});

test("ready recurrence lookup uses the recurrence prefix and paginates once", async () => {
  const client = fakeClient({ pages: [{ Items: [{ seriesId: "one" }], ScannedCount: 1, ConsumedCapacity: { CapacityUnits: 1 }, LastEvaluatedKey: { lookupSk: "RECURRENCE#one" } }, { Items: [{ seriesId: "two" }], ScannedCount: 1, ConsumedCapacity: { CapacityUnits: 1 } }] });
  const { result, lines } = await captureLogs(() => readProfileLookup({
    client,
    tableName: "state",
    profile: "antonio",
    operation: "list_recurrence_links",
    component: "state-repository",
    queryInput: {
      TableName: "state",
      IndexName: "ProfileLookupIndex",
      KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
      ExpressionAttributeValues: { ":lookupPk": "PROFILE#antonio", ":lookupSk": "RECURRENCE#" },
    },
    fallback: async () => { throw new Error("fallback must not run"); },
  }));
  assert.deepEqual(result, [{ seriesId: "one" }, { seriesId: "two" }]);
  assert.equal(client.calls[1].ExpressionAttributeValues[":lookupPk"], "PROFILE#antonio");
  assert.equal(client.calls[1].ExpressionAttributeValues[":lookupSk"], "RECURRENCE#");
  const telemetry = JSON.parse(lines.find((line) => line.includes("dynamodb_query_complete")));
  assert.equal(telemetry.operation, "list_recurrence_links");
  assert.equal(telemetry.accessMethod, "query");
  assert.equal(telemetry.pages, 2);
  assert.equal(telemetry.returnedCount, 2);
  assert.equal(telemetry.evaluatedCount, 2);
  assert.equal(telemetry.consumedCapacityUnits, 2);
  assert.equal(typeof telemetry.durationMs, "number");
});
