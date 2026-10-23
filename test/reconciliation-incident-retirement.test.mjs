import assert from 'node:assert/strict';
import test from 'node:test';

const { ManualInterventionService } = await import('../dist/manual-intervention.js');

function harness({ finishError, decision } = {}) {
  const saved = decision || {
    decisionId: 'home-operational_reconciliation_stuck-test',
    profile: 'home',
    type: 'operational_reconciliation_stuck',
    status: 'pending',
    slackChannelId: 'C123',
    slackMessageTs: '123.456',
  };
  const calls = { finish: [], updates: [] };
  const store = {
    async finish(...args) {
      calls.finish.push(args);
      if (finishError) throw finishError;
      saved.status = args[1];
      saved.resolution = args[2];
    },
    async get() { return saved; },
  };
  const notifier = {
    async updateResolution(...args) { calls.updates.push(args); },
  };
  return { service: new ManualInterventionService(store, notifier), calls, saved };
}

test('finishing a reconciliation incident updates its existing Slack message', async () => {
  const { service, calls, saved } = harness();
  await service.finishReconciliationDecision(saved.decisionId, 'Recovered and verified');
  assert.deepEqual(calls.finish, [[saved.decisionId, 'resolved', 'Recovered and verified', 'reconciliation-worker']]);
  assert.deepEqual(calls.updates, [[saved, 'Recovered and verified']]);
});

test('conditional finish race updates Slack with the already-persisted resolution', async () => {
  const saved = {
    decisionId: 'home-operational_reconciliation_stuck-test',
    profile: 'home',
    type: 'operational_reconciliation_stuck',
    status: 'resolved',
    resolution: 'Resolved by the concurrent worker',
    slackChannelId: 'C123',
    slackMessageTs: '123.456',
  };
  const { service, calls } = harness({
    decision: saved,
    finishError: Object.assign(new Error('conditional write lost'), { name: 'ConditionalCheckFailedException' }),
  });
  await service.finishReconciliationDecision(saved.decisionId, 'Recovered and verified');
  assert.equal(calls.finish.length, 1);
  assert.deepEqual(calls.updates, [[saved, 'Resolved by the concurrent worker']]);
});

test('conditional finish race still rejects when the decision is not resolved', async () => {
  const { service, calls } = harness({
    finishError: Object.assign(new Error('conditional write lost'), { name: 'ConditionalCheckFailedException' }),
  });
  await assert.rejects(service.finishReconciliationDecision('home-operational_reconciliation_stuck-test', 'Recovered'),
    { name: 'ConditionalCheckFailedException' });
  assert.deepEqual(calls.updates, []);
});
