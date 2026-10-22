#!/usr/bin/env node
// Human-gated, dry-run-by-default version of the scheduled maintenance worker.
import { DynamoDBClient, DescribeBackupCommand, DescribeContinuousBackupsCommand } from "@aws-sdk/client-dynamodb";
import { runCompletedHistoryCleanup } from "../dist/completed-history-cleanup.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const confirm = args.includes("--confirm=RETIRE_TERMINAL_COMPLETED_TASK_REFERENCES");
const backupArn = args.find((a) => a.startsWith("--backup-arn="))?.slice(13);
const pagesArg = args.find((a) => a.startsWith("--max-pages="))?.slice(12);
const cursorArg = args.find((a) => a.startsWith("--cursor="))?.slice(9);
const maxPages = pagesArg === undefined ? 10 : Number(pagesArg);
for (const arg of args) {
  if (!["--apply", "--confirm=RETIRE_TERMINAL_COMPLETED_TASK_REFERENCES"].includes(arg)
    && !["--backup-arn=", "--max-pages=", "--cursor="].some((prefix) => arg.startsWith(prefix))) {
    throw new Error("Unknown option " + arg);
  }
}
if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new Error("--max-pages must be 1..40");
if (apply && (!confirm || !backupArn)) throw new Error("Apply requires --confirm=RETIRE_TERMINAL_COMPLETED_TASK_REFERENCES and --backup-arn=...");
if (!apply && (confirm || backupArn)) throw new Error("Confirmation and backup are valid only for --apply");
if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required");
if (apply && cursorArg) throw new Error("Apply uses the durable DynamoDB cursor; --cursor is dry-run only");
let cursor;
if (cursorArg) {
  try {
    cursor = JSON.parse(Buffer.from(cursorArg, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error("invalid cursor");
  } catch { throw new Error("Invalid --cursor (base64url JSON object expected)"); }
}
if (apply) {
  const dynamodb = new DynamoDBClient({ maxAttempts: 5 });
  const description = (await dynamodb.send(new DescribeBackupCommand({ BackupArn: backupArn }))).BackupDescription;
  const backup = description?.BackupDetails;
  if (backup?.BackupStatus !== "AVAILABLE" || backup.BackupArn !== backupArn
    || backup.BackupCreationDateTime === undefined
    || Date.now() - backup.BackupCreationDateTime.getTime() > 24 * 60 * 60 * 1000
    || description?.SourceTableDetails?.TableName !== process.env.STATE_TABLE_NAME) {
    throw new Error("Apply requires an AVAILABLE backup from this exact table created in the last 24 hours");
  }
  const pitr = await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: process.env.STATE_TABLE_NAME }));
  if (pitr.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus !== "ENABLED") {
    throw new Error("DynamoDB point-in-time recovery must be enabled");
  }
}
const report = await runCompletedHistoryCleanup({ apply, maxPages, cursor });
const { nextCursor, ...counts } = report;
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts,
  ...(nextCursor ? { nextCursor: Buffer.from(JSON.stringify(nextCursor)).toString("base64url") } : { scanComplete: true }),
}, null, 2));
if (report.failed) process.exitCode = 1;
