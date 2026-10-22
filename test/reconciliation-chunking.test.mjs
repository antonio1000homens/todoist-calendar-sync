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
    async syncBlocked() { return false; },
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

test("mapped recurring occurrence 400 fails closed with the exact item and permits a fresh reconciliation", async () => {
  const eventId = "5rio60tp27c1g98p449p5curbl_20261016T152000Z";
  const mappings = ["task-1", "task-2", "task-3"].map((id) => ({
    profile: "home", projectId: HOME, taskId: id,
    eventId: id === "task-2" ? eventId : `event-${id}`,
  }));
  const tasks = mappings.map((mapping) => task(mapping.taskId));
  const audits = [];
  const inspected = [];
  let rejectOccurrence = true;
  let deletedTasks = 0;
  const state = {
    async syncBlocked() { return false; },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
  const store = {
    async listMappings() { return mappings; },
    async getBaseline(_profile, taskId) {
      const mapping = mappings.find((m) => m.taskId === taskId);
      return baseline(task(taskId), { ...event(taskId), id: mapping.eventId });
    },
  };
  const clients = async () => ({
    todoist: {
      async listTasks() { return tasks; },
      async deleteTask() { deletedTasks++; },
    },
    calendar: {
      async getEvent(id) {
        inspected.push(id);
        if (id === eventId && rejectOccurrence) {
          throw Object.assign(new Error("Provider request failed: 400"), {
            status: 400,
            body: JSON.stringify({ error: { errors: [{ reason: "invalid" }], message: "Private event detail" } }),
          });
        }
        const mapping = mappings.find((m) => m.eventId === id);
        return { ...event(mapping.taskId), id };
      },
      async deleteEvent() { throw new Error("Calendar deletion must not happen"); },
    },
  });
  const reconciler = new SnapshotReconciler(state, clients, store, async () => {}, async () => {});
  const continuation = { phase: "mapped", sequence: 1 };
  await assert.rejects(reconciler.reconcile("home", continuation, 3), (error) => {
    assert.equal(error.name, "ReconciliationItemError");
    assert.equal(error.status, 400);
    assert.match(error.message, /task task-2.*event 5rio60tp27c1g98p449p5curbl_20261016T152000Z.*invalid/);
    return true;
  });
  assert.deepEqual(inspected, ["event-task-1", eventId]);
  assert.equal(deletedTasks, 0);
  const incident = audits.find((entry) => entry.action === "todoist_snapshot_reconcile_item_failed");
  assert.deepEqual(incident.detail, {
    stage: "mapped", taskId: "task-2", eventId, seriesId: undefined,
    providerStatus: 400, providerReason: "invalid",
  });

  // A manually requested fresh pass restarts from current state. There is no
  // blind replay, and the earlier 400 never reclassified the event as deleted.
  rejectOccurrence = false;
  const retry = await reconciler.reconcile("home", continuation, 3);
  assert.equal(retry.processedCandidates, 3);
  assert.equal(retry.counts.noop, 3);
  assert.equal(deletedTasks, 0);
});
