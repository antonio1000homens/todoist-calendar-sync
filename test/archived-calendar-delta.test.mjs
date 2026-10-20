import test from "node:test";
import assert from "node:assert/strict";
import { Synchronizer, toCalendarEvent } from "../dist/sync.js";

const historicalMaster = {
  id: "old-master", status: "confirmed", summary: "Replace battery smoke alarm",
  start: { date: "2025-05-03" }, end: { date: "2025-05-04" },
  recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20260503"],
  extendedProperties: { shared: { syncSource: "todoist-calendar-sync",
    syncHistoryOnly: "true", syncHistoryTaskId: "original-task" } },
};
const historicOccurrence = {
  id: "old-master_20260503", recurringEventId: "old-master",
  status: "confirmed", summary: "Replace battery smoke alarm",
  start: { date: "2026-05-03" }, end: { date: "2026-05-04" },
};

test("Calendar delta edits on archived occurrences never recreate Todoist tasks", async () => {
  const audits = [];
  const state = {
    async getSyncToken() { return "valid-sync-token"; },
    async putSyncToken() {},
    async audit(_profile, action) { audits.push(action); },
  };
  let getMaster = 0;
  let writes = 0;
  const sync = new Synchronizer(state, undefined, async () => ({
    calendar: {
      async listDelta() { return { items: [historicOccurrence, historicalMaster], nextSyncToken: "next-token" }; },
      async getEvent(id) { assert.equal(id, historicalMaster.id); getMaster += 1; return historicalMaster; },
    },
    todoist: {
      async listTasks() { throw new Error("Archived instances must never enter task matching"); },
      async upsertTask() { writes += 1; throw new Error("Historical task resurrection"); },
    },
  }));
  await sync.process({
    id: "delta-archived-1", kind: "calendar", profile: "antonio", mode: "aws",
    receivedAt: "2026-10-19T21:00:00Z", headers: {}, body: "",
  });
  assert.equal(getMaster, 1);
  assert.equal(writes, 0);
  assert.equal(audits.filter((action) => action === "calendar_archived_series_delta_ignored").length, 2);
});

test("normal Todoist title edits preserve all three future split history references", () => {
  const task = {
    id: "original-task", content: "Replace battery smoke alarm – new title",
    description: "Updated note",
    due: { date: "2027-07-01", is_recurring: true, string: "every 2 years" },
  };
  const original = toCalendarEvent(task);
  const prior = {
    ...original, id: "new-future-master",
    extendedProperties: { shared: { ...original.extendedProperties.shared,
      syncHistoryMasterId: "old-master", syncHistoryCutoff: "2026-05-03",
      syncSplitVersion: "1",
    } },
  };
  const edited = toCalendarEvent(task, prior);
  assert.equal(edited.extendedProperties.shared.syncHistoryMasterId, "old-master");
  assert.equal(edited.extendedProperties.shared.syncHistoryCutoff, "2026-05-03");
  assert.equal(edited.extendedProperties.shared.syncSplitVersion, "1");
});
