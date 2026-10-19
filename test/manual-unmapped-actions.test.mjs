import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ManualInterventionService, MANUAL_DECISION_CATALOG, decisionBlocks } from "../dist/manual-intervention.js";
import { profiles } from "../dist/config.js";

process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";
process.env.STATE_TABLE_NAME ||= "test-state";

const baseTask = () => ({
  id: "task-1", project_id: profiles.antonio.todoistProjectId,
  content: "Insta360 auto-renewal", description: "",
  due: { date: "2027-03-06", is_recurring: true, string: "every year" },
  updated_at: "2026-10-19T12:00:00Z",
});
const baseEvent = () => ({
  id: "event-1", etag: '"version-1"', summary: "Insta360 auto-renewal", description: "",
  status: "confirmed", start: { date: "2027-03-06" }, end: { date: "2027-03-07" },
  extendedProperties: { shared: { taskId: "task-1" } },
});

class DecisionStore {
  constructor(decision) { this.value = decision; }
  async get() { return this.value; }
  async finish(id, status, action) {
    assert.equal(id, this.value.decisionId);
    assert.equal(this.value.status, "pending");
    this.value.status = status;
    this.value.resolution = action;
  }
}
class Notifier {
  constructor() { this.messages = []; }
  async updateResolution(_decision, text) { this.messages.push(text); }
  async postText(text) { this.messages.push(text); }
}

function setup({ alternateTasks = [], alternateEvents = [], tombstone = undefined, completion = undefined,
  mapping = undefined, auditAction = "todoist_snapshot_reconcile_unmapped_conflict",
  cancelOnRead = 0 } = {}) {
  const original = baseTask();
  const originalEvent = baseEvent();
  const tasks = new Map([[original.id, original], ...alternateTasks.map((t) => [t.id, t])]);
  const events = new Map([[originalEvent.id, originalEvent], ...alternateEvents.map((e) => [e.id, e])]);
  const changes = [];
  const audits = [];
  let eventReads = 0;
  const state = {
    currentMapping: mapping,
    async mutationAllowed() { return true; },
    async recordMutation() { changes.push("recordMutation"); },
    async audit(_profile, action, detail) { audits.push({ action, detail }); },
    async getMappingByTaskAnyProfile() { return this.currentMapping; },
    async getMappingByEvent() { return undefined; },
    async getMappingByTask(_profile, id) {
      return this.currentMapping?.taskId === id ? this.currentMapping : undefined;
    },
    async getCalendarProjectionTombstone() { return tombstone; },
    async getCompletedCalendarProjectionByEvent() { return completion; },
    async listCompletedCalendarProjectionsByTaskAnyProfile() { return []; },
    async acceptTaskVersion() { return true; },
    async putMapping(m) { this.currentMapping = m; changes.push("putMapping"); },
    async putRecurrenceLink(m) { changes.push("putRecurrenceLink"); },
    async requestReconciliation() {
      return { state: { pending: true, generation: "generation-1" }, shouldEnqueue: false, created: false };
    },
  };
  const clients = async () => ({
    todoist: {
      async getTask(id) { if (!tasks.has(id)) throw new Error("task missing"); return tasks.get(id); },
      async listTasks() { return [...tasks.values()]; },
      async upsertTask(payload, id) {
        changes.push("todoist:upsert");
        const task = { ...tasks.get(id), ...payload, id, project_id: profiles.antonio.todoistProjectId };
        tasks.set(id, task);
        return task;
      },
      async findComment() { return undefined; },
      async upsertComment() { changes.push("todoist:comment"); return { id: "project-comment-1" }; },
    },
    calendar: {
      async getEvent(id) {
        if (!events.has(id)) throw new Error("event missing");
        eventReads += 1;
        if (eventReads === cancelOnRead) {
          events.set(id, { ...events.get(id), status: "cancelled", etag: '"version-cancelled"' });
        }
        return events.get(id);
      },
      async findByTodoistTaskId(taskId) {
        const linked = [...events.values()].filter((e) => e.extendedProperties?.shared?.taskId === taskId);
        if (linked.length !== 1) throw new Error("ambiguous task ID");
        return linked[0];
      },
      async listOccurrencesInWindow() { return [...events.values()]; },
      async upsertEvent() {
        changes.push("calendar:unexpected-general-upsert");
        throw new Error("Manual path must never use generic Calendar upsert");
      },
      async upsertEventIfUnchanged(payload, id, expectedEtag) {
        changes.push("calendar:upsert");
        const old = events.get(id);
        if (!old || old.etag !== expectedEtag || old.status !== "confirmed") {
          throw new Error("Calendar precondition failed");
        }
        const saved = { ...payload, id, etag: '"version-2"', status: "confirmed" };
        events.set(id, saved);
        return saved;
      },
      async listInstances(id) { return [{ id: `${id}_20270306`, status: "confirmed", start: { date: "2027-03-06" }, end: { date: "2027-03-07" } }]; },
    },
  });
  const decision = {
    decisionId: "antonio-todoist_unmapped_conflict-test", profile: "antonio",
    type: "todoist_unmapped_conflict", status: "pending",
    decisionDeadline: "2099-03-01T00:00:00.000Z",
    taskId: original.id, eventId: originalEvent.id,
    sourceAuditAction: auditAction,
    context: {
      taskTitle: original.content, todoistDue: original.due.date,
      calendarTitle: originalEvent.summary, calendarStart: originalEvent.start.date,
      calendarStatus: "confirmed", todoistRecurring: true,
      todoistUpdatedAt: original.updated_at,
    },
    permittedActions: MANUAL_DECISION_CATALOG.todoist_unmapped_conflict.actions,
  };
  const store = new DecisionStore(decision);
  const notifier = new Notifier();
  const service = new ManualInterventionService(store, notifier, clients);
  const run = async (action) => service.processManualDelivery({
    id: `manual:test:${action}`, kind: "manual", profile: "antonio",
    mode: "aws", receivedAt: new Date().toISOString(), headers: {}, body: "",
    manual: { decisionId: decision.decisionId, action, slackUserId: "U123" },
  }, state);
  return { state, store, notifier, tasks, events, changes, audits, run };
}

// The only DynamoDB read in this fake-provider integration is the strongly
// consistent baseline check; all mapping work uses the fake state object.
async function withNoBaseline(callback) {
  const original = documentClient.send;
  documentClient.send = async (command) => {
    if (command.constructor.name === "GetCommand"
      && command.input.Key.pk === "BASELINE#antonio#TASK#task-1") return {};
    throw new Error(`Unexpected DynamoDB call ${command.constructor.name}`);
  };
  try { await callback(); } finally { documentClient.send = original; }
}

test("Slack exposes confirmed owner choices, but never authorizes unattended auto application", () => {
  const options = MANUAL_DECISION_CATALOG.todoist_unmapped_conflict.actions;
  assert.deepEqual(options.map((action) => action.id), [
    "use_todoist_recurrence", "use_calendar_version", "keep_separate", "reconcile_now",
  ]);
  assert.equal(options[0].destructive, true);
  assert.equal(options[1].destructive, true);
  assert.equal(options.every((action) => !action.autoAllowed), true);
  const oldCard = setup();
  oldCard.store.value.permittedActions = [
    { id: "acknowledge", label: "Ignore" }, { id: "reconcile_now", label: "Retry" },
  ];
  const blocks = JSON.stringify(decisionBlocks(oldCard.store.value));
  assert.match(blocks, /Use Todoist recurrence/);
  assert.match(blocks, /Use Calendar version/);
  assert.match(blocks, /Keep separate/);
  const actions = decisionBlocks(oldCard.store.value).filter((block) => block.type === "actions")
    .flatMap((block) => block.elements);
  assert.equal(JSON.parse(actions[0].value).confirmRequired, true);
  assert.equal(JSON.parse(actions[1].value).confirmRequired, true);
  assert.equal(JSON.parse(actions[2].value).confirmRequired, false);
});

test("Use Todoist recurrence converts only the unique existing event to an RRULE and restores mapping", async () => {
  await withNoBaseline(async () => {
    const { run, store, state, events, changes } = setup();
    await run("use_todoist_recurrence");
    assert.equal(store.value.status, "resolved");
    assert.equal(state.currentMapping?.eventId, "event-1");
    assert.equal(state.currentMapping?.recurrenceOwner, "todoist");
    assert.deepEqual(events.get("event-1").recurrence, ["RRULE:FREQ=YEARLY"]);
    assert.equal(changes.includes("calendar:upsert"), true);
    assert.equal(changes.includes("putRecurrenceLink"), true);
    assert.equal(changes.includes("todoist:upsert"), false);
  });
});

test("Use Calendar version turns recurrence into one-off and links without rewriting Calendar", async () => {
  await withNoBaseline(async () => {
    const { run, store, state, tasks, changes } = setup();
    await run("use_calendar_version");
    assert.equal(store.value.status, "resolved");
    assert.equal(tasks.get("task-1").due.is_recurring, undefined);
    assert.equal(state.currentMapping?.eventId, "event-1");
    assert.equal(state.currentMapping?.recurrenceOwner, undefined);
    assert.equal(changes.includes("todoist:upsert"), true);
    assert.equal(changes.includes("calendar:upsert"), false);
  });
});

test("Keep separate resolves the decision without provider mutation", async () => {
  const { run, store, changes } = setup();
  await run("keep_separate");
  assert.equal(store.value.status, "resolved");
  assert.deepEqual(changes, []);
});

test("duplicate Calendar occurrence or Todoist identity refuses to mutate", async () => {
  const duplicateEvent = {
    ...baseEvent(), id: "other_master_20270306", recurringEventId: "other_master",
    extendedProperties: undefined,
  };
  await withNoBaseline(async () => {
    const one = setup({ alternateEvents: [duplicateEvent] });
    await one.run("use_todoist_recurrence");
    assert.equal(one.store.value.status, "stale");
    assert.equal(one.changes.length, 0);
    assert.ok(one.audits.some((a) => a.action === "manual_unmapped_resolution_duplicate_blocked"));

    const two = setup({ alternateTasks: [{ ...baseTask(), id: "other-task", due: { date: "2027-03-06" } }] });
    await two.run("use_calendar_version");
    assert.equal(two.store.value.status, "stale");
    assert.equal(two.changes.length, 0);
  });
});

test("tombstone and prior ownership block manual conversion", async () => {
  const item = setup({ tombstone: { sourceUpdatedAt: "2026-10-19T12:00:00Z" } });
  await withNoBaseline(() => item.run("use_todoist_recurrence"));
  assert.equal(item.store.value.status, "stale");
  assert.deepEqual(item.changes, []);
});

test("ambiguous recurrence conflict cannot use the one-pair conversion actions", async () => {
  const item = setup({ auditAction: "todoist_snapshot_reconcile_unmapped_ambiguous" });
  await item.run("use_todoist_recurrence");
  assert.equal(item.store.value.status, "stale");
  assert.deepEqual(item.changes, []);
});

test("late cancellation after manual preflight prevents replacement creation and mapping", async () => {
  await withNoBaseline(async () => {
    const item = setup({ cancelOnRead: 2 });
    await assert.rejects(item.run("use_todoist_recurrence"), /Approved Calendar event changed, cancelled or disappeared/);
    assert.equal(item.store.value.status, "pending");
    assert.equal(item.state.currentMapping, undefined);
    assert.equal(item.events.size, 1);
    assert.equal(item.events.get("event-1").status, "cancelled");
    assert.equal(item.changes.includes("calendar:upsert"), false);
    assert.equal(item.changes.includes("calendar:unexpected-general-upsert"), false);
    assert.ok(item.audits.some((x) => x.action === "manual_unmapped_resolution_incomplete"));
  });
});

test("missing event ETag blocks manual mutations", async () => {
  await withNoBaseline(async () => {
    const item = setup();
    item.events.get("event-1").etag = undefined;
    await item.run("use_todoist_recurrence");
    assert.equal(item.store.value.status, "stale");
    assert.deepEqual(item.changes, []);
  });
});

test("legacy persisted Ignore button remains accepted without provider mutation", async () => {
  const item = setup();
  item.store.value.permittedActions = [
    { id: "acknowledge", label: "Acknowledge" },
    { id: "reconcile_now", label: "Retry guarded reconciliation" },
  ];
  await item.run("acknowledge");
  assert.equal(item.store.value.status, "resolved");
  assert.deepEqual(item.changes, []);
});
