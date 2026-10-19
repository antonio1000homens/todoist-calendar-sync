import assert from "node:assert/strict";
import test from "node:test";
import {
  planFutureSeriesSplit, assertUnmodifiedHistoricalOccurrences,
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
  for (const rrule of ["RRULE:FREQ=MONTHLY", "RRULE:FREQ=YEARLY;COUNT=30",
    "RRULE:FREQ=YEARLY;BYMONTH=5", "RRULE:FREQ=YEARLY;INTERVAL=1;EXDATE=20250503"]) {
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
