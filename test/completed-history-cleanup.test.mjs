import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { handler, runCompletedHistoryCleanup } from "../dist/completed-history-cleanup.js";

const history = {
  pk: "COMPLETED_TASK#home#one", sk: "EVENT#event-1", profile: "home",
  taskId: "one", eventId: "event-1", completedAt: "2026-10-01T12:00:00Z",
};
const eventKey = "COMPLETED_EVENT#home#event-1|STATE";
const taskKey = "COMPLETED_TASK#home#one|EVENT#event-1";
const k = ({ pk, sk }) => pk + "|" + sk;

async function simulate({ active = false, partial = false, race = false, recurrence = false, certifiedSeries = false, apply = false, clock = "2026-10-09T12:00:00Z" } = {}) {
  const store = new Map([[taskKey, { ...history }], [eventKey, { ...history, pk: "COMPLETED_EVENT#home#event-1", sk: "STATE" }]]);
  if (active) store.set("TASKOWNER#one|MAP", { profile: "home", taskId: "one", eventId: "new-event" });
  if (partial) store.set("EVENT#home#event-1|MAP", { profile: "home", taskId: "one", eventId: "event-1" });
  if (certifiedSeries) {
    for (let n = 1; n <= 13; n++) {
      const id = "event-" + n;
      const row = { ...history, sk: "EVENT#" + id, eventId: id,
        recurrenceOwner: "todoist", seriesId: "one", masterEventId: "master" };
      store.set(k(row), row);
      store.set("COMPLETED_EVENT#home#" + id + "|STATE",
        { ...row, pk: "COMPLETED_EVENT#home#" + id, sk: "STATE" });
    }
    store.set("COMPLETED_SERIES#home#one|STATE", {
      pk: "COMPLETED_SERIES#home#one", sk: "STATE",
      profile: "home", seriesId: "one", recurrenceOwner: "todoist",
      masterEventId: "master", terminalCompletedAt: "2026-10-02T12:00:00Z",
    });
  }
  if (recurrence) {
    const row = store.get(taskKey);
    row.recurrenceOwner = "todoist";
    row.seriesId = "one";
    store.get(eventKey).recurrenceOwner = "todoist";
    store.get(eventKey).seriesId = "one";
    store.set("RECURRENCE#home#one|STATE", { taskId: "one", seriesId: "one" });
  }
  let writes = 0;
  const original = documentClient.send;
  const oldTable = process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME = "unit-test-state";
  documentClient.send = async (command) => {
    const q = command.input;
    if (command instanceof ScanCommand) return {
      ScannedCount: 1, Items: store.has(taskKey) ? [store.get(taskKey)] : [],
    };
    if (command instanceof QueryCommand) {
      const all = [...store.values()].filter((item) =>
        item.pk === "COMPLETED_TASK#home#one").sort((a, b) => a.sk.localeCompare(b.sk));
      return { Items: all.slice(0, q.Limit), ...(all.length > q.Limit
        ? { LastEvaluatedKey: { pk: all[q.Limit - 1].pk, sk: all[q.Limit - 1].sk } } : {}) };
    }
    if (command instanceof GetCommand) return { Item: store.get(k(q.Key)) };
    if (command instanceof TransactWriteCommand) {
      writes++;
      if (race) {
        // Simulate another writer reintroducing an active mapping after the
        // strongly consistent preflight but before the transactional delete.
        const error = new Error("conditional mapping race");
        error.name = "TransactionCanceledException";
        error.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
        throw error;
      }
      for (const op of q.TransactItems) {
        if (op.ConditionCheck && op.ConditionCheck.ConditionExpression === "attribute_not_exists(pk)") {
          assert.equal(store.has(k(op.ConditionCheck.Key)), false);
        }
      }
      for (const op of q.TransactItems) {
        if (op.Delete) store.delete(k(op.Delete.Key));
      }
      return {};
    }
    if (command instanceof PutCommand) {
      writes++;
      store.set(k(q.Item), q.Item);
      return {};
    }
    throw new Error("Unmocked DynamoDB command " + command.constructor.name);
  };
  try {
    const counts = await runCompletedHistoryCleanup({ apply, maxPages: 1, nowMs: Date.parse(clock) });
    return { counts, store, writes };
  } finally {
    documentClient.send = original;
    if (oldTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = oldTable;
  }
}

test("dry run reports one-off eligibility without state or provider writes", async () => {
  const r = await simulate();
  assert.equal(r.counts.eligible, 1);
  assert.equal(r.counts.retired, 0);
  assert.equal(r.writes, 0);
  assert.ok(r.store.has(taskKey));
  assert.ok(r.store.has(eventKey));
  assert.deepEqual(r.counts.eligibleCandidates,[{profile:"home",taskId:"one",eventIds:["event-1"],completedAt:["2026-10-01T12:00:00Z"]}]);
});
test("apply atomically retires task index and preserves permanent event guard", async () => {
  const r = await simulate({ apply: true });
  assert.equal(r.counts.retired, 1);
  assert.equal(r.store.has(taskKey), false);
  assert.equal(r.store.has(eventKey), true);
});
test("active owner prevents retirement regardless of age", async () => {
  const r = await simulate({ active: true, apply: true });
  assert.equal(r.counts.skipped_active, 1);
  assert.equal(r.store.has(taskKey), true);
});
test("historical recurring occurrence with a live link is not terminal", async () => {
  const r = await simulate({ recurrence: true, apply: true });
  assert.equal(r.counts.skipped_ambiguous, 1);
  assert.equal(r.store.has(taskKey), true);
});
test("6d23h59m never purges a completed task", async () => {
  const r = await simulate({ apply: true, clock: "2026-10-08T11:59:00Z" });
  assert.equal(r.counts.too_recent, 1);
  assert.equal(r.store.has(taskKey), true);
});

test("partial EVENT mapping triplet blocks cleanup even without TASK/TASKOWNER", async () => {
  const result = await simulate({ partial: true, apply: true });
  assert.equal(result.counts.skipped_active, 1);
  assert.equal(result.store.has(taskKey), true);
});
test("reopened mapping during transactional cleanup skips instead of losing history", async () => {
  const result = await simulate({ race: true, apply: true });
  assert.equal(result.counts.skipped_active, 1);
  assert.equal(result.store.has(taskKey), true);
  assert.equal(result.store.has(eventKey), true);
});

test("certified exhausted recurrence is safely retired in bounded batches", async () => {
  const result = await simulate({ certifiedSeries: true, apply: true });
  assert.equal(result.counts.retired, 1);
  assert.equal(result.store.has("COMPLETED_SERIES#home#one|STATE"), true);
  assert.equal(result.store.has("COMPLETED_EVENT#home#event-13|STATE"), true);
  const remaining = [...result.store.values()].filter((i) => i.pk === "COMPLETED_TASK#home#one");
  assert.equal(remaining.length, 1);
});

test("scheduled dry-run checkpoints its bounded cursor and resumes without using the apply cursor", async t => {
  const oldTable = process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME = "unit-test-state";
  const dryKey = "MAINTENANCE#TERMINAL_COMPLETED_TASK|DRY_RUN_STATE";
  const applyKey = "MAINTENANCE#TERMINAL_COMPLETED_TASK|STATE";
  const store = new Map([[applyKey, { pk: "MAINTENANCE#TERMINAL_COMPLETED_TASK", sk: "STATE",
    nextCursor: { pk: "apply-only", sk: "cursor" } }]]);
  const scans = [];
  const original = documentClient.send;
  documentClient.send = async command => {
    const q = command.input;
    if (command instanceof GetCommand) return { Item: store.get(k(q.Key)) };
    if (command instanceof ScanCommand) {
      scans.push(q.ExclusiveStartKey);
      if (scans.length === 1) return { ScannedCount: 25, Items: [], LastEvaluatedKey: { pk: "after-page-one", sk: "row" } };
      return { ScannedCount: 25, Items: [] };
    }
    if (command instanceof PutCommand) {
      const existing = store.get(k(q.Item));
      if (q.ConditionExpression === "attribute_not_exists(pk)") assert.equal(existing, undefined);
      else assert.equal(existing?.version, q.ExpressionAttributeValues[":expectedVersion"]);
      store.set(k(q.Item), q.Item);
      return {};
    }
    throw new Error("Unmocked DynamoDB command " + command.constructor.name);
  };
  t.after(() => {
    documentClient.send = original;
    if (oldTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = oldTable;
  });

  const first = await runCompletedHistoryCleanup({ maxPages: 1, nowMs: Date.parse("2026-10-23T12:00:00Z"), persistDryRunCursor: true });
  assert.equal(first.nextCursor.pk, "after-page-one");
  assert.deepEqual(scans[0], undefined);
  assert.equal(store.get(dryKey).scanComplete, false);
  assert.equal(store.get(applyKey).nextCursor.pk, "apply-only", "dry-run checkpoint does not overwrite apply progress");

  const second = await runCompletedHistoryCleanup({ maxPages: 1, nowMs: Date.parse("2026-10-24T12:00:00Z"), persistDryRunCursor: true });
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual(scans[1], { pk: "after-page-one", sk: "row" });
  assert.equal(store.get(dryKey).scanComplete, true);
  assert.equal(store.get(dryKey).version, 2);
  assert.equal(store.get(applyKey).nextCursor.pk, "apply-only");
});

test("scheduled handler enables only the separate checkpoint while apply is disabled", async t => {
  const oldTable = process.env.STATE_TABLE_NAME;
  const oldApply = process.env.TODOIST_CALENDAR_SYNC_COMPLETED_CLEANUP_APPLY;
  process.env.STATE_TABLE_NAME = "unit-test-state";
  process.env.TODOIST_CALENDAR_SYNC_COMPLETED_CLEANUP_APPLY = "false";
  let checkpoint;
  const original = documentClient.send;
  documentClient.send = async command => {
    if (command instanceof GetCommand) return {};
    if (command instanceof ScanCommand) return { ScannedCount: 0, Items: [] };
    if (command instanceof PutCommand) { checkpoint = command.input.Item; return {}; }
    throw new Error("Unmocked DynamoDB command " + command.constructor.name);
  };
  t.after(() => {
    documentClient.send = original;
    if (oldTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = oldTable;
    if (oldApply === undefined) delete process.env.TODOIST_CALENDAR_SYNC_COMPLETED_CLEANUP_APPLY;
    else process.env.TODOIST_CALENDAR_SYNC_COMPLETED_CLEANUP_APPLY = oldApply;
  });

  const report = await handler();
  assert.equal(report.retired, 0);
  assert.equal(checkpoint.sk, "DRY_RUN_STATE");
  assert.equal(checkpoint.scanComplete, true);
  assert.equal(checkpoint.lastCounts.eligibleCandidates, undefined, "scheduled state stores aggregate counts, not candidate IDs");
});
