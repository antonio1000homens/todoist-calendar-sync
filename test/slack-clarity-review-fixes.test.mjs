import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decisionBlocks,
  MANUAL_DECISION_CATALOG,
  ManualInterventionService,
} from '../dist/manual-intervention.js';

class FakeDecisionStore {
  constructor() {
    this.decisions = new Map();
  }

  async get(id) {
    return this.decisions.get(id);
  }

  async putPending(input) {
    const existing = this.decisions.get(input.decisionId);
    if (existing) return { decision: existing, created: false };
    const decision = {
      ...input,
      status: 'pending',
      createdAt: '2026-09-14T09:00:00.000Z',
      decisionDeadline: '2099-09-21T09:00:00.000Z',
    };
    this.decisions.set(decision.decisionId, decision);
    return { decision, created: true };
  }

  async finish(id, status, resolution, user) {
    const decision = this.decisions.get(id);
    if (!decision || decision.status !== 'pending') throw new Error('not pending');
    Object.assign(decision, {
      status,
      resolution,
      resolvedBySlackUserId: user,
      resolvedAt: '2026-09-14T09:01:00.000Z',
    });
  }

  async listPending() {
    return [...this.decisions.values()].filter((decision) => decision.status === 'pending');
  }

  async setSlackLocation() {}
}

class FakePolicyStore {
  constructor(effective = { mode: 'prompt', source: 'catalog' }) {
    this.effective = effective;
  }

  async resolve() {
    return this.effective;
  }

  async list() {
    return [];
  }
}

class FakeNotifier {
  constructor() {
    this.posted = [];
    this.updated = [];
    this.text = [];
  }

  async postDecision(decision) {
    this.posted.push(decision);
  }

  async updateResolution(decision, text, blocks) {
    this.updated.push({ decision, text, blocks });
  }

  async postText(text) {
    this.text.push(text);
  }
}

function decisionFor(type, overrides = {}) {
  const policy = MANUAL_DECISION_CATALOG[type];
  return {
    decisionId: `home-${type}-test`,
    profile: 'home',
    type,
    severity: policy.severity,
    status: 'pending',
    createdAt: '2026-09-14T09:00:00.000Z',
    decisionDeadline: '2099-09-21T09:00:00.000Z',
    context: {},
    fingerprint: 'test',
    permittedActions: policy.actions,
    ...overrides,
  };
}

function sectionText(blocks) {
  return blocks
    .filter((block) => block?.type === 'section' && block.text?.type === 'mrkdwn')
    .map((block) => block.text.text)
    .join('\n');
}

test('legacy Calendar ambiguity title remains Calendar-labelled and candidate IDs stay out of human copy', () => {
  const type = 'calendar_snapshot_unmapped_ambiguous';
  const decision = decisionFor(type, {
    eventId: 'calendar-event-123',
    context: {
      title: 'School run',
      start: '2026-09-15T08:30:00+01:00',
      candidates: [
        { id: 'todoist-task-111', content: 'School run', due: { datetime: '2026-09-15T08:30:00+01:00' } },
        { id: 'todoist-task-222', content: 'School run backup', due: { date: '2026-09-15' } },
      ],
    },
  });

  const human = sectionText(decisionBlocks(decision));
  assert.match(human, /\*Calendar event:\* School run/);
  assert.doesNotMatch(human, /\*Todoist task:\* School run/);
  assert.match(human, /School run — 2026-09-15T08:30:00\+01:00/);
  assert.match(human, /School run backup — 2026-09-15/);
  assert.doesNotMatch(human, /todoist-task-111|todoist-task-222/);
});

test('new deletion prompt enriches once and displays the moved Calendar occurrence actual start', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore({ mode: 'prompt', source: 'catalog' });
  let providerFactoryCalls = 0;

  const clients = async () => {
    providerFactoryCalls += 1;
    return {
      calendar: {
        async getEvent() {
          return {
            id: 'event-1',
            summary: 'Moved dentist appointment',
            originalStartTime: { dateTime: '2026-09-15T10:00:00+01:00' },
            start: { dateTime: '2026-09-17T14:30:00+01:00' },
          };
        },
      },
      todoist: {},
    };
  };

  const mapping = {
    profile: 'home',
    eventId: 'event-1',
    taskId: 'task-1',
    originalStart: '2026-09-15T10:00:00+01:00',
    activeEffectiveStart: '2026-09-17T14:30:00+01:00',
    updatedAt: '2026-09-14T08:59:00.000Z',
  };
  const state = {
    async getMappingByTask() { return mapping; },
    async audit() {},
  };
  const delivery = {
    id: 'todoist-delete-clarity',
    kind: 'todoist',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: JSON.stringify({
      event_name: 'item:deleted',
      event_data: { id: 'task-1', content: 'Dentist appointment', is_deleted: true },
    }),
  };
  const service = new ManualInterventionService(store, notifier, clients, policies);

  assert.equal(await service.interceptTodoistDeletion(delivery, state), true);
  assert.equal(providerFactoryCalls, 1);
  assert.equal(notifier.posted.length, 1);
  assert.equal(notifier.posted[0].context.calendarTitle, 'Moved dentist appointment');
  assert.equal(notifier.posted[0].context.calendarStart, '2026-09-17T14:30:00+01:00');

  // Same deterministic state must not re-read Calendar or re-post the prompt.
  assert.equal(await service.interceptTodoistDeletion(delivery, state), true);
  assert.equal(providerFactoryCalls, 1);
  assert.equal(notifier.posted.length, 1);
});

test('observe-mode deletion does not read providers for Slack-only enrichment', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore({ mode: 'observe', source: 'profile' });
  let providerFactoryCalls = 0;
  const service = new ManualInterventionService(store, notifier, async () => {
    providerFactoryCalls += 1;
    throw new Error('provider factory must not be called');
  }, policies);
  const state = {
    async getMappingByTask() {
      return {
        profile: 'home',
        eventId: 'event-1',
        taskId: 'task-1',
        updatedAt: '2026-09-14T08:59:00.000Z',
      };
    },
    async audit() {},
  };
  const delivery = {
    id: 'todoist-delete-observe',
    kind: 'todoist',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: JSON.stringify({
      event_name: 'item:deleted',
      event_data: { id: 'task-1', content: 'Observe me', is_deleted: true },
    }),
  };

  assert.equal(await service.interceptTodoistDeletion(delivery, state), true);
  assert.equal(providerFactoryCalls, 0);
  assert.equal(notifier.posted.length, 0);
});

test('both-sides audit uses supplied reconciliation context without re-reading providers', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  let providerFactoryCalls = 0;
  const service = new ManualInterventionService(store, notifier, async () => {
    providerFactoryCalls += 1;
    throw new Error('observer must not re-read providers');
  }, new FakePolicyStore());

  await service.observeAudit({
    id: 'reconcile-1',
    kind: 'reconcile',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: '',
  }, 'home', 'todoist_snapshot_reconcile_conflict_both_sides_changed', {
    taskId: 'task-1',
    eventId: 'event-1',
    taskTitle: 'Todoist title',
    todoistDue: '2026-09-20',
    calendarTitle: 'Calendar title',
    calendarStart: '2026-09-21',
  });

  assert.equal(providerFactoryCalls, 0);
  assert.equal(notifier.posted.length, 1);
  assert.equal(notifier.posted[0].context.taskTitle, 'Todoist title');
  assert.equal(notifier.posted[0].context.calendarTitle, 'Calendar title');
});

test('failed manual action uses the human action label and leaves the decision ID to technical details', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const original = decisionFor('standalone_todoist_task_deleted', {
    decisionId: 'home-standalone_todoist_task_deleted-failure',
    taskId: 'task-1',
    eventId: 'event-1',
    context: { taskTitle: 'Dentist appointment', calendarTitle: 'Dentist appointment' },
  });
  store.decisions.set(original.decisionId, original);
  const service = new ManualInterventionService(store, notifier, async () => ({}), new FakePolicyStore());

  await service.reportDeliveryFailure({
    id: 'manual-failed-1',
    kind: 'manual',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: '',
    manual: {
      decisionId: original.decisionId,
      action: 'delete_calendar_event',
    },
  }, new Error('provider unavailable'));

  assert.equal(notifier.updated.length, 1);
  assert.match(notifier.updated[0].text, /Delete Calendar event/);
  assert.doesNotMatch(notifier.updated[0].text, /delete_calendar_event/);
  assert.doesNotMatch(notifier.updated[0].text, /home-standalone_todoist_task_deleted-failure/);
  assert.match(notifier.updated[0].text, /Technical details/);
});

test('provider-controlled mrkdwn is escaped in human-facing card text and dynamic resolution labels', async () => {
  const unsafe = '<!channel> & <@U123>';
  const decision = decisionFor('calendar_snapshot_unmapped_ambiguous', {
    decisionId: 'home-calendar_snapshot_unmapped_ambiguous-escape',
    eventId: 'event-escape',
    context: {
      title: unsafe,
      candidates: [{ id: 'task-escape', content: unsafe, due: { date: '2026-09-20' } }],
    },
  });

  const human = sectionText(decisionBlocks(decision));
  assert.match(human, /&lt;!channel&gt; &amp; &lt;@U123&gt;/);
  assert.doesNotMatch(human, /<!channel>|<@U123>/);

  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  store.decisions.set(decision.decisionId, decision);
  const service = new ManualInterventionService(store, notifier, async () => ({}), new FakePolicyStore());
  await service.reportDeliveryFailure({
    id: 'manual-bind-failed',
    kind: 'manual',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: '',
    manual: { decisionId: decision.decisionId, action: 'bind_task:task-escape' },
  }, new Error('provider unavailable'));

  assert.match(notifier.updated[0].text, /Bind &lt;!channel&gt; &amp; &lt;@U123&gt;/);
  assert.doesNotMatch(notifier.updated[0].text, /<!channel>|<@U123>/);
});

test('Todoist-owned recurrence deletion enriches from the active Calendar occurrence instead of the master', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const requestedEventIds = [];
  const clients = async () => ({
    calendar: {
      async getEvent(id) {
        requestedEventIds.push(id);
        if (id === 'active-instance') {
          return {
            id,
            summary: 'Moved recurring appointment',
            originalStartTime: { dateTime: '2026-09-15T10:00:00+01:00' },
            start: { dateTime: '2026-09-18T16:00:00+01:00' },
          };
        }
        return { id, summary: 'Series master', start: { dateTime: '2026-09-15T10:00:00+01:00' } };
      },
    },
    todoist: {},
  });
  const mapping = {
    profile: 'home',
    eventId: 'series-master',
    taskId: 'task-recurring',
    recurrenceOwner: 'todoist',
    seriesId: 'task-recurring',
    masterEventId: 'series-master',
    activeInstanceId: 'active-instance',
    originalStart: '2026-09-15T10:00:00+01:00',
    activeEffectiveStart: '2026-09-18T16:00:00+01:00',
    updatedAt: '2026-09-14T08:59:00.000Z',
  };
  const state = { async getMappingByTask() { return mapping; }, async audit() {} };
  const service = new ManualInterventionService(store, notifier, clients, new FakePolicyStore());
  const delivery = {
    id: 'todoist-delete-recurring-active',
    kind: 'todoist',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: JSON.stringify({ event_name: 'item:deleted', event_data: { id: 'task-recurring', content: 'Recurring appointment', is_deleted: true } }),
  };

  assert.equal(await service.interceptTodoistDeletion(delivery, state), true);
  assert.deepEqual(requestedEventIds, ['active-instance']);
  assert.equal(notifier.posted[0].context.calendarTitle, 'Moved recurring appointment');
  assert.equal(notifier.posted[0].context.calendarStart, '2026-09-18T16:00:00+01:00');
});

test('recurrence deletion falls back to the master without overwriting the known active effective start', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const requestedEventIds = [];
  const clients = async () => ({
    calendar: {
      async getEvent(id) {
        requestedEventIds.push(id);
        if (id === 'missing-instance') {
          const error = new Error('not found');
          error.status = 404;
          throw error;
        }
        return { id, summary: 'Recurring series', start: { dateTime: '2026-09-15T10:00:00+01:00' } };
      },
    },
    todoist: {},
  });
  const mapping = {
    profile: 'home',
    eventId: 'series-master-fallback',
    taskId: 'task-recurring-fallback',
    recurrenceOwner: 'todoist',
    seriesId: 'task-recurring-fallback',
    masterEventId: 'series-master-fallback',
    activeInstanceId: 'missing-instance',
    originalStart: '2026-09-15T10:00:00+01:00',
    activeEffectiveStart: '2026-09-18T16:00:00+01:00',
    updatedAt: '2026-09-14T08:59:00.000Z',
  };
  const state = { async getMappingByTask() { return mapping; }, async audit() {} };
  const service = new ManualInterventionService(store, notifier, clients, new FakePolicyStore());
  const delivery = {
    id: 'todoist-delete-recurring-fallback',
    kind: 'todoist',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-09-14T09:00:00.000Z',
    headers: {},
    body: JSON.stringify({ event_name: 'item:deleted', event_data: { id: 'task-recurring-fallback', content: 'Recurring fallback', is_deleted: true } }),
  };

  assert.equal(await service.interceptTodoistDeletion(delivery, state), true);
  assert.deepEqual(requestedEventIds, ['missing-instance', 'series-master-fallback']);
  assert.equal(notifier.posted[0].context.calendarTitle, 'Recurring series');
  assert.equal(notifier.posted[0].context.calendarStart, '2026-09-18T16:00:00+01:00');
});
