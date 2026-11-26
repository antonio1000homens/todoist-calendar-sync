import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { mappingFromProjectMappingComment, parseMappingComment, serializeMappingComment } from "../dist/mapping-comments.js";
import { nativeRecurrenceShape, Synchronizer, selectCalendarRecurrenceInstance, toCalendarEvent } from "../dist/sync.js";
import { selectNextEffectiveTodoistInstance } from "../dist/todoist-recurrence.js";
import { providerSyncBaseline } from "../dist/provider-sync-baseline.js";

const PROFILE = "home";
const MASTER = "calendar-master";
const SERIES = "calendar-series";

test("Calendar progress metadata takes precedence when recurrence provider IDs coincide", () => {
  const mapping = { taskId: "same-provider-id", seriesId: "same-provider-id", calendarProgressVersion: 1 };
  assert.equal(nativeRecurrenceShape(mapping), "calendar");
  assert.notEqual(nativeRecurrenceShape(mapping), "todoist");
  assert.equal(nativeRecurrenceShape({ taskId: "todoist-task", seriesId: "todoist-task" }), "todoist");
  assert.equal(nativeRecurrenceShape({ taskId: "todoist-task", seriesId: "calendar-series" }), "calendar");
  assert.equal(nativeRecurrenceShape({ taskId: "todoist-task", seriesId: "todoist-task", recurrenceOwner: "calendar" }), "todoist");
  assert.equal(nativeRecurrenceShape({ taskId: "todoist-task", seriesId: "calendar-series", recurrenceOwner: "todoist" }), "calendar");
});

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
    ...(link.syncedTitle !== undefined ? { syncedTitle: link.syncedTitle } : {}),
    ...(link.syncedDescription !== undefined ? { syncedDescription: link.syncedDescription } : {}),
    ...(link.calendarProgressVersion === 1 ? { calendarProgressVersion: 1 } : {}),
    ...(link.todoistPhaseBVersion === 1 ? { todoistPhaseBVersion: 1 } : {}),
    ...(link.completedThroughOriginalStart ? { completedThroughOriginalStart: link.completedThroughOriginalStart } : {}),
    updatedAt: link.updatedAt,
  };
}

class FakeState {
  async syncBlocked() { return false; }
  async getMappingByTaskAnyProfile(taskId) { return this.mappingsByTask.get(taskId); }
  constructor(link) {
    this.operations = [];
    this.audits = [];
    this.tombstones = [];
    this.completedProjections = [];
    this.canonicalByEvent = new Set();
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

  async updateCalendarOwnedMetadataIfUnchanged(previous, link, mapping) {
    const current = this.mappingsByTask.get(previous.taskId);
    const currentLink = this.links.find(item => item.profile === previous.profile && item.seriesId === previous.seriesId);
    if (!current || !currentLink || current.updatedAt !== previous.updatedAt
      || current.eventId !== previous.eventId || currentLink.updatedAt !== link.updatedAt
      || currentLink.eventId !== previous.eventId) return false;
    this.storeMapping(mapping);
    this.links = this.links.filter(item => !(item.profile === link.profile && item.seriesId === link.seriesId));
    this.links.push({ ...structuredClone(link), syncedTitle: mapping.syncedTitle,
      syncedDescription: mapping.syncedDescription, updatedAt: mapping.updatedAt });
    return true;
  }
  async advanceCalendarSeriesMapping({ previous, mapping, link }) {
    const active = this.mappingsByTask.get(previous.taskId);
    const recurrence = this.links.find((item) => item.profile === previous.profile && item.seriesId === previous.seriesId);
    if (active?.eventId !== previous.eventId || recurrence?.eventId !== previous.eventId) return false;
    this.operations.push(`advance-mapping:${mapping.taskId}:${mapping.eventId}`);
    this.mappingsByEvent.delete(previous.eventId);
    if (previous.taskId !== mapping.taskId) this.mappingsByTask.delete(previous.taskId);
    this.storeMapping(mapping);
    this.links = this.links.filter((item) => !(item.profile === link.profile && item.seriesId === link.seriesId));
    this.links.push(structuredClone(link));
    return true;
  }

  async deleteMapping(mapping) {
    this.operations.push(`delete-mapping:${mapping.taskId}:${mapping.eventId}`);
    if (this.mappingsByTask.get(mapping.taskId)?.eventId === mapping.eventId) this.mappingsByTask.delete(mapping.taskId);
    if (this.mappingsByEvent.get(mapping.eventId)?.taskId === mapping.taskId) this.mappingsByEvent.delete(mapping.eventId);
  }

  async purgeEarlierCancelledCalendarOccurrence(link, occurrenceId, staleMapping) {
    const active = this.mappingsByEvent.get(link.activeInstanceId);
    if (!active || active.taskId !== link.taskId || active.seriesId !== link.seriesId
      || active.masterEventId !== link.masterEventId || occurrenceId === link.activeInstanceId) return false;
    const old = this.mappingsByEvent.get(occurrenceId);
    if ((old && (!staleMapping || staleMapping.eventId !== old.eventId
      || staleMapping.taskId !== old.taskId)) || (!old && !this.canonicalByEvent.has(occurrenceId))) return false;
    this.mappingsByEvent.delete(occurrenceId);
    if (old?.taskId !== link.taskId && this.mappingsByTask.get(old?.taskId)?.eventId === occurrenceId) {
      this.mappingsByTask.delete(old.taskId);
    }
    this.canonicalByEvent.delete(occurrenceId);
    this.operations.push(`purge-earlier:${occurrenceId}`);
    return true;
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
  async getCompletedCalendarProjectionByEvent(profile, eventId) { return this.completedProjections.find((item) => item.profile === profile && item.eventId === eventId); }
  async listCompletedCalendarProjectionsByTask(profile, taskId) { return this.completedProjections.filter((item) => item.profile === profile && item.taskId === taskId); }
  async putCompletedCalendarProjection(projection) {
    const index = this.completedProjections.findIndex((item) => item.profile === projection.profile && item.eventId === projection.eventId);
    if (index >= 0) this.completedProjections[index] = structuredClone(projection); else this.completedProjections.push(structuredClone(projection));
  }
  async deleteCompletedCalendarProjection(projection) {
    this.completedProjections = this.completedProjections.filter((item) => !(item.profile === projection.profile && item.eventId === projection.eventId));
  }
  async getSyncToken() { return "sync-token"; }
  async putSyncToken() {}
  async deleteSyncToken() {}

  async audit(_profile, action, detail) {
    this.audits.push({ action, detail });
  }
}

function fakeClients(state, instances, tasks = new Map(), deltaEvent, extraEvents = []) {
  let created = 0;
  const createdByRequest = new Map();
  const calendarDeletes = [];
  const calendarUpserts = [];
  const todoistDeletes = [];
  const todoistUpserts = [];
  const todoistRecurringUpdates = [];
  const projectComments = [];
  const mirrorProviderMapping = (content) => {
    const parsed = parseMappingComment({ id: "provider-mapping", project_id: profiles[PROFILE].todoistProjectId, content });
    if (!parsed || "error" in parsed) return;
    const mapping = mappingFromProjectMappingComment(parsed);
    const previous = state.mappingsByTask.get(mapping.taskId);
    state.storeMapping(mapping);
    if (mapping.seriesId) {
      const link = {
        profile: mapping.profile, owner: mapping.seriesId === mapping.taskId ? "todoist" : "calendar", seriesId: mapping.seriesId,
        masterEventId: mapping.masterEventId, activeInstanceId: mapping.activeInstanceId,
        originalStart: mapping.originalStart, activeEffectiveStart: mapping.activeEffectiveStart,
        calendarProgressVersion: mapping.calendarProgressVersion,
        completedThroughOriginalStart: mapping.completedThroughOriginalStart,
        taskId: mapping.taskId, eventId: mapping.eventId, updatedAt: mapping.updatedAt,
      };
      state.links = state.links.filter(item => !(item.profile === link.profile && item.seriesId === link.seriesId));
      state.links.push(link);
      if (previous && previous.activeInstanceId !== mapping.activeInstanceId && mapping.completedThroughOriginalStart)
        state.operations.push({ action: "advance-mapping", link: structuredClone(link) });
    }
  };
  const initialLink = state.links?.find(link => link.profile === PROFILE);
  if (initialLink) {
    const projectId = profiles[PROFILE].todoistProjectId;
    const initialMapping = { ...mappingFromLink(initialLink), projectId, calendarId: profiles[PROFILE].calendarId, mappingRevision: 1 };
    let content = serializeMappingComment(initialMapping, projectId);
    if (!initialMapping.calendarProgressVersion && !initialMapping.todoistPhaseBVersion && initialMapping.recurrenceOwner) {
      const [marker, payload] = content.split("\n");
      content = `${marker}\n${JSON.stringify({ ...JSON.parse(payload), recurrenceOwner: initialMapping.recurrenceOwner })}`;
    }
    projectComments.push({ id: "provider-mapping", project_id: projectId, content });
  }
  const events = new Map();
  for (const event of [...instances, ...extraEvents, ...(deltaEvent ? [deltaEvent] : [])]) {
    events.set(event.id, structuredClone(event));
  }
  if (!events.has(MASTER)) {
    events.set(MASTER, {
      id: MASTER, status: "confirmed", start: { date: "2026-09-06" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
  }
  const calendar = {
    async getTimeZone() { return "Europe/London"; },
    async listInstances() { return instances.map((event) => structuredClone(event)); },
    async listInstancesInWindow(_id, _start, _end) {
      // Legacy fixtures use dates decades ahead to prove progression independently
      // of wall clock time; bounded API arguments are tested separately.
      return instances.map((event) => structuredClone(event));
    },
    async listExplicitSeriesExceptions(masterId) {
      const master = events.get(masterId);
      if (!master) return [];
      const value = item => item?.dateTime || item?.date;
      const duration = item => {
        const start = value(item.start); const end = value(item.end);
        return start && end ? Date.parse(end) - Date.parse(start) : undefined;
      };
      return instances.filter(item => item.recurringEventId === masterId && (
        item.status === "cancelled"
        || value(item.originalStartTime) !== value(item.start)
        || item.summary !== master.summary
        || (item.description || "") !== (master.description || "")
        || (duration(master) !== undefined && duration(item) !== duration(master))
      )).map(item => structuredClone(item));
    },
    async listDelta() {
      return { items: deltaEvent ? [structuredClone(deltaEvent)] : [], nextSyncToken: "sync-next" };
    },
    async deleteEvent(id) {
      calendarDeletes.push(id);
      events.delete(id);
    },
    async patchEventMetadataIfUnchanged(id, etag, metadata) {
      const master = events.get(id);
      if (!master || master.etag !== etag) throw Object.assign(new Error("stale master"), { status: 412 });
      const next = { ...master, ...structuredClone(metadata), etag: `etag-${calendarUpserts.length + 1}` };
      events.set(id, next);
      calendarUpserts.push({ id, metadataOnly: true, metadata: structuredClone(metadata) });
      return structuredClone(next);
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
    async ensureTaskCorrelation(eventId, taskId, _expectedTaskId, mapping) {
      const event=events.get(eventId);
      const shared={...(event.extendedProperties?.shared||{}),taskId,
        syncSchemaVersion:"2",syncProfile:PROFILE,syncCalendarId:profiles[PROFILE].calendarId,
        syncTaskId:taskId,syncEventId:eventId,syncSeriesId:mapping.seriesId,
        syncMasterEventId:mapping.masterEventId,syncActiveInstanceId:mapping.activeInstanceId,
        syncOriginalStart:mapping.originalStart,syncActiveEffectiveStart:mapping.activeEffectiveStart,
        syncProgressVersion:"1"};
      const stored={...event,extendedProperties:{...event.extendedProperties,shared}};
      events.set(eventId,stored);
      return structuredClone(stored);
    },
    async listLinkedEventsByTodoistTaskId(taskId) {
      return [...events.values()].filter((event) => event.extendedProperties?.shared?.taskId === taskId)
        .map((event) => structuredClone(event));
    },
    async getEvent(id) {
      const found = events.get(id);
      if (!found) { const error = new Error("not found"); error.status = 404; throw error; }
      return structuredClone(found);
    },
  };
  const todoist = {
    async listProjectComments() { return projectComments.filter(comment => comment.is_deleted !== true).map(comment => structuredClone(comment)); },
    async upsertProjectComment(projectId, content, existingId) {
      const id = existingId || "provider-mapping";
      const comment = { id, project_id: projectId, content };
      const index = projectComments.findIndex(item => item.id === id);
      if (index >= 0) projectComments[index] = comment; else projectComments.push(comment);
      mirrorProviderMapping(content);
      return structuredClone(comment);
    },
    async updateComment(commentId, content) {
      const index = projectComments.findIndex(item => item.id === commentId);
      if (index < 0) throw new Error("missing comment");
      projectComments[index] = { ...projectComments[index], content };
      mirrorProviderMapping(content);
      return structuredClone(projectComments[index]);
    },
    async getComment(commentId) {
      const comment = projectComments.find(item => item.id === commentId);
      if (!comment) throw Object.assign(new Error("missing comment"), { status: 404 });
      return structuredClone(comment);
    },
    async deleteComment(commentId) {
      const index = projectComments.findIndex(item => item.id === commentId);
      if (index >= 0) projectComments[index] = { ...projectComments[index], is_deleted: true };
    },
    async getTimeZone() { return "Europe/London"; },
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
      const stored = { id, ...structuredClone(payload), project_id: profiles[PROFILE].todoistProjectId };
      state.operations.push(`upsert-task:${id}`);
      todoistUpserts.push({ id, payload: structuredClone(payload), existingId });
      tasks.set(id, stored);
      return stored;
    },
    async createTaskOnce(payload, requestKey) {
      if (createdByRequest.has(requestKey)) return structuredClone(tasks.get(createdByRequest.get(requestKey)));
      const id = `created-${++created}`;
      const stored = { id, ...structuredClone(payload), project_id: profiles[PROFILE].todoistProjectId };
      createdByRequest.set(requestKey, id);
      tasks.set(id, stored);
      todoistUpserts.push({ id, requestKey, payload: structuredClone(payload) });
      state.operations.push(`create-task-once:${id}`);
      return structuredClone(stored);
    },
    async updateTaskMetadata(id, metadata) {
      const current = tasks.get(id);
      if (!current) throw Object.assign(new Error("missing"), { status: 404 });
      const stored = { ...structuredClone(current), ...structuredClone(metadata) };
      tasks.set(id, stored);
      state.operations.push(`update-task-metadata:${id}`);
      return structuredClone(stored);
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
  };
  return { calendar, todoist, calendarDeletes, calendarUpserts, todoistDeletes, todoistUpserts, todoistRecurringUpdates, tasks, events, projectComments };
}

function linkFor(active, taskId = "task-current") {
  return {
    profile: PROFILE,
    owner: "calendar",
    calendarProgressVersion: 1,
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
    todoistPhaseBVersion: 1,
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
  const selected = selectCalendarRecurrenceInstance([current, next], linkFor(current), Date.parse("2098-12-01T00:00:00Z"), "Europe/London");
  assert.equal(selected?.id, "current");
});

test("selector skips expired history and chooses one current or future occurrence", () => {
  const expired = instance("expired", "2000-01-01", "2000-01-02");
  const current = instance("current", "2099-01-01", "2099-01-02");
  const later = instance("later", "2100-01-01", "2100-01-02");
  assert.equal(selectCalendarRecurrenceInstance([expired, current, later], undefined, Date.parse("2026-09-06T00:00:00Z"), "Europe/London")?.id, "current");
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

test("scheduled reconciliation bootstraps provider correlation without advancing an overdue incomplete task", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-26T12:00:00Z") });
  const current = instance("oct-21", "2026-10-21", "2026-10-22");
  const successor = instance("oct-28", "2026-10-28", "2026-10-29");
  const link = { ...linkFor(current), calendarProgressVersion: 1 };
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, project_id: profiles[PROFILE].todoistProjectId, content: current.summary,
    due: { date: "2026-10-21", string: "every Wednesday starting 21 Oct 2026", is_recurring: true },
  }]]);
  const clients = fakeClients(state, [current, successor], tasks);
  clients.events.set(MASTER, { id: MASTER, status: "confirmed", summary: current.summary,
    start: { date: "2026-10-21" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"], etag: "master-etag",
    extendedProperties: { shared: { taskId: link.taskId } } });
  clients.calendar.ensureTaskCorrelation = async (eventId, taskId, _expectedTaskId, mapping) => {
    const event = clients.events.get(eventId);
    const shared = { ...(event.extendedProperties?.shared || {}), taskId,
      syncSchemaVersion: "2", syncProfile: PROFILE, syncCalendarId: profiles[PROFILE].calendarId,
      syncTaskId: taskId, syncEventId: eventId, syncSeriesId: mapping.seriesId,
      syncMasterEventId: mapping.masterEventId, syncActiveInstanceId: mapping.activeInstanceId,
      syncOriginalStart: mapping.originalStart, syncActiveEffectiveStart: mapping.activeEffectiveStart,
      ...(mapping.calendarProgressVersion === 1 ? { syncProgressVersion: "1" } : {}) };
    const updated = { ...event, extendedProperties: { ...event.extendedProperties, shared }, etag: "master-etag-2" };
    clients.events.set(eventId, updated);
    return structuredClone(updated);
  };
  clients.calendar.listInstances = async () => { throw new Error("unbounded expansion forbidden"); };
  const recurrenceSummary = await new Synchronizer(state, undefined, async () => clients).reconcile(PROFILE);
  assert.equal(recurrenceSummary.total, 1);
  assert.equal(recurrenceSummary.converged + recurrenceSummary.repaired + recurrenceSummary.unsupported
    + recurrenceSummary.excluded + recurrenceSummary.blocked + recurrenceSummary.stale
    + recurrenceSummary.unverified, recurrenceSummary.total);
  assert.equal(clients.todoistRecurringUpdates.length, 0, "elapsed time alone does not complete the represented task");
  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.equal(state.links[0].taskId, link.taskId);
  assert.equal(state.links[0].activeInstanceId, current.id);
  assert.equal(tasks.get(link.taskId).due.is_recurring, true);
  assert.equal(tasks.get(link.taskId).due.date, current.start.date);
});

test("scheduled reconciliation repairs a stale active pointer and reports unsupported Calendar recurrence as nonblocking",async()=>{
  const active={...instance("unsupported-current","2099-01-01","2099-01-02"),
    extendedProperties:{shared:{taskId:"task-current"}}};
  const successor={...instance("unsupported-next","2099-01-02","2099-01-03"),
    extendedProperties:{shared:{taskId:"task-current"}}};
  const link={...linkFor(active),activeInstanceId:"stale-instance"};
  const state=new FakeState(link);
  const task={id:link.taskId,project_id:profiles[PROFILE].todoistProjectId,content:active.summary,description:"",
    due:{date:active.start.date,string:"every day",is_recurring:true}};
  const tasks=new Map([[task.id,task]]);
  const master={id:MASTER,status:"confirmed",summary:active.summary,description:"",
    start:{date:"2099-01-01"},end:{date:"2099-01-02"},
    recurrence:["RRULE:FREQ=DAILY;BYSETPOS=1"],etag:"unsupported-master-v1",
    extendedProperties:{shared:{taskId:task.id}}};
  const clients=fakeClients(state,[active,successor],tasks,undefined,[master]);

  const result=await new Synchronizer(state,undefined,async()=>clients).reconcile(PROFILE);

  assert.equal(result.total,1);
  assert.equal(result.unsupported,1,JSON.stringify({result,audits:state.audits}));
  assert.equal(result.blocked,0);
  assert.equal(result.unverified,0);
  assert.equal(clients.todoistUpserts.length,0);
  assert.equal(clients.todoistRecurringUpdates.length,0);
  assert.equal(state.links[0].activeInstanceId,active.id);
  assert.equal(state.audits.some(item=>item.action==="calendar_recurrence_active_occurrence_mapping_repaired"),true);
  assert.equal(state.audits.some(item=>item.action==="calendar_recurrence_todoist_rule_unsupported"
    && item.detail.outcome==="unsupported" && item.detail.existingMirrorPreserved),true);
});

test("Calendar series rule edit updates the exact native Todoist task in place", async () => {
  const current = instance("yearly-current", "2099-01-01", "2099-01-02");
  const next = instance("yearly-next", "2100-01-01", "2100-01-02");
  const link = { ...linkFor(current), calendarNativeRecurring: true };
  const state = new FakeState(link);
  const task = {
    id: link.taskId, content: current.summary, description: "",
    project_id: profiles[PROFILE].todoistProjectId,
    due: { date: current.start.date, string: "every week", is_recurring: true },
  };
  const tasks = new Map([[task.id, task]]);
  const master = {
    id: MASTER, iCalUID: SERIES, status: "confirmed", summary: current.summary,
    description: "", start: structuredClone(current.start), end: structuredClone(current.end),
    recurrence: ["RRULE:FREQ=YEARLY"], etag: "master-etag",
  };
  const clients = fakeClients(state, [current, next], tasks, undefined, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.applyCalendarSeries({ id: "calendar-rule-edit", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2026-10-26T12:00:00Z", headers: {}, body: "" }, master, clients.todoist);

  assert.equal(clients.todoistUpserts.length, 1, JSON.stringify(state.audits));
  assert.equal(clients.todoistUpserts[0].existingId, task.id);
  assert.equal(tasks.get(task.id).id, task.id);
  assert.equal(tasks.get(task.id).due.is_recurring, true);
  assert.match(tasks.get(task.id).due.string, /starting 1 Jan 2099/i);
  assert.equal(state.links[0].taskId, task.id);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_rule_updated_todoist"
    && entry.detail.taskId === task.id), true);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_snapshot_recurring_identity_conflict"), false);
});

test("scheduled reconciliation repairs a missing project mapping from the exact Calendar task ID", async () => {
  const current = instance("yearly-current", "2099-01-01", "2099-01-02");
  const next = instance("yearly-next", "2100-01-01", "2100-01-02");
  const link = { ...linkFor(current), calendarNativeRecurring: true };
  const state = new FakeState(link);
  const task = {
    id: link.taskId, content: current.summary, description: "",
    project_id: profiles[PROFILE].todoistProjectId,
    due: { date: current.start.date, string: "every 1 Jan starting 1 Jan 2099", is_recurring: true },
  };
  const tasks = new Map([[task.id, task]]);
  const master = {
    id: MASTER, iCalUID: SERIES, status: "confirmed", summary: current.summary,
    description: "", start: structuredClone(current.start), end: structuredClone(current.end),
    recurrence: ["RRULE:FREQ=YEARLY"], etag: "master-etag",
    extendedProperties: { shared: { taskId: task.id } },
  };
  const clients = fakeClients(state, [current, next], tasks, undefined, [master]);
  clients.projectComments.splice(0);
  const sync = new Synchronizer(state, undefined, async () => clients);

  assert.equal((await sync.providerMappingByTask(PROFILE, task.id, clients.todoist))?.eventId, current.id,
    "the exact legacy mapping remains available as a fallback when the provider comment is absent");

  await sync.reconcile(PROFILE);

  assert.equal(clients.todoistRecurringUpdates.length, 0,
    "the already-correct task is left untouched while its missing provider mapping is repaired");
  assert.equal(clients.tasks.size, 1);
  assert.equal(clients.projectComments.length, 1);
  assert.equal(parseMappingComment(clients.projectComments[0])?.payload.taskId, task.id);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_snapshot_recurring_identity_conflict"), false);
});

test("scheduled reconciliation repairs a missing Todoist-native series comment from the Calendar master", async () => {
  const current = instance("daily-current", "2099-09-17", "2099-09-18");
  const next = instance("daily-next", "2099-09-18", "2099-09-19");
  const task = {
    id: "todoist-native-task", content: "Daily reminder", description: "",
    project_id: profiles[PROFILE].todoistProjectId,
    due: { date: current.start.date, string: "every day", is_recurring: true },
  };
  const tasks = new Map([[task.id, structuredClone(task)]]);
  const master = {
    id: "todoist-native-master", status: "confirmed", summary: task.content, description: "",
    start: structuredClone(current.start), end: structuredClone(current.end),
    recurrence: ["RRULE:FREQ=DAILY"],
    extendedProperties: { shared: { taskId: task.id, todoistRecurrence: "every day" } },
  };
  const state = new FakeState();
  const clients = fakeClients(state, [current, next], tasks, undefined, [master]);

  await new Synchronizer(state, undefined, async () => clients).reconcile(PROFILE);

  assert.equal(clients.todoistUpserts.length, 0, "repair should not create a replacement Todoist task");
  assert.equal(clients.tasks.size, 1);
  assert.equal(clients.projectComments.length, 1);
  const mapping = parseMappingComment(clients.projectComments[0])?.payload;
  assert.equal(mapping?.taskId, task.id);
  assert.equal(mapping?.masterEventId, master.id);
  assert.equal(clients.events.get(master.id).recurrence[0], "RRULE:FREQ=DAILY");
});

test("unsupported legacy Calendar recurrence preserves its existing Todoist mirror", async () => {
  const expired = instance("expired", "2000-01-01", "2000-01-02");
  const next = instance("next", "2099-01-01", "2099-01-02");
  const later = instance("later", "2100-01-01", "2100-01-02");
  const link = linkFor(expired, "task-old");
  delete link.calendarProgressVersion; // exercise migration of the old rolling mirror
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, content: expired.summary, description: "", due: { date: expired.start.date } }]]);
  const clients = fakeClients(state, [expired, next, later], tasks);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.reconcile(PROFILE);

  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.equal(state.links[0].activeInstanceId, "expired");
  assert.equal(state.links[0].taskId, "task-old");
  assert.equal(tasks.get("task-old").due.is_recurring, undefined);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_todoist_rule_unsupported"
    && entry.detail.existingMirrorPreserved), true);
});

test("new unsupported Calendar recurrence does not create a flattened one-off mirror", async () => {
  const current = instance("hourly-current", "2099-01-01", "2099-01-02");
  const next = instance("hourly-next", "2099-01-02", "2099-01-03");
  const state = new FakeState();
  const clients = fakeClients(state, [current, next]);
  const master = { id: MASTER, iCalUID: SERIES, status: "confirmed", summary: current.summary,
    start: { date: "2099-01-01" }, recurrence: ["RRULE:FREQ=HOURLY"] };
  clients.events.set(MASTER, master);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.applyCalendarSeries({ id: "unsupported-series", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2026-10-26T12:00:00Z", headers: {}, body: "" }, master, clients.todoist);

  assert.deepEqual(clients.todoistUpserts, []);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.equal(state.links.length, 0);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_todoist_rule_unsupported"), true);
});

test("Calendar reconciliation adopts the unique unlinked recurring Todoist candidate", async () => {
  const current=instance("unlinked-current","2099-01-01","2099-01-02");
  const history=[instance("history-2010-1","2010-01-01","2010-01-02"),
    instance("history-2010-2","2010-01-02","2010-01-03"),
    instance("history-2010-3","2010-01-03","2010-01-04")];
  const task={id:"existing-unlinked-task",project_id:profiles[PROFILE].todoistProjectId,
    content:current.summary,description:current.description,
    due:{date:current.start.date,string:"every day",is_recurring:true}};
  const state=new FakeState();
  const master={id:MASTER,iCalUID:SERIES,status:"confirmed",summary:task.content,description:task.description,
    start:{date:"2010-01-01"},end:{date:"2010-01-02"},recurrence:["RRULE:FREQ=DAILY"],etag:"unlinked-master"};
  const clients=fakeClients(state,[...history,current],new Map([[task.id,task]]),undefined,[master]);
  clients.calendar.listInstancesInWindow=async(_id,start,end)=>{
    const from=start.slice(0,10),to=end.slice(0,10);
    return [...history,current].filter(item=>item.start.date>=from&&item.start.date<to).map(item=>structuredClone(item));
  };
  const sync=new Synchronizer(state,undefined,async()=>clients);
  const result=await sync.applyCalendarSeries({id:"unlinked-calendar-series",kind:"calendar",profile:PROFILE,
    mode:"aws",receivedAt:"2026-11-26T12:00:00Z",headers:{},body:""},master,clients.todoist);

  assert.equal(result,"repaired");
  assert.equal(clients.todoistUpserts.length,0);
  assert.equal(clients.todoistRecurringUpdates.length,0);
  assert.equal(clients.tasks.size,1,"candidate adoption must keep the existing Todoist task ID");
  assert.equal(clients.projectComments.length,1);
  assert.equal(parseMappingComment(clients.projectComments[0])?.payload.taskId,task.id);
  assert.equal(clients.events.get(MASTER).extendedProperties.shared.taskId,task.id);
  assert.equal(state.audits.at(-1).action,"calendar_provider_pair_recovered_by_unique_match");
});

test("Calendar delta worker recovers a recurring pair with no provider links or legacy mapping", async () => {
  const current = instance("incremental-unlinked-current", "2099-01-01", "2099-01-02");
  const history = [
    instance("incremental-history-2010-1", "2010-01-01", "2010-01-02"),
    instance("incremental-history-2010-2", "2010-01-02", "2010-01-03"),
  ];
  const task = {
    id: "incremental-existing-unlinked-task",
    project_id: profiles[PROFILE].todoistProjectId,
    content: current.summary,
    description: current.description,
    due: { date: current.start.date, string: "every day", is_recurring: true },
  };
  const master = {
    id: MASTER, iCalUID: SERIES, status: "confirmed", summary: task.content,
    description: task.description, start: { date: "2010-01-01" }, end: { date: "2010-01-02" },
    recurrence: ["RRULE:FREQ=DAILY"], etag: "incremental-unlinked-master",
  };
  const state = new FakeState();
  const clients = fakeClients(state, [...history, current], new Map([[task.id, task]]), master);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = {
    id: "incremental-calendar-unlinked-series", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2026-11-26T12:00:00Z", headers: {}, body: "",
  };

  await sync.process(delivery);

  const linkedComment = parseMappingComment(clients.projectComments[0]);
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(clients.todoistDeletes.length, 0);
  assert.equal(clients.tasks.size, 1, "candidate recovery must preserve the existing Todoist task ID");
  assert.equal(clients.projectComments.length, 1);
  assert.equal(linkedComment?.payload.taskId, task.id);
  assert.equal(linkedComment?.payload.masterEventId, master.id);
  assert.equal(linkedComment?.payload.activeInstanceId, current.id);
  assert.equal(clients.events.get(master.id).extendedProperties.shared.taskId, task.id);
  assert.equal(clients.events.get(master.id).extendedProperties.shared.syncTaskId, task.id);
  assert.ok(state.audits.some(entry => entry.action === "calendar_provider_pair_recovered_by_unique_match"));

  await sync.process({ ...delivery, id: "incremental-calendar-unlinked-series-replay" });
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(clients.tasks.size, 1, "replayed delta must not create a duplicate task");
  assert.equal(clients.projectComments.length, 1, "replayed delta must retain one exact provider mapping");
  assert.equal(clients.events.get(master.id).extendedProperties.shared.taskId, task.id);
});

test("Calendar reconciliation refuses multiple compatible unlinked recurring tasks", async () => {
  const current=instance("ambiguous-current","2099-01-01","2099-01-02");
  const next=instance("ambiguous-next","2099-01-02","2099-01-03");
  const task={project_id:profiles[PROFILE].todoistProjectId,content:current.summary,description:current.description,
    due:{date:current.start.date,string:"every day",is_recurring:true}};
  const tasks=new Map([["candidate-a",{...task,id:"candidate-a"}],["candidate-b",{...task,id:"candidate-b"}]]);
  const state=new FakeState();
  const master={id:MASTER,iCalUID:SERIES,status:"confirmed",summary:task.content,description:task.description,
    start:{date:"2099-01-01"},end:{date:"2099-01-02"},recurrence:["RRULE:FREQ=DAILY"],etag:"ambiguous-master"};
  const clients=fakeClients(state,[current,next],tasks,undefined,[master]);
  const sync=new Synchronizer(state,undefined,async()=>clients);
  const result=await sync.applyCalendarSeries({id:"ambiguous-calendar-series",kind:"calendar",profile:PROFILE,
    mode:"aws",receivedAt:"2026-11-26T12:00:00Z",headers:{},body:""},master,clients.todoist);

  assert.equal(result,"blocked");
  assert.equal(clients.projectComments.length,0);
  assert.equal(clients.todoistUpserts.length,0);
  assert.equal(state.audits.at(-1).action,"calendar_provider_pair_ambiguous");
});

test("repeated Calendar master notifications upgrade an exact one-off mirror to native recurrence once", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const next = instance("next", "2100-01-01", "2100-01-02");
  const link = linkFor(current);
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, project_id: profiles[PROFILE].todoistProjectId,
    content: current.summary, description: "", due: { date: current.start.date } }]]);
  const master = { id: MASTER, iCalUID: SERIES, summary: current.summary, start: structuredClone(current.start),
    recurrence: ["RRULE:FREQ=YEARLY"], status: "confirmed" };
  const clients = fakeClients(state, [current, next], tasks, master);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = { id: "calendar-master", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-09-06T00:00:00Z", headers: {}, body: "" };

  await sync.process(delivery);
  await sync.process({ ...delivery, id: "calendar-master-2" });

  assert.deepEqual(clients.todoistDeletes, []);
  assert.equal(clients.todoistUpserts.length, 1);
  assert.equal(clients.todoistUpserts[0].existingId, link.taskId);
  assert.equal(clients.todoistUpserts[0].payload.due.is_recurring, true);
  assert.equal(state.links[0].activeInstanceId, "current");
  assert.equal(state.mappingsByTask.get(link.taskId).recurrenceOwner, undefined);
  assert.equal(state.mappingsByTask.get(link.taskId).seriesId, SERIES);
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
    due: { date: day1.start.date, string: "every day", is_recurring: true },
  };
  const tasks = new Map([[task.id, task]]);
  const master = { id: MASTER, iCalUID: SERIES, status: "confirmed", summary: task.content,
    start: { date: day1.start.date }, recurrence: ["RRULE:FREQ=DAILY"] };
  const clients = fakeClients(state, [staleDay1Cancellation, day2, day3], tasks, staleDay1Cancellation, [master]);
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
  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(clients.todoistRecurringUpdates[0].stored.due.date, day2.start.date);
  assert.equal(state.links[0].taskId, task.id);

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
  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(tasks.has(day2TaskId), true);
  const retainedCancellationAudit = state.audits.find(
    (entry) => entry.action === "calendar_completed_projection_ignored",
  );
  assert.deepEqual(retainedCancellationAudit?.detail, {
    eventId: day1.id,
    taskId: task.id,
    completedAt: "2099-01-01T12:00:00Z",
  });
});


test("explicit cancellation of an earlier occurrence preserves the provider series correlation", async () => {
  const earlier = instance("day-20", "2099-10-20", "2099-10-21", "cancelled");
  const active = instance("day-21", "2099-10-21", "2099-10-22");
  // Some Google cancelled exceptions omit iCalUID; the master ID still resolves
  // to the existing recurrence link, not to a standalone task deletion.
  delete earlier.iCalUID;
  const link = linkFor(active);
  const state = new FakeState(link);
  const stale = { ...mappingFromLink(link), eventId: earlier.id, taskId: "old-task",
    activeInstanceId: earlier.id, originalStart: earlier.start.date };
  state.storeMapping(stale);
  state.canonicalByEvent.add(earlier.id);
  const tasks = new Map([[link.taskId, {
    id: link.taskId, content: active.summary, description: "",
    due: { date: active.start.date },
  }]]);
  const clients = fakeClients(state, [earlier, active], tasks, earlier);
  const sync = new Synchronizer(state, undefined, async () => clients);
  const delivery = {
    id: "cancel-earlier", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-21T09:00:00Z", headers: {}, body: "",
  };

  await sync.process(delivery);
  assert.equal(state.mappingsByEvent.get(active.id).taskId, link.taskId);
  assert.equal(state.mappingsByTask.get(link.taskId).eventId, active.id);
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.equal(state.links[0].taskId, link.taskId);
  assert.equal(tasks.has(link.taskId), true);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.deepEqual(clients.calendarDeletes, []);
  assert.equal(state.audits.some((entry) =>
    entry.action === "calendar_recurrence_earlier_instance_cancellation_honored"
      || entry.action === "calendar_recurrence_earlier_instance_cancellation_noop"), true);

  await sync.process({ ...delivery, id: "cancel-earlier-delayed-duplicate" });
  await sync.reconcile(PROFILE);
  await sync.reconcile(PROFILE);
  const providerMapping=JSON.parse(clients.projectComments[0].content.split("\n")[1]);
  assert.equal(providerMapping.eventId,active.id,"the provider stores one active series correlation");
  assert.equal(providerMapping.activeInstanceId,active.id);
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
});

test("missing recurringEventId and iCalUID on an earlier cancellation cannot roll the active task", async () => {
  const earlier = instance("day-20", "2099-10-20", "2099-10-21", "cancelled");
  const active = instance("day-21", "2099-10-21", "2099-10-22");
  const delta = { ...earlier };
  delete delta.recurringEventId;
  delete delta.iCalUID;
  const link = linkFor(active);
  const state = new FakeState(link);
  const stale = { ...mappingFromLink(link), eventId: earlier.id, taskId: "stale-task",
    originalStart: earlier.start.date };
  state.storeMapping(stale);
  state.canonicalByEvent.add(earlier.id);
  const tasks = new Map([[link.taskId, {
    id: link.taskId, content: active.summary, due: { date: active.start.date },
  }]]);
  const clients = fakeClients(state, [earlier, active], tasks, delta);
  // Google direct read can still return complete instance metadata despite
  // omitting it from the webhook/delta. The persisted mapping resolves the link.
  clients.events.set(earlier.id, structuredClone(earlier));
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "metadata-free-cancelled-delta", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-21T09:00:00Z", headers: {}, body: "",
  });
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.equal(state.links[0].taskId, link.taskId);
  assert.equal(state.mappingsByEvent.get(active.id).taskId, link.taskId);
  assert.equal(tasks.has(link.taskId), true);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.equal(state.audits.some((entry) =>
    entry.action === "calendar_recurrence_earlier_instance_cancellation_honored"
      || entry.action === "calendar_recurrence_earlier_instance_cancellation_noop"), true);
});

test("missing recurrence metadata on both delta and direct read must not delete the active task", async () => {
  const earlier = instance("day-20", "2099-10-20", "2099-10-21", "cancelled");
  const active = instance("day-21", "2099-10-21", "2099-10-22");
  const delta = { ...earlier };
  delete delta.recurringEventId;
  delete delta.iCalUID;
  const link = linkFor(active);
  const state = new FakeState(link);
  state.storeMapping({ ...mappingFromLink(link), eventId: earlier.id, taskId: "stale-task" });
  const tasks = new Map([[link.taskId, {
    id: link.taskId, content: active.summary, due: { date: active.start.date },
  }]]);
  const clients = fakeClients(state, [earlier, active], tasks, delta);
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "unverified-metadata-free-delta", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-21T09:00:00Z", headers: {}, body: "",
  });
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.equal(tasks.has(link.taskId), true);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  const providerMapping=JSON.parse(clients.projectComments[0].content.split("\n")[1]);
  assert.equal(providerMapping.activeInstanceId,active.id,"unverified cancellation cannot rewrite provider correlation");
});

test("an earlier cancelled event-side duplicate for the active task never removes TASK or TASKOWNER", async () => {
  const earlier = instance("day-20", "2099-10-20", "2099-10-21", "cancelled");
  const active = instance("day-21", "2099-10-21", "2099-10-22");
  const link = linkFor(active);
  const state = new FakeState(link);
  state.mappingsByEvent.set(earlier.id, {
    ...mappingFromLink(link), eventId: earlier.id, originalStart: earlier.start.date,
  });
  const tasks = new Map([[link.taskId, {
    id: link.taskId, content: active.summary, due: { date: active.start.date },
  }]]);
  const clients = fakeClients(state, [earlier, active], tasks, earlier);
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "same-task-earlier", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-21T09:00:00Z", headers: {}, body: "",
  });
  assert.equal(state.mappingsByTask.get(link.taskId).eventId, active.id);
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.deepEqual(clients.todoistDeletes, []);
});

test("stale Calendar cancellation delta without provider confirmation cannot purge earlier occurrence", async () => {
  const earlier = instance("day-20", "2099-10-20", "2099-10-21", "cancelled");
  const active = instance("day-21", "2099-10-21", "2099-10-22");
  const link = linkFor(active);
  const state = new FakeState(link);
  state.canonicalByEvent.add(earlier.id);
  const clients = fakeClients(state, [earlier, active], new Map(), earlier);
  clients.events.set(earlier.id, { ...earlier, status: "confirmed" });
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "unverified-delete", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-21T09:00:00Z", headers: {}, body: "",
  });
  assert.equal(state.canonicalByEvent.has(earlier.id), true);
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.equal(state.audits.some((entry) => entry.action ===
    "calendar_recurrence_stale_instance_cancellation_ignored"), true);
});

test("cancellation of a future nonactive instance leaves the current task and master untouched", async () => {
  const active = instance("day-20", "2099-10-20", "2099-10-21");
  const future = instance("day-21", "2099-10-21", "2099-10-22", "cancelled");
  const link = linkFor(active);
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, {
    id: link.taskId, content: active.summary, due: { date: active.start.date },
  }]]);
  const clients = fakeClients(state, [active, future], tasks, future);
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "future-cancelled", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-20T09:00:00Z", headers: {}, body: "",
  });
  assert.equal(state.links[0].activeInstanceId, active.id);
  assert.deepEqual(clients.todoistDeletes, []);
  assert.deepEqual(clients.todoistUpserts, []);
  assert.deepEqual(clients.calendarDeletes, []);
});

test("cancelling the currently active instance advances the same native task without deleting the master", async () => {
  const current = instance("day-20", "2099-10-20", "2099-10-21", "cancelled");
  const successor = instance("day-21", "2099-10-21", "2099-10-22");
  const link = linkFor(current);
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, {
    id: link.taskId, content: current.summary, due: { date: current.start.date, string: "every day", is_recurring: true },
  }]]);
  const master = { id: MASTER, iCalUID: SERIES, status: "confirmed", summary: current.summary,
    start: { date: current.start.date }, recurrence: ["RRULE:FREQ=DAILY"] };
  const clients = fakeClients(state, [current, successor], tasks, current, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);
  await sync.process({
    id: "current-cancelled", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-20T09:00:00Z", headers: {}, body: "",
  });
  assert.deepEqual(clients.todoistDeletes, []);
  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(state.links[0].activeInstanceId, successor.id);
  assert.equal(state.links[0].masterEventId, MASTER);
  assert.equal(state.links[0].taskId, link.taskId);
  assert.deepEqual(clients.calendarDeletes, []);
});

test("Todoist-native active-instance cancellation uses a bounded Calendar occurrence window", async () => {
  const current = instance("todoist-day-20", "2099-10-20", "2099-10-21", "cancelled");
  const successor = instance("todoist-day-21", "2099-10-21", "2099-10-22");
  const task = { id: "task-recurring", project_id: profiles[PROFILE].todoistProjectId,
    content: current.summary, due: { date: "2099-10-20", string: "every day", is_recurring: true } };
  const master = { id: MASTER, iCalUID: SERIES, status: "confirmed", summary: current.summary,
    start: { date: "2099-10-20" }, recurrence: ["RRULE:FREQ=DAILY"],
    extendedProperties: { shared: { taskId: task.id, todoistRecurrence: "every day" } } };
  const link = todoistOwnedLink(master, current, task.id);
  const state = new FakeState(link);
  const clients = fakeClients(state, [current, successor], new Map([[task.id, task]]), current, [master]);
  const originalBoundedRead = clients.calendar.listInstancesInWindow.bind(clients.calendar);
  let boundedRead;
  clients.calendar.listInstances = async () => { throw new Error("unbounded occurrence expansion forbidden"); };
  clients.calendar.listInstancesInWindow = async (masterId, start, end) => {
    boundedRead = { masterId, start, end };
    return originalBoundedRead(masterId, start, end);
  };
  await new Synchronizer(state, undefined, async () => clients).process({
    id: "todoist-native-current-cancelled", kind: "calendar", profile: PROFILE,
    mode: "aws", receivedAt: "2099-10-20T09:00:00Z", headers: {}, body: "",
  });
  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(state.links[0].activeInstanceId, successor.id);
  assert.equal(boundedRead.masterId, MASTER);
  assert.ok(Date.parse(boundedRead.end) - Date.parse(boundedRead.start) < 4 * 366 * 24 * 60 * 60_000);
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
  assert.equal(clients.projectComments.filter(comment => comment.is_deleted !== true).length, 0, JSON.stringify(clients.projectComments));
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_master_deleted"), true);
});

test("explicit deletion of the currently mapped Calendar-owned mirror still deletes the Calendar master", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const link = linkFor(current, "task-current");
  const state = new FakeState(link);
  const tasks = new Map([[link.taskId, { id: link.taskId, content: current.summary, description: "", due: { date: current.start.date } }]]);
  const clients = fakeClients(state, [current], tasks);
  tasks.delete(link.taskId);
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
  assert.equal(clients.projectComments.filter(comment => comment.is_deleted !== true).length, 0);
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
  assert.equal(state.completedProjections.length, 1);
  assert.equal(state.completedProjections[0].eventId, currentInstance.id);
  assert.equal(state.completedProjections[0].masterEventId, master.id);
  assert.equal(state.links[0].masterEventId, "todoist-master");
  assert.equal(state.links[0].activeInstanceId, "instance-7");
  assert.equal(state.links[0].originalStart, "2026-09-07");
  assert.equal(state.links[0].activeEffectiveStart, "2026-09-07");
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_completed_advanced_to_effective_instance");

  await sync.process({
    id: "todoist-complete-replay",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:00:01Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: initialTask, event_data_extra: { old_item: initialTask } }),
  });

  assert.equal(state.completedProjections.length, 1);
  assert.equal(state.links[0].activeInstanceId, "instance-7");
  assert.equal(state.links[0].originalStart, "2026-09-07");
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_duplicate_completion_ignored");
});

test("unsupported completion-relative Todoist recurrence keeps its existing pair without rolling fallback", async () => {
  const initialTask = { id: "task-rolling", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every! 3 days", is_recurring: true } };
  const oldEvent = { ...toCalendarEvent(initialTask), id: "rolling-old", status: "confirmed" };
  const advancedTask = { ...initialTask, due: { ...initialTask.due, date: "2026-09-09" } };
  const link = {
    profile: PROFILE,
    owner: "todoist",
    seriesId: initialTask.id,
    taskId: initialTask.id,
    eventId: oldEvent.id,
    activeInstanceId: oldEvent.id,
    originalStart: "2026-09-06",
    activeEffectiveStart: "2026-09-06",
    updatedAt: "2026-09-06T00:00:00Z",
  };
  const state = new FakeState(link);
  const tasks = new Map([[initialTask.id, advancedTask]]);
  const clients = fakeClients(state, [oldEvent], tasks);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-complete-rolling",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: initialTask, event_data_extra: { old_item: initialTask } }),
  });

  assert.deepEqual(clients.calendarDeletes, []);
  assert.equal(state.completedProjections.length, 0);
  assert.equal(clients.events.has(oldEvent.id), true);
  assert.equal(clients.calendarUpserts.length, 0);
  assert.equal(state.links[0].eventId, oldEvent.id);
  assert.equal(state.links[0].activeInstanceId, oldEvent.id);
  assert.equal(state.audits.some((entry) => entry.action === "todoist_recurrence_unsupported_rule"
    && entry.detail.outcome === "source_left_unchanged"), true);
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

test("Todoist canonical echo preserves Calendar recurrence ownership before completion skips a canceled occurrence", async () => {
  const dates = ["2099-09-06", "2099-09-13", "2099-09-20", "2099-09-27"];
  const master = {
    id: MASTER, iCalUID: SERIES, summary: "Water plants", status: "confirmed",
    start: { date: dates[0] }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const current = instance("instance-1", dates[0], addDay(dates[0]));
  const cancelled = instance("instance-2", dates[1], addDay(dates[1]), "cancelled");
  const next = instance("instance-3", dates[2], addDay(dates[2]));
  const final = instance("instance-4", dates[3], addDay(dates[3]));
  for (const occurrence of [current, cancelled, next, final]) occurrence.summary = "Water plants";
  const recurrenceText = "every Sunday ending 27 Sep 2099";
  const initialTask = {
    id: "task-calendar-owned", content: "Water plants", description: "", project_id: "home-project",
    due: { date: dates[0], is_recurring: true, string: recurrenceText },
  };
  const link = linkFor(current, initialTask.id);
  const state = new FakeState(link);
  const tasks = new Map([[initialTask.id, structuredClone(initialTask)]]);
  const clients = fakeClients(state, [current, cancelled, next, final], tasks, undefined, [master]);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "todoist-recurring-echo", kind: "todoist", profile: PROFILE, mode: "aws",
    receivedAt: "2099-09-06T08:00:00Z", headers: {},
    body: JSON.stringify({ event_name: "item:added", event_data: initialTask }),
  });

  assert.equal(state.mappingsByTask.get(initialTask.id).recurrenceOwner, undefined);
  assert.equal(state.mappingsByTask.get(initialTask.id).masterEventId, MASTER);
  assert.equal(state.mappingsByTask.get(initialTask.id).seriesId, SERIES);
  assert.equal(state.mappingsByTask.get(initialTask.id).activeInstanceId, current.id);
  assert.equal(state.mappingsByTask.get(initialTask.id).originalStart, dates[0]);
  assert.equal(state.mappingsByTask.get(initialTask.id).activeEffectiveStart, dates[0]);
  assert.equal(state.links[0].owner, "calendar");
  assert.equal(state.links[0].masterEventId, MASTER);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_owned_todoist_echo_ignored"), true);

  // Todoist advances its current due date to the next recurrence before the
  // completion webhook is handled. Here that due date is the canceled slot.
  tasks.set(initialTask.id, {
    ...initialTask,
    due: { ...initialTask.due, date: dates[1] },
  });
  await sync.process({
    id: "todoist-recurring-complete", kind: "todoist", profile: PROFILE, mode: "aws",
    receivedAt: "2099-09-06T09:00:00Z", headers: {},
    body: JSON.stringify({ event_name: "item:completed", event_data: initialTask, event_data_extra: { old_item: initialTask } }),
  });

  assert.equal(clients.todoistRecurringUpdates.length, 1);
  assert.equal(clients.todoistRecurringUpdates[0].stored.due.date, dates[2]);
  assert.equal(state.links[0].owner, "calendar");
  assert.equal(state.links[0].activeInstanceId, next.id);
  assert.equal(state.links[0].masterEventId, MASTER);
  assert.equal(clients.calendarUpserts.length, 0, "completion must advance the existing Calendar series without creating a standalone event");
  assert.deepEqual(clients.calendarDeletes, []);
  assert.deepEqual(clients.events.get(MASTER).recurrence, ["RRULE:FREQ=WEEKLY;COUNT=4"]);
  assert.equal(clients.events.has(final.id), true);
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

test("deleting a Todoist-native Calendar master deletes its task and a stale completion cannot recreate it", async () => {
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

  assert.deepEqual(clients.todoistDeletes, [task.id]);
  assert.equal(tasks.has(task.id), false);
  assert.equal(clients.projectComments.filter(comment => comment.is_deleted !== true
    && parseMappingComment(comment)?.payload.taskId === task.id).length, 0);
  assert.equal(state.tombstones.length, 0, "deleted relationships are not retained as replay tombstones");
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_master_deleted_counterpart"), true);

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
  assert.equal(tasks.has(task.id), false);
  assert.equal(state.audits.at(-1).action, "todoist_missing_task_delivery_ignored");
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
  assert.equal(state.tombstones.length, 0, "deleted relationships are not retained as replay tombstones");
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_completion_suppressed_missing_calendar_master");
});

test("Calendar series rule edit updates the Todoist-owned task without replacing either identity", async () => {
  const task = { id: "task-recurring", project_id: profiles[PROFILE].todoistProjectId,
    content: "Water plants", description: "", due: { date: "2099-01-01", string: "every day", is_recurring: true } };
  const projected = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(projected.id, task.id, "instance-1", "2099-01-01");
  const successor = todoistInstance(projected.id, task.id, "instance-8", "2099-01-08");
  const edited = { ...projected, recurrence: ["RRULE:FREQ=WEEKLY"] };
  const link = todoistOwnedLink(projected, active, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [active, successor], tasks, edited);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({ id: "calendar-master-edit", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2098-12-30T10:00:00Z", headers: {}, body: "" });

  assert.equal(clients.todoistUpserts.length, 1, JSON.stringify(state.audits));
  assert.equal(clients.todoistUpserts[0].existingId, task.id);
  assert.equal(clients.todoistUpserts[0].id, task.id);
  assert.equal(clients.todoistUpserts[0].payload.due.is_recurring, true);
  assert.notEqual(clients.todoistUpserts[0].payload.due.string, "every day");
  assert.deepEqual(clients.calendarUpserts, []);
  assert.equal(state.links[0].taskId, task.id);
  assert.equal(state.audits.some((entry) => entry.action === "calendar_recurrence_rule_updated_todoist"
    && entry.detail.taskId === task.id), true);
});

test("deleting the Todoist recurring task deletes its Calendar RRULE master", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const link = todoistOwnedLink(master, active, task.id);
  const state = new FakeState(link);
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [active], tasks, undefined, [master]);
  tasks.delete(task.id);
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
  assert.equal(clients.projectComments.filter(comment => comment.is_deleted !== true).length, 0);
});

test("a stale Todoist deletion replay does not delete a currently live Calendar series", async () => {
  const task = { id: "task-recurring", content: "Water plants", description: "", due: { date: "2026-09-06", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(task), id: "todoist-master", status: "confirmed" };
  const active = todoistInstance(master.id, task.id, "instance-6", "2026-09-06");
  const state = new FakeState(todoistOwnedLink(master, active, task.id));
  const tasks = new Map([[task.id, task]]);
  const clients = fakeClients(state, [active], tasks, master);
  const sync = new Synchronizer(state, undefined, async () => clients);

  await sync.process({
    id: "stale-todoist-delete",
    kind: "todoist",
    profile: PROFILE,
    mode: "aws",
    receivedAt: "2026-09-06T10:00:00Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:deleted", event_data: { ...task, is_deleted: true } }),
  });

  assert.deepEqual(clients.calendarDeletes, []);
  assert.equal(tasks.has(task.id), true);
  assert.equal(state.audits.at(-1).action, "todoist_stale_delete_replay_suppressed");
});

for (const shape of ["title-date", "shared-master", "shared-instance", "one-off-other-profile", "recurring-existing-mirror"]) {
  test(`Calendar worker handles duplicate recurrence recovery safely: ${shape}`, async () => {
    const current = instance("current", "2099-01-01", "2099-01-02");
    const master = { id: MASTER, iCalUID: SERIES, summary: current.summary, start: structuredClone(current.start),
      recurrence: ["RRULE:FREQ=YEARLY"], status: "confirmed" };
    const task = { id:"original-task", content:current.summary, project_id:profiles[PROFILE].todoistProjectId, due:{ date:current.start.date, is_recurring:true } };
    if (shape === "recurring-existing-mirror") task.due.string = "every week";
    if (shape === "shared-master" || shape === "one-off-other-profile") master.extendedProperties = {shared:{taskId:task.id}};
    if (shape === "shared-instance") current.extendedProperties = {shared:{taskId:task.id}};
    if (shape.startsWith("shared-")) task.content = "Renamed original";
    if (shape === "one-off-other-profile") { task.project_id = "other-project"; task.due.is_recurring = false; }
    const state = new FakeState(shape === "recurring-existing-mirror" ? linkFor(current,task.id) : undefined);
    const clients = fakeClients(state,[current],new Map(shape === "one-off-other-profile" ? [] : [[task.id,task]]),master);
    const sync = new Synchronizer(state,undefined,async () => clients);
    const delivery = {id:"first",kind:"calendar",profile:PROFILE,mode:"aws",receivedAt:"2098-12-01T00:00:00Z",headers:{},body:""};
    await sync.process(delivery);
    await sync.process({...delivery,id:"retry"});
    if (shape === "recurring-existing-mirror") {
      assert.equal(clients.todoistUpserts.length, 1);
      assert.equal(clients.todoistUpserts[0].existingId, task.id);
      assert.equal(clients.tasks.get(task.id).due.is_recurring, true);
      assert.match(clients.tasks.get(task.id).due.string, /starting 1 Jan 2099/i);
      assert.equal(state.audits.some(item => item.action === "calendar_snapshot_recurring_identity_conflict"), false);
    } else {
      assert.deepEqual(clients.todoistUpserts,[]);
      assert.equal(state.audits.filter(item => item.action === "calendar_snapshot_recurring_identity_conflict").length,2);
    }
    assert.deepEqual(clients.todoistDeletes,[]);
  });
}

test("new genuinely Calendar-owned series creates one mirror across retries", async () => {
  const current = instance("current", "2099-01-01", "2099-01-02");
  const master = {id:MASTER,iCalUID:SERIES,summary:current.summary,start:structuredClone(current.start),
    recurrence:["RRULE:FREQ=YEARLY"],status:"confirmed"};
  const state = new FakeState();
  const clients = fakeClients(state,[current],new Map(),master);
  const sync = new Synchronizer(state,undefined,async () => clients);
  const delivery = {id:"first",kind:"calendar",profile:PROFILE,mode:"aws",receivedAt:"2098-12-01T00:00:00Z",headers:{},body:""};
  await sync.process(delivery);
  await sync.process({...delivery,id:"retry"});
  assert.equal(clients.todoistUpserts.length,1);
  assert.equal(state.links[0].taskId,clients.todoistUpserts[0].id);
});

for (const status of ["cancelled", "flattened", "gone", "excluded", "todoist-owned", "archived"]) {
  test(`stale series delta cannot create a mirror after master is ${status}`, async () => {
    const current = instance("current", "2099-01-01", "2099-01-02");
    const master = {id:MASTER,iCalUID:SERIES,summary:current.summary,recurrence:["RRULE:FREQ=YEARLY"],status:"confirmed"};
    const state = new FakeState();
    const clients = fakeClients(state,[current],new Map(),master);
    if (status === "gone") clients.events.delete(MASTER);
    if (status === "cancelled") clients.events.set(MASTER,{...master,status:"cancelled"});
    if (status === "flattened") clients.events.set(MASTER,{...master,recurrence:undefined});
    if (status === "archived") clients.events.set(MASTER,{...master,extendedProperties:{shared:{syncHistoryOnly:"true"}}});
    if (status === "todoist-owned") clients.events.set(MASTER,{...master,extendedProperties:{shared:{syncRecurrenceOwner:"todoist",taskId:"annual-task"}}});
    if (status === "excluded") state.syncBlocked = async (_profile,ids) => ids.eventId === MASTER;
    const sync = new Synchronizer(state,undefined,async () => clients);
    await sync.process({id:"stale",kind:"calendar",profile:PROFILE,mode:"aws",receivedAt:"2098-12-01T00:00:00Z",headers:{},body:""});
    assert.deepEqual(clients.todoistUpserts,[]);
    assert.deepEqual(state.links,[]);
  });
}


test("Calendar-owned native task creation echo never PUTs the generated Calendar instance", async () => {
  const current = instance("oct-28", "2026-10-28", "2026-10-29");
  current.summary = "Weekly test";
  const master = { id: MASTER, etag: '"v1"', iCalUID: SERIES, status: "confirmed",
    summary: "Weekly test", description: "", start: { date: current.start.date },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"] };
  const link = { ...linkFor(current, "echo-task"), calendarProgressVersion: 1,
    syncedTitle: "Weekly test", syncedDescription: "" };
  const state = new FakeState(link);
  const initial = { id: link.taskId, project_id: "home-project",
    content: "Weekly test", description: "",
    due: { date: "2026-10-28", string: "every Wednesday", is_recurring: true } };
  const tasks = new Map([[initial.id, structuredClone(initial)]]);
  const clients = fakeClients(state, [current], tasks, undefined, [master]);
  await new Synchronizer(state, undefined, async () => clients).process({
    id: "echo", kind: "todoist", profile: PROFILE, mode: "aws",
    receivedAt: "2026-10-26T15:10:27Z", headers: {},
    body: JSON.stringify({ event_name: "item:added", event_data: initial }),
  });
  assert.equal(clients.calendarUpserts.length, 0);
  assert.equal(state.mappingsByTask.get(link.taskId).recurrenceOwner, "calendar");
  assert.equal(state.audits.at(-1).action, "calendar_owned_todoist_echo_ignored");
});

test("genuine Todoist title edit on Calendar-owned series PATCHes only the Calendar master", async () => {
  const current = instance("oct-28", "2026-10-28", "2026-10-29");
  current.summary = "Weekly test";
  const master = { id: MASTER, etag: '"v1"', iCalUID: SERIES, status: "confirmed",
    summary: "Weekly test", description: "", start: { date: current.start.date },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"] };
  const link = { ...linkFor(current, "edited-task"), calendarProgressVersion: 1,
    syncedTitle: "Weekly test", syncedDescription: "" };
  const state = new FakeState(link);
  const task = { id: link.taskId, project_id: "home-project",
    content: "Renamed from Todoist", description: "",
    due: { date: "2026-11-04", string: "every Wednesday", is_recurring: true } };
  const tasks = new Map([[task.id, structuredClone(task)]]);
  const clients = fakeClients(state, [current], tasks, undefined, [master]);
  await new Synchronizer(state, undefined, async () => clients).process({
    id: "edit", kind: "todoist", profile: PROFILE, mode: "aws",
    receivedAt: "2026-10-26T15:10:27Z", headers: {},
    body: JSON.stringify({ event_name: "item:updated", event_data: task,
      event_data_extra: { old_item: { ...task, content: "Weekly test" } } }),
  });
  assert.equal(clients.calendarUpserts.length, 1);
  assert.equal(clients.calendarUpserts[0].metadataOnly, true);
  assert.equal(clients.events.get(MASTER).summary, "Renamed from Todoist");
  assert.deepEqual(clients.events.get(MASTER).recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=WE"]);
  assert.equal(tasks.get(task.id).due.date, "2026-11-04");
  assert.equal(state.mappingsByTask.get(task.id).syncedTitle, "Renamed from Todoist");
});

test("Calendar rename updates a native Todoist task without rewinding its automatically advanced due date", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-26T12:00:00Z") });
  const current = instance("oct-28", "2026-10-28", "2026-10-29");
  const next = instance("nov-04", "2026-11-04", "2026-11-05");
  current.summary = "Renamed from Calendar";
  next.summary = "Renamed from Calendar";
  const master = { id: MASTER, etag: '"v2"', iCalUID: SERIES, status: "confirmed",
    summary: "Renamed from Calendar", description: "",
    start: { date: current.start.date }, end: { date: current.end.date },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"] };
  const link = { ...linkFor(current, "advanced-task"), calendarProgressVersion: 1,
    syncedTitle: "Weekly test", syncedDescription: "" };
  const state = new FakeState(link);
  const task = { id: link.taskId, project_id: profiles[PROFILE].todoistProjectId, content: "Weekly test",
    description: "", due: { date: "2026-11-04", string: "every Wednesday", is_recurring: true } };
  const tasks = new Map([[task.id, structuredClone(task)]]);
  const clients = fakeClients(state, [current, next], tasks, master);
  await new Synchronizer(state, undefined, async () => clients).process({
    id: "calendar-rename", kind: "calendar", profile: PROFILE, mode: "aws",
    receivedAt: "2026-10-26T15:11:59Z", headers: {}, body: "",
  });
  assert.equal(tasks.get(task.id).content, "Renamed from Calendar");
  assert.equal(tasks.get(task.id).due.date, "2026-11-04");
  assert.equal(clients.todoistRecurringUpdates.length, 0);
  assert.equal(clients.calendarUpserts.length, 0);
  assert.equal(state.mappingsByTask.get(task.id).eventId, "oct-28",
    "progress should change only after a verified completion");
  assert.ok(state.audits.some(e => e.action === "calendar_owned_completion_advance_deferred"));
});

test("native Todoist completion already at next Calendar occurrence updates mapping without second advance", async (t) => {
  // The fixture models a completion on 26 October 2026. Without a fixed
  // clock, both occurrences become historical after 4 November and the
  // current-occurrence selection changes independently of this regression.
  t.mock.method(Date, "now", () => Date.parse("2026-10-26T15:11:12Z"));
  const current = instance("oct-28", "2026-10-28", "2026-10-29");
  const next = instance("nov-04", "2026-11-04", "2026-11-05");
  current.summary = "Weekly test";
  next.summary = "Weekly test";
  const master = { id: MASTER, etag: '"v1"', iCalUID: SERIES, status: "confirmed",
    summary: "Weekly test", description: "", start: { date: current.start.date },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"] };
  const link = { ...linkFor(current, "advanced-task"), calendarProgressVersion: 1,
    syncedTitle: "Weekly test", syncedDescription: "" };
  const state = new FakeState(link);
  const oldTask = { id: link.taskId, project_id: profiles[PROFILE].todoistProjectId, content: "Weekly test",
    description: "", due: { date: "2026-10-28", string: "every Wednesday", is_recurring: true } };
  const tasks = new Map([[oldTask.id, { ...structuredClone(oldTask),
    due: { ...oldTask.due, date: "2026-11-04" } }]]);
  const clients = fakeClients(state, [current, next], tasks, undefined, [master]);
  await new Synchronizer(state, undefined, async () => clients).process({
    id: "completed", kind: "todoist", profile: PROFILE, mode: "aws",
    receivedAt: "2026-10-26T15:11:12Z", headers: {},
    body: JSON.stringify({ event_name: "item:completed",
      event_data: { ...oldTask, is_completed: true }, event_data_extra: { old_item: oldTask } }),
  });
  assert.equal(clients.todoistRecurringUpdates.length, 0, "Todoist advanced itself; never advance twice");
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(tasks.get(oldTask.id).due.date, "2026-11-04");
  assert.equal(state.mappingsByTask.get(oldTask.id).eventId, "nov-04");
  assert.equal(state.mappingsByTask.get(oldTask.id).completedThroughOriginalStart, "2026-10-28");
  assert.ok(state.audits.some(e => e.action === "calendar_owned_completion_provider_already_advanced"));
});


test("unchanged v2 one-off on moved final annual occurrence avoids correlation and cross-profile reads", async () => {
  const taskId = "guardian-one-off";
  const active = {
    ...instance("annual-final", "2099-11-27", "2099-11-28"),
    originalStartTime: { date: "2099-11-15" },
    extendedProperties: { shared: {
      taskId, syncTaskId: taskId, syncSchemaVersion: "2", syncProfile: PROFILE,
      syncCalendarId: profiles[PROFILE].calendarId, syncEventId: "annual-final",
    } },
  };
  const master = {
    id: MASTER, status: "confirmed", start: { date: "2096-11-15" },
    end: { date: "2096-11-16" }, recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20991115;INTERVAL=1"],
  };
  const task = {
    id: taskId, project_id: profiles[PROFILE].todoistProjectId,
    content: active.summary, description: "", due: { date: active.start.date, is_recurring: false },
  };
  const state = new FakeState();
  const clients = fakeClients(state, [active], new Map([[taskId, task]]), active, [master]);
  const projectId = profiles[PROFILE].todoistProjectId;
  const mapping = {
    profile: PROFILE, projectId, calendarId: profiles[PROFILE].calendarId,
    eventId: active.id, taskId, syncedTitle: active.summary, syncedDescription: "",
    syncedDue: active.start.date, syncBaseline: providerSyncBaseline(task, active),
    mappingRevision: 1, updatedAt: "2026-11-26T12:21:32.498Z",
  };
  clients.projectComments.push({ id: "exact-v2", project_id: projectId,
    content: serializeMappingComment(mapping, projectId) });
  const sync = new Synchronizer(state, undefined, async () => clients);
  let crossProfileReads = 0, taskReads = 0, correlationAttempts = 0, replayVerified = 0;
  sync.providerMappingByTaskAnyProfile = async () => { crossProfileReads++; return mapping; };
  const getTask = clients.todoist.getTask.bind(clients.todoist);
  clients.todoist.getTask = async (...args) => { taskReads++; return getTask(...args); };
  clients.calendar.ensureTaskCorrelation = async () => { correlationAttempts++; throw new Error("unexpected correlation attempt"); };
  const originalComments = structuredClone(clients.projectComments);
  const delivery = { id: "guardian-delta", kind: "calendar", profile: PROFILE, mode: "aws", receivedAt: "2026-11-26T12:30:00Z", headers: {}, body: "" };
  for (let i = 0; i < 3; i++)
    await sync.applyCalendarEvent(delivery, structuredClone(active), clients.calendar, clients.todoist, () => replayVerified++);
  assert.equal(crossProfileReads, 0);
  assert.equal(taskReads, 3, "one task read per delta, no additional baseline read");
  assert.equal(correlationAttempts, 0);
  assert.equal(replayVerified, 0);
  assert.equal(clients.todoistUpserts.length, 0);
  assert.equal(clients.calendarUpserts.length, 0);
  assert.deepEqual(clients.projectComments, originalComments);
  assert.equal(state.audits.filter(entry => entry.action === "calendar_noop_canonical_state").length, 3);

  // An actual edit and an open-ended master must still take the guarded path.
  const changed = { ...active, summary: "Edited reminder" };
  clients.calendar.ensureTaskCorrelation = async () => { throw new Error("guarded correlation path"); };
  await assert.rejects(sync.applyCalendarEvent(delivery, changed, clients.calendar, clients.todoist, () => {}),
    /guarded correlation path/);
  assert.equal(crossProfileReads, 1, "real change still checks cross-profile ownership");
  assert.equal(clients.todoistUpserts.length, 1, "real change still reaches the existing task writer");
  clients.tasks.set(taskId, task);
  clients.events.set(MASTER, { ...master, recurrence: ["RRULE:FREQ=YEARLY"] });
  await assert.rejects(sync.applyCalendarEvent(delivery, active, clients.calendar, clients.todoist, () => {}),
    /guarded correlation path/);
  assert.equal(crossProfileReads, 2, "uncapped series never uses the special no-op shortcut");
});
