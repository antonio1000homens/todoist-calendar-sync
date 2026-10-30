import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarOwnedTodoistRecurrence,
  calendarOwnedRecurringTaskReadback,
  calendarOwnedRecurringTaskPayload,
  matchesCalendarOwnedRecurringTask,
  matchesCalendarOwnedRecurringRule,
  nativeCalendarRecurrenceCandidate,
  verifiedCalendarOwnedRecurrence,
} from "../dist/calendar-owned-todoist-recurrence.js";
import { todoistRecurrenceToRrule } from "../dist/todoist-recurrence.js";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const codes = ["MO", "TU", "WE", "TH", "FR"];
const suffixes = ["1st", "2nd", "3rd", "4th", "5th"];

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function matchingDate(weekday, position, year = 2027) {
  for (let month = 1; month <= 12; month++) {
    const limit = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const matching = Array.from({ length: limit }, (_, d) => d + 1)
      .filter((d) => new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday + 1);
    if (matching.length >= position) return iso(year, month, matching[position - 1]);
  }
  throw new Error("No matching calendar date");
}
function master(date, rule) {
  return { id: "master", summary: "Meeting", start: { date }, recurrence: [rule] };
}
function occurrence(date) {
  return { id: "occurrence-" + date, recurringEventId: "master", status: "confirmed",
    originalStartTime: { date }, start: { date } };
}
function task(date, string) {
  return { id: "same-task", due: { date, is_recurring: true, string } };
}

test("every monthly ordinal 1–5 Mon–Fri round-trips and validates provider semantics", () => {
  for (let n = 1; n <= 5; n++) {
    for (let weekday = 0; weekday < days.length; weekday++) {
      const date = matchingDate(weekday, n);
      const rule = `RRULE:FREQ=MONTHLY;BYDAY=${n}${codes[weekday]}`;
      const cal = master(date, rule);
      const recurrence = calendarOwnedTodoistRecurrence(cal, [occurrence(date)], "Europe/London");
      assert.equal(recurrence?.frequency, "monthly", rule);
      assert.equal(recurrence?.monthlyOrdinal, n, rule);
      assert.equal(recurrence?.weekday, days[weekday], rule);
      const due = task(date, `every ${suffixes[n - 1]} ${days[weekday].toLowerCase()}`);
      assert.equal(matchesCalendarOwnedRecurringTask(due, occurrence(date), recurrence, "Europe/London"), true, rule);
      assert.equal(calendarOwnedRecurringTaskReadback(due, occurrence(date), recurrence, "Europe/London").observed.monthlyOrdinal, n, rule);
      assert.equal(todoistRecurrenceToRrule(due), rule, rule);
      assert.equal(calendarOwnedRecurringTaskPayload(occurrence(date), recurrence).due.is_recurring, true);
      assert.equal(matchesCalendarOwnedRecurringTask(task(date, "every friday"), occurrence(date), recurrence, "Europe/London"), false, rule);
    }
  }
});

test("fifth Friday skips months with no fifth Friday and is never treated as last Friday", () => {
  const cal = master("2027-01-29", "RRULE:FREQ=MONTHLY;BYDAY=5FR");
  const recurrence = calendarOwnedTodoistRecurrence(cal, [occurrence("2027-01-29"), occurrence("2027-04-30")], "Europe/London");
  assert.equal(recurrence.monthlyOrdinal, 5);
  assert.equal(matchesCalendarOwnedRecurringRule(task("2027-04-30", "every fifth Friday"), recurrence, "Europe/London"), true);
  assert.equal(matchesCalendarOwnedRecurringRule(task("2027-02-26", "every 5th Friday"), recurrence, "Europe/London"), false);
  assert.equal(matchesCalendarOwnedRecurringRule(task("2027-03-26", "every last Friday"), recurrence, "Europe/London"), false);
  assert.equal(todoistRecurrenceToRrule(task("2027-02-26", "every 5th Friday")), undefined);
  assert.equal(calendarOwnedRecurringTaskReadback(task("2027-04-30", "every 5th fri"), occurrence("2027-04-30"), recurrence, "Europe/London").matches, true);
  assert.equal(calendarOwnedRecurringTaskReadback(task("2027-04-30", "every 5th fri"), occurrence("2027-01-29"), recurrence, "Europe/London").matches, false, "must match the active Calendar occurrence");
});

test("last weekday 1–5 is distinct from fourth weekday for five-weekday months", () => {
  for (let weekday = 0; weekday < days.length; weekday++) {
    const fifth = matchingDate(weekday, 5);
    const rule = `RRULE:FREQ=MONTHLY;BYDAY=-1${codes[weekday]}`;
    const rec = calendarOwnedTodoistRecurrence(master(fifth, rule), [occurrence(fifth)], "Europe/London");
    assert.equal(rec?.monthlyOrdinal, -1);
    const due = task(fifth, `every last ${days[weekday].toLowerCase()} of the month`);
    assert.equal(matchesCalendarOwnedRecurringTask(due, occurrence(fifth), rec, "Europe/London"), true);
    assert.equal(todoistRecurrenceToRrule(due), rule);
    assert.equal(matchesCalendarOwnedRecurringRule(task(fifth, `every 4th ${days[weekday]}`), rec, "Europe/London"), false);
    const fourth = iso(Number(fifth.slice(0, 4)), Number(fifth.slice(5, 7)), Number(fifth.slice(8, 10)) - 7);
    assert.equal(matchesCalendarOwnedRecurringRule(task(fourth, `every last ${days[weekday]}`), rec, "Europe/London"), false);
    const alternate = calendarOwnedTodoistRecurrence(master(fifth,
      `RRULE:FREQ=MONTHLY;BYDAY=${codes[weekday]};BYSETPOS=-1`), [], "Europe/London");
    assert.equal(alternate?.monthlyOrdinal, -1);
  }
});

test("rejects ambiguous, unsupported and contradictory positional rules and moved exceptions", async () => {
  const date = "2027-01-29";
  for (const rule of [
    "RRULE:FREQ=MONTHLY;BYDAY=FR", "RRULE:FREQ=MONTHLY;BYDAY=-2FR",
    "RRULE:FREQ=MONTHLY;BYDAY=6FR", "RRULE:FREQ=MONTHLY;BYDAY=4FR,5FR",
    "RRULE:FREQ=MONTHLY;BYDAY=5SA", "RRULE:FREQ=MONTHLY;BYDAY=5FR;INTERVAL=2",
    "RRULE:FREQ=MONTHLY;BYDAY=5FR;COUNT=10", "RRULE:FREQ=MONTHLY;BYDAY=5FR;BYMONTHDAY=29",
    "RRULE:FREQ=MONTHLY;BYDAY=5FR;BYSETPOS=-1",
  ]) assert.equal(calendarOwnedTodoistRecurrence(master(date, rule), [], "Europe/London"), undefined, rule);
  const cal = master(date, "RRULE:FREQ=MONTHLY;BYDAY=5FR");
  const moved = { ...occurrence(date), start: { date: "2027-01-28" } };
  assert.equal(calendarOwnedTodoistRecurrence(cal, [moved], "Europe/London"), undefined);
  assert.equal(await verifiedCalendarOwnedRecurrence(cal, [], "Europe/London", async () => [moved]), undefined);
  assert.equal(await verifiedCalendarOwnedRecurrence(cal, [], "Europe/London", async () => [{ ...occurrence(date), status: "cancelled" }]), undefined);
  assert.equal(await verifiedCalendarOwnedRecurrence(cal, [], "Europe/London"), undefined);
  assert.equal((await verifiedCalendarOwnedRecurrence(cal, [], "Europe/London", async () => [])).monthlyOrdinal, 5);
  assert.equal(nativeCalendarRecurrenceCandidate(cal), true);
  assert.equal(todoistRecurrenceToRrule(task(date, "every last Saturday")), undefined);
});

test("fourth-Friday recurrence can start on the fifth Friday before its first matching occurrence", () => {
  // Regression: P&S series master on 30 October 2026, first recurring projection on 27 November.
  const cal = master("2026-10-30", "RRULE:FREQ=MONTHLY;BYDAY=4FR");
  const active = occurrence("2026-11-27");
  const rec = calendarOwnedTodoistRecurrence(cal, [active], "Europe/London");
  assert.equal(rec?.monthlyOrdinal, 4);
  assert.equal(matchesCalendarOwnedRecurringTask(task("2026-11-27", "every 4th Friday"), active, rec, "Europe/London"), true);
  assert.equal(matchesCalendarOwnedRecurringTask(task("2026-11-27", "every last Friday"), active, rec, "Europe/London"), false,
    "even when due dates coincide, different recurrence semantics must be rejected");
});

test("native last-Friday timed recurrence preserves 9 AM London wall time across DST and checks date/time/zone", () => {
  const cal = {
    id: "master", start: { dateTime: "2027-03-26T09:00:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=-1FR"],
  };
  const april = { id: "april", recurringEventId: "master",
    originalStartTime: { dateTime: "2027-04-30T08:00:00Z", timeZone: "Europe/London" },
    start: { dateTime: "2027-04-30T08:00:00Z", timeZone: "Europe/London" } };
  const rec = calendarOwnedTodoistRecurrence(cal, [april], "Europe/London");
  assert.equal(rec.time, "09:00");
  assert.match(rec.dueString, /last Friday at 9:00am/);
  const due = { date: "2027-04-30T08:00:00Z", datetime: "2027-04-30T08:00:00Z",
    timezone: "Europe/London", is_recurring: true, string: "every last Fri at 09:00" };
  const read = (patch = {}) => calendarOwnedRecurringTaskReadback({ id: "same-task", due: { ...due, ...patch } }, april, rec, "Europe/London");
  assert.equal(read().matches, true);
  assert.equal(read({ datetime: "2027-04-30T09:00:00Z", date: "2027-04-30T09:00:00Z" }).matches, false);
  assert.equal(read({ timezone: "America/New_York" }).matches, false);
  assert.equal(read({ string: "every 4th Friday at 09:00" }).matches, false);
  assert.equal(read({ string: "every last Thursday at 09:00" }).matches, false);
  assert.equal(read({ string: "every last Friday at 10:00" }).matches, false);
  assert.equal(read({ date: "2027-05-28T08:00:00Z", datetime: "2027-05-28T08:00:00Z" }).matches, false);
  assert.equal(read({ is_recurring: false }).matches, false);
  assert.equal(calendarOwnedRecurringTaskReadback({ id: "same-task", due }, april, rec).matches, false, "timed offset requires verified timezone");
});
