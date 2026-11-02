import test from "node:test";
import assert from "node:assert/strict";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";

const state = new StateRepository();
const now = () => new Date().toISOString();
const completion = (changes = {}) => ({
  profile: "home", taskId: "fence-task", eventId: "fence-event",
  completedAt: new Date(Date.now() - 60_000).toISOString(), ...changes,
});
const mapping = (changes = {}) => ({
  profile: "home", taskId: "fence-task", eventId: "fence-event", updatedAt: now(), ...changes,
});

test("uncompletion submits only used DynamoDB expression values and checks every legacy recurrence marker", async () => {
  const original = documentClient.send;
  let submitted;
  documentClient.send = async (command) => {
    if (command instanceof GetCommand) return { Item: completion() };
    if (command instanceof TransactWriteCommand) { submitted = command.input.TransactItems; return {}; }
    throw new Error("Unexpected operation: " + command.constructor.name);
  };
  try {
    assert.equal(await state.reopenRetainedStandaloneMapping(mapping(), now()), true);
    assert.equal(submitted.length, 6);
    for (const item of submitted) {
      const op = item.Delete || item.ConditionCheck;
      const expression = op.ConditionExpression;
      for (const attribute of Object.keys(op.ExpressionAttributeValues || {})) {
        assert.ok(expression.includes(attribute), "unused attribute " + attribute + " in " + expression);
      }
      if (op.Key.pk.startsWith("COMPLETED_") || op.Key.sk === "MAP") {
        for (const marker of ["recurrenceOwner", "recurrenceId", "seriesId",
          "masterEventId", "activeInstanceId", "originalStart", "activeEffectiveStart"]) {
          assert.match(expression, new RegExp("attribute_not_exists\\(" + marker + "\\)"));
        }
      }
    }
  } finally { documentClient.send = original; }
});

test("legacy recurrence fields cannot reopen a completed standalone mapping", async () => {
  const original = documentClient.send;
  let writes = 0;
  let history = completion();
  documentClient.send = async (command) => {
    if (command instanceof GetCommand) return { Item: history };
    if (command instanceof TransactWriteCommand) { writes++; return {}; }
    throw new Error("Unexpected operation");
  };
  try {
    for (const marker of ["recurrenceOwner", "recurrenceId", "seriesId", "masterEventId",
      "activeInstanceId", "originalStart", "activeEffectiveStart"]) {
      assert.equal(await state.reopenRetainedStandaloneMapping(mapping({ [marker]: "legacy" }), now()), false, marker);
    }
    for (const marker of ["recurrenceOwner", "recurrenceId", "seriesId", "masterEventId",
      "activeInstanceId", "originalStart"]) {
      history = completion({ [marker]: "legacy" });
      assert.equal(await state.reopenRetainedStandaloneMapping(mapping(), now()), false, marker);
    }
    history = completion({ completedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString() });
    assert.equal(await state.reopenRetainedStandaloneMapping(mapping(), now()), false, "expired grace");
    assert.equal(writes, 0);
  } finally { documentClient.send = original; }
});

test("an in-flight Calendar write prevents completion from committing a guard", async () => {
  const original = documentClient.send;
  let lease;
  let guard;
  documentClient.send = async (command) => {
    const input = command.input;
    if (command instanceof PutCommand) {
      assert.equal(input.Item.pk, "CALENDAR_WRITE#fence-task");
      if (lease) throw Object.assign(new Error("leased"), { name: "ConditionalCheckFailedException" });
      lease = input.Item;
      return {};
    }
    if (command instanceof DeleteCommand) {
      assert.equal(input.Key.pk, "CALENDAR_WRITE#fence-task");
      assert.equal(input.ExpressionAttributeValues[":token"], lease.token);
      lease = undefined;
      return {};
    }
    if (command instanceof GetCommand) return { Item: guard };
    if (command instanceof TransactWriteCommand) {
      const [check, ...puts] = input.TransactItems;
      assert.equal(check.ConditionCheck.Key.pk, "CALENDAR_WRITE#fence-task");
      assert.ok(check.ConditionCheck.ConditionExpression.includes("leaseUntilMs < :now"));
      if (lease) {
        const error = Object.assign(new Error("Calendar write in flight"), {
          name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        });
        throw error;
      }
      assert.ok(puts.some((item) => item.Put?.Item.pk === "COMPLETED_EVENT#home#fence-event"));
      guard = completion();
      return {};
    }
    throw new Error("Unexpected operation: " + command.constructor.name);
  };
  try {
    const token = await state.beginTodoistCalendarWrite("fence-task");
    await assert.rejects(state.putCompletedCalendarProjection(completion()), { name: "TransactionCanceledException" });
    assert.equal(guard, undefined, "the completion guard cannot commit during a Calendar write");
    await state.endTodoistCalendarWrite("fence-task", token);
    await state.putCompletedCalendarProjection(completion());
    assert.equal(guard.eventId, "fence-event");
  } finally { documentClient.send = original; }
});

test("Calendar write lease release aliases the reserved DynamoDB token field", async () => {
  const original = documentClient.send;
  let attempted = 0;
  documentClient.send = async (command) => {
    assert.ok(command instanceof DeleteCommand);
    attempted++;
    assert.equal(command.input.Key.pk, "CALENDAR_WRITE#fence-task");
    assert.equal(command.input.ConditionExpression, "#token = :token");
    assert.deepEqual(command.input.ExpressionAttributeNames, { "#token": "token" });
    assert.deepEqual(command.input.ExpressionAttributeValues, { ":token": "lease-owner-token" });
    return {};
  };
  try {
    await state.endTodoistCalendarWrite("fence-task", "lease-owner-token");
    assert.equal(attempted, 1);
  } finally {
    documentClient.send = original;
  }
});

test("Calendar write lease release still ignores a replaced lease but propagates other errors", async () => {
  const original = documentClient.send;
  let error = Object.assign(new Error("Lease owned by another worker"), { name: "ConditionalCheckFailedException" });
  documentClient.send = async (command) => {
    assert.ok(command instanceof DeleteCommand);
    throw error;
  };
  try {
    await state.endTodoistCalendarWrite("fence-task", "old-token");
    error = Object.assign(new Error("DynamoDB unavailable"), { name: "ValidationException" });
    await assert.rejects(state.endTodoistCalendarWrite("fence-task", "old-token"), /DynamoDB unavailable/);
  } finally {
    documentClient.send = original;
  }
});
