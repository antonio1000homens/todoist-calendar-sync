import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANUAL_DECISION_CATALOG,
  ManualInterventionService,
} from '../dist/manual-intervention.js';

class FakeDecisionStore {
  constructor() {
    this.decisions = new Map();
  }

  async putPending(input) {
    const existing = this.decisions.get(input.decisionId);
    if (existing) return { decision: existing, created: false };
    const decision = {
      ...input,
      status: 'pending',
      createdAt: '2026-09-07T14:00:00.000Z',
      decisionDeadline: '2099-09-14T14:00:00.000Z',
    };
    this.decisions.set(decision.decisionId, decision);
    return { decision, created: true };
  }

  async get(id) {
    return this.decisions.get(id);
  }

  async finish(id, status, resolution, user) {
    const decision = this.decisions.get(id);
    if (!decision || decision.status !== 'pending') throw new Error('not pending');
    Object.assign(decision, { status, resolution, resolvedBySlackUserId: user, resolvedAt: '2026-09-07T14:01:00.000Z' });
  }

  async listPending() {
    return [...this.decisions.values()].filter((decision) => decision.status === 'pending');
  }

  async setSlackLocation() {}
}

class FakePolicyStore {
  constructor(effective = { mode: 'prompt', source: 'catalog' }) {
    this.effective = effective;
    this.saved = [];
    this.deleted = [];
  }
  async resolve() { return this.effective; }
  async put(input) {
    const policy = { ...input, updatedAt: '2026-09-07T14:02:00.000Z' };
    this.saved.push(policy);
    return policy;
  }
  async delete(...args) { this.deleted.push(args); }
  async list() { return this.saved; }
}

class FakeNotifier {
  constructor() {
    this.posted = [];
    this.updated = [];
    this.text = [];
  }
  async postDecision(decision) { this.posted.push(decision); }
  async updateResolution(decision, text, blocks) { this.updated.push({ decision, text, blocks }); }
  async postText(text) { this.text.push(text); }
}

function mappedCalendarRecurrence() {
  return {
    profile: 'antonio',
    eventId: 'instance-1',
    taskId: 'task-1',
    recurrenceOwner: 'calendar',
    seriesId: 'series-1',
    masterEventId: 'master-1',
    activeInstanceId: 'instance-1',
    originalStart: '2026-09-15T00:00:00Z',
    activeEffectiveStart: '2026-09-15T00:00:00Z',
    updatedAt: '2026-09-07T13:59:00.000Z',
  };
}

function todoistDeleteDelivery() {
  return {
    id: 'todoist-delete-1',
    kind: 'todoist',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:00:00.000Z',
    headers: {},
    body: JSON.stringify({
      event_name: 'item:deleted',
      event_data: { id: 'task-1', content: 'test recurring', is_deleted: true },
    }),
  };
}

function decisionFor(type, overrides = {}) {
  const policy = MANUAL_DECISION_CATALOG[type];
  return {
    decisionId: `antonio-${type}-test`,
    profile: 'antonio',
    type,
    severity: policy.severity,
    status: 'pending',
    createdAt: '2026-09-07T14:00:00.000Z',
    decisionDeadline: '2099-09-14T14:00:00.000Z',
    context: {},
    fingerprint: 'test',
    permittedActions: policy.actions,
    ...overrides,
  };
}

function reconciliationState() {
  return {
    state: {
      profile: 'antonio',
      pending: true,
      generation: 'generation-1',
      reason: 'manual',
      requestedAt: '2026-09-07T14:01:00.000Z',
      lastRequestedAt: '2026-09-07T14:01:00.000Z',
      lastEnqueuedAt: '2026-09-07T14:01:00.000Z',
    },
    shouldEnqueue: false,
    created: false,
  };
}

test('decision catalog exposes bounded recurrence choices and explicit auto-safe actions', () => {
  const policy = MANUAL_DECISION_CATALOG.calendar_owned_recurrence_task_deleted;
  assert.equal(policy.detection, 'pre_mutation');
  assert.deepEqual(policy.actions.map((action) => action.id), [
    'skip_occurrence',
    'delete_this_and_future',
    'delete_whole_series',
    'restore_todoist_task',
  ]);
  assert.equal(policy.actions.find((action) => action.id === 'delete_whole_series').destructive, true);
  assert.equal(policy.actions.find((action) => action.id === 'delete_whole_series').autoAllowed, undefined);
  assert.equal(policy.actions.find((action) => action.id === 'restore_todoist_task').autoAllowed, true);
  assert.equal(policy.actions.find((action) => action.id === 'skip_occurrence').autoAllowed, true);
});

test('mapped explicit Todoist deletion is intercepted before provider mutation in prompt mode', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore({ mode: 'prompt', source: 'profile', defaultAction: 'restore_todoist_task' });
  const mapping = mappedCalendarRecurrence();
  const audits = [];
  const state = {
    async getMappingByTask(profile, taskId) {
      assert.equal(profile, 'antonio');
      assert.equal(taskId, 'task-1');
      return mapping;
    },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const service = new ManualInterventionService(decisions, notifier, async () => {
    throw new Error('provider clients must not be called while raising the decision');
  }, policies);

  assert.equal(await service.interceptTodoistDeletion(todoistDeleteDelivery(), state), true);
  assert.equal(notifier.posted.length, 1);
  assert.equal(notifier.posted[0].type, 'calendar_owned_recurrence_task_deleted');
  assert.equal(notifier.posted[0].masterEventId, 'master-1');
  assert.equal(notifier.posted[0].defaultAction, 'restore_todoist_task');
  assert.equal(notifier.posted[0].policyScope, 'profile');
  assert.equal(audits.at(-1).action, 'manual_decision_requested');
  assert.equal(audits.at(-1).detail.handlingMode, 'prompt');
});

test('terminal deterministic decision is not reopened by the same detector state', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore();
  const mapping = mappedCalendarRecurrence();
  const state = {
    async getMappingByTask() { return mapping; },
    async audit() {},
  };
  const service = new ManualInterventionService(decisions, notifier, async () => {
    throw new Error('detector must not call providers');
  }, policies);

  await service.interceptTodoistDeletion(todoistDeleteDelivery(), state);
  const original = [...decisions.decisions.values()][0];
  original.status = 'resolved';
  original.resolution = 'restore_todoist_task';
  await service.interceptTodoistDeletion(todoistDeleteDelivery(), state);

  assert.equal(decisions.decisions.size, 1);
  assert.equal([...decisions.decisions.values()][0].status, 'resolved');
  assert.equal(notifier.posted.length, 1);
});

test('observe mode detects and blocks a pre-mutation ambiguity without posting Slack', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore({ mode: 'observe', source: 'profile' });
  const mapping = mappedCalendarRecurrence();
  const audits = [];
  const state = {
    async getMappingByTask() { return mapping; },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const service = new ManualInterventionService(decisions, notifier, async () => {
    throw new Error('observe mode must not call providers');
  }, policies);

  assert.equal(await service.interceptTodoistDeletion(todoistDeleteDelivery(), state), true);
  assert.equal(notifier.posted.length, 0);
  assert.equal(decisions.decisions.size, 0);
  assert.equal(audits.at(-1).action, 'manual_detector_observed_no_mutation');
});

test('off mode disconnects the detector and allows the legacy synchronizer path', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore({ mode: 'off', source: 'profile' });
  const mapping = mappedCalendarRecurrence();
  const audits = [];
  const state = {
    async getMappingByTask() { return mapping; },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const service = new ManualInterventionService(decisions, notifier, async () => {
    throw new Error('off detector must not call providers');
  }, policies);

  assert.equal(await service.interceptTodoistDeletion(todoistDeleteDelivery(), state), false);
  assert.equal(audits.at(-1).action, 'manual_detector_disabled');
});

test('unsafe destructive action cannot be configured for unattended auto execution', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const policies = new FakePolicyStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(new FakeDecisionStore(), notifier, async () => ({}), policies);
  await service.processManualDelivery({
    id: 'manual:antonio:policy:auto-delete-series',
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:00:00.000Z',
    headers: {},
    body: '',
    manual: {
      command: 'set_policy',
      slackUserId: 'U123',
      policy: {
        decisionType: 'calendar_owned_recurrence_task_deleted',
        scope: 'profile',
        mode: 'auto',
        defaultAction: 'delete_whole_series',
      },
    },
  }, {});
  assert.equal(policies.saved.length, 0);
  assert.match(notifier.text.at(-1), /not marked auto-safe/);
});

test('safe action can be saved as an auto policy', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const policies = new FakePolicyStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(new FakeDecisionStore(), notifier, async () => ({}), policies);
  await service.processManualDelivery({
    id: 'manual:antonio:policy:auto-restore',
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:00:00.000Z',
    headers: {},
    body: '',
    manual: {
      command: 'set_policy',
      slackUserId: 'U123',
      policy: {
        decisionType: 'calendar_owned_recurrence_task_deleted',
        scope: 'profile',
        mode: 'auto',
        defaultAction: 'restore_todoist_task',
      },
    },
  }, {});
  assert.equal(policies.saved.length, 1);
  assert.equal(policies.saved[0].mode, 'auto');
  assert.equal(policies.saved[0].defaultAction, 'restore_todoist_task');
});

test('expired decision is atomically closed before provider clients are read', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const mapping = mappedCalendarRecurrence();
  const decision = decisionFor('calendar_owned_recurrence_task_deleted', {
    decisionId: 'antonio-expired-decision',
    decisionDeadline: '2020-01-01T00:00:00.000Z',
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    masterEventId: mapping.masterEventId,
    activeInstanceId: mapping.activeInstanceId,
    mappingSnapshot: mapping,
  });
  decisions.decisions.set(decision.decisionId, decision);
  const service = new ManualInterventionService(decisions, notifier, async () => {
    throw new Error('expired decision must not read providers');
  }, new FakePolicyStore());

  await service.processManualDelivery({
    id: 'manual:expired',
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:01:00.000Z',
    headers: {},
    body: '',
    manual: { decisionId: decision.decisionId, action: 'delete_whole_series', slackUserId: 'U123' },
  }, {});

  assert.equal(decisions.decisions.get(decision.decisionId).status, 'expired');
  assert.match(notifier.updated.at(-1).text, /expired/);
  assert.match(notifier.updated.at(-1).text, /No provider mutation/);
});

test('manual provider mutation is deferred while normal mutation circuit is open', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const mapping = mappedCalendarRecurrence();
  const decision = decisionFor('calendar_owned_recurrence_task_deleted', {
    decisionId: 'antonio-circuit-decision',
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    seriesId: mapping.seriesId,
    masterEventId: mapping.masterEventId,
    activeInstanceId: mapping.activeInstanceId,
    mappingSnapshot: mapping,
  });
  decisions.decisions.set(decision.decisionId, decision);
  const audits = [];
  let calendarWrites = 0;
  const state = {
    async getMappingByTask() { return mapping; },
    async mutationAllowed() { return false; },
    async recordMutation() { throw new Error('recordMutation must not run when circuit is open'); },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const clients = async () => ({
    todoist: {
      async getTask() { const error = new Error('not found'); error.status = 404; throw error; },
    },
    calendar: {
      async deleteEvent() { calendarWrites += 1; },
    },
  });
  const service = new ManualInterventionService(decisions, notifier, clients, new FakePolicyStore());

  await service.processManualDelivery({
    id: 'manual:circuit',
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:01:00.000Z',
    headers: {},
    body: '',
    manual: { decisionId: decision.decisionId, action: 'delete_whole_series', slackUserId: 'U123' },
  }, state);

  assert.equal(calendarWrites, 0);
  assert.equal(decisions.decisions.get(decision.decisionId).status, 'pending');
  assert.equal(audits.at(-1).action, 'manual_action_deferred_safety');
  assert.match(notifier.updated.at(-1).text, /deferred by the normal sync safety controls/);
});

test('calendar_wins recreates a missing Todoist side instead of DLQing the conflict', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const mapping = {
    profile: 'antonio',
    eventId: 'event-1',
    taskId: 'missing-task',
    updatedAt: '2026-09-07T13:59:00.000Z',
  };
  const decision = decisionFor('both_sides_changed', {
    decisionId: 'antonio-both-sides-missing-task',
    taskId: mapping.taskId,
    eventId: mapping.eventId,
  });
  decisions.decisions.set(decision.decisionId, decision);
  const operations = [];
  const state = {
    async getMappingByTask() { return mapping; },
    async mutationAllowed() { return true; },
    async recordMutation() { operations.push('state:recordMutation'); },
    async deleteMapping() { operations.push('state:deleteMapping'); },
    async putMapping(next) { operations.push(`state:putMapping:${next.taskId}`); },
    async requestReconciliation() { return reconciliationState(); },
  };
  const clients = async () => ({
    calendar: {
      async getEvent() {
        return { id: 'event-1', summary: 'Recovered appointment', start: { date: '2026-09-20' }, end: { date: '2026-09-21' } };
      },
    },
    todoist: {
      async getTask() { const error = new Error('not found'); error.status = 404; throw error; },
      async upsertTask() { operations.push('todoist:create'); return { id: 'task-new', content: 'Recovered appointment', due: { date: '2026-09-20' } }; },
    },
  });
  const service = new ManualInterventionService(decisions, notifier, clients, new FakePolicyStore());

  await service.processManualDelivery({
    id: 'manual:calendar-wins-recreate',
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:01:00.000Z',
    headers: {},
    body: '',
    manual: { decisionId: decision.decisionId, action: 'calendar_wins', slackUserId: 'U123' },
  }, state);

  assert.deepEqual(operations.slice(0, 4), [
    'todoist:create',
    'state:recordMutation',
    'state:deleteMapping',
    'state:putMapping:task-new',
  ]);
  assert.equal(decisions.decisions.get(decision.decisionId).status, 'resolved');
});

test('delete whole recurrence uses circuit/budgeted provider write before removing mapping ownership', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore();
  const mapping = mappedCalendarRecurrence();
  const operations = [];

  const decision = decisionFor('calendar_owned_recurrence_task_deleted', {
    decisionId: 'antonio-calendar_owned_recurrence_task_deleted-test',
    taskId: 'task-1',
    eventId: 'instance-1',
    seriesId: 'series-1',
    masterEventId: 'master-1',
    activeInstanceId: 'instance-1',
    mappingSnapshot: mapping,
  });
  decisions.decisions.set(decision.decisionId, decision);

  const state = {
    async getMappingByTask() { return mapping; },
    async mutationAllowed() { return true; },
    async deleteMapping() { operations.push('state:deleteMapping'); },
    async deleteRecurrenceLink() { operations.push('state:deleteRecurrenceLink'); },
    async recordMutation() { operations.push('state:recordMutation'); },
    async requestReconciliation() { return reconciliationState(); },
  };

  const clients = async () => ({
    todoist: {
      async getTask() { const error = new Error('not found'); error.status = 404; throw error; },
    },
    calendar: {
      async deleteEvent(id) { operations.push(`calendar:delete:${id}`); },
    },
  });
  const service = new ManualInterventionService(decisions, notifier, clients, policies);
  await service.processManualDelivery({
    id: `manual:antonio:${decision.decisionId}:delete_whole_series`,
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:01:00.000Z',
    headers: {},
    body: '',
    manual: {
      decisionId: decision.decisionId,
      action: 'delete_whole_series',
      slackUserId: 'U123',
    },
  }, state);

  assert.deepEqual(operations.slice(0, 4), [
    'calendar:delete:master-1',
    'state:recordMutation',
    'state:deleteMapping',
    'state:deleteRecurrenceLink',
  ]);
  assert.equal(decisions.decisions.get(decision.decisionId).status, 'resolved');
  assert.match(notifier.updated.at(-1).text, /Delete whole Calendar series/);
  assert.ok(notifier.updated.at(-1).blocks, 'resolved prompt should offer future policy controls');
});
