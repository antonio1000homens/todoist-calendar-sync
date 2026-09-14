import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDecisionRenderSummary, renderPendingDecisionCards } from '../dist/status-inbox.js';

const TEST_SLACK_CHANNEL = 'CTESTCHANNEL';

function decision(id, type = 'operational_dlq') {
  return {
    decisionId: id,
    profile: 'antonio',
    type,
    severity: 'warning',
    status: 'pending',
    createdAt: '2026-09-07T20:00:00.000Z',
    decisionDeadline: '2026-09-14T20:00:00.000Z',
    context: {},
    fingerprint: id,
    permittedActions: [{ id: 'reconcile_now', label: 'Reconcile now' }],
  };
}

class FakeStore {
  constructor(decisions) {
    this.decisions = new Map(decisions.map((item) => [item.decisionId, { ...item }]));
    this.failNextReadFor = new Set();
  }

  async get(id) {
    if (this.failNextReadFor.delete(id)) throw new Error(`read failed for ${id}`);
    const item = this.decisions.get(id);
    return item ? { ...item } : undefined;
  }

  async finish() {}
  async listPending() { return [...this.decisions.values()]; }

  markPosted(id, ts) {
    this.decisions.set(id, { ...this.decisions.get(id), slackMessageTs: ts, slackChannelId: TEST_SLACK_CHANNEL });
  }
}

test('status inbox attempts and confirms every pending decision card', async () => {
  const decisions = [decision('decision-one'), decision('decision-two')];
  const store = new FakeStore(decisions);
  const calls = [];
  const notifier = {
    async postDecision(item) {
      calls.push(item.decisionId);
      store.markPosted(item.decisionId, `${calls.length}.000001`);
    },
    async postText() {},
  };

  const result = await renderPendingDecisionCards(decisions, TEST_SLACK_CHANNEL, store, notifier);

  assert.deepEqual(calls, ['decision-one', 'decision-two']);
  assert.deepEqual(result, { attempted: 2, rendered: 2, failedDecisionIds: [] });
});

test('status inbox continues and reports a silently unconfirmed Slack card', async () => {
  const decisions = [decision('decision-one'), decision('decision-two')];
  const store = new FakeStore(decisions);
  const calls = [];
  const notifier = {
    async postDecision(item) {
      calls.push(item.decisionId);
      if (item.decisionId === 'decision-one') store.markPosted(item.decisionId, '1.000001');
      // Mirrors SlackManualNotifier today: a Slack failure can be caught internally,
      // so the caller must not treat a resolved Promise as proof the card appeared.
    },
    async postText() {},
  };

  const result = await renderPendingDecisionCards(decisions, TEST_SLACK_CHANNEL, store, notifier);

  assert.deepEqual(calls, ['decision-one', 'decision-two']);
  assert.equal(result.attempted, 2);
  assert.equal(result.rendered, 1);
  assert.deepEqual(result.failedDecisionIds, ['decision-two']);
});

test('status inbox falls back to the listPending snapshot when the pre-read fails', async () => {
  const original = { ...decision('decision-one'), slackMessageTs: 'old.000001' };
  const store = new FakeStore([original]);
  store.failNextReadFor.add('decision-one');
  const notifier = {
    async postDecision(item) {
      store.markPosted(item.decisionId, 'new.000001');
    },
    async postText() {},
  };

  const result = await renderPendingDecisionCards([original], TEST_SLACK_CHANNEL, store, notifier);

  assert.deepEqual(result, { attempted: 1, rendered: 1, failedDecisionIds: [] });
});

test('formatDecisionRenderSummary formats complete success', () => {
  assert.equal(
    formatDecisionRenderSummary({ attempted: 2, rendered: 2, failedDecisionIds: [] }),
    '✅ Decision inbox render: *2/2* cards published.',
  );
});

test('formatDecisionRenderSummary labels a profile for smoke-test correlation', () => {
  assert.equal(
    formatDecisionRenderSummary({ attempted: 2, rendered: 2, failedDecisionIds: [] }, 'home'),
    '✅ Decision inbox render — home: *2/2* cards published.',
  );
});

test('formatDecisionRenderSummary lists failed decision IDs', () => {
  assert.equal(
    formatDecisionRenderSummary({ attempted: 2, rendered: 1, failedDecisionIds: ['decision-two'] }, 'antonio'),
    '⚠️ Decision inbox render — antonio: *1/2* cards published.\nFailed decision IDs:\n• `decision-two`',
  );
});
