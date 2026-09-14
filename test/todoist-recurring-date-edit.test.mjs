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

function fixture() {
  const state = new FakeState(mapping());
  const events = new Map([[MASTER_ID, masterEvent()]]);
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
  const todoist = {};
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist }));
  return { state, sync, upserts };
}

function delivery(task, oldTask, updateIntent = "item_updated") {
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
