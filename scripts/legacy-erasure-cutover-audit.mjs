#!/usr/bin/env node
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { writeFile } from "node:fs/promises";
import { isStaleLegacyWriter, summarizeLegacyCutover } from "./legacy-cutover-policy.mjs";

const tableName = process.env.STATE_TABLE_NAME?.trim();
const region = process.env.AWS_REGION?.trim();
const operationQueueUrl = process.env.ERASURE_OPERATION_QUEUE_URL?.trim();
const deadLetterQueueUrl = process.env.ERASURE_OPERATION_DLQ_URL?.trim();
const timeoutMs = Number(process.env.LEGACY_CUTOVER_TIMEOUT_MS || 25 * 60 * 1000);
const pollMs = Number(process.env.LEGACY_CUTOVER_POLL_MS || 30_000);
const resultFile = process.env.LEGACY_CUTOVER_RESULT_FILE || "legacy-cutover-audit-result.json";
if (!tableName || !region || !operationQueueUrl || !deadLetterQueueUrl)
  throw new Error("State table, AWS region, operation queue and DLQ are required for legacy cutover audit");
if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 25 * 60 * 1000
  || !Number.isFinite(pollMs) || pollMs < 5_000 || pollMs > 60_000)
  throw new Error("Legacy cutover audit timeout or polling interval is outside the allowed range");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 5, retryMode: "standard" }), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({ region, maxAttempts: 5, retryMode: "standard" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readLegacyRows() {
  const rows = [];
  let cursor;
  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      Limit: 25,
      ProjectionExpression: "pk, sk, #status, epoch, grants, exclusiveOwner, exclusiveUntil, #version, operationId, updatedAt, acquiredAt",
      ExpressionAttributeNames: { "#status": "status", "#version": "version" },
      ReturnConsumedCapacity: "TOTAL",
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const row of result.Items || []) {
      if (String(row.pk || "").startsWith("ERASURE_OPERATION#")
        || String(row.pk || "").startsWith("ERASURE_CONFIRMATION#")
        || String(row.pk || "").startsWith("ERASURE#")) rows.push(row);
    }
    const capacity = Number(result.ConsumedCapacity?.CapacityUnits || 0);
    if (result.LastEvaluatedKey) await sleep(Math.max(250, Math.ceil(capacity * 500)));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return rows;
}

async function queueCounts(queueUrl) {
  const response = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible",
      "ApproximateNumberOfMessagesDelayed"],
  }));
  const values = response.Attributes || {};
  return {
    visible: Number(values.ApproximateNumberOfMessages || 0),
    inFlight: Number(values.ApproximateNumberOfMessagesNotVisible || 0),
    delayed: Number(values.ApproximateNumberOfMessagesDelayed || 0),
  };
}

async function snapshot() {
  const [rows, operations, deadLetter] = await Promise.all([
    readLegacyRows(), queueCounts(operationQueueUrl), queueCounts(deadLetterQueueUrl),
  ]);
  return { rows, operations, deadLetter, ...summarizeLegacyCutover(rows, { operations, deadLetter }) };
}

async function retireDrainedLegacyRows(rows) {
  const operations = new Map(rows
    .filter(row => String(row.pk || "").startsWith("ERASURE_OPERATION#") && row.sk === "STATE")
    .map(row => [String(row.pk).slice("ERASURE_OPERATION#".length), row]));
  const confirmations = rows.filter(row => String(row.pk || "").startsWith("ERASURE_CONFIRMATION#") && row.sk === "STATE");

  for (const confirmation of confirmations) {
    const operationId = String(confirmation.pk).slice("ERASURE_CONFIRMATION#".length);
    const operation = operations.get(operationId);
    if (!operation || !["succeeded", "cancelled"].includes(operation.status)
      || confirmation.operationId !== operationId || typeof confirmation.status !== "string")
      throw new Error("legacy_confirmation_not_retirable");
    await dynamo.send(new DeleteCommand({
      TableName: tableName,
      Key: { pk: confirmation.pk, sk: confirmation.sk },
      ConditionExpression: "#status = :status AND operationId = :operationId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": confirmation.status, ":operationId": operationId },
    }));
  }

  for (const [operationId, operation] of operations) {
    if (!["succeeded", "cancelled"].includes(operation.status))
      throw new Error("legacy_operation_not_terminal");
    await dynamo.send(new DeleteCommand({
      TableName: tableName,
      Key: { pk: operation.pk, sk: operation.sk },
      ConditionExpression: operation.updatedAt
        ? "#status = :status AND updatedAt = :updatedAt" : "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": operation.status,
        ...(operation.updatedAt ? { ":updatedAt": operation.updatedAt } : {}),
      },
    }));
  }

  const profileRows = rows.filter(row => String(row.pk || "").startsWith("ERASURE#"));
  for (const row of profileRows) {
    const profile = String(row.pk).slice("ERASURE#".length);
    if (!["home", "antonio", "work"].includes(profile)) throw new Error("unknown_legacy_profile_partition");
    if (row.sk === "FENCE" || row.sk === "JOURNAL") throw new Error("legacy_profile_lock_not_retirable");
    if (String(row.sk).startsWith("WRITER#")) {
      if (!isStaleLegacyWriter(row)) throw new Error("legacy_writer_lease_not_stale");
      await dynamo.send(new DeleteCommand({
        TableName: tableName,
        Key: { pk: row.pk, sk: row.sk },
        ConditionExpression: "acquiredAt = :acquiredAt",
        ExpressionAttributeValues: { ":acquiredAt": row.acquiredAt },
      }));
      continue;
    }
    if (row.sk === "EPOCH") {
      if (!Number.isSafeInteger(row.epoch)) throw new Error("legacy_epoch_invalid");
      await dynamo.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: {
          TableName: tableName, Key: { pk: row.pk, sk: "FENCE" },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { ConditionCheck: {
          TableName: tableName, Key: { pk: row.pk, sk: "JOURNAL" },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { Delete: {
          TableName: tableName, Key: { pk: row.pk, sk: row.sk },
          ConditionExpression: "epoch = :epoch",
          ExpressionAttributeValues: { ":epoch": row.epoch },
        } },
      ] }));
      continue;
    }
    if (row.sk !== "SCOPED_ADMISSION") throw new Error("unknown_legacy_profile_state");
    if (!Number.isSafeInteger(row.version)) throw new Error("legacy_admission_version_missing");
    const grants = row.grants === undefined ? [] : row.grants;
    if (!Array.isArray(grants) || grants.some(grant => !Number.isFinite(grant?.expiresAt)))
      throw new Error("legacy_admission_inventory_invalid");
    if ((row.exclusiveOwner !== undefined && !Number.isFinite(row.exclusiveUntil))
      || (row.exclusiveUntil !== undefined && typeof row.exclusiveOwner !== "string"))
      throw new Error("legacy_exclusive_lease_invalid");
    if (grants.some(grant => grant.expiresAt > Date.now())
      || (typeof row.exclusiveOwner === "string" && Number(row.exclusiveUntil) > Date.now()))
      throw new Error("legacy_admission_lease_active");
    let version = row.version;
    if (grants.length || row.exclusiveOwner !== undefined) {
      const updated = await dynamo.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: row.pk, sk: row.sk },
        UpdateExpression: "SET grants = :empty, owners = :owners, leaseUntilByOwner = :leaseMap, #version = :next REMOVE exclusiveOwner, exclusiveUntil",
        ConditionExpression: "#version = :version AND (attribute_not_exists(exclusiveUntil) OR exclusiveUntil <= :now)",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ":empty": [], ":owners": [], ":leaseMap": {}, ":version": row.version,
          ":next": row.version + 1, ":now": Date.now(),
        },
        ReturnValues: "ALL_NEW",
      }));
      version = updated.Attributes?.version;
      if (!Number.isSafeInteger(version)) throw new Error("legacy_admission_retirement_unverified");
    }
    await dynamo.send(new DeleteCommand({
      TableName: tableName,
      Key: { pk: row.pk, sk: row.sk },
      ConditionExpression: "#version = :version AND (attribute_not_exists(grants) OR size(grants) = :zero) AND attribute_not_exists(exclusiveOwner)",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": version, ":zero": 0 },
    }));
  }
}

const started = Date.now();
let result;
let idleObservations = 0;
let beforeCleanup;
let cleanupFailure;
do {
  result = await snapshot();
  idleObservations = result.idle ? idleObservations + 1 : 0;
  console.log(JSON.stringify({
    service: "todoist-calendar-sync-legacy-cutover",
    event: result.idle ? "legacy_worker_idle" : "legacy_worker_state_pending",
    elapsedSeconds: Math.floor((Date.now() - started) / 1000),
    idleObservations,
    ...result,
  }));
  if (idleObservations >= 3) break;
  if (Date.now() - started >= timeoutMs) break;
  await sleep(pollMs);
} while (Date.now() - started <= timeoutMs);

if (idleObservations >= 3) {
  beforeCleanup = result;
  try {
    const current = await snapshot();
    if (!current.idle) throw new Error("legacy_cutover_state_changed");
    await retireDrainedLegacyRows(current.rows);
    result = await snapshot();
  } catch {
    cleanupFailure = "legacy_state_cleanup_not_verified";
  }
}

const clean = !cleanupFailure && result?.clean === true;
await writeFile(resultFile, `${JSON.stringify({
  mode: "legacy-erasure-cutover-audit",
  status: clean ? "clean" : "pending",
  elapsedSeconds: Math.floor((Date.now() - started) / 1000),
  idleObservations,
  ...(cleanupFailure ? { cleanupFailure } : {}),
  beforeCleanup: beforeCleanup ? summarizeLegacyCutover(beforeCleanup.rows, {
    operations: beforeCleanup.operations, deadLetter: beforeCleanup.deadLetter,
  }) : undefined,
  result: result ? summarizeLegacyCutover(result.rows, {
    operations: result.operations, deadLetter: result.deadLetter,
  }) : undefined,
}, null, 2)}\n`);
if (!clean) process.exitCode = 1;
