import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";

process.env.STATE_TABLE_NAME ||= "test-future-split-state";
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
    assert.ok(checks.every((item) => item.ConditionExpression === "attribute_not_exists(pk)"));
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
