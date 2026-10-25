import assert from "node:assert/strict";
import test from "node:test";
import { StateRepository } from "../dist/repository.js";
import { documentClient } from "../dist/dynamodb-capacity.js";

process.env.STATE_TABLE_NAME ||= "test-state";

function advanceFixture() {
  const previous = {
    profile: "home", taskId: "task-1", eventId: "occurrence-1", recurrenceOwner: "calendar",
    seriesId: "series-1", masterEventId: "master-1", activeInstanceId: "occurrence-1",
    originalStart: "2026-11-04T14:00:00Z", calendarProgressVersion: 1,
    updatedAt: "2026-11-04T15:01:00.000Z",
  };
  const expectedLink = {
    profile: "home", owner: "calendar", taskId: "task-1", eventId: "occurrence-1",
    seriesId: "series-1", masterEventId: "master-1", activeInstanceId: "occurrence-1",
    calendarProgressVersion: 1, updatedAt: "2026-11-04T15:01:01.000Z",
  };
  const mapping = {
    ...previous, eventId: "occurrence-3", activeInstanceId: "occurrence-3",
    originalStart: "2026-11-18T14:00:00Z", completedThroughOriginalStart: "2026-11-04T14:00:00Z",
    updatedAt: "2026-11-04T15:02:00.000Z",
  };
  const link = {
    ...expectedLink, eventId: mapping.eventId, activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart, completedThroughOriginalStart: mapping.completedThroughOriginalStart,
    updatedAt: mapping.updatedAt,
  };
  return { previous, expectedLink, mapping, link };
}

test("Calendar recurrence advance replaces old event and progress indexes in one transaction", async (t) => {
  const fixture = advanceFixture();
  let transaction;
  t.mock.method(documentClient, "send", async (command) => {
    transaction = command.input.TransactItems;
    return {};
  });

  assert.equal(await new StateRepository().advanceCalendarSeriesMapping(fixture), true);
  const keys = transaction.flatMap((item) => Object.values(item).map((operation) =>
    `${operation.Key?.pk || operation.Item?.pk}|${operation.Key?.sk || operation.Item?.sk || ""}`));
  assert.equal(new Set(keys).size, keys.length, "the transaction must not operate on one item twice");
  assert.ok(transaction.some((item) => item.Delete?.Key.pk === "EVENT#home#occurrence-1"
    && /updatedAt = :updated/.test(item.Delete.ConditionExpression)));
  assert.ok(transaction.some((item) => item.Put?.Item.pk === "EVENT#home#occurrence-3"));
  assert.ok(transaction.some((item) => item.Put?.Item.pk === "TASK#home#task-1"
    && item.Put.Item.eventId === "occurrence-3" && /eventId = :event/.test(item.Put.ConditionExpression)));
  assert.ok(transaction.some((item) => item.Put?.Item.pk === "TASKOWNER#task-1"
    && item.Put.Item.eventId === "occurrence-3"));
  assert.ok(transaction.some((item) => item.Put?.Item.pk === "RECURRENCE#home#series-1"
    && item.Put.Item.eventId === "occurrence-3" && /updatedAt = :updated/.test(item.Put.ConditionExpression)));
});

test("Calendar recurrence advance transaction conflict is retryable and reported as false", async (t) => {
  const fixture = advanceFixture();
  t.mock.method(documentClient, "send", async () => {
    throw Object.assign(new Error("conditional transaction conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
  });

  assert.equal(await new StateRepository().advanceCalendarSeriesMapping(fixture), false);
});
