import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";

function stateDb(t, beforeComplete = async () => {}) {
  const rows = new Map();
  const keyOf = key => `${key.pk}|${key.sk}`;
  let ranCompletionHook = false;
  t.mock.method(documentClient, "send", async command => {
    const input = command.input;
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(keyOf(input.Key))) };
    assert.ok(command instanceof UpdateCommand, `unexpected command ${command.constructor.name}`);
    const key = keyOf(input.Key);
    const row = rows.get(key) || { ...input.Key };
    const values = input.ExpressionAttributeValues || {};
    const condition = input.ConditionExpression || "";
    const now = Date.now();

    if (condition.includes("calendarSyncChannel") && condition.includes("calendarSyncMessageNumber")) {
      const newer = !row.calendarSyncChannel || row.calendarSyncChannel !== values[":channel"]
        || row.calendarSyncMessageNumber === undefined || row.calendarSyncMessageNumber < values[":messageNumber"];
      if (!newer) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      row.calendarSyncChannel = values[":channel"];
      row.calendarSyncMessageNumber = values[":messageNumber"];
      row.calendarSyncGeneration = (row.calendarSyncGeneration || 0) + 1;
      row.lastNotificationAt = values[":receivedAt"];
    } else if (input.UpdateExpression.includes("if_not_exists(calendarSyncGeneration")) {
      row.calendarSyncGeneration = (row.calendarSyncGeneration || 0) + 1;
      row.lastNotificationAt = values[":receivedAt"];
    } else if (condition.includes("calendarSyncRunningGeneration = :generation")) {
      if (values[":current"] !== undefined && !ranCompletionHook) {
        ranCompletionHook = true;
        await beforeComplete();
      }
      if (row.calendarSyncState !== "running" || row.calendarSyncRunningGeneration !== values[":generation"]
        || values[":current"] !== undefined && row.calendarSyncGeneration !== values[":current"])
        throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      if (values[":state"] !== undefined) {
        row.calendarSyncState = values[":state"];
        row.calendarSyncCompletedGeneration = values[":generation"];
      } else {
        row.calendarSyncState = values[":failed"];
        row.calendarSyncFailedGeneration = values[":generation"];
      }
      delete row.calendarSyncLeaseUntil;
      delete row.calendarSyncRunningGeneration;
      delete row.calendarSyncQueuedGeneration;
    } else if (condition.includes("calendarSyncGeneration = :current")) {
      const canStart = (row.calendarSyncState === "queued" || row.calendarSyncState === "dispatching")
          && row.calendarSyncQueuedGeneration === values[":queuedGeneration"]
        || row.calendarSyncState === "idle" || row.calendarSyncState === "pending";
      if (row.calendarSyncGeneration !== values[":current"] || !canStart)
        throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      row.calendarSyncState = values[":running"];
      row.calendarSyncRunningGeneration = values[":generation"];
      delete row.calendarSyncLeaseUntil;
    } else if (condition.includes("calendarSyncState IN")) {
      const expired = ["queued", "dispatching"].includes(row.calendarSyncState)
        && (!row.calendarSyncLeaseUntil || row.calendarSyncLeaseUntil <= values[":now"]);
      const eligible = !row.calendarSyncState || row.calendarSyncState === "pending"
        || row.calendarSyncState === "idle"
        || row.calendarSyncState === "failed" && row.calendarSyncFailedGeneration < values[":generation"]
        || expired;
      if (row.calendarSyncGeneration !== values[":generation"] || !eligible)
        throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      row.calendarSyncState = values[":dispatching"];
      row.calendarSyncQueuedGeneration = values[":generation"];
      row.calendarSyncLeaseUntil = values[":lease"];
    } else if (condition.includes("calendarSyncState = :dispatching AND calendarSyncQueuedGeneration")) {
      if (row.calendarSyncState !== "dispatching" || row.calendarSyncQueuedGeneration !== values[":generation"])
        throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      row.calendarSyncState = values[":queued"];
      row.calendarSyncLeaseUntil = values[":lease"];
    } else if (condition.includes("calendarSyncState = :running")) {
      if (row.calendarSyncState !== "running")
        throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
      row.calendarSyncState = values[":pending"];
      delete row.calendarSyncLeaseUntil;
      delete row.calendarSyncRunningGeneration;
      delete row.calendarSyncQueuedGeneration;
    } else if (input.UpdateExpression.includes("calendarSyncState = :pending")) {
      row.calendarSyncState = values[":pending"];
      delete row.calendarSyncLeaseUntil;
    } else {
      throw new Error(`unhandled update: ${input.UpdateExpression}`);
    }
    rows.set(key, row);
    return { Attributes: structuredClone(row) };
  });
  return rows;
}

test("notifications during a Calendar pass force a serialized follow-up generation", async t => {
  const rows = stateDb(t);
  const repo = new StateRepository();
  const first = await repo.markCalendarWatchNotification("home", "t1", "channel-a", "1");
  const claimed = await repo.claimCalendarSyncDispatch("home");
  assert.equal(claimed, first);
  await repo.markCalendarSyncQueued("home", first);
  const processing = await repo.startCalendarSync("home", first);
  assert.equal(processing, first);

  const duringPass = await repo.markCalendarWatchNotification("home", "t2", "channel-a", "2");
  assert.equal(duringPass, first + 1);
  assert.equal(await repo.completeCalendarSync("home", processing), true);

  const followUp = await repo.claimCalendarSyncDispatch("home");
  assert.equal(followUp, duringPass);
  await repo.markCalendarSyncQueued("home", followUp);
  const nextPass = await repo.startCalendarSync("home", followUp);
  assert.equal(nextPass, followUp);
  assert.equal(await repo.completeCalendarSync("home", nextPass), false);
  const row = [...rows.values()][0];
  assert.equal(row.calendarSyncState, "idle");
  assert.equal(row.calendarSyncCompletedGeneration, followUp);
});

test("one hundred pushes before a pass are covered by one claimed sync at the latest generation", async t => {
  const rows = stateDb(t);
  const repo = new StateRepository();
  let claims = 0;
  for (let number = 1; number <= 100; number++) {
    await repo.markCalendarWatchNotification("work", `t${number}`, "work-channel", String(number));
    const claim = await repo.claimCalendarSyncDispatch("work");
    if (claim !== undefined) {
      claims++;
      await repo.markCalendarSyncQueued("work", claim);
    }
  }
  assert.equal(claims, 1);
  const active = await repo.startCalendarSync("work", 1);
  assert.equal(active, 100);
  assert.equal(await repo.completeCalendarSync("work", active), false);
  const row = [...rows.values()][0];
  assert.equal(row.calendarSyncState, "idle");
  assert.equal(row.calendarSyncCompletedGeneration, 100);
});

test("notification racing the final completion compare-and-swap cannot be cleared", async t => {
  let repo;
  let deliverPush;
  const rows = stateDb(t, async () => deliverPush?.());
  repo = new StateRepository();
  const generation = await repo.markCalendarWatchNotification("home", "t1", "channel-a", "1");
  await repo.claimCalendarSyncDispatch("home");
  await repo.markCalendarSyncQueued("home", generation);
  const processing = await repo.startCalendarSync("home", generation);
  deliverPush = () => repo.markCalendarWatchNotification("home", "t2", "channel-a", "2");

  assert.equal(await repo.completeCalendarSync("home", processing), true);
  const row = [...rows.values()][0];
  assert.equal(row.calendarSyncGeneration, generation + 1);
  assert.equal(row.calendarSyncCompletedGeneration, generation);
  assert.equal(row.calendarSyncState, "pending");
});

test("duplicate notifications are coalesced and watch rotation preserves dirty work", async t => {
  const rows = stateDb(t);
  const repo = new StateRepository();
  const first = await repo.markCalendarWatchNotification("antonio", "t1", "old-channel", "10");
  assert.equal(await repo.markCalendarWatchNotification("antonio", "t2", "old-channel", "10"), first);
  assert.equal(await repo.markCalendarWatchNotification("antonio", "t3", "new-channel", "1"), first + 1);
  assert.equal(await repo.markCalendarWatchNotification("antonio", "t4", "new-channel", "1"), first + 1);

  const claim = await repo.claimCalendarSyncDispatch("antonio");
  assert.equal(claim, first + 1);
  assert.equal(await repo.claimCalendarSyncDispatch("antonio"), undefined);
  assert.equal(await repo.calendarSyncAlreadyHandled("antonio"), false,
    "an unconfirmed dispatch claim must not cause ingress to acknowledge a notification");
  assert.equal([...rows.values()][0].calendarSyncGeneration, first + 1);
});

test("crashed worker retries its active generation; a stale completed SQS copy is skipped", async t => {
  const rows = stateDb(t);
  const repo = new StateRepository();
  const generation = await repo.markCalendarWatchNotification("work", "t1", "work-channel", "1");
  await repo.claimCalendarSyncDispatch("work");
  await repo.markCalendarSyncQueued("work", generation);
  const started = await repo.startCalendarSync("work", generation);
  assert.equal(await repo.startCalendarSync("work", generation), started,
    "an SQS retry resumes the same generation after worker failure");
  assert.equal(await repo.completeCalendarSync("work", started), false);
  assert.equal(await repo.startCalendarSync("work", generation), undefined,
    "a duplicate SQS copy cannot scan after the generation is committed");
  assert.equal([...rows.values()][0].calendarSyncState, "idle");
});

test("scheduled admission recovers orphaned ingress claims and never rescans completed work", async t => {
  const rows = stateDb(t);
  const repo = new StateRepository();
  assert.equal(await repo.calendarSyncDispatchDue("antonio"), false);
  const generation = await repo.markCalendarWatchNotification("antonio", "t1", "antonio-channel", "1");
  assert.equal(await repo.calendarSyncDispatchDue("antonio"), true,
    "a crash after durable notification admission is recoverable");
  await repo.claimCalendarSyncDispatch("antonio", 60_000);
  assert.equal(await repo.calendarSyncDispatchDue("antonio"), false,
    "a live SQS admission lease is not duplicated");
  const row = [...rows.values()][0];
  row.calendarSyncLeaseUntil = 0;
  assert.equal(await repo.calendarSyncDispatchDue("antonio"), true,
    "an expired, ambiguous send claim can be recovered");
  row.calendarSyncState = "running";
  assert.equal(await repo.calendarSyncDispatchDue("antonio"), false,
    "the dispatcher never overlaps active token advancement");
  row.calendarSyncState = "idle";
  row.calendarSyncCompletedGeneration = generation;
  assert.equal(await repo.calendarSyncDispatchDue("antonio"), false);
});

test("terminal worker failure waits for a newer notification instead of dispatcher retry looping", async t => {
  const rows = stateDb(t);
  const repo = new StateRepository();
  const first = await repo.markCalendarWatchNotification("home", "t1", "home-channel", "1");
  await repo.claimCalendarSyncDispatch("home");
  await repo.markCalendarSyncQueued("home", first);
  await repo.startCalendarSync("home", first);
  await repo.failCalendarSync("home");

  assert.equal(await repo.calendarSyncDispatchDue("home"), false);
  assert.equal(await repo.claimCalendarSyncDispatch("home"), undefined);
  await repo.markCalendarWatchNotification("home", "t2", "home-channel", "2");
  assert.equal(await repo.calendarSyncDispatchDue("home"), true);
  assert.equal(await repo.claimCalendarSyncDispatch("home"), first + 1);
  assert.equal([...rows.values()][0].calendarSyncState, "dispatching");
});

test("duplicate messages for completed or failed generations are acknowledged without another scan", async t => {
  stateDb(t);
  const repo = new StateRepository();
  const first = await repo.markCalendarWatchNotification("antonio", "t1", "channel-a", "1");
  await repo.claimCalendarSyncDispatch("antonio");
  await repo.markCalendarSyncQueued("antonio", first);
  const pass = await repo.startCalendarSync("antonio", first);
  assert.equal(await repo.completeCalendarSync("antonio", pass), false);
  assert.equal(await repo.markCalendarWatchNotification("antonio", "duplicate", "channel-a", "1"), first);
  assert.equal(await repo.claimCalendarSyncDispatch("antonio"), undefined);
  assert.equal(await repo.calendarSyncAlreadyHandled("antonio"), true);

  const second = await repo.markCalendarWatchNotification("antonio", "t2", "channel-a", "2");
  await repo.claimCalendarSyncDispatch("antonio");
  await repo.markCalendarSyncQueued("antonio", second);
  await repo.startCalendarSync("antonio", second);
  await repo.failCalendarSync("antonio");
  assert.equal(await repo.markCalendarWatchNotification("antonio", "duplicate", "channel-a", "2"), second);
  assert.equal(await repo.claimCalendarSyncDispatch("antonio"), undefined);
  assert.equal(await repo.calendarSyncAlreadyHandled("antonio"), true);
});
