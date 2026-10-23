import assert from 'node:assert/strict';
import test from 'node:test';
import { StateRepository } from '../dist/repository.js';
import { ReviewStore, SyncControls } from '../dist/review-store.js';
import { documentClient } from '../dist/dynamodb-capacity.js';
import {
  decisionBlocks,
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
  async postDecision(decision) { this.posted.push(decision); return true; }
  async updateResolution(decision, text, blocks) { this.updated.push({ decision, text, blocks }); }
  async postText(text) { this.text.push(text); }
  async reconciliationOutcome(_channel, _thread, text) { this.text.push(text); }
  async reconciliationLocation(channel, ts) { return `<https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}|active reconciliation thread>`; }
  async updateReconciliationIncident(channel, ts, text) { this.updated.push({ channel, ts, text }); }
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
    async syncBlocked() { return false; },
    async getMappingByTask(profile, taskId) {
      assert.equal(profile, 'antonio');
      assert.equal(taskId, 'task-1');
      return mapping;
    },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const service = new ManualInterventionService(decisions, notifier, async () => ({
    todoist: {
      async getTask() {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      },
    },
    calendar: {
      async getEvent() {
        return { id: 'instance-1', summary: 'test recurring', start: { dateTime: '2026-09-15T00:00:00Z' } };
      },
    },
  }), policies);

  assert.equal(await service.interceptTodoistDeletion(todoistDeleteDelivery(), state), true);
  assert.equal(notifier.posted.length, 1);
  assert.equal(notifier.posted[0].type, 'calendar_owned_recurrence_task_deleted');
  assert.equal(notifier.posted[0].masterEventId, 'master-1');
  assert.equal(notifier.posted[0].defaultAction, 'restore_todoist_task');
  assert.equal(notifier.posted[0].policyScope, 'profile');
  assert.equal(audits.at(-1).action, 'manual_decision_requested');
  assert.equal(audits.at(-1).detail.handlingMode, 'prompt');
});

test('stale Todoist deletion webhook does not create a prompt when the task already exists', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const audits = [];
  const mapping = mappedCalendarRecurrence();
  const state = {
    async syncBlocked() { return false; },
    async getMappingByTask() { return mapping; },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const service = new ManualInterventionService(decisions, notifier, async () => ({
    todoist: { async getTask() { return { id: 'task-1', content: 'test recurring' }; } },
    calendar: {},
  }), new FakePolicyStore());

  assert.equal(await service.interceptTodoistDeletion(todoistDeleteDelivery(), state), true);
  assert.equal(decisions.decisions.size, 0);
  assert.equal(notifier.posted.length, 0);
  assert.equal(audits.at(-1).action, 'manual_decision_suppressed_current_task_exists');
});

test('terminal deterministic decision is not reopened by the same detector state', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const policies = new FakePolicyStore();
  const mapping = mappedCalendarRecurrence();
  const state = {
    async syncBlocked() { return false; },
    async getMappingByTask() { return mapping; },
    async audit() {},
  };
  const service = new ManualInterventionService(decisions, notifier, async () => ({
    todoist: {
      async getTask() {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      },
    },
    calendar: {
      async getEvent() {
        return { id: 'instance-1', summary: 'test recurring', start: { dateTime: '2026-09-15T00:00:00Z' } };
      },
    },
  }), policies);

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
    async syncBlocked() { return false; },
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
    async syncBlocked() { return false; },
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
    async syncBlocked() { return false; },
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
    async syncBlocked() { return false; },
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
    async syncBlocked() { return false; },
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

test('unmapped conflict creates one stable non-destructive manual decision', async (t) => {
  t.mock.method(ReviewStore.prototype, 'observeDecision', async () => {});
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(
    decisions, notifier,
    async () => ({
      todoist: { async getTask() { return { id: 'task-1', content: 'Renew annually', due: { date: '2027-01-01', is_recurring: true } }; } },
      calendar: { async getEvent() { return { id: 'legacy-event', status: 'confirmed', summary: 'Renew annually', start: { date: '2027-01-01' } }; } },
    }),
    new FakePolicyStore(),
  );
  const delivery = { ...todoistDeleteDelivery(), kind: 'reconcile', id: 'reconcile-1' };
  const detail = { taskId: 'task-1', eventId: 'legacy-event', mismatchCategories:['title_mismatch'],
    taskUpdatedAt:'2026-09-07T13:59:00.000Z', calendarEtag:'etag-1' };
  await service.observeAudit(delivery, 'antonio', 'todoist_snapshot_reconcile_unmapped_conflict', detail);
  await service.observeAudit({ ...delivery, id: 'reconcile-2' }, 'antonio', 'todoist_snapshot_reconcile_unmapped_conflict', detail);
  assert.equal(notifier.posted.length, 1);
  const decision = notifier.posted[0];
  assert.equal(decision.type, 'todoist_unmapped_conflict');
  assert.equal(decision.context.taskTitle, 'Renew annually');
  assert.equal(decision.context.todoistRecurring, true);
  assert.match(decision.context.conflictKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(decision.permittedActions.map((action) => action.id), [
    'use_todoist_recurrence', 'split_future_todoist', 'use_calendar_version', 'keep_separate', 'reconcile_now',
  ]);
  assert.equal(decision.permittedActions[0].destructive, true);
  assert.equal(decision.permittedActions[1].destructive, true);
  assert.equal(decision.permittedActions[2].destructive, true);
  assert.equal(decision.permittedActions[3].destructive, undefined);
  assert.ok(decision.permittedActions.every((action) => !action.autoAllowed));
});

test('changed provider state after dismissal creates a new case while unchanged repeats coalesce', async (t) => {
  t.mock.method(ReviewStore.prototype, 'observeDecision', async () => {});
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions=new FakeDecisionStore(),notifier=new FakeNotifier();
  const service=new ManualInterventionService(decisions,notifier,async()=>({
    todoist:{async getTask(){return {id:'task-1',content:'Annual task',due:{date:'2027-01-01',is_recurring:true}};}},
    calendar:{async getEvent(){return {id:'event-1',status:'confirmed',summary:'Changed event',start:{date:'2027-01-02'}};}},
  }),new FakePolicyStore());
  const delivery={...todoistDeleteDelivery(),kind:'reconcile',id:'reconcile-state-change',reconcile:{generation:'generation-2',reason:'manual'}};
  const first=await service.observeAudit(delivery,'antonio','todoist_snapshot_reconcile_unmapped_conflict',{
    taskId:'task-1',eventId:'event-1',mismatchCategories:['title_mismatch'],taskUpdatedAt:'task-v1',calendarEtag:'etag-v1',
  });
  await decisions.finish(first.caseId,'resolved','dismiss');
  const changed=await service.observeAudit(delivery,'antonio','todoist_snapshot_reconcile_unmapped_conflict',{
    taskId:'task-1',eventId:'event-1',mismatchCategories:['title_mismatch','start_mismatch'],taskUpdatedAt:'task-v2',calendarEtag:'etag-v2',
  });
  const repeated=await service.observeAudit({...delivery,id:'reconcile-state-change-2'},'antonio','todoist_snapshot_reconcile_unmapped_conflict',{
    taskId:'task-1',eventId:'event-1',mismatchCategories:['title_mismatch','start_mismatch'],taskUpdatedAt:'task-v2',calendarEtag:'etag-v2',
  });
  assert.notEqual(first.caseId,changed.caseId);
  assert.equal(first.caseStatus,'open');
  assert.equal(changed.caseStatus,'open');
  assert.equal(repeated.caseId,changed.caseId);
  assert.equal(notifier.posted.length,2);
});

test('cancelled Calendar projection conflict is a distinct manual decision type', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(
    decisions, notifier,
    async () => ({
      todoist: { async getTask() { return { id: 'task-1', content: 'Renew annually', due: { date: '2027-01-01' } }; } },
      calendar: { async getEvent() { return { id: 'cancelled', status: 'cancelled', summary: 'Renew annually' }; } },
    }),
    new FakePolicyStore(),
  );
  const delivery = { ...todoistDeleteDelivery(), kind: 'reconcile' };
  await service.observeAudit(delivery, 'antonio', 'todoist_snapshot_reconcile_cancelled_projection_blocked', {
    taskId: 'task-1', eventId: 'cancelled',
  });
  assert.equal(notifier.posted[0].type, 'todoist_cancelled_projection_blocked');
  assert.equal(notifier.posted[0].context.calendarStatus, 'cancelled');
  assert.equal(notifier.posted[0].permittedActions[0].id, 'acknowledge');
});


test('guarded retry keeps an unresolved unmapped decision pending and actionable', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const decision = decisionFor('todoist_unmapped_conflict', {
    decisionId: 'antonio-unmapped-retry-test',
  });
  decisions.decisions.set(decision.decisionId, decision);
  let requested = 0;
  const state = {
    async syncBlocked() { return false; },
    async requestReconciliation(profile, reason) {
      requested += 1;
      assert.equal(profile, 'antonio');
      assert.equal(reason, 'manual');
      return reconciliationState();
    },
  };
  const service = new ManualInterventionService(decisions, notifier, async () => ({}), new FakePolicyStore());

  await service.processManualDelivery({
    id: 'manual:unmapped-retry',
    kind: 'manual',
    profile: 'antonio',
    mode: 'aws',
    receivedAt: '2026-09-07T14:01:00.000Z',
    headers: {},
    body: '',
    manual: { decisionId: decision.decisionId, action: 'reconcile_now', slackUserId: 'U123' },
  }, state);

  assert.equal(requested, 1);
  assert.equal(decisions.decisions.get(decision.decisionId).status, 'pending');
  assert.match(notifier.text.at(-1), /Reconciliation already active/);
  assert.equal(notifier.updated.length, 0, 'the originating incident card stays open during reconciliation');
});

test('Calendar-only ambiguity enriches and renders bounded candidate details read-only', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(
    decisions, notifier,
    async () => ({
      todoist: {
        async getTask(id) {
          return { id, content: 'Renewal task', due: { date: '2027-06-11', is_recurring: true } };
        },
      },
      calendar: {
        async getEvent(id) {
          return {
            id,
            status: 'confirmed',
            summary: 'Renewal series',
            start: { date: '2027-06-11' },
            recurrence: ['RRULE:FREQ=YEARLY'],
          };
        },
      },
    }),
    new FakePolicyStore(),
  );
  await service.observeAudit(
    { ...todoistDeleteDelivery(), kind: 'reconcile', id: 'reconcile-calendar-only' },
    'antonio',
    'calendar_snapshot_recurring_identity_conflict',
    { eventId: 'series-event', seriesId: 'series-1', candidateTaskIds: ['task-a', 'task-b'] },
  );

  const decision = notifier.posted[0];
  assert.equal(decision.type, 'todoist_unmapped_conflict');
  assert.equal(decision.context.calendarTitle, 'Renewal series');
  assert.equal(decision.context.calendarStart, '2027-06-11');
  assert.deepEqual(decision.context.readOnlyCandidates.map((candidate) => candidate.id), ['task-a', 'task-b']);
  const rendered = JSON.stringify(decisionBlocks(decision));
  assert.match(rendered, /Conflicting provider objects \(read-only\)/);
  assert.match(rendered, /Renewal task/);
  assert.match(rendered, /recurring: yes/);
  assert.doesNotMatch(rendered, /bind_task:/);
});

test('reconciliation actions cannot be saved as automatic policies', async () => {
  for (const policy of Object.values(MANUAL_DECISION_CATALOG)) {
    for (const action of policy.actions.filter((candidate) => candidate.id === 'reconcile_now')) {
      assert.notEqual(action.autoAllowed, true);
    }
  }
});

test('saved automatic reconciliation policies fall back to an explicit decision', async () => {
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = 'true';
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const service = new ManualInterventionService(decisions, notifier, async () => {
    throw new Error('provider clients must not be read');
  }, new FakePolicyStore({ mode: 'auto', defaultAction: 'reconcile_now', source: 'profile' }));
  await service.observeAudit({ ...todoistDeleteDelivery(), kind: 'reconcile' }, 'antonio', 'reconciliation_circuit_open_deferred', {});
  assert.equal(notifier.posted.length, 1);
  assert.equal(notifier.posted[0].policyMode, 'prompt');
  assert.equal(notifier.posted[0].status, 'pending');
});

test('old queued AUTO_POLICY reconciliation actions require a new Slack click', async () => {
  const decisions = new FakeDecisionStore();
  const notifier = new FakeNotifier();
  const decision = decisionFor('operational_dlq', {
    permittedActions: [{ id: 'reconcile_now', label: 'Reconcile', autoAllowed: true }],
  });
  decisions.decisions.set(decision.decisionId, decision);
  const service = new ManualInterventionService(decisions, notifier);
  await service.processManualDelivery({
    ...todoistDeleteDelivery(), kind: 'manual',
    manual: { decisionId: decision.decisionId, action: 'reconcile_now', slackUserId: 'AUTO_POLICY' },
  }, { async requestReconciliation() { throw new Error('automatic reconciliation must not run'); } });
  assert.equal(notifier.posted.length, 1);
  assert.equal(decisions.decisions.get(decision.decisionId).status, 'pending');
  assert.equal(notifier.posted[0].permittedActions[0].autoAllowed, undefined);
});

for (const entry of ['decision', 'command']) {
  test(`coalesced ${entry} requests point to the active run instead of promising another outcome`, async () => {
    const decisions = new FakeDecisionStore();
    const notifier = new FakeNotifier();
    notifier.postText = async (text) => { notifier.text.push(text); return '2.000'; };
    const decision = decisionFor('operational_dlq', { slackChannelId: 'CSECOND', slackMessageTs: '2.000' });
    decisions.decisions.set(decision.decisionId, decision);
    const service = new ManualInterventionService(decisions, notifier);
    const state = {
    async syncBlocked() { return false; },
      async requestReconciliation() {
        const result = reconciliationState();
        result.state.slackChannelId = 'CFIRST';
        result.state.slackThreadTs = '1.000';
        return result;
      },
    };
    await service.processManualDelivery({
      ...todoistDeleteDelivery(), kind: 'manual',
      manual: { slackUserId: 'U123', slackChannelId: 'CSECOND', ...(entry === 'command'
        ? { command: 'reconcile_now' } : { decisionId: decision.decisionId, action: 'reconcile_now' }) },
    }, state);
    assert.match(notifier.text.at(-1), /already active/);
    assert.match(notifier.text.at(-1), /https:\/\/example.slack.com\/archives\/CFIRST\/p1000/);
    assert.doesNotMatch(notifier.text.at(-1), /final outcome in this thread/);
    if (entry === 'command') assert.match(notifier.updated.at(-1).text, /already active/);
  });
}

for (const protection of ['activeRepair','excluded','rejectedPair']) {
  for (const ownRepair of [false,true]) test(`Slack Calendar-wins action respects ${protection} with ownRepair=${ownRepair}`,async t=>{
    process.env.STATE_TABLE_NAME ||= 'test-state';
    const decisions=new FakeDecisionStore(),notifier=new FakeNotifier(),writes=[];
    const decision=decisionFor('both_sides_changed',{decisionId:'protected-pair',taskId:'task-1',eventId:'event-1'});
    decisions.decisions.set(decision.decisionId,decision);
    t.mock.method(documentClient,'send',async()=>({}));
    t.mock.method(ReviewStore.prototype,'get',async pk=>pk.startsWith('REJECTED_PAIR#')&&protection==='rejectedPair'
      ?{operationId:ownRepair?'repair':'another-repair'}:undefined);
    t.mock.method(SyncControls.prototype,'control',async()=>({
      activeRepair:ownRepair?'repair':protection==='activeRepair'?'other-repair':undefined,
      excluded:protection==='excluded',
    }));
    t.mock.method(SyncControls.prototype,'rejected',async()=>protection==='rejectedPair');
    const state={
      repairOperationId:ownRepair?'repair':undefined,
      syncBlocked:StateRepository.prototype.syncBlocked,
      async getMappingByTask(){return {profile:'antonio',taskId:'task-1',eventId:'event-1'};},
      async mutationAllowed(){return true;},async recordMutation(){},async audit(){},
    };
    const service=new ManualInterventionService(decisions,notifier,async()=>({
      calendar:{async getEvent(){return {id:'event-1',summary:'Calendar title',status:'confirmed',start:{date:'2099-12-18'}};}},
      todoist:{async getTask(){return {id:'task-1',content:'Old title'};},async upsertTask(value){writes.push(value);return {id:'task-1',...value};}},
    }),new FakePolicyStore());
    await service.processManualDelivery({id:'manual-protected',kind:'manual',profile:'antonio',mode:'aws',headers:{},body:'',
      manual:{decisionId:decision.decisionId,action:'calendar_wins'}},state);
    assert.equal(writes.length,ownRepair?1:0);
    assert.equal(decision.status,ownRepair?'resolved':'pending');
    if(!ownRepair)assert.match(notifier.updated[0].text,/protected by a repair, exclusion, or rejected link/);
  });
}

test('manual provider writes recheck a barrier established after initial decision validation',async t=>{
  process.env.STATE_TABLE_NAME ||= 'test-state';
  const decisions=new FakeDecisionStore(),notifier=new FakeNotifier();let barrier=false,writes=0;
  const decision=decisionFor('both_sides_changed',{decisionId:'new-barrier',taskId:'task-1',eventId:'event-1'});
  decisions.decisions.set(decision.decisionId,decision);
  t.mock.method(documentClient,'send',async()=>({}));
  t.mock.method(SyncControls.prototype,'control',async()=>barrier?{activeRepair:'another-repair'}:undefined);
  t.mock.method(SyncControls.prototype,'rejected',async()=>false);
  const state={syncBlocked:StateRepository.prototype.syncBlocked,
    async getMappingByTask(){return {profile:'antonio',taskId:'task-1',eventId:'event-1'};},
    async mutationAllowed(){return true;},async recordMutation(){},async audit(){},
  };
  const service=new ManualInterventionService(decisions,notifier,async()=>({
    calendar:{async getEvent(){barrier=true;return {id:'event-1',summary:'Calendar title',status:'confirmed',start:{date:'2099-12-18'}};}},
    todoist:{async getTask(){return {id:'task-1',content:'Old title'};},async upsertTask(){writes++;}},
  }),new FakePolicyStore());
  await service.processManualDelivery({id:'late-barrier',kind:'manual',profile:'antonio',mode:'aws',headers:{},body:'',
    manual:{decisionId:decision.decisionId,action:'calendar_wins'}},state);
  assert.ok(barrier);assert.equal(writes,0);assert.equal(decision.status,'pending');
});
