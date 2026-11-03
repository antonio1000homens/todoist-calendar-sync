import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCalendarRule, classifyTodoistRule, occurrenceDates, compareOccurrenceSemantics,
} from "../dist/recurrence-semantics.js";

const london = { timeZone: "Europe/London", start: "2027-01-01" };
const evidence = { calendarReadback: true, todoistReadback: true,
  anchorVerified: true, progressionVerified: true, exceptionInventoryComplete: true };
const verified = (start, timeZone = "Europe/London") => ({ start, timeZone, evidence });

test("multiple monthly days are the same anchored sequence in either direction", () => {
  const todoist = classifyTodoistRule("every 2, 15, 27", verified("2027-01-02"));
  const google = classifyCalendarRule("RRULE:BYMONTHDAY=27,2,15;FREQ=MONTHLY;INTERVAL=1", verified("2027-01-02"));
  assert.equal(todoist.disposition, "native_exact");
  assert.equal(google.disposition, "native_exact");
  assert.equal(todoist.canonicalRrule, "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27");
  assert.equal(google.canonicalRrule, todoist.canonicalRrule);
  assert.deepEqual(occurrenceDates(todoist.semantic, 7),
    ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02", "2027-02-15", "2027-02-27", "2027-03-02"]);
  assert.equal(compareOccurrenceSemantics(todoist.semantic, google.semantic).equivalent, true);
});

test("weekday list order canonicalizes and remains an anchored single weekly schedule", () => {
  const fromTodoist = classifyTodoistRule("every fri, mon", verified("2027-01-01"));
  const fromGoogle = classifyCalendarRule("RRULE:BYDAY=FR,MO;FREQ=WEEKLY", verified("2027-01-01"));
  assert.equal(fromTodoist.canonicalRrule, "RRULE:FREQ=WEEKLY;BYDAY=MO,FR");
  assert.equal(compareOccurrenceSemantics(fromTodoist.semantic, fromGoogle.semantic).equivalent, true);
  assert.deepEqual(occurrenceDates(fromGoogle.semantic, 5),
    ["2027-01-01", "2027-01-04", "2027-01-08", "2027-01-11", "2027-01-15"]);
});

test("alternate Friday phase comes from DTSTART, not today's week number", () => {
  const a = classifyTodoistRule("every other Friday", verified("2027-01-08"));
  const b = classifyCalendarRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", verified("2027-01-08"));
  const shifted = classifyCalendarRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", verified("2027-01-15"));
  assert.equal(a.canonicalRrule, "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  assert.deepEqual(occurrenceDates(a.semantic, 4),
    ["2027-01-08", "2027-01-22", "2027-02-05", "2027-02-19"]);
  assert.equal(compareOccurrenceSemantics(a.semantic, b.semantic).equivalent, true);
  assert.equal(compareOccurrenceSemantics(a.semantic, shifted.semantic).equivalent, false);
});

test("quarterly alias is a month interval, never a ninety-day approximation", () => {
  const q = classifyTodoistRule("quarterly", verified("2027-01-31"));
  const r = classifyCalendarRule("RRULE:FREQ=MONTHLY;INTERVAL=3", verified("2027-01-31"));
  assert.equal(q.canonicalRrule, "RRULE:FREQ=MONTHLY;INTERVAL=3");
  assert.deepEqual(occurrenceDates(q.semantic, 5),
    ["2027-01-31", "2027-07-31", "2027-10-31", "2028-01-31", "2028-07-31"]);
  assert.equal(compareOccurrenceSemantics(q.semantic, r.semantic).equivalent, true);
});

test("29th, 30th and 31st skip short months rather than moving to the 28th", () => {
  for (const day of [29, 30, 31]) {
    const r = classifyCalendarRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=" + day, verified("2027-01-" + day));
    assert.equal(r.semantic.byMonthDay[0], day);
    assert.ok(!occurrenceDates(r.semantic, 6).includes("2027-02-28"));
  }
  assert.deepEqual(occurrenceDates(
    classifyCalendarRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=31", verified("2027-01-31")).semantic, 4),
  ["2027-01-31", "2027-03-31", "2027-05-31", "2027-07-31"]);
});

test("yearly leap day is not shifted into non-leap years", () => {
  const r = classifyCalendarRule("RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", verified("2028-02-29"));
  assert.deepEqual(occurrenceDates(r.semantic, 3), ["2028-02-29", "2032-02-29", "2036-02-29"]);
});

test("civil clock remains 09:00 Europe/London across BST changes", () => {
  const a = classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=FR",
    verified("2027-03-26T09:00:00Z"));
  const b = classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=FR",
    verified("2027-04-02T08:00:00Z"));
  assert.equal(a.semantic.localTime, "09:00");
  assert.equal(b.semantic.localTime, "09:00");
  assert.equal(a.semantic.timeZone, "Europe/London");
  assert.deepEqual(occurrenceDates(a.semantic, 3), ["2027-03-26", "2027-04-02", "2027-04-09"]);
  assert.deepEqual(occurrenceDates(b.semantic, 3), ["2027-04-02", "2027-04-09", "2027-04-16"]);
  assert.equal(classifyCalendarRule("RRULE:FREQ=DAILY", { start:"2027-03-26T09:00:00Z" }).reason,
    "timezone_not_verified");
});

test("no provider evidence, partial evidence or uncertain anchor can authorize native writing", () => {
  const unverified = classifyTodoistRule("every 2, 15, 27", london);
  assert.equal(unverified.disposition, "rolling_required");
  assert.equal(unverified.reason, "anchor_not_verified");
  const partial = classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=MO,FR", {
    ...london, evidence: { anchorVerified: true, calendarReadback: true },
  });
  assert.equal(partial.disposition, "rolling_required");
  assert.equal(partial.reason, "provider_readback_required");
  assert.equal(classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=MO,FR", {
    ...london, evidence, exceptionPresent:true,
  }).reason, "calendar_exception");
});

test("finite, completion-relative and exception-bearing cases are never promoted", () => {
  assert.equal(classifyTodoistRule("every! 2 days", verified("2027-01-01")).reason, "completion_relative");
  assert.equal(classifyTodoistRule("every Monday ending 10 June", verified("2027-01-01")).reason,
    "finite_provider_validation_required");
  for (const rule of [
    "RRULE:FREQ=WEEKLY;COUNT=8", "RRULE:FREQ=WEEKLY;UNTIL=20270801",
  ]) {
    const result = classifyCalendarRule(rule, verified("2027-01-01"));
    assert.equal(result.disposition, "rolling_required");
    assert.equal(result.reason, "finite_provider_validation_required");
  }
});

test("strictly rejects unknown/duplicated/invalid and compound components", () => {
  for (const [rule, reason] of [
    ["RRULE:FREQ=WEEKLY;INTERVAL=1;INTERVAL=2", "duplicate_component"],
    ["RRULE:FREQ=WEEKLY;BYHOUR=9", "unsupported_component"],
    ["RRULE:FREQ=WEEKLY;BYDAY=ZZ", "invalid_component"],
    ["RRULE:FREQ=MONTHLY;BYMONTHDAY=32", "invalid_component"],
    ["RRULE:FREQ=MONTHLY;INTERVAL=0", "invalid_component"],
    ["RRULE:FREQ=WEEKLY;COUNT=3;UNTIL=20270131", "invalid_component"],
    ["RRULE:FREQ=WEEKLY;WKST=SU", "compound_rule_not_verified"],
    ["RRULE:FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=3", "compound_rule_not_verified"],
  ]) assert.equal(classifyCalendarRule(rule, verified("2027-01-01")).reason, reason, rule);
  assert.equal(classifyTodoistRule("every last workday", verified("2027-01-01")).reason, "unknown_todoist_phrase");
  assert.equal(classifyTodoistRule("every 2, 42", verified("2027-01-01")).reason, "invalid_component");
  assert.equal(classifyCalendarRule("RRULE:FREQ=DAILY", verified("2027-02-31")).reason, "invalid_start");
});

test("timed and all-day rules do not compare equivalent; timezone is semantic", () => {
  const allDay = classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=MO", {
    start:"2027-01-04", evidence,
  }).semantic;
  const timed = classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=MO", verified("2027-01-04T09:00:00Z")).semantic;
  const otherZone = classifyCalendarRule("RRULE:FREQ=WEEKLY;BYDAY=MO",
    verified("2027-01-04T09:00:00Z", "Europe/Paris")).semantic;
  assert.equal(compareOccurrenceSemantics(allDay, timed).equivalent, false);
  assert.equal(compareOccurrenceSemantics(timed, otherZone).equivalent, false);
});
