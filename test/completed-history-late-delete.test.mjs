import test from "node:test";
import assert from "node:assert/strict";
import { Synchronizer } from "../dist/sync.js";

const history = {
  profile: "home", taskId: "completed-task", eventId: "historical-event",
  completedAt: "2026-10-01T12:00:00Z",
};
const event = {
  id: history.eventId, status: "confirmed",
  start: { date: "2026-10-01" }, end: { date: "2026-10-02" },
  extendedProperties: { shared: { taskId: history.taskId } },
};
const task = { id: history.taskId, content: "Completed", is_deleted: true, project_id: "home-test" };

async function runLateDelete(withTaskIndex, receivedAt) {
  let deleted = 0;
  let removedHistory = 0;
  let audits = [];
  const state = {
    async syncBlocked() { return false; },
    async getMappingByTaskAnyProfile() { return undefined; },
    async getMappingByTask() { return undefined; },
    async getMappingByEvent() { return undefined; },
    async getCompletedCalendarProjectionByEvent(_profile, eventId) { return eventId === history.eventId ? history : undefined; },
    async listCompletedCalendarProjectionsByTask() { return withTaskIndex ? [history] : []; },
    async deleteCompletedCalendarProjection() { removedHistory++; },
    async mutationAllowed() { return true; },
    async recordMutation() {},
    async audit(_profile, action, detail) { audits.push({ action, detail }); },
  };
  const calendar = {
    async findByTodoistTaskId() { return event; },
    async deleteEvent() { deleted++; },
  };
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist: {} }));
  await sync.process({
    id: "delete-late", kind: "todoist", profile: "home", mode: "aws",
    receivedAt, headers: {}, body: JSON.stringify({ event_name: "item:deleted", event_data: task }),
  });
  return { deleted, removedHistory, actions: audits.map((a) => a.action) };
}

test("delayed Todoist auto-deletion preserves one-off Calendar history before seven-day maintenance", async () => {
  const result = await runLateDelete(true, "2026-10-08T12:00:00Z");
  assert.equal(result.deleted, 0);
  assert.equal(result.removedHistory, 0);
  assert.ok(result.actions.includes("todoist_late_completed_deletion_ignored"));
});

test("deletion after task-side index retirement still respects event-side historical guard", async () => {
  const result = await runLateDelete(false, "2026-10-09T12:00:00Z");
  assert.equal(result.deleted, 0);
  assert.equal(result.removedHistory, 0);
});

test("explicit deletion within the grace retains its existing documented behaviour", async () => {
  const result = await runLateDelete(true, "2026-10-08T11:59:59Z");
  assert.equal(result.deleted, 1);
  assert.equal(result.removedHistory, 1);
});

test("an earlier completed recurrence remains protected from delayed deletion if mapping was lost", async () => {
  // Without a live recurrence link no finality can be inferred. Preserve
  // Calendar rather than treating an old instance as an active-task delete.
  const result = await runLateDelete(true, "2026-10-11T12:00:00Z");
  assert.equal(result.deleted, 0);
});
