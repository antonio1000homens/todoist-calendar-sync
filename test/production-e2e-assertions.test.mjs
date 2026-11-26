import assert from "node:assert/strict";
import test from "node:test";
import { unsupportedCalendarRecurrencePreserved } from "../scripts/production-e2e-assertions.mjs";

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
