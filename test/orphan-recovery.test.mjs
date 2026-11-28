import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarCanonicalIdentity,
  sameCanonicalIdentity,
  todoistCanonicalIdentity,
} from "../dist/canonical-identity.js";
import { profiles } from "../dist/config.js";
import { OrphanRecoveringSynchronizer } from "../dist/orphan-recovery.js";
import { serializeDeletionTombstoneComment } from "../dist/mapping-comments.js";

const HOME = profiles.home.todoistProjectId;

class FakeState {
  async syncBlocked() { return false; }
  constructor() {
    this.token = "sync-token";
    this.mappings = [];
    this.completedEvents = new Map();
    this.audits = [];
    this.mutations = 0;
  }
  async getSyncToken() { return this.token; }
  async putSyncToken(_profile, token) { this.token = token; }
  async deleteSyncToken() { this.token = undefined; }
  async getMappingByEvent(profile, eventId) {
    return this.mappings.find((mapping) => mapping.profile === profile && mapping.eventId === eventId);
  }
  async getMappingByTask(profile, taskId) {
    return this.mappings.find((mapping) => mapping.profile === profile && mapping.taskId === taskId);
  }
  async getMappingByTaskAnyProfile(taskId) {
    return this.mappings.find((mapping) => mapping.taskId === taskId);
  }
  async getCompletedCalendarProjectionByEvent(profile, eventId) {
    return this.completedEvents.get(`${profile}:${eventId}`);
  }
  async putMapping(mapping) {
    this.mappings = this.mappings.filter((existing) => !(
      existing.profile === mapping.profile
      && (existing.eventId === mapping.eventId || existing.taskId === mapping.taskId)
    ));
    this.mappings.push(structuredClone(mapping));
  }
  async deleteMapping(mapping) {
    this.mappings = this.mappings.filter((existing) => !(
      existing.profile === mapping.profile
      && existing.eventId === mapping.eventId
      && existing.taskId === mapping.taskId
    ));
  }
  async mutationAllowed() { return true; }
  async recordMutation() { this.mutations += 1; }
  async recordRecurrence() {}
  async acceptTaskVersion() { return true; }
  async getCalendarProjectionTombstone() { return undefined; }
  async deleteCalendarProjectionTombstone() {}
  async putCalendarProjectionTombstone() {}
  async putRecurrenceLink() {}
  async deleteRecurrenceLink() {}
  async getRecurrenceLink() { return undefined; }
  async listRecurrenceLinks() { return []; }
  async audit(profile, action, detail) {
    this.audits.push({ profile, action, detail });
  }
}

function timedEvent(id, summary, hour, extra = {}) {
  const hh = String(hour).padStart(2, "0");
  return {
    id,
    status: "confirmed",
    summary,
    description: "",
    start: { dateTime: `2099-09-18T${hh}:30:00+01:00`, timeZone: "Europe/London" },
    end: { dateTime: `2099-09-18T${hh}:00:00Z`, timeZone: "Europe/London" },
    ...extra,
  };
}

function timedTask(id, content, hour, extra = {}) {
  const hh = String(hour).padStart(2, "0");
  return {
    id,
    content,
    description: "",
    project_id: HOME,
    due: { datetime: `2099-09-18T${hh}:30:00+01:00`, timezone: "Europe/London" },
    updated_at: "2099-09-17T10:00:00Z",
    ...extra,
  };
}

function delivery(kind, body = "") {
  return {
    id: `${kind}-delivery`,
    kind,
    profile: "home",
    mode: "aws",
    receivedAt: "2026-09-17T10:00:00Z",
    headers: {},
    body,
  };
}

function fixture({ events = [], tasks = [] } = {}) {
  const state = new FakeState();
  const eventMap = new Map(events.map((event) => [event.id, structuredClone(event)]));
  const taskMap = new Map(tasks.map((task) => [task.id, structuredClone(task)]));
  const calendarUpserts = [];
  const todoistUpserts = [];
  let createdEvents = 0;
  let createdTasks = 0;

  const calendar = {
    async listDelta(token) {
      return { items: [...eventMap.values()].map((event) => structuredClone(event)), nextSyncToken: token ? "sync-token-next" : "snapshot-token" };
    },
    async findByTodoistTaskId(taskId) {
      return [...eventMap.values()].find((event) => event.extendedProperties?.shared?.taskId === taskId);
    },
    async getEvent(eventId) {
      const event = eventMap.get(eventId);
      if (!event) { const error = new Error("not found"); error.status = 404; throw error; }
      return structuredClone(event);
    },
    async upsertEvent(next, existingId) {
      const id = existingId || `created-event-${++createdEvents}`;
      const stored = { ...structuredClone(next), id };
      eventMap.set(id, stored);
      calendarUpserts.push({ id, existingId, event: structuredClone(stored) });
      return structuredClone(stored);
    },
    async deleteEvent() {},
    async listInstances() { return []; },
  };

  const todoist = {
    async listProjectComments() { return []; },
    async listTasks() { return [...taskMap.values()].map((task) => structuredClone(task)); },
    async getTask(taskId) {
      const task = taskMap.get(taskId);
      if (!task) { const error = new Error("not found"); error.status = 404; throw error; }
      return structuredClone(task);
    },
    async upsertTask(next, existingId) {
      const id = existingId || `created-task-${++createdTasks}`;
      const previous = taskMap.get(id) || {};
      const stored = { ...previous, ...structuredClone(next), id, project_id: previous.project_id || next.project_id || HOME };
      taskMap.set(id, stored);
      todoistUpserts.push({ id, existingId, task: structuredClone(stored) });
      return structuredClone(stored);
    },
    async findComment() { return undefined; },
    async upsertComment() { return { id: "comment-1" }; },
    async deleteComment() {},
    async deleteTask(taskId) { taskMap.delete(taskId); },
    async updateRecurringOccurrence(task) { return task; },
  };

  const clients = async () => ({ calendar, todoist });
  const sync = new OrphanRecoveringSynchronizer(state, undefined, clients);
  return { state, eventMap, taskMap, calendar, todoist, calendarUpserts, todoistUpserts, sync };
}

function tombstoneComment({profile="home",taskId,eventIds=[]}) {
  const projectId=profiles[profile].todoistProjectId;
  const createdAt=new Date().toISOString();
  return {id:"bounded-erasure-marker",project_id:projectId,
    content:serializeDeletionTombstoneComment({schemaVersion:1,profile,projectId,taskId,eventIds,
      createdAt,expiresAt:new Date(Date.parse(createdAt)+18*24*60*60*1000).toISOString()})};
}

test("historical standalone Calendar deltas bypass orphan ownership reads and preserve the sync cursor", async () => {
  const old = {
    id: "old-one-off", status: "confirmed", summary: "An old appointment", description: "",
    start: { dateTime: "2020-01-01T10:00:00Z" },
    end: { dateTime: "2020-01-01T11:00:00Z" },
  };
  const f = fixture({ events: [old] });
  let mappingReads = 0, syncControlReads = 0;
  const originalMapping = f.state.getMappingByEvent.bind(f.state);
  f.state.getMappingByEvent = async (...args) => { mappingReads++; return originalMapping(...args); };
  f.state.syncBlocked = async () => { syncControlReads++; return false; };

  await f.sync.process(delivery("calendar"));

  assert.equal(mappingReads, 0, "no orphan or delegated sync EVENT# reads for historical one-offs");
  assert.equal(syncControlReads, 0, "no per-event DynamoDB control checks for historical one-offs");
  assert.equal(f.state.token, "sync-token-next", "the whole Calendar delta must still be acknowledged");
  assert.equal(f.todoistUpserts.length, 0);
  assert.equal(f.calendarUpserts.length, 0);
  assert.equal(f.state.mappings.length, 0);
  assert.ok(f.state.audits.some((item) => item.action === "calendar_elapsed_standalone_event_ignored"));
});

test("same-profile Todoist deletion checks cross-profile correlations", async () => {
  const f=fixture();
  const profilesRequested=[];
  const clients=async profile=>{profilesRequested.push(profile);return {calendar:f.calendar,todoist:f.todoist};};
  const sync=new OrphanRecoveringSynchronizer(f.state,undefined,clients);
  await sync.process({...delivery("todoist",JSON.stringify({
    event_name:"item:deleted",
    event_data:{id:"deleted-home-task",project_id:HOME},
    event_data_extra:{old_item:{id:"deleted-home-task",project_id:HOME}},
  }))});
  assert.ok(profilesRequested.includes("work"));
  assert.ok(profilesRequested.includes("antonio"));
});

test("old recurring instance stays on the ownership path even when its end is historical", async () => {
  // The helper must never treat a historical instance as a standalone event:
  // a past exception may belong to an active series with future occurrences.
  const { ignorableElapsedStandaloneCalendarEvent } = await import("../dist/sync.js");
  const oldInstance = {
    id: "master_20200101", recurringEventId: "master", status: "confirmed",
    start: { dateTime: "2020-01-01T10:00:00Z" }, end: { dateTime: "2020-01-01T11:00:00Z" },
  };
  assert.equal(ignorableElapsedStandaloneCalendarEvent(oldInstance), false);
});

test("canonical identity treats Calendar offset time and Todoist floating wall-clock time as the same logical start", () => {
  const event = {
    id: "event",
    summary: " School Run ",
    start: { dateTime: "2026-09-18T08:30:00+01:00", timeZone: "Europe/London" },
  };
  const task = {
    id: "task",
    content: "school run",
    due: { datetime: "2026-09-18T08:30:00", timezone: "Europe/London" },
  };
  assert.equal(sameCanonicalIdentity(calendarCanonicalIdentity(event), todoistCanonicalIdentity(task)), true);
});

test("Calendar edit does not re-link a Todoist task from a previous canonical identity", async () => {
  const oldTask = timedTask("task-1", "School run", 8);
  const changedEvent = timedEvent("event-1", "School pickup", 15);
  const f = fixture({ events: [changedEvent], tasks: [oldTask] });
  await f.sync.process(delivery("calendar"));

  const mapping = await f.state.getMappingByEvent("home", changedEvent.id);
  assert.notEqual(mapping?.taskId, oldTask.id);
  assert.equal(f.todoistUpserts.length, 1);
  assert.equal(f.todoistUpserts[0].existingId, undefined);
  assert.equal(f.todoistUpserts[0].task.content, "School pickup");
  assert.equal(f.taskMap.size, 2, "similar title/date fields do not prove that an existing task is the counterpart");
});

test("Calendar previous-identity ambiguity preserves both tasks and syncs the event as a new pair", async () => {
  const old = timedTask("task-1", "School run", 8);
  const duplicate = timedTask("task-2", "School run", 8);
  const changedEvent = timedEvent("event-1", "School pickup", 15);
  const f = fixture({ events: [changedEvent], tasks: [old, duplicate] });
  await f.sync.process(delivery("calendar"));

  assert.equal(f.todoistUpserts.length, 1);
  assert.equal(f.todoistUpserts[0].existingId, undefined);
  assert.equal(f.taskMap.size, 3);
});

test("Todoist edit does not re-link a Calendar event from old_item title/date", async () => {
  const oldTask = timedTask("task-1", "Dentist", 10);
  const changedTask = timedTask("task-1", "Dental check-up", 11, { updated_at: "2026-09-17T10:05:00Z" });
  const orphanEvent = timedEvent("event-1", "Dentist", 10);
  const f = fixture({ events: [orphanEvent], tasks: [changedTask] });
  const body = JSON.stringify({
    event_name: "item:updated",
    event_data: changedTask,
    event_data_extra: { old_item: oldTask, update_intent: "item_updated" },
  });

  await f.sync.process(delivery("todoist", body));

  const mapping = await f.state.getMappingByTask("home", changedTask.id);
  assert.notEqual(mapping?.eventId, orphanEvent.id);
  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].existingId, undefined);
  assert.equal(f.calendarUpserts[0].event.summary, "Dental check-up");
  assert.equal(f.eventMap.size, 2, "similar title/date fields do not prove that an existing event is the counterpart");
});

test("worker-facing unmapped Todoist upsert ignores a stale payload when the source task is gone", async () => {
  const stalePayload = {
    event_name: "item:added",
    event_data: timedTask("purged-task", "Purged task from delayed webhook", 9),
  };
  const f = fixture();

  await f.sync.process(delivery("todoist", JSON.stringify(stalePayload)));

  assert.equal(f.calendarUpserts.length, 0, "configured-project create path must not create a Calendar projection from a stale payload");
  assert.equal(f.state.mappings.length, 0);
  assert.equal(f.state.audits.length, 0, "a deleted source should not leave new item-specific state");
});

test("worker-facing unmapped Todoist upsert uses the live task snapshot instead of stale webhook fields", async () => {
  const liveTask = timedTask("live-task", "Current Todoist title", 11, { updated_at: "2026-09-17T10:05:00Z" });
  const stalePayload = {
    event_name: "item:updated",
    event_data: timedTask("live-task", "Stale webhook title", 9, { updated_at: "2026-09-17T10:01:00Z" }),
  };
  const f = fixture({ tasks: [liveTask] });

  await f.sync.process(delivery("todoist", JSON.stringify(stalePayload)));

  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].event.summary, "Current Todoist title");
  assert.equal(f.state.mappings[0]?.taskId, "live-task");
});

test("worker-facing unmapped Todoist upsert propagates non-404 provider lookup failures without writes", async () => {
  const task = timedTask("lookup-failure-task", "Delayed task", 9);
  const f = fixture();
  f.todoist.getTask = async () => { const error = new Error("temporarily unavailable"); error.status = 503; throw error; };

  await assert.rejects(
    f.sync.process(delivery("todoist", JSON.stringify({ event_name: "item:added", event_data: task }))),
    /temporarily unavailable/,
  );
  assert.equal(f.calendarUpserts.length, 0);
  assert.equal(f.state.mappings.length, 0);
  assert.equal(f.state.audits.length, 0);
});

test("Todoist previous-identity ambiguity preserves events and syncs a new exact pair", async () => {
  const oldTask = timedTask("task-1", "Dentist", 10);
  const changedTask = timedTask("task-1", "Dental check-up", 11, { updated_at: "2026-09-17T10:05:00Z" });
  const events = [timedEvent("event-1", "Dentist", 10), timedEvent("event-2", "Dentist", 10)];
  const f = fixture({ events, tasks: [changedTask] });
  const body = JSON.stringify({
    event_name: "item:updated",
    event_data: changedTask,
    event_data_extra: { old_item: oldTask, update_intent: "item_updated" },
  });

  await f.sync.process(delivery("todoist", body));

  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].existingId, undefined);
  assert.equal(f.eventMap.size, 3);
});

test("new task with the same title/due creates its own Calendar event, not the completed event", async () => {
  const old = timedEvent("completed-event", "School run", 8, {
    extendedProperties: { shared: { taskId: "completed-task", syncSource: "todoist-calendar-sync" } },
  });
  const fresh = timedTask("new-task", "School run", 8);
  const f = fixture({ events: [old], tasks: [fresh] });
  f.state.completedEvents.set("home:completed-event", {
    profile: "home", taskId: "completed-task", eventId: "completed-event",
    completedAt: "2026-09-01T09:00:00Z",
  });
  await f.sync.process(delivery("todoist", JSON.stringify({ event_name: "item:added", event_data: fresh })));
  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].existingId, undefined);
  assert.equal(f.state.mappings[0]?.taskId, fresh.id);
  assert.notEqual(f.state.mappings[0]?.eventId, old.id);
  assert.deepEqual(f.eventMap.get(old.id), old);
});

test("even if the completed Calendar event lost shared metadata, its permanent guard blocks canonical rebinding", async () => {
  const old = timedEvent("completed-event", "School run", 8);
  const fresh = timedTask("new-task", "School run", 8);
  const f = fixture({ events: [old], tasks: [fresh] });
  f.state.completedEvents.set("home:completed-event", {
    profile: "home", taskId: "completed-task", eventId: "completed-event",
    completedAt: "2026-09-01T09:00:00Z",
  });
  await f.sync.process(delivery("todoist", JSON.stringify({ event_name: "item:added", event_data: fresh })));
  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].existingId, undefined);
  assert.notEqual(f.state.mappings[0]?.eventId, old.id);
  assert.deepEqual(f.eventMap.get(old.id), old);
});

test("a stale completed task update cannot rebind a lifecycle-retired mapping", async () => {
  const old = timedEvent("completed-event", "School run", 8, {
    extendedProperties: { shared: { taskId: "completed-task" } },
  });
  const sameId = timedTask("completed-task", "School run", 8);
  const f = fixture({ events: [old], tasks: [sameId] });
  f.state.completedEvents.set("home:completed-event", {
    profile: "home", taskId: sameId.id, eventId: old.id,
    completedAt: "2026-09-01T09:00:00Z",
  });
  await f.sync.process(delivery("todoist", JSON.stringify({ event_name: "item:updated", event_data: sameId })));
  assert.equal(f.state.mappings.length, 0);
  assert.equal(f.calendarUpserts.length, 0);
  assert.deepEqual(f.eventMap.get(old.id), old);
});

test("an explicitly added task never reuses an unrelated Calendar orphan on matching title and date", async () => {
  const existing = timedEvent("unrelated-calendar-event", "School run", 8);
  const fresh = timedTask("brand-new-task", "School run", 8);
  const f = fixture({ events: [existing], tasks: [fresh] });
  await f.sync.process(delivery("todoist", JSON.stringify({ event_name: "item:added", event_data: fresh })));
  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].existingId, undefined);
  assert.notEqual(f.calendarUpserts[0].id, existing.id);
  assert.deepEqual(f.eventMap.get(existing.id), existing);
});
