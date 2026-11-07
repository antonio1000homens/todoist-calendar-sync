#!/usr/bin/env node
/**
 * #367 read-only, operator-scoped forensic inventory. Absolutely no apply mode.
 * This is a *candidate report*, not evidence that any row is safe to delete.
 * Resumable scan state (including raw DynamoDB keys) stays in a mode-0600
 * local file; published JSON never contains provider IDs or raw DynamoDB rows.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  assessResidueRow, countResidueRow, emptyResidueReport,
  scopeDigest, validateResidueScope,
} from "./verified-deletion-residue-policy.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = e => ["ProvisionedThroughputExceededException", "ThrottlingException",
  "RequestLimitExceeded", "InternalServerError"].includes(e?.name);

export function parseArgs(args) {
  const opts = { caseIds: [], taskIds: [], eventIds: [], maxPages: 20, maxRefPages: 8, restart: false };
  for (const arg of args) {
    if (arg === "--restart") opts.restart = true;
    else if (arg.startsWith("--profile=")) opts.profile = arg.slice(10);
    else if (arg.startsWith("--case=")) opts.caseIds.push(arg.slice(7));
    else if (arg.startsWith("--task-id=")) opts.taskIds.push(arg.slice(10));
    else if (arg.startsWith("--event-id=")) opts.eventIds.push(arg.slice(11));
    else if (arg.startsWith("--max-pages=")) opts.maxPages = Number(arg.slice(12));
    else if (arg.startsWith("--max-ref-pages=")) opts.maxRefPages = Number(arg.slice(16));
    else if (arg.startsWith("--cursor-file=")) opts.cursorFile = arg.slice(14);
    else throw new Error("Unknown option (no --apply mode): " + arg.split("=")[0]);
  }
  validateResidueScope(opts);
  if (!Number.isSafeInteger(opts.maxPages) || opts.maxPages < 1 || opts.maxPages > 80)
    throw new Error("--max-pages must be between 1 and 80");
  if (!Number.isSafeInteger(opts.maxRefPages) || opts.maxRefPages < 1 || opts.maxRefPages > 12)
    throw new Error("--max-ref-pages must be between 1 and 12");
  return opts;
}

export async function inventory({
  options, table, client, cursorStore, clock = Date.now, delay = sleep,
}) {
  const scope = validateResidueScope(options);
  const digest = scopeDigest(scope, table);
  let saved = await cursorStore.load();
  if (options.restart) { saved = null; await cursorStore.clear(); }
  else if (saved && (saved.digest !== digest || !saved.report || !saved.cursor))
    throw new Error("Cursor scope differs from this exact table, case and provider-ID set; use --restart");

  // Immutable terminal receipts are necessary for the *inventory scope*.
  // They are NOT proof of provider absence or exclusive audit attribution.
  for (const caseId of scope.caseIds) {
    const res = await client.send(new GetCommand({ TableName: table,
      Key: { pk: "REVIEW_CASE#" + caseId, sk: "STATE" }, ConsistentRead: true }));
    const row = res.Item;
    if (!row || row.profile !== scope.profile || row.status !== "resolved"
      || typeof row.result !== "string" || !row.result.startsWith("resolved_deleted"))
      throw new Error("Selected case is missing, changed or not a verified-deletion terminal receipt");
  }

  // Read the exact indexed audit pointers independently of the full scan,
  // including every page. Partial pointer enumeration is a hard failure.
  const indexedKeys = new Set();
  for (const side of ["todoist", "calendar"]) {
    const ids = side === "todoist" ? scope.taskIds : scope.eventIds;
    for (const id of ids) {
      let cursor;
      let page = 0;
      do {
        if (++page > options.maxRefPages)
          throw new Error("Audit reverse-pointer pagination incomplete; raise --max-ref-pages (bounded)");
        const res = await client.send(new QueryCommand({
          TableName: table, ConsistentRead: true, Limit: 50,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": "AUDIT_REF#" + scope.profile + "#" + side + "#" + id },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          ReturnConsumedCapacity: "TOTAL",
        }));
        for (const item of res.Items || []) if (typeof item.auditKey === "string")
          indexedKeys.add(item.auditKey);
        cursor = res.LastEvaluatedKey;
        await delay(Math.max(200, Math.ceil(Number(res.ConsumedCapacity?.CapacityUnits || 1) * 200)));
      } while (cursor);
    }
  }

  const report = saved?.report || emptyResidueReport();
  let cursor = saved?.cursor;
  let scannedPages = 0, scannedItems = 0, scannedUnits = 0;
  let complete = false;
  for (; scannedPages < options.maxPages; scannedPages++) {
    const res = await client.send(new ScanCommand({
      TableName: table, ConsistentRead: true, Limit: 25,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      ReturnConsumedCapacity: "TOTAL",
    }));
    scannedItems += res.ScannedCount || 0;
    scannedUnits += Number(res.ConsumedCapacity?.CapacityUnits || 0);
    for (const row of res.Items || []) {
      const assessment = assessResidueRow(row, scope, indexedKeys, clock() / 1000);
      countResidueRow(report, row, assessment);
    }
    cursor = res.LastEvaluatedKey;
    if (cursor) await cursorStore.save({ digest, cursor, report });
    await delay(Math.max(200, Math.ceil(Number(res.ConsumedCapacity?.CapacityUnits || 1) * 200)));
    if (!cursor) { complete = true; await cursorStore.clear(); break; }
  }

  return {
    event: "verified_deletion_residue_inventory",
    mode: "read_only", scope: { profile: scope.profile, cases: scope.caseIds.length,
      taskIds: scope.taskIds.length, eventIds: scope.eventIds.length },
    scanComplete: complete, resumeSaved: !complete,
    scannedPages: scannedPages + (complete ? 1 : 0),
    scannedItemsThisRun: scannedItems,
    consumedCapacityThisRun: scannedUnits,
    ...report,
    caveat: "Exact IDs and terminal DynamoDB receipts identify CANDIDATES only. This tool does not verify provider absence, series instances, mapping ownership, active writes, or exclusive deletion eligibility. eligible_and_exclusively_attributable deliberately stays zero. TTL deletion is asynchronous; no data was modified.",
  };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  const table = env.STATE_TABLE_NAME?.trim();
  if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error("Explicit STATE_TABLE_NAME is required");
  if (!env.AWS_REGION?.trim()) throw new Error("Explicit AWS_REGION is required");
  const digest = scopeDigest(options, table);
  // Default cursor location is private and scope-bound; no IDs are logged.
  const filename = options.cursorFile || join(tmpdir(), "todoist-sync-residue-" + digest.slice(0, 20) + ".json");
  const cursorStore = {
    load: async () => {
      try { return JSON.parse(await readFile(filename, "utf8")); }
      catch (e) { if (e?.code === "ENOENT") return null; throw e; }
    },
    save: async value => { await writeFile(filename, JSON.stringify(value), { mode: 0o600 }); },
    clear: async () => { await unlink(filename).catch(e => { if (e.code !== "ENOENT") throw e; }); },
  };
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: env.AWS_REGION, maxAttempts: 4, retryMode: "standard",
  }), { marshallOptions: { removeUndefinedValues: true } });
  const client = { send: async command => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await db.send(command); }
      catch (e) {
        if (!retryable(e) || attempt === 4) throw e;
        await sleep(Math.min(5000, 250 * 2 ** attempt));
      }
    }
  }};
  const report = await inventory({ options, table, client, cursorStore });
  console.log(JSON.stringify(report, null, 2));
  if (!report.scanComplete) process.exitCode = 2; // Explicit partial audit, safe to resume.
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e => { console.error("Read-only inventory failed: " + String(e?.message || e)); process.exitCode = 1; });
