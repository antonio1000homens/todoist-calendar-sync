import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

const DEFAULT_SCAN_PAGE_ITEM_LIMIT = 25;
const DEFAULT_SCAN_RCU_BUDGET_PER_SECOND = 10;
const DEFAULT_SCAN_JITTER_MS = 50;
const LARGE_ITEM_WARNING_BYTES = 16 * 1024;
const LARGE_ITEM_CRITICAL_BYTES = 64 * 1024;

const baseClient = new DynamoDBClient({
  maxAttempts: 5,
  retryMode: "standard",
});

export const documentClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export function estimateItemBytes(item: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(item));
  } catch {
    return 0;
  }
}

export function itemSizeSeverity(bytes: number): "normal" | "warning" | "critical" {
  if (bytes >= LARGE_ITEM_CRITICAL_BYTES) return "critical";
  if (bytes >= LARGE_ITEM_WARNING_BYTES) return "warning";
  return "normal";
}

function stateIdentity(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") return {};
  const value = item as Record<string, unknown>;
  return {
    pk: typeof value.pk === "string" ? value.pk.slice(0, 160) : undefined,
    sk: typeof value.sk === "string" ? value.sk.slice(0, 80) : undefined,
  };
}

function observeItemSize(operation: string, item: unknown): void {
  const bytes = estimateItemBytes(item);
  const severity = itemSizeSeverity(bytes);
  if (severity === "normal") return;
  const record = {
    service: "todoist-calendar-sync",
    event: "dynamodb_large_item",
    operation,
    severity,
    estimatedBytes: bytes,
    warningThresholdBytes: LARGE_ITEM_WARNING_BYTES,
    criticalThresholdBytes: LARGE_ITEM_CRITICAL_BYTES,
    ...stateIdentity(item),
  };
  if (severity === "critical") console.error(JSON.stringify(record));
  else console.warn(JSON.stringify(record));
}

documentClient.middlewareStack.add(
  (next, context) => async (args) => {
    const input = args.input as Record<string, unknown>;
    if (input.Item) observeItemSize(context.commandName || "PutItem", input.Item);
    const transactItems = Array.isArray(input.TransactItems) ? input.TransactItems as Array<Record<string, unknown>> : [];
    for (const entry of transactItems) {
      const put = entry.Put as Record<string, unknown> | undefined;
      if (put?.Item) observeItemSize(context.commandName || "TransactWriteItems", put.Item);
    }
    return next(args);
  },
  { step: "initialize", name: "todoistCalendarSyncItemSizeObservability", priority: "low" },
);

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function scanPageItemLimit(): number {
  return Math.max(1, Math.floor(positiveNumber(
    process.env.TODOIST_CALENDAR_SYNC_DYNAMODB_SCAN_PAGE_ITEM_LIMIT,
    DEFAULT_SCAN_PAGE_ITEM_LIMIT,
  )));
}

export function scanRcuBudgetPerSecond(): number {
  return positiveNumber(
    process.env.TODOIST_CALENDAR_SYNC_DYNAMODB_SCAN_RCU_BUDGET_PER_SECOND,
    DEFAULT_SCAN_RCU_BUDGET_PER_SECOND,
  );
}

export function pacingDelayMs(
  consumedCapacityUnits: number,
  elapsedMs: number,
  budgetPerSecond = scanRcuBudgetPerSecond(),
): number {
  if (!Number.isFinite(consumedCapacityUnits) || consumedCapacityUnits <= 0) return 0;
  if (!Number.isFinite(budgetPerSecond) || budgetPerSecond <= 0) return 0;
  const targetElapsedMs = (consumedCapacityUnits / budgetPerSecond) * 1000;
  return Math.max(0, Math.ceil(targetElapsedMs - Math.max(0, elapsedMs)));
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export interface PacedScanOptions {
  operation: string;
  profile?: string;
  pageItemLimit?: number;
  rcuBudgetPerSecond?: number;
  jitterMs?: number;
  client?: Pick<typeof documentClient, "send">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface PacedScanResult<T> {
  items: T[];
  pages: number;
  scannedCount: number;
  returnedCount: number;
  consumedCapacityUnits: number;
  durationMs: number;
  pacedDelayMs: number;
}

export async function pacedScan<T>(
  input: Omit<ScanCommandInput, "ExclusiveStartKey" | "ReturnConsumedCapacity">,
  options: PacedScanOptions,
): Promise<PacedScanResult<T>> {
  const client = options.client || documentClient;
  const now = options.now || Date.now;
  const delay = options.sleep || sleep;
  const random = options.random || Math.random;
  const pageItemLimit = Math.max(1, Math.floor(options.pageItemLimit || scanPageItemLimit()));
  const rcuBudget = options.rcuBudgetPerSecond || scanRcuBudgetPerSecond();
  const jitterLimit = Math.max(0, Math.floor(options.jitterMs ?? DEFAULT_SCAN_JITTER_MS));
  const startedAt = now();

  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  let scannedCount = 0;
  let consumedCapacityUnits = 0;
  let pacedDelayMs = 0;

  do {
    const pageStartedAt = now();
    const result = await client.send(new ScanCommand({
      ...input,
      Limit: Math.min(pageItemLimit, Math.max(1, Math.floor(input.Limit ?? pageItemLimit))),
      ExclusiveStartKey: exclusiveStartKey,
      ReturnConsumedCapacity: "TOTAL",
    }));

    pages += 1;
    scannedCount += Number(result.ScannedCount || 0);
    items.push(...((result.Items || []) as T[]));
    const pageCapacity = Number(result.ConsumedCapacity?.CapacityUnits || 0);
    consumedCapacityUnits += pageCapacity;
    exclusiveStartKey = result.LastEvaluatedKey;

    let waitMs = pacingDelayMs(pageCapacity, now() - pageStartedAt, rcuBudget);
    if (exclusiveStartKey && waitMs > 0 && jitterLimit > 0) {
      waitMs += Math.floor(random() * (jitterLimit + 1));
    }

    console.log(JSON.stringify({
      service: "todoist-calendar-sync",
      event: "dynamodb_scan_page",
      operation: options.operation,
      profile: options.profile,
      page: pages,
      scannedCount: Number(result.ScannedCount || 0),
      returnedCount: result.Items?.length || 0,
      consumedCapacityUnits: pageCapacity,
      rcuBudgetPerSecond: rcuBudget,
      nextPage: Boolean(exclusiveStartKey),
      pacingDelayMs: exclusiveStartKey ? waitMs : 0,
    }));

    if (exclusiveStartKey && waitMs > 0) {
      pacedDelayMs += waitMs;
      await delay(waitMs);
    }
  } while (exclusiveStartKey);

  const summary: PacedScanResult<T> = {
    items,
    pages,
    scannedCount,
    returnedCount: items.length,
    consumedCapacityUnits,
    durationMs: now() - startedAt,
    pacedDelayMs,
  };

  console.log(JSON.stringify({
    service: "todoist-calendar-sync",
    event: "dynamodb_scan_complete",
    operation: options.operation,
    profile: options.profile,
    ...summary,
    items: undefined,
  }));

  return summary;
}
