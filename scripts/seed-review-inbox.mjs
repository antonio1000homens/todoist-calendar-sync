#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewStore } from "../dist/review-store.js";

const tableName = process.env.STATE_TABLE_NAME?.trim();
if (!tableName) throw new Error("STATE_TABLE_NAME is required; refusing to select a table implicitly");
const apply = process.argv.includes("--apply");
const rawClient = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 5, retryMode: "standard" }), {
  marshallOptions: { removeUndefinedValues: true },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (error) => ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"].includes(error?.name);
// Keep every seeder request, including case writes, under a conservative
// 5-RCU/s budget and add bounded retries for transient capacity errors.
const client = { send: async (command) => {
  command.input.ReturnConsumedCapacity = "TOTAL";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const started = Date.now();
    try {
      const result = await rawClient.send(command);
      const units = Number(result.ConsumedCapacity?.CapacityUnits || 0);
      await sleep(Math.max(200, Math.ceil(units * 1000 / 5) - (Date.now() - started)));
      return result;
    } catch (error) {
      if (attempt === 7 || !retryable(error)) throw error;
      await sleep(Math.min(10000, 250 * 2 ** attempt));
    }
  }
  throw new Error("DynamoDB retries exhausted");
} };
const store = new ReviewStore(client);
let pendingDecisions = 0, activeIncidents = 0, seeded = 0;
let cursor;
do {
  const result = await client.send(new ScanCommand({
    TableName: tableName, Limit: 50,
    FilterExpression: "begins_with(pk, :manual) AND sk = :state",
    ExpressionAttributeValues: { ":manual": "MANUAL#", ":state": "STATE" },
    ...(cursor ? { ExclusiveStartKey: cursor } : {}),
  }));
  for (const decision of result.Items || []) if (decision.decisionId && decision.profile) pendingDecisions += 1;
  if (apply) for (const decision of result.Items || []) {
    if (decision.decisionId && decision.profile) {
      await store.observeDecision(decision);
      seeded += 1;
    }
  }
  cursor = result.LastEvaluatedKey;
} while (cursor);

cursor = undefined;
do {
  const result = await client.send(new ScanCommand({
    TableName: tableName, Limit: 50,
    FilterExpression: "begins_with(pk, :conflict) AND #active = :true",
    ExpressionAttributeNames: { "#active": "active" },
    ExpressionAttributeValues: { ":conflict": "CONFLICT_STATE#", ":true": true },
    ...(cursor ? { ExclusiveStartKey: cursor } : {}),
  }));
  for (const state of result.Items || []) {
    const [, candidateProfile, fingerprint] = String(state.pk).split("#");
    if (!["home", "antonio", "work"].includes(candidateProfile) || !fingerprint || !state.incidentId) continue;
    activeIncidents += 1;
    const auditKey = { pk: `AUDIT#${candidateProfile}#CONFLICT#${fingerprint}#${state.incidentId}`, sk: "STATE" };
    const audit = (await client.send(new GetCommand({ TableName: tableName, Key: auditKey, ConsistentRead: true }))).Item;
    if (!audit) continue;
    if (apply) {
      await store.observeConflictIncident(candidateProfile, fingerprint, state.incidentId, audit);
      seeded += 1;
    }
  }
  cursor = result.LastEvaluatedKey;
} while (cursor);

cursor = undefined;
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", pendingAndRetainedDecisions: pendingDecisions,
  activeIncidents, recordsSeeded: seeded }));
