import assert from "node:assert/strict";
import test from "node:test";
import { Synchronizer, selectCalendarRecurrenceInstance, toCalendarEvent } from "../dist/sync.js";
import { selectNextEffectiveTodoistInstance } from "../dist/todoist-recurrence.js";

const PROFILE = "home";
const MASTER = "calendar-master";
const SERIES = "calendar-series";

function instance(id, start, end, status = "confirmed") {
  return {
    id,
    status,
    summary: "Recurring reminder",
    description: "",
    recurringEventId: MASTER,
    iCalUID: SERIES,
    originalStartTime: { date: start },
    start: { date: start },
    end: { date: end },
  };
}

function todoistInstance(masterId, taskId, id, logicalStart, effectiveStart = logicalStart, status = "confirmed") {
  return {
    id,
    status,
    summary: "Water plants",
    description: "",
    recurringEventId: masterId,
    originalStartTime: { date: logicalStart },
    start: { date: effectiveStart },
    end: { date: addDay(effectiveStart) },
    extendedProperties: {
      shared: {
        taskId,
        syncRecurrenceOwner: "todoist",
      },
    },
  };
}

function addDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function mappingFromLink(link) {
  return {
    profile: link.profile,
    eventId: link.eventId,
    taskId: link.taskId,
    recurrenceOwner: link.owner,
    seriesId: link.seriesId,
    masterEventId: link.masterEventId,
    activeInstanceId: link.activeInstanceId,
    originalStart: link.originalStart,
    activeEffectiveStart: link.activeEffectiveStart,
    updatedAt: link.updatedAt,
  };
}

class FakeState {
  constructor(link) {
    this.operations = [];
    this.audits = [];
    this.tombstones = [];
    this.links = link ? [structuredClone(link)] : [];
    this.mappingsByTask = new Map();
    this.mappingsByEvent = new Map();
    if (link) this.storeMapping(mappingFromLink(link));
  }

  storeMapping(mapping) {
    this.mappingsByTask.set(mapping.taskId, structuredClone(mapping));
    this.mappingsByEvent.set(mapping.eventId, structuredClone(mapping));
  }

  async listRecurrenceLinks(profile) {
    return this.links.filter((link) => link.profile === profile).map((link) => structuredClone(link));
  }

  async getRecurrenceLink(profile, seriesId) {
    return this.links.find((link) => link.profile === profile && link.seriesId === seriesId);
  }

  async putRecurrenceLink(link) {
    this.operations.push(`put-link:${link.taskId}:${link.eventId}`);
    this.links = this.links.filter((item) => !(item.profile === link.profile && item.seriesId === link.seriesId));
    this.links.push(structuredClone(link));
  }

  async deleteRecurrenceLink(profile, seriesId) {
    this.operations.push(`delete-link:${seriesId}`);
    this.links = this.links.filter((link) => !(link.profile === profile && link.seriesId === seriesId));
  }

  async getMappingByTask(_profile, taskId) {
    return this.mappingsByTask.get(taskId);
  }

  async getMappingByEvent(_profile, eventId) {
    return this.mappingsByEvent.get(eventId);
  }

  async putMapping(mapping) {
    this.operations.push(`put-mapping:${mapping.taskId}:${mapping.eventId}`);
    this.storeMapping(mapping);
  }

  async deleteMapping(mapping) {
    this.operations.push(`delete-mapping:${mapping.taskId}:${mapping.eventId}`);
    this.mappingsByTask.delete(mapping.taskId);
    this.mappingsByEvent.delete(mapping.eventId);
  }

  async mutationAllowed() { return true; }
  async recordMutation() { this.operations.push("record-mutation"); }
  async acceptTaskVersion() { return true; }
  async getCalendarProjectionTombstone() { return undefined; }
  async putCalendarProjectionTombstone(profile, taskId, sourceUpdatedAt) {
    this.tombstones.push({ profile, taskId, sourceUpdatedAt });
  }
  async deleteCalendarProjectionTombstone() {}
  async recordRecurrence() {}
  async getSyncToken() { return "sync-token"; }
  async putSyncToken() {}
  async deleteSyncToken() {}

  async audit(_profile, action, detail) {
    this.audits.push({ action, detail });
  }
}

function fakeClients(state, instances, tasks = new Map(), deltaEvent, extraEvents = []) {
  let created = 0;
  const calendarDeletes = [];
  const calendarUpserts = [];
  const todoistDeletes = [];
  const todoistUpserts = [];
  const todoistRecurringUpdates = [];
  const events = new Map();
  for (const event of [...instances, ...extraEvents, ...(deltaEvent ? [deltaEvent] : [])]) {
    events.set(event.id, structuredClone(event));
  }
  const calendar = {
    async listInstances() { return instances.map((event) => structuredClone(event)); },
    async listDelta() {
      return { items: deltaEvent ? [structuredClone(deltaEvent)] : [], nextSyncToken: "sync-next" };
    },
    async deleteEvent(id) {
      calendarDeletes.push(id);
      events.delete(id);
    },
    async upsertEvent(payload, existingId) {
      const id = existingId || payload.id || `calendar-created-${calendarUpserts.length + 1}`;
      const stored = { ...structuredClone(payload), id, status: "confirmed" };
      events.set(id, stored);
      calendarUpserts.push({ id, payload: structuredClone(payload), existingId });
      return structuredClone(stored);
    },
    async findByTodoistTaskId(taskId) {
      return [...events.values()].find((event) => event.extendedProperties?.shared?.taskId === taskId);
    },
    async getEvent(id) {
      const found = events.get(id);
      if (!found) { const error = new Error("not found"); error.status = 404; throw error; }
      return structuredClone(found);
    },
  };
  const todoist = {
    async getTask(id) {
      if (!tasks.has(id)) { const error = new Error("not found"); error.status = 404; throw error; }
      return structuredClone(tasks.get(id));
    },
    async deleteTask(id) {
      state.operations.push(`delete-task:${id}`);
      todoistDeletes.push(id);
      tasks.delete(id);
    },
    async upsertTask(payload, existingId) {
      const id = existingId || `created-${++created}`;
      const stored = { id, ...structuredClone(payload), project_id: "home-project" };
      state.operations.push(`upsert-task:${id}`);
      todoistUpserts.push({ id, payload: structuredClone(payload), existingId });
      tasks.set(id, stored);
      return stored;
    },
    async updateRecurringOccurrence(task, occurrence) {
      const concrete = occurrence.due?.datetime || occurrence.due?.date;
      const stored = {
        ...structuredClone(task),
        content: occurrence.content,
        description: occurrence.description || "",
        due: {
          ...structuredClone(task.due),
          date: concrete,
          ...(occurrence.due?.datetime ? { datetime: occurrence.due.datetime } : { datetime: undefined }),
          timezone: occurrence.due?.timezone || task.due?.timezone,
          string: task.due?.string,
          is_recurring: true,
        },
      };
      state.operations.push(`update-recurring-task:${task.id}:${concrete}`);
      todoistRecurringUpdates.push({ taskId: task.id, occurrence: structuredClone(occurrence), stored: structuredClone(stored) });
      tasks.set(task.id, stored);
      return structuredClone(stored);
    },
    async listTasks() { return [...tasks.values()].map((task) => structuredClone(task)); },
    async findComment() { return undefined; },
    async upsertComment() { return { id: "comment" }; },
    async deleteComment() {},
  };
  return { calendar, todoist, calendarDeletes, calendarUpserts, todoistDeletes, todoistUpserts, todoistRecurringUpdates, tasks, events };
}

function linkFor(active, taskId = "task-current") {
  return {
    profile: PROFILE,
    owner: "calendar",
    seriesId: SERIES,
    masterEventId: MASTER,
    activeInstanceId: active.id,
    originalStart: active.originalStartTime.date,
    activeEffectiveStart: active.start.date,
    taskId,
    eventId: active.id,
    updatedAt: "2026-09-06T00:00:00Z",
  };
}

function todoistOwnedLink(master, active, taskId = "task-recurring") {
  return {
    profile: PROFILE,
    owner: "todoist",
    seriesId: taskId,
    masterEventId: master.id,
    activeInstanceId: active?.id,
    originalStart: active?.originalStartTime?.dateTime || active?.originalStartTime?.date || master.start.dateTime || master.start.date,
    activeEffectiveStart: active?.start?.dateTime || active?.start?.date,
    taskId,
    eventId: master.id,
    updatedAt: "2026-09-06T00:00:00Z",
  };
}

test("selector keeps the linked occurrence until it actually ends", () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const next = instance("next", "2100-01-01", "2100-01-02");
  const selected = selectCalendarRecurrenceInstance([current, next], linkFor(current), Date.parse("2098-12-01T00:00:00Z"));
  assert.equal(selected?.id, "current");
});

test("selector skips expired history and chooses one current or future occurrence", () => {
  const expired = instance("expired", "2000-01-01", "2000-01-02");
  const current = instance("current", "2099-01-01", "2099-01-02");
  const later = instance("later", "2100-01-01", "2100-01-02");
  assert.equal(selectCalendarRecurrenceInstance([expired, current, later], undefined, Date.parse("2026-09-06T00:00:00Z"))?.id, "current");
});

test("repeated reconciliation cannot walk through future occurrences", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const next = instance("next", "2100-01-01", "2100-01-02");
  const link = linkFor(current);
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, content: current.summary, description: "", due: { date: current.start.date } }]]);
  const clients = fakeClients(state, [current, next], tasks);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.reconcile(PROFILE);
  await sync.reconcile(PROFILE);

  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.equal(state.links[0].activeInstanceId, "current");
});

test("expired occurrence rolls once and its generated deletion webhook cannot delete the master", async () => {
  const expired = instance("expired", "2000-01-01", "2000-01-02");
  const next = instance("next", "2099-01-01", "2099-01-02");
  const later = instance("later", "2100-01-01", "2100-01-02");
  const link = linkFor(expired, "task-old");
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, content: expired.summary, description: "", due: { date: expired.start.date } }]]);
  const clients = fakeClients(state, [expired, next, later], tasks);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.reconcile(PROFILE);

  assert.deepEqual(clients.todoistDeletes, ["task-old"]);
  assert.equal(clients.todoistUpserts.length, 1);
  const replacementId = clients.todoistUpserts[0].id;
  assert.equal(state.links[0].activeInstanceId, "next");
  assert.equal(state.links[0].taskId, replacementId);
  assert.ok(state.operations.indexOf("delete-mapping:task-old:expired") < state.operations.indexOf("delete-task:task-old"));

  await sync.reconcile(PROFILE);
  assert.deepEqual(clients.todoistDeletes, ["task-old"]);
  assert.equal(clients.todoistUpserts.length, 1);

  await sync.process({
    id: "old-delete-webhook",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T00:00:00Z",
    headers: {},
    body: JSON.stringify({
      event_name: "item:deleted",
      event_data: { id: "task-old", content: expired.summary, project_id: "home-project", due: { date: expired.start.date }, is_deleted: true },
    }),
  });

  assert.deepEqual(clients.calendarDeletes, []);
  assert.equal(state.links[0].activeInstanceId, "next");
});

test("repeated Calendar master notifications keep the same live mirror", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const next = instance("next", "2100-01-01", "2100-01-02");
  const link = linkFor(current);
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, content: current.summary, description: "", due: { date: current.start.date } }]]);
  const master = { id: MASTER, iCalUID: SERIES, summary: current.summary, recurrence: ["RRULE:FREQ=YEARLY"], status: "confirmed" };
  const clients = fakeClients(state, [current, next], tasks, master);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = { id: "calendar-master", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-09-06T00:00:00Z", headers: {}, body: "" };

  await sync.process(delivery);
  await sync.process({ ...delivery, id: "calendar-master-2" });

  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.equal(state.links[0].activeInstanceId, "current");
  assert.equal(state.audits.filter((entry) => entry.action === "calendar_recurrence_noop_active_instance").length, 2);
});

test("stale Calendar cancellation after Calendar-owned rollover cannot advance the series twice", async () => {
  const day1 = instance("day-1", "2099-01-01", "2099-01-02");
  const day2 = instance("day-2", "2099-01-02", "2099-01-03");
  const day3 = instance("day-3", "2099-01-03", "2099-01-04");
  const staleDay1Cancellation = { ...day1, status: "cancelled" };
  const link = linkFor(day1, "task-day-1");
  const state = new FakeState(link);
  const task = {
    id: link.taskId,
    content: day1.summary,
    description: "",
    project_id: "home-project",
    due: { date: day1.start.date },
  };
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [staleDay1Cancellation, day2, day3], tasks, staleDay1Cancellation);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-complete-day-1",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-01-01T12:00:00Z",
    headers: {},
    body: JSON.stringify({
      event_name: "item:completed",
      event_data: task,
      event_data_extra: { old_item: task },
    }),
  });

  assert.equal(state.links[0].activeInstanceId, day2.id);
  const day2TaskId = state.links[0].taskId;
  assert.equal(clients.todoistUpserts.length, 1);
  assert.equal(clients.todoistUpserts[0].payload.due.date, day2.start.date);

  await sync.process({
    id: "stale-calendar-day-1-cancellation",
    kind: "calendar",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-01-01T12:00:01Z",
    headers: {},
    body: "",
  });

  assert.equal(state.links[0].activeInstanceId, day2.id);
  assert.equal(state.links[0].taskId, day2TaskId);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.equal(clients.todoistUpserts.length, 1);
  assert.equal(tasks.has(day2TaskId), true);
  const staleCancellationAudit = state.audits.find(
    (entry) => entry.action === "calendar_recurrence_stale_instance_cancellation_ignored",
  );
  assert.deepEqual(staleCancellationAudit?.detail, {
    seriesId: SERIES,
    eventId: day1.id,
    activeInstanceId: day2.id,
  });
});

test("cancelled Calendar master still terminates a Calendar-owned recurrence", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const link = linkFor(current, "task-current");
  const state = new FakeState(link);
  const task = { id: link.taskId, content: current.summary, description: "", due: { date: current.start.date } };
  const tasks = new Map([[task.id, task]]);
  const cancelledMaster = {
    id: MASTER,
    iCalUID: SERIES,
    summary: current.summary,
    status: "cancelled",
    recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
  };
  const clients = fakeClients(state, [current], tasks, cancelledMaster);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "calendar-master-cancelled",
    kind: "calendar",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-01-01T12:00:00Z",
    headers: {},
    body: "",
  });

  assert.deepEqual(clients.todoistDeletes, [task.id]);
  assert.equal(state.links.length, 0);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_master_deleted"), true);
});

test("explicit deletion of the currently mapped Calendar-owned mirror still deletes the Calendar master", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const link = linkFor(current, "task-current");
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, content: current.summary, description: "", due: { date: current.start.date } }]]);
  const clients = fakeClients(state, [current], tasks);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "current-delete-webhook",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T00:00:00Z",
    headers: {},
    body: JSON.stringify({
      event_name: "item:deleted",
      event_data: { id: link.taskId, content: current.summary, project_id: "home-project", due: { date: current.start.date }, is_deleted: true },
    }),
  });

  assert.deepEqual(clients.calendarDeletes, [MASTER]);
  assert.equal(state.links.length, 0);
});

test("Todoist recurring completion advances the same task to the next effective Google instance", async () => {
  const initialTask = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(initialTask), id: "todoist-master", status: "confirmed" };
  const currentInstance = todoistInstance(master.id, initialTask.id, "instance-6", "2026-09-06");
  const nextInstance = todoistInstance(master.id, initialTask.id, "instance-7", "2026-09-07");
  const currentTask = { ...initialTask, due: { ...initialTask.due, date: "2026-09-07" } };
  const link = todoistOwnedLink(master, currentInstance, initialTask.id);
  const state = new FakeState(link);
  const tasks = new Map([[initialTask.id, currentTask]]);
  const clients = fakeClients(state, [currentInstance, nextInstance], tasks, undefined, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-complete",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: initialTask, event_data_extra: { old_item: initialTask } }),
  });

  assert.deepEqual(clients.calendarDeletes, []);
  assert.deepEqual(clients.calendarUpserts, []);
  assert.deepEqual(clients.todoistRecurringUpdates, []);
  assert.equal(state.links[0].masterEventId, "todoist-master");
  assert.equal(state.links[0].activeInstanceId, "instance-7");
  assert.equal(state.links[0].originalStart, "2026-09-07");
  assert.equal(state.links[0].activeEffectiveStart, "2026-09-07");
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_completed_advanced_to_effective_instance");
});

test("future Calendar instance deletion in a Todoist-owned RRULE is deferred", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const current = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const cancelledFuture = todoistInstance(master.id, task.id, "instance-7", "2026-09-07", "2026-09-07", "cancelled");
  const later = todoistInstance(master.id, task.id, "instance-8", "2026-09-08");
  const link = todoistOwnedLink(master, current, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [current, cancelledFuture, later], tasks, cancelledFuture, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({ id: "calendar-instance-delete", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-09-06T10:00:00Z", headers: {}, body: "" });

  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistRecurringUpdates, []);
  assert.equal(tasks.has(task.id), true);
  assert.equal(state.links[0].activeInstanceId, current.id);
  assert.equal(state.audits.some((entry) => entry.action === "todoist_recurrence_calendar_instance_cancelled_deferred"), true);
});

test("completion skips a deleted future Calendar occurrence", async () => {
  const initialTask = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(initialTask), id: "todoist-master", status: "confirmed" };
  const current = todoistInstance(master.id, initialTask.id, "instance-6", "2026-09-06");
  const cancelled = todoistInstance(master.id, initialTask.id, "instance-7", "2026-09-07", "2026-09-07", "cancelled");
  const next = todoistInstance(master.id, initialTask.id, "instance-8", "2026-09-08");
  const todoistProvisional = { ...initialTask, due: { ...initialTask.due, date: "2026-09-07" } };
  const link = todoistOwnedLink(master, current, initialTask.id);
  const state = new FakeState(link);
  const tasks = new Map([[initialTask.id, todoistProvisional]]);
  const clients = fakeClients(state, [current, cancelled, next], tasks, undefined, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-complete-skip",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: initialTask, event_data_extra: { old_item: initialTask } }),
  });

  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(clients.todoistRecurringUpdates[0].stored.due.date, "2026-09-08");
  assert.equal(clients.todoistRecurringUpdates[0].stored.due.string, "every day");
  assert.equal(state.links[0].activeInstanceId, next.id);
  assert.equal(state.links[0].originalStart, "2026-09-08");
  assert.equal(state.links[0].activeEffectiveStart, "2026-09-08");
});

test("moved Calendar exception can cross another occurrence without changing logical identity", () => {
  const taskId = "task-recurring";
  const masterId = "todoist-master";
  const current = todoistInstance(masterId, taskId, "instance-7", "2026-09-07");
  const moved = todoistInstance(masterId, taskId, "instance-14", "2026-09-14", "2026-09-25");
  const intervening = todoistInstance(masterId, taskId, "instance-21", "2026-09-21");
  const instances = [current, moved, intervening];

  // The 14-Sep logical occurrence has been moved behind 21 Sep. Selection is
  // therefore 21 Sep first, then the moved 14-Sep occurrence on 25 Sep. Its
  // originalStartTime remains 14 Sep so identity is never confused with order.
  const firstNext = selectNextEffectiveTodoistInstance(instances, current.id, current.start.date);
  assert.equal(firstNext?.id, intervening.id);
  assert.equal(firstNext?.originalStartTime.date, "2026-09-21");

  const secondNext = selectNextEffectiveTodoistInstance(instances, intervening.id, intervening.start.date);
  assert.equal(secondNext?.id, moved.id);
  assert.equal(secondNext?.originalStartTime.date, "2026-09-14");
  assert.equal(secondNext?.start.date, "2026-09-25");
});

test("active Calendar exception updates the recurring Todoist task but preserves its rule", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const movedActive = { ...todoistInstance(master.id, task.id, "instance-6", "2026-09-06", "2026-09-09"), summary: "Water plants outside" };
  const later = todoistInstance(master.id, task.id, "instance-7", "2026-09-07");
  const link = todoistOwnedLink(master, active, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [movedActive, later], tasks, movedActive, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({ id: "calendar-active-exception", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-09-06T10:00:00Z", headers: {}, body: "" });

  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(clients.todoistRecurringUpdates[0].stored.content, "Water plants outside");
  assert.equal(clients.todoistRecurringUpdates[0].stored.due.date, "2026-09-09");
  assert.equal(clients.todoistRecurringUpdates[0].stored.due.string, "every day");
  assert.equal(state.links[0].originalStart, "2026-09-06");
  assert.equal(state.links[0].activeEffectiveStart, "2026-09-09");
  assert.equal(state.audits.some((entry) => entry.action === "todoist_recurrence_calendar_active_exception_applied"), true);
});

test("deleting a Todoist-owned Calendar master keeps Todoist and suppresses future Calendar recreation", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const link = todoistOwnedLink(master, active, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const cancelledMaster = { ...master, status: "cancelled", recurrence: undefined };
  const clients = fakeClients(state, [active], tasks, cancelledMaster);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({ id: "calendar-master-delete", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-09-06T10:00:00Z", headers: {}, body: "" });

  assert.deepEqual(clients.todoistDeletes, []);
  assert.equal(tasks.has(task.id), true);
  assert.equal(state.links.length, 1);
  assert.equal(state.mappingsByTask.has(task.id), true);
  assert.equal(state.tombstones.length, 1);
  assert.equal(state.audits.some((entry) => entry.action === "todoist_recurrence_calendar_master_deleted_projection_only"), true);

  const advanced = { ...task, due: { ...task.due, date: "2026-09-07" } };
  tasks.set(task.id, advanced);
  await sync.process({
    id: "todoist-complete-after-calendar-delete",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-07T10:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: task }),
  });

  assert.deepEqual(clients.calendarUpserts, []);
  assert.equal(state.links.length, 1);
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_completion_suppressed_cancelled_calendar");
});

test("Todoist completion observing a missing RRULE master writes suppression before Calendar delta arrives", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const next = todoistInstance(master.id, task.id, "instance-7", "2026-09-07");
  const link = todoistOwnedLink(master, active, task.id);
  const state = new FakeState(link);
  const advanced = { ...task, due: { ...task.due, date: "2026-09-07" } };
  const tasks = new Map([[task.id, advanced]]);
  // Deliberately omit the master from the fake Calendar store. Google can
  // return 404/410 here before the cancelled-master delta is delivered.
  const clients = fakeClients(state, [active, next], tasks);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-complete-before-calendar-delete-delta",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:05:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: task, event_data_extra: { old_item: task } }),
  });

  assert.deepEqual(clients.calendarUpserts, []);
  assert.deepEqual(clients.calendarDeletes, []);
  assert.deepEqual(clients.todoistRecurringUpdates, []);
  assert.equal(state.links.length, 1);
  assert.equal(state.links[0].masterEventId, master.id);
  assert.equal(state.mappingsByTask.has(task.id), true);
  assert.equal(state.tombstones.length, 1);
  assert.equal(state.tombstones[0].sourceUpdatedAt, "2026-09-06T10:05:00Z");
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_completion_suppressed_missing_calendar_master");
});

test("Calendar edits to a Todoist-owned RRULE master are restored from Todoist", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const projected = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(projected.id, task.id, "instance-6", "2026-09-06");
  const edited = { ...projected, recurrence: ["RRULE:FREQ=WEEKLY"], summary: "Changed in Calendar" };
  const link = todoistOwnedLink(projected, active, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [active], tasks, edited);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({ id: "calendar-master-edit", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-09-06T10:00:00Z", headers: {}, body: "" });

  assert.deepEqual(clients.todoistUpserts, []);
  assert.equal(clients.calendarUpserts.length, 1);
  assert.deepEqual(clients.calendarUpserts[0].payload.recurrence, ["RRULE:FREQ=DAILY"]);
  assert.equal(clients.calendarUpserts[0].payload.summary, "Water plants");
  assert.equal(state.audits.some((entry) => entry.action === "todoist_recurrence_calendar_master_restored"), true);
});

test("deleting the Todoist recurring task deletes its Calendar RRULE master", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const link = todoistOwnedLink(master, active, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [active], tasks, undefined, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-delete",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:deleted", event_data: { ...task, is_deleted: true } }),
  });

  assert.deepEqual(clients.calendarDeletes, [master.id]);
  assert.equal(state.links.length, 0);
});
