import assert from "node:assert/strict";
import test from "node:test";
import { requestReconciliation } from "../dist/queue.js";

function reconciliationState(generation, reason = "webhook") {
  const now = new Date().toISOString();
  return {
    profile: "home",
    pending: true,
    generation,
    reason,
    requestedAt: now,
    lastRequestedAt: now,
  };
}

test("initial reconciliation request enqueues exactly one durable generation", async () => {
  const generation = "gen-1";
  const marked = [];
  const deliveries = [];
  const state = {
    async requestReconciliation() {
      return { state: reconciliationState(generation), shouldEnqueue: true, created: true };
    },
    async markReconciliationEnqueued(profile, value) { marked.push([profile, value]); },
  };

  const result = await requestReconciliation(state, "home", "webhook", async (delivery) => {
    deliveries.push(delivery);
  });

  assert.equal(result.created, true);
  assert.equal(result.queued, true);
  assert.equal(result.coalesced, false);
  assert.equal(result.generation, generation);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].id, `reconcile:home:${generation}`);
  assert.equal("dryRun" in deliveries[0].reconcile, false);
  assert.deepEqual(marked, [["home", generation]]);
});

test("already-pending reconciliation coalesces without another queue send", async () => {
  let enqueueCalls = 0;
  const generation = "gen-pending";
  const state = {
    async requestReconciliation() {
      return { state: reconciliationState(generation), shouldEnqueue: false, created: false };
    },
    async markReconciliationEnqueued() { throw new Error("must not mark coalesced request as newly enqueued"); },
  };

  const result = await requestReconciliation(state, "home", "webhook", async () => {
    enqueueCalls += 1;
  });

  assert.equal(result.queued, false);
  assert.equal(result.coalesced, true);
  assert.equal(result.generation, generation);
  assert.equal(enqueueCalls, 0);
});

test("failed enqueue preserves and later reuses the same generation", async () => {
  const generation = "gen-recover";
  const requests = [
    { state: reconciliationState(generation), shouldEnqueue: true, created: true },
    { state: reconciliationState(generation), shouldEnqueue: true, created: false },
  ];
  const marked = [];
  const attemptedIds = [];
  const state = {
    async requestReconciliation() { return requests.shift(); },
    async markReconciliationEnqueued(profile, value) { marked.push([profile, value]); },
  };

  const first = await requestReconciliation(state, "home", "webhook", async (delivery) => {
    attemptedIds.push(delivery.id);
    throw new Error("synthetic SQS outage");
  });

  assert.equal(first.queued, false);
  assert.equal(first.enqueueError, "synthetic SQS outage");
  assert.equal(marked.length, 0);

  const second = await requestReconciliation(state, "home", "scheduled", async (delivery) => {
    attemptedIds.push(delivery.id);
  });

  assert.equal(second.queued, true);
  assert.equal(second.recoveredPending, true);
  assert.equal(second.generation, generation);
  assert.deepEqual(attemptedIds, [`reconcile:home:${generation}`, `reconcile:home:${generation}`]);
  assert.deepEqual(marked, [["home", generation]]);
});
