import assert from "node:assert/strict";
import test from "node:test";
import { applyApprovedFutureSeriesSplit } from "../dist/future-split-execution.js";
import { profiles } from "../dist/config.js";

const original = () => ({
  id: "old-may-master", etag: '"old-v1"', status: "confirmed",
  summary: "Replace battery smoke alarm", description: "",
  start: { date: "2025-05-03" }, end: { date: "2025-05-04" },
  recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1"],
  extendedProperties: { shared: { taskId: "smoke-task", syncSource: "todoist-calendar-sync" } },
});
const todo = () => ({
  id: "smoke-task", project_id: profiles.antonio.todoistProjectId,
  content: "Replace battery smoke alarm", description: "",
  due: { date: "2027-07-01", string: "every 2 years", is_recurring: true },
  updated_at: "2026-10-19T09:00:00Z",
});
const today = new Date("2026-10-19T12:00:00Z");
const interval = (start, end, value) => {
  const stamp = Date.parse(value + "T12:00:00Z");
  return stamp >= Date.parse(start) && stamp < Date.parse(end);
};
const instance = (master, date) => ({
  id: master.id + "_" + date.replaceAll("-", ""),
  recurringEventId: master.id, originalStartTime: { date },
  status: "confirmed", summary: master.summary,
  start: { date }, end: { date: new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10) },
});

function fixture({ duplicateTask = false, duplicateCalendar = false, modifiedFuture = false,
  failFirstCreate = false, tombstone = undefined, conflictingOwner = undefined } = {}) {
  const task = todo();
  const master = original();
  const events = new Map([[master.id, master]]);
  const calls = [];
  let created = 0;
  let failedOnce = false;
  const state = {
    owner: conflictingOwner,
    link: undefined,
    split: undefined,
    async beginFutureSeriesSplit(profile, taskId, oldMasterId, newMasterId) {
      if (this.split && (this.split.profile !== profile || this.split.taskId !== taskId
        || this.split.oldMasterId !== oldMasterId || this.split.newMasterId !== newMasterId)) {
        throw new Error("another split already owns the task");
      }
      if (!this.split) {
        this.split = { profile, taskId, oldMasterId, newMasterId, status: "pending" };
        calls.push("split-pending");
      }
    },
    async completeFutureSeriesSplit(profile, taskId, newMasterId) {
      assert.equal(this.split?.profile, profile);
      assert.equal(this.split?.taskId, taskId);
      assert.equal(this.split?.newMasterId, newMasterId);
      this.split.status = "completed";
      calls.push("split-completed");
    },
    async getMappingByTaskAnyProfile() { return this.owner; },
    async getMappingByEvent() { return undefined; },
    async getCalendarProjectionTombstone() { return tombstone; },
    async getCompletedCalendarProjectionByEvent() { return undefined; },
    async listCompletedCalendarProjectionsByTaskAnyProfile() { return []; },
    async getRecurrenceLink(_profile, seriesId) { return seriesId === task.id ? this.link : undefined; },
    async putNewRecurrenceMappingIfUnowned(mapping, link) {
      if (this.owner || this.link) return false;
      this.owner = mapping; this.link = link;
      calls.push("atomic-mapping");
      return true;
    },
    async assertHistoricalSeriesUnowned() {},
    async audit(_profile, action, detail) { calls.push([action, detail]); },
  };
  const calendar = {
    async getTimeZone() { return "Europe/London"; },
    async listExplicitSeriesExceptions() { return []; },
    async findByTodoistTaskId(id) {
      const linked = [...events.values()].filter((event) => event.extendedProperties?.shared?.taskId === id);
      if (linked.length > 1) throw new Error("ambiguous event identity");
      return linked[0];
    },
    async getEvent(id) {
      const event = events.get(id);
      if (!event) throw new Error("missing Calendar event");
      return event;
    },
    async listInstancesInWindow(id, from, to) {
      const event = events.get(id);
      const dates = id === master.id
        ? ["2025-05-03", "2026-05-03", "2027-05-03", "2028-05-03"]
        : ["2027-07-01", "2029-07-01", "2031-07-01"];
      const filtered = dates.filter((date) => interval(from, to, date));
      const cutoff = event.recurrence?.[0]?.match(/UNTIL=(\d{4})(\d{2})(\d{2})/)?.slice(1).join("-");
      return filtered.filter((date) => !cutoff || date <= cutoff).map((date) => {
        const entry = instance(event, date);
        if (id === master.id && modifiedFuture && date === "2027-05-03") {
          entry.start.date = "2027-05-04";
        }
        return entry;
      });
    },
    async listOccurrencesInWindow(from, to) {
      const all = [...events.values()].flatMap((event) => {
        const date = event.id === master.id ? "2027-05-03" : "2027-07-01";
        return interval(from, to, date) ? [instance(event, date)] : [];
      });
      if (duplicateCalendar) all.push({
        ...instance(master, "2027-07-01"), id: "competing-master_20270701", recurringEventId: "competing-master",
      });
      return all;
    },
    async upsertEventIfUnchanged(event, id, etag) {
      const existing = events.get(id);
      if (existing?.etag !== etag) throw new Error("ETag precondition failed");
      calls.push("cap-old");
      const updated = { ...event, status: "confirmed", etag: '"old-v2"' };
      events.set(id, updated);
      return updated;
    },
    async createFutureMasterOnce(event, historyId) {
      assert.equal(historyId, master.id);
      if (failFirstCreate && !failedOnce) {
        failedOnce = true;
        throw new Error("Google 503 after historical cap");
      }
      const previous = events.get(event.id);
      if (previous) {
        assert.equal(previous.start.date, event.start.date);
        assert.deepEqual(previous.recurrence, event.recurrence);
        return previous;
      }
      created += 1;
      calls.push("create-future");
      const next = { ...event, status: "confirmed", etag: '"new-v1"' };
      events.set(event.id, next);
      return next;
    },
  };
  const todoist = {
    async listProjectComments() { return []; },
    async listTaskComments() { return []; },
    async listTasks() { return duplicateTask ? [task, { ...task, id: "other-smoke-task" }] : [task]; },
    async getTask() { return task; },
    async findComment() { return undefined; },
    async upsertComment() { calls.push("project-comment"); return { id: "new-project-comment" }; },
  };
  return { state, pair: { calendar, todoist }, events, task, calls, get created() { return created; } };
}

test("future-only approved split retains historical master and creates biennial July series", async () => {
  const fixtureValue = fixture();
  const { mapping, plan } = await applyApprovedFutureSeriesSplit("antonio", fixtureValue.task,
    fixtureValue.events.get("old-may-master"), fixtureValue.pair, fixtureValue.state, { now: today });
  assert.equal(plan.previousOccurrence, "2026-05-03");
  assert.equal(plan.newStart, "2027-07-01");
  assert.equal(mapping.recurrenceOwner, "todoist");
  assert.equal(mapping.masterEventId, plan.newMasterId);
  assert.equal(mapping.activeInstanceId, plan.newMasterId + "_20270701");
  assert.equal(fixtureValue.events.get("old-may-master").recurrence[0], plan.truncatedRule);
  assert.equal(fixtureValue.events.get("old-may-master").extendedProperties.shared.syncHistoryOnly, "true");
  assert.equal(fixtureValue.events.get("old-may-master").extendedProperties.shared.taskId, undefined);
  assert.equal(fixtureValue.events.get(plan.newMasterId).extendedProperties.shared.syncHistoryMasterId, plan.oldMasterId);
  assert.equal(fixtureValue.created, 1);
  assert.deepEqual(fixtureValue.calls.filter((x) => typeof x === "string"), [
    "split-pending", "cap-old", "create-future", "project-comment", "atomic-mapping", "split-completed",
  ]);
  const again = await applyApprovedFutureSeriesSplit("antonio", fixtureValue.task,
    fixtureValue.events.get("old-may-master"), fixtureValue.pair, fixtureValue.state, { now: today });
  assert.equal(again.resumed, true);
  assert.equal(fixtureValue.created, 1);
  assert.equal(fixtureValue.calls.filter((x) => x === "atomic-mapping").length, 1);
});

test("a partial failure after capping history resumes without duplicating future occurrences", async () => {
  const f = fixture({ failFirstCreate: true });
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, { now: today }), /Google 503/);
  assert.equal(f.events.get("old-may-master").extendedProperties.shared.syncHistoryOnly, "true");
  assert.equal(f.created, 0);
  assert.equal(f.state.owner, undefined);
  assert.equal(f.state.split?.status, "pending", "hourly reconciliation must see the durable guard");
  const resumed = await applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, { now: today });
  assert.equal(resumed.resumed, true);
  assert.equal(f.created, 1);
  assert.equal(f.state.owner.eventId, resumed.plan.newMasterId);
  assert.equal(f.state.split.status, "completed");
});

test("changed future Calendar exception blocks all writes", async () => {
  const f = fixture({ modifiedFuture: true });
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, { now: today }), /Upcoming old-series occurrence/);
  assert.deepEqual(f.calls, []);
});

test("competing task, calendar master, ownership or tombstone each blocks before writes", async () => {
  for (const options of [
    { duplicateTask: true }, { duplicateCalendar: true },
    { conflictingOwner: { taskId: "smoke-task", eventId: "other" } },
    { tombstone: { sourceUpdatedAt: "2026-10-01" } },
  ]) {
    const f = fixture(options);
    await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
      f.events.get("old-may-master"), f.pair, f.state, { now: today }));
    assert.deepEqual(f.calls, []);
    assert.equal(f.created, 0);
  }
});
