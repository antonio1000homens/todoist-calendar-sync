import { ChangeMessageVisibilityCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import type { SQSRecord } from "aws-lambda";
import type { Delivery, Profile } from "./types.js";
import { syncMessageGroupId } from "./types.js";

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
  $retryable?: { throttling?: boolean };
  CancellationReasons?: Array<{ Code?: string }>;
};

function fields(error: unknown): ErrorFields {
  return error && typeof error === "object" ? error as ErrorFields : {};
}

/**
 * Match explicit AWS DynamoDB exceptions, including known transaction-wide
 * throttling cancellation reasons. Never match on text/status alone; Google
 * or Todoist 429s and conditional/erasure conflicts must not be replayed.
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
  reason: "transient_dynamodb" | "partial_provider_mutation" | "unverified_delivery_type" | "non_transient" | "retries_exhausted";
  receiveCount: number;
}

export function failedDeliveryDisposition(
  error: unknown,
  delivery: Pick<Delivery, "kind"> | undefined,
  providerMutationObserved: boolean,
  receiveCount: number,
): FailedDeliveryDisposition {
  const attempts = Number.isInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1;
  if (!isTransientDynamoDbFailure(error)) return { kind:"quarantine", reason:"non_transient", receiveCount:attempts };
  // A provider write may already have happened. The DynamoDB state write may
  // have failed after it, so automated replay could duplicate provider writes.
  if (providerMutationObserved) return { kind:"quarantine", reason:"partial_provider_mutation", receiveCount:attempts };
  // Do not replay manual approvals, repairs, erasure-sensitive orphan work or
  // partially persisted reconciliation generations without operator review.
  if (!delivery || !["calendar", "todoist"].includes(delivery.kind)) {
    return { kind:"quarantine", reason:"unverified_delivery_type", receiveCount:attempts };
  }
  if (attempts >= MAX_SYNC_RECEIVES) return { kind:"quarantine", reason:"retries_exhausted", receiveCount:attempts };
  return { kind:"retry_fifo", reason:"transient_dynamodb", receiveCount:attempts };
}

export function transientRetryVisibilitySeconds(receiveCount: number): number {
  return Math.min(240, 30 * 2 ** Math.max(0, Math.min(3, receiveCount - 1)));
}

export async function shortenTransientRetryVisibility(record: SQSRecord, receiveCount: number): Promise<void> {
  const queueUrl = process.env.SYNC_QUEUE_URL;
  if (!queueUrl || !record.receiptHandle) throw new Error("Source SQS queue URL and receipt handle required");
  await syncFailureQueueClient.send(new ChangeMessageVisibilityCommand({
    QueueUrl:queueUrl,
    ReceiptHandle:record.receiptHandle,
    VisibilityTimeout:transientRetryVisibilitySeconds(receiveCount),
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
