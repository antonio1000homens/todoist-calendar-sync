import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarOwnedRecurringTaskPayload,
  calendarOwnedRecurringTaskReadback,
  calendarOwnedTodoistRecurrence,
  matchesCalendarOwnedRecurringRule,
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
  assert.equal(recurrence.dueString, "every Wednesday at 2:00pm starting 4 Nov 2026 and ending 25 Nov 2026");
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
  assert.equal(recurrence.dueString, "every Sunday at 9:00am starting 21 Mar 2027 and ending 11 Apr 2027");
});

test("all-day finite weekly recurrence preserves date-only Todoist due values", () => {
  const master = { ...weeklyMaster("2099-09-02"), start: { date: "2099-09-02" } };
  const schedule = [2, 9, 16, 23].map((day, index) => ({
    id: `all-day-${day}`, recurringEventId: master.id, status: index === 1 ? "cancelled" : "confirmed",
    originalStartTime: { date: `2099-09-${String(day).padStart(2, "0")}` },
    start: { date: `2099-09-${String(day).padStart(2, "0")}` }, end: { date: `2099-09-${String(day + 1).padStart(2, "0")}` },
  }));
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  assert.equal(recurrence.dueString, "every Wednesday starting 2 Sep 2099 and ending 23 Sep 2099");
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

test("recurring task readback accepts Todoist date-text normalization but rejects changed schedule fields", () => {
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
  const normalizedReadback = {
    ...task,
    due: { ...task.due, string: "every Wed at 2pm starting Nov 4 and ending Nov 25" },
  };
  assert.equal(matchesCalendarOwnedRecurringTask(normalizedReadback, active, recurrence), true);
  const mismatch = (due) => calendarOwnedRecurringTaskReadback({ ...task, due: { ...task.due, ...due } }, active, recurrence);
  assert.equal(mismatch({ string: "every Thursday at 2pm starting Nov 4 and ending Nov 25" }).matches, false);
  assert.equal(mismatch({ string: "every Wednesday at 2pm starting Nov 5 and ending Nov 25" }).matches, false);
  assert.equal(mismatch({ string: "every Wednesday at 2pm starting Nov 4 and ending Nov 26" }).matches, false);
  assert.equal(mismatch({ string: "every Wednesday at 2pm starting Nov 4 2027 and ending Nov 25 2027" }).matches, false);
  assert.equal(matchesCalendarOwnedRecurringTask({ ...task, due: { ...task.due, datetime: "2026-11-11T14:00:00Z" } }, active, recurrence), false);
  assert.equal(matchesCalendarOwnedRecurringTask({ ...task, due: { ...task.due, is_recurring: false } }, active, recurrence), false);

  const crossYear = { ...recurrence, dueString: "every Wednesday starting 23 Dec 2026 and ending 13 Jan 2027" };
  assert.equal(matchesCalendarOwnedRecurringRule({
    id: "task", due: { is_recurring: true, string: "every Wednesday starting 23 Dec and ending 13 Jan" },
  }, crossYear), false);

  const diagnostic = calendarOwnedRecurringTaskReadback(normalizedReadback, active, recurrence);
  assert.equal(diagnostic.expected.startDate, "2026-11-04");
  assert.equal(diagnostic.expected.endDate, "2026-11-25");
  assert.equal(diagnostic.observed.weekday, "Wednesday");
  assert.equal(diagnostic.observed.startYearOmitted, true);
  assert.equal(diagnostic.observed.endYearOmitted, true);
  assert.equal("dueString" in diagnostic.observed, false);
  const unrecognized = calendarOwnedRecurringTaskReadback({
    ...task,
    due: { ...task.due, string: "every Wednesday at 2pm starting on 4 Nov 2026 and ending on 25 Nov 2026" },
  }, active, recurrence);
  assert.deepEqual({
    phraseKind: unrecognized.observed.phraseKind,
    weekdayRecognized: unrecognized.observed.weekdayRecognized,
    startDateParsed: unrecognized.observed.startDateParsed,
    endDateParsed: unrecognized.observed.endDateParsed,
    timePresent: unrecognized.observed.timePresent,
    timeParsed: unrecognized.observed.timeParsed,
  }, {
    phraseKind: "starting_on_ending_on", weekdayRecognized: true,
    startDateParsed: true, endDateParsed: true, timePresent: true, timeParsed: true,
  });
  const invalidStart = calendarOwnedRecurringTaskReadback({
    ...task,
    due: { ...task.due, string: "every Wednesday starting on nonsense and ending on 25 Nov 2026" },
  }, active, recurrence);
  assert.equal(invalidStart.observed.startDateParsed, false);
  assert.equal(invalidStart.observed.endDateParsed, true);
  assert.equal(invalidStart.observed.weekdayRecognized, true);
  const invalidTime = calendarOwnedRecurringTaskReadback({
    ...task,
    due: { ...task.due, string: "every Wednesday at nonsense starting on 4 Nov 2026 and ending on 25 Nov 2026" },
  }, active, recurrence);
  assert.equal(invalidTime.observed.startDateParsed, true);
  assert.equal(invalidTime.observed.endDateParsed, true);
  assert.equal(invalidTime.observed.timePresent, true);
  assert.equal(invalidTime.observed.timeParsed, false);
  const fromUntil = calendarOwnedRecurringTaskReadback({
    ...task,
    due: { ...task.due, string: "every Wednesday at 2pm from 4 Nov 2026 until 25 Nov 2026" },
  }, active, recurrence);
  assert.deepEqual({
    phraseKind: fromUntil.observed.phraseKind,
    weekdayRecognized: fromUntil.observed.weekdayRecognized,
    startDateParsed: fromUntil.observed.startDateParsed,
    endDateParsed: fromUntil.observed.endDateParsed,
    timePresent: fromUntil.observed.timePresent,
    timeParsed: fromUntil.observed.timeParsed,
  }, {
    phraseKind: "from_until", weekdayRecognized: true,
    startDateParsed: true, endDateParsed: true, timePresent: true, timeParsed: true,
  });
  const wrongEnd = mismatch({ string: "every Wednesday at 2pm starting Nov 4 and ending Nov 26" });
  assert.equal(wrongEnd.expected.endDate, "2026-11-25");
  assert.equal(wrongEnd.observed.endDate, "11-26");
  assert.equal("dueString" in wrongEnd.observed, false);
});

test("ending-only Todoist readback uses the current date as the inclusive weekly start anchor", () => {
  const master = { id: "all-day-master", summary: "Task", start: { date: "2026-11-05" }, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] };
  const active = {
    id: "all-day-first", recurringEventId: master.id, status: "confirmed",
    originalStartTime: { date: "2026-11-05" }, start: { date: "2026-11-05" },
  };
  const schedule = ["2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26"].map((date, index) => ({
    id: `all-day-${index}`, recurringEventId: master.id, status: "confirmed",
    originalStartTime: { date }, start: { date },
  }));
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  const task = { id: "task", content: "Task", due: {
    date: "2026-11-05", is_recurring: true, string: "every Thursday ending 26 Nov 2026",
  } };

  const accepted = calendarOwnedRecurringTaskReadback(task, active, recurrence);
  assert.equal(accepted.matches, true);
  assert.deepEqual({ weekday: accepted.observed.weekday, startDate: accepted.observed.startDate, endDate: accepted.observed.endDate }, {
    weekday: "Thursday", startDate: "2026-11-05", endDate: "2026-11-26",
  });
  assert.equal("dueString" in accepted.observed, false);
  assert.equal("string" in accepted.observed, false);

  const readback = (due) => calendarOwnedRecurringTaskReadback({ ...task, due: { ...task.due, ...due } }, active, recurrence);
  assert.equal(readback({ string: "every Thursday ending 25 Nov 2026" }).matches, false, "wrong inclusive end is rejected");
  assert.equal(readback({ date: "2026-11-12" }).matches, false, "wrong current iteration is rejected");
  assert.equal(readback({ date: "2026-02-31" }).matches, false, "malformed current date is rejected");
  assert.equal(readback({ date: undefined }).matches, false, "missing current date is rejected");
  assert.equal(readback({ string: "every Thursday ending sometime" }).matches, false, "malformed ending is rejected");
  assert.equal(readback({ string: "every Friday ending 26 Nov 2026" }).matches, false, "wrong weekday is rejected");
  assert.equal(readback({ is_recurring: false }).matches, false, "non-recurring tasks are rejected");
  assert.equal(readback({ datetime: "2026-11-05T00:00:00Z", date: undefined }).matches, false, "timestamp-only anchors fail closed");
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
