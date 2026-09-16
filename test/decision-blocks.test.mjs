import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionBlocks, decisionResolutionBlocks, MANUAL_DECISION_CATALOG } from '../dist/manual-intervention.js';

function actionIds(blocks) {
  return blocks
    .filter((block) => block?.type === 'actions')
    .flatMap((block) => block.elements || [])
    .map((element) => element.action_id)
    .filter(Boolean);
}

function mrkdwnText(blocks) {
  return blocks
    .filter((block) => block?.type === 'section' && block.text?.type === 'mrkdwn')
    .map((block) => block.text.text)
    .join('\n');
}

function contextText(blocks) {
  return blocks
    .filter((block) => block?.type === 'context')
    .flatMap((block) => block.elements || [])
    .map((element) => element.text || '')
    .join('\n');
}

test('multi-action decision cards use unique Slack action IDs', () => {
  const type = 'calendar_snapshot_unmapped_ambiguous';
  const decision = {
    decisionId: 'home-calendar_snapshot_unmapped_ambiguous-test',
    profile: 'home',
    type,
    severity: MANUAL_DECISION_CATALOG[type].severity,
    status: 'pending',
    createdAt: '2026-09-07T20:00:00.000Z',
    decisionDeadline: '2026-09-14T20:00:00.000Z',
    eventId: 'event-1',
    context: {
      calendarTitle: 'Duplicate candidate test',
      candidates: [
        { id: 'task-1', content: 'Candidate one' },
        { id: 'task-2', content: 'Candidate two' },
      ],
    },
    fingerprint: 'test',
    permittedActions: MANUAL_DECISION_CATALOG[type].actions,
  };

  const ids = actionIds(decisionBlocks(decision));
  assert.ok(ids.length >= 3);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith('gcp_sync_decision_')));
});

test('saved-default button does not reuse a normal decision action ID', () => {
  const type = 'standalone_todoist_task_deleted';
  const decision = {
    decisionId: 'antonio-standalone_todoist_task_deleted-test',
    profile: 'antonio',
    type,
    severity: MANUAL_DECISION_CATALOG[type].severity,
    status: 'pending',
    createdAt: '2026-09-07T20:00:00.000Z',
    decisionDeadline: '2026-09-14T20:00:00.000Z',
    context: {},
    fingerprint: 'test',
    permittedActions: MANUAL_DECISION_CATALOG[type].actions,
    defaultAction: 'restore_todoist_task',
    policyScope: 'profile',
  };

  const ids = actionIds(decisionBlocks(decision));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('gcp_sync_decision_default'));
});

test('deletion decision card prioritizes human-readable task and Calendar context', () => {
  const type = 'standalone_todoist_task_deleted';
  const decision = {
    decisionId: 'home-standalone_todoist_task_deleted-cf9aa1f32416bbecc517',
    profile: 'home',
    type,
    severity: MANUAL_DECISION_CATALOG[type].severity,
    status: 'pending',
    createdAt: '2026-09-14T09:00:00.000Z',
    decisionDeadline: '2026-09-21T09:00:00.000Z',
    taskId: 'task-123',
    eventId: 'event-456',
    context: {
      taskTitle: 'Take Lennox swimming',
      calendarTitle: 'Take Lennox swimming',
      todoistDue: '2026-09-14T17:30:00Z',
      calendarStart: '2026-09-14T17:30:00Z',
    },
    fingerprint: 'test',
    permittedActions: MANUAL_DECISION_CATALOG[type].actions,
  };

  const blocks = decisionBlocks(decision);
  const human = mrkdwnText(blocks);
  const technical = contextText(blocks);

  assert.match(human, /\*Item:\* Take Lennox swimming/);
  assert.match(human, /\*Todoist due:\* 2026-09-14T17:30:00Z/);
  assert.match(human, /\*Calendar start:\* 2026-09-14T17:30:00Z/);
  assert.match(human, /\*What changed:\* The Todoist task was deleted/);
  assert.doesNotMatch(human, /task-123|event-456|cf9aa1f32416bbecc517/);

  assert.match(technical, /type `standalone_todoist_task_deleted`/);
  assert.match(technical, /task ID `task-123`/);
  assert.match(technical, /event ID `event-456`/);
  assert.match(technical, /decision ID `home-standalone_todoist_task_deleted-cf9aa1f32416bbecc517`/);
});

test('operational quarantine card identifies the failed provider object and reconciliation', () => {
  const type = 'operational_dlq';
  const decision = {
    decisionId: 'work-operational_dlq-test',
    profile: 'work',
    type,
    severity: MANUAL_DECISION_CATALOG[type].severity,
    status: 'pending',
    createdAt: '2026-09-15T18:17:32.685Z',
    decisionDeadline: '2026-09-22T18:17:32.685Z',
    context: {
      kind: 'reconcile',
      status: 404,
      providerTaskId: 'task-123',
      providerEventId: 'event-456',
      failure: 'Todoist task was not found during Calendar repair',
      reconcileReason: 'scheduled',
      reconcileGeneration: 'generation-1',
      reconcileContinuation: 'mapped sequence 1',
    },
    fingerprint: 'test',
    permittedActions: MANUAL_DECISION_CATALOG[type].actions,
  };
  const blocks = decisionBlocks(decision);
  const human = mrkdwnText(blocks);
  assert.match(human, /Delivery:\* reconcile/);
  assert.match(human, /Affected Todoist task:\* `task-123`/);
  assert.match(human, /Affected Calendar event:\* `event-456`/);
  assert.match(human, /HTTP 404/);
  assert.match(human, /scheduled.*generation-1.*mapped sequence 1/);
  assert.match(human, /will not replay the failed delivery/);
  const resolved = decisionResolutionBlocks(decision, 'Resolved');
  assert.equal(resolved.filter((block) => block.type === 'actions').length, 0);
});

test('resolution and stale updates preserve the original human-readable decision context', () => {
  const type = 'standalone_todoist_task_deleted';
  const decision = {
    decisionId: 'home-standalone_todoist_task_deleted-test',
    profile: 'home',
    type,
    severity: MANUAL_DECISION_CATALOG[type].severity,
    status: 'pending',
    createdAt: '2026-09-14T09:00:00.000Z',
    decisionDeadline: '2026-09-21T09:00:00.000Z',
    taskId: 'task-123',
    eventId: 'event-456',
    context: {
      taskTitle: 'Dentist appointment',
      calendarTitle: 'Dentist appointment',
      calendarStart: '2026-09-18T10:00:00+01:00',
    },
    fingerprint: 'test',
    permittedActions: MANUAL_DECISION_CATALOG[type].actions,
  };

  const text = '⚠️ No action was taken because this request became stale.\nThe Todoist task now exists again, so the deletion decision is no longer valid.';
  const blocks = decisionResolutionBlocks(decision, text);
  const human = mrkdwnText(blocks);
  const technical = contextText(blocks);

  assert.match(human, /\*Item:\* Dentist appointment/);
  assert.match(human, /\*Calendar start:\* 2026-09-18T10:00:00\+01:00/);
  assert.match(human, /No action was taken because this request became stale/);
  assert.match(human, /Todoist task now exists again/);
  assert.match(technical, /Technical details/);
  assert.match(technical, /type `standalone_todoist_task_deleted`/);
});

test('both-sides-changed card identifies each provider version', () => {
  const type = 'both_sides_changed';
  const decision = {
    decisionId: 'home-both_sides_changed-test',
    profile: 'home',
    type,
    severity: MANUAL_DECISION_CATALOG[type].severity,
    status: 'pending',
    createdAt: '2026-09-14T09:00:00.000Z',
    decisionDeadline: '2026-09-21T09:00:00.000Z',
    taskId: 'task-123',
    eventId: 'event-456',
    context: {
      taskTitle: 'Todoist version',
      calendarTitle: 'Calendar version',
      todoistDue: '2026-09-20',
      calendarStart: '2026-09-21',
    },
    fingerprint: 'test',
    permittedActions: MANUAL_DECISION_CATALOG[type].actions,
  };

  const human = mrkdwnText(decisionBlocks(decision));
  assert.match(human, /\*Todoist task:\* Todoist version/);
  assert.match(human, /\*Calendar event:\* Calendar version/);
  assert.match(human, /Both Calendar and Todoist changed since the last synchronized baseline/);
});
