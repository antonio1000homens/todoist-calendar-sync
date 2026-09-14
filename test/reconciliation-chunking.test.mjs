import assert from "node:assert/strict";
import test from "node:test";

import { profiles } from "../dist/config.js";
import { SnapshotReconciler } from "../dist/reconciliation.js";

const HOME = profiles.home.todoistProjectId;

function task(id) {
  return {
    id,
    project_id: HOME,
    content: `Task ${id}`,
    description: "",
    due: { date: "2026-09-10" },
    updated_at: "2026-09-08T09:00:00Z",
  };
}

function event(id) {
  return {
    id: `event-${id}`,
    status: "confirmed",
    summary: `Task ${id}`,
    description: "",
    start: { date: "2026-09-10" },
    end: { date: "2026-09-11" },
    extendedProperties: { shared: { taskId: id } },
  };
}

function baseline(t, e) {
  return {
    todoist: {
      content: t.content,
      description: "",
      due: { date: "2026-09-10", datetime: null, timezone: null, isRecurring: false },
    },
    calendar: {
      status: "confirmed",
      summary: e.summary,
      description: "",
      start: { date: "2026-09-10", dateTime: null, timeZone: null },
    },
    updatedAt: "2026-09-08T08:00:00Z",
  };
}

test("snapshot reconciliation resumes after the last processed task id and does not rerun recurrence work", async () => {
  const ids = ["task-1", "task-2", "task-3", "task-4", "task-5"];
  const tasks = ids.map(task);
  const events = new Map(ids.map((id) => [`event-${id}`, event(id)]));
  const mappings = ids.map((id) => ({
    profile: "home",
    projectId: HOME,
    eventId: `event-${id}`,
    taskId: id,
    updatedAt: "2026-09-08T08:00:00Z",
  }));
  const baselines = new Map(ids.map((id) => [id, baseline(task(id), event(id))]));
  const inspectedEvents = [];
  const audits = [];
  let recurrenceRuns = 0;

  const state = {
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const store = {
    async listMappings() { return [...mappings].reverse(); },
    async getBaseline(_profile, taskId) { return baselines.get(taskId); },
    async putBaseline() {},
    async deleteBaseline() {},
  };
  const clients = async () => ({
    todoist: {
      async listTasks() { return [...tasks].reverse(); },
      async getTask(taskId) { return tasks.find((candidate) => candidate.id === taskId); },
    },
    calendar: {
      async getEvent(eventId) {
        inspectedEvents.push(eventId);
        return events.get(eventId);
      },
    },
  });

  const reconciler = new SnapshotReconciler(
    state,
    clients,
    store,
    async () => {},
    async () => { recurrenceRuns += 1; },
  );

  const first = await reconciler.reconcile("home", undefined, 2);
  assert.deepEqual(first.continuation, { sequence: 1, phase: "mapped", afterTaskId: "task-2" });
  assert.equal(first.processedCandidates, 2);

  const second = await reconciler.reconcile("home", first.continuation, 2);
  assert.deepEqual(second.continuation, { sequence: 2, phase: "mapped", afterTaskId: "task-4" });
  assert.equal(second.processedCandidates, 2);

  const third = await reconciler.reconcile("home", second.continuation, 2);
  assert.equal(third.continuation, undefined);
  assert.equal(third.processedCandidates, 1);

  assert.equal(recurrenceRuns, 1);
  assert.deepEqual(inspectedEvents, ids.map((id) => `event-${id}`));
  assert.equal(audits.filter((entry) => entry.action === "todoist_snapshot_reconcile_chunk_completed").length, 2);
  assert.equal(audits.filter((entry) => entry.action === "todoist_snapshot_reconcile_completed").length, 1);
});
