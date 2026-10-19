import assert from "node:assert/strict";
import test from "node:test";
import {
  competingUnmappedIdentities, manualConflictWindow, unresolvedStandalonePair,
} from "../dist/unmapped-resolution.js";

const task = {
  id: "insta", content: "Insta360 auto-renewal", description: "",
  due: { date: "2027-03-06", is_recurring: true, string: "every year" },
};
const event = {
  id: "legacy", status: "confirmed", summary: task.content,
  start: { date: "2027-03-06" }, end: { date: "2027-03-07" },
  extendedProperties: { shared: { taskId: "insta" } },
};

test("one linked standalone task/event pair is eligible for explicit owner selection", () => {
  assert.equal(unresolvedStandalonePair(task, event), true);
  assert.equal(unresolvedStandalonePair(task, { ...event, recurrence: ["RRULE:FREQ=YEARLY"] }), false);
  assert.equal(unresolvedStandalonePair(task, { ...event, recurringEventId: "another-series" }), false);
  assert.equal(unresolvedStandalonePair(task, { ...event, status: "cancelled" }), false);
  assert.equal(unresolvedStandalonePair(task, { ...event, extendedProperties: { shared: { taskId: "other" } } }), false);
  assert.equal(unresolvedStandalonePair(task, { ...event, summary: "Other" }), false);
});

test("duplicate lookup detects existing master series occurrence even when it has no task ID", () => {
  const current = [event, { ...event, id: "master_20270306", recurringEventId: "master", extendedProperties: undefined }];
  const result = competingUnmappedIdentities(task, event, [task], current);
  assert.deepEqual(result.taskIds, []);
  assert.deepEqual(result.eventIds, ["master_20270306"]);
  assert.equal(result.sawTarget, true);
});

test("competing Todoist task with the same title is flagged even if it has no recurrence", () => {
  const result = competingUnmappedIdentities(task, event, [
    task, { ...task, id: "duplicate", due: { date: "2027-03-06" } },
  ], [event]);
  assert.deepEqual(result.taskIds, ["duplicate"]);
  assert.deepEqual(result.eventIds, []);
});

test("no candidate occurrence means lookup did not establish uniqueness", () => {
  assert.deepEqual(competingUnmappedIdentities(task, event, [task], []), {
    taskIds: [], eventIds: [], sawTarget: false,
  });
});

test("date-bound occurrence lookup includes surrounding timezone days", () => {
  const { start, end } = manualConflictWindow(task);
  assert.equal(start, "2027-03-04T12:00:00.000Z");
  assert.equal(end, "2027-03-08T12:00:00.000Z");
});
