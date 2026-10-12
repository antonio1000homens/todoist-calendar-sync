#!/usr/bin/env node
/**
 * Production state inspection and deliberately gated legacy AUDIT cleanup.
 * Mappings, completed history, delivery receipts, recurrence and other state
 * are never mutated by this script.
 */
import { DynamoDBClient, DescribeBackupCommand, DescribeContinuousBackupsCommand, DescribeTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  classifyLegacyAudit, expectedMappingKey, inspectMappingIntegrity,
  summarizeUnmappedConflicts,
} from "./state-cleanup-policy.mjs";

const tableName = process.env.STATE_TABLE_NAME?.trim();
if (!tableName) throw new Error("STATE_TABLE_NAME must be explicitly set (no production default)");

const apply = process.argv.includes("--apply-audits");
const confirmation = process.argv.includes("--confirm=DELETE_EXPIRED_LEGACY_AUDITS");
const backupArg = process.argv.find((arg) => arg.startsWith("--backup-arn="));
const backupArn = backupArg?.slice("--backup-arn=".length);
const maxArg = process.argv.find((arg) => arg.startsWith("--max-deletes="));
const maxDeletes = maxArg ? Number(maxArg.split("=")[1]) : 250;
const permittedArgs = new Set(["--apply-audits", "--confirm=DELETE_EXPIRED_LEGACY_AUDITS"]);
for (const arg of process.argv.slice(2)) {
  if (!permittedArgs.has(arg) && !arg.startsWith("--backup-arn=") && !arg.startsWith("--max-deletes=")) {
    throw new Error("Unknown argument: " + arg);
  }
}
if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > 1000) {
  throw new Error("--max-deletes must be an integer between 1 and 1000");
}
if (apply && (!confirmation || !backupArn)) {
  throw new Error("Apply requires --confirm=DELETE_EXPIRED_LEGACY_AUDITS and --backup-arn=<AVAILABLE_BACKUP_ARN>");
}
if (!apply && (confirmation || backupArn)) {
  throw new Error("Confirmation/backup may only be supplied with --apply-audits");
}

const rawClient = new DynamoDBClient({ maxAttempts: 5, retryMode: "standard" });
const client = DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(error) {
  return ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"].includes(error?.name);
}
async function send(command) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await client.send(command); }
    catch (error) {
      if (attempt === 7 || !retryable(error)) throw error;
      await sleep(Math.min(10000, 250 * 2 ** attempt));
    }
  }
  throw new Error("AWS operation retries exhausted");
}

async function verifyBackup() {
  const [backup, recovery, ttl] = await Promise.all([
    rawClient.send(new DescribeBackupCommand({ BackupArn: backupArn })),
    rawClient.send(new DescribeContinuousBackupsCommand({ TableName: tableName })),
    rawClient.send(new DescribeTimeToLiveCommand({ TableName: tableName })),
  ]);
  if (backup.BackupDescription?.BackupDetails?.BackupStatus !== "AVAILABLE"
    || backup.BackupDescription?.SourceTableDetails?.TableName !== tableName) {
    throw new Error("Supplied backup is not AVAILABLE or does not belong to this table");
  }
  if (recovery.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus !== "ENABLED") {
    throw new Error("Point-in-time recovery must be ENABLED before deletion");
  }
  if (ttl.TimeToLiveDescription?.TimeToLiveStatus !== "ENABLED"
    || ttl.TimeToLiveDescription?.AttributeName !== "expiresAt") {
    throw new Error("Production expiresAt TTL must be ENABLED before deletion");
  }
}

async function scan() {
  const rows = [];
  let exclusiveStartKey;
  let scanned = 0;
  let readUnits = 0;
  do {
    const result = await send(new ScanCommand({
      TableName: tableName,
      ProjectionExpression: "pk, sk, #action, #createdAt, expiresAt, profile, eventId, taskId, #detail",
      ExpressionAttributeNames: { "#action": "action", "#createdAt": "createdAt", "#detail": "detail" },
      Limit: 25,
      ExclusiveStartKey: exclusiveStartKey,
      ReturnConsumedCapacity: "TOTAL",
    }));
    rows.push(...(result.Items || []));
    scanned += result.ScannedCount || 0;
    const units = Number(result.ConsumedCapacity?.CapacityUnits || 0);
    readUnits += units;
    exclusiveStartKey = result.LastEvaluatedKey;
    // Administrative full-table scan must not exhaust fixed 25-RCU production table.
    if (exclusiveStartKey) await sleep(Math.max(250, Math.ceil(units * 1000 / 5)));
  } while (exclusiveStartKey);
  return { rows, scanned, readUnits };
}

async function verifyMappingAnomalies(anomalies) {
  const out = [];
  for (const item of anomalies) {
    const observed = {};
    for (const kind of ["EVENT", "TASK", "TASKOWNER"]) {
      const key = expectedMappingKey(kind, item.profile, item.eventId, item.taskId);
      const result = await send(new GetCommand({
        TableName: tableName, Key: key, ConsistentRead: true,
        ProjectionExpression: "profile, eventId, taskId, pk, sk",
      }));
      observed[kind] = !result.Item ? "absent" :
        result.Item.profile === item.profile
        && result.Item.eventId === item.eventId
        && result.Item.taskId === item.taskId ? "matches" : "points_elsewhere";
    }
    // Do not emit raw Todoist task IDs or Calendar event IDs in action logs.
    out.push({ profile: item.profile, fingerprint: item.fingerprint,
      scanPresent: item.present, scanMissing: item.missing, current: observed });
  }
  return out;
}

const startedAt = Date.now();
const { rows, scanned, readUnits } = await scan();
const itemTypes = {};
for (const item of rows) {
  const kind = String(item.pk || "").split("#")[0];
  itemTypes[kind] = (itemTypes[kind] || 0) + 1;
}
const auditCandidates = rows.filter((item) => classifyLegacyAudit(item, startedAt));
const legacyByAction = {}, legacyByRetention = {};
for (const item of auditCandidates) {
  const category = classifyLegacyAudit(item, startedAt);
  legacyByAction[category.action] = (legacyByAction[category.action] || 0) + 1;
  const days = String(category.originalRetentionDays);
  legacyByRetention[days] = (legacyByRetention[days] || 0) + 1;
}

const mapping = inspectMappingIntegrity(rows);
const confirmedAnomalies = await verifyMappingAnomalies(mapping.anomalies);
const repeatedConflicts = summarizeUnmappedConflicts(rows);
const summary = {
  event: "production_state_retention_review",
  mode: apply ? "apply-audits" : "report-only",
  tableName,
  scanned,
  returned: rows.length,
  readUnits: Math.round(readUnits * 10) / 10,
  itemTypes,
  legacyAuditCandidates: auditCandidates.length,
  legacyAuditByRetentionDays: legacyByRetention,
  legacyAuditByAction: legacyByAction,
  conflictCount: repeatedConflicts.reduce((total, item) => total + item.count, 0),
  conflictPairCount: repeatedConflicts.length,
  topUnmappedConflicts: repeatedConflicts.slice(0, 20),
  mappingIntegrity: {
    uniqueMappings: mapping.uniqueMappings,
    complete: mapping.complete,
    malformedRows: mapping.malformedRows,
    anomalies: confirmedAnomalies,
  },
  protectedFamilies: ["COMPLETED_TASK", "COMPLETED_EVENT", "DELIVERY", "CANONICAL", "VERSION", "BASELINE", "RECURRENCE", "PROJECTION", "TASK", "EVENT", "TASKOWNER"],
};
console.log(JSON.stringify(summary, null, 2));

if (!apply) {
  console.log(JSON.stringify({ event: "production_state_cleanup_finished", deleted: 0, dryRun: true }));
  process.exit(0);
}
if (mapping.malformedRows > 0) {
  throw new Error("Malformed mapping records detected: investigate before performing even audit-only cleanup");
}
if (auditCandidates.length > maxDeletes) {
  throw new Error("Candidate count exceeds deletion cap; rerun report and explicitly set --max-deletes after review");
}
await verifyBackup();

// A second strongly consistent read plus conditional delete prevents races.
// No mutations to Calendar, Todoist, task/event mapping, or completion records.
let deleted = 0, changed = 0;
for (const scannedItem of auditCandidates) {
  const key = { pk: scannedItem.pk, sk: scannedItem.sk };
  const current = (await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
  if (!current || !classifyLegacyAudit(current, Date.now())) {
    changed += 1;
    continue;
  }
  if (current.createdAt !== scannedItem.createdAt
    || current.expiresAt !== scannedItem.expiresAt
    || current.action !== scannedItem.action) {
    changed += 1;
    continue;
  }
  try {
    await send(new DeleteCommand({
      TableName: tableName, Key: key,
      ConditionExpression: "attribute_exists(pk) AND #createdAt = :createdAt AND expiresAt = :expiresAt AND #action = :action",
      ExpressionAttributeNames: { "#createdAt": "createdAt", "#action": "action" },
      ExpressionAttributeValues: {
        ":createdAt": scannedItem.createdAt, ":expiresAt": scannedItem.expiresAt, ":action": scannedItem.action,
      },
    }));
    deleted += 1;
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") changed += 1;
    else throw error;
  }
  await sleep(200);
}
console.log(JSON.stringify({ event: "production_state_cleanup_finished", deleted, changed, dryRun: false }));
