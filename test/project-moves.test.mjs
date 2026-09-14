import assert from "node:assert/strict";
import test from "node:test";
import { profiles, profileForTodoistProject, rememberTodoistTokenProject } from "../dist/config.js";
import { Todoist } from "../dist/providers.js";
import { ProjectAwareSynchronizer, todoistProjectTransition } from "../dist/project-sync.js";

const HOME = profiles.home.todoistProjectId;
const WORK = profiles.work.todoistProjectId;
const ANTONIO = profiles.antonio.todoistProjectId;

test("maps configured Todoist projects to Calendar profiles", () => {
  assert.equal(profileForTodoistProject(HOME), "home");
  assert.equal(profileForTodoistProject(WORK), "work");
  assert.equal(profileForTodoistProject(ANTONIO), "antonio");
  assert.equal(profileForTodoistProject("inbox-project"), undefined);
});

test("classifies Todoist project membership transitions", () => {
  assert.deepEqual(todoistProjectTransition("inbox", "other"), { action: "skip" });
  assert.deepEqual(todoistProjectTransition("inbox", HOME), { action: "create_projection", toProfile: "home" });
  assert.deepEqual(todoistProjectTransition(HOME, "inbox"), { action: "delete_projection", fromProfile: "home" });
  assert.deepEqual(todoistProjectTransition(HOME, HOME), { action: "upsert_projection", fromProfile: "home", toProfile: "home" });
  assert.deepEqual(todoistProjectTransition(HOME, WORK), { action: "move_projection", fromProfile: "home", toProfile: "work" });
  assert.deepEqual(todoistProjectTransition(WORK, ANTONIO), { action: "move_projection", fromProfile: "work", toProfile: "antonio" });
  assert.deepEqual(todoistProjectTransition(undefined, WORK, "home"), { action: "move_projection", fromProfile: "home", toProfile: "work" });
});

test("Todoist project-scoped list requests filter out Inbox/unrelated tasks", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  rememberTodoistTokenProject("home-token", HOME);
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ results: [], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const todoist = new Todoist("home-token");
    await todoist.listTasks();
    assert.match(urls[0], new RegExp(`project_id=${encodeURIComponent(HOME)}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Todoist task creation sends project_id but updates do not move projects", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  rememberTodoistTokenProject("token", HOME);
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ id: calls.length === 1 ? "new-task" : "existing", content: "Task", project_id: HOME }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const todoist = new Todoist("token");
    await todoist.upsertTask({ content: "Task", project_id: HOME, due: { date: "2026-09-01" } });
    await todoist.upsertTask({ content: "Task", project_id: WORK, due: { date: "2026-09-02" } }, "existing");
    assert.equal(calls[0].body.project_id, HOME);
    assert.equal(calls[1].body.project_id, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class FakeState {
  constructor(mapping) {
    this.mapping = mapping;
    this.tombstones = new Map();
    this.versions = new Map();
    this.audits = [];
    this.operations = [];
    this.recurrenceLinks = [];
  }
  async getMappingByTaskAnyProfile() { return this.mapping; }
  async getMappingByTask(profile) { return this.mapping?.profile === profile ? this.mapping : undefined; }
  async getMappingByEvent(profile, eventId) { return this.mapping?.profile === profile && this.mapping?.eventId === eventId ? this.mapping : undefined; }
  async acceptTaskVersion(_profile, taskId, updatedAt, deliveryId) {
    if (!updatedAt) return true;
    const old = this.versions.get(taskId);
    if (old && (old.updatedAt > updatedAt || (old.updatedAt === updatedAt && old.deliveryId !== deliveryId))) return false;
    this.versions.set(taskId, { updatedAt, deliveryId });
    return true;
  }
  async mutationAllowed() { return true; }
  async getCalendarProjectionTombstone(profile, taskId) { return this.tombstones.get(`${profile}:${taskId}`); }
  async putCalendarProjectionTombstone(profile, taskId, sourceUpdatedAt) {
    this.operations.push(`tombstone:${profile}:${taskId}`);
    this.tombstones.set(`${profile}:${taskId}`, { sourceUpdatedAt });
  }
  async deleteCalendarProjectionTombstone(profile, taskId) {
    this.operations.push(`delete-tombstone:${profile}:${taskId}`);
    this.tombstones.delete(`${profile}:${taskId}`);
  }
  async putMapping(mapping) {
    this.operations.push(`put-mapping:${mapping.profile}:${mapping.eventId}`);
    this.mapping = mapping;
  }
  async deleteMapping(mapping) {
    this.operations.push(`delete-mapping:${mapping.profile}:${mapping.eventId}`);
    if (this.mapping?.profile === mapping.profile && this.mapping?.eventId === mapping.eventId) this.mapping = undefined;
  }
  async putRecurrenceLink(link) {
    this.operations.push(`put-recurrence:${link.profile}:${link.seriesId}`);
    this.recurrenceLinks = this.recurrenceLinks.filter((item) => !(item.profile === link.profile && item.seriesId === link.seriesId));
    this.recurrenceLinks.push(link);
  }
  async deleteRecurrenceLink(profile, seriesId) {
    this.operations.push(`delete-recurrence:${profile}:${seriesId}`);
    this.recurrenceLinks = this.recurrenceLinks.filter((item) => !(item.profile === profile && item.seriesId === seriesId));
  }
  async recordRecurrence() {}
  async recordMutation(profile) { this.operations.push(`mutation:${profile}`); }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

function fakeClients(currentTask, calendars) {
  return async (profile) => ({
    calendar: {
      async getEvent(id) {
        const direct = calendars[profile].events.get(id);
        const instance = [...calendars[profile].instances.values()].flat().find((event) => event.id === id);
        const found = direct || instance;
        if (found) return found;
        const error = new Error(`Calendar event ${id} not found`);
        error.status = 404;
        throw error;
      },
      async findByTodoistTaskId(taskId) {
        return [
          ...calendars[profile].events.values(),
          ...[...calendars[profile].instances.values()].flat(),
        ].find((event) => event.extendedProperties?.shared?.taskId === taskId);
      },
      async deleteEvent(id) {
        calendars[profile].deleted.push(id);
        calendars[profile].events.delete(id);
        calendars[profile].instances.delete(id);
      },
      async upsertEvent(event, existingId) {
        const id = existingId || `${profile}-event-${calendars[profile].created.length + 1}`;
        const stored = { ...event, id, htmlLink: `https://calendar/${id}` };
        if (event.recurrence?.length) {
          stored.iCalUID = stored.iCalUID || `${profile}-ical-${id}`;
          const instance = {
            id: `${id}-instance`,
            status: "confirmed",
            summary: event.summary,
            description: event.description,
            start: event.start,
            end: event.end,
            recurringEventId: id,
            iCalUID: stored.iCalUID,
            originalStartTime: event.start,
            extendedProperties: event.extendedProperties,
            htmlLink: `https://calendar/${id}-instance`,
          };
          calendars[profile].instances.set(id, [instance]);
        }
        calendars[profile].events.set(id, stored);
        calendars[profile].created.push(id);
        return stored;
      },
      async listInstances(masterEventId) { return calendars[profile].instances.get(masterEventId) || []; },
    },
    todoist: {
      async getTask() { return currentTask.value; },
      async upsertComment() { return { id: `${profile}-comment` }; },
      async deleteComment() {},
      async findComment() { return undefined; },
      async listTasks() { return []; },
      async upsertTask(task) { return { id: "created-task", ...task }; },
      async deleteTask() {},
      async updateRecurringOccurrence(task) { return task; },
    },
  });
}

function calendarSet() {
  return {
    home: { events: new Map(), instances: new Map(), created: [], deleted: [] },
    work: { events: new Map(), instances: new Map(), created: [], deleted: [] },
    antonio: { events: new Map(), instances: new Map(), created: [], deleted: [] },
  };
}

function delivery(id, task, oldTask) {
  return {
    id,
    kind: "todoist",
    profile: "home",
    mode: "aws",
    receivedAt: "2026-09-03T12:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:updated", event_data: task, ...(oldTask ? { event_data_extra: { old_item: oldTask } } : {}) }),
  };
}

test("Inbox -> mapped creates exactly one destination Calendar projection", async () => {
  const task = { id: "task-1", project_id: HOME, content: "Task", due: { date: "2026-09-05" }, updated_at: "2026-09-03T10:00:00Z" };
  const currentTask = { value: task };
  const calendars = calendarSet();
  const state = new FakeState();
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients(currentTask, calendars));
  await sync.process(delivery("d1", task, { ...task, project_id: "inbox" }));
  assert.deepEqual(calendars.home.created, ["home-event-1"]);
  assert.equal(calendars.work.created.length, 0);
  assert.equal(state.mapping?.profile, "home");
  assert.equal(state.mapping?.projectId, HOME);
});

test("mapped -> Inbox deletes the old projection and does not create another", async () => {
  const previous = { id: "task-2", project_id: HOME, content: "Task", due: { date: "2026-09-05" }, updated_at: "2026-09-03T09:00:00Z" };
  const task = { ...previous, project_id: "inbox", updated_at: "2026-09-03T10:00:00Z" };
  const calendars = calendarSet();
  calendars.home.events.set("home-existing", { id: "home-existing", summary: "Task", start: { date: "2026-09-05" }, extendedProperties: { shared: { taskId: task.id } } });
  const state = new FakeState({ profile: "home", projectId: HOME, eventId: "home-existing", taskId: task.id, updatedAt: "2026-09-03T09:00:00Z" });
  const currentTask = { value: task };
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients(currentTask, calendars));
  await sync.process(delivery("d2", task, previous));
  assert.deepEqual(calendars.home.deleted, ["home-existing"]);
  assert.equal(calendars.work.created.length, 0);
  assert.equal(state.mapping, undefined);
  assert.ok(state.tombstones.has(`home:${task.id}`));
  assert.ok(state.operations.indexOf(`tombstone:home:${task.id}`) < state.operations.indexOf("delete-mapping:home:home-existing"));
});

test("mapped Home -> Work migrates the projection without recreating the Todoist task", async () => {
  const previous = { id: "task-3", project_id: HOME, content: "Move me", due: { date: "2026-09-06" }, updated_at: "2026-09-03T09:00:00Z" };
  const task = { ...previous, project_id: WORK, updated_at: "2026-09-03T10:00:00Z" };
  const calendars = calendarSet();
  calendars.home.events.set("home-existing", { id: "home-existing", summary: "Move me", start: { date: "2026-09-06" }, extendedProperties: { shared: { taskId: task.id } } });
  const state = new FakeState({ profile: "home", projectId: HOME, eventId: "home-existing", taskId: task.id, updatedAt: "2026-09-03T09:00:00Z" });
  const currentTask = { value: task };
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients(currentTask, calendars));
  await sync.process(delivery("d3", task, previous));
  assert.deepEqual(calendars.home.deleted, ["home-existing"]);
  assert.deepEqual(calendars.work.created, ["work-event-1"]);
  assert.equal(state.mapping?.profile, "work");
  assert.equal(state.mapping?.taskId, task.id);
  assert.equal(state.mapping?.projectId, WORK);
});

test("mapped Home -> Work migration is not suppressed when Todoist retains updated_at", async () => {
  const previous = { id: "task-3-unchanged-version", project_id: HOME, content: "Move me", due: { date: "2026-09-06" }, updated_at: "2026-09-03T09:00:00Z" };
  const task = { ...previous, project_id: WORK };
  const calendars = calendarSet();
  calendars.home.events.set("home-existing", { id: "home-existing", summary: "Move me", start: { date: "2026-09-06" }, extendedProperties: { shared: { taskId: task.id } } });
  const state = new FakeState({ profile: "home", projectId: HOME, eventId: "home-existing", taskId: task.id, updatedAt: previous.updated_at });
  await state.acceptTaskVersion("home", task.id, task.updated_at, "create-delivery");
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients({ value: task }, calendars));
  await sync.process(delivery("move-delivery", task, previous));
  assert.deepEqual(calendars.home.deleted, ["home-existing"]);
  assert.deepEqual(calendars.work.created, ["work-event-1"]);
  assert.equal(state.mapping?.profile, "work");
  assert.equal(state.mapping?.taskId, task.id);
  assert.equal(state.audits.some((audit) => audit.action === "todoist_stale_project_move_suppressed"), false);
});

test("project move plus due removal deletes source but creates no destination projection", async () => {
  const previous = { id: "task-4", project_id: HOME, content: "Move undated", due: { date: "2026-09-06" }, updated_at: "2026-09-03T09:00:00Z" };
  const task = { ...previous, project_id: WORK, due: null, updated_at: "2026-09-03T10:00:00Z" };
  const calendars = calendarSet();
  calendars.home.events.set("home-existing", { id: "home-existing", summary: "Move undated", start: { date: "2026-09-06" }, extendedProperties: { shared: { taskId: task.id } } });
  const state = new FakeState({ profile: "home", projectId: HOME, eventId: "home-existing", taskId: task.id, updatedAt: "2026-09-03T09:00:00Z" });
  const currentTask = { value: task };
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients(currentTask, calendars));
  await sync.process(delivery("d4", task, previous));
  assert.deepEqual(calendars.home.deleted, ["home-existing"]);
  assert.equal(calendars.work.created.length, 0);
  assert.equal(state.mapping, undefined);
});

test("due re-add without updated_at can recreate a tombstoned mapped projection", async () => {
  const previous = { id: "task-5", project_id: "inbox", content: "Re-add due", due: null };
  const task = { ...previous, project_id: HOME, due: { date: "2026-09-08" } };
  const calendars = calendarSet();
  const state = new FakeState();
  state.tombstones.set(`home:${task.id}`, { sourceUpdatedAt: "2026-09-03T10:00:00Z" });
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients({ value: task }, calendars));
  await sync.process(delivery("d5", task, previous));
  assert.deepEqual(calendars.home.created, ["home-event-1"]);
  assert.equal(state.mapping?.profile, "home");
  assert.equal(state.tombstones.has(`home:${task.id}`), false);
});

test("destination tombstone suppression still removes the source projection", async () => {
  const previous = { id: "task-6", project_id: HOME, content: "Stale destination", due: { date: "2026-09-09" } };
  const task = { ...previous, project_id: WORK };
  const calendars = calendarSet();
  calendars.home.events.set("home-existing", { id: "home-existing", summary: task.content, start: { date: "2026-09-09" }, extendedProperties: { shared: { taskId: task.id } } });
  const state = new FakeState({ profile: "home", projectId: HOME, eventId: "home-existing", taskId: task.id, updatedAt: "2026-09-03T09:00:00Z" });
  state.tombstones.set(`work:${task.id}`, { sourceUpdatedAt: "2026-09-03T10:00:00Z" });
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients({ value: task }, calendars));
  await sync.process(delivery("d6", task, previous));
  assert.deepEqual(calendars.home.deleted, ["home-existing"]);
  assert.deepEqual(calendars.work.created, []);
  assert.equal(state.mapping, undefined);
  assert.ok(state.tombstones.has(`home:${task.id}`));
});

test("Calendar-owned recurrence moves its master series and active-instance mapping", async () => {
  const previous = { id: "task-7", project_id: HOME, content: "Weekly task", due: { date: "2026-09-10" }, updated_at: "2026-09-03T09:00:00Z" };
  const task = { ...previous, project_id: WORK, updated_at: "2026-09-03T10:00:00Z" };
  const calendars = calendarSet();
  calendars.home.events.set("home-master", {
    id: "home-master",
    summary: task.content,
    start: { date: "2026-09-10" },
    end: { date: "2026-09-11" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
    iCalUID: "home-series",
  });
  const mapping = {
    profile: "home",
    projectId: HOME,
    eventId: "home-instance",
    taskId: task.id,
    commentId: "home-comment",
    recurrenceOwner: "calendar",
    seriesId: "home-series",
    masterEventId: "home-master",
    activeInstanceId: "home-instance",
    originalStart: "2026-09-10",
    activeEffectiveStart: "2026-09-10",
    updatedAt: "2026-09-03T09:00:00Z",
  };
  const state = new FakeState(mapping);
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients({ value: task }, calendars));
  await sync.process(delivery("d7", task, previous));
  assert.deepEqual(calendars.home.deleted, ["home-master"]);
  assert.deepEqual(calendars.work.created, ["work-event-1"]);
  assert.equal(state.mapping?.profile, "work");
  assert.equal(state.mapping?.recurrenceOwner, "calendar");
  assert.equal(state.mapping?.masterEventId, "work-event-1");
  assert.equal(state.mapping?.eventId, "work-event-1-instance");
  assert.equal(state.mapping?.activeEffectiveStart, "2026-09-10");
  assert.ok(state.recurrenceLinks.some((link) => link.profile === "work" && link.owner === "calendar"));
  assert.ok(state.operations.indexOf(`tombstone:home:${task.id}`) < state.operations.indexOf("delete-mapping:home:home-instance"));
});

test("Todoist-owned RRULE move binds the destination master and current instance separately", async () => {
  const previous = {
    id: "task-rrule-move",
    project_id: HOME,
    content: "Daily recurring",
    description: "",
    due: { date: "2026-09-12", string: "every day", is_recurring: true },
    updated_at: "2026-09-03T09:00:00Z",
  };
  const task = { ...previous, project_id: WORK, updated_at: "2026-09-03T10:00:00Z" };
  const calendars = calendarSet();
  calendars.home.events.set("home-rrule-master", {
    id: "home-rrule-master",
    summary: task.content,
    description: "",
    start: { date: "2026-09-12" },
    end: { date: "2026-09-13" },
    recurrence: ["RRULE:FREQ=DAILY"],
    extendedProperties: { shared: { taskId: task.id, syncRecurrenceOwner: "todoist", todoistRecurrence: "every day" } },
  });
  const mapping = {
    profile: "home",
    projectId: HOME,
    eventId: "home-rrule-master",
    taskId: task.id,
    recurrenceOwner: "todoist",
    seriesId: task.id,
    masterEventId: "home-rrule-master",
    activeInstanceId: "home-rrule-instance",
    originalStart: "2026-09-12",
    activeEffectiveStart: "2026-09-12",
    updatedAt: previous.updated_at,
  };
  const state = new FakeState(mapping);
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients({ value: task }, calendars));

  await sync.process(delivery("rrule-move", task, previous));

  assert.deepEqual(calendars.home.deleted, ["home-rrule-master"]);
  assert.deepEqual(calendars.work.created, ["work-event-1"]);
  assert.equal(state.mapping?.profile, "work");
  assert.equal(state.mapping?.recurrenceOwner, "todoist");
  assert.equal(state.mapping?.eventId, "work-event-1");
  assert.equal(state.mapping?.masterEventId, "work-event-1");
  assert.equal(state.mapping?.activeInstanceId, "work-event-1-instance");
  assert.equal(state.mapping?.originalStart, "2026-09-12");
  assert.equal(state.mapping?.activeEffectiveStart, "2026-09-12");
  assert.ok(state.recurrenceLinks.some((link) => link.profile === "work" && link.owner === "todoist" && link.activeInstanceId === "work-event-1-instance"));
});

test("moved orphan writes a source tombstone before dropping ownership mapping", async () => {
  const task = { id: "task-8", project_id: WORK, content: "Moved orphan", due: { date: "2026-09-11" }, updated_at: "2026-09-03T10:00:00Z" };
  const mapping = { profile: "home", projectId: HOME, eventId: "home-orphan", taskId: task.id, updatedAt: "2026-09-03T09:00:00Z" };
  const calendars = calendarSet();
  const state = new FakeState(mapping);
  const sync = new ProjectAwareSynchronizer(state, undefined, fakeClients({ value: task }, calendars));
  await sync.process({
    id: "orphan-delivery",
    kind: "orphan",
    profile: "home",
    mode: "aws",
    receivedAt: "2026-09-03T12:00:00Z",
    headers: {},
    body: "",
    orphan: { eventId: "home-orphan", taskId: task.id, attempt: 2 },
  });
  assert.ok(state.tombstones.has(`home:${task.id}`));
  assert.equal(state.mapping, undefined);
  assert.ok(state.operations.indexOf(`tombstone:home:${task.id}`) < state.operations.indexOf("delete-mapping:home:home-orphan"));
});
