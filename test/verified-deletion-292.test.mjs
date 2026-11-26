import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelledOccurrenceMasterId, verifyCancelledSeries, verifyCancelledSeriesInstances,
} from "../dist/verified-deletion.js";

const taskId = "6hqp4fFR45WvJ5VV";
const master = "agejr3i89v5p13lfl95uss11o8";
const active = `${master}_20261116`;
const completed = `${master}_20261102`;
const masterSeriesId = `${master}-gcal-series`;
const cancelledMaster = {
  id: master, status: "cancelled", iCalUID: masterSeriesId,
  recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
};
const cancelledActive = {
  id: active, status: "cancelled", recurringEventId: master, iCalUID: masterSeriesId,
};

test("a legacy instance identifies its master only through a direct cancelled provider read", () => {
  assert.equal(cancelledOccurrenceMasterId(active, cancelledActive), master);
  assert.equal(cancelledOccurrenceMasterId(active, { ...cancelledActive, status: "confirmed" }), undefined);
  assert.equal(cancelledOccurrenceMasterId(active, { ...cancelledActive, recurringEventId: undefined }), undefined);
  assert.equal(cancelledOccurrenceMasterId(active, { ...cancelledActive, id: "another-id" }), undefined);
});

test("cancelled series verification requires the exact master and active instance", () => {
  const valid = verifyCancelledSeries(master, active, [master, active],
    new Map([[master, cancelledMaster], [active, cancelledActive]]));
  assert.equal(valid.valid, true);
  assert.equal(valid.masterSeriesId, masterSeriesId);
  for (const [badMaster, badActive] of [
    [{ ...cancelledMaster, status: "confirmed" }, cancelledActive],
    [{ ...cancelledMaster, iCalUID: undefined }, cancelledActive],
    [cancelledMaster, { ...cancelledActive, recurringEventId: "another-series" }],
    [cancelledMaster, { ...cancelledActive, iCalUID: "foreign-series" }],
  ]) {
    const result = verifyCancelledSeries(master, active, [master, active],
      new Map([[master, badMaster], [active, badActive]]));
    assert.equal(result.valid, false);
  }
  assert.equal(verifyCancelledSeries(master, active, [master], new Map([[master, cancelledMaster]])).valid, false);
});

test("complete Calendar instance inventory preserves completed history and is order independent", async () => {
  const nowMs = Date.parse("2026-11-07T12:00:00Z");
  const previous = {
    id: completed, status: "confirmed", recurringEventId: master,
    iCalUID: masterSeriesId, start: { date: "2026-11-02" },
  };
  const current = { ...cancelledActive, start: { date: "2026-11-16" } };
  const history = {
    profile: "antonio", taskId, eventId: completed,
    masterEventId: master, seriesId: masterSeriesId,
    completedAt: "2026-10-25T19:09:00.177Z",
  };
  const input = {
    profile: "antonio", taskIds: [taskId], masterId: master,
    masterSeriesId, activeInstanceId: active, instances: [previous, current], nowMs,
  };
  let reads = 0;
  const marker = async (id) => { reads++; return id === completed ? history : undefined; };
  const first = await verifyCancelledSeriesInstances(input, marker);
  assert.equal(first.valid, true, first.reason);
  assert.equal(reads, 1);
  const reordered = await verifyCancelledSeriesInstances({ ...input, instances: [current, previous] }, marker);
  assert.equal(reordered.valid, true, reordered.reason);
  assert.equal(reordered.fingerprint, first.fingerprint);
  for (const changed of [
    { ...input, instances: [] },
    { ...input, instances: [previous] },
    { ...input, instances: [{ ...previous, status: "tentative" }, current] },
    { ...input, instances: [{ ...previous, iCalUID: "foreign-series" }, current] },
    { ...input, instances: [previous, previous, current] },
    { ...input, instances: Array.from({ length: 101 }, (_, i) => ({
      id: `occurrence-${i}`, status: "cancelled", recurringEventId: master,
    })) },
  ]) assert.equal((await verifyCancelledSeriesInstances(changed, marker)).valid, false);
  for (const missing of [
    undefined,
    { ...history, taskId: "other-task" },
    { ...history, eventId: "other-event" },
    { ...history, masterEventId: "other-master" },
    { ...history, seriesId: "other-series" },
    { ...history, completedAt: "invalid" },
  ]) {
    const result = await verifyCancelledSeriesInstances(input, async () => missing);
    assert.equal(result.valid, false);
  }
  const legacyOwnerLabel = await verifyCancelledSeriesInstances(input,
    async id => id === completed ? { ...history, recurrenceOwner: "todoist" } : undefined);
  assert.equal(legacyOwnerLabel.valid, true, "legacy owner labels do not override exact task/series IDs");
});

test("provider instance changes invalidate the preflight fingerprint", async () => {
  const input = {
    profile: "antonio", taskIds: [taskId], masterId: master, masterSeriesId,
    activeInstanceId: active, nowMs: Date.parse("2026-11-07T12:00:00Z"),
  };
  const read = async etag => verifyCancelledSeriesInstances({ ...input, instances: [
    { id: active, status: "cancelled", recurringEventId: master, etag },
  ] }, async () => undefined);
  const first = await read("etag-a");
  const changed = await read("etag-b");
  assert.equal(first.valid, true);
  assert.equal(changed.valid, true);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});
