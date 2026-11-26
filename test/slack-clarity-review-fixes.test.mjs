import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarCorrelationConflictError, ReconciliationItemError } from '../dist/reconciliation-diagnostics.js';
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

test('both-sides conflict audit stays diagnostic without re-reading providers or opening a decision', async () => {
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
  assert.equal(notifier.posted.length, 0);
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

test('orphan Calendar 410 quarantine keeps the provider identities for review instead of an anonymous DLQ card', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(store, notifier, async () => ({}), new FakePolicyStore());
  const error = Object.assign(new Error('Provider request failed: 410'), { status: 410 });

  await service.reportDeliveryFailure({
    id: 'original:orphan:event-gone:task-gone',
    kind: 'orphan',
    profile: 'home',
    mode: 'aws',
    receivedAt: '2026-10-22T18:00:00Z',
    headers: {},
    body: '',
    orphan: { eventId: 'event-gone', taskId: 'task-gone', attempt: 2 },
  }, error);

  assert.equal(notifier.posted.length, 1);
  const decision = notifier.posted[0];
  assert.equal(decision.type, 'operational_dlq');
  assert.equal(decision.eventId, 'event-gone');
  assert.equal(decision.taskId, 'task-gone');
  assert.equal(decision.context.providerEventId, 'event-gone');
  assert.equal(decision.context.providerTaskId, 'task-gone');
  assert.equal(decision.context.status, 410);
});

test('Calendar conflict reviews show the exact requested, stored, and expected identities', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(new FakeDecisionStore(), notifier, async () => {
    assert.fail('operational review must not infer identity by re-reading providers');
  }, new FakePolicyStore());
  const masterId = 'master-' + 'a'.repeat(1017);
  const deltaId = 'delta-' + 'b'.repeat(1018);
  const requestedId = 'requested-' + 'c'.repeat(1014);
  const conflict = {
    stage: 'ensureTaskCorrelation', profile: 'home', eventId: masterId,
    taskId: requestedId, existingTaskId: 'foreign-task', expectedTaskId: 'prior-task',
    calendarEventState: 'cancelled', existingTaskState: 'unverified',
  };
  const error = new ReconciliationItemError(new CalendarCorrelationConflictError(conflict), {
    stage: 'calendar', eventId: deltaId, taskId: 'stale-delta-task',
  });
  await service.reportDeliveryFailure({
    id: 'calendar-correlation-conflict', kind: 'calendar', profile: 'home', mode: 'aws',
    receivedAt: '2026-11-26T00:00:00.000Z', headers: { authorization: 'private-header' },
    body: JSON.stringify({ description: 'private-description' }),
  }, error);
  const [decision] = notifier.posted;
  assert.equal(decision.type, 'operational_dlq');
  assert.equal(decision.context.providerTaskId, requestedId);
  assert.equal(decision.context.providerEventId, deltaId);
  assert.equal(decision.context.reconcileStage, 'calendar');
  assert.deepEqual(decision.context.correlationConflict, conflict);
  assert.doesNotMatch(JSON.stringify(decision.context), /private-header|private-description|stale-delta-task/);
  const blocks = decisionBlocks(decision);
  for (const block of blocks.filter(block => block.type === 'section')) assert.ok(block.text.text.length <= 3000);
  const text = sectionText(blocks);
  for (const id of [deltaId, masterId, requestedId, 'foreign-task', 'prior-task']) {
    assert.ok(text.includes(id), id);
  }
  assert.match(text, /task state unverified/);
  assert.match(text, /Calendar readback:.*Cancelled/);
});

test('repair DLQ failure records only the durable operation reference in safe context', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const store = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(store, notifier, async () => ({}), new FakePolicyStore());
  await service.reportDeliveryFailure({ id:'repair:op-123:attempt:1', kind:'repair', profile:'home', mode:'aws',
    receivedAt:'2026-10-23T09:00:00Z', headers:{authorization:'must-not-persist'}, body:'secret', repair:{operationId:'op-123'} },
  new Error('repair failed'));
  const decision = notifier.posted[0];
  assert.equal(decision.context.repairOperationId,'op-123');
  assert.equal(decision.context.kind,'repair');
  assert.equal(JSON.stringify(decision.context).includes('must-not-persist'),false);
  assert.equal(JSON.stringify(decision.context).includes('secret'),false);
});
