import test from "node:test";
import assert from "node:assert/strict";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ReviewStore } from "../dist/review-store.js";

test("active conflict incidents seed an indexed durable review case from the retained audit row", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  const sent = [];
  t.mock.method(ReviewStore.prototype, "getCase", async () => undefined);
  t.mock.method(documentClient, "send", async (command) => { sent.push(command); return {}; });
  const audit = { pk: "AUDIT#home#CONFLICT#fingerprint#incident", action: "todoist_snapshot_reconcile_unmapped_conflict",
    detail: { taskId: "task-1", eventId: "event-1" }, createdAt: "2026-10-22T10:00:00.000Z" };

  await new ReviewStore().observeConflictIncident("home", "fingerprint", "incident", audit);

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof PutCommand);
  assert.equal(sent[0].input.Item.pk.startsWith("REVIEW_CASE#incident-"), true);
  assert.equal(sent[0].input.Item.lookupPk, "PROFILE#home");
  assert.match(sent[0].input.Item.lookupSk, /^REVIEW#OPEN#/);
  assert.equal(sent[0].input.Item.taskId, "task-1");
  assert.equal(sent[0].input.Item.eventId, "event-1");
  assert.equal(sent[0].input.Item.sourceAuditKey, audit.pk);
});
