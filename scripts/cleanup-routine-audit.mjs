#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { classifyAuditAction } from "../dist/audit-policy.js";

const tableName = process.env.STATE_TABLE_NAME || "todoist-calendar-sync-state-production";
const apply = process.argv.includes("--apply");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const candidates = [];
const counts = new Map();
let lastEvaluatedKey;

do {
  const result = await client.send(new ScanCommand({
    TableName: tableName,
    FilterExpression: "begins_with(pk, :prefix)",
    ExpressionAttributeValues: { ":prefix": "AUDIT#" },
    ProjectionExpression: "pk, sk, #action",
    ExpressionAttributeNames: { "#action": "action" },
    ExclusiveStartKey: lastEvaluatedKey,
    Limit: 25,
  }));
  for (const item of result.Items || []) {
    if (typeof item.action !== "string" || classifyAuditAction(item.action) !== "routine") continue;
    candidates.push({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } });
    counts.set(item.action, (counts.get(item.action) || 0) + 1);
  }
  lastEvaluatedKey = result.LastEvaluatedKey;
} while (lastEvaluatedKey);

console.log(JSON.stringify({
  event: "routine_audit_cleanup_preview",
  mode: apply ? "apply" : "preview",
  tableName,
  candidateCount: candidates.length,
  actions: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
}));

if (apply) {
  for (let offset = 0; offset < candidates.length; offset += 25) {
    let pending = candidates.slice(offset, offset + 25);
    for (let attempt = 0; pending.length > 0 && attempt < 8; attempt += 1) {
      const result = await client.send(new BatchWriteCommand({
        RequestItems: { [tableName]: pending },
      }));
      pending = result.UnprocessedItems?.[tableName] || [];
      if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    if (pending.length > 0) throw new Error(`Unprocessed audit deletes remain after retries at offset ${offset}`);
  }
  console.log(JSON.stringify({ event: "routine_audit_cleanup_complete", deleted: candidates.length }));
}
