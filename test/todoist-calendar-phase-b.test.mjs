import assert from "node:assert/strict";
import test from "node:test";
import {
  todoistPhaseBCandidate, verifyTodoistPhaseBReadback,
} from "../dist/todoist-calendar-phase-b.js";

function task(date, phrase, id = "task-phase-b", extras = {}) {
  return { id, content: "Phase B", due: { date, string: phrase, is_recurring: true, ...extras } };
}

function master(taskId, anchor, rule, timeZone, phrase) {
  return {
    id: "calendar-master", etag: "etag-live", status: "confirmed",
    start: timeZone ? { dateTime: anchor, timeZone } : { date: anchor },
    recurrence: [rule],
    extendedProperties: { shared: { taskId, syncRecurrenceOwner: "todoist",
      todoistRecurrence: phrase?.toLowerCase(), todoistAnchorStart: anchor } },
  };
}

function instances(masterId, dates) {
  return dates.map((date, i) => ({
    id: "instance-" + i, recurringEventId: masterId, status: "confirmed",
    start: { date }, originalStartTime: { date },
  }));
}

const knownAnchor = (start, timeZone) => ({
  start, ...(timeZone ? { timeZone } : {}), source: "verified_original_schedule",
});

function readbacks(phrase, anchor, dates, index = 0, options = {}) {
  const before = task(dates[index], phrase);
  const after = task(dates[index + 1], phrase);
  const candidate = todoistPhaseBCandidate(before, knownAnchor(anchor));
  return {
    beforeCompletion: before, afterCompletion: after,
    calendarMaster: master(before.id, anchor, candidate.candidateRrule, undefined, phrase),
    calendarInstances: instances("calendar-master", dates.slice(0, 3)),
    exceptionInventoryComplete: true, timeZoneVerified: true,
    ...options,
  };
}

test("Phase B new rule families stay on rolling without original anchor and provider proof", () => {
  const examples = [
    [task("2027-01-15", "every 2, 15, 27"), "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"],
    [task("2027-01-15", "every other Friday"), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"],
    [task("2027-01-15", "every quarter"), "RRULE:FREQ=MONTHLY;INTERVAL=3"],
    [task("2027-01-15", "quarterly"), "RRULE:FREQ=MONTHLY;INTERVAL=3"],
  ];
  for (const [item, expected] of examples) {
    const result = todoistPhaseBCandidate(item);
    assert.equal(result.disposition, "rolling_required");
    assert.equal(result.reason, "anchor_not_verified");
    assert.equal(result.candidateRrule, expected);
  }
});

test("monthly BYMONTHDAY list passes persisted master, inventory and completion verification", () => {
  const phrase = "every 2, 15, 27";
  const dates = ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"];
  const proof = readbacks(phrase, dates[0], dates, 1);
  const decision = verifyTodoistPhaseBReadback(proof.beforeCompletion, knownAnchor(dates[0]), proof);
  assert.equal(decision.disposition, "native_exact");
  assert.equal(decision.reason, "verified_equivalent");
  assert.equal(decision.candidateRrule, "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27");
  assert.deepEqual(verifyTodoistPhaseBReadback(proof.beforeCompletion, knownAnchor(dates[0]), proof), decision,
    "identical repeated provider readbacks never create different dispositions");
});

test("alternating Friday is phase-locked to its verified original Friday", () => {
  const phrase = "every other Friday";
  const dates = ["2027-01-15", "2027-01-29", "2027-02-12", "2027-02-26"];
  const proof = readbacks(phrase, dates[0], dates);
  const anchor = knownAnchor(dates[0]);
  assert.equal(verifyTodoistPhaseBReadback(proof.beforeCompletion, anchor, proof).disposition, "native_exact");
  assert.equal(todoistPhaseBCandidate(task("2027-01-22", phrase), anchor).reason, "anchor_or_occurrence_mismatch",
    "an intervening Friday is not part of the same alternating sequence");
  assert.equal(verifyTodoistPhaseBReadback(proof.beforeCompletion, knownAnchor("2027-01-22"), proof).disposition,
    "rolling_required", "wrong starting Friday cannot be promoted");
});

test("quarterly is three calendar months and skips short months rather than 90 days", () => {
  const phrase = "every quarter";
  const dates = ["2027-01-31", "2027-04-30", "2027-07-31", "2027-10-31"];
  const result = todoistPhaseBCandidate(task(dates[0], phrase), knownAnchor(dates[0]));
  assert.equal(result.candidateRrule, "RRULE:FREQ=MONTHLY;INTERVAL=3");
  assert.equal(result.disposition, "rolling_required");
  assert.equal(result.reason, "provider_readback_required");
  // The anchor's Jan 31 cadence skips April's missing 31st. This Todoist
  // advancement cannot safely be treated as equivalent until verified.
  const proof = readbacks(phrase, dates[0], dates);
  assert.equal(verifyTodoistPhaseBReadback(proof.beforeCompletion, knownAnchor(dates[0]), proof).disposition,
    "rolling_required", "an apparent end-of-month adjustment is not an exact RFC5545 recurrence");
});

test("completion readback must advance the same Todoist task by exactly one expected iteration", () => {
  const dates = ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"];
  const proof = readbacks("every 2, 15, 27", dates[0], dates);
  const anchor = knownAnchor(dates[0]);
  for (const after of [
    task("2027-01-27", "every 2, 15, 27", "different-task"),
    task("2027-02-02", "every 2, 15, 27"),
    task("2027-01-16", "every 2, 15, 27"),
    task("2027-01-15", "every 2, 15, 27", undefined, { is_recurring: false }),
  ]) {
    assert.equal(verifyTodoistPhaseBReadback(proof.beforeCompletion, anchor,
      { ...proof, afterCompletion: after }).disposition, "rolling_required");
  }
});

test("Calendar provider evidence cannot be inferred from an HTTP write or generated RRULE alone", () => {
  const dates = ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"];
  const proof = readbacks("every 2, 15, 27", dates[0], dates);
  const anchor = knownAnchor(dates[0]);
  const mutations = [
    { calendarMaster: { ...proof.calendarMaster, etag: undefined } },
    { calendarMaster: { ...proof.calendarMaster, recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15"] } },
    { calendarMaster: { ...proof.calendarMaster, extendedProperties: { shared: { taskId: "unrelated", syncRecurrenceOwner: "todoist" } } } },
    { calendarMaster: { ...proof.calendarMaster, status: "cancelled" } },
    { calendarInstances: proof.calendarInstances.slice(0, 2) },
    { calendarInstances: [{ ...proof.calendarInstances[0], status: "cancelled" }, ...proof.calendarInstances.slice(1)] },
    { calendarInstances: [{ ...proof.calendarInstances[0], start: { date: "2027-01-03" } }, ...proof.calendarInstances.slice(1)] },
    { calendarInstances: [{ ...proof.calendarInstances[0], recurringEventId: "different-master" }, ...proof.calendarInstances.slice(1)] },
    { calendarInstances: [proof.calendarInstances[0], proof.calendarInstances[2], { ...proof.calendarInstances[2], id: "instance-last" }] },
    { exceptionInventoryComplete: false },
  ];
  for (const changes of mutations) {
    const decision = verifyTodoistPhaseBReadback(proof.beforeCompletion, anchor, { ...proof, ...changes });
    assert.equal(decision.disposition, "rolling_required", JSON.stringify(changes));
  }
});

test("finite and completion-relative Todoist rules are excluded from Phase B", () => {
  for (const phrase of ["every! 3 months", "every 2, 15, 27 until 1 Dec",
    "every other Friday starting 2 Jan", "every last workday", "every 3 months"]) {
    assert.equal(todoistPhaseBCandidate(task("2027-01-02", phrase)).disposition, "unsupported", phrase);
  }
});

test("timed Phase B needs observed timezone and consistent DST-aware local wall-time", () => {
  const anchor = knownAnchor("2027-01-15T09:00:00+00:00", "Europe/London");
  const due = { datetime: "2027-01-15T09:00:00+00:00", timezone: "Europe/London",
    string: "every other Friday at 9am", is_recurring: true };
  const before = { id: "task-phase-b", content: "Phase B", due };
  const after = { ...before, due: { ...due, datetime: "2027-01-29T09:00:00+00:00" } };
  const calendar = master(before.id, anchor.start, "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", "Europe/London", due.string);
  const make = (date) => ({
    id: "instance-" + date, recurringEventId: calendar.id, status: "confirmed",
    originalStartTime: { dateTime: date, timeZone: "Europe/London" },
    start: { dateTime: date, timeZone: "Europe/London" },
  });
  const readback = {
    beforeCompletion: before, afterCompletion: after, calendarMaster: calendar,
    calendarInstances: [
      make("2027-01-15T09:00:00+00:00"),
      make("2027-01-29T09:00:00+00:00"),
      make("2027-02-12T09:00:00+00:00"),
    ],
    exceptionInventoryComplete: true, timeZoneVerified: true,
  };
  assert.equal(verifyTodoistPhaseBReadback(before, anchor, readback).disposition, "native_exact");
  assert.equal(verifyTodoistPhaseBReadback(before, anchor,
    { ...readback, timeZoneVerified: false }).disposition, "rolling_required");
  assert.equal(verifyTodoistPhaseBReadback(before, anchor, { ...readback,
    calendarMaster: { ...calendar, start: { ...calendar.start, timeZone: "UTC" } } }).disposition,
    "rolling_required");
});
