import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarPhaseCCandidate, verifyCalendarPhaseCReadback,
} from "../dist/calendar-todoist-phase-c.js";

function master(start, rule, zone) {
  return {
    id: "calendar-master", etag: "provider-etag", status: "confirmed",
    start: zone ? { dateTime: start, timeZone: zone } : { date: start },
    recurrence: [rule],
  };
}
function task(date, phrase, zone) {
  return {
    id: "todoist-task", project_id: "isolated-project", content: "Test recurrence",
    due: {
      ...(zone ? { datetime: date, timezone: zone } : { date }),
      string: phrase, is_recurring: true,
    },
  };
}
function instance(date, index, zone) {
  const start = zone ? { dateTime: date, timeZone: zone } : { date };
  return {
    id: "occurrence-" + index, recurringEventId: "calendar-master",
    status: "confirmed", originalStartTime: start, start,
  };
}
function readback(calendar, dates, phrase, zone) {
  return {
    persistedMaster: calendar,
    beforeCompletion: task(dates[0], phrase, zone),
    afterCompletion: task(dates[1], phrase, zone),
    calendarInstances: dates.slice(0, 3).map((date, i) => instance(date, i, zone)),
    explicitExceptions: [],
    exceptionInventoryComplete: true,
    timeZoneVerified: true,
    verifiedLink: {
      masterEventId: calendar.id, taskId: "todoist-task",
      projectId: "isolated-project", owner: "calendar",
    },
  };
}
test("Phase C generates strict, READ-ONLY bidirectional candidates for four simple families", () => {
  const cases = [
    ["2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR", "multi_weekday",
      "every mon, fri", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR"],
    ["2027-01-02", "RRULE:BYMONTHDAY=27,2,15;FREQ=MONTHLY", "multi_month_day",
      "every 2, 15, 27", "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"],
    ["2027-01-15", "RRULE:FREQ=WEEKLY;BYDAY=FR;INTERVAL=2", "alternate_weekday",
      "every other fri", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"],
    ["2027-01-10", "RRULE:FREQ=MONTHLY;INTERVAL=2", "monthly_interval",
      "every 2 months", "RRULE:FREQ=MONTHLY;INTERVAL=2"],
  ];
  for (const [start, rule, family, phrase, canonical] of cases) {
    const proposal = calendarPhaseCCandidate(master(start, rule));
    assert.equal(proposal.family, family);
    assert.equal(proposal.todoistPhrase, phrase);
    assert.equal(proposal.candidateRrule, canonical);
    assert.equal(proposal.disposition, "rolling_required", "no candidate enables production writes");
    assert.equal(proposal.reason, "provider_readback_required");
  }
});
test("synthetic complete readbacks prove month-day list and weekday list progression without new identity", () => {
  const samples = [
    [master("2027-01-02", "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"),
      ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"]],
    [master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR"),
      ["2027-01-01", "2027-01-04", "2027-01-08", "2027-01-11"]],
    [master("2027-01-15", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"),
      ["2027-01-15", "2027-01-29", "2027-02-12", "2027-02-26"]],
    [master("2027-01-10", "RRULE:FREQ=MONTHLY;INTERVAL=2"),
      ["2027-01-10", "2027-03-10", "2027-05-10", "2027-07-10"]],
  ];
  for (const [calendar, dates] of samples) {
    const phrase = calendarPhaseCCandidate(calendar).todoistPhrase;
    const proof = readback(calendar, dates, phrase);
    const result = verifyCalendarPhaseCReadback(calendar, undefined, proof);
    assert.equal(result.disposition, "native_exact", result.reason);
    assert.deepEqual(verifyCalendarPhaseCReadback(calendar, undefined, proof), result,
      "an identical verification is pure and idempotent");
  }
});
test("missing anchor phase, wrong ordinal and finite/cancelled/other-owned rules fail closed", () => {
  const invalid = [
    [master("2027-01-06", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR"), "anchor_or_occurrence_mismatch"],
    [master("2027-01-22", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"), "provider_readback_required"],
    [master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;UNTIL=20271231"), "finite_provider_validation_required"],
    [master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;COUNT=5"), "finite_provider_validation_required"],
    [master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;EXDATE=20270104"), "unsupported_component"],
    [master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYDAY=TU"), "duplicate_component"],
  ];
  for (const [calendar, reason] of invalid)
    assert.equal(calendarPhaseCCandidate(calendar).reason, reason, calendar.recurrence[0]);
  assert.equal(calendarPhaseCCandidate({
    ...master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR"),
    extendedProperties: { shared: { syncRecurrenceOwner: "todoist" } },
  }).disposition, "unsupported");
  assert.equal(calendarPhaseCCandidate({
    ...master("2027-01-01", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR"), recurrence: [
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR", "EXDATE:20270104",
    ],
  }).disposition, "unsupported");
});
test("independent task identity, provider state, exceptions and completion are mandatory", () => {
  const calendar = master("2027-01-02", "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27");
  const dates = ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"];
  const proof = readback(calendar, dates, "every 2, 15, 27");
  const cases = [
    { verifiedLink: { ...proof.verifiedLink, owner: "todoist" } },
    { verifiedLink: { ...proof.verifiedLink, projectId: "unrelated-project" } },
    { beforeCompletion: { ...proof.beforeCompletion, id: "wrong-task" } },
    { afterCompletion: { ...proof.afterCompletion, due: { ...proof.afterCompletion.due, date: dates[2] } } },
    { afterCompletion: { ...proof.afterCompletion, due: { ...proof.afterCompletion.due, string: "every 2, 15" } } },
    { beforeCompletion: { ...proof.beforeCompletion, due: { ...proof.beforeCompletion.due, is_recurring: false } } },
    { persistedMaster: { ...calendar, etag: undefined } },
    { persistedMaster: { ...calendar, recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15"] } },
    { explicitExceptions: [instance(dates[1], 19)] },
    { exceptionInventoryComplete: false },
    { calendarInstances: [instance(dates[0], 0)] },
    { calendarInstances: [instance(dates[0], 0), instance(dates[2], 2), instance(dates[3], 3)] },
    { calendarInstances: [instance(dates[0], 0), { ...instance(dates[1], 1),
      start: { date: "2027-01-16" } }, instance(dates[2], 2)] },
  ];
  for (const modified of cases) {
    const result = verifyCalendarPhaseCReadback(calendar, undefined, { ...proof, ...modified });
    assert.equal(result.disposition, "rolling_required", JSON.stringify(modified));
    assert.notEqual(result.reason, "verified_equivalent");
  }
});
test("timed multi-weekday Calendar recurrence preserves London wall-time over BST", () => {
  const zone = "Europe/London";
  const calendar = master("2027-03-26T09:00:00Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR", zone);
  const proposal = calendarPhaseCCandidate(calendar, zone);
  assert.equal(proposal.todoistPhrase, "every mon, fri at 9:00am");
  const dates = ["2027-03-26T09:00:00Z", "2027-03-29T08:00:00Z",
    "2027-04-02T08:00:00Z", "2027-04-05T08:00:00Z"];
  const proof = readback(calendar, dates, proposal.todoistPhrase, zone);
  assert.equal(verifyCalendarPhaseCReadback(calendar, zone, proof).disposition, "native_exact");
  assert.equal(verifyCalendarPhaseCReadback(calendar, zone, {
    ...proof, timeZoneVerified: false,
  }).disposition, "rolling_required");
  assert.equal(verifyCalendarPhaseCReadback(calendar, zone, {
    ...proof, afterCompletion: {
      ...proof.afterCompletion,
      due: { ...proof.afterCompletion.due, datetime: "2027-03-29T09:00:00Z" },
    },
  }).disposition, "rolling_required", "a one-hour BST drift must not be accepted");
  assert.equal(verifyCalendarPhaseCReadback(calendar, zone, {
    ...proof, afterCompletion: {
      ...proof.afterCompletion,
      due: { ...proof.afterCompletion.due, string: "every mon, fri at 8am" },
    },
  }).disposition, "rolling_required", "Todoist's normalized text must not change local time");
});
test("monthly 29/30/31 skips short months and rejects made-up Feb 28", () => {
  const calendar = master("2027-01-29", "RRULE:FREQ=MONTHLY;BYMONTHDAY=29,30,31");
  const proposal = calendarPhaseCCandidate(calendar);
  assert.equal(proposal.disposition, "rolling_required");
  assert.equal(proposal.todoistPhrase, "every 29, 30, 31");
  const correct = ["2027-01-29", "2027-01-30", "2027-01-31", "2027-03-29"];
  const proof = readback(calendar, correct, proposal.todoistPhrase);
  assert.equal(verifyCalendarPhaseCReadback(calendar, undefined, proof).disposition, "native_exact");
  assert.equal(verifyCalendarPhaseCReadback(calendar, undefined, {
    ...proof, afterCompletion: task("2027-02-28", proposal.todoistPhrase),
  }).disposition, "rolling_required");
});
