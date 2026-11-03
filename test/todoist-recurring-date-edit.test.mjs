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
    project_id: "home-project",
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
    extendedProperties: {
      shared: {
        taskId: TASK_ID,
        syncRecurrenceOwner: "todoist",
      },
    },
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

function fixture({ unlinked = false, unmapped = false } = {}) {
  const state = new FakeState(unlinked || unmapped ? undefined : mapping());
  const events = new Map(unlinked ? [] : [[MASTER_ID, masterEvent()]]);
  const instances = [
    instance("instance-14", "2026-09-14"),
    instance("instance-21", "2026-09-21"),
    instance("instance-28", "2026-09-28"),
  ];
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
      const stored = { ...structuredClone(payload), id, status: "confirmed" };
      events.set(id, stored);
      upserts.push({ id, payload: structuredClone(payload), existingId });
      return structuredClone(stored);
    },
    async deleteEvent() {},
  };
  const todoist = { async getTask() { return structuredClone(currentTodoistTask); } };
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist }));
  return { state, sync, upserts };
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

test("manual date edit re-anchors a Todoist-owned recurring Calendar series", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-21", "Water plants", "2026-09-14T10:05:00Z");
  const { state, sync, upserts } = fixture();

  await sync.process(delivery(task, oldTask));

  assert.equal(upserts.length, 1, "the recurring Calendar master should be updated, not treated as a no-op");
  assert.equal(upserts[0].existingId, MASTER_ID);
  assert.deepEqual(upserts[0].payload.start, { date: "2026-09-21" });
  assert.equal(upserts[0].payload.extendedProperties.shared.todoistAnchorStart, "2026-09-21");
  assert.equal(state.mapping.activeInstanceId, "instance-21");
  assert.equal(state.mapping.originalStart, "2026-09-21");
  assert.equal(state.audits.at(-1).detail.recurrenceReanchored, true);
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

test("Phase B recurrence edits never delete an existing Calendar RRULE master or its mapping", async () => {
  const oldTask = recurringTask("2026-09-14");
  const task = recurringTask("2026-09-14", "Water plants", "2026-09-14T10:09:00Z");
  task.due.string = "every other Monday";
  const { state, sync, upserts } = fixture();
  await sync.process(delivery(task, oldTask));
  assert.equal(upserts.length, 0, "unproven Phase B edit must not replace the master");
  assert.equal(state.mapping.masterEventId, MASTER_ID, "preserve the existing recurrence mapping");
  assert.equal(state.mapping.activeInstanceId, "instance-14", "preserve active occurrence identity");
  const record = state.audits.at(-1);
  assert.equal(record.action, "todoist_phase_b_existing_series_requires_review");
  assert.equal(record.detail.phaseBFamily, "alternate_weekday");
  assert.equal(record.detail.phaseBDisposition, "rolling_required");
  assert.equal(record.detail.phaseBReason, "anchor_not_verified");
  assert.equal(record.detail.phaseBCandidateRrule, "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
});

test("new unsupported Phase B schedules remain one-off rolling projections with diagnostic evidence", async () => {
  for (const [date, phrase, family, rule] of [
    ["2026-09-14", "every other Monday", "alternate_weekday", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"],
    ["2026-09-15", "every 2, 15, 27", "multi_month_day", "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"],
    ["2026-09-15", "every quarter", "quarterly", "RRULE:FREQ=MONTHLY;INTERVAL=3"],
  ]) {
    const task = recurringTask(date, "Water plants", "2026-09-14T11:00:00Z");
    task.due.string = phrase;
    const { state, sync, upserts } = fixture({ unlinked: true });
    await sync.process(delivery(task));
    assert.equal(upserts.length, 1, phrase);
    assert.equal(upserts[0].payload.recurrence, undefined, phrase);
    assert.equal(state.mapping.recurrenceOwner, "todoist", phrase);
    assert.equal(state.mapping.masterEventId, undefined, phrase);
    const record = state.audits.at(-1);
    assert.equal(record.action, "todoist_created_calendar", phrase);
    assert.equal(record.detail.recurrenceProjection, "rolling", phrase);
    assert.equal(record.detail.phaseBFamily, family, phrase);
    assert.equal(record.detail.phaseBCandidateRrule, rule, phrase);
    assert.equal(record.detail.phaseBReason, "anchor_not_verified", phrase);
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
  assert.equal(record.action, "todoist_phase_b_existing_series_requires_review");
  assert.equal(record.detail.eventId, MASTER_ID);
});
