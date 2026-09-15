#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  mappingLookupSk,
  profileLookupPk,
  PROFILE_LOOKUP_MIGRATION_VERSION,
  PROFILE_LOOKUP_READY_KEY,
  PROFILE_LOOKUP_READY_SORT_KEY,
  recurrenceLookupSk,
} from "../dist/profile-lookup.js";

const tableName = process.env.STATE_TABLE_NAME?.trim();
if (!tableName) {
  throw new Error("STATE_TABLE_NAME is required; refusing to default a mutating migration to production");
}
if (!process.argv.includes("--confirm-writers-drained")) {
  throw new Error("Refusing to publish profile-lookup readiness until legacy writers are drained; wait at least 5 minutes after deploying the additive GSI/write-path change, then rerun with --confirm-writers-drained");
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({
  maxAttempts: 5,
  retryMode: "standard",
}), {
  marshallOptions: { removeUndefinedValues: true },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryableThrottle(error) {
  return error?.name === "ProvisionedThroughputExceededException"
    || error?.name === "ThrottlingException"
    || error?.name === "RequestLimitExceeded";
}

async function sendWithThrottleRetry(command, operation) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await client.send(command);
    } catch (error) {
      if (!retryableThrottle(error) || attempt === 7) throw error;
      const delayMs = Math.min(10_000, 250 * 2 ** attempt);
      console.warn(JSON.stringify({ event: "profile_lookup_backfill_throttled", operation, attempt: attempt + 1, delayMs, error: error.name }));
      await sleep(delayMs);
    }
  }
  throw new Error(`Retry loop exhausted for ${operation}`);
}

function profile(value) {
  return value === "home" || value === "antonio" || value === "work" ? value : undefined;
}

function lookupFor(item) {
  const pk = typeof item.pk === "string" ? item.pk : "";
  const sk = typeof item.sk === "string" ? item.sk : "";
  if (sk === "MAP" && pk.startsWith("TASK#")) {
    const [, candidate, taskId] = pk.split("#");
    const owner = profile(candidate);
    return owner && taskId ? { lookupPk: profileLookupPk(owner), lookupSk: mappingLookupSk("task", taskId) } : undefined;
  }
  if (sk === "MAP" && pk.startsWith("EVENT#")) {
    const [, candidate, eventId] = pk.split("#");
    const owner = profile(candidate);
    return owner && eventId ? { lookupPk: profileLookupPk(owner), lookupSk: mappingLookupSk("event", eventId) } : undefined;
  }
  if (sk === "MAP" && pk.startsWith("TASKOWNER#")) {
    const owner = profile(item.profile);
    const taskId = pk.slice("TASKOWNER#".length);
    return owner && taskId ? { lookupPk: profileLookupPk(owner), lookupSk: mappingLookupSk("owner", taskId) } : undefined;
  }
  if (pk.startsWith("RECURRENCE#")) {
    const [, candidate, seriesId] = pk.split("#");
    const owner = profile(candidate);
    return owner && seriesId ? { lookupPk: profileLookupPk(owner), lookupSk: recurrenceLookupSk(seriesId) } : undefined;
  }
  return undefined;
}

function lookupIdentity(lookup) {
  return `${lookup.lookupPk}\u0000${lookup.lookupSk}`;
}

const totals = {
  scanned: 0,
  updated: 0,
  alreadyIndexed: 0,
  ignored: 0,
  conditionalMisses: 0,
};

async function backfillPass(label) {
  let lastEvaluatedKey;
  let scanned = 0;
  let updated = 0;
  let alreadyIndexed = 0;
  let ignored = 0;
  let conditionalMisses = 0;
  const expected = new Set();

  do {
    const result = await sendWithThrottleRetry(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 25,
      ReturnConsumedCapacity: "TOTAL",
    }), `${label}:scan`);

    for (const item of result.Items || []) {
      scanned += 1;
      const lookup = lookupFor(item);
      if (!lookup) {
        ignored += 1;
        continue;
      }
      expected.add(lookupIdentity(lookup));

      const hasLookupPk = typeof item.lookupPk === "string";
      const hasLookupSk = typeof item.lookupSk === "string";
      if (hasLookupPk || hasLookupSk) {
        if (item.lookupPk !== lookup.lookupPk || item.lookupSk !== lookup.lookupSk) {
          throw new Error(`Refusing to overwrite partial/conflicting lookup attributes for ${item.pk}/${item.sk}`);
        }
        alreadyIndexed += 1;
        continue;
      }

      try {
        await sendWithThrottleRetry(new UpdateCommand({
          TableName: tableName,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: "SET lookupPk = :lookupPk, lookupSk = :lookupSk",
          ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk) AND attribute_not_exists(lookupPk) AND attribute_not_exists(lookupSk)",
          ExpressionAttributeValues: { ":lookupPk": lookup.lookupPk, ":lookupSk": lookup.lookupSk },
        }), `${label}:update`);
        updated += 1;
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") conditionalMisses += 1;
        else throw error;
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
    console.log(JSON.stringify({
      event: "profile_lookup_backfill_page",
      pass: label,
      scanned,
      updated,
      alreadyIndexed,
      ignored,
      conditionalMisses,
      consumedCapacityUnits: Number(result.ConsumedCapacity?.CapacityUnits || 0),
      hasNextPage: Boolean(lastEvaluatedKey),
    }));
    if (lastEvaluatedKey) await sleep(250);
  } while (lastEvaluatedKey);

  totals.scanned += scanned;
  totals.updated += updated;
  totals.alreadyIndexed += alreadyIndexed;
  totals.ignored += ignored;
  totals.conditionalMisses += conditionalMisses;
  return { scanned, updated, alreadyIndexed, ignored, conditionalMisses, expected };
}

async function indexedIdentities() {
  const actual = new Set();
  for (const owner of ["home", "antonio", "work"]) {
    for (const prefix of ["MAPPING#", "RECURRENCE#"]) {
      let exclusiveStartKey;
      do {
        const result = await sendWithThrottleRetry(new QueryCommand({
          TableName: tableName,
          IndexName: "ProfileLookupIndex",
          KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
          ExpressionAttributeValues: { ":lookupPk": `PROFILE#${owner}`, ":lookupSk": prefix },
          ProjectionExpression: "lookupPk, lookupSk",
          ExclusiveStartKey: exclusiveStartKey,
          Limit: 25,
          ReturnConsumedCapacity: "TOTAL",
        }), "verify:query");
        for (const item of result.Items || []) {
          if (typeof item.lookupPk === "string" && typeof item.lookupSk === "string") {
            actual.add(lookupIdentity(item));
          }
        }
        exclusiveStartKey = result.LastEvaluatedKey;
        if (exclusiveStartKey) await sleep(250);
      } while (exclusiveStartKey);
    }
  }
  return actual;
}

await backfillPass("initial");

let readyExpected;
for (let catchup = 1; catchup <= 5; catchup += 1) {
  await sleep(2000);
  const pass = await backfillPass(`catchup-${catchup}`);
  if (pass.updated === 0 && pass.conditionalMisses === 0) {
    readyExpected = pass.expected;
    break;
  }
}
if (!readyExpected) {
  throw new Error("Profile lookup backfill did not reach a stable catch-up pass; ready marker was not written");
}

for (let attempt = 1; attempt <= 10; attempt += 1) {
  const actual = await indexedIdentities();
  const missing = [...readyExpected].filter((identity) => !actual.has(identity));
  console.log(JSON.stringify({
    event: "profile_lookup_backfill_verify",
    attempt,
    expected: readyExpected.size,
    indexed: actual.size,
    missing: missing.length,
  }));
  if (missing.length === 0) break;
  if (attempt === 10) throw new Error(`Profile lookup GSI did not reach exact backfill parity (${missing.length} expected rows missing); ready marker was not written`);
  await sleep(2000);
}

await sendWithThrottleRetry(new PutCommand({
  TableName: tableName,
  Item: {
    pk: PROFILE_LOOKUP_READY_KEY,
    sk: PROFILE_LOOKUP_READY_SORT_KEY,
    ready: true,
    version: PROFILE_LOOKUP_MIGRATION_VERSION,
    completedAt: new Date().toISOString(),
  },
}), "publish:ready");

console.log(JSON.stringify({
  event: "profile_lookup_backfill_complete",
  tableName,
  ...totals,
  expectedIndexedRows: readyExpected.size,
  migrationVersion: PROFILE_LOOKUP_MIGRATION_VERSION,
}));
