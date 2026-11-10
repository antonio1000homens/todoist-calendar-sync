import test from "node:test";
import assert from "node:assert/strict";
import { Synchronizer } from "../dist/sync.js";
import {
  atCompletionBoundary, completedProjection,
} from "./helpers/completed-history-fixtures.mjs";

const history = completedProjection({ taskId: "completed-task", eventId: "historical-event" });
const event = {
  id: history.eventId, status: "confirmed",
  start: { date: "2026-10-01" }, end: { date: "2026-10-02" },
  extendedProperties: { shared: { taskId: history.taskId } },
};
const task = { id: history.taskId, content: "Completed", is_deleted: true, project_id: "home-test" };

async function runLateDelete(withTaskIndex, receivedAt, recordedHistory = history) {
  let deleted = 0;
  let removedHistory = 0;
  let audits = [];
  const state = {
    async syncBlocked() { return false; },
    async getMappingByTaskAnyProfile() { return undefined; },
    async getMappingByTask() { return undefined; },
    async getMappingByEvent() { return undefined; },
    async getCompletedCalendarProjectionByEvent(_profile, eventId) { return eventId === recordedHistory.eventId ? recordedHistory : undefined; },
    async listCompletedCalendarProjectionsByTask() { return withTaskIndex ? [recordedHistory] : []; },
    async deleteCompletedCalendarProjection() { removedHistory++; },
    async mutationAllowed() { return true; },
    async recordMutation() {},
    async audit(_profile, action, detail) { audits.push({ action, detail }); },
  };
  const calendar = {
    async findByTodoistTaskId() { return event; },
    async deleteEvent() { deleted++; },
  };
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist: {
    async listProjectComments() { return []; }, async getTask() { return task; } } }));
  await sync.process({
    id: "delete-late", kind: "todoist", profile: "home", mode: "aws",
    receivedAt, headers: {}, body: JSON.stringify({ event_name: "item:deleted", event_data: task }),
  });
  return { deleted, removedHistory, actions: audits.map((a) => a.action) };
}

// Run the same late-delete contract with and without the task-facing index.
// Keep each scenario separately reported so a regression identifies the gap.
for (const scenario of [
  {
    name: "at the seven-day boundary with the task index present",
    withTaskIndex: true, offsetMs: 0, audit: true,
  },
  {
    name: "after the task-facing index has retired",
    withTaskIndex: false, offsetMs: 24 * 60 * 60_000,
  },
]) {
  test(`completed Calendar history survives late Todoist deletion: ${scenario.name}`, async () => {
    const result = await runLateDelete(
      scenario.withTaskIndex, atCompletionBoundary(scenario.offsetMs),
    );
    assert.equal(result.deleted, 0);
    assert.equal(result.removedHistory, 0);
    if (scenario.audit) {
      assert.ok(result.actions.includes("todoist_late_completed_deletion_ignored"));
    }
  });
}

test("explicit deletion before seven full days retains its existing behaviour", async () => {
  const result = await runLateDelete(true, atCompletionBoundary(-1));
  assert.equal(result.deleted, 1);
  assert.equal(result.removedHistory, 1);
});

test("older completed recurring occurrence stays protected without a live recurrence mapping", async () => {
  // A terminally completed occurrence must not be mistaken for an active-task
  // deletion after the recurring mapping has gone missing.
  const recurringHistory = {
    ...history,
    recurrenceOwner: "calendar",
    seriesId: "yearly-series",
    masterEventId: "yearly-master",
    originalStart: "2026-10-01",
  };
  const result = await runLateDelete(
    true, atCompletionBoundary(3 * 24 * 60 * 60_000), recurringHistory,
  );
  assert.equal(result.deleted, 0);
  assert.equal(result.removedHistory, 0);
});
