import assert from "node:assert/strict";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { enqueueCalendarSync } from "../dist/queue.js";

function stateFixture() {
  const profiles = new Map();
  const row = profile => {
    if (!profiles.has(profile)) profiles.set(profile, { generation: 0, state: "idle" });
    return profiles.get(profile);
  };
  return {
    profiles,
    async markCalendarWatchNotification(profile) { return ++row(profile).generation; },
    async claimCalendarSyncDispatch(profile) {
      const current = row(profile);
      if (["queued", "running", "dispatching"].includes(current.state)) return undefined;
      current.state = "dispatching";
      current.queuedGeneration = current.generation;
      return current.generation;
    },
    async calendarSyncAlreadyHandled(profile) { return ["queued", "running"].includes(row(profile).state); },
    async markCalendarSyncQueued(profile, generation) {
      const current = row(profile);
      assert.equal(current.queuedGeneration, generation);
      current.state = "queued";
    },
    async releaseCalendarSyncDispatch(profile) { row(profile).state = "pending"; },
  };
}

test("push bursts coalesce to one pending request independently for each profile", async t => {
  const originalSend = SQSClient.prototype.send;
  const originalQueueUrl = process.env.QUEUE_URL;
  const sends = [];
  SQSClient.prototype.send = async function(command) { sends.push(command.input); return {}; };
  process.env.QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/123456789012/sync.fifo";
  t.after(() => {
    SQSClient.prototype.send = originalSend;
    if (originalQueueUrl === undefined) delete process.env.QUEUE_URL;
    else process.env.QUEUE_URL = originalQueueUrl;
  });

  const state = stateFixture();
  for (const profile of ["antonio", "home", "work"]) {
    for (let i = 0; i < 100; i++) {
      await state.markCalendarWatchNotification(profile);
      await enqueueCalendarSync(state, profile);
    }
  }

  assert.equal(sends.length, 3);
  assert.deepEqual(sends.map(message => message.MessageGroupId).sort(), ["sync:antonio", "sync:home", "sync:work"]);
  assert.equal(new Set(sends.map(message => message.MessageDeduplicationId)).size, 3);
});

test("a failed queue send releases the durable claim so a retried push can dispatch", async t => {
  const originalSend = SQSClient.prototype.send;
  const originalQueueUrl = process.env.QUEUE_URL;
  let fail = true;
  let sends = 0;
  SQSClient.prototype.send = async function() {
    sends++;
    if (fail) throw new Error("synthetic SQS outage");
    return {};
  };
  process.env.QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/123456789012/sync.fifo";
  t.after(() => {
    SQSClient.prototype.send = originalSend;
    if (originalQueueUrl === undefined) delete process.env.QUEUE_URL;
    else process.env.QUEUE_URL = originalQueueUrl;
  });

  const state = stateFixture();
  await state.markCalendarWatchNotification("home");
  await assert.rejects(enqueueCalendarSync(state, "home"), error => {
    assert.equal(error.name, "CalendarSyncAdmissionError");
    assert.match(error.cause.message, /synthetic SQS outage/);
    return true;
  });
  fail = false;
  await state.markCalendarWatchNotification("home");
  assert.equal(await enqueueCalendarSync(state, "home"), true);
  assert.equal(sends, 2);
});
