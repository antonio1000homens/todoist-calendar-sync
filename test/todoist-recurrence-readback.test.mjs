import assert from "node:assert/strict";
import test from "node:test";
import { calendarRecurrenceMatchesTodoist, calendarRuleMatches } from "../dist/todoist-recurrence.js";

const task = { due: { date: "2027-06-06", is_recurring: true, string: "every June 6" } };
const master = { start: { date: "2027-06-06" },
  recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=6"] };

test("recurrence readback accepts one semantically equivalent RRULE", () => {
  assert.equal(calendarRuleMatches(master, "RRULE:BYMONTHDAY=6;FREQ=YEARLY;BYMONTH=6"), true);
  assert.equal(calendarRecurrenceMatchesTodoist(master, task), true);
});

test("recurrence readback rejects extra rules and explicit exception components", () => {
  for (const component of [
    "RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25",
    "RDATE:2027-12-25",
    "EXDATE:2027-12-25",
    "EXRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25",
  ]) {
    const altered = { ...master, recurrence: [...master.recurrence, component] };
    assert.equal(calendarRuleMatches(altered, master.recurrence[0]), false, component);
    assert.equal(calendarRecurrenceMatchesTodoist(altered, task), false, component);
  }
});
