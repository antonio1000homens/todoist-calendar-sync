import assert from "node:assert/strict";
import test from "node:test";
import { applyApprovedFutureSeriesSplit } from "../dist/future-split-execution.js";
import { planFutureSeriesSplit } from "../dist/recurrence-split.js";
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
  failFirstCreate = false, normalizeCappedRule = false, tombstone = undefined, conflictingOwner = undefined,
  expiredUntil = undefined } = {}) {
  const task = todo();
  const master = original();
  if (expiredUntil) master.recurrence = [`RRULE:FREQ=YEARLY;UNTIL=${expiredUntil}`];
  const events = new Map([[master.id, master]]);
  const calls = [];
  let created = 0;
  let failedOnce = false;
  const state = {
    owner: conflictingOwner,
    link: undefined,
    split: undefined,
    async beginFutureSeriesSplit(profile, taskId, oldMasterId, newMasterId, previousOccurrence) {
      if (this.split && (this.split.profile !== profile || this.split.taskId !== taskId
        || this.split.oldMasterId !== oldMasterId || this.split.newMasterId !== newMasterId)) {
        throw new Error("another split already owns the task");
      }
      if (!this.split) {
        this.split = { profile, taskId, oldMasterId, newMasterId, previousOccurrence, status: "pending" };
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
      const normalized = normalizeCappedRule && event.recurrence?.[0]
        ? event.recurrence[0].replace(
          /^(RRULE:FREQ=YEARLY);INTERVAL=(\d+);UNTIL=(\d{8})$/,
          "$1;UNTIL=$3;INTERVAL=$2",
        ) : event.recurrence?.[0];
      const updated = {
        ...event, ...(normalized ? { recurrence: [normalized] } : {}),
        status: "confirmed", etag: '"old-v2"',
      };
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

test("Google reorders UNTIL before INTERVAL but the split verifies and completes", async () => {
  const f = fixture({ normalizeCappedRule: true });
  const { plan, mapping } = await applyApprovedFutureSeriesSplit(
    "antonio", f.task, f.events.get("old-may-master"), f.pair, f.state, { now: today },
  );
  assert.equal(f.events.get("old-may-master").recurrence[0],
    "RRULE:FREQ=YEARLY;UNTIL=20260503;INTERVAL=1");
  assert.equal(mapping.eventId, plan.newMasterId);
  assert.equal(f.created, 1);
  assert.equal(f.state.split.status, "completed");
});

test("an already-capped Google-normalized master resumes without repeating historical PUT", async () => {
  const f = fixture({ normalizeCappedRule: true, failFirstCreate: true });
  await assert.rejects(applyApprovedFutureSeriesSplit(
    "antonio", f.task, f.events.get("old-may-master"), f.pair, f.state, { now: today },
  ), /Google 503/);
  assert.equal(f.events.get("old-may-master").recurrence[0],
    "RRULE:FREQ=YEARLY;UNTIL=20260503;INTERVAL=1");
  assert.equal(f.state.split.status, "pending");
  const result = await applyApprovedFutureSeriesSplit(
    "antonio", f.task, f.events.get("old-may-master"), f.pair, f.state, { now: today },
  );
  assert.equal(result.resumed, true);
  assert.equal(f.created, 1);
  assert.equal(f.state.split.status, "completed");
  assert.equal(f.calls.filter((entry) => entry === "cap-old").length, 1);
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

test("an explicit exception in a distant future year blocks the split before Calendar mutations", async () => {
  const f = fixture();
  f.pair.calendar.listExplicitSeriesExceptions = async () => [{
    id: "old-may-master_20490503", recurringEventId: "old-may-master",
    originalStartTime: { date: "2049-05-03" }, status: "cancelled",
  }];
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, { now: today }), /explicit Calendar recurrence exception/);
  assert.deepEqual(f.calls, []);
});

test("future instance title-only and description-only changes are never truncated", async () => {
  for (const field of ["summary", "description"]) {
    const f = fixture();
    const originalList = f.pair.calendar.listInstancesInWindow;
    f.pair.calendar.listInstancesInWindow = async (...args) => {
      const items = await originalList(...args);
      return items.map((item) => item.start?.date === "2027-05-03"
        ? { ...item, [field]: "User-customized occurrence" } : item);
    };
    await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
      f.events.get("old-may-master"), f.pair, f.state, { now: today }), /Upcoming old-series occurrence/);
    assert.deepEqual(f.calls, []);
  }
});

test("Calendar instance owned by another mapping or completed history blocks before cap", async () => {
  const f = fixture();
  f.state.assertHistoricalSeriesUnowned = async () => {
    throw new Error("Another Calendar master/instance mapping still owns historical occurrences");
  };
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, { now: today }), /instance mapping/);
  assert.deepEqual(f.calls, []);
});

test("project mapping comments with competing owner, master or completion block first write", async () => {
  for (const override of [
    { recurrenceOwner: "calendar" },
    { masterEventId: "different-master" },
    { completedThroughOriginalStart: "2026-05-03" },
  ]) {
    const f = fixture();
    const payload = {
      schemaVersion: 1, profile: "antonio",
      projectId: profiles.antonio.todoistProjectId,
      taskId: "smoke-task", eventId: "old-may-master",
      mappingRevision: 1, updatedAt: "2026-10-19T12:00:00Z", ...override,
    };
    f.pair.todoist.listProjectComments = async () => [{
      id: "comment-1", content: "todoist-calendar-sync:mapping:v1\n" + JSON.stringify(payload),
    }];
    await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
      f.events.get("old-may-master"), f.pair, f.state, { now: today }), /project mapping comments conflict/);
    assert.deepEqual(f.calls, []);
  }
});

test("stale Calendar ETag, adjusted cutoff or changed timezone require a new approval", async () => {
  const f = fixture();
  const approved = planFutureSeriesSplit("antonio", f.task, f.events.get("old-may-master"),
    new Date("2027-05-02T10:00:00Z"), "Europe/London");
  const opts = { now: new Date("2027-05-04T10:00:00Z"), approvedPlan: approved, approvedEtag: '"old-v1"' };
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, opts), /Approved future-series cutover changed/);
  assert.deepEqual(f.calls, []);

  f.events.get("old-may-master").etag = '"changed-etag"';
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, {
      now: today, approvedEtag: '"old-v1"',
    }), /ETag changed/);
  assert.deepEqual(f.calls, []);

  f.pair.calendar.getTimeZone = async () => "America/New_York";
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, {
      now: today, approvedPlan: approved,
    }), /timezone changed/);
  assert.deepEqual(f.calls, []);
});

test("an interrupted split may resume across a new yearly anniversary with unchanged approved cutoff", async () => {
  const f = fixture({ failFirstCreate: true });
  const approved = planFutureSeriesSplit("antonio", f.task, f.events.get("old-may-master"),
    today, "Europe/London");
  const originalEtag = f.events.get("old-may-master").etag;
  const options = { now: today, approvedPlan: approved, approvedEtag: originalEtag };
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, options), /Google 503/);
  const replay = await applyApprovedFutureSeriesSplit("antonio", f.task,
    f.events.get("old-may-master"), f.pair, f.state, {
      now: new Date("2027-05-04T12:00:00Z"), approvedPlan: approved,
      approvedEtag: originalEtag,
    });
  assert.equal(replay.plan.previousOccurrence, "2026-05-03");
  assert.equal(replay.resumed, true);
  assert.equal(f.created, 1);
});

test("approved repair leaves an expired-before-anchor Calendar RRULE unchanged and preserves audit lineage", async () => {
  const f = fixture({ expiredUntil: "20231231" });
  const old = f.events.get("old-may-master");
  const approved = planFutureSeriesSplit("antonio", f.task, old, today, "Europe/London");
  const result = await applyApprovedFutureSeriesSplit("antonio", f.task, old, f.pair, f.state, {
    now: today, approvedPlan: approved, approvedEtag: old.etag,
  });
  assert.equal(result.plan.expiredUntil, "2023-12-31");
  assert.equal(result.plan.previousOccurrence, undefined);
  assert.equal(f.state.split.previousOccurrence, undefined, "the DynamoDB guard must not claim fabricated history");
  assert.equal(f.events.get(old.id).extendedProperties.shared.syncHistoryCutoff, undefined);
  assert.equal(f.events.get(result.plan.newMasterId).extendedProperties.shared.syncHistoryCutoff, undefined);
  const audit = f.calls.find(value => Array.isArray(value) && value[0] === "manual_future_series_split_applied")?.[1];
  assert.equal(audit?.priorOccurrence, undefined, "audit must omit nonexistent historical occurrence");
  assert.equal(audit?.expiredUntil, "2023-12-31");
  assert.equal(result.plan.truncatedRule, "RRULE:FREQ=YEARLY;UNTIL=20231231");
  assert.equal(f.events.get(old.id).recurrence[0], "RRULE:FREQ=YEARLY;UNTIL=20231231");
  assert.equal(f.events.get(old.id).start.date, "2025-05-03");
  assert.equal(f.events.get(result.plan.newMasterId).start.date, "2027-07-01");
  assert.equal(f.state.owner.masterEventId, result.plan.newMasterId);
  assert.ok(f.calls.some(value => Array.isArray(value) && value[0] === "manual_future_series_split_applied"));
  const retry = await applyApprovedFutureSeriesSplit("antonio", f.task, f.events.get(old.id),
    f.pair, f.state, { now: today, approvedPlan: approved, approvedEtag: old.etag });
  assert.equal(retry.resumed, true);
  assert.equal(f.created, 1);
});

test("expired rule with an existing prior occurrence is retained without extending the history", async () => {
  const f = fixture({ expiredUntil: "20251231" });
  const result = await applyApprovedFutureSeriesSplit("antonio", f.task, f.events.get("old-may-master"),
    f.pair, f.state, { now: today });
  assert.equal(result.plan.historicalLastOccurrence, "2025-05-03");
  assert.equal(result.plan.previousOccurrence, "2025-05-03");
  assert.equal(f.state.split.previousOccurrence, "2025-05-03");
  assert.equal(f.events.get("old-may-master").extendedProperties.shared.syncHistoryCutoff, "2025-05-03");
  assert.equal(f.events.get("old-may-master").recurrence[0], "RRULE:FREQ=YEARLY;UNTIL=20251231");
});

test("approval rejects a stale Todoist due shape even when date and yearly RRULE are unchanged", async () => {
  const f = fixture({ expiredUntil: "20231231" });
  const old = f.events.get("old-may-master");
  const approved = planFutureSeriesSplit("antonio", f.task, old, today, "Europe/London");
  const mutatedTask = { ...f.task, due: { ...f.task.due, timezone: "Europe/London", lang: "en" } };
  await assert.rejects(
    applyApprovedFutureSeriesSplit("antonio", mutatedTask, old, f.pair, f.state,
      { now: today, approvedPlan: approved, approvedEtag: old.etag }),
    /Approved future-series cutover changed \(approvedTaskFingerprint\)/,
  );
  assert.deepEqual(f.calls, []);
});

test("a live due-shape mutation without a changed updated_at is rejected before the guard", async () => {
  const f = fixture({ expiredUntil: "20231231" });
  const old = f.events.get("old-may-master");
  f.pair.todoist.getTask = async () => ({ ...f.task, due: { ...f.task.due, datetime: "2027-07-01T09:00:00Z" } });
  await assert.rejects(applyApprovedFutureSeriesSplit("antonio", f.task, old, f.pair, f.state,
    { now: today }), /changed after approval/);
  assert.deepEqual(f.calls, []);
});

test("task or Calendar updates between approved preview and first write block the split", async () => {
  for (const provider of ["todoist", "calendar"]) {
    const f = fixture({ expiredUntil: "20231231" });
    const old = structuredClone(f.events.get("old-may-master"));
    const approved = planFutureSeriesSplit("antonio", f.task, old, today, "Europe/London");
    if (provider === "todoist") {
      f.pair.todoist.getTask = async () => ({ ...f.task, updated_at: "2026-10-22T19:00:00Z" });
    } else {
      f.events.get(old.id).etag = '"outside-update"';
    }
    await assert.rejects(
      applyApprovedFutureSeriesSplit("antonio", f.task, old, f.pair, f.state,
        { now: today, approvedPlan: approved, approvedEtag: old.etag }),
      /changed after approval/,
    );
    assert.deepEqual(f.calls, [], provider + " changed before a guard or provider mutation");
  }
});
