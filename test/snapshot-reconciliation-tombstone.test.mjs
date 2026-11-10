import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { serializeDeletionTombstoneComment } from "../dist/mapping-comments.js";
import { SnapshotReconciler } from "../dist/reconciliation.js";

const HOME = profiles.home.todoistProjectId;

class FakeState {
  async syncBlocked() { return false; }
  constructor(tombstone) {
    this.tombstone = tombstone;
    this.audits = [];
  }
  async getCalendarProjectionTombstone() { return this.tombstone; }
  async getMappingByTask() { return undefined; }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

class FakeStore {
  async listMappings() { return this.mappings || []; }
  async getBaseline() { return undefined; }
  async putBaseline(...args) { (this.baselines ||= []).push(args); }
  async deleteBaseline() {}
}

function clients(task, projectComments = []) {
  return async () => ({
    todoist: {
      async listProjectComments() { return projectComments; },
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

test("project-comment erasure tombstone suppresses stale Todoist snapshot before repair or Calendar lookup", async () => {
  const current = task("2026-09-03T21:00:00Z");
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const marker = serializeDeletionTombstoneComment({
    schemaVersion: 1, profile: "home", projectId: HOME, taskId: current.id,
    eventIds: ["cancelled-old-event"], createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 18 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const projectComments = [{ id: "erasure-marker", project_id: HOME, content: marker }];
  const state = new FakeState(undefined);
  const repairs = [];
  let calendarLookups = 0;
  const providerFactory = async () => ({
    todoist: {
      async listProjectComments() { return projectComments; },
      async listTasks() { return [current]; },
      async getTask() { return current; },
    },
    calendar: {
      async findByTodoistTaskId() { calendarLookups += 1; throw new Error("must not inspect Calendar after tombstone match"); },
    },
  });
  const reconciler = new SnapshotReconciler(
    state, providerFactory, new FakeStore(),
    async (delivery) => repairs.push(JSON.parse(delivery.body)),
    async () => {},
  );

  await reconciler.reconcile("home");

  assert.equal(repairs.length, 0);
  assert.equal(calendarLookups, 0);
  const suppressed = state.audits.find((audit) => audit.action === "erasure_project_comment_replay_suppressed");
  assert.deepEqual(suppressed?.detail, { side: "todoist_reconciliation" });
  assert.equal(JSON.stringify(suppressed).includes(current.id), false, "suppression diagnostics must not persist deleted identity");
});

test("project-comment erasure tombstone suppresses a stale mapped snapshot before provider or baseline work", async () => {
  const current = task("2026-09-03T21:00:00Z");
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const marker = serializeDeletionTombstoneComment({
    schemaVersion: 1, profile: "home", projectId: HOME, taskId: current.id,
    eventIds: ["mapped-event"], createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 18 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const projectComments = [{ id: "erasure-marker", project_id: HOME, content: marker }];
  const state = new FakeState(undefined);
  const store = new FakeStore();
  store.mappings = [{ profile: "home", projectId: HOME, taskId: current.id,
    eventId: "mapped-event", updatedAt: "2026-09-03T20:00:00Z" }];
  let calendarLookups = 0;
  const providerFactory = async () => ({
    todoist: {
      async listProjectComments() { return projectComments; },
      async listTasks() { return [current]; },
      async getTask() { return current; },
    },
    calendar: {
      async getEvent() { calendarLookups += 1; throw new Error("must not read mapped Calendar item after tombstone match"); },
    },
  });
  const reconciler = new SnapshotReconciler(state, providerFactory, store, async () => {}, async () => {});

  await reconciler.reconcile("home");

  assert.equal(calendarLookups, 0);
  assert.equal(store.baselines?.length || 0, 0);
  assert.deepEqual(state.audits[0], {
    profile: "home", action: "erasure_project_comment_replay_suppressed",
    detail: { side: "todoist_reconciliation" },
  });
});
