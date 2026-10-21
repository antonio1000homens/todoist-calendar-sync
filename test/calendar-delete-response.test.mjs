import assert from "node:assert/strict";
import test from "node:test";
import { calendarResourceAlreadyDeleted } from "../dist/sync.js";

test("authorized Calendar deletion treats 404 and 410 Resource deleted as completed cleanup", () => {
  assert.equal(calendarResourceAlreadyDeleted({ status: 404 }), true);
  assert.equal(calendarResourceAlreadyDeleted({
    status: 410,
    body: JSON.stringify({ error: { errors: [{ reason: "deleted" }] } }),
  }), true);
});

test("Calendar 410 for an expired cursor or another reason is not treated as deleted cleanup", () => {
  assert.equal(calendarResourceAlreadyDeleted({
    status: 410,
    body: JSON.stringify({ error: { errors: [{ reason: "fullSyncRequired" }] } }),
  }), false);
  assert.equal(calendarResourceAlreadyDeleted({ status: 410, body: "not JSON" }), false);
});
