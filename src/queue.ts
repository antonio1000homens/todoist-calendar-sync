import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { StateRepository } from "./repository.js";
import { sha256 } from "./security.js";
import { syncMessageGroupId, type Delivery, type Profile, type ReconciliationReason } from "./types.js";

const queue = new SQSClient({});

export class CalendarSyncAdmissionError extends Error {
  constructor(cause: unknown) {
    super("Unable to durably admit a follow-up Calendar sync request");
    this.name = "CalendarSyncAdmissionError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

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

/** Admit at most one incremental Calendar request per profile. DynamoDB owns
 * the durable claim; FIFO preserves its order alongside independent Todoist
 * deliveries. An expired claim is recoverable after an ingress crash. */
export async function enqueueCalendarSync(state: StateRepository, profile: Profile): Promise<boolean> {
  let generation: number | undefined;
  try {
    generation = await state.claimCalendarSyncDispatch(profile);
    if (generation === undefined) {
      if (await state.calendarSyncAlreadyHandled(profile)) return false;
      throw new Error(`Calendar sync request for ${profile} is still awaiting durable queue admission`);
    }
    const delivery: Delivery = {
      id: `calendar-sync:${profile}:${generation}:${randomUUID()}`, kind: "calendar", profile, mode: "aws",
      receivedAt: new Date().toISOString(), headers: {}, body: "", calendarSync: { generation },
    };
    await enqueueDelivery(delivery);
    await state.markCalendarSyncQueued(profile, generation);
    return true;
  }
  catch (error) {
    let cause: unknown = error;
    if (generation !== undefined) {
      try { await state.releaseCalendarSyncDispatch(profile, generation); }
      catch (releaseError) { cause = new AggregateError([error, releaseError], "Calendar sync dispatch and claim release both failed"); }
    }
    throw new CalendarSyncAdmissionError(cause);
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
 * the next scheduled check or manual request can safely re-enqueue the generation.
 *
 * enqueue is injectable for behavioral tests; production callers use the FIFO
 * SQS implementation above for manual and scheduled full reconciliations.
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
