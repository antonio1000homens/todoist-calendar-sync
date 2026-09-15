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

const tableName = process.env.STATE_TABLE_NAME || "todoist-calendar-sync-state-production";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

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

let lastEvaluatedKey;
let scanned = 0;
let updated = 0;
let alreadyIndexed = 0;
let ignored = 0;
let mappingTaskRows = 0;
let recurrenceRows = 0;

do {
  const result = await client.send(new ScanCommand({
    TableName: tableName,
    ExclusiveStartKey: lastEvaluatedKey,
    Limit: 25,
  }));
  for (const item of result.Items || []) {
    scanned += 1;
    const lookup = lookupFor(item);
    if (!lookup) {
      ignored += 1;
      continue;
    }
    if (lookup.lookupSk.startsWith("MAPPING#TASK#")) mappingTaskRows += 1;
    if (lookup.lookupSk.startsWith("RECURRENCE#")) recurrenceRows += 1;
    if (item.lookupPk && item.lookupSk) {
      alreadyIndexed += 1;
      continue;
    }
    try {
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: "SET lookupPk = :lookupPk, lookupSk = :lookupSk",
        ConditionExpression: "attribute_not_exists(lookupPk)",
        ExpressionAttributeValues: lookup,
      }));
      updated += 1;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") alreadyIndexed += 1;
      else throw error;
    }
  }
  lastEvaluatedKey = result.LastEvaluatedKey;
  console.log(JSON.stringify({ event: "profile_lookup_backfill_page", scanned, updated, alreadyIndexed, ignored, hasNextPage: Boolean(lastEvaluatedKey) }));
} while (lastEvaluatedKey);

async function indexedCount(prefix) {
  let count = 0;
  for (const owner of ["home", "antonio", "work"]) {
    let exclusiveStartKey;
    do {
      const result = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: "ProfileLookupIndex",
        KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
        ExpressionAttributeValues: { ":lookupPk": `PROFILE#${owner}`, ":lookupSk": prefix },
        Select: "COUNT",
        ExclusiveStartKey: exclusiveStartKey,
      }));
      count += result.Count || 0;
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }
  return count;
}

for (let attempt = 1; attempt <= 10; attempt += 1) {
  const indexedMappings = await indexedCount("MAPPING#TASK#");
  const indexedRecurrences = await indexedCount("RECURRENCE#");
  console.log(JSON.stringify({ event: "profile_lookup_backfill_verify", attempt, expectedMappings: mappingTaskRows, indexedMappings, expectedRecurrences: recurrenceRows, indexedRecurrences }));
  if (indexedMappings >= mappingTaskRows && indexedRecurrences >= recurrenceRows) break;
  if (attempt === 10) throw new Error("Profile lookup GSI did not reach backfill parity; ready marker was not written");
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

await client.send(new PutCommand({
  TableName: tableName,
  Item: {
    pk: PROFILE_LOOKUP_READY_KEY,
    sk: PROFILE_LOOKUP_READY_SORT_KEY,
    ready: true,
    version: PROFILE_LOOKUP_MIGRATION_VERSION,
    completedAt: new Date().toISOString(),
  },
}));

console.log(JSON.stringify({ event: "profile_lookup_backfill_complete", tableName, scanned, updated, alreadyIndexed, ignored, migrationVersion: PROFILE_LOOKUP_MIGRATION_VERSION }));
