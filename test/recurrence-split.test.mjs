import assert from "node:assert/strict";
import test from "node:test";
import {
  planFutureSeriesSplit, assertUnmodifiedHistoricalOccurrences, sameSafeYearlyRecurrenceRule,
  sameSafeFutureRecurrenceRule,
} from "../dist/recurrence-split.js";

const task = () => ({
  id: "6V94GpQGGG4xCvV2", project_id: "test-project",
  content: "Replace battery smoke alarm",
  due: { date: "2027-07-01", is_recurring: true, string: "every 2 years" },
});
const old = () => ({
  id: "ia2mhkus0g1n279vsgnrrqmda8", status: "confirmed", etag: '"old-1"',
  summary: "Replace battery smoke alarm",
  start: { date: "2025-05-03" }, end: { date: "2025-05-04" },
  recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1"],
  extendedProperties: { shared: { taskId: task().id } },
});
const plan = () => planFutureSeriesSplit("antonio", task(), old(), new Date("2026-10-19T12:00:00Z"));

test("smoke alarm example keeps May 2025/2026 but replaces all May 2027+ occurrences", () => {
  const p = plan();
  assert.equal(p.previousOccurrence, "2026-05-03");
  assert.equal(p.nextOldOccurrence, "2027-05-03");
  assert.equal(p.truncatedRule, "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20260503");
  assert.equal(p.newRule, "RRULE:FREQ=YEARLY;INTERVAL=2");
  assert.equal(p.newStart, "2027-07-01");
  assert.match(p.newMasterId, /^[a-f0-9]{32}$/);
  assert.notEqual(p.newMasterId, p.oldMasterId);
});

test("exact archived cap and lineage permits an idempotent retry", () => {
  const p = plan();
  const e = old();
  e.recurrence = [p.truncatedRule];
  e.extendedProperties.shared = {
    syncHistoryTaskId: task().id, syncHistoryOnly: "true",
    syncHistoryOriginalRule: p.originalRule, syncHistorySuccessorId: p.newMasterId,
  };
  assert.deepEqual(planFutureSeriesSplit("antonio", task(), e, new Date("2026-10-19T12:00:00Z")), {
    ...p, oldEtag: '"old-1"',
  });
});

test("Google canonicalizes DATE UNTIL before INTERVAL without changing yearly recurrence semantics", () => {
  const submitted = "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20260503";
  const fromGoogle = "RRULE:FREQ=YEARLY;UNTIL=20260503;INTERVAL=1";
  assert.equal(sameSafeYearlyRecurrenceRule(submitted, fromGoogle), true);
  assert.equal(sameSafeYearlyRecurrenceRule(fromGoogle, submitted), true);
  assert.equal(sameSafeYearlyRecurrenceRule(
    "RRULE:FREQ=YEARLY;UNTIL=20260503", submitted,
  ), true, "an omitted default yearly interval is equivalent to one");
  for (const unsafe of [
    "RRULE:FREQ=YEARLY;INTERVAL=2;UNTIL=20260503",
    "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20270503",
    "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20260503;COUNT=3",
    "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20260503;BYMONTH=5",
    "RRULE:FREQ=YEARLY;INTERVAL=1;INTERVAL=1;UNTIL=20260503",
    "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20260230",
  ]) {
    assert.equal(sameSafeYearlyRecurrenceRule(submitted, unsafe), false, unsafe);
  }
});

test("an already-capped Google master with reordered RRULE components can be resumed", () => {
  const p = plan();
  const e = old();
  e.recurrence = ["RRULE:FREQ=YEARLY;UNTIL=20260503;INTERVAL=1"];
  e.extendedProperties.shared = {
    syncHistoryTaskId: task().id,
    syncHistoryOnly: "true",
    syncHistoryOriginalRule: p.originalRule,
    syncHistorySuccessorId: p.newMasterId,
  };
  assert.deepEqual(
    planFutureSeriesSplit("antonio", task(), e, new Date("2026-10-19T12:00:00Z")),
    p,
  );
});

test("archived master cannot be silently claimed for a different Todoist task or successor", () => {
  const p = plan();
  const e = old();
  e.recurrence = [p.truncatedRule];
  e.extendedProperties.shared = {
    syncHistoryTaskId: task().id, syncHistoryOnly: "true",
    syncHistoryOriginalRule: p.originalRule, syncHistorySuccessorId: "another",
  };
  assert.throws(() => planFutureSeriesSplit("antonio", task(), e, new Date("2026-10-19T12:00:00Z")), /does not match/);
});

test("split refuses unsupported RRULEs, timed events and already elapsed first new dates", () => {
  for (const rrule of ["RRULE:FREQ=DAILY;COUNT=30", "RRULE:FREQ=YEARLY;COUNT=30",
    "RRULE:FREQ=YEARLY;BYDAY=1MO", "RRULE:FREQ=YEARLY;INTERVAL=1;EXDATE=20250503"]) {
    const e = old();
    e.recurrence = [rrule];
    assert.throws(() => planFutureSeriesSplit("antonio", task(), e, new Date("2026-10-19T12:00:00Z")));
  }
  const timed = old();
  timed.start = { dateTime: "2025-05-03T10:00:00Z" };
  assert.throws(() => planFutureSeriesSplit("antonio", task(), timed, new Date("2026-10-19T12:00:00Z")));
  const overdue = task();
  overdue.due.date = "2024-07-01";
  assert.throws(() => planFutureSeriesSplit("antonio", overdue, old(), new Date("2026-10-19T12:00:00Z")));
});

test("future-only split preserves the last real occurrence for supported all-day cadences", () => {
  const cases = [
    { rule: "RRULE:FREQ=DAILY;INTERVAL=2", start: "2024-01-01", due: "2026-11-29",
      dueString: "every Sunday", next: "2026-11-28", prior: "2026-11-26", newRule: "RRULE:FREQ=WEEKLY;BYDAY=SU" },
    { rule: "RRULE:FREQ=WEEKLY;BYDAY=WE", start: "2024-01-03", due: "2026-12-02",
      dueString: "every 2 weeks", next: "2026-12-02", prior: "2026-11-25", newRule: "RRULE:FREQ=WEEKLY;INTERVAL=2" },
    { rule: "RRULE:FREQ=MONTHLY;BYDAY=2TU", start: "2024-01-09", due: "2026-12-08",
      dueString: "every 2 months", next: "2026-12-08", prior: "2026-11-10", newRule: "RRULE:FREQ=MONTHLY;INTERVAL=2" },
  ];
  for (const item of cases) {
    const source = task();
    source.due = { date: item.due, is_recurring: true, string: item.dueString };
    const master = old();
    master.start = { date: item.start };
    master.end = { date: new Date(Date.parse(item.start + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) };
    master.recurrence = [item.rule];
    const p = planFutureSeriesSplit("antonio", source, master, new Date("2026-11-28T12:00:00Z"));
    assert.equal(p.previousOccurrence, item.prior, item.rule);
    assert.equal(p.nextOldOccurrence, item.next, item.rule);
    assert.equal(p.truncatedRule, `${item.rule};UNTIL=${item.prior.replace(/-/g, "")}`, item.rule);
    assert.equal(p.newRule, item.newRule, item.rule);
  }
});

test("timed future-only split cuts the old RRULE at the exact pre-DST occurrence instant", () => {
  const master = { id: "london-weekly-master", iCalUID: "london-weekly-series", status: "confirmed",
    etag: '"london-master-v1"', summary: task().content,
    start: { dateTime: "2026-03-29T09:00:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-03-29T10:00:00+01:00", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
    extendedProperties: { shared: { taskId: task().id, syncSeriesId: "london-weekly-series" } } };
  const timedTask = { ...task(), due: { datetime: "2027-03-28T09:00:00+01:00", timezone: "Europe/London",
    is_recurring: true, string: "every 2 weeks" } };
  const plan = planFutureSeriesSplit("antonio", timedTask, master,
    new Date("2027-03-27T12:00:00Z"), "Europe/London", undefined, "london-weekly-series");
  assert.equal(plan.previousOccurrence, "2027-03-21T09:00:00.000Z");
  assert.equal(plan.nextOldOccurrence, "2027-03-28");
  assert.equal(plan.truncatedRule, "RRULE:FREQ=WEEKLY;UNTIL=20270321T090000Z");
  assert.equal(plan.newRule, "RRULE:FREQ=WEEKLY;INTERVAL=2");
  assert.equal(plan.newStart, timedTask.due.datetime);
  assert.equal(sameSafeFutureRecurrenceRule(plan.truncatedRule, "RRULE:UNTIL=20270321T090000Z;FREQ=WEEKLY",
    master.start.dateTime, "Europe/London"), true);
  assert.equal(sameSafeFutureRecurrenceRule(plan.truncatedRule, "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20270321T090000Z",
    master.start.dateTime, "Europe/London"), false);
});

test("timed future-only split rejects ambiguous local wall times", () => {
  const makePlan = (start, due) => {
    const master = { id: "london-wall-time-master", iCalUID: "london-wall-time-series", status: "confirmed",
      etag: '"london-wall-time-v1"', summary: task().content,
      start: { dateTime: start, timeZone: "Europe/London" },
      end: { dateTime: new Date(Date.parse(start) + 3_600_000).toISOString(), timeZone: "Europe/London" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
      extendedProperties: { shared: { taskId: task().id, syncSeriesId: "london-wall-time-series" } } };
    const timedTask = { ...task(), due: { datetime: due, timezone: "Europe/London",
      is_recurring: true, string: "every 2 weeks" } };
    return () => planFutureSeriesSplit("antonio", timedTask, master,
      new Date("2027-03-27T12:00:00Z"), "Europe/London", undefined, "london-wall-time-series");
  };
  assert.throws(makePlan("2026-10-25T01:30:00+01:00", "2027-03-28T09:00:00+01:00"), /missing or ambiguous/);
});

test("old modified, cancelled or missing historical instances require operator review", () => {
  const p = plan();
  const instance = (date) => ({
    id: "instance-" + date, recurringEventId: old().id, status: "confirmed",
    summary: old().summary, start: { date }, end: { date: new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) },
    originalStartTime: { date },
  });
  const good = [instance("2025-05-03"), instance("2026-05-03")];
  assert.doesNotThrow(() => assertUnmodifiedHistoricalOccurrences(old(), good, p));
  assert.throws(() => assertUnmodifiedHistoricalOccurrences(old(), [good[0]], p), /Last historical/);
  assert.throws(() => assertUnmodifiedHistoricalOccurrences(old(), [
    good[0], { ...good[1], status: "cancelled" },
  ], p), /exception/);
  assert.throws(() => assertUnmodifiedHistoricalOccurrences(old(), [
    good[0], { ...good[1], start: { date: "2026-05-04" } },
  ], p), /exception/);
});

test("Calendar local midnight, not UTC midnight, determines historical cutoff during BST", () => {
  const instant = new Date("2027-05-03T23:30:00Z"); // May 4 00:30 BST
  const local = planFutureSeriesSplit("antonio", task(), old(), instant, "Europe/London");
  const utc = planFutureSeriesSplit("antonio", task(), old(), instant, "UTC");
  assert.equal(local.previousOccurrence, "2027-05-03");
  assert.equal(local.truncatedRule, "RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20270503");
  assert.equal(utc.previousOccurrence, "2026-05-03");
  assert.equal(local.calendarTimeZone, "Europe/London");
});

test("an RRULE with UNTIL before DTSTART stays expired; the 2027 successor never backfills history", () => {
  const master = old();
  master.recurrence = ["RRULE:FREQ=YEARLY;UNTIL=20231231"];
  master.start.date = "2025-05-02";
  master.end.date = "2025-05-03";
  master.summary = "LL09 FZV honda vehicle tax bike expiry";
  const next = task();
  next.content = master.summary;
  next.due = { date: "2027-05-02", is_recurring: true, string: "every year" };
  const p = planFutureSeriesSplit("antonio", next, master, new Date("2026-10-22T12:00:00Z"), "Europe/London");
  assert.equal(p.originalRule, "RRULE:FREQ=YEARLY;UNTIL=20231231");
  assert.equal(p.truncatedRule, p.originalRule, "never expand the expired Calendar series");
  assert.equal(p.expiredUntil, "2023-12-31");
  assert.equal(p.historicalLastOccurrence, undefined, "original rule never produced an instance");
  assert.equal(p.previousOccurrence, undefined, "do not persist a phantom pre-repair anniversary");
  assert.ok(p.approvedTaskFingerprint, "bind approval to the entire Todoist task and due shape");
  assert.equal(p.newStart, "2027-05-02");
  assert.equal(p.newRule, "RRULE:FREQ=YEARLY");
  assert.doesNotThrow(() => assertUnmodifiedHistoricalOccurrences(master, [], p));
  assert.throws(() => assertUnmodifiedHistoricalOccurrences(master, [{
    recurringEventId: master.id, start: { date: "2025-05-02" },
    end: { date: "2025-05-03" }, status: "confirmed",
    summary: master.summary,
  }], p), /Last historical/);
});

test("expired UNTIL after DTSTART verifies actual history and preserves the old cap", () => {
  const master = old();
  master.recurrence = ["RRULE:UNTIL=20251231;FREQ=YEARLY;INTERVAL=1"];
  // Calendar may reorder components; the supported subset is order-agnostic.
  const p = planFutureSeriesSplit("antonio", task(), master, new Date("2026-10-19T12:00:00Z"));
  assert.equal(p.truncatedRule, master.recurrence[0]);
  assert.equal(p.expiredUntil, "2025-12-31");
  assert.equal(p.historicalLastOccurrence, "2025-05-03");
  assert.equal(p.previousOccurrence, "2025-05-03", "history cutoff must respect the expired UNTIL");
  assert.throws(() => assertUnmodifiedHistoricalOccurrences(master, [], p), /Last historical/);
});

test("unsupported or ambiguous expiry clauses fail closed with actionable guidance", () => {
  for (const rule of [
    "RRULE:FREQ=YEARLY;COUNT=3", "RRULE:FREQ=YEARLY;RDATE=20270502",
    "RRULE:FREQ=YEARLY;EXDATE=20250502", "RRULE:FREQ=YEARLY;UNTIL=20231231;BYDAY=1MO",
    "RRULE:FREQ=YEARLY;UNTIL=20231231T000000Z", "RRULE:FREQ=YEARLY;UNTIL=20231231;UNTIL=20231231",
  ]) {
    const master = old(); master.recurrence = [rule];
    assert.throws(() => planFutureSeriesSplit("antonio", task(), master, new Date("2026-10-19T12:00:00Z")), /manual review/, rule);
  }
  const master = old();
  master.recurrence = ["RRULE:FREQ=YEARLY", "EXDATE;VALUE=DATE:20250503"];
  assert.throws(() => planFutureSeriesSplit("antonio", task(), master), /RDATE, EXDATE/);
  master.recurrence = ["RRULE:FREQ=YEARLY;UNTIL=20991231"];
  assert.throws(() => planFutureSeriesSplit("antonio", task(), master, new Date("2026-10-19T12:00:00Z")), /not yet expired/);
});
