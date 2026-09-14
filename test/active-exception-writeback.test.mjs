import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { ProjectAwareSynchronizer } from "../dist/project-sync.js";

const HOME = profiles.home.todoistProjectId;

class FakeState {
  constructor(mapping) {
    this.mapping = mapping;
    this.audits = [];
    this.mutations = 0;
    this.versionAccepted = true;
  }
  async getMappingByTaskAnyProfile() { return this.mapping; }
  async acceptTaskVersion() { return this.versionAccepted; }
  async mutationAllowed() { return true; }
  async putMapping(mapping) { this.mapping = mapping; }
  async putRecurrenceLink(link) { this.link = link; }
  async recordMutation() { this.mutations += 1; }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

function fixture({ activeStart = "2026-09-16", activeSummary = "Weekly task", taskDate = "2026-09-14", taskSummary = "Weekly task" } = {}) {
  const master = {
    id: "master-1",
    status: "confirmed",
    summary: "Weekly task",
    description: "",
    start: { date: "2026-09-14" },
    end: { date: "2026-09-15" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    extendedProperties: {
      shared: {
        taskId: "task-1",
        syncRecurrenceOwner: "todoist",
        todoistRecurrence: "every monday",
        todoistAnchorStart: "2026-09-14",
        todoistAnchorEnd: "2026-09-15",
        todoistAnchorAllDay: "true",
        todoistAnchorTimeZone: "",
        todoistTemplateSummary: "Weekly task",
        todoistTemplateDescription: "",
      },
    },
  };
  const active = {
    id: "instance-1",
    status: "confirmed",
    recurringEventId: master.id,
    originalStartTime: { date: "2026-09-14" },
    summary: activeSummary,
    description: "",
    start: { date: activeStart },
    end: { date: activeStart === "2026-09-16" ? "2026-09-17" : "2026-09-15" },
    extendedProperties: master.extendedProperties,
  };
  const task = {
    id: "task-1",
    project_id: HOME,
    content: taskSummary,
    description: "",
    updated_at: "2026-09-06T02:20:00Z",
    due: { date: taskDate, is_recurring: true, string: "every monday" },
  };
  const mapping = {
    profile: "home",
    projectId: HOME,
    eventId: master.id,
    taskId: task.id,
    recurrenceOwner: "todoist",
    seriesId: task.id,
    masterEventId: master.id,
    activeInstanceId: active.id,
    originalStart: "2026-09-14",
    activeEffectiveStart: activeStart,
    updatedAt: "2026-09-06T02:00:00Z",
  };
  const writes = [];
  const calendar = {
    async getEvent(id) {
      assert.equal(id, master.id);
      return master;
    },
    async listInstances(id) {
      assert.equal(id, master.id);
      return [active];
    },
    async upsertEvent(event, existingId) {
      writes.push({ event, existingId });
      assert.equal(existingId, active.id);
      return {
        ...active,
        ...event,
        id: active.id,
        recurringEventId: master.id,
        originalStartTime: active.originalStartTime,
      };
    },
  };
  return { master, active, task, mapping, writes, calendar, todoist: {} };
}

function delivery(task, oldTask) {
  return {
    id: "delivery-1",
    kind: "todoist",
    profile: "home",
    mode: "aws",
    receivedAt: "2026-09-06T02:20:01Z",
    headers: {},
    body: JSON.stringify({
      event_name: "item:updated",
      event_data: task,
      event_data_extra: { old_item: oldTask },
    }),
  };
}

test("Todoist can move an active Calendar exception back to its logical slot without changing the RRULE master", async () => {
  const f = fixture();
  const state = new FakeState(f.mapping);
  const sync = new ProjectAwareSynchronizer(state, undefined, async () => ({ calendar: f.calendar, todoist: f.todoist }));
  const oldTask = { ...f.task, due: { ...f.task.due, date: "2026-09-16" } };

  await sync.process(delivery(f.task, oldTask));

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].existingId, f.active.id);
  assert.equal(f.writes[0].event.start.date, "2026-09-14");
  assert.equal(f.writes[0].event.recurrence, undefined);
  assert.equal(state.mapping.eventId, f.master.id);
  assert.equal(state.mapping.masterEventId, f.master.id);
  assert.equal(state.mapping.activeInstanceId, f.active.id);
  assert.equal(state.mutations, 1);
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_active_exception_written_back");
  assert.equal(state.audits.at(-1).detail.visuallyRejoinedSeries, true);
});

test("Todoist can rename an active Calendar exception back to the series title without changing the master", async () => {
  const f = fixture({ activeStart: "2026-09-14", activeSummary: "Special weekly task", taskSummary: "Weekly task" });
  const state = new FakeState(f.mapping);
  const sync = new ProjectAwareSynchronizer(state, undefined, async () => ({ calendar: f.calendar, todoist: f.todoist }));
  const oldTask = { ...f.task, content: "Special weekly task" };

  await sync.process(delivery(f.task, oldTask));

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].existingId, f.active.id);
  assert.equal(f.writes[0].event.summary, "Weekly task");
  assert.equal(f.writes[0].event.recurrence, undefined);
  assert.equal(state.mapping.eventId, f.master.id);
  assert.equal(state.audits.at(-1).detail.visuallyRejoinedSeries, true);
});

test("stale Todoist exception edits cannot overwrite a newer Calendar exception", async () => {
  const f = fixture();
  const state = new FakeState(f.mapping);
  state.versionAccepted = false;
  const sync = new ProjectAwareSynchronizer(state, undefined, async () => ({ calendar: f.calendar, todoist: f.todoist }));
  const oldTask = { ...f.task, due: { ...f.task.due, date: "2026-09-16" } };

  await sync.process(delivery(f.task, oldTask));

  assert.equal(f.writes.length, 0);
  assert.equal(state.mutations, 0);
  assert.equal(state.audits.at(-1).action, "todoist_recurrence_active_exception_stale_version_suppressed");
});
