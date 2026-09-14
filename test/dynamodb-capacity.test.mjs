import assert from "node:assert/strict";
import test from "node:test";

import { estimateItemBytes, itemSizeSeverity, pacedScan, pacingDelayMs } from "../dist/dynamodb-capacity.js";

test("pacingDelayMs enforces an RCU-per-second budget", () => {
  assert.equal(pacingDelayMs(5, 100, 10), 400);
  assert.equal(pacingDelayMs(5, 600, 10), 0);
  assert.equal(pacingDelayMs(0, 0, 10), 0);
});

test("item size guardrails classify ordinary, warning and critical state records", () => {
  assert.equal(estimateItemBytes({ pk: "A", sk: "STATE" }) > 0, true);
  assert.equal(itemSizeSeverity(16 * 1024 - 1), "normal");
  assert.equal(itemSizeSeverity(16 * 1024), "warning");
  assert.equal(itemSizeSeverity(64 * 1024 - 1), "warning");
  assert.equal(itemSizeSeverity(64 * 1024), "critical");
});

test("pacedScan paginates with a bounded evaluated-item limit and consumed-capacity pacing", async () => {
  const seenInputs = [];
  const waits = [];
  const responses = [
    {
      Items: [{ pk: "A" }],
      ScannedCount: 25,
      ConsumedCapacity: { CapacityUnits: 5 },
      LastEvaluatedKey: { pk: "cursor" },
    },
    {
      Items: [{ pk: "B" }],
      ScannedCount: 10,
      ConsumedCapacity: { CapacityUnits: 2 },
    },
  ];
  const client = {
    async send(command) {
      seenInputs.push(command.input);
      return responses.shift();
    },
  };
  let clock = 0;

  const result = await pacedScan({
    TableName: "state",
    FilterExpression: "begins_with(pk, :prefix)",
    ExpressionAttributeValues: { ":prefix": "TASK#" },
  }, {
    operation: "test_scan",
    profile: "home",
    pageItemLimit: 25,
    rcuBudgetPerSecond: 10,
    jitterMs: 0,
    client,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    random: () => 0,
  });

  assert.equal(seenInputs.length, 2);
  assert.equal(seenInputs[0].Limit, 25);
  assert.equal(seenInputs[0].ReturnConsumedCapacity, "TOTAL");
  assert.deepEqual(seenInputs[1].ExclusiveStartKey, { pk: "cursor" });
  assert.deepEqual(waits, [500]);
  assert.deepEqual(result.items, [{ pk: "A" }, { pk: "B" }]);
  assert.equal(result.pages, 2);
  assert.equal(result.scannedCount, 35);
  assert.equal(result.returnedCount, 2);
  assert.equal(result.consumedCapacityUnits, 7);
  assert.equal(result.pacedDelayMs, 500);
});

test("pacedScan does not delay after the final page", async () => {
  const waits = [];
  const client = {
    async send() {
      return {
        Items: [{ pk: "A" }],
        ScannedCount: 25,
        ConsumedCapacity: { CapacityUnits: 20 },
      };
    },
  };

  await pacedScan({ TableName: "state" }, {
    operation: "single_page",
    pageItemLimit: 25,
    rcuBudgetPerSecond: 10,
    jitterMs: 0,
    client,
    now: () => 0,
    sleep: async (ms) => waits.push(ms),
  });

  assert.deepEqual(waits, []);
});
