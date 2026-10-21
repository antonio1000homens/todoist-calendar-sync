import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StateRepository } from "./repository.js";
import { sha256 } from "./security.js";
import { syncMessageGroupId, type Delivery, type Profile, type ReconciliationReason } from "./types.js";

const queue = new SQSClient({});

function queueUrl(): string {
  const value = process.env.QUEUE_URL;
  if (!value) throw new Error("QUEUE_URL is not configured");
  return value;
}

/** Bound transport IDs without changing logical delivery IDs or completion keys. */
export function messageDeduplicationId(delivery: Pick<Delivery, "profile" | "kind" | "id">): string {
  return sha256(JSON.stringify(["sqs-dedup-v1", delivery.profile, delivery.kind, delivery.id]));
}

export async function enqueueDelivery(delivery: Delivery): Promise<void> {
  await queue.send(new SendMessageCommand({
    QueueUrl: queueUrl(),
    MessageBody: JSON.stringify(delivery),
    MessageGroupId: syncMessageGroupId(delivery.profile),
    MessageDeduplicationId: messageDeduplicationId(delivery),
  }));
}

export interface ReconciliationRequestResult {
  profile: Profile;
  generation: string;
  reason: ReconciliationReason;
  created: boolean;
  queued: boolean;
  coalesced: boolean;
  recoveredPending: boolean;
  enqueueError?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}

type EnqueueReconciliation = (delivery: Delivery) => Promise<void>;
export interface ReconciliationRequestContext { requester?: string; slackChannelId?: string; slackMessageTs?: string; slackThreadTs?: string; slackDecisionId?: string; }

/**
 * Durably marks a profile dirty before attempting SQS delivery. If the SQS
 * send fails the pending marker remains without a fresh lastEnqueuedAt value;
 * a later explicit Slack request can safely re-enqueue the same generation.
 *
 * enqueue is injectable for behavioral tests; production callers use the FIFO
 * SQS implementation above.
 */
export async function requestReconciliation(
  state: StateRepository,
  profile: Profile,
  reason: ReconciliationReason,
  enqueue: EnqueueReconciliation = enqueueDelivery,
  context: ReconciliationRequestContext = {},
): Promise<ReconciliationRequestResult> {
  const request = await state.requestReconciliation(profile, reason, context);
  const location = {
    slackChannelId: request.state.slackChannelId,
    slackThreadTs: request.state.slackThreadTs || request.state.slackMessageTs,
  };
  if (!request.shouldEnqueue) {
    return {
      profile,
      generation: request.state.generation,
      reason,
      created: request.created,
      queued: false,
      coalesced: true,
      recoveredPending: false,
      ...location,
    };
  }

  const delivery: Delivery = {
    id: `reconcile:${profile}:${request.state.generation}`,
    kind: "reconcile",
    profile,
    mode: "aws",
    receivedAt: new Date().toISOString(),
    headers: {},
    body: "",
    reconcile: {
      reason,
      generation: request.state.generation,
      ...context,
    },
  };

  try {
    await enqueue(delivery);
    await state.markReconciliationEnqueued(profile, request.state.generation);
    return {
      profile,
      generation: request.state.generation,
      reason,
      created: request.created,
      queued: true,
      coalesced: false,
      recoveredPending: !request.created,
      ...location,
    };
  } catch (error) {
    return {
      profile,
      generation: request.state.generation,
      reason,
      created: request.created,
      queued: false,
      coalesced: false,
      recoveredPending: !request.created,
      ...location,
      enqueueError: error instanceof Error ? error.message : String(error),
    };
  }
}
