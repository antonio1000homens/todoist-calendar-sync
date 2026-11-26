import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import type { SQSRecord } from "aws-lambda";
import type { Delivery, DeliveryKind, Profile } from "./types.js";
import { syncMessageGroupId } from "./types.js";
import { isSafeProviderReplay } from "./safe-provider-replay.js";

/**
 * The source FIFO queue is the retry buffer. Never enqueue a replacement
 * delivery at the tail of the queue: it would let newer profile events
 * overtake a failed earlier event. All retry attempts use the original
 * message ID, body, SQS FIFO group, completion marker and erasure epoch.
 */
export const MAX_SYNC_RECEIVES = 5;
export const DLQ_RETENTION_SECONDS = 14 * 24 * 60 * 60;
export const syncFailureQueueClient = new SQSClient({});

const TRANSIENT_DYNAMODB_ERRORS = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "ThrottlingError",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
  "TransactionInProgressException",
  "ReplicatedWriteConflictException",
]);
const THROTTLED_CANCELLATION_CODES = new Set([
  "ProvisionedThroughputExceeded", "ThrottlingError",
]);
const MAX_CAUSE_DEPTH = 6;

type ErrorFields = {
  name?: string;
  cause?: unknown;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  $retryable?: { throttling?: boolean };
  CancellationReasons?: Array<{ Code?: string }>;
};

function fields(error: unknown): ErrorFields {
  return error && typeof error === "object" ? error as ErrorFields : {};
}

function hasProviderErrorBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_tag?: unknown };
    return Boolean(parsed && typeof parsed === "object" && ("error" in parsed || "error_tag" in parsed));
  } catch {
    return false;
  }
}

/**
 * Match explicit AWS DynamoDB exceptions, including known transaction-wide
 * throttling cancellation reasons. Provider HTTP failures are classified
 * separately and require a recognizable provider response body.
 */
export function isTransientDynamoDbFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const e = fields(current);
    if (e.name === "TransactionCanceledException") {
      const reasons = e.CancellationReasons || [];
      // If AWS omitted cancellation reasons, the transaction's reason is
      // ambiguous. Any conditional or validation reason makes it nonretryable.
      return reasons.length > 0 && reasons.some(r => THROTTLED_CANCELLATION_CODES.has(r.Code || ""))
        && reasons.every(r => r.Code === "None" || (typeof r.Code === "string" && THROTTLED_CANCELLATION_CODES.has(r.Code)));
    }
    if (e.name && TRANSIENT_DYNAMODB_ERRORS.has(e.name)) return true;
    // SDK $retryable hints alone are insufficient to identify DynamoDB.
    current = e.cause;
  }
  return false;
}

export interface FailedDeliveryDisposition {
  kind: "retry_fifo" | "quarantine";
  reason: "transient_dynamodb" | "transient_provider" | "safe_provider_replay" | "partial_provider_mutation" | "unverified_delivery_type" | "non_transient" | "retries_exhausted";
  receiveCount: number;
}

/** Provider throttling and temporary outages can retry only before any write was attempted. */
export function isTransientProviderFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const e = fields(current) as ErrorFields & { body?: unknown; providerReason?: unknown };
    const status = Number(e.status);
    const transientStatus = status === 408 || status === 429 || (status >= 500 && status < 600);
    const providerResponse = hasProviderErrorBody(e.body)
      || (e.name === "ReconciliationItemError" && typeof e.providerReason === "string");
    if (transientStatus && providerResponse) return true;
    current = e.cause;
  }
  return false;
}

export function failedDeliveryDisposition(
  error: unknown,
  delivery: Pick<Delivery, "kind"> | undefined,
  providerMutationObserved: boolean,
  receiveCount: number,
): FailedDeliveryDisposition {
  const attempts = Number.isInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1;
  const safeReplay = isSafeProviderReplay(error);
  const accountCooldown = fields(error).code === "todoist_account_cooldown";
  const transientDynamoDb = isTransientDynamoDbFailure(error);
  const transientProvider = !transientDynamoDb && (accountCooldown || safeReplay || isTransientProviderFailure(error));
  if (!transientDynamoDb && !transientProvider) return { kind:"quarantine", reason:"non_transient", receiveCount:attempts };
  // A provider write may already have happened. The DynamoDB state write may
  // have failed after it, so automated replay could duplicate provider writes.
  if (providerMutationObserved && !safeReplay) return { kind:"quarantine", reason:"partial_provider_mutation", receiveCount:attempts };
  // Retry only deliveries whose state is safe to re-read. Reconciliation chunks
  // are idempotent when no provider write has been attempted; repair and
  // erasure-sensitive operations remain quarantined.
  const retryableKinds: DeliveryKind[] = accountCooldown ? ["calendar", "todoist", "orphan", "reconcile", "manual", "repair"]
    : safeReplay ? ["todoist"]
    : transientProvider ? ["calendar", "todoist", "reconcile"] : ["calendar", "todoist"];
  if (!delivery || !retryableKinds.includes(delivery.kind)) {
    return { kind:"quarantine", reason:"unverified_delivery_type", receiveCount:attempts };
  }
  if (attempts >= MAX_SYNC_RECEIVES && !accountCooldown) return { kind:"quarantine", reason:"retries_exhausted", receiveCount:attempts };
  return { kind:"retry_fifo", reason:safeReplay ? "safe_provider_replay" : transientProvider ? "transient_provider" : "transient_dynamodb", receiveCount:attempts };
}

export function transientRetryVisibilitySeconds(receiveCount: number, retryAfterMs?: number): number {
  const exponential = 30 * 2 ** Math.max(0, Math.min(3, receiveCount - 1));
  const hinted = Number.isFinite(retryAfterMs) ? Math.ceil(Math.max(0, retryAfterMs!) / 1000) : 0;
  // Leave room for the worker's full five-minute Lambda execution under SQS's
  // 12-hour maximum, which is measured from the original receive timestamp.
  return Math.min(42_900, Math.max(exponential, hinted));
}

export function providerRetryAfterMs(error: unknown): number | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const e = fields(current);
    if (Number(e.status) === 429 && Number.isFinite(e.retryAfterMs) && Number(e.retryAfterMs) >= 0)
      return Number(e.retryAfterMs);
    current = e.cause;
  }
  return undefined;
}

export async function shortenTransientRetryVisibility(record: SQSRecord, receiveCount: number,
  retryAfterMs?: number): Promise<void> {
  const queueUrl = process.env.SYNC_QUEUE_URL;
  if (!queueUrl || !record.receiptHandle) throw new Error("Source SQS queue URL and receipt handle required");
  await syncFailureQueueClient.send(new ChangeMessageVisibilityCommand({
    QueueUrl:queueUrl,
    ReceiptHandle:record.receiptHandle,
    VisibilityTimeout:transientRetryVisibilitySeconds(receiveCount, retryAfterMs),
  }));
}

/**
 * Permanent/ambiguous failures are quarantined immediately rather than
 * replayed MAX_SYNC_RECEIVES times. Send ORIGINAL payload to the DLQ with
 * its profile FIFO group; only acknowledge the source after SQS confirms.
 * A failed handoff returns the original message as failed for native redrive.
 */
export async function quarantineFailedRecord(record: SQSRecord, profile: Profile): Promise<void> {
  const dlqUrl = process.env.DLQ_URL;
  if (!dlqUrl) throw new Error("DLQ_URL is not configured; cannot acknowledge source message");
  const id = createHash("sha256").update(JSON.stringify([
    "sync-dlq-handoff-v1", record.messageId, record.attributes?.SequenceNumber || "",
  ])).digest("hex");
  await syncFailureQueueClient.send(new SendMessageCommand({
    QueueUrl:dlqUrl,
    MessageBody:record.body,
    MessageGroupId:record.attributes?.MessageGroupId || syncMessageGroupId(profile),
    MessageDeduplicationId:id,
  }));
}
