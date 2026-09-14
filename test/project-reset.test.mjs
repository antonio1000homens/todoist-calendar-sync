import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { ProjectAwareSynchronizer } from "../dist/project-sync.js";

const HOME = profiles.home.todoistProjectId;
const TASK_ID = "6hCr44chgHx8Qr2f";
const CANCELLED_EVENT_ID = "5nu5jid0nm3b6970lf7i8cqs6o";

class FakeState {
  constructor() {
    this.mapping = undefined;
    this.tombstones = new Map([[`home:${TASK_ID}`, { sourceUpdatedAt: "2026-09-03T13:09:00Z" }]]);
    this.versions = new Map([[TASK_ID, { updatedAt: "2026-09-03T21:31:00Z", deliveryId: "prior-delivery" }]]);
    this.audits = [];
  }

  async getMappingByTaskAnyProfile() { return this.mapping; }
  async acceptTaskVersion(_profile, taskId, updatedAt, deliveryId) {
    if (!updatedAt) return true;
    const old = this.versions.get(taskId);
    if (old && (old.updatedAt > updatedAt || (old.updatedAt === updatedAt && old.deliveryId !== deliveryId))) return false;
    this.versions.set(taskId, { updatedAt, deliveryId });
    return true;
  }
  async mutationAllowed() { return true; }
  async getCalendarProjectionTombstone(profile, taskId) { return this.tombstones.get(`${profile}:${taskId}`); }
  async putCalendarProjectionTombstone(profile, taskId, sourceUpdatedAt, reason) {
    this.tombstones.set(`${profile}:${taskId}`, { sourceUpdatedAt, ...(reason ? { reason } : {}) });
  }
  async deleteCalendarProjectionTombstone(profile, taskId) { this.tombstones.delete(`${profile}:${taskId}`); }
  async putMapping(mapping) { this.mapping = mapping; }
  async deleteMapping(mapping) {
    if (this.mapping?.profile === mapping.profile && this.mapping?.eventId === mapping.eventId) this.mapping = undefined;
  }
  async putRecurrenceLink() {}
  async deleteRecurrenceLink() {}
  async recordMutation() {}
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

function delivery(id, task, oldTask) {
  return {
    id,
    kind: "todoist",
    profile: "home",
    mode: "aws",
    receivedAt: "2026-09-03T21:40:00Z",
    headers: {},
    body: JSON.stringify({
      event_name: "item:updated",
      event_data: task,
      ...(oldTask ? { event_data_extra: { old_item: oldTask } } : {}),
    }),
  };
}

test("move out then back in resets a cancelled legacy projection with a fresh Calendar event", async () => {
  const updatedAt = "2026-09-03T21:31:00Z";
  const mappedTask = {
    id: TASK_ID,
    project_id: HOME,
    content: "Legacy migrated task",
    description: "Updated Todoist description",
    due: { date: "2026-09-05" },
    updated_at: updatedAt,
  };
  const unmappedTask = { ...mappedTask, project_id: "inbox" };
  const currentTask = { value: unmappedTask };
  const state = new FakeState();
  const created = [];
  const events = new Map([
    [CANCELLED_EVENT_ID, {
      id: CANCELLED_EVENT_ID,
      status: "cancelled",
      updated: "2026-09-03T13:09:00Z",
      extendedProperties: { shared: { taskId: TASK_ID } },
    }],
  ]);

  const clients = async () => ({
    calendar: {
      async findByTodoistTaskId(taskId) {
        return [...events.values()].find((event) => event.extendedProperties?.shared?.taskId === taskId);
      },
      async upsertEvent(event, existingId) {
        const id = existingId || `home-reset-${created.length + 1}`;
        const stored = { ...event, id, htmlLink: `https://calendar/${id}` };
        events.set(id, stored);
        created.push(id);
        return stored;
      },
      async deleteEvent(id) { events.delete(id); },
      async getEvent(id) {
        const event = events.get(id);
        if (event) return event;
        const error = new Error("not found");
        error.status = 404;
        throw error;
      },
      async listInstances() { return []; },
    },
    todoist: {
      async getTask() { return currentTask.value; },
      async findComment() { return undefined; },
      async upsertComment() { return { id: "reset-comment" }; },
      async deleteComment() {},
    },
  });

  const sync = new ProjectAwareSynchronizer(state, undefined, clients);

  // Moving out must work even if Todoist kept the same updated_at as the last
  // processed webhook. It replaces the historical deletion tombstone with an
  // intentional project-exit reset marker.
  await sync.process(delivery("exit-delivery", unmappedTask, mappedTask));
  assert.deepEqual(state.tombstones.get(`home:${TASK_ID}`), {
    sourceUpdatedAt: updatedAt,
    reason: "project_exit",
  });
  assert.equal(state.mapping, undefined);
  assert.equal(events.get(CANCELLED_EVENT_ID)?.status, "cancelled");

  // A webhook that does not prove an explicit project re-entry must not consume
  // the reset marker or resurrect the cancelled event.
  currentTask.value = { ...mappedTask, updated_at: undefined };
  await sync.process(delivery("unproven-create", currentTask.value));
  assert.equal(created.length, 0);
  assert.equal(state.tombstones.get(`home:${TASK_ID}`)?.reason, "project_exit");

  // Moving back in is the explicit reset action. The old cancelled Calendar
  // object is ignored and a brand-new event ID is created before the tombstone
  // is cleared.
  currentTask.value = mappedTask;
  await sync.process(delivery("reentry-delivery", mappedTask, unmappedTask));
  assert.deepEqual(created, ["home-reset-1"]);
  assert.equal(state.mapping?.eventId, "home-reset-1");
  assert.notEqual(state.mapping?.eventId, CANCELLED_EVENT_ID);
  assert.equal(state.tombstones.has(`home:${TASK_ID}`), false);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_project_projection_reset"), true);
});
