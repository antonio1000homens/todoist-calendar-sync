import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { StateRepository } from "../dist/repository.js";
import { documentClient } from "../dist/dynamodb-capacity.js";

const link = {
  profile: "home",
  owner: "calendar",
  taskId: "task-1",
  eventId: "occurrence-1",
  seriesId: "series-1",
  masterEventId: "master-1",
  activeInstanceId: "occurrence-1",
  calendarProgressVersion: 1,
  updatedAt: "2026-11-04T15:01:01.000Z",
};
const firstCompleted = "2026-11-04T14:00:00Z";
const mappedCompleted = "2026-11-11T14:00:00Z";
const incomingCompleted = "2026-11-18T14:00:00Z";
const concurrentlyCompleted = "2026-11-25T14:00:00Z";

function existingRow(completedThroughOriginalStart = firstCompleted) {
  return { ...link, completedThroughOriginalStart };
}

function stubRecurrenceReads(t, { currentRow } = {}) {
  const reads = [];
  return {
    reads,
    respond(command) {
      if (!(command instanceof GetCommand)) return undefined;
      reads.push(command.input);
      assert.equal(command.input.ConsistentRead, true, "progress and mapping reads must be strongly consistent");
      if (command.input.Key.pk === "RECURRENCE#home#series-1") {
        return { Item: currentRow?.() };
      }
      if (command.input.Key.pk === "TASK#home#task-1") {
        return { Item: { ...link, recurrenceOwner: "calendar", completedThroughOriginalStart: mappedCompleted } };
      }
      throw new Error("unexpected DynamoDB read: " + command.input.Key.pk);
    },
  };
}

test("Calendar recurrence-link CAS retries against the latest persisted progress", async (t) => {
  const writes = [];
  let concurrentlyAdvanced = false;
  const db = stubRecurrenceReads(t, {
    currentRow: () => existingRow(concurrentlyAdvanced ? concurrentlyCompleted : firstCompleted),
  });
  t.mock.method(documentClient, "send", async (command) => {
    if (command instanceof GetCommand) return db.respond(command);
    assert.ok(command instanceof PutCommand);
    writes.push(command.input);
    if (writes.length === 1) {
      concurrentlyAdvanced = true;
      throw Object.assign(new Error("lost a CAS race"), { name: "ConditionalCheckFailedException" });
    }
    return {};
  });

  await new StateRepository().putRecurrenceLink({
    ...link, completedThroughOriginalStart: incomingCompleted,
  });

  assert.equal(writes.length, 2, "one conditional conflict should cause one fresh attempt");
  assert.equal(db.reads.length, 4, "each attempt must re-read the link and task mapping");
  assert.equal(writes[0].Item.completedThroughOriginalStart, incomingCompleted);
  assert.equal(writes[1].Item.completedThroughOriginalStart, concurrentlyCompleted,
    "a concurrent later completion must not be moved backwards");
  assert.equal(writes[0].ExpressionAttributeValues[":expectedCompletedThroughOriginalStart"], firstCompleted);
  assert.equal(writes[1].ExpressionAttributeValues[":expectedCompletedThroughOriginalStart"], concurrentlyCompleted);
  for (const write of writes) {
    assert.match(write.ConditionExpression, /completedThroughOriginalStart = :expectedCompletedThroughOriginalStart/);
    assert.match(write.ConditionExpression, /calendarProgressVersion = :expectedCalendarProgressVersion/);
    assert.equal(write.ExpressionAttributeValues[":expectedCalendarProgressVersion"], 1);
    assert.equal(write.Item.calendarProgressVersion, 1);
  }
});

test("a new Calendar-owned recurrence link requires absent progress fields", async (t) => {
  const writes = [];
  const reads = [];
  t.mock.method(documentClient, "send", async (command) => {
    if (command instanceof GetCommand) {
      reads.push(command.input);
      assert.equal(command.input.ConsistentRead, true);
      return { Item: undefined };
    }
    assert.ok(command instanceof PutCommand);
    writes.push(command.input);
    return {};
  });

  await new StateRepository().putRecurrenceLink({
    ...link, calendarProgressVersion: undefined, completedThroughOriginalStart: incomingCompleted,
  });

  assert.equal(reads.length, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].Item.completedThroughOriginalStart, incomingCompleted);
  assert.match(writes[0].ConditionExpression, /attribute_not_exists\(completedThroughOriginalStart\)/);
  assert.match(writes[0].ConditionExpression, /attribute_not_exists\(calendarProgressVersion\)/);
});

test("Calendar recurrence-link persistence has a bounded retry policy", async (t) => {
  let writes = 0;
  t.mock.method(documentClient, "send", async (command) => {
    if (command instanceof GetCommand) {
      assert.equal(command.input.ConsistentRead, true);
      return { Item: existingRow() };
    }
    assert.ok(command instanceof PutCommand);
    writes += 1;
    throw Object.assign(new Error("concurrent writer keeps winning"), {
      name: "ConditionalCheckFailedException",
    });
  });

  await assert.rejects(
    new StateRepository().putRecurrenceLink({
      ...link, completedThroughOriginalStart: incomingCompleted,
    }),
    { name: "ConditionalCheckFailedException" },
  );
  assert.equal(writes, 5, "repeated races must fail closed after the configured retry limit");
});
