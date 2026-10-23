import assert from 'node:assert/strict';
import test from 'node:test';
process.env.STATE_TABLE_NAME ||= 'test-reconciliation-state';
const { StateRepository, reconciliationSummary } = await import('../dist/repository.js');
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

for (const terminal of ['succeeded', 'needs_review']) {
  test(`run-scoped ${terminal} summary remains distinct from open review cases after an earlier failure`, async (t) => {
    const db = reconciliationDatabase(t, [run()]);
    const state = new StateRepository();
    await state.recordReconciliationFailure('home', 'old', 'previous generation failed');
    const next = await state.requestReconciliation('home', 'manual');
    await state.completeReconciliation('home', next.state.generation, terminal === 'needs_review' ? 1 : 0, { repaired: 4 });
    const latest = db.get('RECONCILE#home');
    const summary = reconciliationSummary(latest, 2);
    assert.equal(summary.runStatus, terminal);
    assert.equal(summary.runUnresolved, terminal === 'needs_review' ? 1 : 0);
    assert.equal(summary.actionableCaseCount, 2);
    assert.equal(summary.inboxClear, false);
    assert.equal((await state.getReconciliationOutcome('home', 'old')).status, 'failed');
  });
}

test('reconciliation diagnostics persist accepted delivery, checkpoint, and next cursor', async (t) => {
  const db = reconciliationDatabase(t, [run()]);
  const state = new StateRepository();
  await state.markReconciliationEnqueued('home', 'old', 'reconcile:home:old');
  assert.equal(db.get('RECONCILE#home').queueState, 'accepted');
  await state.beginReconciliation('home', 'old', 'reconcile:home:old');
  await state.addReconciliationProgress('home', 'old', { scanned: 25 }, {
    phase: 'mapped', sequence: 1, deliveryId: 'reconcile:home:old', afterTaskId: 'task-25', observedAt: old,
  });
  await state.markReconciliationEnqueued('home', 'old', 'reconcile:home:old:chunk:2', {
    phase: 'mapped', sequence: 2, deliveryId: 'reconcile:home:old:chunk:2', afterTaskId: 'task-50',
  });
  const saved = db.get('RECONCILE#home');
  assert.equal(saved.queueState, 'accepted');
  assert.equal(saved.lastStartedDeliveryId, 'reconcile:home:old');
  assert.equal(saved.progressCheckpoint.afterTaskId, 'task-25');
  assert.equal(saved.nextContinuation.deliveryId, 'reconcile:home:old:chunk:2');
  assert.equal(saved.nextContinuation.afterTaskId, 'task-50');
});

test('unresolved reconciliation diagnostics are run-scoped, idempotent, bounded, and retain case status', async (t) => {
  const db = reconciliationDatabase(t, [run()]);
  const state = new StateRepository();
  const detail = { taskId: 'task-7', eventId: 'e'.repeat(256), seriesId: 'series-7', recurrenceOwner: 'calendar',
    taskUpdatedAt: 'task-v1', calendarEtag: 'etag-v1', mismatchCategories: ['start_mismatch'], taskTitle: 'sensitive title' };
  await state.recordReconciliationDiagnostic('home', 'old', 'delivery-1', 'todoist_snapshot_reconcile_unmapped_conflict', detail,
    { caseId: 'home-decision-1', caseStatus: 'dismissed' });
  await state.recordReconciliationDiagnostic('home', 'old', 'delivery-2', 'todoist_snapshot_reconcile_unmapped_conflict', detail,
    { caseId: 'home-decision-1', caseStatus: 'dismissed' });
  await state.recordReconciliationDiagnostic('home', 'old', 'delivery-3', 'todoist_snapshot_reconcile_unmapped_conflict',
    { ...detail, calendarEtag: 'etag-v2' }, { caseId: 'home-decision-2', caseStatus: 'open' });
  await state.recordReconciliationDiagnostic('home', 'new-generation', 'delivery-4', 'todoist_snapshot_reconcile_unmapped_conflict', detail);
  await state.recordReconciliationDiagnostic('work', 'old', 'delivery-work', 'todoist_snapshot_reconcile_unmapped_conflict',
    { taskId: 'work-only-task', eventId: 'work-only-event' });
  await state.recordReconciliationDiagnostic('home', 'old', 'delivery-5', 'todoist_snapshot_reconcile_baseline_established', detail);

  const first = await state.listReconciliationDiagnostics('home', 'old', 1);
  assert.equal(first.items.length, 1);
  assert.ok(first.next);
  const second = await state.listReconciliationDiagnostics('home', 'old', 1, first.next);
  assert.equal(second.items.length, 1);
  assert.equal(second.next, undefined);
  assert.equal(first.items[0].outcome, 'conflict');
  assert.equal(first.items[0].taskId, 'task-7');
  assert.equal(first.items[0].eventId, detail.eventId);
  assert.equal(first.items[0].recurrenceOwner, 'calendar');
  assert.equal(first.items[0].detail.taskTitle, undefined);
  assert.deepEqual(new Set([first.items[0].caseStatus, second.items[0].caseStatus]), new Set(['dismissed','open']));
  assert.equal((await state.listReconciliationDiagnostics('home', 'new-generation')).items.length, 1);
  const homeRows = await state.listReconciliationDiagnostics('home', 'old', 50);
  const workRows = await state.listReconciliationDiagnostics('work', 'old', 50);
  assert.ok(homeRows.items.every(item => item.profile === 'home' && item.taskId !== 'work-only-task'));
  assert.deepEqual(workRows.items.map(item => item.taskId), ['work-only-task']);
});

test('worker failure context is retained separately from its free-form error', async (t) => {
  const db = reconciliationDatabase(t, [run()]);
  await new StateRepository().recordReconciliationFailure('home', 'old', 'provider failure details', {
    category: 'provider_http_503', stage: 'mapped', status: 503, taskId: 'task-7',
  });
  assert.deepEqual(db.get('RECONCILE#home').failureContext, {
    category: 'provider_http_503', stage: 'mapped', status: 503, taskId: 'task-7',
  });
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
