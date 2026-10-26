import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarOwnedRecurringTaskPayload,
  calendarOwnedRecurringTaskReadback,
  calendarOwnedTodoistRecurrence,
  verifiedCalendarOwnedRecurrence,
  nativeCalendarRecurrenceCandidate,
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

test("unsupported or incomplete finite weekly recurrence inventories fail closed", () => {
  const master = weeklyMaster("2026-11-04T14:00:00Z", "RRULE:FREQ=DAILY;COUNT=4");
  const schedule = instances(["2026-11-04T14:00:00Z"]);
  assert.equal(calendarOwnedTodoistRecurrence(master, schedule, "Europe/London"), undefined);
   assert.equal(calendarOwnedTodoistRecurrence(weeklyMaster("2026-11-04T14:00:00Z"), schedule, "Europe/London"), undefined);
});


test("indefinite weekly, monthly and annual Calendar patterns produce real Todoist recurrences", () => {
  const examples = [
    { start: "2026-11-04T14:00:00Z", rule: "RRULE:FREQ=WEEKLY;BYDAY=WE",
      text: "every Wednesday at 2:00pm starting 4 Nov 2026", frequency: "weekly" },
    { start: "2026-11-15T14:00:00Z", rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
      text: "every 15th at 2:00pm starting 15 Nov 2026", frequency: "monthly" },
    { start: "2026-10-10T14:00:00Z", rule: "RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=10",
      text: "every 10 Oct at 3:00pm starting 10 Oct 2026", frequency: "yearly" },
  ];
  for (const { start, rule, text, frequency } of examples) {
    const master = weeklyMaster(start, rule);
    assert.equal(nativeCalendarRecurrenceCandidate(master), true);
    const recurrence = calendarOwnedTodoistRecurrence(master, [], "Europe/London");
    assert.equal(recurrence.frequency, frequency);
    assert.equal(recurrence.dueString, text);
    const event = { id: "active", start: master.start, summary: "Appointment" };
    const due = { date: start, datetime: start, is_recurring: true, string: text };
    const task = { id: "task", content: "Appointment", due };
    assert.equal(calendarOwnedRecurringTaskPayload(event, recurrence).due.is_recurring, true);
    assert.equal(matchesCalendarOwnedRecurringTask(task, event, recurrence, "Europe/London"), true);
    assert.equal(matchesCalendarOwnedRecurringRule(task, recurrence, "Europe/London"), true);
    assert.equal(matchesCalendarOwnedRecurringTask({ ...task, due: { ...due, string: "every day" } },
      event, recurrence, "Europe/London"), false);
  }
});

test("all-day native rules and Todoist's normalized no-start recurrence remain valid", () => {
  const shapes = [
    { date: "2099-09-02", rule: "RRULE:FREQ=WEEKLY", normalized: "every Wednesday" },
    { date: "2099-09-15", rule: "RRULE:FREQ=MONTHLY", normalized: "every 15th" },
    { date: "2099-10-10", rule: "RRULE:FREQ=YEARLY", normalized: "every October 10" },
  ];
  for (const { date, rule, normalized } of shapes) {
    const event = { id: "master", start: { date }, recurrence: [rule] };
    const recurrence = calendarOwnedTodoistRecurrence(event, [], "Europe/London");
    const task = { id: "task", due: { date, string: normalized, is_recurring: true } };
    assert.equal(matchesCalendarOwnedRecurringTask(task, event, recurrence, "Europe/London"), true);
    assert.equal(matchesCalendarOwnedRecurringRule(task, recurrence, "Europe/London"), true);
    assert.equal(matchesCalendarOwnedRecurringRule({ ...task, due: { ...task.due, is_recurring: false } }, recurrence), false);
  }
});


test("native weekly recurrence checks the London-local day across UTC midnight", () => {
  const master = weeklyMaster("2027-07-06T23:30:00Z", "RRULE:FREQ=WEEKLY;BYDAY=WE");
  const scheduled = instances(["2027-07-06T23:30:00Z"]);
  const recurrence = calendarOwnedTodoistRecurrence(master, scheduled, "Europe/London");
  assert.equal(recurrence.weekday, "Wednesday");
  assert.equal(recurrence.startDate, "2027-07-07");
  const event = { ...scheduled[0], start: master.start };
  const task = { id: "task", due: {
    date: "2027-07-06T23:30:00Z", is_recurring: true, string: recurrence.dueString,
  } };
  assert.equal(matchesCalendarOwnedRecurringRule(task, recurrence, "Europe/London"), true);
  assert.equal(matchesCalendarOwnedRecurringTask(task, event, recurrence, "Europe/London"), true);
  assert.equal(matchesCalendarOwnedRecurringRule(task, recurrence), false,
    "unverified timezone cannot prove an offset datetime's logical weekday");
});

test("complex or finite non-weekly Calendar recurrences are never silently approximated", () => {
  const invalid = [
    ["2026-11-30", "RRULE:FREQ=MONTHLY"],
    ["2026-11-15", "RRULE:FREQ=MONTHLY;COUNT=5"],
    ["2026-11-15", "RRULE:FREQ=MONTHLY;UNTIL=20271231"],
    ["2028-02-29", "RRULE:FREQ=YEARLY"],
    ["2026-11-04", "RRULE:FREQ=WEEKLY;BYDAY=WE,FR"],
    ["2026-11-04", "RRULE:FREQ=WEEKLY;INTERVAL=2"],
    ["2026-11-04", "RRULE:FREQ=WEEKLY;BYSETPOS=1"],
    ["2026-11-15", "RRULE:FREQ=MONTHLY;BYDAY=3SU"],
  ];
  for (const [date, rule] of invalid) {
    const master = { id: "master", start: { date }, recurrence: [rule] };
    assert.equal(calendarOwnedTodoistRecurrence(master, [], "Europe/London"), undefined, rule);
  }
  const weekly = calendarOwnedTodoistRecurrence({
    id: "master", start: { date: "2099-09-02" }, recurrence: ["RRULE:FREQ=WEEKLY"],
  }, [], "Europe/London");
  const event = { start: { date: "2099-09-02" } };
  assert.equal(matchesCalendarOwnedRecurringTask({
    id: "task", due: { date: "2099-09-02", is_recurring: true, string: "every Tuesday" },
  }, event, weekly), false);
  assert.equal(matchesCalendarOwnedRecurringTask({
    id: "task", due: { date: "2099-09-02", is_recurring: true, string: "every Wednesday ending 30 Sep" },
  }, event, weekly), false);
});

test("native recurrence requires a complete explicit exception inventory", async () => {
  const master = weeklyMaster("2026-11-04T14:00:00Z", "RRULE:FREQ=WEEKLY");
  const scoped = instances(["2026-11-04T14:00:00Z"]);
  assert.equal(await verifiedCalendarOwnedRecurrence(master, scoped, "Europe/London"), undefined,
    "missing provider method is not proof that there are no future exceptions");
  assert.equal((await verifiedCalendarOwnedRecurrence(master, scoped, "Europe/London", async () => [])).frequency, "weekly");
  let queried;
  const farFuture = { ...instances(["2028-11-01T14:00:00Z"])[0],
    id: "far-future", status: "cancelled" };
  const rejected = await verifiedCalendarOwnedRecurrence(master, scoped, "Europe/London", async (id) => {
    queried = id; return [farFuture];
  });
  assert.equal(queried, master.id);
  assert.equal(rejected, undefined, "a cancellation outside the bounded instance window blocks native conversion");
  const moved = { ...farFuture, status: "confirmed", start: { dateTime: "2028-11-02T14:00:00Z" } };
  assert.equal(await verifiedCalendarOwnedRecurrence(master, scoped, "Europe/London", async () => [moved]), undefined);
});

test("native task payload uses verified timezone without a London default", () => {
  const master = {
    ...weeklyMaster("2026-11-04T14:00:00Z", "RRULE:FREQ=WEEKLY"),
    start: { dateTime: "2026-11-04T14:00:00Z" },
  };
  const recurrence = calendarOwnedTodoistRecurrence(master, [], "Europe/Berlin");
  const event = { ...master, recurrence: undefined };
  assert.equal(calendarOwnedRecurringTaskPayload(event, recurrence, "Europe/Berlin").due.timezone, "Europe/Berlin");
  assert.equal(calendarOwnedRecurringTaskPayload(event, recurrence).due.timezone, undefined);
});

test("native recurrence rejects moved Calendar exceptions but accepts cancellations", () => {
  const master = weeklyMaster("2026-11-04T14:00:00Z", "RRULE:FREQ=WEEKLY");
  const series = instances(["2026-11-04T14:00:00Z", "2026-11-11T14:00:00Z"]);
  const moved = structuredClone(series);
  moved[1].start.dateTime = "2026-11-12T14:00:00Z";
  assert.equal(calendarOwnedTodoistRecurrence(master, moved, "Europe/London"), undefined,
    "a moved single Calendar event cannot be represented by one native Todoist rule");
  const cancelled = structuredClone(series);
  cancelled[1].status = "cancelled";
  assert.equal(calendarOwnedTodoistRecurrence(master, cancelled, "Europe/London").frequency, "weekly");
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

  const advancedTask = { ...task, due: { ...task.due, date: "2026-11-12" } };
  assert.equal(matchesCalendarOwnedRecurringRule(advancedTask, recurrence), true,
    "Todoist may advance its ending-only anchor before the completion webhook is handled");
  assert.equal(calendarOwnedRecurringTaskReadback(advancedTask, schedule[1], recurrence).matches, true,
    "an advanced current occurrence remains a valid recurrence readback");
  assert.equal(matchesCalendarOwnedRecurringRule({
    ...advancedTask, due: { ...advancedTask.due, date: "2026-11-06" },
  }, recurrence), false, "a due date outside the weekly series cadence is rejected");
  assert.equal(matchesCalendarOwnedRecurringRule({
    ...advancedTask, due: { ...advancedTask.due, date: "2026-12-03" },
  }, recurrence), false, "a due date beyond the finite series is rejected");

  const zonedAdvancedTask = {
    ...task,
    due: { ...task.due, date: "2026-11-13T02:00:00Z" },
  };
  assert.equal(matchesCalendarOwnedRecurringRule(zonedAdvancedTask, recurrence, "America/Los_Angeles"), true,
    "a verified timezone converts Todoist's zoned completion readback to the correct local recurrence date");
  assert.equal(matchesCalendarOwnedRecurringRule(zonedAdvancedTask, recurrence), false,
    "zoned timestamps fail closed when no timezone has been verified");
  assert.equal(matchesCalendarOwnedRecurringRule(zonedAdvancedTask, recurrence, "Not/A_Timezone"), false,
    "an invalid timezone fails closed instead of throwing");
  const zonedReadback = calendarOwnedRecurringTaskReadback(zonedAdvancedTask, active, recurrence, "America/Los_Angeles");
  assert.equal(zonedReadback.observed.startDate, "2026-11-12",
    "the anchor is derived from the timezone-local date across a UTC date boundary");
});

test("ending-only timed recurrence accepts Todoist's local datetime as the current date anchor", () => {
  const master = weeklyMaster("2026-11-05T14:00:00Z");
  const schedule = instances([
    "2026-11-05T14:00:00Z", "2026-11-12T14:00:00Z",
    "2026-11-19T14:00:00Z", "2026-11-26T14:00:00Z",
  ]);
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  const active = schedule[0];
  const task = { id: "task", content: "Task", due: {
    date: "2026-11-05T14:00:00", datetime: "2026-11-05T14:00:00",
    timezone: "Europe/London", is_recurring: true,
    string: "every Thursday at 2pm ending 26 Nov 2026",
  } };

  const accepted = calendarOwnedRecurringTaskReadback(task, active, recurrence, "Europe/London");
  assert.equal(accepted.matches, true);
  assert.deepEqual({ weekday: accepted.observed.weekday, time: accepted.observed.time, startDate: accepted.observed.startDate, endDate: accepted.observed.endDate }, {
    weekday: "Thursday", time: "14:00", startDate: "2026-11-05", endDate: "2026-11-26",
  });
  assert.equal(calendarOwnedRecurringTaskReadback({
    ...task, due: { ...task.due, timezone: "America/New_York" },
  }, active, recurrence, "Europe/London").matches, false, "an explicit due timezone mismatch is rejected");
  assert.equal(calendarOwnedRecurringTaskReadback({
    ...task, due: { ...task.due, timezone: undefined },
  }, active, recurrence).matches, false, "a zone-less local datetime requires an independently verified timezone");
  assert.equal(calendarOwnedRecurringTaskReadback({
    ...task, due: { ...task.due, timezone: undefined },
  }, active, recurrence, "America/New_York").matches, false, "a verified timezone mismatch is rejected");
});

test("production-shaped timed recurrence readback accepts zone-less Todoist due only with verified matching zone", () => {
  const master = weeklyMaster("2026-11-05T09:00:00Z");
  const schedule = instances([
    "2026-11-05T09:00:00Z", "2026-11-12T09:00:00Z",
    "2026-11-19T09:00:00Z", "2026-11-26T09:00:00Z",
  ]);
  const recurrence = calendarOwnedTodoistRecurrence(master, schedule, "Europe/London");
  const task = { id: "task", content: "Task", due: {
    date: "2026-11-05T09:00:00", datetime: "2026-11-05T09:00:00",
    is_recurring: true, string: "every Thursday at 9am ending 26 Nov 2026",
  } };

  const missingVerification = calendarOwnedRecurringTaskReadback(task, schedule[0], recurrence);
  assert.equal(missingVerification.expected.weekday, "Thursday");
  assert.equal(missingVerification.expected.time, "09:00");
  assert.equal(missingVerification.expected.startDate, "2026-11-05");
  assert.equal(missingVerification.expected.endDate, "2026-11-26");
  assert.equal(missingVerification.observed.weekday, "Thursday");
  assert.equal(missingVerification.observed.time, "09:00");
  assert.equal(missingVerification.observed.startDate, "2026-11-05");
  assert.equal(missingVerification.observed.endDate, "2026-11-26");
  assert.equal(missingVerification.matches, false, "matching visible schedule fields are insufficient without verified zone context");

  assert.equal(calendarOwnedRecurringTaskReadback(task, schedule[0], recurrence, "Europe/London").matches, true);
  assert.equal(calendarOwnedRecurringTaskReadback(task, schedule[0], recurrence, "America/Los_Angeles").matches, false);
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
