import assert from "node:assert/strict";
import test from "node:test";

process.env.STATE_TABLE_NAME ||= "test-recovery-state";
const { documentClient } = await import("../dist/dynamodb-capacity.js");
const { StateRepository } = await import("../dist/repository.js");

const baseMapping = {
  profile: "home", projectId: "test-home-project", taskId: "task-1", eventId: "event-1",
  updatedAt: "2026-09-03T19:00:00Z",
};
function stubDynamo(mapping = baseMapping, other = {}) {
  const original = documentClient.send;
  const calls = [];
  documentClient.send = async (command) => {
    calls.push(command);
    const type = command.constructor.name;
    if (type === "GetCommand") {
      const pk = command.input.Key.pk;
      if (pk === "EVENT#home#event-1") return { Item: mapping };
      if (other[pk]) return { Item: other[pk] };
      return {};
    }
    if (type === "TransactWriteCommand") return {};
    throw new Error(`unexpected command: ${type}`);
  };
  return {
    calls,
    restore() { documentClient.send = original; },
  };
}

test("index repair transaction guards EVENT identity and all competing profile indexes", async () => {
  const stub = stubDynamo();
  try {
    assert.equal(await new StateRepository().restoreMappingIndexesIfOwned(baseMapping), true);
    const transaction = stub.calls.find((x) => x.constructor.name === "TransactWriteCommand");
    assert.ok(transaction);
    const writes = transaction.input.TransactItems;
    const checks = writes.filter((x) => x.ConditionCheck).map((x) => x.ConditionCheck);
    const puts = writes.filter((x) => x.Put).map((x) => x.Put);
    assert.deepEqual(puts.map((p) => p.Item.pk).sort(), ["TASK#home#task-1", "TASKOWNER#task-1"]);
    assert.equal(checks.find((x) => x.Key.pk === "EVENT#home#event-1")
      .ExpressionAttributeValues[":updated"], baseMapping.updatedAt);
    for (const pk of [
      "PROJECTION#home#TASK#task-1", "COMPLETED_EVENT#home#event-1",
      "TASK#antonio#task-1", "TASK#work#task-1",
    ]) {
      assert.equal(checks.find((x) => x.Key.pk === pk)?.ConditionExpression, "attribute_not_exists(pk)");
    }
    assert.ok(puts.every((x) => x.ConditionExpression.includes("attribute_not_exists(pk)")
      && x.ConditionExpression.includes("taskId = :task")));
    assert.ok(stub.calls.filter((x) => x.constructor.name === "GetCommand")
      .every((x) => x.input.ConsistentRead === true));
  } finally {
    stub.restore();
  }
});

test("recovery refuses an already-owned task in another profile without attempting writes", async () => {
  const stub = stubDynamo(baseMapping, {
    "TASKOWNER#task-1": { ...baseMapping, profile: "work", eventId: "work-event" },
  });
  try {
    assert.equal(await new StateRepository().restoreMappingIndexesIfOwned(baseMapping), false);
    assert.equal(stub.calls.some((x) => x.constructor.name === "TransactWriteCommand"), false);
  } finally {
    stub.restore();
  }
});

test("recovery refuses a stale task index even if global owner is absent", async () => {
  const stub = stubDynamo(baseMapping, {
    "TASK#work#task-1": { ...baseMapping, profile: "work", eventId: "work-event" },
  });
  try {
    assert.equal(await new StateRepository().restoreMappingIndexesIfOwned(baseMapping), false);
    assert.equal(stub.calls.some((x) => x.constructor.name === "TransactWriteCommand"), false);
  } finally {
    stub.restore();
  }
});

test("concurrent ownership change cancels transaction rather than clobbering TASKOWNER", async () => {
  const stub = stubDynamo();
  const original = documentClient.send;
  documentClient.send = async (command) => {
    if (command.constructor.name === "TransactWriteCommand") {
      throw Object.assign(new Error("conditional transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" }, { Code: "None" }, { Code: "None" },
          { Code: "None" }, { Code: "ConditionalCheckFailed" },
        ],
      });
    }
    return original(command);
  };
  try {
    assert.equal(await new StateRepository().restoreMappingIndexesIfOwned(baseMapping), false);
  } finally {
    stub.restore();
  }
});

test("transient transaction failure is not silently treated as an ownership conflict", async () => {
  const stub = stubDynamo();
  const original = documentClient.send;
  documentClient.send = async (command) => {
    if (command.constructor.name === "TransactWriteCommand") {
      throw Object.assign(new Error("throughput"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }],
      });
    }
    return original(command);
  };
  try {
    await assert.rejects(new StateRepository().restoreMappingIndexesIfOwned(baseMapping), /throughput/);
  } finally {
    stub.restore();
  }
});

test("same task and event IDs with newer owner version are not overwritten", async () => {
  const stub = stubDynamo(baseMapping, {
    "TASKOWNER#task-1": { ...baseMapping, updatedAt: "2026-09-03T20:00:00Z" },
  });
  try {
    assert.equal(await new StateRepository().restoreMappingIndexesIfOwned(baseMapping), false);
    assert.equal(stub.calls.some((x) => x.constructor.name === "TransactWriteCommand"), false);
  } finally {
    stub.restore();
  }
});
