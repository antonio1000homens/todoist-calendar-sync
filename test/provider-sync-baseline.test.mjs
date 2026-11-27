import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../dist/security.js";
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

test("historical v1 recurrence baseline uses its original Todoist text and Calendar components", () => {
  const task = { id: "legacy", due: { date: "2027-06-06", is_recurring: true, string: "every June 6" } };
  const master = { id: "legacy-master", start: { date: "2027-06-06" },
    recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=6"] };
  const legacyHash = value => sha256(JSON.stringify(value));
  const baseline = {
    version: 1,
    todoist: { recurrence: legacyHash("every June 6") },
    calendar: { recurrence: legacyHash(master.recurrence) },
  };
  assert.deepEqual(providerRecurrenceChanges(task, master, baseline), {
    todoistChanged: false, calendarChanged: false,
  });
  assert.deepEqual(providerRecurrenceChanges({ ...task,
    due: { ...task.due, string: "every 2 weeks" } }, master, baseline), {
    todoistChanged: true, calendarChanged: false,
  });
});

test("projection boundaries normalize with Calendar cadence and preserve old v2 baselines", () => {
  const master = { id: "historical-master", start: { date: "2026-01-01" },
    recurrence: ["RRULE:FREQ=YEARLY"] };
  const task = { id: "projected", due: { date: "2027-01-01", is_recurring: true,
    string: "every 1 Jan starting 1 Jan 2027" } };
  const baseline = providerSyncBaseline(task, master, master);
  for (const phrase of ["every January 1 starting 2027-01-01", "every Jan 1", "every 1 January starting 1 Jan"]) {
    assert.deepEqual(providerRecurrenceChanges({ ...task, due: { ...task.due, string: phrase } }, master, baseline), {
      todoistChanged: false, calendarChanged: false,
    }, phrase);
  }
  assert.deepEqual(providerRecurrenceChanges({ ...task,
    due: { ...task.due, string: "every 1 Jan starting 2 Jan 2027" } }, master, baseline), {
    todoistChanged: true, calendarChanged: false,
  }, "an off-phase explicit boundary is never normalized away");

  const oldV2 = structuredClone(baseline);
  oldV2.todoist.recurrence = sha256(JSON.stringify("every 1 jan starting 1 jan 2027"));
  assert.deepEqual(providerRecurrenceChanges({ ...task,
    due: { ...task.due, string: "every January 1 starting 2027-01-01" } }, master, oldV2), {
    todoistChanged: false, calendarChanged: false,
  }, "a prior v2 raw-text hash migrates when current state proves the Calendar cadence");
});
