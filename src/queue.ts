import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { StateRepository } from "./repository.js";
import { acquireProfileAdmissionLeaseWithEpoch, ErasureEpochChangedError } from "./erasure-protocol.js";
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
  const protocolEnabled = process.env.ERASURE_PROTOCOL_VERSION === "1";
  let epoch: number | undefined;
  let release: (() => Promise<void>) | undefined;
  if (protocolEnabled) {
    // Never resample and re-enqueue an in-flight payload after an epoch race.
    // A provider retry gets a fresh invocation and passes through live-state checks.
    try {
      const admission=await acquireProfileAdmissionLeaseWithEpoch(delivery.profile);
      release=admission.release;
      epoch=admission.epoch;
    } catch (error) {
      if (error instanceof ErasureEpochChangedError) {
        throw new Error("Admission rejected because the erasure epoch changed; retry from the source after revalidation");
      }
      throw error;
    }
  }
  try {
    const admittedDelivery = protocolEnabled
      ? { ...delivery, erasureEpoch: epoch }
      : delivery;
    await queue.send(new SendMessageCommand({
      QueueUrl: queueUrl(),
      MessageBody: JSON.stringify(admittedDelivery),
      MessageGroupId: syncMessageGroupId(admittedDelivery.profile),
      MessageDeduplicationId: messageDeduplicationId(admittedDelivery),
    }));
  } finally {
    await release?.();
  }
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
export interface ReconciliationRequestContext {
  requester?: string; slackChannelId?: string; slackMessageTs?: string; slackThreadTs?: string; slackDecisionId?: string;
  pendingRefreshRefs?: Array<{profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string}>;
}

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
    await state.markReconciliationEnqueued(profile, request.state.generation, delivery.id);
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

/** Schedule a profile refresh for entity updates deferred by an active repair. */
export async function queuePendingRefresh(
  state: StateRepository,
  profile: Profile,
  pendingRefreshRefs: NonNullable<Delivery["reconcile"]>["pendingRefreshRefs"],
): Promise<ReconciliationRequestResult> {
  if (!pendingRefreshRefs?.length) throw new Error("At least one pending repair update is required");
  return requestReconciliation(state, profile, "manual", enqueueDelivery, { requester:"repair-refresh", pendingRefreshRefs });
}
