import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { serializeMappingComment } from "../dist/mapping-comments.js";
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
  async syncBlocked() { return false; }
  constructor(mapping) {
    this.mapping = mapping;
    this.tombstones = new Map();
    this.completedProjections = new Map();
    this.eventMappings = new Map();
    this.recurrenceLinks = new Map();
    this.ownerMapping = undefined;
    this.otherProfileMappings = new Map();
    this.audits = [];
    this.operations = [];
  }
  async getMode() { return "aws"; }
  async getMappingByTask(profile, taskId) {
    return this.mapping?.profile === profile && this.mapping?.taskId === taskId ? this.mapping : undefined;
  }
  async getMappingByEvent(profile, eventId) {
    return this.eventMappings.get(`${profile}:${eventId}`);
  }
  async getRecurrenceLink(profile, seriesId) {
    return this.recurrenceLinks.get(`${profile}:${seriesId}`);
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
  async getCompletedCalendarProjectionByEvent(profile, eventId) {
    return this.completedProjections.get(`${profile}:${eventId}`);
  }
  async putCompletedCalendarProjection(projection) {
    this.completedProjections.set(`${projection.profile}:${projection.eventId}`, projection);
    this.operations.push(`completed:${projection.eventId}`);
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

function makeReconciler({ state, store, clients, repairs = [], reconcileRecurrence }) {
  return new SnapshotReconciler(
    state,
    clients.factory,
    store,
    async (delivery) => { repairs.push(JSON.parse(delivery.body)); },
    reconcileRecurrence || (async () => {}),
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

test("a missing baseline repairs an exact live pair using Calendar's documented tie-break", async () => {
  const m = mapping();
  const t = task({ content: "Older Todoist title" });
  const e = event({ summary: "Current Calendar title" });
  const state = new FakeState(m);
  const store = new FakeStore(m);
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");

  assert.equal(result.counts.calendar_to_todoist, 1);
  assert.equal(clients.metrics.todoistUpdates.length, 1);
  assert.equal(clients.metrics.todoistUpdates[0].next.content, e.summary);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(store.baselines.has(`home:${t.id}`), true);
  assert.equal(state.audits.some(audit => audit.action === "todoist_snapshot_reconcile_baseline_missing_repaired_from_live_pair"), true);
});

test("a missing baseline retains an exact Calendar projection when Todoist reports completion", async () => {
  const m = mapping();
  const completed = task({ is_completed: true, completed_at: "2026-09-03T21:00:00Z" });
  const e = event();
  const state = new FakeState(m);
  const clients = fakeClients({ listedTasks: [completed], taskById: new Map([[completed.id, completed]]), calendarEvents: new Map([[e.id, e]]) });

  const result = await makeReconciler({ state, store: new FakeStore(m), clients }).reconcile("home");

  assert.equal(result.counts.completed_retained, 1);
  assert.equal(state.completedProjections.get(`home:${e.id}`).completedAt, completed.completed_at);
  assert.deepEqual(clients.metrics.calendarDeletes, []);
  assert.deepEqual(clients.metrics.todoistDeletes, []);
  assert.equal(state.mapping.eventId, e.id);
});

test("exact Todoist 404 prevents an unmapped stale list snapshot from creating a Calendar projection", async () => {
  const stale = task();
  const state = new FakeState(undefined);
  const store = new FakeStore(undefined);
  const clients = fakeClients({
    listedTasks: [stale],
    taskById: new Map(),
    calendarEvents: new Map(),
  });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");

  assert.equal(result.counts.noop, 1);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(state.audits.some(audit => audit.action === "todoist_snapshot_reconcile_inactive_task_ignored"
    && audit.detail.reason === "exact_provider_read_not_found"), true);
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
  assert.equal(state.mapping.eventId, oldEvent.id);
  assert.equal(state.operations.some((operation) => operation.startsWith("tombstone:")), false);
});

test("retained completion wins over a missing Todoist task during snapshot reconciliation", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const state = new FakeState(m);
  state.completedProjections.set(`home:${m.eventId}`, {
    profile: "home", taskId: m.taskId, eventId: m.eventId, completedAt: "2026-09-03T21:00:00Z",
  });
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [], taskById: new Map(), calendarEvents: new Map([[oldEvent.id, oldEvent]]) });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");

  assert.equal(result.counts.completed_retained, 1);
  assert.equal(state.mapping?.eventId, m.eventId, "completed mapping is retained for seven days");
  assert.equal(store.baselines.has(`home:${m.taskId}`), true);
  assert.deepEqual(clients.metrics.calendarDeletes, []);
  assert.deepEqual(clients.metrics.todoistDeletes, []);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_completed_projection_retained"), true);
});

test("rechecks completion before destructive snapshot reconciliation", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const marker = {
    profile: "home",
    taskId: m.taskId,
    eventId: m.eventId,
    completedAt: "2026-09-03T21:00:00Z",
  };
  const state = new FakeState(m);
  let completedReads = 0;
  state.getCompletedCalendarProjectionByEvent = async () => {
    completedReads += 1;
    return completedReads === 1 ? undefined : marker;
  };
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [], taskById: new Map(), calendarEvents: new Map([[oldEvent.id, oldEvent]]) });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");

  assert.equal(completedReads >= 2, true);
  assert.equal(result.counts.completed_retained, 1);
  assert.deepEqual(clients.metrics.calendarDeletes, []);
  assert.deepEqual(clients.metrics.todoistDeletes, []);
  assert.equal(state.mapping?.eventId, m.eventId, "completion cannot prematurely delete the mapping");
  assert.equal(store.baselines.has(`home:${m.taskId}`), true);
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

test("existing linked multi-day pair ignores end-only Calendar edits without changing names or providers", async () => {
  const m = mapping();
  const t = task({ id: "task-1", content: "Leave Approved", description: "", due: { date: "2026-12-21" } });
  const original = event({
    summary: "Leave Approved", description: "", start: { date: "2026-12-21" }, end: { date: "2026-12-26" },
  });
  const edited = { ...original, end: { date: "2026-12-30" } };
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(t, original));
  const eventMap = new Map([[edited.id, edited]]);
  const taskMap = new Map([[t.id, t]]);
  const clients = fakeClients({ listedTasks: [t], taskById: taskMap, calendarEvents: eventMap });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.noop, 1);
  assert.equal(store.putBaselineCalls, 0);
  assert.deepEqual(clients.metrics.todoistUpdates, []);
  assert.deepEqual(clients.metrics.calendarUpdates, []);
  assert.deepEqual(clients.metrics.todoistDeletes, []);
  assert.deepEqual(clients.metrics.calendarDeletes, []);
  assert.strictEqual(eventMap.get(original.id), edited);
  assert.strictEqual(taskMap.get(t.id), t);
  assert.equal(t.content, "Leave Approved");
  assert.equal(edited.end.date, "2026-12-30");
  assert.equal(state.audits.some((entry) => entry.action === "todoist_snapshot_reconcile_conflict_both_sides_changed"), false);
});

test("Todoist date change alongside Calendar end-only edit keeps the edited multi-day duration", async () => {
  const m = mapping();
  const oldTask = task({ content: "Leave Approved", description: "", due: { date: "2026-12-21" } });
  const oldEvent = event({
    summary: "Leave Approved", description: "", start: { date: "2026-12-21" }, end: { date: "2026-12-26" },
  });
  const movedTask = task({ content: "Leave Approved", description: "", due: { date: "2026-12-22" } });
  const extendedEvent = { ...oldEvent, end: { date: "2026-12-30" } };
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({
    listedTasks: [movedTask], taskById: new Map([[movedTask.id, movedTask]]),
    calendarEvents: new Map([[extendedEvent.id, extendedEvent]]),
  });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.todoist_to_calendar, 1);
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 1);
  assert.deepEqual(clients.metrics.calendarUpdates[0].next.start, { date: "2026-12-22" });
  assert.deepEqual(clients.metrics.calendarUpdates[0].next.end, { date: "2026-12-31" });
  assert.equal(clients.metrics.calendarUpdates[0].next.summary, "Leave Approved");
  assert.equal(state.audits.some((entry) => entry.action === "todoist_snapshot_reconcile_conflict_both_sides_changed"), false);
});

test("Calendar multi-day start edits move the Todoist due date without truncating the Calendar event", async () => {
  const m = mapping();
  const t = task({ content: "Leave Approved", description: "", due: { date: "2026-12-21" } });
  const original = event({ summary: "Leave Approved", description: "", start: { date: "2026-12-21" }, end: { date: "2026-12-26" } });
  const shifted = { ...original, start: { date: "2026-12-23" } };
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(t, original));
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[shifted.id, shifted]]) });

  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.calendar_to_todoist, 1);
  assert.deepEqual(clients.metrics.todoistUpdates[0].next.due, { date: "2026-12-23" });
  assert.equal(clients.metrics.todoistUpdates[0].next.content, "Leave Approved");
  assert.deepEqual(clients.metrics.calendarUpdates, []);
  assert.deepEqual(shifted.end, { date: "2026-12-26" });
});

test("timed Calendar end-only edits are ignored while start changes update Todoist", async () => {
  const m = mapping();
  const t = task({ due: { datetime: "2026-09-10T08:00:00Z", timezone: "Europe/London" } });
  const original = event({
    start: { dateTime: "2026-09-10T09:00:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-09-10T10:00:00+01:00", timeZone: "Europe/London" },
  });
  const endEdited = { ...original, end: { dateTime: "2026-09-10T13:00:00+01:00", timeZone: "Europe/London" } };
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(t, original));
  const calendarEvents = new Map([[endEdited.id, endEdited]]);
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents });
  const reconciler = makeReconciler({ state, store, clients });

  const first = await reconciler.reconcile("home");
  assert.equal(first.counts.noop, 1);
  assert.deepEqual(clients.metrics.todoistUpdates, []);
  assert.deepEqual(clients.metrics.calendarUpdates, []);

  calendarEvents.set(original.id, { ...endEdited, start: { dateTime: "2026-09-10T11:00:00+01:00", timeZone: "Europe/London" } });
  const second = await reconciler.reconcile("home");
  assert.equal(second.counts.calendar_to_todoist, 1);
  assert.deepEqual(clients.metrics.todoistUpdates[0].next.due, {
    datetime: "2026-09-10T11:00:00+01:00", timezone: "Europe/London",
  });
  assert.deepEqual(clients.metrics.calendarUpdates, []);
  assert.deepEqual(calendarEvents.get(original.id).end, endEdited.end);
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

test("retries a provider 404 when an exact Todoist reread still finds the task", async () => {
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
  await assert.rejects(
    makeReconciler({ state, store, clients }).reconcile("home"),
    /Reconciliation mapped failed for task task-1, event event-1: HTTP 404/,
  );
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.equal(state.mapping?.taskId, m.taskId);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_item_failed"), true);
});

test("merges simultaneous edits and uses Calendar for same-field ties", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const undated = task({ due: null, content: "Todoist title edit", description: "Todoist edit" });
  const movedEvent = event({ start: { date: "2026-09-12" }, end: { date: "2026-09-13" }, description: "Calendar edit" });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [undated], taskById: new Map([[undated.id, undated]]), calendarEvents: new Map([[movedEvent.id, movedEvent]]) });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.todoistUpdates.length, 1);
  assert.equal(clients.metrics.todoistUpdates[0].next.content, "Todoist title edit");
  assert.equal(clients.metrics.todoistUpdates[0].next.description, "Calendar edit");
  assert.equal(clients.metrics.todoistUpdates[0].next.due.date, "2026-09-12");
  assert.equal(clients.metrics.calendarUpdates.length, 1);
  assert.equal(clients.metrics.calendarUpdates[0].next.summary, "Todoist title edit");
  assert.equal(clients.metrics.calendarDeletes.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_simultaneous_edits_merged"), true);
});

test("simultaneous same-field edits use Todoist when its valid provider timestamp is later", async () => {
  const m = mapping();
  const oldTask = task();
  const oldEvent = event();
  const editedTask = task({
    content: "Todoist title",
    description: "Todoist description",
    due: { date: "2026-09-12" },
    updated_at: "2026-09-03T22:00:00Z",
  });
  const editedEvent = event({
    summary: "Calendar title",
    description: "Calendar description",
    start: { date: "2026-09-13" },
    end: { date: "2026-09-14" },
    updated: "2026-09-03T21:00:00Z",
  });
  const state = new FakeState(m);
  const store = new FakeStore(m, baseline(oldTask, oldEvent));
  const clients = fakeClients({ listedTasks: [editedTask], taskById: new Map([[editedTask.id, editedTask]]),
    calendarEvents: new Map([[editedEvent.id, editedEvent]]) });

  await makeReconciler({ state, store, clients }).reconcile("home");

  assert.equal(clients.metrics.todoistUpdates.length, 0, "Todoist already contains the winning values");
  assert.equal(clients.metrics.calendarUpdates.length, 1);
  assert.equal(clients.metrics.calendarUpdates[0].next.summary, "Todoist title");
  assert.equal(clients.metrics.calendarUpdates[0].next.description, "Todoist description");
  assert.equal(clients.metrics.calendarUpdates[0].next.start.date, "2026-09-12");
  const mergeAudit = state.audits.find((audit) => audit.action === "todoist_snapshot_reconcile_simultaneous_edits_merged");
  assert.equal(mergeAudit.detail.sameFieldWinner, "todoist_newer_provider_timestamp");
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

test("keeps a cancelled projection blocked until a newer live Todoist edit proves intentional recreation", async () => {
  const t = task({ updated_at: "2026-09-03T19:00:00Z" });
  const cancelled = event({ status: "cancelled", updated: "2026-09-03T20:00:00Z" });
  const state = new FakeState();
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[cancelled.id, cancelled]]) });
  const repairs = [];
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 0);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_snapshot_reconcile_cancelled_projection_blocked"), true);

  t.updated_at = "2026-09-03T21:00:00Z";
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].event_data_extra.old_item.project_id, "reconcile-unmapped");
});

test("unmapped canonical task recovers its provider correlation without relying on a DynamoDB EVENT index", async () => {
  const t = task();
  const e = event();
  const oldMapping = mapping();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", oldMapping);
  const store = new FakeStore();
  const clients = fakeClients({
    listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]),
  });
  const repairs = [];
  const result = await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined, "exact Calendar correlation must not restore a DynamoDB mapping");
  assert.ok(store.baselines.get(`home:${t.id}`));
  assert.equal(repairs.length, 0);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(clients.metrics.todoistUpdates.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "todoist_snapshot_reconcile_provider_correlation_recovered"));
  // A later run sees a mapped task and does not create another projection.
  store.mappings.push(mapping());
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(repairs.length, 0);
});

test("unmapped recovery will not steal a Calendar event owned by another Todoist task", async () => {
  const t = task();
  const e = event();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", { ...mapping(), taskId: "other-task" });
  const store = new FakeStore();
  const clients = fakeClients({
    listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]),
  });
  const repairs = [];
  await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(state.mapping, undefined);
  assert.equal(repairs.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "todoist_snapshot_reconcile_mapping_owner_conflict"));
});

test("snapshot reconciliation adopts an untagged recurring master through its current instance", async () => {
  const due = "2099-06-10";
  const recurringTask = task({ content: "Daily task", description: "details",
    due: { date: due, string: "every day", is_recurring: true } });
  const master = { id: "untagged-master", status: "confirmed", summary: "Daily task", description: "details",
    start: { date: "2020-01-01" }, recurrence: ["RRULE:FREQ=DAILY;INTERVAL=1"] };
  const active = { id: "active-instance", status: "confirmed", recurringEventId: master.id,
    summary: "Daily task", description: "details", originalStartTime: { date: due }, start: { date: due } };
  const state = new FakeState();
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [recurringTask], taskById: new Map([[recurringTask.id, recurringTask]]),
    calendarEvents: new Map([[master.id, master], [active.id, active]]) });
  const pair = await clients.factory();
  pair.calendar.listDelta = async () => ({ items: [master] });
  pair.calendar.listInstancesInWindow = async (masterId) => {
    assert.equal(masterId, master.id);
    return [active];
  };
  clients.factory = async () => pair;
  const repairs = [];

  const result = await makeReconciler({ state, store, clients, repairs }).reconcile("home");

  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping.eventId, master.id);
  assert.equal(state.mapping.masterEventId, master.id);
  assert.equal(state.mapping.activeInstanceId, active.id);
  assert.equal(state.mapping.seriesId, recurringTask.id);
  assert.equal(repairs.length, 0);
});

test("snapshot recovery does not adopt an untagged event whose master alias has a comment-only owner", async () => {
  const t = task({ content: "Existing appointment", description: "", due: { date: "2099-01-11" } });
  const e = event({ id: "comment-owned-event", summary: t.content, description: "", start: { date: "2099-01-11" },
    extendedProperties: undefined });
  const state = new FakeState();
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const pair = await clients.factory();
  pair.todoist.listProjectComments = async projectId => projectId === WORK ? [{
    id: "comment-only-owner", project_id: WORK,
    content: serializeMappingComment({ profile: "work", projectId: WORK, eventId: e.id,
      taskId: "different-task", updatedAt: "2098-01-01T00:00:00Z" }, WORK),
  }] : [];
  pair.calendar.listDelta = async () => ({ items: [e] });
  clients.factory = async () => pair;
  const repairs = [];

  const result = await makeReconciler({ state, store, clients, repairs }).reconcile("home");

  assert.equal(result.counts.conflict, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(repairs.length, 0);
  assert.ok(state.audits.some(entry => entry.action === "todoist_snapshot_reconcile_mapping_owner_conflict"));
});

test("exact Calendar task correlation takes precedence over a stale cross-profile DynamoDB owner", async () => {
  const t = task();
  const e = event();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", mapping());
  state.ownerMapping = { ...mapping(), profile: "work", projectId: WORK, eventId: "work-event" };
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const repairs = [];
  const result = await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(state.ownerMapping.profile, "work");
  assert.equal(store.baselines.size, 1);
  assert.equal(repairs.length, 0);
  assert.ok(state.audits.some((x) => x.action === "todoist_snapshot_reconcile_provider_correlation_recovered"));
});

test("exact Calendar task correlation recovers despite a stale cross-profile TASK row", async () => {
  const t = task();
  const e = event();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", mapping());
  state.otherProfileMappings.set("work", { ...mapping(), profile: "work", eventId: "work-event" });
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined);
});

test("provider correlation repairs a known pair without consulting a stale projection tombstone", async () => {
  const t = task();
  const e = event();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", mapping());
  state.tombstones.set(`home:${t.id}`, { sourceUpdatedAt: t.updated_at });
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const repairs = [];
  const result = await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(store.baselines.size, 1);
  assert.equal(repairs.length, 0);
  assert.equal(state.operations.some((x) => x.startsWith("restore-mapping:")), false);
});

test("retained completed Calendar projection is never reactivated by index restoration", async () => {
  const t = task();
  const e = event();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", mapping());
  state.completedProjections.set("home:event-1", {
    profile: "home", taskId: t.id, eventId: e.id, completedAt: "2026-09-04T12:00:00Z",
  });
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const repairs = [];
  const result = await makeReconciler({ state, store, clients, repairs }).reconcile("home");
  assert.equal(result.counts.completed_retained, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(store.baselines.size, 0);
  assert.equal(repairs.length, 0);
  assert.equal(state.audits.some((x) => x.action === "todoist_snapshot_completed_projection_retained"), true);
});

test("completed Calendar projection with a competing task ID blocks relinking", async () => {
  const t = task();
  const e = event();
  const state = new FakeState();
  state.eventMappings.set("home:event-1", mapping());
  state.completedProjections.set("home:event-1", {
    profile: "home", taskId: "other-task", eventId: e.id, completedAt: "2026-09-04T12:00:00Z",
  });
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.conflict, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(state.audits.some((x) => x.action === "todoist_snapshot_reconcile_completed_owner_conflict"), true);
});

test("recurring EVENT correlation recovers without requiring a DynamoDB recurrence link", async () => {
  const t = task();
  const e = event();
  const m = { ...mapping(), recurrenceOwner: "calendar", seriesId: "series-1", masterEventId: "master-1", activeInstanceId: "event-1" };
  const state = new FakeState();
  state.eventMappings.set("home:event-1", m);
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(store.baselines.size, 1);
});

test("recurring EVENT correlation remains provider-native even when a legacy link exists", async () => {
  const t = task();
  const e = event();
  const m = { ...mapping(), recurrenceOwner: "calendar", seriesId: "series-1", masterEventId: "master-1", activeInstanceId: "event-1" };
  const link = {
    profile: "home", owner: "calendar", seriesId: m.seriesId, masterEventId: m.masterEventId,
    activeInstanceId: m.activeInstanceId, eventId: m.eventId, taskId: t.id, updatedAt: m.updatedAt,
  };
  const state = new FakeState();
  state.eventMappings.set("home:event-1", m);
  state.recurrenceLinks.set("home:series-1", link);
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(store.baselines.size, 1);
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(clients.metrics.todoistUpdates.length, 0);
});

test("Calendar shared correlation supersedes a divergent legacy recurrence watermark", async () => {
  const t = task();
  const e = event();
  const m = {
    ...mapping(), recurrenceOwner: "calendar", seriesId: "series-1",
    masterEventId: "master-1", activeInstanceId: "event-1",
    calendarProgressVersion: 1, completedThroughOriginalStart: "2026-09-01",
  };
  const link = {
    profile: "home", owner: "calendar", seriesId: m.seriesId, masterEventId: m.masterEventId,
    activeInstanceId: m.activeInstanceId, eventId: m.eventId, taskId: t.id, updatedAt: m.updatedAt,
    calendarProgressVersion: 1, completedThroughOriginalStart: "2026-08-01",
  };
  const state = new FakeState();
  state.eventMappings.set("home:event-1", m);
  state.recurrenceLinks.set("home:series-1", link);
  const store = new FakeStore();
  const clients = fakeClients({ listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map([[e.id, e]]) });
  const result = await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(result.counts.baseline, 1);
  assert.equal(state.mapping, undefined);
  assert.equal(store.baselines.size, 1);
});

test("pending legacy future-only split does not block provider-state reconciliation", async () => {
  const t = task({ id: "split-task", due: { date: "2027-07-01", string: "every 2 years", is_recurring: true } });
  const state = new FakeState();
  state.getFutureSeriesSplitAnyProfile = async () => { throw new Error("legacy split fence must not be read"); };
  const store = new FakeStore();
  const clients = fakeClients({
    listedTasks: [t], taskById: new Map([[t.id, t]]), calendarEvents: new Map(),
  });
  await makeReconciler({ state, store, clients }).reconcile("home");
  assert.equal(clients.metrics.calendarUpdates.length, 0);
  assert.equal(store.putBaselineCalls, 0);
  assert.ok(!state.audits.some((x) => x.action === "todoist_snapshot_future_series_split_pending"));
});

test("Todoist-native deleted recurrence is recognized without a permanent owner marker", async () => {
  for (const calendarStatus of ["cancelled", "missing"]) {
    const m={...mapping(),seriesId:"task-1",
      masterEventId:"event-1",activeInstanceId:"instance-1"};
    const link={profile:"home",owner:"todoist",seriesId:m.seriesId,taskId:m.taskId,
      eventId:m.eventId,masterEventId:m.masterEventId,activeInstanceId:m.activeInstanceId,
      updatedAt:m.updatedAt};
    const state=new FakeState(m);
    state.recurrenceLinks.set("home:task-1",link);
    const store=new FakeStore(m,baseline(task(),event()));
    const events=new Map(calendarStatus==="cancelled"
      ? [["event-1",event({status:"cancelled"})],["instance-1",event({id:"instance-1",status:"cancelled",recurringEventId:"event-1"})]]
      : []);
    const clients=fakeClients({listedTasks:[],taskById:new Map(),calendarEvents:events});
    let retired=0;
    state.retireDeletedTodoistRecurrenceIfUnchanged=async(current,expected)=>{
      assert.deepEqual(current,m); assert.deepEqual(expected,link);
      retired++;
      state.mapping=undefined;
      state.recurrenceLinks.delete("home:task-1");
      return true;
    };
    const result=await makeReconciler({state,store,clients}).reconcile("home");
    assert.equal(result.counts.deleted_retired,1,calendarStatus);
    assert.equal(retired,0,calendarStatus);
    assert.equal(store.baselines.size,0);
    assert.deepEqual(clients.metrics.todoistUpdates,[]);
    assert.deepEqual(clients.metrics.calendarUpdates,[]);
    assert.deepEqual(clients.metrics.calendarDeletes,[]);
    assert.ok(state.audits.some(a=>a.action==="todoist_snapshot_reconcile_verified_deletion_retired"));
  }
});

test("Todoist recurrence retirement follows exact provider reads without a legacy link dependency", async () => {
  for (const scenario of ["task-live","calendar-live","link-changed","repair-blocked"]) {
    const m={...mapping(),recurrenceOwner:"todoist",seriesId:"task-1",masterEventId:"event-1"};
    const state=new FakeState(m);
    state.recurrenceLinks.set("home:task-1",{profile:"home",owner:"todoist",seriesId:"task-1",
      taskId:scenario==="link-changed"?"different-task":"task-1",eventId:"event-1",
      masterEventId:"event-1",updatedAt:m.updatedAt});
    if (scenario==="repair-blocked") state.syncBlocked=async()=>true;
    const t=task();
    const tasks=scenario==="task-live"?[t]:[];
    const events=new Map([["event-1",event({status:scenario==="calendar-live"?"confirmed":"cancelled"})]]);
    const clients=fakeClients({listedTasks:tasks,taskById:new Map(tasks.map(x=>[x.id,x])),calendarEvents:events});
    let retired=0;
    state.retireDeletedTodoistRecurrenceIfUnchanged=async()=>{retired++;return true;};
    const result=await makeReconciler({state,store:new FakeStore(m),clients}).reconcile("home");
    const providerPairAbsent = scenario === "link-changed";
    assert.equal(retired,0,scenario);
    assert.equal(result.counts.deleted_retired,providerPairAbsent ? 1 : 0,scenario);
    assert.deepEqual(clients.metrics.todoistUpdates,[]);
    assert.deepEqual(clients.metrics.calendarUpdates,[]);
  }
});
