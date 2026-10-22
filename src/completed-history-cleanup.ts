/**
 * Bounded, resumable cleanup of COMPLETED_TASK lookup rows only.
 * Never touches Google Calendar, Todoist, or permanent COMPLETED_EVENT guards.
 * Disabled for writes in production until a reviewed dry-run enables it.
 */
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient as db } from "./dynamodb-capacity.js";
import { terminalCompletionDecision } from "./completed-history-policy.js";
import type { CompletedCalendarProjection, Profile } from "./types.js";

const profiles: Profile[] = ["home", "antonio", "work"];
const cursorKey = { pk: "MAINTENANCE#TERMINAL_COMPLETED_TASK", sk: "STATE" };
const MAX_HISTORY_ROWS = 12; // conservative: all guards and deletes fit in one DynamoDB transaction
type Row = CompletedCalendarProjection & { pk: string; sk: string };
type ScanKey = Record<string, unknown>;
export type CleanupCounts = {
  eligible: number; retired: number; skipped_active: number;
  skipped_ambiguous: number; too_recent: number; failed: number;
  scanned: number; pages: number; nextCursor?: ScanKey;
};
const key = (pk: string, sk = "STATE") => ({ pk, sk });

async function strongGet(table: string, pk: string, sk = "STATE"): Promise<Record<string, unknown> | undefined> {
  const response = await db.send(new GetCommand({ TableName: table, Key: key(pk, sk), ConsistentRead: true }));
  return response.Item;
}

function conditionalRace(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return e.name === "TransactionCanceledException"
    && Boolean(e.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed"))
    && Boolean(e.CancellationReasons?.every((r) => r.Code === "None" || r.Code === "ConditionalCheckFailed"));
}

async function processTask(
  table: string, profile: Profile, taskId: string, apply: boolean, nowMs: number,
): Promise<"eligible" | "retired" | "skipped_active" | "skipped_ambiguous" | "too_recent"> {
  const queried = await db.send(new QueryCommand({
    TableName: table, ConsistentRead: true,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :event)",
    ExpressionAttributeValues: { ":pk": `COMPLETED_TASK#${profile}#${taskId}`, ":event": "EVENT#" },
    Limit: MAX_HISTORY_ROWS + 1,
  }));
  const rows = (queried.Items || []) as Row[];
  if (!rows.length) return "skipped_ambiguous"; // another cleanup already won
  if (queried.LastEvaluatedKey || rows.length > MAX_HISTORY_ROWS
    || rows.some((p) => p.pk !== `COMPLETED_TASK#${profile}#${taskId}`
      || p.sk !== `EVENT#${p.eventId}`)) return "skipped_ambiguous";
  const decision = terminalCompletionDecision(rows, nowMs);
  if (decision !== "eligible") return decision === "too_recent" ? "too_recent" : "skipped_ambiguous";

  // The preflight is a courtesy for diagnostics. Conditions in the transaction
  // below are authoritative if a new mapping/recurrence races the cleanup.
  const absent = new Set<string>();
  absent.add(`TASKOWNER#${taskId}|MAP`);
  for (const candidateProfile of profiles) {
    absent.add(`TASK#${candidateProfile}#${taskId}|MAP`);
    for (const row of rows) absent.add(`EVENT#${candidateProfile}#${row.eventId}|MAP`);
    for (const seriesId of [...new Set(rows.map((r) => r.seriesId).filter((s): s is string => Boolean(s)))]) {
      absent.add(`RECURRENCE#${candidateProfile}#${seriesId}|STATE`);
    }
  }
  for (const entry of absent) {
    const separator = entry.lastIndexOf("|");
    if (await strongGet(table, entry.slice(0, separator), entry.slice(separator + 1))) return "skipped_active";
  }
  for (const row of rows) {
    const marker = await strongGet(table, `COMPLETED_EVENT#${profile}#${row.eventId}`);
    if (marker?.taskId !== taskId || marker.completedAt !== row.completedAt || marker.profile !== profile) {
      return "skipped_ambiguous";
    }
  }
  // A baseline is task-facing but not keyed by event. Retire it only when it
  // predates the proven terminal completion, with a condition on its exact
  // observed timestamp; never erase a newer reconciliation baseline.
  const baselineKey = key(`BASELINE#${profile}#TASK#${taskId}`, "RECONCILE");
  const baseline = await strongGet(table, baselineKey.pk, baselineKey.sk);
  const latest = Math.max(...rows.map((r) => Date.parse(r.completedAt)));
  if (baseline && (typeof baseline.updatedAt !== "string"
    || !Number.isFinite(Date.parse(baseline.updatedAt))
    || Date.parse(baseline.updatedAt) > latest)) return "skipped_ambiguous";

  if (!apply) return "eligible";
  const tx: Array<Record<string, unknown>> = [];
  for (const reference of absent) {
    const separator = reference.lastIndexOf("|");
    tx.push({ ConditionCheck: {
      TableName: table, Key: key(reference.slice(0, separator), reference.slice(separator + 1)),
      ConditionExpression: "attribute_not_exists(pk)",
    } });
  }
  for (const row of rows) {
    const values = { ":profile": profile, ":task": taskId, ":time": row.completedAt };
    const condition = "#profile = :profile AND taskId = :task AND completedAt = :time";
    tx.push({ ConditionCheck: {
      TableName: table, Key: key(`COMPLETED_EVENT#${profile}#${row.eventId}`),
      ConditionExpression: condition,
      ExpressionAttributeNames: { "#profile": "profile" },
      ExpressionAttributeValues: values,
    } });
    tx.push({ Delete: {
      TableName: table, Key: key(row.pk, row.sk),
      ConditionExpression: condition,
      ExpressionAttributeNames: { "#profile": "profile" },
      ExpressionAttributeValues: values,
    } });
  }
  if (baseline) tx.push({ Delete: {
    TableName: table, Key: baselineKey,
    ConditionExpression: "updatedAt = :expected",
    ExpressionAttributeValues: { ":expected": baseline.updatedAt },
  } });
  if (tx.length > 100) return "skipped_ambiguous";
  try {
    await db.send(new TransactWriteCommand({ TransactItems: tx as never }));
    return "retired";
  } catch (error) {
    if (conditionalRace(error)) return "skipped_active";
    throw error;
  }
}

export async function runCompletedHistoryCleanup(options: {
  apply?: boolean; maxPages?: number; cursor?: ScanKey; nowMs?: number;
} = {}): Promise<CleanupCounts> {
  const table = process.env.STATE_TABLE_NAME?.trim();
  if (!table) throw new Error("STATE_TABLE_NAME must be set");
  const apply = options.apply === true;
  const maxPages = options.maxPages ?? 10;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new Error("maxPages must be 1..40");
  const nowMs = options.nowMs ?? Date.now();
  const stored = apply && !options.cursor ? await strongGet(table, cursorKey.pk, cursorKey.sk) : undefined;
  let cursor: ScanKey | undefined = options.cursor || (
    stored?.nextCursor && typeof stored.nextCursor === "object" ? stored.nextCursor as ScanKey : undefined
  );
  const counts: CleanupCounts = {
    eligible: 0, retired: 0, skipped_active: 0, skipped_ambiguous: 0,
    too_recent: 0, failed: 0, scanned: 0, pages: 0,
  };
  const visited = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const scan = await db.send(new ScanCommand({
      TableName: table,
      Limit: 25,
      FilterExpression: "begins_with(pk, :prefix)",
      ExpressionAttributeValues: { ":prefix": "COMPLETED_TASK#" },
      ExclusiveStartKey: cursor,
      ReturnConsumedCapacity: "TOTAL",
    }));
    counts.scanned += scan.ScannedCount || 0;
    counts.pages++;
    for (const raw of scan.Items || []) {
      const row = raw as Row;
      if (!profiles.includes(row.profile) || typeof row.taskId !== "string" || !row.taskId) {
        counts.skipped_ambiguous++;
        continue;
      }
      const identity = `${row.profile}#${row.taskId}`;
      if (visited.has(identity)) continue;
      visited.add(identity);
      try {
        const decision = await processTask(table, row.profile, row.taskId, apply, nowMs);
        counts[decision]++;
        if (decision === "retired") {
          console.info(JSON.stringify({ event: "terminal_completed_history_retired", profile: row.profile, count: 1 }));
        }
      } catch (error) {
        counts.failed++;
        console.error(JSON.stringify({ event: "terminal_completed_history_cleanup_failed", profile: row.profile,
          error: error instanceof Error ? error.name : "unknown" }));
      }
    }
    cursor = scan.LastEvaluatedKey as ScanKey | undefined;
    if (!cursor) break;
    const rcu = Number(scan.ConsumedCapacity?.CapacityUnits || 0);
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, Math.ceil(rcu * 1000 / 5))));
  }
  counts.nextCursor = cursor;
  if (apply) {
    await db.send(new PutCommand({
      TableName: table, Item: { ...cursorKey, ...(cursor ? { nextCursor: cursor } : {}),
        updatedAt: new Date(nowMs).toISOString(), lastCounts: counts },
    }));
  }
  console.info(JSON.stringify({ event: "terminal_completed_history_cleanup_report", apply,
    ...counts, nextCursor: Boolean(cursor) }));
  return counts;
}

export const handler = async (): Promise<CleanupCounts> => runCompletedHistoryCleanup({
  // Deliberately OFF until the preflight report has been reviewed.
  apply: process.env.TODOIST_CALENDAR_SYNC_COMPLETED_CLEANUP_APPLY === "true",
});
