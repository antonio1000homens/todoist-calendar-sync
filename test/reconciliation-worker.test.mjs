import assert from 'node:assert/strict';
import test from 'node:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { processReconciliation } from '../dist/worker.js';
import { SnapshotReconciler } from '../dist/reconciliation.js';

test('Calendar continuations keep increasing after mapped/unmapped chunk IDs', async (t) => {
  const previousQueue = process.env.QUEUE_URL;
  const previousLimit = process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT;
  process.env.QUEUE_URL = 'https://sqs.example.test/sync.fifo';
  process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT = '2';
  t.after(() => {
    if (previousQueue === undefined) delete process.env.QUEUE_URL;
    else process.env.QUEUE_URL = previousQueue;
    if (previousLimit === undefined) delete process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT;
    else process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT = previousLimit;
  });
  const queued = [];
  t.mock.method(SQSClient.prototype, 'send', async (command) => {
    queued.push(JSON.parse(command.input.MessageBody));
    return {};
  });
  const mapped = t.mock.method(SnapshotReconciler.prototype, 'reconcile', async () => ({ counts: { scanned: 2 } }));
  const aggregate = {};
  const completed = [];
  const state = {
    async beginReconciliation() { return true; },
    async mutationAllowed() { return true; },
    async markReconciliationEnqueued() {},
    async audit() {},
    async addReconciliationProgress(_profile, _generation, counts) {
      for (const [key, count] of Object.entries(counts)) aggregate[key] = (aggregate[key] || 0) + count;
    },
    async getReconciliationState() { return { result: aggregate }; },
    async completeReconciliation(...args) { completed.push(args); },
  };
  const clients = async () => ({
    calendar: { async listDelta() { return { items: Array.from({ length: 5 }, (_, i) => ({ id: `event-${i}`, status: 'cancelled' })) }; } },
    todoist: { async listTasks() { return []; } },
  });
  const delivery = {
    id: 'reconcile:home:gen:chunk:3', kind: 'reconcile', profile: 'home', mode: 'aws',
    headers: {}, body: '', receivedAt: new Date().toISOString(),
    reconcile: { generation: 'gen', reason: 'manual', continuation: { phase: 'unmapped', sequence: 3 } },
  };
  assert.equal((await processReconciliation(delivery, state, clients)).continuationQueued, true);
  assert.equal(completed.length, 0);
  assert.equal(queued[0].id, 'reconcile:home:gen:chunk:4');
  assert.equal((await processReconciliation(queued[0], state, clients)).continuationQueued, true);
  assert.equal(completed.length, 0);
  assert.equal(queued[1].id, 'reconcile:home:gen:chunk:5');
  assert.deepEqual(await processReconciliation(queued[1], state, clients), { continuationRequired: false });
  assert.equal(mapped.mock.callCount(), 1);
  assert.equal(aggregate.calendar_scanned, 5);
  assert.equal(aggregate.calendar_skipped, 5);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0], ['home', 'gen', 0, aggregate]);
});
