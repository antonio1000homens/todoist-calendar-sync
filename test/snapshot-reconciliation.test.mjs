import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { SnapshotReconciler } from "../dist/reconciliation.js";

const HOME = profiles.home.todoistProjectId;
const WORK = profiles.work.todoistProjectId;

function task(overrides = {}) {
  return {
    id: "task-1",
    project_id: HOME,
    content: "Task",
    description: "Description",
    due: { date: "2026-09-10" },
    updated_at: "2026-09-03T20:00:00Z",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    id: "event-1",
    status: "confirmed",
    summary: "Task",
    description: "Description",
    start: { date: "2026-09-10" },
    end: { date: "2026-09-11" },
    extendedProperties: { shared: { taskId: "task-1" } },
    ...overrides,
  };
}

function canonicalTodoist(value) {
  const due = value?.due && (value.due.date || value.due.datetime)
    ? {
        date: value.due.date || null,
        datetime: value.due.datetime || null,
        timezone: value.due.timezone || null,
        isRecurring: Boolean(value.due.is_recurring),
      }
    : null;
  return {
    content: String(value?.content || "").trim(),
    description: String(value?.description || "").trim(),
    due,
  };
}

function canonicalCalendar(value) {
  const point = (part) => part
    ? { date: part.date || null, dateTime: part.dateTime || null, timeZone: part.timeZone || null }
    : null;
  return {
    status: value?.status || "confirmed",
    summary: String(value?.summary || "").trim(),
    description: String(value?.description || "").trim(),
    start: point(value?.start),
  };
}

function baseline(todoistTask, calendarEvent) {
  return {
    todoist: canonicalTodoist(todoistTask),
    calendar: canonicalCalendar(calendarEvent),
    updatedAt: "2026-09-03T19:00:00Z",
  };
}

class FakeState {
  constructor(mapping) {
    this.mapping = mapping;
    this.tombstones = new Map();
    this.audits = [];
    this.operations = [];
  }
  async getMode() { return "aws"; }
  async getMappingByTask(profile, taskId) {
    return this.mapping?.profile === profile && this.mapping?.taskId === taskId ? this.mapping : undefined;
  }
  async putMapping(mapping) {
    this.mapping = mapping;
    this.operations.push(`put-mapping:${mapping.eventId}`);
  }
  async deleteMapping(mapping) {
    if (this.mapping?.eventId === mapping.eventId) this.mapping = undefined;
    this.operations.push(`delete-mapping:${mapping.eventId}`);
  }
  async putCalendarProjectionTombstone(profile, taskId, sourceUpdatedAt, reason) {
    this.tombstones.set(`${profile}:${taskId}`, { sourceUpdatedAt, ...(reason ? { reason } : {}) });
    this.operations.push(`tombstone:${profile}:${taskId}`);
  }
  async getCalendarProjectionTombstone(profile, taskId) {
    return this.tombstones.get(`${profile}:${taskId}`);
  }
  async recordMutation(profile) { this.operations.push(`mutation:${profile}`); }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

class FakeStore {
  constructor(mapping, savedBaseline) {
    this.mappings = mapping ? [mapping] : [];
    this.baselines = new Map(savedBaseline ? [[`home:${mapping.taskId}`, savedBaseline]] : []);
    this.putBaselineCalls = 0;
  }
  async listMappings(profile) { return this.mappings.filter((mapping) => mapping.profile === profile); }
  async getBaseline(profile, taskId) { return this.baselines.get(`${profile}:${taskId}`); }
  async putBaseline(profile, taskId, todoistTask, calendarEvent) {
    this.putBaselineCalls += 1;
    this.baselines.set(`${profile}:${taskId}`, baseline(todoistTask, calendarEvent));
  }
  async deleteBaseline(profile, taskId) { this.baselines.delete(`${profile}:${taskId}`); }
}

function fakeClients({ listedTasks, taskById, calendarEvents, upsertTaskError }) {
  const todoistUpdates = [];
  const calendarUpdates = [];
  const calendarDeletes = [];
  const todoistDeletes = [];
  const comments = [];

  return {
    metrics: { todoistUpdates, calendarUpdates, calendarDeletes, todoistDeletes, comments },
    factory: async () => ({
      todoist: {
        async listTasks() { return listedTasks; },
        async getTask(taskId) {
          const value = taskById.get(taskId);
          if (value) return value;
          const error = new Error("not found");
          error.status = 404;
          throw error;
        },
        async upsertTask(next, existingId) {
          if (upsertTaskError) throw upsertTaskError;
          todoistUpdates.push({ next, existingId });
          const previous = taskById.get(existingId) || { id: existingId, project_id: HOME };
          const updated = { ...previous, ...next, id: existingId, project_id: previous.project_id || HOME };
          taskById.set(existingId, updated);
          return updated;
        },
        async deleteTask(taskId) { todoistDeletes.push(taskId); taskById.delete(taskId); },
        async findComment() { return undefined; },
        async upsertComment(taskId, content, existingId) {
          comments.push({ taskId, content, existingId });
          return { id: existingId || "comment-1" };
        },
        async deleteComment() {},
      },
      calendar: {
        async getEvent(eventId) {
          const value = calendarEvents.get(eventId);
          if (value) return value;
          const error = new Error("not found");
          error.status = 404;
          throw error;
        },
        async findByTodoistTaskId(taskId) {
          return [...calendarEvents.values()].find((value) => value.extendedProperties?.shared?.taskId === taskId);
        },
        async upsertEvent(next, existingId) {
          const id = existingId || `created-${calendarUpdates.length + 1}`;
          const stored = { ...next, id, status: "confirmed", htmlLink: `https://calendar/${id}` };
          calendarUpdates.push({ next, existingId, stored });
          calendarEvents.set(id, stored);
          return stored;
        },
        async deleteEvent(eventId) { calendarDeletes.push(eventId); calendarEvents.delete(eventId); },
      },
    }),
  };
}

function mapping() {
  return {
    profile: "home",
    projectId: HOME,
    eventId: "event-1",
    taskId: "task-1",
    commentId: "comment-1",
    updatedAt: "2026-09-03T19:00:00Z",
  };
}

function makeReconciler({ state, store, clients, repairs = [] }) {
  return new SnapshotReconciler(
    state,
    clients.factory,
    store,
    async (delivery) => { repairs.push(JSON.parse(delivery.body)); },
    async () => {},
  );
}

test("establishes a baseline only when existing Todoist and Calendar state already agree", async () => {
  const m = mapping();
  const t = task();
  const e = event();
  const state = new FakeState(m);
  const store = new FakeStore(m);
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.deepEqual(store.baselines.get(`home:${t.id}`).todoist, canonicalTodoist(t));
  assert.deepEqual(store.baselines.get(`home:${t.id}`).calendar, canonicalCalendar(e));
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
});

test("repairs a missed Todoist due removal when Calendar is unchanged", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const undated = task({ due: null, updated_at: "2026-09-03T21:00:00Z" });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [undated], taskById: new Map([[undated.id, undated]]), calendarEvents: new Map([[oldEvent.id, oldEvent]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.deepEqual(clients.metrics.calendarDeletes, [oldEvent.id]);
  assert.equal(state.mapping, undefined);
  assert.ok(state.tombstones.has(`home:${undated.id}`));
});

test("ignores Calendar end-only drift because end is not a synchronized canonical field", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const endDrift = event({ end: { date: "2026-09-15" } });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [oldTask], taskById: new Map([[oldTask.id, oldTask]]), calendarEvents: new Map([[endDrift.id, endDrift]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(clients.metrics.calendarDeletes.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_conflict_both_sides_changed"), false);
});

test("blocks non-confirmed mapped Calendar state instead of baselining or mutating it", async () => {
  const m = mapping();
  const t = task();
  const tentative = event({ status: "tentative" });
  const state = new FakeState(m);
  const store = new FakeStore(m);
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[tentative.id, tentative]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(store.baselines.has(`home:${t.id}`), false);
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(clients.metrics.calendarDeletes.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_calendar_status_blocked" && audit.detail.calendarStatus === "tentative"), true);
});

test("blocks non-confirmed unmapped Calendar projections instead of repairing them", async () => {
  const t = task();
  const tentative = event({ status: "tentative" });
  const state = new FakeState();
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[tentative.id, tentative]]) });
  const repairs = [];
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 0);
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_calendar_status_blocked" && audit.detail.calendarStatus === "tentative"), true);
});

test("repairs a missed Calendar date change by updating Todoist", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const movedEvent = event({ start: { date: "2026-09-12" }, end: { date: "2026-09-13" } });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [oldTask], taskById: new Map([[oldTask.id, oldTask]]), calendarEvents: new Map([[movedEvent.id, movedEvent]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.todoistUpdates.length, 1);
  assert.equal(clients.metrics.todoistUpdates[0].next.due.date, "2026-09-12");
  assert.equal(clients.metrics.calendarUpdates.length, 0);
});

test("treats a Todoist deletion during Calendar repair as a conflict, not a failed delivery", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const movedEvent = event({ start: { date: "2026-09-12" }, end: { date: "2026-09-13" } });
  const notFound = new Error("Task not found");
  notFound.status = 404;
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({
    listedTasks: [oldTask],
    taskById: new Map([[oldTask.id, oldTask]]),
    calendarEvents: new Map([[movedEvent.id, movedEvent]]),
    upsertTaskError: notFound,
  });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(state.mapping?.taskId, m.taskId);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_task_disappeared_during_repair"), true);
});

test("does not guess when Todoist and Calendar both changed differently", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const undated = task({ due: null, description: "Todoist edit" });
  const movedEvent = event({ start: { date: "2026-09-12" }, end: { date: "2026-09-13" }, description: "Calendar edit" });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [undated], taskById: new Map([[undated.id, undated]]), calendarEvents: new Map([[movedEvent.id, movedEvent]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(clients.metrics.calendarDeletes.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_conflict_both_sides_changed"), true);
});

test("accepts both-sides-changed when the two providers have already converged", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const newTask = task({ due: { date: "2026-09-12" }, description: "Same edit" });
  const newEvent = event({ start: { date: "2026-09-12" }, end: { date: "2026-09-13" }, description: "Same edit" });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [newTask], taskById: new Map([[newTask.id, newTask]]), calendarEvents: new Map([[newEvent.id, newEvent]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.deepEqual(store.baselines.get(`home:${newTask.id}`).todoist, canonicalTodoist(newTask));
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_converged"), true);
  const convergence = state.audits.find((audit) => audit.action === "todoist_snapshot_reconcile_converged");
  assert.deepEqual(convergence.detail.todoistChangedFields, ["description", "due.date"]);
  assert.deepEqual(convergence.detail.calendarChangedFields, ["description", "start.date"]);
  assert.equal(convergence.detail.providerStatesAgree, true);
});

test("treats equivalent canonical states with different object key order as a no-op", async () => {
  const m = mapping();
  const t = task();
  const e = event();
  const saved = {
    todoist: {
      due: { isRecurring: false, datetime: null, timezone: null, date: "2026-09-10" },
      content: "Task",
      description: "Description",
    },
    calendar: {
      summary: "Task",
      start: { dateTime: null, timeZone: null, date: "2026-09-10" },
      status: "confirmed",
      description: "Description",
    },
    updatedAt: "2026-09-03T19:00:00Z",
  };
  const state = new FakeState(m);
  const store = new FakeStore(m, saved);
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(store.putBaselineCalls, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_converged"), false);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_baseline_established"), false);
});

test("uses authoritative project membership to repair a missed mapped-project move", async () => {
  const m = mapping();
  const moved = task({ project_id: WORK });
  const oldEvent = event();
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(task(), oldEvent));
  const clients = fakeClients({ listedTasks: [], taskById: new Map([[moved.id, moved]]), calendarEvents: new Map([[oldEvent.id, oldEvent]]) });
  const repairs = [];
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].event_data.project_id, WORK);
  assert.equal(repairs[0].event_data_extra.old_item.project_id, HOME);
  assert.equal(store.baselines.has(`home:${moved.id}`), false);
});

test("keeps a cancelled legacy projection blocked until project-exit reset evidence exists", async () => {
  const t = task();
  const cancelled = event({ status: "cancelled" });
  const state = new FakeState();
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[cancelled.id, cancelled]]) });
  const repairs = [];
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_cancelled_projection_blocked"), true);

  state.tombstones.set(`home:${t.id}`, { sourceUpdatedAt: t.updated_at, reason: "project_exit" });
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].event_data_extra.old_item.project_id, "reconcile-unmapped");
});
