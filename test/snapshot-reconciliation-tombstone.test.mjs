import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { SnapshotReconciler } from "../dist/reconciliation.js";

const HOME = profiles.home.todoistProjectId;

class FakeState {
  constructor(tombstone) {
    this.tombstone = tombstone;
    this.audits = [];
  }
  async getCalendarProjectionTombstone() { return this.tombstone; }
  async getMappingByTask() { return undefined; }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

class FakeStore {
  async listMappings() { return []; }
  async getBaseline() { return undefined; }
  async putBaseline() {}
  async deleteBaseline() {}
}

function clients(task) {
  return async () => ({
    todoist: {
      async listTasks() { return [task]; },
      async getTask() { return task; },
    },
    calendar: {
      async findByTodoistTaskId() {
        return {
          id: "cancelled-old-event",
          status: "cancelled",
          extendedProperties: { shared: { taskId: task.id } },
        };
      },
    },
  });
}

function task(updatedAt) {
  return {
    id: "task-due-readded",
    project_id: HOME,
    content: "Task",
    due: { date: "2026-09-10" },
    updated_at: updatedAt,
  };
}

test("a missed due re-add may cross a generic tombstone only when Todoist is strictly newer", async () => {
  const olderTombstone = { sourceUpdatedAt: "2026-09-03T20:00:00Z" };
  const current = task("2026-09-03T21:00:00Z");
  const repairs = [];
  const reconciler = new SnapshotReconciler(
    new FakeState(olderTombstone),
    clients(current),
    new FakeStore(),
    async (delivery) => repairs.push(JSON.parse(delivery.body)),
    async () => {},
  );
  await reconciler.reconcile("home");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].event_data.id, current.id);
});

test("an equal/stale Todoist timestamp cannot resurrect a generic cancelled tombstone", async () => {
  const tombstone = { sourceUpdatedAt: "2026-09-03T21:00:00Z" };
  const current = task("2026-09-03T21:00:00Z");
  const state = new FakeState(tombstone);
  const repairs = [];
  const reconciler = new SnapshotReconciler(
    state,
    clients(current),
    new FakeStore(),
    async (delivery) => repairs.push(JSON.parse(delivery.body)),
    async () => {},
  );
  await reconciler.reconcile("home");
  assert.equal(repairs.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_cancelled_projection_blocked"), true);
});
