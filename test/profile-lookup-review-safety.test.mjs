import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { profileLookupPacingDelayMs, profileLookupQueryInput } from "../dist/dynamodb-capacity.js";
import { profileLookupBackfillCondition } from "../dist/profile-lookup.js";

const backfillSource = await readFile(new URL("../scripts/backfill-profile-lookup-index.mjs", import.meta.url), "utf8");
const cleanupSource = await readFile(new URL("../scripts/cleanup-routine-audit.mjs", import.meta.url), "utf8");
const template = await readFile(new URL("../template.yaml", import.meta.url), "utf8");
const rolloutDocs = await readFile(new URL("../docs/profile-lookup-index.md", import.meta.url), "utf8");

test("profile lookup query guardrail bounds pages and requests consumed capacity", () => {
  const input = profileLookupQueryInput({
    TableName: "state",
    IndexName: "ProfileLookupIndex",
    KeyConditionExpression: "lookupPk = :pk",
    ExpressionAttributeValues: { ":pk": "PROFILE#home" },
    Limit: 1000,
  });
  assert.equal(input.Limit, 25);
  assert.equal(input.ReturnConsumedCapacity, "TOTAL");

  const unrelated = profileLookupQueryInput({
    TableName: "state",
    IndexName: "OtherIndex",
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": "X" },
    Limit: 1000,
  });
  assert.equal(unrelated.Limit, 1000);
  assert.equal(unrelated.ReturnConsumedCapacity, undefined);
});

test("deadline-bound profile lookup pacing cannot sleep beyond the health-check budget", () => {
  const now = 10_000;
  assert.equal(profileLookupPacingDelayMs(100, 0, now + 1_000, now), 1_000);
  assert.equal(profileLookupPacingDelayMs(100, 0, now - 1, now), 0);
});

test("mutating migration and cleanup scripts fail closed without an explicit table", () => {
  assert.match(backfillSource, /process\.env\.STATE_TABLE_NAME\?\.trim\(\)/);
  assert.match(backfillSource, /STATE_TABLE_NAME is required/);
  assert.doesNotMatch(backfillSource, /STATE_TABLE_NAME\s*\|\|\s*["']todoist-calendar-sync-state-production/);
  assert.match(cleanupSource, /process\.env\.STATE_TABLE_NAME\?\.trim\(\)/);
  assert.match(cleanupSource, /STATE_TABLE_NAME is required/);
  assert.doesNotMatch(cleanupSource, /STATE_TABLE_NAME\s*\|\|\s*["']todoist-calendar-sync-state-production/);
});

test("backfill cannot resurrect deleted rows and publishes readiness only after a stable exact verification", () => {
  assert.match(backfillSource, /--confirm-writers-drained/);
  assert.match(backfillSource, /profileLookupBackfillCondition\(lookup\)/);
  const ordinaryCondition = profileLookupBackfillCondition({ lookupSk: "MAPPING#TASK#task-1" });
  assert.match(ordinaryCondition.expression, /attribute_exists\(pk\).*attribute_exists\(sk\).*attribute_not_exists\(lookupPk\).*attribute_not_exists\(lookupSk\)/);
  assert.match(backfillSource, /catchup-/);
  assert.match(backfillSource, /profileLookupParity\(readyExpected, actual\)/);
  assert.match(backfillSource, /backfillPass\(`verify-\$\{attempt\}`\)/);
  assert.match(backfillSource, /verificationPass\.updated === 0 && verificationPass\.conditionalMisses === 0/);
  assert.match(backfillSource, /missing\.length === 0 && unexpected\.length === 0/);
  assert.match(backfillSource, /missing=\$\{missing\.length\}, unexpected=\$\{unexpected\.length\}/);
  assert.match(backfillSource, /PROFILE_LOOKUP_READY_KEY/);
  assert.match(backfillSource, /item\.status === "pending"/);
  assert.match(backfillSource, /MANUAL_PENDING_LOOKUP_PREFIX/);
});

test("a decision resolved after the scan cannot be reindexed by the backfill", () => {
  const condition = profileLookupBackfillCondition({ lookupSk: "MANUAL#PENDING#2026-10-23T10:00:00.000Z#decision-1" });
  const afterFinish = {
    pk: "MANUAL#decision-1", sk: "STATE", status: "resolved",
    lookupPk: undefined, lookupSk: undefined,
  };

  assert.match(condition.expression, /#status = :pending/);
  assert.equal(condition.names["#status"], "status");
  assert.equal(condition.values[":pending"], "pending");
  // This is the race window: the scan saw pending, then finish() cleared the
  // lookup attributes and changed status before the conditional Update runs.
  assert.notEqual(afterFinish.status, condition.values[":pending"]);
  assert.match(backfillSource, /ConditionalCheckFailedException"\) conditionalMisses \+= 1/);
  assert.match(backfillSource, /pass\.updated === 0 && pass\.conditionalMisses === 0/);
});

test("pending decisions use the existing profile GSI and require the expanded migration parity", async () => {
  const { PROFILE_LOOKUP_MIGRATION_VERSION, manualPendingLookupAttributes } = await import("../dist/profile-lookup.js");
  assert.equal(PROFILE_LOOKUP_MIGRATION_VERSION, 2);
  assert.deepEqual(manualPendingLookupAttributes({ profile: "home", decisionId: "home-review-1", createdAt: "2026-10-23T10:00:00.000Z" }), {
    lookupPk: "PROFILE#home",
    lookupSk: "MANUAL#PENDING#2026-10-23T10:00:00.000Z#home-review-1",
  });
});

test("administrative migration paths retry throttling and document their full-table cost", () => {
  assert.match(backfillSource, /ThrottlingException/);
  assert.match(backfillSource, /ProvisionedThroughputExceededException/);
  assert.match(cleanupSource, /ThrottlingException/);
  assert.match(cleanupSource, /ProvisionedThroughputExceededException/);
  assert.match(cleanupSource, /const batchSize = 5/);
  assert.match(rolloutDocs, /full-table administrative scan/);
  assert.match(rolloutDocs, /batches of 5/);
});

test("ProfileLookupIndex has independent capacity headroom and GSI-dimensioned alarms", () => {
  assert.match(template, /ProfileLookupIndexReadCapacity:[\s\S]*?Default:\s*10/);
  assert.match(template, /ProfileLookupIndexWriteCapacity:[\s\S]*?Default:\s*10/);
  assert.match(template, /ProfileLookupIndexReadThrottleAlarm:/);
  assert.match(template, /ProfileLookupIndexWriteThrottleAlarm:/);
  assert.match(template, /ProfileLookupIndexReadUtilizationAlarm:/);
  assert.match(template, /ProfileLookupIndexWriteUtilizationAlarm:/);
  assert.equal((template.match(/Name:\s*GlobalSecondaryIndexName/g) || []).length >= 6, true);
  assert.match(template, /Value:\s*ProfileLookupIndex/);
});
