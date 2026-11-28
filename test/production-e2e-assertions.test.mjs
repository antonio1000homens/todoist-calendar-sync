import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarResourceAbsent,
  calendarOwnedRecurrenceCorrelationMatches,
  sameProviderInstant,
  uniqueProjectEventMapping,
  uniqueProjectTaskMapping,
  uniqueProjectTaskMappingForEvent,
  unsupportedCalendarRecurrencePreserved,
} from "../scripts/production-e2e-assertions.mjs";

test("Calendar cleanup treats cancelled resources as deleted", () => {
  assert.equal(calendarResourceAbsent(undefined), true);
  assert.equal(calendarResourceAbsent({ status: "cancelled" }), true);
  assert.equal(calendarResourceAbsent({ status: "confirmed" }), false);
});

test("provider due values compare by instant across serialization formats", () => {
  assert.equal(sameProviderInstant("2026-11-30T15:00:00Z", "2026-11-30T15:00:00.000Z"), true);
  assert.equal(sameProviderInstant("2026-11-30T15:00:00Z", "2026-11-30T16:00:00+01:00"), true);
  assert.equal(sameProviderInstant("2026-11-30T15:00:00Z", "2026-11-30T15:30:00Z"), false);
  assert.equal(sameProviderInstant(undefined, "2026-11-30T15:00:00Z"), false);
});

test("Calendar recurrence correlation uses the active occurrence and explicit master link", () => {
  const event = { extendedProperties: { shared: {
    taskId: "task-1", syncTaskId: "task-1", syncProfile: "antonio", syncCalendarId: "calendar",
    syncEventId: "master-1", syncMasterEventId: "master-1", syncActiveInstanceId: "instance-1",
    syncProgressVersion: "1",
  } } };
  const mapping = { profile: "antonio", calendarId: "calendar", masterEventId: "master-1",
    eventId: "instance-1", activeInstanceId: "instance-1", taskId: "task-1", calendarProgressVersion: 1 };
  assert.equal(calendarOwnedRecurrenceCorrelationMatches({
    event, mapping, profile: "antonio", calendarId: "calendar", masterEventId: "master-1",
  }), true);
  assert.equal(calendarOwnedRecurrenceCorrelationMatches({
    event, mapping: { ...mapping, eventId: "master-1" }, profile: "antonio", calendarId: "calendar", masterEventId: "master-1",
  }), false, "the stored event ID must be the active instance");
});

const rule = "RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1";
const title = "[E2E fixture] Unsupported Calendar recurrence";
const passingState = {
  readback: { id: "calendar-master", status: "confirmed", recurrence: [rule] },
  expectedEventId: "calendar-master",
  expectedRule: [rule],
  tasks: [{ content: "Unrelated task" }],
  fixtureTitle: title,
  mapping: undefined,
};

test("unsupported Calendar recurrence acceptance requires the rule and source to remain unprojected", () => {
  assert.equal(unsupportedCalendarRecurrencePreserved(passingState), true);
  assert.equal(unsupportedCalendarRecurrencePreserved({
    ...passingState,
    readback: { recurrence: ["RRULE:FREQ=MONTHLY"] },
  }), false, "Calendar rule was rewritten");
  assert.equal(unsupportedCalendarRecurrencePreserved({
    ...passingState,
    readback: { ...passingState.readback, id: "other-master" },
  }), false, "the readback must be the exact Calendar master");
  assert.equal(unsupportedCalendarRecurrencePreserved({
    ...passingState,
    readback: { ...passingState.readback, status: "cancelled" },
  }), false, "a cancelled master does not prove the source was preserved");
  assert.equal(unsupportedCalendarRecurrencePreserved({
    ...passingState,
    tasks: [...passingState.tasks, { content: title }],
  }), false, "a flattened or native Todoist mirror was created");
  assert.equal(unsupportedCalendarRecurrencePreserved({
    ...passingState,
    mapping: { taskId: "unexpected-task", masterEventId: "calendar-master" },
  }), false, "provider correlation was created for an unsupported rule");
});

const mappingEntry = (id, payload) => ({ comment: { id }, payload });

test("live acceptance requires exactly one mapping for a project task and the expected event or master", () => {
  const current = mappingEntry("comment-current", {
    projectId: "project-1", taskId: "task-1", eventId: "instance-1", masterEventId: "master-1",
  });
  const index = { parsed: [current, mappingEntry("unrelated", {
    projectId: "project-1", taskId: "task-2", eventId: "other-master",
  })] };
  assert.equal(uniqueProjectTaskMapping(index, "project-1", "task-1"), current);
  assert.equal(uniqueProjectTaskMappingForEvent(index, "project-1", "master-1", "task-1"), current);
  assert.equal(uniqueProjectTaskMappingForEvent(index, "project-1", "wrong-event", "task-1"), undefined);
  assert.equal(uniqueProjectEventMapping(index, "project-1", "master-1"), current);
});

test("live acceptance rejects duplicate mapping comments instead of accepting the first page match", () => {
  const index = { parsed: [
    mappingEntry("comment-current", { projectId: "project-1", taskId: "task-1", eventId: "event-1" }),
    mappingEntry("comment-stale", { projectId: "project-1", taskId: "task-1", eventId: "event-2" }),
  ] };
  assert.throws(() => uniqueProjectTaskMapping(index, "project-1", "task-1"), /found 2/);
  assert.throws(() => uniqueProjectTaskMappingForEvent(index, "project-1", "event-1", "task-1"), /found 2/);
});

test("live acceptance rejects multiple tasks claiming one Calendar event", () => {
  const index = { parsed: [
    mappingEntry("comment-one", { projectId: "project-1", taskId: "task-1", eventId: "event-1" }),
    mappingEntry("comment-two", { projectId: "project-1", taskId: "task-2", masterEventId: "event-1" }),
  ] };
  assert.throws(() => uniqueProjectEventMapping(index, "project-1", "event-1"), /found 2/);
});
