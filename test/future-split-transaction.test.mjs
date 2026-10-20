import assert from "node:assert/strict";
import test from "node:test";
process.env.STATE_TABLE_NAME ||= "test-future-split-state";
const { documentClient } = await import("../dist/dynamodb-capacity.js");
const { StateRepository } = await import("../dist/repository.js");
const mapping = {
  profile: "antonio", projectId: "home-project", taskId: "smoke-task",
  eventId: "new-series", recurrenceOwner: "todoist", seriesId: "smoke-task",
  masterEventId: "new-series", activeInstanceId: "new-series_20270701",
  updatedAt: "2026-10-19T21:00:00Z",
};
const link = {
  profile: "antonio", owner: "todoist", seriesId: "smoke-task",
  masterEventId: "new-series", activeInstanceId: "new-series_20270701",
  taskId: "smoke-task", eventId: "new-series", updatedAt: mapping.updatedAt,
};

test("future mapping transaction conditionally claims owner, mapping indexes and recurrence link together", async () => {
  const original = documentClient.send;
  let captured;
  documentClient.send = async (command) => { captured = command; return {}; };
  try {
    assert.equal(await new StateRepository().putNewRecurrenceMappingIfUnowned(mapping, link), true);
    assert.equal(captured.constructor.name, "TransactWriteCommand");
    const writes = captured.input.TransactItems;
    const puts = writes.filter((item) => item.Put).map((item) => item.Put);
    const checks = writes.filter((item) => item.ConditionCheck).map((item) => item.ConditionCheck);
    assert.deepEqual(puts.map((item) => item.Item.pk).sort(), [
      "EVENT#antonio#new-series", "RECURRENCE#antonio#smoke-task",
      "TASK#antonio#smoke-task", "TASKOWNER#smoke-task",
    ]);
    assert.ok(puts.every((item) => item.ConditionExpression === "attribute_not_exists(pk)"));
    assert.ok(checks.some((item) => item.Key.pk === "PROJECTION#antonio#TASK#smoke-task"));
    assert.ok(checks.some((item) => item.Key.pk === "COMPLETED_EVENT#antonio#new-series"));
    assert.ok(checks.some((item) => item.Key.pk === "TASK#work#smoke-task"));
    assert.ok(checks.some((item) => item.Key.pk === "PROJECTION#work#TASK#smoke-task"));
    const guard = checks.find((item) => item.Key.pk === "FUTURE_SPLIT#TASK#smoke-task");
    assert.equal(guard.ConditionExpression, "#status = :pending AND profile = :profile AND newMasterId = :master");
    assert.equal(guard.ExpressionAttributeValues[":pending"], "pending");
    assert.equal(guard.ExpressionAttributeValues[":master"], mapping.eventId);
    assert.ok(checks.filter((item) => item !== guard)
      .every((item) => item.ConditionExpression === "attribute_not_exists(pk)"));
  } finally { documentClient.send = original; }
});

test("split transaction treats concurrent ownership race as refusal, not a success", async () => {
  const original = documentClient.send;
  documentClient.send = async () => {
    throw Object.assign(new Error("race"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
  };
  try {
    assert.equal(await new StateRepository().putNewRecurrenceMappingIfUnowned(mapping, link), false);
  } finally { documentClient.send = original; }
});

test("non-conditional transaction failures propagate for operator recovery", async () => {
  const original = documentClient.send;
  documentClient.send = async () => {
    throw Object.assign(new Error("throughput"), { name: "ProvisionedThroughputExceededException" });
  };
  try {
    await assert.rejects(
      new StateRepository().putNewRecurrenceMappingIfUnowned(mapping, link), /throughput/,
    );
  } finally { documentClient.send = original; }
});

test("existing master/instance mappings and completed history are examined before any Calendar cap", async () => {
  const original = documentClient.send;
  let queries = 0;
  documentClient.send = async (cmd) => {
    const pk = cmd.input?.Key?.pk;
    if (cmd.constructor.name === "GetCommand") return {};
    if (cmd.constructor.name === "ScanCommand") return { Items: [], ScannedCount: 1 };
    if (cmd.constructor.name === "QueryCommand") {
      queries += 1;
      if (cmd.input.ExpressionAttributeValues[":lookupSk"] === "MAPPING#TASK#"
        && cmd.input.ExpressionAttributeValues[":lookupPk"] === "PROFILE#work") {
        return { Items: [{
          profile: "work", taskId: "different-task",
          eventId: "old-instance", masterEventId: "old-master",
        }] };
      }
      return { Items: [] };
    }
    throw new Error("Unexpected query");
  };
  try {
    await assert.rejects(
      new StateRepository().assertHistoricalSeriesUnowned("old-master", ["old-instance"]),
      /mapping still owns/,
    );
    assert.ok(queries > 0);
  } finally { documentClient.send = original; }
});

test("completed instance history in another profile blocks historical master reuse", async () => {
  const original = documentClient.send;
  documentClient.send = async (cmd) => {
    const pk = cmd.input?.Key?.pk;
    if (cmd.constructor.name === "GetCommand") {
      if (pk === "COMPLETED_EVENT#work#old-instance") {
        return { Item: { completedAt: "2026-01-01", taskId: "other-task" } };
      }
      return {};
    }
    if (cmd.constructor.name === "QueryCommand") return { Items: [] };
    if (cmd.constructor.name === "ScanCommand") return { Items: [], ScannedCount: 1 };
    throw new Error("Unexpected query");
  };
  try {
    await assert.rejects(
      new StateRepository().assertHistoricalSeriesUnowned("old-master", ["old-instance"]),
      /completed task history/,
    );
  } finally { documentClient.send = original; }
});
