import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarOwnedRecurringTaskPayload,
  calendarOwnedTodoistRecurrence,
  matchesCalendarOwnedRecurringTask,
} from "../dist/calendar-owned-todoist-recurrence.js";
import { Todoist } from "../dist/providers.js";

function weeklyMaster(start, rule = "RRULE:FREQ=WEEKLY;COUNT=4") {
  return {
    id: "master", iCalUID: "series", summary: "Task", description: "",
    start: { dateTime: start, timeZone: "Europe/London" },
    recurrence: [rule],
  };
}

function instances(dates, cancelledIndex = -1) {
  return dates.map((date, index) => ({
    id: `instance-${index + 1}`, recurringEventId: "master", iCalUID: "series",
    status: index === cancelledIndex ? "cancelled" : "confirmed",
    originalStartTime: { dateTime: date, timeZone: "Europe/London" },
    start: { dateTime: date, timeZone: "Europe/London" },
  }));
}

test("finite weekly COUNT maps to one anchored Todoist recurrence including canceled dates and an inclusive end", () => {
  const master = weeklyMaster("2026-11-04T14:00:00Z");
  const schedule = instances([
    "2026-11-04T14:00:00Z", "2026-11-11T14:00:00Z",
    "2026-11-18T14:00:00Z", "2026-11-25T14:00:00Z",
  ], 1);
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  assert.equal(recurrence.dueString, "every Wednesday at 2:00pm starting 4 Nov 2026 ending 25 Nov 2026");
  const payload = calendarOwnedRecurringTaskPayload({ ...schedule[0], summary: "Task", description: "" }, recurrence);
  assert.equal(payload.due.is_recurring, true);
  assert.equal(payload.due.string, recurrence.dueString);
  // Finite Calendar-owned rules must not enter the generic Todoist-owned
  // Calendar projection path, which cannot preserve their inclusive end.
});

test("weekly recurrence phrase preserves Calendar wall time through the London DST boundary", () => {
  const master = weeklyMaster("2027-03-21T09:00:00Z");
  const schedule = instances([
    "2027-03-21T09:00:00Z", "2027-03-28T08:00:00Z",
    "2027-04-04T08:00:00Z", "2027-04-11T08:00:00Z",
  ]);
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  assert.equal(recurrence.dueString, "every Sunday at 9:00am starting 21 Mar 2027 ending 11 Apr 2027");
});

test("all-day finite weekly recurrence preserves date-only Todoist due values", () => {
  const master = { ...weeklyMaster("2099-09-02"), start: { date: "2099-09-02" } };
  const schedule = [2, 9, 16, 23].map((day, index) => ({
    id: `all-day-${day}`, recurringEventId: master.id, status: index === 1 ? "cancelled" : "confirmed",
    originalStartTime: { date: `2099-09-${String(day).padStart(2, "0")}` },
    start: { date: `2099-09-${String(day).padStart(2, "0")}` }, end: { date: `2099-09-${String(day + 1).padStart(2, "0")}` },
  }));
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  assert.equal(recurrence.dueString, "every Wednesday starting 2 Sep 2099 ending 23 Sep 2099");
  const payload = calendarOwnedRecurringTaskPayload(schedule[0], recurrence);
  assert.equal(payload.due.date, "2099-09-02");
  assert.equal(payload.due.datetime, undefined);
  assert.equal(matchesCalendarOwnedRecurringTask({
    id: "task", content: "Task", due: { date: "2099-09-02", is_recurring: true, string: recurrence.dueString },
  }, schedule[0], recurrence), true);
});

test("unsupported, unbounded, or incomplete weekly recurrence inventories fail closed", () => {
  const master = weeklyMaster("2026-11-04T14:00:00Z", "RRULE:FREQ=DAILY;COUNT=4");
  const schedule = instances(["2026-11-04T14:00:00Z"]);
  assert.equal(calendarOwnedTodoistRecurrence(master, schedule, "Europe/London"), undefined);
  assert.equal(calendarOwnedTodoistRecurrence(weeklyMaster("2026-11-04T14:00:00Z", "RRULE:FREQ=WEEKLY"), schedule, "Europe/London"), undefined);
  assert.equal(calendarOwnedTodoistRecurrence(weeklyMaster("2026-11-04T14:00:00Z"), schedule, "Europe/London"), undefined);
});

test("recurring task readback requires the exact finite rule, end date, and active occurrence", () => {
  const master = weeklyMaster("2026-11-04T14:00:00Z");
  const schedule = instances([
    "2026-11-04T14:00:00Z", "2026-11-11T14:00:00Z",
    "2026-11-18T14:00:00Z", "2026-11-25T14:00:00Z",
  ]);
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  const active = schedule[0];
  const task = {
    id: "task", content: "Task", description: "",
    due: { datetime: "2026-11-04T14:00:00Z", is_recurring: true, string: recurrence.dueString },
  };
  assert.equal(matchesCalendarOwnedRecurringTask(task, active, recurrence), true);
  assert.equal(matchesCalendarOwnedRecurringTask({ ...task, due: { ...task.due, string: "every Wednesday" } }, active, recurrence), false);
  assert.equal(matchesCalendarOwnedRecurringTask({ ...task, due: { ...task.due, datetime: "2026-11-11T14:00:00Z" } }, active, recurrence), false);
});

test("Todoist timezone lookup reads only user resource and exposes the IANA timezone", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ user: {
      timezone: "GMT +0:00", tz_info: { timezone: "Europe/London" }, token: "must-not-be-logged",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const zone = await new Todoist("secret-token").getTimeZone();
  assert.equal(zone, "Europe/London");
  assert.equal(request.url, "https://api.todoist.com/api/v1/sync");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.get("authorization"), "Bearer secret-token");
  assert.deepEqual(JSON.parse(new URLSearchParams(request.init.body).get("resource_types")), ["user"]);
  assert.equal(new URLSearchParams(request.init.body).get("sync_token"), "*");
});
