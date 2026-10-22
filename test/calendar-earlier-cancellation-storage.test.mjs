import assert from "node:assert/strict";
import test from "node:test";

process.env.STATE_TABLE_NAME ||= "test-earlier-cancellation-state";
const { documentClient } = await import("../dist/dynamodb-capacity.js");
const { StateRepository } = await import("../dist/repository.js");

const link = {
  profile: "home", owner: "calendar", seriesId: "series-a", masterEventId: "master-a",
  activeInstanceId: "master-a_20991021", eventId: "master-a_20991021",
  taskId: "task-current", updatedAt: "2099-10-21T00:00:00Z",
};
const olderId = "master-a_20991020";
const stale = {
  profile: "home", eventId: olderId, taskId: "task-old", recurrenceOwner: "calendar",
  seriesId: link.seriesId, masterEventId: link.masterEventId,
  updatedAt: "2099-10-20T00:00:00Z",
};

async function withDynamo(mock, run) {
  const original = documentClient.send;
  const calls = [];
  documentClient.send = async (command) => {
    calls.push(command);
    if (command.constructor.name === "GetCommand") {
      assert.equal(command.input.ConsistentRead, true);
      assert.equal(command.input.Key.pk, `CANONICAL#home#calendar#${olderId}`);
      return mock.canonical ? { Item: {
        pk: command.input.Key.pk, sk: "STATE", profile: "home", side: "calendar",
        providerId: olderId,
        identity: { normalizedTitle: "old reminder", normalizedStart: "2099-10-20", allDay: true },
        updatedAt: "2099-10-20T00:00:00.000Z",
        ...(typeof mock.canonical === "object" ? mock.canonical : {}),
      } } : {};
    }
    if (command.constructor.name === "TransactWriteCommand") {
      if (mock.changedCanonical) {
        const canonicalDelete = command.input.TransactItems
          .find((item) => item.Delete?.Key.pk === `CANONICAL#home#calendar#${olderId}`).Delete;
        assert.match(canonicalDelete.ConditionExpression, /updatedAt = :canonicalUpdated/);
        assert.match(canonicalDelete.ConditionExpression, /#identity = :canonicalIdentity/);
        const observed = canonicalDelete.ExpressionAttributeValues;
        if (mock.changedCanonical.updatedAt !== observed[":canonicalUpdated"]
          || JSON.stringify(mock.changedCanonical.identity) !== JSON.stringify(observed[":canonicalIdentity"])) {
          throw Object.assign(new Error("concurrent canonical identity replacement"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        }
      }
      if (mock.error) throw mock.error;
      return {};
    }
    throw new Error("Unexpected DynamoDB command " + command.constructor.name);
  };
  try { await run(calls); } finally { documentClient.send = original; }
}

test("earlier cancellation protects all live indexes and removes only old occurrence state", async () => {
  await withDynamo({ canonical: true }, async (calls) => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, olderId, stale), true);
    const transaction = calls.find((c) => c.constructor.name === "TransactWriteCommand");
    const items = transaction.input.TransactItems;
    assert.deepEqual(items.filter((x) => x.ConditionCheck).map((x) => x.ConditionCheck.Key.pk), [
      "RECURRENCE#home#series-a", "EVENT#home#master-a_20991021",
      "TASK#home#task-current", "TASKOWNER#task-current",
    ]);
    assert.deepEqual(items.filter((x) => x.Delete).map((x) => x.Delete.Key.pk), [
      `EVENT#home#${olderId}`, `CANONICAL#home#calendar#${olderId}`,
      "TASK#home#task-old", "TASKOWNER#task-old",
    ]);
    assert.ok(items.filter((x) => x.ConditionCheck).every((x) =>
      x.ConditionCheck.ExpressionAttributeValues[":active"] === link.activeInstanceId));
    const oldEventDelete = items.find((x) => x.Delete?.Key.pk === `EVENT#home#${olderId}`).Delete;
    assert.equal(oldEventDelete.ExpressionAttributeValues[":oldUpdated"], stale.updatedAt);
    assert.match(oldEventDelete.ConditionExpression, /recurrenceOwner = :owner/);
    const canonicalDelete = items.find((x) => x.Delete?.Key.pk === `CANONICAL#home#calendar#${olderId}`).Delete;
    assert.match(canonicalDelete.ConditionExpression, /updatedAt = :canonicalUpdated/);
    assert.match(canonicalDelete.ConditionExpression, /#identity = :canonicalIdentity/);
    assert.equal(canonicalDelete.ExpressionAttributeValues[":canonicalProvider"], olderId);
    assert.equal(canonicalDelete.ExpressionAttributeValues[":canonicalUpdated"], "2099-10-20T00:00:00.000Z");
    assert.deepEqual(canonicalDelete.ExpressionAttributeValues[":canonicalIdentity"], {
      normalizedTitle: "old reminder", normalizedStart: "2099-10-20", allDay: true,
    });
    const oldTaskDeletes = items.filter((x) => x.Delete?.Key.pk.includes("task-old"));
    assert.ok(oldTaskDeletes.every((x) => x.Delete.ConditionExpression.includes("eventId = :oldEvent")));
  });
});

test("an old EVENT row for the same task never deletes the active TASK and TASKOWNER indexes", async () => {
  await withDynamo({ canonical: false }, async (calls) => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(
      link, olderId, { ...stale, taskId: link.taskId },
    ), true);
    const deletes = calls.find((c) => c.constructor.name === "TransactWriteCommand")
      .input.TransactItems.filter((item) => item.Delete).map((item) => item.Delete.Key.pk);
    assert.deepEqual(deletes, [`EVENT#home#${olderId}`, `CANONICAL#home#calendar#${olderId}`]);
    const canonicalDelete = calls.find((c) => c.constructor.name === "TransactWriteCommand")
      .input.TransactItems.find((item) => item.Delete?.Key.pk === `CANONICAL#home#calendar#${olderId}`).Delete;
    assert.equal(canonicalDelete.ConditionExpression, "attribute_not_exists(pk)");
  });
});

test("already-purged occurrence is idempotent and does not consume a write transaction", async () => {
  await withDynamo({ canonical: false }, async (calls) => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, olderId), false);
    assert.equal(calls.filter((item) => item.constructor.name === "TransactWriteCommand").length, 0);
  });
});

test("identity-only cleanup requires that the obsolete EVENT row is still absent", async () => {
  await withDynamo({ canonical: true }, async (calls) => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, olderId), true);
    const oldEventDelete = calls.find((item) => item.constructor.name === "TransactWriteCommand")
      .input.TransactItems.find((item) => item.Delete?.Key.pk === `EVENT#home#${olderId}`).Delete;
    assert.equal(oldEventDelete.ConditionExpression, "attribute_not_exists(pk)");
    const canonicalDelete = calls.find((item) => item.constructor.name === "TransactWriteCommand")
      .input.TransactItems.find((item) => item.Delete?.Key.pk === `CANONICAL#home#calendar#${olderId}`).Delete;
    assert.match(canonicalDelete.ConditionExpression, /updatedAt = :canonicalUpdated/);
  });
});

test("changed canonical identity or version aborts the entire stale-occurrence purge", async () => {
  const newer = {
    updatedAt: "2099-10-21T01:00:00.000Z",
    identity: { normalizedTitle: "new reminder", normalizedStart: "2099-10-21", allDay: true },
  };
  await withDynamo({ canonical: true, changedCanonical: newer }, async (calls) => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, olderId, stale), false);
    assert.equal(calls.filter((c) => c.constructor.name === "TransactWriteCommand").length, 1);
  });
});

test("canonical row with unverified ownership fails closed before any transaction", async () => {
  await withDynamo({ canonical: { providerId: "other-event" } }, async (calls) => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, olderId, stale), false);
    assert.equal(calls.filter((c) => c.constructor.name === "TransactWriteCommand").length, 0);
  });
});

test("mapping changes during cancellation are treated as no-op, not destructive cleanup", async () => {
  const error = Object.assign(new Error("condition rejected"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
  await withDynamo({ canonical: true, error }, async () => {
    assert.equal(await new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, olderId, stale), false);
  });
});

test("the active instance or master can never be purged as an earlier occurrence", async () => {
  await withDynamo({ canonical: true }, async (calls) => {
    await assert.rejects(
      () => new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, link.activeInstanceId),
      /distinct, same-series inactive event/,
    );
    await assert.rejects(
      () => new StateRepository().purgeEarlierCancelledCalendarOccurrence(link, link.masterEventId),
      /distinct, same-series inactive event/,
    );
    assert.equal(calls.length, 0);
  });
});
