import assert from 'node:assert/strict';
import test from 'node:test';
import { isCleanReconciliationPass } from '../scripts/reconciliation-acceptance-logic.mjs';
import { runReconciliationAcceptance } from '../scripts/reconciliation-acceptance-runner.mjs';

test('production acceptance enqueues and verifies two fresh full reconciliations for each profile', async () => {
  const current = new Map();
  const requests = [];
  const state = { async getReconciliationState(profile) { return current.get(profile); } };
  const result = await runReconciliationAcceptance({
    state,
    profiles: ['antonio', 'home', 'work'],
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    requestProfileReconciliation: async profile => {
      const generation = `${profile}-${requests.filter(item => item === profile).length + 1}`;
      requests.push(profile);
      current.set(profile, {
        generation, pending: false, status: 'succeeded', unresolved: 0,
        result: { scanned: 10, created: generation.endsWith('-1') ? 1 : 0, conflict: 0, recurrence_reported: 1 },
      });
      return { queued: true, generation };
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(requests, ['antonio', 'antonio', 'home', 'home', 'work', 'work']);
  assert.equal(result.profiles.antonio.length, 2);
  assert.equal(result.profiles.work[1].counts.created, 0);
});

test('production acceptance fails when the second full reconciliation still changes provider state', async () => {
  const current = new Map();
  let requestCount = 0;
  const state = { async getReconciliationState(profile) { return current.get(profile); } };
  const result = await runReconciliationAcceptance({
    state,
    profiles: ['antonio'],
    timeoutMs: 1_000,
    requestProfileReconciliation: async profile => {
      const generation = `generation-${++requestCount}`;
      current.set(profile, {
        generation, pending: false, status: 'succeeded', unresolved: 0,
        result: { scanned: 1, created: 1, conflict: 0, recurrence_reported: 1 },
      });
      return { queued: true, generation };
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.profiles.antonio.length, 2);
});

test('production acceptance rejects a failed recurrence even when the reconciliation reports no conflicts', async () => {
  const current = new Map();
  let requestCount = 0;
  const state = { async getReconciliationState(profile) { return current.get(profile); } };
  const result = await runReconciliationAcceptance({
    state,
    profiles: ['antonio'],
    timeoutMs: 1_000,
    requestProfileReconciliation: async profile => {
      const generation = `generation-${++requestCount}`;
      current.set(profile, {
        generation, pending: false, status: 'succeeded', unresolved: 0,
        result: {
          scanned: 1, conflict: 0, blocked: 0, recurrence_reported: 1,
          recurrence_total: 1, recurrence_unverified: 1,
        },
      });
      return { queued: true, generation };
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.profiles.antonio.length, 1);
  assert.equal(requestCount, 1);
});

test('production acceptance requires a clean result and a mutation-free second pass', () => {
  const clean = { status: 'succeeded', unresolved: 0, counts: { scanned: 10, created: 0, conflict: 0, recurrence_reported: 1, recurrence_total: 0 } };
  assert.equal(isCleanReconciliationPass(clean, 1), true);
  assert.equal(isCleanReconciliationPass({ ...clean, counts: { scanned: 10, created: 0 } }, 1), false);
  assert.equal(isCleanReconciliationPass({ ...clean, unresolved: 1 }, 1), false);
  assert.equal(isCleanReconciliationPass({ ...clean, counts: { conflict: 1 } }, 1), false);
  assert.equal(isCleanReconciliationPass({ ...clean, counts: { created: 1, recurrence_reported: 1 } }, 1), true);
  assert.equal(isCleanReconciliationPass({ ...clean, counts: { created: 1, recurrence_reported: 1 } }, 2), false);
  assert.equal(isCleanReconciliationPass({ ...clean, counts: { recurrence_unsupported: 1, recurrence_reported: 1, recurrence_total: 1 } }, 1), true);
  assert.equal(isCleanReconciliationPass({ ...clean, counts: { recurrence_excluded: 1, recurrence_reported: 1, recurrence_total: 1 } }, 1), true);
  for (const key of ['recurrence_blocked', 'recurrence_stale', 'recurrence_unverified'])
    assert.equal(isCleanReconciliationPass({ ...clean, counts: { [key]: 1, recurrence_total: 1 } }, 1), false, key);
});
