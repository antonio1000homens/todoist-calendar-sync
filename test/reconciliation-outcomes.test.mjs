import assert from 'node:assert/strict';
import test from 'node:test';
import { SSMClient } from '@aws-sdk/client-ssm';
process.env.STATE_TABLE_NAME ||= 'test-reconciliation-state';
const { StateRepository, reconciliationRunStatus } = await import('../dist/repository.js');
const { ManualInterventionService, SlackManualNotifier, MANUAL_DECISION_CATALOG } = await import('../dist/manual-intervention.js');
const { checkReconciliationHealth } = await import('../dist/reconcile.js');
const { deliverPendingReconciliationOutcome } = await import('../dist/reconciliation-outcomes.js');
const { reconciliationDatabase } = await import('./support/reconciliation-state.mjs');

const old = new Date(Date.now() - 30 * 60_000).toISOString();
function run(overrides = {}) {
  return { pk: 'RECONCILE#home', sk: 'STATE', profile: 'home', pending: true, generation: 'old',
    reason: 'manual', requestedAt: old, lastRequestedAt: old, lastEnqueuedAt: old,
    slackChannelId: 'CTEST', slackMessageTs: '1.000', slackThreadTs: '1.000', slackDecisionId: 'incident', ...overrides };
}
function decision(overrides = {}) {
  return { decisionId: 'incident', profile: 'home', type: 'operational_dlq', severity: 'warning', status: 'pending',
    createdAt: old, decisionDeadline: '2099-01-01T00:00:00Z', fingerprint: 'incident', context: {},
    permittedActions: MANUAL_DECISION_CATALOG.operational_dlq.actions, ...overrides };
}
class Store {
  decisions = new Map();
  finishes = 0;
  async get(id) { return structuredClone(this.decisions.get(id)); }
  async listPending(profile) { return [...this.decisions.values()].filter(item => item.status === 'pending' && (!profile || item.profile === profile)); }
  async putPending(input) {
    const current = this.decisions.get(input.decisionId);
    if (current) return { decision: current, created: false };
    const value = decision(input);
    this.decisions.set(input.decisionId, value);
    return { decision: value, created: true };
  }
  async setSlackLocation(id, channel, ts) {
    Object.assign(this.decisions.get(id), { slackChannelId: channel, slackMessageTs: ts });
  }
  async finish(id, status = 'resolved', resolution) {
    const current = this.decisions.get(id);
    if (current?.status !== 'pending') throw Object.assign(new Error('not pending'), { name: 'ConditionalCheckFailedException' });
    current.status = status;
    current.resolution = resolution;
    this.finishes++;
  }
}
function fakeSlack(t, respond) {
  const previous = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = previous;
  });
  t.mock.method(SSMClient.prototype, 'send', async () => ({ Parameter: { Value: 'test-slack-token' } }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(String(url).startsWith('https://slack.com/api/'), `unexpected request ${url}`);
    const payload = JSON.parse(init.body);
    const method = String(url).split('/').at(-1);
    calls.push({ method, payload });
    const result = respond?.(method, payload, calls.length) || { ok: true, channel: 'CTEST', ts: '1.001' };
    return new Response(JSON.stringify(result), { status: 200 });
  });
  return calls;
}

for (const status of ['failed', 'needs_review']) {
  test(`${status} outcomes keep the incident's retry buttons`, async (t) => {
    const calls = fakeSlack(t);
    const store = new Store();
    store.decisions.set('incident', decision());
    const service = new ManualInterventionService(store, new SlackManualNotifier(store));
    await service.updateReconciliationIncident('CTEST', '1.000', status, false, 'incident');
    const blocks = calls[0].payload.blocks;
    assert.equal(blocks[0].text.text, status);
    assert.ok(blocks.some((block) => block.type === 'actions' && block.elements.some((element) => JSON.parse(element.value).action === 'reconcile_now')));
    await service.updateReconciliationIncident('CTEST', '1.000', 'Succeeded', true, 'incident');
    assert.deepEqual(calls[1].payload.blocks, []);
  });
}

test('health retries a failed alert post and only deduplicates confirmed delivery', async (t) => {
  const calls = fakeSlack(t, (_method, _payload, count) => count === 1 ? { ok: false, error: 'temporary_slack_outage' } : undefined);
  const db = reconciliationDatabase(t, [run({ slackDecisionId: undefined })]);
  const store = new Store();
  const state = new StateRepository();
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await checkReconciliationHealth(state, service, ['home']);
  assert.equal(db.get('RECONCILE#home').lastHealthAlertAt, undefined);
  assert.equal(calls.length, 1);
  await checkReconciliationHealth(state, service, ['home']);
  assert.ok(db.get('RECONCILE#home').lastHealthAlertAt);
  assert.equal(calls.length, 2);
  assert.equal(store.decisions.size, 1);
  await checkReconciliationHealth(state, service, ['home']);
  assert.equal(calls.length, 2);
});

test('stuck incidents persist structured generation diagnostics without exposing raw errors', async (t) => {
  fakeSlack(t);
  const store = new Store();
  const state = new StateRepository();
  const checkpoint = { phase: 'mapped', sequence: 2, deliveryId: 'reconcile:home:old:chunk:2', afterTaskId: 'task-25', observedAt: old };
  reconciliationDatabase(t, [run({
    status: 'failed', lastFailedAt: old, lastProgressAt: old, lastError: 'secret-bearing provider response',
    failureContext: { category: 'provider_http_503', stage: 'mapped', status: 503, taskId: 'task-7' },
    progressCheckpoint: checkpoint, lastDeliveryId: 'reconcile:home:old:chunk:2',
  })]);
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await checkReconciliationHealth(state, service, ['home']);
  const incident = [...store.decisions.values()][0];
  assert.equal(incident.context.reconciliationGeneration, 'old');
  assert.equal(incident.context.incidentClassification, 'worker_failure');
  assert.equal(incident.context.failureCategory, 'provider_http_503');
  assert.equal(incident.context.failureSummary, 'A provider request returned HTTP 503.');
  assert.equal(incident.context.progressCheckpoint.afterTaskId, 'task-25');
  assert.equal(incident.context.failureContext.taskId, 'task-7');
  assert.equal(incident.context.detail.includes('secret-bearing'), false);
  assert.match(incident.context.queueStateNote, /not queried/);
});

test('monitor-only stalls are labeled without inferring a worker failure or raw cause', async (t) => {
  fakeSlack(t);
  const store = new Store();
  reconciliationDatabase(t, [run({ status: 'running', lastStartedAt: old, lastProgressAt: old })]);
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await checkReconciliationHealth(new StateRepository(), service, ['home']);
  const incident = [...store.decisions.values()][0];
  assert.equal(incident.context.incidentClassification, 'monitor_stall');
  assert.equal(incident.context.failureCategory, undefined);
  assert.match(incident.context.detail, /does not identify why progress stopped/);
  assert.equal(incident.context.progressCheckpoint, undefined);
});

test('fresh progress suppresses a delayed-but-active monitor alert', async (t) => {
  fakeSlack(t);
  const store = new Store();
  reconciliationDatabase(t, [run({ status: 'running', lastStartedAt: old, lastProgressAt: new Date().toISOString() })]);
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await checkReconciliationHealth(new StateRepository(), service, ['home']);
  assert.equal(store.decisions.size, 0);
});

test('a later terminal generation marks only its older stuck-run alert stale', async (t) => {
  const calls = fakeSlack(t);
  const store = new Store();
  store.decisions.set('old-stuck', decision({ decisionId: 'old-stuck', type: 'operational_reconciliation_stuck',
    slackChannelId: 'CTEST', slackMessageTs: '1.000',
    context: { reconciliationGeneration: 'old-generation' } }));
  store.decisions.set('other-case', decision({ decisionId: 'other-case', type: 'both_sides_changed',
    context: {} }));
  reconciliationDatabase(t, [run({ generation: 'new-generation', pending: false, status: 'succeeded' })]);
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await checkReconciliationHealth(new StateRepository(), service, ['home']);
  assert.equal(store.decisions.get('old-stuck').status, 'resolved');
  assert.match(store.decisions.get('old-stuck').resolution, /no longer actionable/);
  assert.equal(store.decisions.get('other-case').status, 'pending');
  const incidentUpdate = calls.find(({ method, payload }) => method === 'chat.update' && payload.ts === '1.000');
  assert.ok(incidentUpdate);
  assert.equal((incidentUpdate.payload.blocks || []).some((block) => block.type === 'actions'), false);
});

test('stale retirement updates Slack after a concurrent successful finish', async (t) => {
  const calls = fakeSlack(t);
  const store = new Store();
  const incident = decision({ decisionId: 'old-stuck', type: 'operational_reconciliation_stuck',
    slackChannelId: 'CTEST', slackMessageTs: '1.000', context: { reconciliationGeneration: 'old-generation' } });
  store.decisions.set(incident.decisionId, incident);
  const finish = store.finish.bind(store);
  store.finish = async (...args) => {
    await finish(...args);
    throw Object.assign(new Error('conditional write lost after commit'), { name: 'ConditionalCheckFailedException' });
  };
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await service.retireStaleReconciliationIncidents('home', 'new-generation', false);
  assert.equal(store.decisions.get(incident.decisionId).status, 'resolved');
  assert.ok(calls.some(({ method, payload }) => method === 'chat.update' && payload.ts === '1.000'));
});

test('notification retry reuses its reply and tolerates an already-resolved incident after a new generation starts', async (t) => {
  const calls = fakeSlack(t);
  const db = reconciliationDatabase(t, [run()]);
  const state = new StateRepository();
  const store = new Store();
  store.decisions.set('incident', decision({ slackChannelId: 'CTEST', slackMessageTs: '1.000' }));
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await state.completeReconciliation('home', 'old', 0, { repaired: 2 });
  const markNotified = state.markReconciliationNotified.bind(state);
  let failMark = true;
  state.markReconciliationNotified = async (...args) => {
    if (failMark) { failMark = false; throw new Error('synthetic acknowledgement write failure'); }
    return markNotified(...args);
  };
  await assert.rejects(deliverPendingReconciliationOutcome(state, service,
    await state.getReconciliationOutcome('home', 'old')), /acknowledgement write failure/);
  assert.equal(store.decisions.get('incident').status, 'resolved');
  assert.equal(db.get('RECONCILE_OUTCOME#home', 'old').notificationReplyTs, '1.001');
  const next = await state.requestReconciliation('home', 'manual', { slackChannelId: 'CNEW', slackThreadTs: '2.000' });
  await checkReconciliationHealth(state, service, ['home']);
  assert.equal(db.get('RECONCILE_OUTCOME#home', 'old').notificationPending, false);
  assert.equal(db.get('RECONCILE#home').generation, next.state.generation);
  assert.equal(store.finishes, 1);
  assert.equal(calls.filter(({ method }) => method === 'chat.postMessage').length, 1);
  assert.equal(calls.filter(({ method, payload }) => method === 'chat.update' && payload.ts === '1.001').length, 1);
  assert.equal(calls.find(({ method }) => method === 'chat.postMessage').payload.thread_ts, '1.000');
});

test('unrelated decision failures still leave outcome delivery pending', async (t) => {
  fakeSlack(t);
  const db = reconciliationDatabase(t, [run()]);
  const store = new Store();
  store.decisions.set('incident', decision({ status: 'stale' }));
  const state = new StateRepository();
  await state.completeReconciliation('home', 'old');
  const service = new ManualInterventionService(store, new SlackManualNotifier(store));
  await assert.rejects(deliverPendingReconciliationOutcome(state, service,
    await state.getReconciliationOutcome('home', 'old')), { name: 'ConditionalCheckFailedException' });
  assert.equal(db.get('RECONCILE_OUTCOME#home', 'old').notificationPending, true);
});

test('legacy failed states report Failed consistently in the health check and Slack outcome', async (t) => {
  const calls = fakeSlack(t);
  const legacy = run({ lastFailedAt: old, lastError: 'task-1: Invalid start time', notificationPending: true });
  assert.equal(reconciliationRunStatus(legacy), 'failed');
  const state = { async storeReconciliationReply() {}, async markReconciliationNotified() {} };
  const store = new Store();
  store.decisions.set('incident', decision({ slackChannelId: 'CTEST', slackMessageTs: '1.000' }));
  await deliverPendingReconciliationOutcome(state, new ManualInterventionService(store, new SlackManualNotifier(store)), legacy);
  assert.match(calls[0].payload.text, /Failed/);
  assert.match(calls[0].payload.text, /task-1: Invalid start time/);
  assert.equal(store.finishes, 0);
});

test('health delivers a legacy pending outcome even when no new run is requested', async (t) => {
  const calls = fakeSlack(t);
  const db = reconciliationDatabase(t, [run({ pending: false, status: 'succeeded', notificationPending: true })]);
  const store = new Store();
  store.decisions.set('incident', decision({ slackChannelId: 'CTEST', slackMessageTs: '1.000' }));
  await checkReconciliationHealth(new StateRepository(), new ManualInterventionService(store, new SlackManualNotifier(store)), ['home']);
  assert.equal(db.get('RECONCILE_OUTCOME#home', 'old').notificationPending, false);
  assert.equal(calls.filter(({ method }) => method === 'chat.postMessage').length, 1);
});

test('coalesced acknowledgements obtain the active Slack thread permalink', async (t) => {
  const calls = fakeSlack(t, () => ({ ok: true, permalink: 'https://example.slack.com/archives/CFIRST/p1000' }));
  const notifier = new SlackManualNotifier();
  assert.equal(await notifier.reconciliationLocation('CFIRST', '1.000'), '<https://example.slack.com/archives/CFIRST/p1000|active reconciliation thread>');
  assert.deepEqual(calls[0], { method: 'chat.getPermalink', payload: { channel: 'CFIRST', message_ts: '1.000' } });
});
