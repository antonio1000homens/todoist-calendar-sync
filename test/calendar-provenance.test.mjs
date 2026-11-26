import assert from "node:assert/strict";
import test from "node:test";
import { calendarReplaySourceIds } from "../dist/calendar-provenance.js";
import { ErasureReplayUnavailableError } from "../dist/erasure-replay-barrier.js";

test("Calendar task provenance includes the exact occurrence and master IDs", () => {
  assert.deepEqual(calendarReplaySourceIds({ id: "instance-1", recurringEventId: "master-1" }),
    ["instance-1", "master-1"]);
});

test("Calendar task provenance rejects missing, malformed, duplicate overflow aliases", () => {
  assert.throws(() => calendarReplaySourceIds({ id: "" }), ErasureReplayUnavailableError);
  assert.throws(() => calendarReplaySourceIds({ id: "event-1" }, ""), ErasureReplayUnavailableError);
  assert.throws(() => calendarReplaySourceIds({ id: "event-1" }, ...Array.from({ length: 32 }, (_, i) => `alias-${i}`)),
    ErasureReplayUnavailableError);
});
