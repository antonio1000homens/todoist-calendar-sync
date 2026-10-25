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
  async syncBlocked() { return false; }
  async getMappingByTaskAnyProfile(taskId) { return this.mappingsByTask.get(taskId); }
  constructor(link) {
    this.audits = [];
    this.operations = [];
    this.links = link ? [structuredClone(link)] : [];
    this.completedProjections = [];
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
  async advanceCalendarSeriesMapping({ previous, mapping, link }) {
    this.operations.push({ action: "advance-mapping", previous: structuredClone(previous), mapping: structuredClone(mapping), link: structuredClone(link) });
    if (this.failAdvance) throw new Error("injected recurrence mapping transaction failure");
    if (this.mappingsByEvent.get(previous.eventId)?.taskId !== previous.taskId
      || this.links.find((item) => item.profile === previous.profile && item.seriesId === previous.seriesId)?.eventId !== previous.eventId) return false;
    this.mappingsByEvent.delete(previous.eventId);
    this.storeMapping(mapping);
    this.links = this.links.filter((item) => !(item.profile === link.profile && item.seriesId === link.seriesId));
    this.links.push(structuredClone(link));
    return true;
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
    if (this.mappingsByTask.get(mapping.taskId)?.eventId === mapping.eventId) this.mappingsByTask.delete(mapping.taskId);
    if (this.mappingsByEvent.get(mapping.eventId)?.taskId === mapping.taskId) this.mappingsByEvent.delete(mapping.eventId);
  }
  async mutationAllowed() { return true; }
  async recordMutation() { this.operations.push({ action: "record-mutation" }); }
  async acceptTaskVersion() { return true; }
  async getCalendarProjectionTombstone() { return undefined; }
  async putCalendarProjectionTombstone() {}
  async deleteCalendarProjectionTombstone() {}
  async recordRecurrence() {}
  async getCompletedCalendarProjectionByEvent(profile, eventId) { return this.completedProjections.find((item) => item.profile === profile && item.eventId === eventId); }
  async listCompletedCalendarProjectionsByTask(profile, taskId) { return this.completedProjections.filter((item) => item.profile === profile && item.taskId === taskId); }
  async putCompletedCalendarProjection(projection) {
    this.operations.push({ action: "put-completed", projection: structuredClone(projection) });
    const index = this.completedProjections.findIndex((item) => item.profile === projection.profile && item.eventId === projection.eventId);
    if (index >= 0) this.completedProjections[index] = structuredClone(projection); else this.completedProjections.push(structuredClone(projection));
  }
  async deleteCompletedCalendarProjection(projection) {
    this.completedProjections = this.completedProjections.filter((item) => !(item.profile === projection.profile && item.eventId === projection.eventId));
  }
  async audit(_profile, action, detail) { this.audits.push({ action, detail }); }
}

function fakeClients(state, instances, link, masterDelta, recurrenceString) {
  const failures = {};
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
      if (recurrenceString) tasks.get(link.taskId).due = {
        ...tasks.get(link.taskId).due, string: recurrenceString, is_recurring: true,
      };
    }
  }
  const todoistDeletes = [];
  const todoistUpserts = [];
  const calendarDeletes = [];
  const calendarUpserts = [];
  const recurringUpdates = [];
  let created = 0;
  return {
    tasks,
    todoistDeletes,
    todoistUpserts,
    calendarDeletes,
    calendarUpserts,
    recurringUpdates,
    failures,
    calendar: {
      async listDelta() { return { items: masterDelta ? [masterDelta] : [], nextSyncToken: "next" }; },
      async listInstances() {
        if (failures.listInstances) throw new Error("injected Calendar instance read failure");
        return instances.map((item) => structuredClone(item));
      },
      async getTimeZone() {
        if (failures.calendarTimezone) throw new Error("injected Calendar timezone read failure");
        return failures.calendarTimeZone || "Europe/London";
      },
      async deleteEvent(id) { calendarDeletes.push(id); state.operations.push({ action: "delete-calendar", id }); },
      async getEvent(id) {
        if (id === masterDelta?.id) return structuredClone(masterDelta);
        if (id === MASTER) return structuredClone(masterDelta || masterEvent());
        return instances.find((item) => item.id === id);
      },
      async findByTodoistTaskId() { return undefined; },
      async upsertEvent(event) { calendarUpserts.push(structuredClone(event)); return { ...structuredClone(event), id: event.id || "stored" }; },
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
      async getTimeZone() {
        if (failures.timezone) throw new Error("injected Todoist timezone read failure");
        return failures.todoistTimeZone || "Europe/London";
      },
      async updateRecurringOccurrence(task, occurrence) {
        if (failures.update) throw new Error("injected Todoist update failure");
        recurringUpdates.push({ taskId: task.id, occurrence: structuredClone(occurrence) });
        if (failures.staleReadback) {
          failures.staleReadback = false;
          return structuredClone(task);
        }
        const updated = {
          ...task, ...structuredClone(occurrence), id: task.id,
          due: { ...task.due, ...structuredClone(occurrence.due), string: task.due.string, is_recurring: true },
        };
        tasks.set(task.id, updated);
        state.operations.push({ action: "update-recurring", taskId: task.id, due: structuredClone(updated.due) });
        return structuredClone(updated);
      },
      async getTimeZone() {
        if (failures.timezone) throw new Error("injected Todoist timezone read failure");
        return failures.todoistTimeZone || "Europe/London";
      },
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

function completedDelivery(id, taskId, occurrence, receivedAt) {
  return {
    id,
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt,
    headers: {},
    body: JSON.stringify({
      event_name: "item:completed",
      event_data: {
        id: taskId,
        content: occurrence.summary,
        description: "",
        due: occurrence.start.date ? { date: occurrence.start.date } : { datetime: occurrence.start.dateTime },
        is_completed: true,
      },
    }),
  };
}

test("legacy Calendar recurrence keeps a live mapped occurrence and exposes the suppressed earlier candidate", () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current);
  assert.equal(selectCalendarRecurrenceInstance([earlier, current], link, Date.parse("2099-09-16T00:00:00Z"), "Europe/London")?.id, "day-18");
  assert.equal(suppressedLegacyCalendarRecurrenceCandidate([earlier, current], link, Date.parse("2099-09-16T00:00:00Z"), "Europe/London")?.id, "day-17");
});

test("progress-aware Calendar recurrence re-anchors to the earliest uncompleted occurrence", () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current, { calendarProgressVersion: 1 });
  assert.equal(selectCalendarRecurrenceInstance([current, earlier], link, Date.parse("2099-09-16T00:00:00Z"), "Europe/London")?.id, "day-17");
  assert.equal(suppressedLegacyCalendarRecurrenceCandidate([earlier, current], link, Date.parse("2099-09-16T00:00:00Z"), "Europe/London"), undefined);
});

test("progress watermark permanently consumes occurrences at or before the completed logical start", () => {
  const completed = instance("completed", "2099-09-17", "2099-09-18");
  const successor = instance("successor", "2099-09-18", "2099-09-19");
  const link = linkFor(successor, { calendarProgressVersion: 1, completedThroughOriginalStart: "2099-09-17" });
  assert.equal(selectCalendarRecurrenceInstance([completed, successor], link, Date.parse("2099-09-16T00:00:00Z"), "Europe/London")?.id, "successor");
});

test("timed completion boundaries compare logical instants across offsets", () => {
  const sameInstant = instance("same", "2099-09-17T08:00:00Z", "2099-09-17T09:00:00Z");
  const later = instance("later", "2099-09-17T08:30:00Z", "2099-09-17T09:30:00Z");
  const link = linkFor(later, { calendarProgressVersion: 1, completedThroughOriginalStart: "2099-09-17T09:00:00+01:00" });
  assert.equal(selectCalendarRecurrenceInstance([sameInstant, later], link, Date.parse("2099-09-16T00:00:00Z"))?.id, "later");
});

test("all-day selection uses Calendar local date at near-midnight UTC boundaries", () => {
  const occurrence = instance("berlin-day", "2026-11-03", "2026-11-04");
  const now = Date.parse("2026-11-03T23:30:00Z"); // already Nov 4 in Europe/Berlin
  assert.equal(selectCalendarRecurrenceInstance([occurrence], undefined, now, "Europe/Berlin"), undefined);
  assert.equal(selectCalendarRecurrenceInstance([occurrence], undefined, now, "UTC")?.id, "berlin-day");
  assert.throws(() => selectCalendarRecurrenceInstance([occurrence], undefined, now), /Calendar timezone is required/);
});

for (const failure of ["calendarTimezone", "todoistTimeZone"]) {
  test(`Calendar recurrence reconcile fails closed on all-day ${failure} uncertainty`, async () => {
    const expired = instance("expired-day", "2026-11-03", "2026-11-04");
    const next = instance("next-day", "2026-11-10", "2026-11-11");
    const link = linkFor(expired);
    const master = {
      id: MASTER, status: "confirmed", summary: "Recurring reminder", description: "", iCalUID: SERIES,
      start: { date: "2026-11-03" }, end: { date: "2026-11-04" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    };
    const state = new FakeState(link);
    const clients = fakeClients(state, [expired, next], link, master);
    clients.failures[failure] = failure === "todoistTimeZone" ? "Europe/Berlin" : true;
    const sync = new Synchronizer(state, undefined, async () => clients);

    await sync.reconcile(PROFILE);

    assert.deepEqual(clients.todoistDeletes, []);
    assert.deepEqual(clients.todoistUpserts, []);
    assert.equal(state.links[0].activeInstanceId, expired.id);
    assert.equal(state.mappingsByEvent.get(expired.id)?.taskId, link.taskId);
    assert.ok(state.audits.some((entry) => entry.action === (failure === "calendarTimezone"
      ? "calendar_recurrence_calendar_timezone_unverified" : "calendar_recurrence_todoist_timezone_mismatch")));
  });
}

for (const failure of ["calendarTimezone", "todoistTimeZone"]) {
  test(`deleting the active all-day Calendar occurrence leaves state untouched when ${failure} cannot be verified`, async () => {
    const current = instance("cancelled-day", "2099-09-02", "2099-09-03", "cancelled");
    const successor = instance("successor-day", "2099-09-09", "2099-09-10");
    const master = {
      id: MASTER, status: "confirmed", summary: "Recurring reminder", description: "", iCalUID: SERIES,
      start: { date: "2099-09-02" }, end: { date: "2099-09-03" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    };
    const link = linkFor(current);
    const state = new FakeState(link);
    const clients = fakeClients(state, [current, successor], link, current);
    clients.calendar.listDelta = async () => ({ items: [structuredClone(current)], nextSyncToken: "next" });
    clients.calendar.getEvent = async (id) => id === MASTER ? structuredClone(master)
      : [current, successor].find((item) => item.id === id);
    clients.failures[failure] = failure === "todoistTimeZone" ? "Europe/Berlin" : true;
    const sync = new Synchronizer(state, undefined, async () => clients);

    await sync.process({
      id: `delete-all-day-${failure}`, kind: "calendar", profile: PROFILE, mode: "aws",
      receivedAt: "2099-09-02T12:00:00Z", headers: {}, body: "",
    });

    assert.deepEqual(clients.todoistDeletes, []);
    assert.deepEqual(clients.todoistUpserts, []);
    assert.equal(state.links[0].activeInstanceId, current.id);
    assert.equal(state.mappingsByEvent.get(current.id)?.taskId, link.taskId);
    assert.ok(state.audits.some((entry) => entry.action === (failure === "calendarTimezone"
      ? "calendar_recurrence_calendar_timezone_unverified" : "calendar_recurrence_todoist_timezone_mismatch")));
  });
}

test("Calendar master re-anchor updates the same Todoist mirror once under repeated notifications", async () => {
  const earlier = instance("day-17", "2099-09-17", "2099-09-18");
  const current = instance("day-18", "2099-09-18", "2099-09-19");
  const link = linkFor(current, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, [earlier, current], link, masterEvent());
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = {
    id: "calendar-reanchor",
    kind: "calendar",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2099-09-16T10:00:00Z",
    headers: {},
    body: "",
  };

  await sync.process(delivery);
  await sync.process({ ...delivery, id: "calendar-reanchor-duplicate" });

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

  await sync.process(completedDelivery("complete-day-17", link.taskId, completed, "2099-09-17T12:00:00Z"));

  const boundaryWrite = state.operations.findIndex((operation) => operation.action === "advance-mapping" && operation.link.completedThroughOriginalStart === "2099-09-17");
  const retainedWrite = state.operations.findIndex((operation) => operation.action === "put-completed" && operation.projection.eventId === completed.id);
  const taskAdvance = state.operations.findIndex((operation) => operation.action === "update-recurring" || operation.action === "upsert-task");
  const deleteCalendar = state.operations.findIndex((operation) => operation.action === "delete-calendar");
  assert.ok(boundaryWrite >= 0);
  assert.ok(retainedWrite >= 0);
  assert.ok(boundaryWrite > taskAdvance);
  assert.equal(deleteCalendar, -1);
  assert.equal(state.completedProjections.length, 1);
  assert.equal(state.completedProjections[0].eventId, completed.id);
  assert.equal(state.links[0].activeInstanceId, "day-18");
  assert.equal(state.links[0].completedThroughOriginalStart, "2099-09-17");
  assert.equal(state.links[0].calendarProgressVersion, 1);
});

test("multiple Calendar-owned completions advance the watermark monotonically and stale completion replays cannot roll it back", async () => {
  const day17 = instance("day-17", "2099-09-17", "2099-09-18");
  const day18 = instance("day-18", "2099-09-18", "2099-09-19");
  const day19 = instance("day-19", "2099-09-19", "2099-09-20");
  const link = linkFor(day17, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, [day17, day18, day19], link);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process(completedDelivery("complete-day-17", link.taskId, day17, "2099-09-17T12:00:00Z"));
  const day18TaskId = state.links[0].taskId;
  assert.equal(state.links[0].completedThroughOriginalStart, "2099-09-17");
  assert.equal(state.links[0].activeInstanceId, "day-18");

  await sync.process(completedDelivery("complete-day-18", day18TaskId, day18, "2099-09-18T12:00:00Z"));
  assert.equal(state.links[0].completedThroughOriginalStart, "2099-09-18");
  assert.equal(state.links[0].activeInstanceId, "day-19");

  await sync.process(completedDelivery("stale-replay-day-17", link.taskId, day17, "2099-09-19T12:00:00Z"));
  assert.equal(state.completedProjections.some((projection) => projection.eventId === day17.id), true);
  assert.equal(state.completedProjections.some((projection) => projection.eventId === day18.id), true);
  assert.equal(state.links[0].completedThroughOriginalStart, "2099-09-18");
  assert.equal(state.links[0].activeInstanceId, "day-19");
});

test("Calendar-owned finite weekly completion skips a canceled occurrence and advances the same Todoist task", async () => {
  const scheduled = [4, 11, 18, 25].map((day, index) => instance(
    `nov-${day}`, `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`,
    `2026-11-${String(day).padStart(2, "0")}T14:15:00Z`, index === 1 ? "cancelled" : "confirmed",
  ));
  const master = {
    id: MASTER, status: "confirmed", summary: "Task", description: "", iCalUID: SERIES,
    start: { dateTime: "2026-11-04T14:00:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const current = scheduled[0];
  const recurringString = "every Wednesday at 2:00pm starting 4 Nov 2026 ending 25 Nov 2026";
  const link = linkFor(current, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, scheduled, link, master, recurringString);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = completedDelivery("complete-nov-4", link.taskId, current, "2026-11-04T15:00:00Z");
  const parsed = JSON.parse(delivery.body);
  parsed.event_data_extra = { old_item: structuredClone(clients.tasks.get(link.taskId)) };
  delivery.body = JSON.stringify(parsed);

  await sync.process(delivery);

  const task = clients.tasks.get(link.taskId);
  assert.equal(task.id, link.taskId);
  assert.equal(task.due.is_recurring, true);
  assert.equal(task.due.string, recurringString);
  assert.equal(task.due.datetime, "2026-11-18T14:00:00Z");
  assert.deepEqual(clients.recurringUpdates.map((entry) => entry.taskId), [link.taskId]);
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(clients.todoistDeletes.length, 0);
  assert.equal(clients.calendarDeletes.length, 0);
  assert.equal(clients.calendarUpserts.length, 0);
  assert.equal(state.links[0].taskId, link.taskId);
  assert.equal(state.links[0].activeInstanceId, "nov-18");
  assert.equal(state.links[0].completedThroughOriginalStart, "2026-11-04T14:00:00Z");

  await sync.process(delivery);
  assert.equal(clients.tasks.get(link.taskId).due.datetime, "2026-11-18T14:00:00Z");
  assert.equal(clients.recurringUpdates.length, 1, "replay must not advance the same task twice");
  assert.equal(clients.calendarUpserts.length, 0, "Calendar series remains untouched on replay");
});

test("Calendar-owned all-day weekly completion skips canceled dates and preserves the same Todoist task", async () => {
  const scheduled = [2, 9, 16, 23].map((day, index) => instance(
    `sep-${day}`, `2099-09-${String(day).padStart(2, "0")}`, `2099-09-${String(day + 1).padStart(2, "0")}`,
    index === 1 ? "cancelled" : "confirmed",
  ));
  const master = {
    id: MASTER, status: "confirmed", summary: "Recurring reminder", description: "", iCalUID: SERIES,
    start: { date: "2099-09-02" }, end: { date: "2099-09-03" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const current = scheduled[0];
  const recurringString = "every Wednesday starting 2 Sep 2099 ending 23 Sep 2099";
  const link = linkFor(current, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, scheduled, link, master, recurringString);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = completedDelivery("complete-sep-2", link.taskId, current, "2099-09-02T12:00:00Z");
  const parsed = JSON.parse(delivery.body);
  parsed.event_data_extra = { old_item: structuredClone(clients.tasks.get(link.taskId)) };
  delivery.body = JSON.stringify(parsed);

  await sync.process(delivery);
  const task = clients.tasks.get(link.taskId);
  assert.equal(task.id, link.taskId);
  assert.equal(task.due.date, "2099-09-16");
  assert.equal(task.due.datetime, undefined);
  assert.equal(task.due.string, recurringString);
  assert.equal(state.links[0].activeInstanceId, "sep-16");
  assert.equal(clients.calendarDeletes.length, 0);
  assert.equal(clients.calendarUpserts.length, 0);
});

test("all-day completion timezone mismatch fails closed without Todoist or Calendar writes", async () => {
  const scheduled = [2, 9, 16, 23].map((day, index) => instance(
    `mismatch-${day}`, `2099-09-${String(day).padStart(2, "0")}`, `2099-09-${String(day + 1).padStart(2, "0")}`,
    index === 1 ? "cancelled" : "confirmed",
  ));
  const master = {
    id: MASTER, status: "confirmed", summary: "Recurring reminder", description: "", iCalUID: SERIES,
    start: { date: "2099-09-02" }, end: { date: "2099-09-03" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const current = scheduled[0];
  const recurrenceString = "every Wednesday starting 2 Sep 2099 ending 23 Sep 2099";
  const link = linkFor(current, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, scheduled, link, master, recurrenceString);
  clients.failures.todoistTimeZone = "Europe/Berlin";
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = completedDelivery("all-day-zone-mismatch", link.taskId, current, "2099-09-02T12:00:00Z");
  const parsed = JSON.parse(delivery.body);
  parsed.event_data_extra = { old_item: structuredClone(clients.tasks.get(link.taskId)) };
  delivery.body = JSON.stringify(parsed);

  await sync.process(delivery);
  assert.equal(clients.recurringUpdates.length, 0);
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(clients.calendarUpserts.length, 0);
  assert.equal(clients.calendarDeletes.length, 0);
  assert.equal(state.links[0].activeInstanceId, current.id);
  assert.equal(clients.tasks.get(link.taskId).due.date, "2099-09-02");
  assert.ok(state.audits.some((entry) => entry.action === "calendar_recurrence_todoist_timezone_mismatch"));
});

test("non-recurring Todoist completion of an all-day Calendar series also requires matching timezones", async () => {
  const completed = instance("all-day-completed", "2099-09-02", "2099-09-03");
  const successor = instance("all-day-successor", "2099-09-09", "2099-09-10");
  const link = linkFor(completed, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, [completed, successor], link, masterEvent());
  clients.failures.todoistTimeZone = "Europe/Berlin";
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process(completedDelivery("complete-all-day-nonrecurring", link.taskId, completed, "2099-09-02T12:00:00Z"));

  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(clients.recurringUpdates.length, 0);
  assert.equal(clients.calendarUpserts.length, 0);
  assert.equal(state.links[0].activeInstanceId, completed.id);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_recurrence_todoist_timezone_mismatch"));
});

test("incremental import resolves all-day Calendar resource timezone before creating a recurring task", async () => {
  const scheduled = [2, 9, 16, 23].map((day, index) => instance(
    `incremental-${day}`, `2099-09-${String(day).padStart(2, "0")}`, `2099-09-${String(day + 1).padStart(2, "0")}`,
    index === 1 ? "cancelled" : "confirmed",
  ));
  const master = {
    id: MASTER, status: "confirmed", summary: "Recurring reminder", description: "", iCalUID: SERIES,
    start: { date: "2099-09-02" }, end: { date: "2099-09-03" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const state = new FakeState();
  const clients = fakeClients(state, scheduled, undefined, master);
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "incremental-all-day", kind: "calendar", profile: PROFILE, mode: "aws",
    receivedAt: "2099-09-01T10:00:00Z", headers: {}, body: "",
  });
  assert.equal(clients.todoistUpserts.length, 1);
  assert.equal(clients.todoistUpserts[0].payload.due.date, "2099-09-02");
  assert.equal(clients.todoistUpserts[0].payload.due.datetime, undefined);
  assert.equal(clients.todoistUpserts[0].payload.due.string, "every Wednesday starting 2 Sep 2099 and ending 23 Sep 2099");
  assert.equal(state.links[0].activeInstanceId, "incremental-2");
});

test("incremental all-day recurrence import fails closed on Todoist timezone mismatch", async () => {
  const scheduled = [2, 9, 16, 23].map((day) => instance(
    `incremental-${day}`, `2099-09-${String(day).padStart(2, "0")}`, `2099-09-${String(day + 1).padStart(2, "0")}`,
  ));
  const master = {
    id: MASTER, status: "confirmed", summary: "Recurring reminder", description: "", iCalUID: SERIES,
    start: { date: "2099-09-02" }, end: { date: "2099-09-03" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const state = new FakeState();
  const clients = fakeClients(state, scheduled, undefined, master);
  clients.failures.todoistTimeZone = "Europe/Berlin";
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "incremental-all-day-mismatch", kind: "calendar", profile: PROFILE, mode: "aws",
    receivedAt: "2099-09-01T10:00:00Z", headers: {}, body: "",
  });
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(state.links.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_recurrence_todoist_timezone_mismatch"));
});

for (const failurePoint of ["listInstances", "timezone", "update", "advance"]) {
  test(`Calendar-owned completion retries after ${failurePoint} failure without losing its advance`, async () => {
    const scheduled = [4, 11, 18, 25].map((day, index) => instance(
      `retry-nov-${day}`, `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`,
      `2026-11-${String(day).padStart(2, "0")}T14:15:00Z`, index === 1 ? "cancelled" : "confirmed",
    ));
    const master = {
      id: MASTER, status: "confirmed", summary: "Task", description: "", iCalUID: SERIES,
      start: { dateTime: "2026-11-04T14:00:00Z", timeZone: "Europe/London" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    };
    const current = scheduled[0];
    const recurrenceString = "every Wednesday at 2:00pm starting 4 Nov 2026 ending 25 Nov 2026";
    const link = linkFor(current, { calendarProgressVersion: 1 });
    const state = new FakeState(link);
    const clients = fakeClients(state, scheduled, link, master, recurrenceString);
    const sync = new Synchronizer(state, undefined, async () => clients);
    const delivery = completedDelivery(`retry-${failurePoint}`, link.taskId, current, "2026-11-04T15:00:00Z");
    const parsed = JSON.parse(delivery.body);
    parsed.event_data_extra = { old_item: structuredClone(clients.tasks.get(link.taskId)) };
    delivery.body = JSON.stringify(parsed);
    clients.failures[failurePoint] = true;
    if (failurePoint === "advance") state.failAdvance = true;

    if (failurePoint === "timezone") await sync.process(delivery);
    else await assert.rejects(sync.process(delivery), /injected/);
    assert.equal(state.links[0].activeInstanceId, current.id);
    assert.equal(state.links[0].completedThroughOriginalStart, undefined);
    assert.equal(state.mappingsByTask.get(link.taskId).activeInstanceId, current.id);

    clients.failures[failurePoint] = false;
    state.failAdvance = false;
    await sync.process(delivery);
    assert.equal(state.links[0].activeInstanceId, "retry-nov-18");
    assert.equal(state.links[0].completedThroughOriginalStart, "2026-11-04T14:00:00Z");
    assert.equal(state.mappingsByTask.get(link.taskId).taskId, link.taskId);
    assert.equal(clients.tasks.get(link.taskId).due.datetime, "2026-11-18T14:00:00Z");
  });
}

test("Calendar-owned completion does not bind a successor until Todoist readback confirms recurrence and due occurrence", async () => {
  const scheduled = [4, 11, 18, 25].map((day, index) => instance(
    `readback-nov-${day}`, `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`,
    `2026-11-${String(day).padStart(2, "0")}T14:15:00Z`, index === 1 ? "cancelled" : "confirmed",
  ));
  const master = {
    id: MASTER, status: "confirmed", summary: "Task", description: "", iCalUID: SERIES,
    start: { dateTime: "2026-11-04T14:00:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const current = scheduled[0];
  const recurrenceString = "every Wednesday at 2:00pm starting 4 Nov 2026 ending 25 Nov 2026";
  const link = linkFor(current, { calendarProgressVersion: 1 });
  const state = new FakeState(link);
  const clients = fakeClients(state, scheduled, link, master, recurrenceString);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = completedDelivery("readback-mismatch", link.taskId, current, "2026-11-04T15:00:00Z");
  const parsed = JSON.parse(delivery.body);
  parsed.event_data_extra = { old_item: structuredClone(clients.tasks.get(link.taskId)) };
  delivery.body = JSON.stringify(parsed);
  clients.failures.staleReadback = true;

  await sync.process(delivery);
  assert.equal(state.links[0].activeInstanceId, current.id);
  assert.equal(state.links[0].completedThroughOriginalStart, undefined);
  assert.equal(state.mappingsByTask.get(link.taskId).activeInstanceId, current.id);
  assert.equal(state.audits.at(-1).action, "calendar_recurrence_todoist_readback_mismatch");

  await sync.process(delivery);
  assert.equal(state.links[0].activeInstanceId, "readback-nov-18");
  assert.equal(clients.tasks.get(link.taskId).due.datetime, "2026-11-18T14:00:00Z");
});
