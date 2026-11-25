import assert from "node:assert/strict";
import test from "node:test";
import { Synchronizer } from "../dist/sync.js";

const PROFILE = "home";
const TASK_ID = "task-recurring";
const MASTER_ID = "todoist-master";

function recurringTask(date, content = "Water plants", updatedAt = "2026-09-14T10:00:00Z") {
  return {
    id: TASK_ID,
    content,
    description: "",
    project_id: "test-home-project",
    updated_at: updatedAt,
    due: {
      date,
      is_recurring: true,
      string: "every monday",
    },
  };
}

function masterEvent() {
  return {
    id: MASTER_ID,
    status: "confirmed",
    summary: "Water plants",
    description: "",
    start: { date: "2026-09-14" },
    end: { date: "2026-09-15" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    etag: "master-etag",
    extendedProperties: {
      shared: {
        taskId: TASK_ID,
        syncSource: "todoist-calendar-sync",
        syncRecurrenceOwner: "todoist",
        todoistRecurrence: "every monday",
        todoistAnchorStart: "2026-09-14",
        todoistAnchorEnd: "2026-09-15",
        todoistAnchorAllDay: "true",
        todoistAnchorTimeZone: "",
        todoistTemplateSummary: "Water plants",
        todoistTemplateDescription: "",
      },
    },
  };
}

function instance(id, date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    id,
    status: "confirmed",
    summary: "Water plants",
    description: "",
    recurringEventId: MASTER_ID,
    originalStartTime: { date },
    start: { date },
    end: { date: next.toISOString().slice(0, 10) },
    etag: `etag-${id}`,
    extendedProperties: {
      shared: {
        taskId: TASK_ID,
        syncRecurrenceOwner: "todoist",
      },
    },
  };
}

function timedInstance(id, startDateTime) {
  const end = new Date(Date.parse(startDateTime) + 60 * 60 * 1000).toISOString();
  return {
    id, status: "confirmed", summary: "Water plants", description: "",
    recurringEventId: MASTER_ID,
    originalStartTime: { dateTime: startDateTime },
    start: { dateTime: startDateTime, timeZone: "Europe/London" },
    end: { dateTime: end, timeZone: "Europe/London" },
    etag: `etag-${id}`,
    extendedProperties: { shared: { taskId: TASK_ID, syncRecurrenceOwner: "todoist" } },
  };
}

function mapping() {
  return {
    profile: PROFILE,
    eventId: MASTER_ID,
    taskId: TASK_ID,
    recurrenceOwner: "todoist",
    seriesId: TASK_ID,
    masterEventId: MASTER_ID,
    activeInstanceId: "instance-14",
    originalStart: "2026-09-14",
    activeEffectiveStart: "2026-09-14",
    updatedAt: "2026-09-14T09:00:00Z",
  };
}

class FakeState {
  async getMappingByTaskAnyProfile() { return this.mapping; }
  async syncBlocked() { return false; }
  constructor(initialMapping) {
    this.mapping = structuredClone(initialMapping);
    this.links = [];
    this.audits = [];
    this.mutations = 0;
  }

  async acceptTaskVersion() { return true; }
  async getCalendarProjectionTombstone() { return undefined; }
  async getMappingByTask(_profile, taskId) {
    return taskId === this.mapping?.taskId ? structuredClone(this.mapping) : undefined;
  }
  async mutationAllowed() { return true; }
  async putMapping(next) { this.mapping = structuredClone(next); }
  async putRecurrenceLink(link) { this.links.push(structuredClone(link)); }
  async deleteRecurrenceLink() {}
  async deleteCalendarProjectionTombstone() {}
  async recordRecurrence() {}
  async recordMutation() { this.mutations += 1; }
  async audit(_profile, action, detail) { this.audits.push({ action, detail }); }
}

let currentTodoistTask;

function fixture({ unlinked = false, unmapped = false, timed = false, initialMapping = mapping() } = {}) {
  const state = new FakeState(unlinked || unmapped ? undefined : initialMapping);
  const master = masterEvent();
  const instances = timed ? [
    timedInstance("instance-14", "2026-09-14T09:00:00+01:00"),
    timedInstance("instance-21", "2026-09-21T09:00:00+01:00"),
    timedInstance("instance-28", "2026-09-28T09:00:00+01:00"),
  ] : [
    instance("instance-14", "2026-09-14"),
    instance("instance-21", "2026-09-21"),
    instance("instance-28", "2026-09-28"),
  ];
  if (timed) {
    master.start = { dateTime: "2026-09-07T09:00:00+01:00", timeZone: "Europe/London" };
    master.end = { dateTime: "2026-09-07T10:00:00+01:00", timeZone: "Europe/London" };
  }
  const events = new Map(unlinked ? [] : [[MASTER_ID, master]]);
  for (const event of instances) events.set(event.id, event);
  const upserts = [];
  const calendar = {
    async getEvent(id) {
      const event = events.get(id);
      if (!event) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      return structuredClone(event);
    },
    async findByTodoistTaskId(taskId) {
      return taskId === TASK_ID ? structuredClone(events.get(MASTER_ID)) : undefined;
    },
    async listInstances() {
      return instances.map((event) => structuredClone(event));
    },
    async upsertEvent(payload, existingId) {
      const id = existingId || MASTER_ID;
      const stored = { ...structuredClone(payload), id, status: "confirmed", etag: `updated-${upserts.length + 1}` };
      events.set(id, stored);
      upserts.push({ id, payload: structuredClone(payload), existingId });
      return structuredClone(stored);
    },
    async upsertEventIfUnchanged(payload, existingId, etag) {
      assert.equal(events.get(existingId)?.etag, etag);
      return this.upsertEvent(payload, existingId);
    },
    async deleteEvent() {},
  };
  const todoist = { async listProjectComments() { return []; },
    async getTask() { return structuredClone(currentTodoistTask); } };
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist }));
  return { state, sync, upserts, events };
}

function delivery(task, oldTask, updateIntent = "item_updated") {
  currentTodoistTask = task;
  return {
    id: `delivery-${task.updated_at}-${updateIntent}`,
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: task.updated_at,
    headers: {},
    body: JSON.stringify({
      event_name: "item:updated",
      event_data: task,
      event_data_extra: { old_item: oldTask, update_intent: updateIntent },
    }),
  };
}

test("manual date edit reschedules only the mapped Todoist-owned Calendar occurrence", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-16", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts } = fixture();

  await sync.process(delivery(task, oldTask));

  assert.equal(upserts.length, 1, "the exact Calendar occurrence should be updated");
  assert.equal(upserts[0].existingId, "instance-14");
  assert.deepEqual(upserts[0].payload.start, { date: "2026-09-16" });
  assert.deepEqual(upserts[0].payload.end, { date: "2026-09-17" });
  assert.deepEqual(upserts[0].payload.originalStartTime, { date: "2026-09-14" });
  assert.equal(state.mapping.masterEventId, MASTER_ID);
  assert.equal(state.mapping.activeInstanceId, "instance-14");
  assert.equal(state.mapping.originalStart, "2026-09-14");
  assert.equal(state.mapping.activeEffectiveStart, "2026-09-16");
  assert.deepEqual(upserts[0].payload.recurrence, undefined, "an instance update must not write the master RRULE");
  assert.equal(state.audits.at(-1).action, "todoist_recurring_occurrence_rescheduled");
});

test("timed recurring due edit changes only the exact instance and preserves duration and zone", async () => {
  const initialMapping = {
    ...mapping(),
    originalStart: "2026-09-14T09:00:00+01:00",
    activeEffectiveStart: "2026-09-14T09:00:00+01:00",
  };
  const oldTask = recurringTask("2026-09-14T09:00:00+01:00");
  const task = recurringTask("2026-09-14T10:30:00+01:00", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts } = fixture({ timed: true, initialMapping });

  await sync.process(delivery(task, oldTask));

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].existingId, "instance-14");
  assert.equal(upserts[0].payload.start.dateTime, "2026-09-14T10:30:00+01:00");
  assert.equal(upserts[0].payload.end.dateTime, "2026-09-14T10:30:00.000Z");
  assert.equal(upserts[0].payload.start.timeZone, "Europe/London");
  assert.equal(upserts[0].payload.originalStartTime.dateTime, initialMapping.originalStart);
  assert.equal(state.mapping.activeInstanceId, "instance-14");
  assert.equal(state.mapping.masterEventId, MASTER_ID);
  assert.equal(state.mapping.activeEffectiveStart, "2026-09-14T10:30:00+01:00");
});

test("date edit without old_item is detected from the exact mapped effective occurrence", async () => {
  const task = recurringTask("2026-09-16", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts } = fixture();

  await sync.process(delivery(task, undefined));

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].existingId, "instance-14");
  assert.equal(upserts[0].payload.start.date, "2026-09-16");
  assert.equal(upserts[0].payload.originalStartTime.date, "2026-09-14");
  assert.equal(state.mapping.activeEffectiveStart, "2026-09-16");
});

test("Calendar-origin recurrence reschedules from exact task and master IDs without a permanent owner marker", async () => {
  const initialMapping = { ...mapping(), recurrenceOwner: "calendar" };
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-16", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts, events } = fixture({ initialMapping });
  const master = events.get(MASTER_ID);
  delete master.extendedProperties.shared.todoistRecurrence;
  delete master.extendedProperties.shared.syncRecurrenceOwner;

  await sync.process(delivery(task, oldTask));

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].existingId, "instance-14");
  assert.equal(upserts[0].payload.start.date, "2026-09-16");
  assert.equal(state.mapping.recurrenceOwner, "calendar");
  assert.equal(state.mapping.originalStart, "2026-09-14");
  assert.equal(state.mapping.activeEffectiveStart, "2026-09-16");
});

test("a retry after Calendar accepted the occurrence patch completes correlation without another write", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-16", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts, events } = fixture();
  const accepted = events.get("instance-14");
  accepted.start = { date: "2026-09-16" };
  accepted.end = { date: "2026-09-17" };
  events.set(accepted.id, accepted);

  await sync.process(delivery(task, oldTask));

  assert.equal(upserts.length, 0);
  assert.equal(state.mapping.activeInstanceId, "instance-14");
  assert.equal(state.mapping.originalStart, "2026-09-14");
  assert.equal(state.mapping.activeEffectiveStart, "2026-09-16");
  assert.equal(state.audits.at(-1).action, "todoist_recurring_occurrence_rescheduled");
  assert.equal(state.audits.at(-1).detail.recoveredAppliedWrite, true);
});

test("content-only edit keeps the existing Todoist recurrence anchor", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-14", "Water indoor plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts } = fixture();

  await sync.process(delivery(task, oldTask));

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].existingId, MASTER_ID);
  assert.equal(upserts[0].payload.summary, "Water indoor plants");
  assert.deepEqual(upserts[0].payload.start, { date: "2026-09-14" });
  assert.equal(upserts[0].payload.extendedProperties.shared.todoistAnchorStart, "2026-09-14");
  assert.equal(state.mapping.activeInstanceId, "instance-14");
});

test("completion-originated recurring due advance keeps the existing Calendar anchor", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-21", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts } = fixture();

  await sync.process(delivery(task, oldTask, "item_completed"));

  assert.equal(upserts.length, 0, "a completion echo must not shift the RRULE master");
  assert.equal(state.mapping.activeInstanceId, "instance-21");
  assert.equal(state.mapping.originalStart, "2026-09-21");
});

test("unsupported Todoist recurrence edits leave the existing Calendar master and mapping intact", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-14", "Water plants", "2026-09-14T10:09:00Z");
  task.due.string = "every other Monday";
  const { state, sync, upserts } = fixture();
  await sync.process(delivery(task, oldTask));
  assert.equal(upserts.length, 0, "unproven Phase B edit must not replace the master");
  assert.equal(state.mapping.masterEventId, MASTER_ID, "preserve the existing recurrence mapping");
  assert.equal(state.mapping.activeInstanceId, "instance-14", "preserve active occurrence identity");
  const record = state.audits.at(-1);
  assert.equal(record.action, "todoist_recurrence_unsupported_rule");
  assert.equal(record.detail.existingMirrorPreserved, true);
  assert.equal(record.detail.outcome, "source_left_unchanged");
});

test("new unsupported Todoist recurrence remains untouched with a non-blocking diagnostic", async () => {
  for (const [date, phrase] of [
    ["2026-09-14", "every other Monday"],
    ["2026-09-15", "every 2, 15, 27"],
    ["2026-09-15", "every quarter"],
  ]) {
    const task = recurringTask(date, "Water plants", "2026-09-14T11:00:00Z");
    task.due.string = phrase;
    const { state, sync, upserts } = fixture({ unlinked: true });
    await sync.process(delivery(task));
    assert.equal(upserts.length, 0, phrase);
    assert.equal(state.mapping, undefined, phrase);
    const record = state.audits.at(-1);
    assert.equal(record.action, "todoist_recurrence_unsupported_rule", phrase);
    assert.equal(record.detail.outcome, "source_left_unchanged", phrase);
  }
});

test("Phase B never overwrites a Todoist-owned Calendar master when DynamoDB mapping is absent", async () => {
  const task = recurringTask("2026-09-14", "Water plants edited", "2026-09-14T10:10:00Z");
  task.due.string = "every other Monday";
  const { state, sync, upserts } = fixture({ unmapped: true });
  await sync.process(delivery(task, undefined));
  assert.equal(upserts.length, 0);
  assert.equal(state.mapping, undefined);
  const record = state.audits.at(-1);
  assert.equal(record.action, "todoist_recurrence_unsupported_rule");
  assert.equal(record.detail.eventId, MASTER_ID);
});
