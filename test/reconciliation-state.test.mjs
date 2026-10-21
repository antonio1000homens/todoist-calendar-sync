import assert from 'node:assert/strict';
import test from 'node:test';
process.env.STATE_TABLE_NAME ||= 'test-reconciliation-state';
const { StateRepository } = await import('../dist/repository.js');
const { reconciliationDatabase } = await import('./support/reconciliation-state.mjs');

const old = new Date(Date.now() - 30 * 60_000).toISOString();
function run(overrides = {}) {
  return { pk: 'RECONCILE#home', sk: 'STATE', profile: 'home', pending: true, generation: 'old',
    reason: 'manual', requestedAt: old, lastRequestedAt: old, ...overrides };
}

for (const timestamp of ['lastStartedAt', 'lastEnqueuedAt']) {
  test(`manual retry replaces a stalled legacy run with only ${timestamp}`, async (t) => {
    const previous = run({ [timestamp]: old });
    const db = reconciliationDatabase(t, [previous]);
    const result = await new StateRepository().requestReconciliation('home', 'manual');
    assert.equal(result.created, true);
    assert.notEqual(result.state.generation, previous.generation);
    assert.equal(db.get('RECONCILE_RUN#home#old').generation, 'old');
    assert.equal(db.get('RECONCILE#home').generation, result.state.generation);
  });
}

test('a legacy run that resumes during retry is coalesced instead of superseded', async (t) => {
  const db = reconciliationDatabase(t, [run({ lastStartedAt: old })]);
  db.fault.beforeWrite = (items) => {
    items.get(JSON.stringify(['RECONCILE#home', 'STATE'])).lastProgressAt = new Date().toISOString();
  };
  const result = await new StateRepository().requestReconciliation('home', 'manual');
  assert.equal(result.created, false);
  assert.equal(result.state.generation, 'old');
});

test('progress and terminal results persist with reserved attributes aliased', async (t) => {
  const db = reconciliationDatabase(t, [run({ result: { repaired: 2 } })]);
  const state = new StateRepository();
  await state.addReconciliationProgress('home', 'old', { repaired: 1, scanned: 5 });
  assert.deepEqual(db.get('RECONCILE#home').result, { repaired: 3, scanned: 5 });
  await state.completeReconciliation('home', 'old', 1, db.get('RECONCILE#home').result);
  assert.equal(db.get('RECONCILE#home').status, 'needs_review');
  assert.equal(db.get('RECONCILE_OUTCOME#home', 'old').notificationPending, true);
  assert.deepEqual(db.get('RECONCILE_OUTCOME#home', 'old').result, { repaired: 3, scanned: 5 });
});

test('failed live keys never overwrite the archival evidence key', async (t) => {
  const db = reconciliationDatabase(t, [run({ lastFailedAt: old, lastError: 'Invalid start time' })]);
  await new StateRepository().requestReconciliation('home', 'manual');
  assert.equal(db.get('RECONCILE_RUN#home#old').lastError, 'Invalid start time');
  assert.notEqual(db.get('RECONCILE#home').generation, 'old');
});

for (const terminal of ['succeeded', 'needs_review', 'failed']) {
  test(`a new generation preserves and can notify an older ${terminal} outcome`, async (t) => {
    const db = reconciliationDatabase(t, [run({ slackChannelId: 'COLD', slackThreadTs: '1.0' })]);
    const state = new StateRepository();
    if (terminal === 'failed') await state.recordReconciliationFailure('home', 'old', 'task-1: Invalid start time');
    else await state.completeReconciliation('home', 'old', terminal === 'needs_review' ? 1 : 0, { repaired: 3 });
    const request = await state.requestReconciliation('home', 'manual', { slackChannelId: 'CNEW', slackThreadTs: '2.0' });
    assert.equal(request.created, true);
    const [outcome] = await state.listPendingReconciliationOutcomes('home');
    assert.equal(outcome.status, terminal);
    assert.equal(outcome.slackChannelId, 'COLD');
    assert.equal(outcome.slackThreadTs, '1.0');
    await state.storeReconciliationReply('home', 'old', '1.1');
    assert.equal((await state.getReconciliationOutcome('home', 'old')).notificationReplyTs, '1.1');
    await state.markReconciliationNotified('home', 'old', '1.1');
    assert.deepEqual(await state.listPendingReconciliationOutcomes('home'), []);
    assert.equal(db.get('RECONCILE#home').generation, request.state.generation);
    assert.equal(db.get('RECONCILE#home').notificationReplyTs, undefined);
  });
}

test('notifications already pending on legacy state survive replacement and paginated retries', async (t) => {
  reconciliationDatabase(t, [run({ pending: false, status: 'succeeded', notificationPending: true, slackThreadTs: '1.0' }),
    { ...run({ notificationPending: false }), pk: 'RECONCILE_OUTCOME#home', sk: 'a-acknowledged' }]);
  const state = new StateRepository();
  await state.requestReconciliation('home', 'manual');
  assert.deepEqual((await state.listPendingReconciliationOutcomes('home')).map((outcome) => outcome.generation), ['old']);
});

test('failed outcome persistence cannot falsely commit a terminal live state', async (t) => {
  const db = reconciliationDatabase(t, [run()]);
  db.fault.failTransaction = true;
  await assert.rejects(new StateRepository().completeReconciliation('home', 'old'), /transaction failure/);
  assert.equal(db.get('RECONCILE#home').pending, true);
  assert.equal(db.get('RECONCILE_OUTCOME#home', 'old'), undefined);
});

test('superseded and already-failed deliveries cannot restart provider work', async (t) => {
  reconciliationDatabase(t, [run({ lastFailedAt: old, status: 'failed' })]);
  const state = new StateRepository();
  assert.equal(await state.beginReconciliation('home', 'superseded'), false);
  assert.equal(await state.beginReconciliation('home', 'old'), false);
});
