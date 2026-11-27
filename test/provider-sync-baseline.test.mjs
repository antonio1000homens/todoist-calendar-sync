import assert from "node:assert/strict";
import test from "node:test";
import { providerRecurrenceChanges, providerSyncBaseline } from "../dist/provider-sync-baseline.js";

test("recurrence baselines treat natural-language aliases and RRULE field order as the same cadence", () => {
  const task = { id: "annual", due: { date: "2027-06-06", is_recurring: true, string: "every June 6" } };
  const master = { id: "annual-master", start: { date: "2027-06-06" },
    recurrence: ["RRULE:FREQ=YEARLY;BYMONTHDAY=6;BYMONTH=6"] };
  const baseline = providerSyncBaseline(task, master, master);
  const aliasTask = { ...task, due: { ...task.due, string: "every 6 June" } };
  const reorderedMaster = { ...master,
    recurrence: ["RRULE:BYMONTH=6;FREQ=YEARLY;BYMONTHDAY=6"] };
  assert.deepEqual(providerRecurrenceChanges(aliasTask, reorderedMaster, baseline), {
    todoistChanged: false, calendarChanged: false,
  });
});
