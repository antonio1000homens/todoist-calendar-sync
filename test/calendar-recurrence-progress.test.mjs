import assert from "node:assert/strict";
import test from "node:test";
import {
  Synchronizer,
  selectCalendarRecurrenceInstance,
  suppressedLegacyCalendarRecurrenceCandidate,
} from "../dist/sync.js";

const PROFILE = "home";
const MASTER = "calendar-master";
const SERIES = "calendar-series";

function instance(id, start, end, status = "confirmed") {
  const timed = start.includes("T");
  return {
    id,
    status,
    summary: "Recurring reminder",
    description: "",
    recurringEventId: MASTER,
    iCalUID: SERIES,
    originalStartTime: timed ? { dateTime: start, timeZone: "Europe/London" } : { date: start },
    start: timed ? { dateTime: start, timeZone: "Europe/London" } : { date: start },
    end: timed ? { dateTime: end, timeZone: "Europe/London" } : { date: end },
  };
}

function linkFor(active, overrides = {}) {
  return {
    profile: PROFILE,
    owner: "calendar",
    seriesId: SERIES,
    masterEventId: MASTER,
    activeInstanceId: active.id,
    originalStart: active.originalStartTime.dateTime || active.originalStartTime.date,
    activeEffectiveStart: active.start.dateTime || active.start.date,
    taskId: "task-current",
    eventId: active.id,
    updatedAt: "2026-09-16T00:00:00Z",
    ...overrides,
  };
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
    calendarProgressVersion: link.calendarProgressVersion,
    completedThroughOriginalStart: link.completedThroughOriginalStart,
    updatedAt: link.updatedAt,
  };
}

class FakeState {
  constructor(link) {
    this.audits = [];
    this.operations = [];
    this.links = link ? [structuredClone(link)] : [];
    this.mappingsByTask = new Map();
    this.mappingsByEvent = new Map();
    if (link) this.storeMapping(mappingFromLink(link));
  }

  storeMapping(mapping) {
    this.mappingsByTask.set(mapping.taskId, structuredClone(mapping));
    this.mappingsByEvent.set(mapping.eventId, structuredClone(mapping));
  }

  async getSyncToken() { return "sync-token"; }
  async putSyncToken() {}
  async deleteSyncToken() {}
  async getRecurrenceLink(profile, seriesId) { return this.links.find((link) => link.profile === profile && link.seriesId === seriesId); }
  async listRecurrenceLinks(profile) { return this.links.filter((link) => link.profile === profile).map((link) => structuredClone(link)); }
  async putRecurrenceLink(link) {
    this.operations.push({ action: "put-link", link: structuredClone(link) });
    this.links = this.links.filter((item) => !(item.profile === link.profile && item.seriesId === link.seriesId));
    this.links.push(structuredClone(link));
  }
  async deleteRecurrenceLink(profile, seriesId) {
    this.links = this.links.filter((link) => !(link.profile === profile && link.seriesId === seriesId));
  }
  async getMappingByTask(_profile, taskId) { return this.mappingsByTask.get(taskId); }
  async getMappingByEvent(_profile, eventId) { return this.mappingsByEvent.get(eventId); }
  async putMapping(mapping) {
    this.operations.push({ action: "put-mapping", mapping: structuredClone(mapping) });
    this.storeMapping(mapping);
  }
  async deleteMapping(mapping) {
    this.operations.push({ action: "delete-mapping", mapping: structuredClone(mapping) });
    this.mappingsByTask.delete(mapping.taskId);
    this.mappingsByEvent.delete(mapping.eventId);
  }
  async mutationAllowed() { return true; }
  async recordMutation() { this.operations.push({ action: "record-mutation" }); }
  async acceptTaskVersion() { return true; }
  async getCalendarProjectionTombstone() { return undefined; }
  async putCalendarProjectionTombstone() {}
  async deleteCalendarProjectionTombstone() {}
  async recordRecurrence() {}
  async audit(_profile, action, detail) { this.audits.push({ action, detail }); }
}

function fakeClients(state, instances, link, masterDelta) {
  const tasks = new Map();
  if (link) {
    const active = instances.find((item) => item.id === link.activeInstanceId);
    if (active) {
      tasks.set(link.taskId, {
        id: link.taskId,
        content: active.summary,
        description: active.description,
        due: active.start.date ? { date: active.start.date } : { datetime: active.start.dateTime, timezone: "Europe/London" },
      });
    }
  }
  const todoistDeletes = [];
  const todoistUpserts = [];
  const calendarDeletes = [];
  let created = 0;
  return {
    tasks,
    todoistDeletes,
    todoistUpserts,
    calendarDeletes,
    calendar: {
      async listDelta() { return { items: masterDelta ? [masterDelta] : [], nextSyncToken: "next" }; },
      async listInstances() { return instances.map((item) => structuredClone(item)); },
      async deleteEvent(id) { calendarDeletes.push(id); state.operations.push({ action: "delete-calendar", id }); },
      async getEvent(id) { return instances.find((item) => item.id === id); },
      async findByTodoistTaskId() { return undefined; },
      async upsertEvent(event) { return { ...structuredClone(event), id: event.id || "stored" }; },
    },
    todoist: {
      async getTask(id) {
        const task = tasks.get(id);
        if (!task) throw Object.assign(new Error("missing"), { status: 404 });
        return structuredClone(task);
      },
      async upsertTask(payload, existingId) {
        const id = existingId || `created-${++created}`;
        const task = { id, ...structuredClone(payload) };
        tasks.set(id, task);
        todoistUpserts.push({ id, existingId, payload: structuredClone(payload) });
        state.operations.push({ action: "upsert-task", id, existingId });
        return structuredClone(task);
      },
      async deleteTask(id) { todoistDeletes.push(id); tasks.delete(id); state.operations.push({ action: "delete-task", id }); },
      async listTasks() { return [...tasks.values()].map((task) => structuredClone(task)); },
      async findComment() { return undefined; },
      async upsertComment() { return { id: "comment" }; },
      async deleteComment() {},
      async updateRecurringOccurrence(task) { return task; },
    },
  };
}

function masterEvent() {
  return {
    id: MASTER,
    status: "confirmed",
    summary: "Recurring reminder",
    description: "",
    iCalUID: SERIES,
    start: { date: "2026-09-17" },
    end: { date: "2026-09-18" },
    recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
  };
}

test("legacy Calendar recurrence keeps a live mapped occurrence and exposes the suppressed earlier candidate", () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current);
  assert.equal(selectCalendarRecurrenceInstance([earlier, current], link, Date.parse("2099-09-16T00:00:00Z"))?.id, "day-18");
  assert.equal(suppressedLegacyCalendarRecurrenceCandidate([earlier, current], link, Date.parse("2099-09-16T00:00:00Z"))?.id, "day-17");
});

test("progress-aware Calendar recurrence re-anchors to the earliest uncompleted occurrence", () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current, { calendarProgressVersion: 1 });
  assert.equal(selectCalendarRecurrenceInstance([current, earlier], link, Date.parse("2099-09-16T00:00:00Z"))?.id, "day-17");
  assert.equal(suppressedLegacyCalendarRecurrenceCandidate([earlier, current], link, Date.parse("2099-09-16T00:00:00Z")), undefined);
});

test("progress watermark permanently consumes occurrences at or before the completed logical start", () => {
  const completed = instance("completed", "2099-09-17", "2099-09-18");
  const successor = instance("successor", "2099-09-18", "2099-09-19");
  const link = linkFor(successor, { calendarProgressVersion: 1, completedThroughOriginalStart: "2099-09-17" });
  assert.equal(selectCalendarRecurrenceInstance([completed, successor], link, Date.parse("2099-09-16T00:00:00Z"))?.id, "successor");
});

test("timed completion boundaries compare logical instants across offsets", () => {
  const sameInstant = instance("same", "2099-09-17T08:00:00Z", "2099-09-17T09:00:00Z");
  const later = instance("later", "2099-09-17T08:30:00Z", "2099-09-17T09:30:00Z");
  const link = linkFor(later, { calendarProgressVersion: 1, completedThroughOriginalStart: "2099-09-17T09:00:00+01:00" });
  assert.equal(selectCalendarRecurrenceInstance([sameInstant, later], link, Date.parse("2099-09-16T00:00:00Z"))?.id, "later");
});

test("Calendar master re-anchor updates the same Todoist mirror in place for trusted progress state", async () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, [earlier, current], link, masterEvent());
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "calendar-reanchor",
    kind: "calendar",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-09-16T10:00:00Z",
    headers: {},
    body: "",
  });

  assert.deepEqual(clients.todoistDeletes, []);
  assert.equal(clients.todoistUpserts.length, 1);
  assert.equal(clients.todoistUpserts[0].existingId, link.taskId);
  assert.equal(clients.todoistUpserts[0].id, link.taskId);
  assert.equal(state.links[0].activeInstanceId, "day-17");
  assert.equal(state.links[0].calendarProgressVersion, 1);
});

test("legacy Calendar master re-anchor remains pinned and emits the dedicated suppression audit", async () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current);
  const state = new FakeState(link);
  const clients = fakeClients(state, [earlier, current], link, masterEvent());
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "legacy-reanchor",
    kind: "calendar",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-09-16T10:00:00Z",
    headers: {},
    body: "",
  });

  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  const audit = state.audits.find((entry) => entry.action === "calendar_recurrence_backward_shift_suppressed_legacy_state");
  assert.ok(audit);
  assert.equal(audit.detail.currentInstanceId, "day-18");
  assert.equal(audit.detail.candidateInstanceId, "day-17");
});

test("completing a Calendar-owned occurrence persists the monotonic boundary before binding its successor", async () => {
  const completed = instance("day-17", "2099-09-17", "2099-09-18");
  const successor = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(completed, {
    calendarProgressVersion: 1,
    completedThroughOriginalStart: "2099-09-16",
  });
  const state = new FakeState(link);
  const clients = fakeClients(state, [completed, successor], link);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "complete-day-17",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-09-17T12:00:00Z",
    headers: {},
    body: JSON.stringify({
      event_name: "item:completed",
      event_data: {
        id: link.taskId,
        content: completed.summary,
        description: "",
        due: { date: completed.start.date },
        is_completed: true,
      },
    }),
  });

  const boundaryWrite = state.operations.findIndex((operation) => operation.action === "put-link" && operation.link.completedThroughOriginalStart === "2099-09-17");
  const deleteCalendar = state.operations.findIndex((operation) => operation.action === "delete-calendar");
  assert.ok(boundaryWrite >= 0);
  assert.ok(deleteCalendar > boundaryWrite);
  assert.equal(state.links[0].activeInstanceId, "day-18");
  assert.equal(state.links[0].completedThroughOriginalStart, "2099-09-17");
  assert.equal(state.links[0].calendarProgressVersion, 1);
});
