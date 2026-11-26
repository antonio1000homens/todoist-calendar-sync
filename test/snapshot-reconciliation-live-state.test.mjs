import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { serializeDeletionTombstoneComment, serializeMappingComment } from "../dist/mapping-comments.js";
import { SnapshotReconciler } from "../dist/reconciliation.js";

const HOME = profiles.home.todoistProjectId;

class FakeState {
  constructor() { this.audits = []; }
  async syncBlocked() { return false; }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}
class FakeStore {
  async listMappings() { return []; }
  async getBaseline() { return undefined; }
  async putBaseline(...args) { (this.baselines ||= []).push(args); }
  async deleteBaseline() {}
}
const task = (updatedAt) => ({
  id: "task-live", project_id: HOME, content: "Task", due: { date: "2026-09-10" }, updated_at: updatedAt,
});
const tombstoneComment = (taskId) => {
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  return { id: "retired-deletion-comment", project_id: HOME, content: serializeDeletionTombstoneComment({
    schemaVersion: 1, profile: "home", projectId: HOME, taskId, eventIds: ["old-event"], createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 18 * 24 * 60 * 60 * 1000).toISOString(),
  }) };
};

function createReconciler({ currentTask, calendarEvent, projectComments = [], repairs }) {
  const comments = [...projectComments];
  const eventById = new Map(calendarEvent ? [[calendarEvent.id, calendarEvent]] : []);
  const pair = {
    todoist: {
      async listProjectComments() { return comments; },
      async listTasks() { return [currentTask]; },
      async getTask(id) { return id === currentTask.id ? currentTask : undefined; },
    },
    calendar: {
      async findByTodoistTaskId() { return calendarEvent; },
      async getEvent(id) { return eventById.get(id); },
    },
  };
  const repair = async (delivery) => {
    repairs.push(JSON.parse(delivery.body));
    const event = { id: "created-event", status: "confirmed", etag: "new-etag", summary: currentTask.content,
      description: "", start: { date: currentTask.due.date }, end: { date: "2026-09-11" } };
    eventById.set(event.id, event);
    comments.push({ id: "mapping-comment", project_id: HOME, content: serializeMappingComment({
      profile: "home", projectId: HOME, taskId: currentTask.id, eventId: event.id,
      syncedTitle: currentTask.content, syncedDescription: "", updatedAt: currentTask.updated_at,
    }, HOME) });
  };
  return new SnapshotReconciler(new FakeState(), async () => pair, new FakeStore(), repair, async () => {});
}

const cancelledEvent = (updated) => ({
  id: "old-event", status: "cancelled", updated, etag: "old-etag",
  extendedProperties: { shared: { taskId: "task-live" } },
});

test("newer exact Todoist state can recreate a cancelled projection without a persistent tombstone", async () => {
  const repairs = [];
  const reconciler = createReconciler({ currentTask: task("2026-09-03T21:00:00Z"),
    calendarEvent: cancelledEvent("2026-09-03T20:00:00Z"), repairs });
  const result = await reconciler.reconcile("home");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].event_data.id, "task-live");
  assert.equal(result.counts.created, 1);
});

test("equal timestamps preserve a confirmed Calendar deletion", async () => {
  const repairs = [];
  const reconciler = createReconciler({ currentTask: task("2026-09-03T20:00:00Z"),
    calendarEvent: cancelledEvent("2026-09-03T20:00:00Z"), repairs });
  const result = await reconciler.reconcile("home");
  assert.equal(repairs.length, 0);
  assert.equal(result.counts.blocked, 1);
});

test("project deletion comments do not suppress reconciliation of the exact live Todoist task", async () => {
  const repairs = [];
  const liveTask = task("2026-09-03T21:00:00Z");
  const reconciler = createReconciler({ currentTask: liveTask, calendarEvent: undefined,
    projectComments: [tombstoneComment(liveTask.id)], repairs });
  const result = await reconciler.reconcile("home");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].event_data.id, liveTask.id);
  assert.equal(result.counts.created, 1);
});
