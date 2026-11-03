import assert from "node:assert/strict";
import test from "node:test";
import { assessTodoistPhaseBProviders } from "../dist/todoist-calendar-phase-b-evidence.js";

const dates = ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"];
const phrase = "every 2, 15, 27";
function task(date = dates[0], dueString = phrase, extras = {}) {
  return { id: "task-b", project_id: "test-project", content: "Phase B",
    is_completed: false,
    due: { date, string: dueString, is_recurring: true }, ...extras };
}
function master(anchor = dates[0], rrule = "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27") {
  return { id: "master-b", status: "confirmed", etag: "etag-1",
    start: { date: anchor }, end: { date: "2027-01-03" },
    recurrence: [rrule], extendedProperties: { shared: {
      taskId: "task-b", syncRecurrenceOwner: "todoist",
      todoistAnchorStart: anchor, todoistRecurrence: phrase,
    } } };
}
function instances(masterId = "master-b", values = dates) {
  return values.map((date, i) => ({
    id: "instance-" + i, status: "confirmed", recurringEventId: masterId,
    originalStartTime: { date }, start: { date },
  }));
}
function fixture(overrides = {}) {
  const source = {
    taskId: "task-b", todoistProjectId: "test-project", masterId: "master-b",
    anchor: { start: dates[0], source: "verified_original_schedule" },
    beforeCompletion: task(), afterCompletion: task(dates[1]),
    ...overrides.source,
  };
  const calendarMaster = overrides.master || master();
  const calls = [];
  const providers = {
    todoist: {
      async getTask(id) { calls.push("getTask"); assert.equal(id, "task-b");
        if (overrides.todoistError) throw new Error("read failure");
        return structuredClone(overrides.latest || source.afterCompletion); },
    },
    calendar: {
      async getEvent(id) { calls.push("getEvent"); assert.equal(id, "master-b");
        if (overrides.calendarError) throw new Error("provider read failed");
        return structuredClone(calendarMaster); },
      async findByTodoistTaskId(id) { calls.push("findByTodoistTaskId"); assert.equal(id, "task-b");
        return structuredClone(overrides.linked === undefined ? calendarMaster : overrides.linked); },
      async listExplicitSeriesExceptions(id) { calls.push("listExplicitSeriesExceptions");
        assert.equal(id, "master-b"); return structuredClone(overrides.exceptions || []); },
      async listInstancesInWindow(id, from, through) {
        calls.push("listInstancesInWindow"); assert.equal(id, "master-b");
        assert.ok(from < dates[0] + "T00:00:00Z");
        assert.ok(through > dates[3] + "T00:00:00Z");
        return structuredClone(overrides.instances || instances());
      },
      async getTimeZone() { calls.push("getTimeZone"); return overrides.calendarZone || "Europe/London"; },
    },
  };
  return { source, providers, calls };
}
test("Phase B collector independently reads Todoist and Calendar with no provider writes", async () => {
  const f = fixture();
  const result = await assessTodoistPhaseBProviders(f.source, f.providers);
  assert.equal(result.disposition, "native_exact");
  assert.equal(result.reason, "verified_equivalent");
  assert.deepEqual(result.observations, {
    providerReadback: true, instanceCount: 4, explicitExceptionCount: 0,
  });
  assert.deepEqual(f.calls, [
    "getTask", "getEvent", "findByTodoistTaskId",
    "listExplicitSeriesExceptions", "listInstancesInWindow",
  ]);
});

test("no new native approval without source anchor or candidate family", async () => {
  for (const change of [
    { source: { anchor: undefined } },
    { source: { beforeCompletion: task(dates[0], "every! 2 days") } },
  ]) {
    const f = fixture(change);
    const result = await assessTodoistPhaseBProviders(f.source, f.providers);
    assert.notEqual(result.disposition, "native_exact");
    assert.deepEqual(f.calls, [], "ineligible candidates do not call providers");
  }
});

test("wrong profile, stale completion snapshots and readback disagreement fail closed", async () => {
  for (const change of [
    { source: { todoistProjectId: "other-project" } },
    { source: { afterCompletion: task(dates[1], phrase, { project_id: "other-project" }) } },
    { source: { afterCompletion: task(dates[2]) } },
    { latest: task(dates[2]) },
    { latest: task(dates[1], phrase, { is_deleted: true }) },
    { todoistError: true },
  ]) {
    const f = fixture(change);
    const result = await assessTodoistPhaseBProviders(f.source, f.providers);
    assert.equal(result.disposition, "rolling_required", JSON.stringify(change));
  }
});

test("Calendar linking, complete exception inventory and stable master identity are mandatory", async () => {
  for (const change of [
    { linked: { ...master(), id: "other-master" } },
    { exceptions: [{ id: "exception", recurringEventId: "master-b", status: "cancelled" }] },
    { master: { ...master(), etag: undefined } },
    { instances: instances().slice(0, 2) },
    { instances: instances().map((item, i) => i === 1
      ? { ...item, start: { date: "2027-01-16" } } : item) },
    { calendarError: true },
  ]) {
    const f = fixture(change);
    const result = await assessTodoistPhaseBProviders(f.source, f.providers);
    assert.equal(result.disposition, "rolling_required", JSON.stringify(change));
  }
});

test("captured quarterly provider normalization can be assessed without changing cadence", async () => {
  const qDates = ["2027-01-15", "2027-04-15", "2027-07-15", "2027-10-15"];
  const before = task(qDates[0], "every quarter");
  const after = task(qDates[1], "every 3 months");
  const qMaster = master(qDates[0], "RRULE:FREQ=MONTHLY;INTERVAL=3");
  qMaster.extendedProperties.shared.todoistRecurrence = "every quarter";
  const f = fixture({
    source: { anchor: { start: qDates[0], source: "verified_original_schedule" },
      beforeCompletion: before, afterCompletion: after },
    master: qMaster, instances: instances("master-b", qDates),
  });
  const result = await assessTodoistPhaseBProviders(f.source, f.providers);
  assert.equal(result.disposition, "native_exact");
});

test("timed provider observations must match Europe/London wall time across BST", async () => {
  const localDates = ["2027-03-19", "2027-04-02", "2027-04-16", "2027-04-30"];
  const dueTimes = [
    "2027-03-19T09:00:00+00:00",
    "2027-04-02T09:00:00+01:00",
    "2027-04-16T09:00:00+01:00",
    "2027-04-30T09:00:00+01:00",
  ];
  const timed = (dateTime) => task(undefined, "every other Friday at 9am",
    { due: { datetime: dateTime, string: "every other Friday at 9am",
      is_recurring: true, timezone: "Europe/London" } });
  const before = timed(dueTimes[0]);
  const after = timed(dueTimes[1]);
  const m = master(dueTimes[0], "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  m.start = { dateTime: dueTimes[0], timeZone: "Europe/London" };
  m.extendedProperties.shared.todoistRecurrence = "every other friday at 9am";
  const occ = dueTimes.map((dateTime, i) => ({
    id: "timed-" + i, status: "confirmed", recurringEventId: "master-b",
    start: { dateTime, timeZone: "Europe/London" },
    originalStartTime: { dateTime, timeZone: "Europe/London" },
  }));
  const f = fixture({
    source: {
      anchor: { start: dueTimes[0], timeZone: "Europe/London", source: "verified_original_schedule" },
      beforeCompletion: before, afterCompletion: after,
    }, master: m, instances: occ,
  });
  const result = await assessTodoistPhaseBProviders(f.source, f.providers);
  assert.equal(result.disposition, "native_exact");
  assert.equal(f.calls.includes("getTimeZone"), true);
  const mismatch = fixture({
    source: f.source, master: m, instances: occ, calendarZone: "UTC",
  });
  const declined = await assessTodoistPhaseBProviders(mismatch.source, mismatch.providers);
  assert.equal(declined.reason, "timezone_not_verified");
});
