import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLegacyCutover } from "../scripts/legacy-cutover-policy.mjs";

test("legacy cutover audit waits for queued work, active operations and fences", () => {
  const result = summarizeLegacyCutover([
    { pk: "ERASURE_OPERATION#sensitive-task-id", sk: "STATE", status: "deleting" },
    { pk: "ERASURE#antonio", sk: "FENCE", operationId: "private-operation-id" },
    { pk: "ERASURE#home", sk: "JOURNAL" },
  ], {
    operations: { visible: 0, inFlight: 1 },
    deadLetter: { visible: 0 },
  });

  assert.equal(result.idle, false);
  assert.equal(result.pendingOperations, 1);
  assert.equal(result.pendingByStatus.deleting, 1);
  assert.equal(result.fences, 1);
  assert.equal(result.journals, 1);
  assert.equal(result.replayMarkers, 0);
  assert.equal(JSON.stringify(result).includes("sensitive-task-id"), false);
  assert.equal(JSON.stringify(result).includes("private-operation-id"), false);
});

test("legacy cutover distinguishes drained workers from remaining replay records", () => {
  const result = summarizeLegacyCutover([
    { pk: "ERASURE_OPERATION#completed-id", sk: "STATE", status: "succeeded" },
    { pk: "ERASURE#work", sk: "EPOCH" },
  ], { operations: {}, deadLetter: {} });

  assert.equal(result.idle, true);
  assert.equal(result.clean, false);
  assert.equal(result.pendingOperations, 0);
  assert.equal(result.queueMessages, 0);
  assert.deepEqual(result.pendingByStatus, {});
});

test("fully drained legacy state reports clean with sanitized aggregate counts", () => {
  const result = summarizeLegacyCutover([], { operations: {}, deadLetter: {} });
  assert.equal(result.idle, true);
  assert.equal(result.clean, true);
  assert.deepEqual(result.queues.operations, { visible: 0, inFlight: 0, delayed: 0 });
});

test("cutover remains pending while a writer lease or terminal audit row remains", () => {
  const result = summarizeLegacyCutover([
    { pk: "ERASURE#home", sk: "WRITER#lease-id" },
    { pk: "ERASURE_OPERATION#completed-id", sk: "STATE", status: "succeeded" },
  ], { operations: {}, deadLetter: {} });
  assert.equal(result.idle, false);
  assert.equal(result.activeLeases, 1);
  assert.equal(result.terminalOperations, 1);
  assert.equal(result.clean, false);
  assert.equal(JSON.stringify(result).includes("lease-id"), false);
});

test("cutover treats scoped grants as live leases until they expire", () => {
  const result = summarizeLegacyCutover([
    { pk: "ERASURE#work", sk: "SCOPED_ADMISSION", version: 2,
      grants: [{ expiresAt: Date.now() + 60_000 }] },
  ], { operations: {}, deadLetter: {} });
  assert.equal(result.idle, false);
  assert.equal(result.activeLeases, 1);
});
