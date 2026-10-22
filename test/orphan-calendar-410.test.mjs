import assert from "node:assert/strict";
import test from "node:test";
import { Synchronizer } from "../dist/sync.js";

const delivery = {
  id: "original:orphan:calendar-event:todoist-task",
  kind: "orphan",
  profile: "home",
  mode: "aws",
  receivedAt: "2026-10-22T18:00:00Z",
  headers: {},
  body: "",
  orphan: { eventId: "calendar-event", taskId: "todoist-task", attempt: 2 },
};

function providerError(status, body) {
  return Object.assign(new Error(`Provider request failed: ${status}`), { status, ...(body === undefined ? {} : { body }) });
}

function fixture({ deleteError, readError, readEvent, taskExists = false, mappedTaskId = "todoist-task", completed = false } = {}) {
  const calls = { delete: [], read: [], task: [] };
  const mapping = { profile: "home", taskId: mappedTaskId, eventId: "calendar-event", updatedAt: "2026-10-21T12:00:00Z" };
  const state = {
    mapping,
    audits: [],
    async getCompletedCalendarProjectionByEvent() {
      return completed ? { profile: "home", eventId: "calendar-event", taskId: "todoist-task", completedAt: "2026-10-21T12:00:00Z" } : undefined;
    },
    async getMappingByEvent(profile, id) {
      return this.mapping?.profile === profile && this.mapping?.eventId === id ? this.mapping : undefined;
    },
    async deleteMapping(expected) {
      assert.strictEqual(this.mapping, expected);
      this.mapping = undefined;
    },
    async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); },
  };
  const calendar = {
    async deleteEvent(id) {
      calls.delete.push(id);
      if (deleteError) throw deleteError;
    },
    async getEvent(id) {
      calls.read.push(id);
      if (readError) throw readError;
      return readEvent || { id, status: "confirmed" };
    },
  };
  const todoist = {
    async getTask(id) {
      calls.task.push(id);
      if (!taskExists) throw providerError(404);
      return { id, content: "Still present" };
    },
  };
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist }));
  return { state, calls, sync };
}

test("an orphan DELETE 410 with no deletion reason is retired after the exact Calendar GET returns 404", async () => {
  const f = fixture({ deleteError: providerError(410), readError: providerError(404) });
  await f.sync.process(delivery);
  assert.deepEqual(f.calls.delete, ["calendar-event"]);
  assert.deepEqual(f.calls.read, ["calendar-event"]);
  assert.equal(f.state.mapping, undefined);
  assert.equal(f.state.audits.at(-1).action, "orphan_confirmed_deleted");
  assert.equal(f.state.audits.at(-1).detail.alreadyDeleted, true);
});

test("an orphan DELETE 410 is terminal after the exact event GET also returns a bare 410", async () => {
  const f = fixture({ deleteError: providerError(410), readError: providerError(410) });
  await f.sync.process(delivery);
  assert.equal(f.state.mapping, undefined);
  assert.deepEqual(f.calls.read, ["calendar-event"]);
});

test("Google's structured deleted 410 needs no second read", async () => {
  const f = fixture({
    deleteError: providerError(410, JSON.stringify({ error: { errors: [{ reason: "deleted" }] } })),
  });
  await f.sync.process(delivery);
  assert.equal(f.state.mapping, undefined);
  assert.deepEqual(f.calls.read, []);
});

test("a cancelled event is a terminal orphan; a live event after 410 is not", async () => {
  const cancelled = fixture({ deleteError: providerError(410), readEvent: { id: "calendar-event", status: "cancelled" } });
  await cancelled.sync.process(delivery);
  assert.equal(cancelled.state.mapping, undefined);

  const live = fixture({ deleteError: providerError(410), readEvent: { id: "calendar-event", status: "confirmed" } });
  await assert.rejects(live.sync.process(delivery), { status: 410 });
  assert.ok(live.state.mapping);
  assert.equal(live.state.audits.length, 0);
});

test("a non-deletion Calendar 410 or a failed verification never retires the mapping", async () => {
  for (const readError of [
    providerError(410, JSON.stringify({ error: { errors: [{ reason: "fullSyncRequired" }] } })),
    providerError(503),
    providerError(410, "unknown failure"),
  ]) {
    const f = fixture({ deleteError: providerError(410), readError });
    await assert.rejects(f.sync.process(delivery));
    assert.ok(f.state.mapping);
    assert.equal(f.state.audits.length, 0);
  }
  const failure = fixture({ deleteError: providerError(500) });
  await assert.rejects(failure.sync.process(delivery), { status: 500 });
  assert.deepEqual(failure.calls.read, []);
  assert.ok(failure.state.mapping);
});

test("orphan recheck never touches the Calendar when the task exists or ownership changed", async () => {
  const existing = fixture({ taskExists: true });
  await existing.sync.process(delivery);
  assert.deepEqual(existing.calls.delete, []);
  assert.ok(existing.state.mapping);
  assert.equal(existing.state.audits.at(-1).action, "orphan_recheck_recovered");

  const moved = fixture({ mappedTaskId: "another-task" });
  await moved.sync.process(delivery);
  assert.deepEqual(moved.calls.delete, []);
  assert.ok(moved.state.mapping);
  assert.equal(moved.state.audits.at(-1).action, "orphan_recheck_mapping_changed");

  const historic = fixture({ completed: true });
  await historic.sync.process(delivery);
  assert.deepEqual(historic.calls.task, []);
  assert.deepEqual(historic.calls.delete, []);
  assert.ok(historic.state.mapping);
  assert.equal(historic.state.audits.at(-1).action, "orphan_completed_projection_retained");
});
