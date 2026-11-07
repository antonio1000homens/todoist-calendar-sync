import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeCalendarRecurrenceCandidate, verifiedCalendarOwnedRecurrence,
  calendarOwnedRecurringTaskReadback, matchesCalendarOwnedRecurringRule,
} from "../dist/calendar-owned-todoist-recurrence.js";

const flag = "TODOIST_CALENDAR_SYNC_PHASE_C_NATIVE_ENABLED";
function withPhaseC(on, callback) {
  const old = process.env[flag];
  try { process.env[flag] = on ? "true" : "false"; return callback(); }
  finally { if (old === undefined) delete process.env[flag]; else process.env[flag] = old; }
}
function m(start, rule, timed = false) {
  return { id: "phase-c-master", etag: "etag", status: "confirmed",
    start: timed ? { dateTime: start, timeZone: "Europe/London" } : { date: start },
    recurrence: [rule] };
}
function i(value, n, timed = false) {
  const start = timed ? { dateTime: value, timeZone: "Europe/London" } : { date: value };
  return { id: "instance-" + n, recurringEventId: "phase-c-master", status: "confirmed",
    originalStartTime: start, start };
}
test("Phase C is OFF without explicit production opt-in and never widens finite or exception rules", () =>
  withPhaseC(false, () => {
    assert.equal(nativeCalendarRecurrenceCandidate(m("2027-01-08",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR")), false);
    assert.equal(nativeCalendarRecurrenceCandidate(m("2027-01-15",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27")), false);
  }));
test("enabled Phase C does not admit finite rules, mixed fields, invalid phase or moved instances", async () => {
  process.env[flag] = "true";
  try {
    const start = "2027-01-08";
    for (const rule of ["RRULE:FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;UNTIL=20271231",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYMONTHDAY=8",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;INTERVAL=3"])
      assert.equal(nativeCalendarRecurrenceCandidate(m(start, rule)), false, rule);
    const calendar = m("2027-01-08", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR");
    assert.equal(nativeCalendarRecurrenceCandidate(calendar), true);
    const instances = [i("2027-01-08",0),i("2027-01-11",1),i("2027-01-15",2)];
    assert.equal(await verifiedCalendarOwnedRecurrence(calendar, instances,
      "Europe/London", async () => [i("2027-01-18",3)]), undefined);
    assert.equal(await verifiedCalendarOwnedRecurrence(calendar, instances.slice(0,2),
      "Europe/London", async () => []), undefined);
    const moved = instances.map(x=>({...x}));
    moved[1] = {...moved[1], start: {date:"2027-01-12"}};
    assert.equal(await verifiedCalendarOwnedRecurrence(calendar, moved,
      "Europe/London", async () => []), undefined);
    assert.equal(await verifiedCalendarOwnedRecurrence(calendar,
      [i("2027-01-08",0),i("2027-01-12",1),i("2027-01-15",2)],
      "Europe/London", async () => []), undefined);
  } finally { delete process.env[flag]; }
});
test("multi-weekday readback accepts one recurring Todoist identity, rejects unrelated cadence", async () => {
  process.env[flag] = "true";
  try {
    const calendar = m("2027-01-08", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR");
    const items = ["2027-01-08","2027-01-11","2027-01-15","2027-01-18"]
      .map((date,j) => i(date,j));
    const recurrence = await verifiedCalendarOwnedRecurrence(calendar,items,"Europe/London",async()=>[]);
    assert.equal(recurrence?.phaseCCandidate?.family, "multi_weekday");
    assert.equal(recurrence?.dueString, "every mon, fri starting 8 Jan 2027");
    const task = { id:"same-task", due: { date:"2027-01-08",
      is_recurring:true, string:"every mon, fri" }};
    assert.equal(calendarOwnedRecurringTaskReadback(task,items[0],recurrence,"Europe/London").matches,true);
    assert.equal(matchesCalendarOwnedRecurringRule({...task,due:{...task.due,date:"2027-01-11"}},
      recurrence,"Europe/London"),true,"Todoist must advance in place to the next weekday");
    assert.equal(matchesCalendarOwnedRecurringRule({...task,due:{...task.due,string:"every fri"}},
      recurrence,"Europe/London"),false);
    assert.equal(matchesCalendarOwnedRecurringRule({...task,due:{...task.due,date:"2027-01-12"}},
      recurrence,"Europe/London"),false);
  } finally { delete process.env[flag]; }
});
test("multi-month-day, alternating phase and bimonthly readbacks require exact anchored dates", async () => {
  process.env[flag] = "true";
  try {
    for (const [calendar,dates,normalized,family] of [
      [m("2027-01-02","RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"),
        ["2027-01-02","2027-01-15","2027-01-27","2027-02-02"],"every 2, 15, 27","multi_month_day"],
      [m("2027-01-08","RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"),
        ["2027-01-08","2027-01-22","2027-02-05","2027-02-19"],"every other fri","alternate_weekday"],
      [m("2027-01-10","RRULE:FREQ=MONTHLY;INTERVAL=2"),
        ["2027-01-10","2027-03-10","2027-05-10","2027-07-10"],"every 2 months","monthly_interval"],
    ]) {
      const instances = dates.map((date,j)=>i(date,j));
      const recurrence = await verifiedCalendarOwnedRecurrence(calendar, instances,
        "Europe/London", async()=>[]);
      assert.equal(recurrence?.phaseCCandidate?.family,family);
      const todoist = {id:"same-task",due:{date:dates[0],string:normalized,is_recurring:true}};
      assert.equal(calendarOwnedRecurringTaskReadback(todoist,instances[0],recurrence,"Europe/London").matches,true);
      assert.equal(matchesCalendarOwnedRecurringRule({...todoist,due:{...todoist.due,date:dates[1]}},
        recurrence,"Europe/London"),true);
    }
  } finally { delete process.env[flag]; }
});
test("timezones and DST: an advanced floating Todoist local time matches the Calendar wall clock", async () => {
  process.env[flag] = "true";
  try {
    const calendar = m("2027-03-26T09:00:00Z","RRULE:FREQ=WEEKLY;BYDAY=MO,FR",true);
    const instances = ["2027-03-26T09:00:00Z","2027-03-29T08:00:00Z","2027-04-02T08:00:00Z"]
      .map((d,j)=>i(d,j,true));
    const recurrence = await verifiedCalendarOwnedRecurrence(calendar,instances,
      "Europe/London",async()=>[]);
    assert.equal(recurrence?.phaseCCandidate?.family,"multi_weekday");
    const task={id:"same-task",due:{datetime:"2027-03-26T09:00:00",
      timezone:"Europe/London",string:"every mon, fri at 9am",is_recurring:true}};
    assert.equal(calendarOwnedRecurringTaskReadback(task,instances[0],recurrence,"Europe/London").matches,true);
    assert.equal(matchesCalendarOwnedRecurringRule({...task,due:{...task.due,
      datetime:"2027-03-29T09:00:00"}},recurrence,"Europe/London"),true);
    assert.equal(matchesCalendarOwnedRecurringRule({...task,due:{...task.due,
      datetime:"2027-03-29T08:00:00"}},recurrence,"Europe/London"),false);
  } finally { delete process.env[flag]; }
});
