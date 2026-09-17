import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarCanonicalIdentity,
  sameCanonicalIdentity,
  todoistCanonicalIdentity,
} from "../dist/canonical-identity.js";
import { profiles } from "../dist/config.js";
import { OrphanRecoveringSynchronizer } from "../dist/orphan-recovery.js";

const HOME = profiles.home.todoistProjectId;

class FakeIdentityStore {
  constructor() {
    this.values = new Map();
  }
  key(profile, side, providerId) {
    return `${profile}:${side}:${providerId}`;
  }
  async get(profile, side, providerId) {
    const identity = this.values.get(this.key(profile, side, providerId));
    return identity ? { profile, side, providerId, identity, updatedAt: new Date().toISOString() } : undefined;
  }
  async put(profile, side, providerId, identity) {
    this.values.set(this.key(profile, side, providerId), structuredClone(identity));
  }
}

class FakeState {
  constructor() {
    this.token = "sync-token";
    this.mappings = [];
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
    start: { dateTime: `2026-09-18T${hh}:30:00+01:00`, timeZone: "Europe/London" },
    end: { dateTime: `2026-09-18T${hh}:00:00Z`, timeZone: "Europe/London" },
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
    due: { datetime: `2026-09-18T${hh}:30:00+01:00`, timezone: "Europe/London" },
    updated_at: "2026-09-17T10:00:00Z",
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
  const identities = new FakeIdentityStore();
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
  const sync = new OrphanRecoveringSynchronizer(state, undefined, clients, identities);
  return { state, identities, eventMap, taskMap, calendarUpserts, todoistUpserts, sync };
}

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

test("Calendar edit re-links the unique Todoist task matching the previous canonical identity and updates it", async () => {
  const oldTask = timedTask("task-1", "School run", 8);
  const changedEvent = timedEvent("event-1", "School pickup", 15);
  const f = fixture({ events: [changedEvent], tasks: [oldTask] });
  await f.identities.put("home", "calendar", changedEvent.id, todoistCanonicalIdentity(oldTask));

  await f.sync.process(delivery("calendar"));

  const mapping = await f.state.getMappingByEvent("home", changedEvent.id);
  assert.equal(mapping?.taskId, oldTask.id);
  assert.equal(f.todoistUpserts.length, 1);
  assert.equal(f.todoistUpserts[0].existingId, oldTask.id);
  assert.equal(f.todoistUpserts[0].task.content, "School pickup");
  assert.equal(f.taskMap.size, 1, "must update the orphan rather than create a duplicate task");
  assert.ok(f.state.audits.some((entry) => entry.action === "calendar_orphan_todoist_rebound_previous_identity"));
});

test("Calendar previous-identity ambiguity is blocked instead of creating a Todoist duplicate", async () => {
  const old = timedTask("task-1", "School run", 8);
  const duplicate = timedTask("task-2", "School run", 8);
  const changedEvent = timedEvent("event-1", "School pickup", 15);
  const f = fixture({ events: [changedEvent], tasks: [old, duplicate] });
  await f.identities.put("home", "calendar", changedEvent.id, todoistCanonicalIdentity(old));

  await f.sync.process(delivery("calendar"));

  assert.equal(f.todoistUpserts.length, 0);
  assert.equal(f.taskMap.size, 2);
  const audit = f.state.audits.find((entry) => entry.action === "calendar_snapshot_unmapped_ambiguous");
  assert.deepEqual(audit?.detail.candidateTaskIds, ["task-1", "task-2"]);
  assert.equal(audit?.detail.source, "webhook_previous_identity");
});

test("Todoist edit re-links the unique Calendar event matching old_item and updates that event", async () => {
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
  assert.equal(mapping?.eventId, orphanEvent.id);
  assert.equal(f.calendarUpserts.length, 1);
  assert.equal(f.calendarUpserts[0].existingId, orphanEvent.id);
  assert.equal(f.calendarUpserts[0].event.summary, "Dental check-up");
  assert.equal(f.eventMap.size, 1, "must update the orphan rather than create a duplicate Calendar event");
  assert.ok(f.state.audits.some((entry) => entry.action === "todoist_orphan_calendar_rebound_previous_identity"));
});

test("Todoist previous-identity ambiguity performs no Calendar mutation", async () => {
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

  assert.equal(f.calendarUpserts.length, 0);
  assert.equal(f.eventMap.size, 2);
  const audit = f.state.audits.find((entry) => entry.action === "todoist_orphan_recovery_ambiguous");
  assert.deepEqual(audit?.detail.candidateEventIds, ["event-1", "event-2"]);
  assert.equal(audit?.detail.source, "webhook_old_item");
});
