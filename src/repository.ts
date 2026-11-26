import { ReviewStore as SyncReviewStore, SyncControls, reviewHash } from "./review-store.js";
import { dismissResolvedPrewriteRecoveryIncidents } from "./guarded-recovery-incidents.js";
import { recoveryCounterpartEventId, type RecoveryPolicy } from "./cancelled-mapping-recovery-policy.js";
import { createHash, randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient as client, pacedScan } from "./dynamodb-capacity.js";
import {assertReplayAdmissionIfEnabled, mappingReplayIdentity} from "./erasure-replay-barrier.js";
import {
  auditExpiresAt,
  classifyAuditAction,
  retainedAuditProviderIds,
  retainedConflictEntity,
  retainedConflictIdentity,
  retainedConflictIncidentId,
} from "./audit-policy.js";
import { logEvent, sanitizeTelemetryDetail } from "./observability.js";
import {
  mappingEventLookupAttributes,
  mappingLookupAttributes,
  mappingLookupQueryInput,
  mappingOwnerLookupAttributes,
  recurrenceLookupAttributes,
  recurrenceLookupQueryInput,
  readProfileLookup,
} from "./profile-lookup.js";
import type { CompletedCalendarProjection, Mapping, Profile, ReconciliationReason, RecurrenceLink } from "./types.js";
import {phaseBNativeMoveBeginTransaction,phaseBNativeMoveCommitTransaction,
  phaseBNativeMoveControlKeys,phaseBNativeMoveStage,phaseBNativeMoveStageKey,
  type PhaseBNativeMoveHandoff,type PhaseBNativeMoveStage,
} from "./todoist-phase-b-move-handoff.js";

const tableName = process.env.STATE_TABLE_NAME || "";
function annotateProviderAction(error: unknown, providerAction: string, providerSubAction?: string): void {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "providerAction", { value: providerAction, configurable: true });
      if (providerSubAction) Object.defineProperty(error, "providerSubAction", { value: providerSubAction, configurable: true });
    } catch { /* Preserve the provider failure if a non-extensible SDK error cannot be annotated. */ }
  }
}
const allProfiles: Profile[] = ["home", "antonio", "work"];
const CIRCUIT_MUTATION_LIMIT = 20;
const CIRCUIT_WINDOW_MS = 20_000;
const CIRCUIT_OPEN_MS = 5 * 60_000;
// A Lambda invocation cannot live longer than 15 minutes. Keep future-series
// split coordination only for the lifetime of an in-flight writer; an
// interrupted operation must not become a permanent reconciliation fence.
const FUTURE_SERIES_SPLIT_LEASE_SECONDS = 16 * 60;

export interface ReconciliationState {
  profile: Profile;
  pending: boolean;
  generation: string;
  reason: ReconciliationReason;
  requestedAt: string;
  lastRequestedAt: string;
  lastEnqueuedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  lastError?: string;
  failureContext?: { category: string; stage?: string; status?: number; taskId?: string; eventId?: string; seriesId?: string };
  status?: "queued" | "running" | "succeeded" | "needs_review" | "failed";
  requester?: string;
  slackChannelId?: string;
  slackMessageTs?: string;
  slackThreadTs?: string;
  slackDecisionId?: string;
  lastProgressAt?: string;
  result?: Record<string, number>;
  /** Monotonic compare-and-swap token for persisted reconciliation progress. */
  progressRevision?: number;
  unresolved?: number;
  notificationPending?: boolean;
  notificationText?: string;
  notificationReplyTs?: string;
  lastHealthAlertAt?: string;
  /** Last durable worker checkpoint and accepted continuation identity. */
  progressCheckpoint?: {
    phase?: "mapped" | "unmapped" | "calendar";
    sequence?: number;
    deliveryId?: string;
    nextDeliveryId?: string;
    afterTaskId?: string;
    afterEventId?: string;
    observedAt: string;
  };
  nextContinuation?: { phase: "mapped" | "unmapped" | "calendar"; sequence: number; deliveryId: string;
    afterTaskId?: string; afterEventId?: string };
  queueState?: "accepted" | "running" | "terminal";
  lastDeliveryId?: string;
  lastStartedDeliveryId?: string;
  pendingRefreshRefs?: Array<{ profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string }>;
  /** Refreshes requested after this run started; they require a fresh generation. */
  followUpRefreshRefs?: Array<{ profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string }>;
}

export interface ReconciliationDiagnostic {
  profile: Profile;
  generation: string;
  action: string;
  outcome: "conflict" | "blocked" | "deferred";
  reason: string;
  taskId?: string;
  eventId?: string;
  seriesId?: string;
  recurrenceOwner?: string;
  caseId?: string;
  caseStatus?: string;
  observedAt: string;
  sourceDeliveryId: string;
  detail: Record<string, unknown>;
}

export function reconciliationDiagnosticOutcome(action: string): ReconciliationDiagnostic["outcome"] | undefined {
  if (!action.startsWith("todoist_snapshot_reconcile_") && !action.startsWith("calendar_snapshot_")
    && !["todoist_snapshot_consolidated_duplicate_ignored", "todoist_snapshot_future_series_split_pending"].includes(action)) return undefined;
  if (action.includes("recurring_deferred")) return "deferred";
  if (/(?:conflict|ambiguous|ownership|disappeared)/.test(action)) return "conflict";
  if (/(?:blocked|sync_control|pending|missing_after_repair|circuit_open|consolidated_duplicate_ignored|mutation_budget_exhausted)/.test(action)) return "blocked";
  if (action.includes("_deferred")) return "deferred";
  return undefined;
}

function mergePendingRefreshRefs(
  current: NonNullable<ReconciliationState["pendingRefreshRefs"]> = [],
  incoming: NonNullable<ReconciliationState["pendingRefreshRefs"]> = [],
): NonNullable<ReconciliationState["pendingRefreshRefs"]> {
  const refs = new Map<string, (typeof current)[number]>();
  for (const ref of [...current, ...incoming]) refs.set(`${ref.profile}:${ref.side}:${ref.id}`, ref);
  return [...refs.values()];
}

export function reconciliationRunStatus(run: ReconciliationState): NonNullable<ReconciliationState["status"]> {
  return run.status || (run.lastFailedAt ? "failed" : run.pending ? "queued" : "succeeded");
}

/** A run outcome and the review inbox are separate dimensions. */
export function reconciliationSummary(run: ReconciliationState | undefined, actionableCaseCount: number) {
  return {
    runStatus: run ? reconciliationRunStatus(run) : "not_started",
    runUnresolved: run?.unresolved ?? 0,
    actionableCaseCount,
    inboxClear: actionableCaseCount === 0,
  };
}

function key(pk: string, sk = "STATE"): { pk: string; sk: string } {
  return { pk, sk };
}

function now(): string {
  return new Date().toISOString();
}

function ttl(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

// Reconciliation chunks execute in a Lambda capped at 15 minutes. The margin
// lets a retried delivery resume after an invocation has certainly stopped.
const RECONCILIATION_DELIVERY_LEASE_MS = 16 * 60_000;

function conditionalFailure(error: unknown): boolean {
  return (error as { name?: string }).name === "ConditionalCheckFailedException";
}

function latestOriginalStart(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).reduce<string | undefined>((latest, value) => {
    if (!latest) return value;
    const latestTime = Date.parse(latest);
    const valueTime = Date.parse(value);
    if (Number.isFinite(latestTime) && Number.isFinite(valueTime)) return valueTime > latestTime ? value : latest;
    return value.localeCompare(latest) > 0 ? value : latest;
  }, undefined);
}

/** Admission contention is retryable before any provider processing starts. */
export class CalendarSyncStartContentionError extends Error {
  constructor() {
    super("Calendar sync admission raced repeated notifications; retain the source delivery");
    this.name = "CalendarSyncStartContentionError";
  }
}

export class StateRepository {
  constructor(readonly repairOperationId?: string) {}

  async syncBlocked(profile: Profile, ids: {taskId?: string; eventId?: string}, _beforeProjection = false): Promise<boolean> {
    return new SyncControls().blockedForReconciliation(profile, ids, this.repairOperationId);
  }

  /** Reconciliation ignores historical review decisions and review cases.
   * Explicit exclusions and short-lived repair locks still protect identities. */
  async reconciliationBlocked(profile: Profile, ids: {taskId?: string; eventId?: string}): Promise<boolean> {
    return this.syncBlocked(profile, ids);
  }

  async explicitlyExcluded(profile: Profile, ids: {taskId?: string; eventId?: string}): Promise<boolean> {
    const controls = new SyncControls();
    for (const [side, id] of [["todoist", ids.taskId], ["calendar", ids.eventId]] as const) {
      if (!id) continue;
      const control = await controls.control({ profile, side, id });
      if (control?.excluded === true) return true;
    }
    return false;
  }

  /** A verified two-calendar native split must fence both profiles before
   * either provider is changed. The stage has no TTL while unresolved. */
  async getPhaseBNativeMoveStage(taskId: string): Promise<PhaseBNativeMoveStage | undefined> {
    const result = await client.send(new GetCommand({
      TableName:this.ensureTable(),Key:phaseBNativeMoveStageKey(taskId),ConsistentRead:true,
    }));
    return result.Item?.operationId ? result.Item as PhaseBNativeMoveStage : undefined;
  }

  /** Consistent read of the four immutable stage-owned controls. Recovery
   * must not infer ownership merely from syncBlocked(), which is also true
   * for unrelated repairs and explicit exclusions. */
  async phaseBNativeMoveControlsMatch(stage: PhaseBNativeMoveStage): Promise<boolean> {
    const controls = await Promise.all(phaseBNativeMoveControlKeys(stage).map(Key =>
      client.send(new GetCommand({TableName:this.ensureTable(),Key,ConsistentRead:true}))));
    return controls.every(result => result.Item?.activeRepair === stage.operationId
      && result.Item?.excluded !== true);
  }

  async beginPhaseBNativeMove(input: Pick<PhaseBNativeMoveHandoff,
    "plan"|"sourceMapping"|"sourceLink">): Promise<"claimed"|"resumed"> {
    const stage=phaseBNativeMoveStage(input);
    await Promise.all([
      assertReplayAdmissionIfEnabled({profile:stage.sourceProfile,taskId:stage.taskId,
        eventIds:[stage.sourceMasterId]}),
      assertReplayAdmissionIfEnabled({profile:stage.destinationProfile,taskId:stage.taskId,
        eventIds:[stage.successorMasterId]}),
    ]);
    try {
      await client.send(new TransactWriteCommand({
        TransactItems:phaseBNativeMoveBeginTransaction(this.ensureTable(),input,now()) as never,
      }));
      return "claimed";
    } catch(error) {
      const cancelled=error as {name?:string;CancellationReasons?:Array<{Code?:string}>};
      if(!conditionalFailure(error) && !(cancelled.name==="TransactionCanceledException"
        && cancelled.CancellationReasons?.some(c=>c.Code==="ConditionalCheckFailed")
        && cancelled.CancellationReasons.every(c=>c.Code==="None"||c.Code==="ConditionalCheckFailed")))throw error;
      const existing=await this.getPhaseBNativeMoveStage(stage.taskId);
      if(!existing || Object.entries(stage).some(([k,v])=>
        (existing as unknown as Record<string,unknown>)[k]!==v))
        throw new Error("Phase B move stage differs or another writer owns the task");
      const controls=new SyncControls();
      for(const ref of phaseBNativeMoveControlKeys(stage)) {
        const parts=ref.pk.slice("SYNC_CONTROL#".length).split(":");
        const p=parts[0] as Profile,side=parts[1] as "todoist"|"calendar";
        const id=parts.slice(2).join(":");
        const control=await controls.control({profile:p,side,id});
        if(control?.activeRepair!==stage.operationId)
          throw new Error("Phase B move stage has an incomplete durable write fence");
      }
      return "resumed";
    }
  }

  /** Once provider comments, Calendar masters, and recurrence windows have
   * independently verified the handoff, remove only its transient stage and
   * release the four cross-profile controls atomically. */
  async commitPhaseBNativeMoveIfUnchanged(input: PhaseBNativeMoveHandoff): Promise<boolean> {
    const stage=phaseBNativeMoveStage(input);
    await Promise.all([
      assertReplayAdmissionIfEnabled({profile:stage.sourceProfile,taskId:stage.taskId,
        eventIds:[stage.sourceMasterId]}),
      assertReplayAdmissionIfEnabled({profile:stage.destinationProfile,taskId:stage.taskId,
        eventIds:[stage.successorMasterId]}),
    ]);
    try {
      await client.send(new TransactWriteCommand({
        TransactItems:phaseBNativeMoveCommitTransaction(this.ensureTable(),input,now()) as never,
      }));
      return true;
    } catch(error) {
      const cancelled=error as {name?:string;CancellationReasons?:Array<{Code?:string}>};
      if(conditionalFailure(error) || cancelled.name==="TransactionCanceledException"
        && cancelled.CancellationReasons?.some(c=>c.Code==="ConditionalCheckFailed")
        && cancelled.CancellationReasons.every(c=>c.Code==="None"||c.Code==="ConditionalCheckFailed"))return false;
      throw error;
    }
  }

  async pendingRefreshRefs(refs: Array<{profile:Profile; side:"todoist"|"calendar"; id:string}>) {
    return new SyncControls().pendingRefreshRefs(refs);
  }

  async clearPendingRefresh(refs: Array<{profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string}>): Promise<void> {
    return new SyncControls().clearPendingRefresh(refs);
  }

  private readonly table = tableName;

  private ensureTable(): string {
    if (!this.table) throw new Error("STATE_TABLE_NAME is not configured");
    return this.table;
  }

  async getSyncToken(profile: Profile): Promise<string | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`SYNC#${profile}`) }));
    return typeof result.Item?.token === "string" ? result.Item.token : undefined;
  }

  async putSyncToken(profile: Profile, token: string): Promise<void> {
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: { ...key(`SYNC#${profile}`), token, updatedAt: now() },
    }));
  }

  async deleteSyncToken(profile: Profile): Promise<void> {
    await client.send(new DeleteCommand({ TableName: this.ensureTable(), Key: key(`SYNC#${profile}`) }));
  }

  /** Operational Todoist account cooldown only; this stores no entity mappings. */
  async getTodoistCooldown(accountIdentity: string): Promise<number | undefined> {
    if (!/^[a-f0-9]{64}$/.test(accountIdentity)) throw new Error("Invalid Todoist account identity");
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(), Key: key(`TODOIST_COOLDOWN#${accountIdentity}`), ConsistentRead: true,
    }));
    const until = result.Item?.cooldownUntilMs;
    return typeof until === "number" && Number.isSafeInteger(until) && until > Date.now() ? until : undefined;
  }

  async extendTodoistCooldown(accountIdentity: string, cooldownUntilMs: number): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(accountIdentity) || !Number.isSafeInteger(cooldownUntilMs)
      || cooldownUntilMs <= Date.now()) throw new Error("Invalid Todoist account cooldown");
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(), Key: key(`TODOIST_COOLDOWN#${accountIdentity}`),
        UpdateExpression: "SET cooldownUntilMs = :until, expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(cooldownUntilMs) OR cooldownUntilMs < :until",
        ExpressionAttributeValues: {
          ":until": cooldownUntilMs,
          ":expires": Math.ceil(cooldownUntilMs / 1000) + 86_400,
        },
      }));
    } catch (error) {
      // A longer concurrent cooldown already owns the record. Every other
      // DynamoDB failure must remain visible to the caller.
      if (!conditionalFailure(error)) throw error;
    }
  }

  async getCalendarWatch(profile: Profile): Promise<import("./types.js").CalendarWatchState | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`WATCH#${profile}`), ConsistentRead: true }));
    return result.Item?.status ? result.Item as import("./types.js").CalendarWatchState : undefined;
  }

  async getCalendarWatchByChannel(channelId: string): Promise<import("./types.js").Profile | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`WATCH_CHANNEL#${channelId}`), ConsistentRead: true }));
    return result.Item?.profile as import("./types.js").Profile | undefined;
  }

  async putCalendarWatch(state: import("./types.js").CalendarWatchState): Promise<void> {
    const writes = [
      { Put: { TableName: this.ensureTable(), Item: { ...key(`WATCH#${state.profile}`), ...state, expiresAt: Math.floor(Date.parse(state.expiration) / 1000) } } },
      { Put: { TableName: this.ensureTable(), Item: { ...key(`WATCH_CHANNEL#${state.channelId}`), profile: state.profile, generation: state.generation, expiresAt: Math.floor(Date.parse(state.expiration) / 1000) } } },
    ];
    await client.send(new TransactWriteCommand({ TransactItems: writes as never }));
  }

  async deleteCalendarWatchChannel(channelId: string): Promise<void> {
    await client.send(new DeleteCommand({ TableName: this.ensureTable(), Key: key(`WATCH_CHANNEL#${channelId}`) }));
  }

  async markCalendarWatchNotification(profile: Profile, receivedAt = now(), channelId?: string, messageNumber?: string): Promise<number> {
    const parsedMessageNumber = Number(messageNumber);
    if (channelId && /^\d+$/.test(messageNumber || "") && Number.isSafeInteger(parsedMessageNumber)) {
      try {
        const result = await client.send(new UpdateCommand({
          TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
          UpdateExpression: "SET lastNotificationAt = :receivedAt, calendarSyncGeneration = if_not_exists(calendarSyncGeneration, :zero) + :one, calendarSyncChannel = :channel, calendarSyncMessageNumber = :messageNumber",
          ConditionExpression: "attribute_not_exists(calendarSyncChannel) OR calendarSyncChannel <> :channel OR attribute_not_exists(calendarSyncMessageNumber) OR calendarSyncMessageNumber < :messageNumber",
          ExpressionAttributeValues: { ":receivedAt": receivedAt, ":zero": 0, ":one": 1, ":channel": channelId, ":messageNumber": parsedMessageNumber },
          ReturnValues: "UPDATED_NEW",
        }));
        const generation = Number(result.Attributes?.calendarSyncGeneration);
        if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Calendar notification generation was not persisted");
        return generation;
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
        // A duplicate or out-of-order push is already covered by a later dirty
        // generation. The incremental token remains the source of correctness.
        const current = await this.getCalendarSyncState(profile);
        if (Number.isSafeInteger(current.generation)) return current.generation!;
        throw error;
      }
    }
    const result = await client.send(new UpdateCommand({
      TableName: this.ensureTable(),
      Key: key(`CALSYNC#${profile}`),
      UpdateExpression: "SET lastNotificationAt = :receivedAt, calendarSyncGeneration = if_not_exists(calendarSyncGeneration, :zero) + :one",
      ExpressionAttributeValues: { ":receivedAt": receivedAt, ":zero": 0, ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    }));
    const generation = Number(result.Attributes?.calendarSyncGeneration);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Calendar notification generation was not persisted");
    return generation;
  }

  /** Claim one durable per-profile Calendar SQS admission. Expired claims recover
   * a crash between the DynamoDB claim and SQS send; SQS duplicates are safe. */
  private async getCalendarSyncState(profile: Profile): Promise<{
    generation?: number; state?: "pending" | "dispatching" | "queued" | "running" | "idle" | "failed";
    queuedGeneration?: number; leaseUntil?: number; runningGeneration?: number; completedGeneration?: number;
    failedGeneration?: number;
  }> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`), ConsistentRead: true }));
    return { generation: result.Item?.calendarSyncGeneration, state: result.Item?.calendarSyncState,
      queuedGeneration: result.Item?.calendarSyncQueuedGeneration, leaseUntil: result.Item?.calendarSyncLeaseUntil,
      runningGeneration: result.Item?.calendarSyncRunningGeneration, completedGeneration: result.Item?.calendarSyncCompletedGeneration,
      failedGeneration: result.Item?.calendarSyncFailedGeneration };
  }

  async claimCalendarSyncDispatch(profile: Profile, leaseMs = 30_000): Promise<number | undefined> {
    const watch = await this.getCalendarSyncState(profile);
    const generation = watch.generation || 0;
    if (!generation || watch.state === "running"
      || generation <= (watch.completedGeneration || 0)
      || generation <= (watch.failedGeneration || 0)) return undefined;
    const nowMs = Date.now();
    if (watch.state === "queued" && (watch.leaseUntil || 0) > nowMs) return undefined;
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
        UpdateExpression: "SET calendarSyncState = :dispatching, calendarSyncQueuedGeneration = :generation, calendarSyncLeaseUntil = :lease",
        ConditionExpression: "calendarSyncGeneration = :generation AND (attribute_not_exists(calendarSyncState) OR calendarSyncState = :pending OR calendarSyncState = :idle OR (calendarSyncState = :failed AND calendarSyncFailedGeneration < :generation) OR (calendarSyncState IN (:queued, :dispatching) AND (attribute_not_exists(calendarSyncLeaseUntil) OR calendarSyncLeaseUntil <= :now)))",
        ExpressionAttributeValues: { ":dispatching": "dispatching", ":pending": "pending", ":idle": "idle", ":failed": "failed", ":queued": "queued", ":generation": generation, ":lease": nowMs + leaseMs, ":now": nowMs },
      }));
      return generation;
    } catch (error) { if (conditionalFailure(error)) return undefined; throw error; }
  }

  async markCalendarSyncQueued(profile: Profile, generation: number): Promise<void> {
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
      UpdateExpression: "SET calendarSyncState = :queued, calendarSyncLeaseUntil = :lease",
      ConditionExpression: "calendarSyncState = :dispatching AND calendarSyncQueuedGeneration = :generation",
      ExpressionAttributeValues: { ":queued": "queued", ":dispatching": "dispatching", ":generation": generation, ":lease": Date.now() + 15 * 60_000 },
    }));
  }

  async calendarSyncAlreadyHandled(profile: Profile): Promise<boolean> {
    const state = await this.getCalendarSyncState(profile);
    const generation = state.generation || 0;
    return state.state === "queued" || state.state === "running"
      // A concurrent ingress may observe the dispatcher's short claim before
      // its SQS send is confirmed. The durable generation plus this live lease
      // is enough to acknowledge: the dispatcher recovers an abandoned claim
      // after expiry, and a send failure releases it back to pending.
      || state.state === "dispatching" && (state.leaseUntil || 0) > Date.now()
      || generation > 0 && generation <= (state.completedGeneration || 0)
      || generation > 0 && generation <= (state.failedGeneration || 0);
  }

  /** Lightweight dispatcher recovery. It deliberately checks no provider data
   * and treats generation as pending when no pass has committed it yet. */
  async calendarSyncDispatchDue(profile: Profile, nowMs = Date.now()): Promise<boolean> {
    const state = await this.getCalendarSyncState(profile);
    const generation = state.generation || 0;
    if (!generation || generation <= (state.completedGeneration || 0) || state.state === "running") return false;
    if (state.state === "pending" || state.state === "idle" || !state.state) return true;
    if (state.state === "failed") return generation > (state.failedGeneration || 0);
    return (state.state === "dispatching" || state.state === "queued")
      && (state.leaseUntil || 0) <= nowMs;
  }

  async releaseCalendarSyncDispatch(profile: Profile, generation: number): Promise<void> {
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
        UpdateExpression: "SET calendarSyncState = :pending REMOVE calendarSyncLeaseUntil",
        ConditionExpression: "(calendarSyncState = :dispatching OR calendarSyncState = :queued) AND calendarSyncQueuedGeneration = :generation",
        ExpressionAttributeValues: { ":pending": "pending", ":dispatching": "dispatching", ":queued": "queued", ":generation": generation },
      }));
    } catch (error) { if (!conditionalFailure(error)) throw error; }
  }

  /** Worker snapshots the latest dirty generation. A crash leaves it running;
   * the original FIFO record retries and may safely take the same lease. */
  async startCalendarSync(profile: Profile, queuedGeneration: number): Promise<number | undefined> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const watch = await this.getCalendarSyncState(profile);
      const dirtyGeneration = watch.generation || 0;
      const completedGeneration = Math.max(watch.completedGeneration || 0, watch.failedGeneration || 0);
      const pendingNewerWork = watch.state === "pending" && dirtyGeneration > completedGeneration;
      if (watch.state === "running") {
        // Only the original queued generation may resume its running pass.
        if (watch.queuedGeneration === queuedGeneration && Number.isSafeInteger(watch.runningGeneration))
          return watch.runningGeneration!;
        if (queuedGeneration <= completedGeneration || (watch.queuedGeneration || 0) > queuedGeneration)
          return undefined;
        throw new CalendarSyncStartContentionError();
      }
      if ((watch.state === "queued" || watch.state === "dispatching")
        && (watch.queuedGeneration || 0) > queuedGeneration) return undefined;
      if (queuedGeneration <= completedGeneration && !pendingNewerWork) return undefined;
      if (!dirtyGeneration || dirtyGeneration < queuedGeneration
        || (watch.state !== "queued" && watch.state !== "dispatching" && watch.state !== "idle" && watch.state !== "pending"))
        throw new CalendarSyncStartContentionError();
      try {
        await client.send(new UpdateCommand({
          TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
          UpdateExpression: "SET calendarSyncState = :running, calendarSyncRunningGeneration = :generation, calendarSyncQueuedGeneration = :queuedGeneration REMOVE calendarSyncLeaseUntil",
          ConditionExpression: "calendarSyncGeneration = :current AND (attribute_not_exists(calendarSyncCompletedGeneration) OR calendarSyncCompletedGeneration < :current) AND (attribute_not_exists(calendarSyncFailedGeneration) OR calendarSyncFailedGeneration < :current) AND ((calendarSyncState IN (:queued, :dispatching) AND calendarSyncQueuedGeneration = :queuedGeneration) OR calendarSyncState = :idle OR calendarSyncState = :pending)",
          ExpressionAttributeValues: { ":running": "running", ":idle": "idle", ":pending": "pending", ":queued": "queued", ":dispatching": "dispatching", ":generation": dirtyGeneration, ":queuedGeneration": queuedGeneration, ":current": dirtyGeneration },
        }));
        return dirtyGeneration;
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
        // Ingress can advance the dirty generation between Get and Update.
        // Re-read all admission predicates instead of retrying a stale CAS.
      }
    }
    throw new CalendarSyncStartContentionError();
  }

  /** Complete a pass with a compare-and-swap against the dirty generation. */
  async completeCalendarSync(profile: Profile, processedGeneration: number): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const watch = await this.getCalendarSyncState(profile);
      const current = watch.generation || 0;
      const dirty = current !== processedGeneration;
      try {
        await client.send(new UpdateCommand({
          TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
          UpdateExpression: "SET calendarSyncState = :state, calendarSyncCompletedGeneration = :generation REMOVE calendarSyncLeaseUntil, calendarSyncRunningGeneration, calendarSyncQueuedGeneration",
          ConditionExpression: "calendarSyncState = :running AND calendarSyncRunningGeneration = :generation AND calendarSyncGeneration = :current",
          ExpressionAttributeValues: { ":state": dirty ? "pending" : "idle", ":running": "running", ":generation": processedGeneration, ":current": current },
        }));
        return dirty;
      } catch (error) { if (!conditionalFailure(error)) throw error; }
    }
    throw new Error("Calendar sync completion raced repeated notifications; keep the delivery retryable");
  }

  /** A quarantined pass remains dirty, so a later provider retry can dispatch
   * fresh work from the last committed Calendar token. */
  async failCalendarSync(profile: Profile, expectedGeneration?: number): Promise<void> {
    const state = await this.getCalendarSyncState(profile);
    const runningGeneration = state.runningGeneration;
    if (!Number.isSafeInteger(runningGeneration)
      || (expectedGeneration !== undefined && runningGeneration !== expectedGeneration)) return;
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(), Key: key(`CALSYNC#${profile}`),
        UpdateExpression: "SET calendarSyncState = :failed, calendarSyncFailedGeneration = :generation REMOVE calendarSyncLeaseUntil, calendarSyncRunningGeneration, calendarSyncQueuedGeneration",
        ConditionExpression: "calendarSyncState = :running AND calendarSyncRunningGeneration = :generation",
        ExpressionAttributeValues: { ":failed": "failed", ":running": "running", ":generation": runningGeneration },
      }));
    } catch (error) { if (!conditionalFailure(error)) throw error; }
  }

  /** @deprecated Ingress no longer claims before enqueue. Kept for compatibility/tests. */
  async claimDelivery(id: string): Promise<boolean> {
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(),
        Item: { ...key(`DELIVERY#${id}`), expiresAt: ttl(14), receivedAt: now() },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async isDeliveryCompleted(id: string): Promise<boolean> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`DELIVERY#${id}`, "COMPLETED"),
      ConsistentRead: true,
    }));
    return Boolean(result.Item);
  }

  async markDeliveryCompleted(
    id: string,
    profile: Profile,
    kind: string,
    identityRefs: { taskIds?: string[]; eventIds?: string[]; seriesIds?: string[]; generation?: string } = {},
  ): Promise<void> {
    const completedAt = now();
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: {
        ...key(`DELIVERY#${id}`, "COMPLETED"),
        profile,
        kind,
        identityRefs: {
          taskIds: [...new Set(identityRefs.taskIds || [])].sort(),
          eventIds: [...new Set(identityRefs.eventIds || [])].sort(),
          seriesIds: [...new Set(identityRefs.seriesIds || [])].sort(),
          ...(identityRefs.generation ? { generation: identityRefs.generation } : {}),
        },
        completedAt,
        expiresAt: ttl(14),
      },
    }));
  }

  async getReconciliationState(profile: Profile): Promise<ReconciliationState | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`RECONCILE#${profile}`),
      ConsistentRead: true,
    }));
    if (!result.Item || typeof result.Item.generation !== "string") return undefined;
    return result.Item as ReconciliationState;
  }

  async recordReconciliationDiagnostic(
    profile: Profile, generation: string, sourceDeliveryId: string, action: string,
    detail: Record<string, unknown>, manual?: { caseId?: string; caseStatus?: string },
  ): Promise<void> {
    const outcome = reconciliationDiagnosticOutcome(action);
    if (!outcome || !generation || generation.length > 200) return;
    const text = (value: unknown, max = 10_000): string | undefined =>
      typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined;
    const list = (value: unknown): string[] | undefined => Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 10_000))].slice(0, 100)
      : undefined;
    const safeDetail: Record<string, unknown> = {};
    for (const name of ["calendarStatus", "tombstoneReason", "source", "reason", "taskUpdatedAt", "calendarUpdatedAt", "calendarEtag", "ownerTaskId", "discardedTaskId", "retainedTaskId", "decisionId"]) {
      const value = text(detail[name], 500);
      if (value) safeDetail[name] = value;
    }
    for (const name of ["candidateEventIds", "candidateTaskIds", "mismatchCategories"]) {
      const values = list(detail[name]);
      if (values?.length) safeDetail[name] = values;
    }
    const taskId = text(detail.taskId), eventId = text(detail.eventId), seriesId = text(detail.seriesId);
    const recurrenceOwner = text(detail.recurrenceOwner, 40);
    if (!taskId && !eventId && !seriesId && !list(detail.candidateEventIds)?.length && !list(detail.candidateTaskIds)?.length
      && !action.includes("circuit_open")) return;
    const diagnostic: ReconciliationDiagnostic = {
      profile, generation, sourceDeliveryId, action, outcome,
      reason: text(detail.reason, 500) || action,
      ...(taskId ? { taskId } : {}), ...(eventId ? { eventId } : {}), ...(seriesId ? { seriesId } : {}),
      ...(recurrenceOwner ? { recurrenceOwner } : {}),
      ...(manual?.caseId ? { caseId: manual.caseId } : {}), ...(manual?.caseStatus ? { caseStatus: manual.caseStatus } : {}),
      observedAt: now(), detail: safeDetail,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify({
      action, taskId, eventId, seriesId, recurrenceOwner, detail: safeDetail,
    })).digest("hex");
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(),
        Item: { ...diagnostic, ...key(`RECONCILE_DIAGNOSTIC#${profile}#${generation}`, `ITEM#${fingerprint}`), expiresAt: ttl(90) },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) { if (!conditionalFailure(error)) throw error; }
  }

  async listReconciliationDiagnostics(profile: Profile, generation: string, limit = 50, after?: string) {
    const pk = `RECONCILE_DIAGNOSTIC#${profile}#${generation}`;
    const result = await client.send(new QueryCommand({
      TableName: this.ensureTable(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "ITEM#" },
      Limit: Math.max(1, Math.min(50, Math.floor(limit))),
      ...(after ? { ExclusiveStartKey: key(pk, after) } : {}),
    }));
    return { items: (result.Items || []) as ReconciliationDiagnostic[], next: result.LastEvaluatedKey?.sk as string | undefined };
  }

  async requestReconciliation(
    profile: Profile,
    reason: ReconciliationReason,
    context: { requester?: string; slackChannelId?: string; slackMessageTs?: string; slackThreadTs?: string; slackDecisionId?: string;
      pendingRefreshRefs?: Array<{profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string}> } = {},
  ): Promise<{ state: ReconciliationState; shouldEnqueue: boolean; created: boolean }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getReconciliationState(profile);
      const requestedAt = now();
      const stalledAt = current?.lastProgressAt || current?.lastStartedAt || current?.lastEnqueuedAt;
      const explicitlyRetryable = Boolean(current?.pending && (current.lastFailedAt
        || (stalledAt && Date.now() - Date.parse(stalledAt) >= 15 * 60_000)));
      if (current?.pending && !explicitlyRetryable) {
        const staleOrNeverEnqueued = !current.lastEnqueuedAt;
        const started = Boolean(current.lastStartedAt);
        const refreshRefs = context.pendingRefreshRefs?.length
          ? started
            ? { followUpRefreshRefs: mergePendingRefreshRefs(current.followUpRefreshRefs, context.pendingRefreshRefs) }
            : { pendingRefreshRefs: mergePendingRefreshRefs(current.pendingRefreshRefs, context.pendingRefreshRefs) }
          : {};
        const effectiveReason = reason === "scheduled" && current.reason === "manual" ? "manual" : reason;
        const next: ReconciliationState = {
          ...current,
          reason: effectiveReason,
          lastRequestedAt: requestedAt,
          ...refreshRefs,
          ...((current.requester || context.requester) ? { requester: current.requester || context.requester } : {}),
          ...((current.slackChannelId || context.slackChannelId) ? { slackChannelId: current.slackChannelId || context.slackChannelId } : {}),
          ...((current.slackMessageTs || context.slackMessageTs) ? { slackMessageTs: current.slackMessageTs || context.slackMessageTs } : {}),
          ...((current.slackThreadTs || context.slackThreadTs) ? { slackThreadTs: current.slackThreadTs || context.slackThreadTs } : {}),
          ...((current.slackDecisionId || context.slackDecisionId) ? { slackDecisionId: current.slackDecisionId || context.slackDecisionId } : {}),
        };
        try {
          await client.send(new UpdateCommand({
            TableName: this.ensureTable(),
            Key: key(`RECONCILE#${profile}`),
            UpdateExpression: "SET reason = :reason, lastRequestedAt = :lastRequestedAt, requester = :requester, slackChannelId = :channel, slackMessageTs = :messageTs, slackThreadTs = :thread, slackDecisionId = :decisionId, pendingRefreshRefs = :refreshRefs, followUpRefreshRefs = :followUpRefs, expiresAt = :expiresAt",
            ConditionExpression: "#pending = :true AND generation = :generation",
            ExpressionAttributeNames: { "#pending": "pending" },
            ExpressionAttributeValues: {
              ":true": true,
              ":generation": current.generation,
              ":reason": effectiveReason,
              ":lastRequestedAt": requestedAt,
              ":requester": current.requester || context.requester || (reason === "scheduled" ? "scheduler" : "operator"),
              ":channel": current.slackChannelId || context.slackChannelId || "",
              ":messageTs": current.slackMessageTs || context.slackMessageTs || "",
              ":thread": current.slackThreadTs || context.slackThreadTs || "",
              ":decisionId": current.slackDecisionId || context.slackDecisionId || "",
              ":refreshRefs": next.pendingRefreshRefs || current.pendingRefreshRefs || [],
              ":followUpRefs": next.followUpRefreshRefs || [],
              ":expiresAt": ttl(30),
            },
          }));
          return { state: next, shouldEnqueue: staleOrNeverEnqueued, created: false };
        } catch (error) {
          if (conditionalFailure(error)) continue;
          throw error;
        }
      }

      const generation = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const state: ReconciliationState = {
        profile,
        pending: true,
        generation,
        reason,
        requestedAt,
        lastRequestedAt: requestedAt,
        status: "queued",
        lastProgressAt: requestedAt,
        ...context,
        requester: context.requester || (reason === "scheduled" ? "scheduler" : "operator"),
        ...(() => {
          const refreshRefs = mergePendingRefreshRefs(
            mergePendingRefreshRefs(current?.pendingRefreshRefs, current?.followUpRefreshRefs),
            context.pendingRefreshRefs,
          );
          return refreshRefs.length ? { pendingRefreshRefs: refreshRefs } : {};
        })(),
        ...(current?.lastCompletedAt ? { lastCompletedAt: current.lastCompletedAt } : {}),
      };
      if (current && (current.lastFailedAt || explicitlyRetryable)) {
        try {
          await client.send(new PutCommand({
            TableName: this.ensureTable(),
            Item: { ...current, ...key(`RECONCILE_RUN#${profile}#${current.generation}`), archivedAt: requestedAt, expiresAt: ttl(90) },
            ConditionExpression: "attribute_not_exists(pk)",
          }));
        } catch (error) { if (!conditionalFailure(error)) throw error; }
      }
      // Keep outcomes independent of the latest profile generation, including
      // records written before the durable notification outbox was introduced.
      if (current?.notificationPending) await this.preserveReconciliationOutcome(current);
      const names: Record<string, string> = { "#pending": "pending" };
      const values: Record<string, unknown> = {};
      let condition = "attribute_not_exists(pk)";
      if (current) {
        values[":previousGeneration"] = current.generation;
        values[":previousPending"] = current.pending;
        condition = "generation = :previousGeneration AND #pending = :previousPending";
        // Compare the same timestamp precedence used to determine staleness.
        // A resumed run must invalidate the replacement even for legacy rows.
        for (const attribute of ["lastProgressAt", "lastStartedAt", "lastEnqueuedAt", "lastFailedAt"] as const) {
          if (current[attribute]) {
            values[`:${attribute}`] = current[attribute];
            condition += ` AND ${attribute} = :${attribute}`;
          } else {
            condition += ` AND attribute_not_exists(${attribute})`;
          }
        }
      }
      try {
        await client.send(new PutCommand({
          TableName: this.ensureTable(),
          Item: {
            ...key(`RECONCILE#${profile}`),
            ...state,
            expiresAt: ttl(30),
          },
          ConditionExpression: condition,
          ...(current ? { ExpressionAttributeNames: names, ExpressionAttributeValues: values } : {}),
        }));
        return { state, shouldEnqueue: true, created: true };
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
      }
    }
    throw new Error(`Unable to request reconciliation for ${profile} because state changed repeatedly`);
  }

  async markReconciliationEnqueued(profile: Profile, generation: string, deliveryId?: string,
    nextContinuation?: ReconciliationState["nextContinuation"]): Promise<void> {
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET lastEnqueuedAt = :now, queueState = :accepted, expiresAt = :expiresAt"
          + (deliveryId ? ", lastDeliveryId = :deliveryId" : "")
          + (nextContinuation ? ", nextContinuation = :nextContinuation" : ""),
        ConditionExpression: "#pending = :true AND generation = :generation",
        ExpressionAttributeNames: { "#pending": "pending" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
          ":now": now(),
          ":accepted": "accepted",
          ":expiresAt": ttl(30),
          ...(deliveryId ? { ":deliveryId": deliveryId } : {}),
          ...(nextContinuation ? { ":nextContinuation": nextContinuation } : {}),
        },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async beginReconciliation(profile: Profile, generation: string, deliveryId?: string): Promise<boolean> {
    const current = await this.getReconciliationState(profile);
    if (!current || current.generation !== generation || !current.pending
      || deliveryId && current.lastDeliveryId && current.lastDeliveryId !== deliveryId) return false;
    const startedAt = new Date().toISOString();
    const previousStartedAt = current.lastStartedAt;
    if (deliveryId && current.lastStartedDeliveryId === deliveryId) {
      const previousStartedAtMs = Date.parse(previousStartedAt || "");
      if (!Number.isFinite(previousStartedAtMs)
        || Date.parse(startedAt) - previousStartedAtMs < RECONCILIATION_DELIVERY_LEASE_MS) return false;
    }
    // Compare the observed start timestamp in the write condition. Concurrent
    // duplicate deliveries that both read the same old state cannot both
    // acquire the same chunk lease.
    const leaseCondition = deliveryId
      ? previousStartedAt ? " AND lastStartedAt = :previousStartedAt" : " AND attribute_not_exists(lastStartedAt)"
      : "";
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET lastStartedAt = :now, lastProgressAt = :now, #status = :running, queueState = :running, expiresAt = :expiresAt"
          + (deliveryId ? ", lastStartedDeliveryId = :deliveryId" : "") + " REMOVE lastHealthAlertAt",
        ConditionExpression: "#pending = :true AND generation = :generation AND attribute_not_exists(lastFailedAt)"
          + (deliveryId ? current.lastDeliveryId ? " AND lastDeliveryId = :deliveryId" : " AND attribute_not_exists(lastDeliveryId)" : "")
          + leaseCondition,
        ExpressionAttributeNames: { "#pending": "pending", "#status": "status" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
          ":running": "running",
          ":now": startedAt,
          ...(deliveryId ? { ":deliveryId": deliveryId } : {}),
          ...(deliveryId && previousStartedAt ? { ":previousStartedAt": previousStartedAt } : {}),
          ":expiresAt": ttl(30),
        },
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async addReconciliationProgress(
    profile: Profile, generation: string, counts: Record<string, number>,
    checkpoint?: ReconciliationState["progressCheckpoint"],
  ): Promise<void> {
    // SQS may redeliver a chunk after its checkpoint was committed. Compare
    // checkpoints in delivery order and update the aggregate with a revision
    // token so concurrent redeliveries cannot count the same chunk twice.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.getReconciliationState(profile);
      if (!current || current.generation !== generation || !current.pending) return;
      if (checkpoint && current.progressCheckpoint) {
        const phaseOrder = { mapped: 0, unmapped: 1, calendar: 2 };
        const prior = current.progressCheckpoint;
        const isBehind = (prior.sequence ?? 0) > (checkpoint.sequence ?? 0)
          || (prior.sequence ?? 0) === (checkpoint.sequence ?? 0)
            && phaseOrder[prior.phase || "mapped"] >= phaseOrder[checkpoint.phase || "mapped"];
        if (isBehind) return;
      }
      const aggregate = { ...(current.result || {}) };
      for (const [name, count] of Object.entries(counts)) aggregate[name] = (aggregate[name] || 0) + count;
      const revision = current.progressRevision || 0;
      const writtenAt = now();
      try {
        await client.send(new UpdateCommand({
          TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`),
          UpdateExpression: "SET #result = :result, lastProgressAt = :now, progressRevision = :nextRevision, expiresAt = :expiresAt"
            + (checkpoint ? ", progressCheckpoint = :checkpoint" : "") + " REMOVE lastHealthAlertAt",
          ConditionExpression: "#pending = :true AND generation = :generation AND "
            + (current.progressRevision === undefined ? "attribute_not_exists(progressRevision)" : "progressRevision = :revision"),
          ExpressionAttributeNames: { "#pending": "pending", "#result": "result" },
          ExpressionAttributeValues: { ":result": aggregate, ":now": writtenAt, ":expiresAt": ttl(30), ":true": true, ":generation": generation,
            ":revision": revision, ":nextRevision": revision + 1,
            ...(checkpoint ? { ":checkpoint": { ...checkpoint, observedAt: writtenAt } } : {}) },
        }));
        return;
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
      }
    }
    throw new Error(`Unable to persist reconciliation progress for ${profile}; state changed repeatedly`);
  }

  async preserveReconciliationOutcome(run: ReconciliationState): Promise<void> {
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(),
        Item: { ...run, ...key(`RECONCILE_OUTCOME#${run.profile}`, run.generation), expiresAt: ttl(90) },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) { if (!conditionalFailure(error)) throw error; }
  }

  async getReconciliationOutcome(profile: Profile, generation: string): Promise<ReconciliationState | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(), Key: key(`RECONCILE_OUTCOME#${profile}`, generation), ConsistentRead: true,
    }));
    return result.Item as ReconciliationState | undefined;
  }

  async listPendingReconciliationOutcomes(profile: Profile): Promise<ReconciliationState[]> {
    const runs: ReconciliationState[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await client.send(new QueryCommand({
        TableName: this.ensureTable(), ConsistentRead: true,
        KeyConditionExpression: "pk = :pk", FilterExpression: "notificationPending = :true",
        ExpressionAttributeValues: { ":pk": `RECONCILE_OUTCOME#${profile}`, ":true": true },
        ExclusiveStartKey: cursor,
      }));
      runs.push(...(page.Items || []) as ReconciliationState[]);
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return runs;
  }

  private async saveReconciliationOutcome(
    profile: Profile, generation: string, terminal: Partial<ReconciliationState>,
    update: { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> },
  ): Promise<void> {
    const current = await this.getReconciliationState(profile);
    if (!current?.pending || current.generation !== generation) return;
    const notificationPending = current.reason === "manual";
    const outcome = { ...current, ...terminal, notificationPending };
    if (terminal.status !== "failed") {
      delete outcome.lastFailedAt;
      delete outcome.lastError;
    }
    try {
      // The terminal result and its notification become durable together.
      await client.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`), ...update,
          ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":notificationPending": notificationPending },
          ConditionExpression: "#pending = :true AND generation = :generation",
        } },
        { Put: { TableName: this.ensureTable(), Item: {
          ...outcome, ...key(`RECONCILE_OUTCOME#${profile}`, generation), expiresAt: ttl(90),
        } } },
      ] }));
    } catch (error) {
      const transaction = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (transaction.name === "TransactionCanceledException"
        && transaction.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")) return;
      throw error;
    }
  }

  async completeReconciliation(profile: Profile, generation: string, unresolved = 0, counts: Record<string, number> = {}): Promise<void> {
    const completedAt = now();
    const status = unresolved > 0 ? "needs_review" : "succeeded";
    const notificationText = unresolved > 0 ? `Needs review: ${unresolved} unresolved reconciliation item(s).` : "Succeeded: reconciliation completed.";
    await this.saveReconciliationOutcome(profile, generation, {
      pending: false, status, unresolved, result: counts, lastCompletedAt: completedAt,
      lastProgressAt: completedAt, notificationText,
    }, {
      UpdateExpression: "SET #pending = :false, #status = :status, queueState = :terminal, unresolved = :unresolved, #result = :result, lastCompletedAt = :now, lastProgressAt = :now, notificationPending = :notificationPending, notificationText = :notification, expiresAt = :expiresAt REMOVE lastEnqueuedAt, lastStartedAt, lastFailedAt, lastError",
      ExpressionAttributeNames: { "#pending": "pending", "#status": "status", "#result": "result" },
      ExpressionAttributeValues: {
        ":true": true, ":false": false, ":status": status, ":terminal": "terminal", ":unresolved": unresolved, ":result": counts,
        ":notificationPending": false,
        ":notification": notificationText, ":generation": generation, ":now": completedAt, ":expiresAt": ttl(30),
      },
    });
  }

  async recordReconciliationFailure(profile: Profile, generation: string, message: string,
    failureContext?: ReconciliationState["failureContext"]): Promise<void> {
    const failedAt = now();
    const lastError = message.slice(0, 1000);
    await this.saveReconciliationOutcome(profile, generation, {
      status: "failed", lastFailedAt: failedAt, lastProgressAt: failedAt, lastError, notificationText: lastError,
      ...(failureContext ? { failureContext } : {}),
    }, {
      UpdateExpression: "SET lastFailedAt = :now, lastProgressAt = :now, #status = :failed, queueState = :terminal, lastError = :message, notificationPending = :notificationPending, notificationText = :message, expiresAt = :expiresAt"
        + (failureContext ? ", failureContext = :failureContext" : ""),
      ExpressionAttributeNames: { "#pending": "pending", "#status": "status" },
      ExpressionAttributeValues: {
        ":true": true, ":generation": generation, ":now": failedAt, ":message": lastError, ":failed": "failed", ":terminal": "terminal", ":expiresAt": ttl(30),
        ":notificationPending": false,
        ...(failureContext ? { ":failureContext": failureContext } : {}),
      },
    });
  }

  private async updateReconciliationNotification(
    profile: Profile, generation: string, UpdateExpression: string, values: Record<string, unknown>,
  ): Promise<void> {
    const input = {
      TableName: this.ensureTable(), UpdateExpression,
      ConditionExpression: "generation = :generation",
      ExpressionAttributeValues: { ...values, ":generation": generation },
    };
    await client.send(new UpdateCommand({ ...input, Key: key(`RECONCILE_OUTCOME#${profile}`, generation) }));
    // Keep the latest-run view up to date without depending on it for delivery.
    try {
      await client.send(new UpdateCommand({ ...input, Key: key(`RECONCILE#${profile}`) }));
    } catch (error) {
      if (!conditionalFailure(error)) logEvent("reconciliation_notification_view_update_failed", { profile, generation });
    }
  }

  async markReconciliationNotified(profile: Profile, generation: string, replyTs?: string): Promise<void> {
    await this.updateReconciliationNotification(profile, generation,
      "SET notificationPending = :false, notificationReplyTs = :reply", { ":false": false, ":reply": replyTs || "" });
  }

  async storeReconciliationReply(profile: Profile, generation: string, replyTs: string): Promise<void> {
    await this.updateReconciliationNotification(profile, generation,
      "SET notificationReplyTs = :replyTs", { ":replyTs": replyTs });
  }

  async recordReconciliationNotification(profile: Profile, generation: string, message: string): Promise<void> {
    await this.updateReconciliationNotification(profile, generation,
      "SET notificationPending = :true, notificationText = :message", { ":true": true, ":message": message.slice(0, 1000) });
  }

  async markReconciliationHealthAlert(profile: Profile, generation: string): Promise<void> {
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`),
      UpdateExpression: "SET lastHealthAlertAt = :now",
      ConditionExpression: "generation = :generation",
      ExpressionAttributeValues: { ":now": now(), ":generation": generation },
    }));
  }

  async clearReconciliationHealthAlert(profile: Profile, generation: string): Promise<void> {
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`),
      UpdateExpression: "REMOVE lastHealthAlertAt",
      ConditionExpression: "generation = :generation",
      ExpressionAttributeValues: { ":generation": generation },
    }));
  }

  async getMappingByEvent(profile: Profile, eventId: string): Promise<Mapping | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`EVENT#${profile}#${eventId}`, "MAP"), ConsistentRead: true }));
    return result.Item as Mapping | undefined;
  }

  async getTaskOwnerMapping(taskId: string): Promise<Mapping | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`TASKOWNER#${taskId}`, "MAP"), ConsistentRead: true }));
    return result.Item as Mapping | undefined;
  }

  /** #369: a failed repair's exact task lock is only a recovery candidate,
   * never sufficient permission to reset mappings or erase provider history. */
  async getCancelledAnnualRecoveryLock(profile: Profile, taskId: string): Promise<string | undefined> {
    const item=await client.send(new GetCommand({
      TableName:this.ensureTable(),Key:key(`SYNC_CONTROL#${profile}:todoist:${taskId}`),ConsistentRead:true,
    }));
    return typeof item.Item?.activeRepair==="string" ? item.Item.activeRepair : undefined;
  }

  async getCancelledAnnualRecoveryReceipt(profile: Profile, taskId: string): Promise<{
    profile:Profile; taskId:string; oldEventId:string; operationId:string; sourceUpdatedAt:string;
    sourceDueDate:string; sourcePolicy?:RecoveryPolicy; sourceFingerprint?:string; candidateEventId?:string; status:"pending"; createdAt:string;
  } | undefined> {
    const item=await client.send(new GetCommand({
      TableName:this.ensureTable(),Key:key(`ANNUAL_RECOVERY#${profile}#${taskId}`),ConsistentRead:true,
    }));
    const row=item.Item;
    if(!row)return undefined;
    if(row.profile!==profile || row.taskId!==taskId || row.status!=="pending"
      || typeof row.oldEventId!=="string" || typeof row.sourceUpdatedAt!=="string"
      || typeof row.sourceDueDate!=="string" || typeof row.operationId!=="string"
      || (row.sourcePolicy !== undefined && !["standalone","weekly","monthly","yearly"].includes(row.sourcePolicy))
      || (row.sourceFingerprint !== undefined && (typeof row.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint)))
      || (row.sourceFingerprint !== undefined && row.sourcePolicy === undefined)
      || (row.sourceFingerprint !== undefined && row.candidateEventId !==
        recoveryCounterpartEventId(profile,taskId,row.oldEventId,row.sourceUpdatedAt)))
      throw new Error("Annual Calendar recovery receipt is inconsistent; manual review required");
    return row as {profile:Profile;taskId:string;oldEventId:string;operationId:string;sourceUpdatedAt:string;sourceDueDate:string;sourcePolicy?:RecoveryPolicy;sourceFingerprint?:string;candidateEventId?:string;status:"pending";createdAt:string};
  }

  /** Only clear a pending reset after the new series, its three index views
   * and Todoist-owned recurrence link were durably written. */
  async completeCancelledAnnualRecovery(profile:Profile,taskId:string,newEventId:string):Promise<boolean> {
    const receipt=await this.getCancelledAnnualRecoveryReceipt(profile,taskId);
    if(!receipt)return false;
    if(!newEventId || newEventId===receipt.oldEventId
      || (receipt.candidateEventId && receipt.candidateEventId!==newEventId))
      throw new Error("Cannot acknowledge recovery against an unapproved Calendar event ID");
    const mapping=await this.getMappingByTask(profile,taskId);
    const standalone=receipt.sourcePolicy==="standalone";
    if(!mapping || mapping.eventId!==newEventId || mapping.profile!==profile
      || (standalone
        ? Boolean(mapping.recurrenceOwner || mapping.seriesId || mapping.masterEventId || mapping.activeInstanceId)
        : mapping.recurrenceOwner!=="todoist" || mapping.seriesId!==taskId || mapping.masterEventId!==newEventId))
      return false;
    const table=this.ensureTable();
    const mapCheck=(pk:string,sk:string)=>({ConditionCheck:{
      TableName:table,Key:key(pk,sk),
      ConditionExpression:standalone
        ? "profile = :profile AND taskId = :task AND eventId = :event AND attribute_not_exists(recurrenceOwner) AND attribute_not_exists(seriesId) AND attribute_not_exists(masterEventId)"
        : "profile = :profile AND taskId = :task AND eventId = :event AND recurrenceOwner = :owner AND seriesId = :series",
      ExpressionAttributeValues:standalone
        ? {":profile":profile,":task":taskId,":event":newEventId}
        : {":profile":profile,":task":taskId,":event":newEventId,":owner":"todoist",":series":taskId},
    }});
    try {
      await client.send(new TransactWriteCommand({TransactItems:[
        mapCheck(`TASK#${profile}#${taskId}`,"MAP"),
        mapCheck(`TASKOWNER#${taskId}`,"MAP"),
        mapCheck(`EVENT#${profile}#${newEventId}`,"MAP"),
        {ConditionCheck:{TableName:table,Key:key(`RECURRENCE#${profile}#${taskId}`),
          ConditionExpression:standalone
            ? "attribute_not_exists(pk)"
            : "profile = :profile AND taskId = :task AND masterEventId = :event AND #owner = :owner",
          ...(standalone ? {} : {
            ExpressionAttributeNames:{"#owner":"owner"},
            ExpressionAttributeValues:{":profile":profile,":task":taskId,":event":newEventId,":owner":"todoist"},
          })}},
        {Delete:{TableName:table,Key:key(`ANNUAL_RECOVERY#${profile}#${taskId}`),
          ConditionExpression:"profile = :profile AND taskId = :task AND oldEventId = :old AND sourceUpdatedAt = :version AND #status = :pending"
            + (receipt.candidateEventId ? " AND candidateEventId = :candidate" : ""),
          ExpressionAttributeNames:{"#status":"status"},
          ExpressionAttributeValues:{":profile":profile,":task":taskId,":old":receipt.oldEventId,
            ":version":receipt.sourceUpdatedAt,":pending":"pending",
            ...(receipt.candidateEventId ? {":candidate":receipt.candidateEventId} : {})}}},
      ]}));
      // At this point a single fresh Calendar master and its three mapping
      // views/recurrence link are verified, and the pending reset receipt was
      // conditionally removed. This is the first safe point to acknowledge
      // the *known pre-write* recovery validation alert. Other open cases
      // remain untouched. Alert cleanup failure must not turn the successful
      // provider write into a duplicate-create retry.
      try {
        const resolved=await dismissResolvedPrewriteRecoveryIncidents(profile,taskId,new SyncReviewStore());
        if(resolved) logEvent("annual_recovery_prewrite_dlq_incidents_resolved",
          {profile,taskId,resolved},"state-repository");
      } catch (error) {
        logEvent("annual_recovery_prewrite_dlq_incident_resolution_deferred",
          {profile,taskId,errorType:(error as {name?:string})?.name||"unknown"},"state-repository");
      }
      return true;
    }catch(e){if((e as {name?:string}).name==="TransactionCanceledException")return false;throw e;}
  }

  async getMappingByTask(profile: Profile, taskId: string): Promise<Mapping | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`TASK#${profile}#${taskId}`, "MAP"), ConsistentRead: true }));
    return result.Item as Mapping | undefined;
  }

  async getMappingByTaskAnyProfile(taskId: string): Promise<Mapping | undefined> {
    const owner = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`TASKOWNER#${taskId}`, "MAP"), ConsistentRead: true }));
    if (owner.Item) return owner.Item as Mapping;
    for (const profile of allProfiles) {
      const mapping = await this.getMappingByTask(profile, taskId);
      if (mapping) return mapping;
    }
    return undefined;
  }

  /** Replace approved recurrence indexes with a standalone pair in one conditional transaction. */
  async commitFlattenMapping(input: { operationId:string; mapping:Mapping; previous:Mapping[]; links:RecurrenceLink[] }): Promise<boolean> {
    const {mapping,previous,links,operationId} = input;
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    for (const old of previous) await assertReplayAdmissionIfEnabled(mappingReplayIdentity(old));
    for (const link of links) await assertReplayAdmissionIfEnabled({
      profile:link.profile,taskId:link.taskId,
      eventIds:[...new Set([link.eventId,link.masterEventId].filter((id):id is string=>typeof id==="string"&&id.length>0))],
    });
    if (mapping.recurrenceOwner || mapping.seriesId || mapping.masterEventId || !mapping.updatedAt
      || previous.some(m=>m.profile!==mapping.profile || !m.updatedAt)
      || links.some(l=>l.profile!==mapping.profile || !l.updatedAt)) throw new Error("Flatten mapping identities or versions are incomplete");
    const table = this.ensureTable(), receiptKey = key(`FLATTEN_REPAIR#${operationId}`);
    const receipt = await client.send(new GetCommand({TableName:table,Key:receiptKey,ConsistentRead:true}));
    if (receipt.Item) {
      if (receipt.Item.taskId !== mapping.taskId || receipt.Item.eventId !== mapping.eventId || receipt.Item.profile !== mapping.profile) throw new Error("Flatten operation receipt belongs to another pair");
      const rows = await Promise.all([key(`TASKOWNER#${mapping.taskId}`,"MAP"),key(`TASK#${mapping.profile}#${mapping.taskId}`,"MAP"),key(`EVENT#${mapping.profile}#${mapping.eventId}`,"MAP")].map(Key=>client.send(new GetCommand({TableName:table,Key,ConsistentRead:true}))));
      return rows.every(({Item:m})=>m?.taskId===mapping.taskId && m?.eventId===mapping.eventId && m?.profile===mapping.profile && !m?.recurrenceOwner);
    }
    const rows = new Map<string,{key:Record<string,string>; old?:Mapping; item?:Record<string,unknown>}>();
    const rowKey = (value:Record<string,string>) => JSON.stringify(value);
    for (const old of previous) for (const k of [key(`EVENT#${old.profile}#${old.eventId}`,"MAP"),key(`TASK#${old.profile}#${old.taskId}`,"MAP"),key(`TASKOWNER#${old.taskId}`,"MAP")]) {
      const prior = rows.get(rowKey(k));
      if (prior?.old && (prior.old.taskId!==old.taskId || prior.old.eventId!==old.eventId)) throw new Error("Competing indexes in flatten preview");
      rows.set(rowKey(k),{key:k,old});
    }
    for (const [k,attributes] of [[key(`EVENT#${mapping.profile}#${mapping.eventId}`,"MAP"),mappingEventLookupAttributes(mapping)],
      [key(`TASK#${mapping.profile}#${mapping.taskId}`,"MAP"),mappingLookupAttributes(mapping)],
      [key(`TASKOWNER#${mapping.taskId}`,"MAP"),mappingOwnerLookupAttributes(mapping)]] as const) {
      rows.set(rowKey(k),{...rows.get(rowKey(k)),key:k,item:{...mapping,...k,...attributes}});
    }
    const tx: Array<Record<string,unknown>> = [];
    for (const row of rows.values()) {
      const old = row.old;
      const condition = old ? {ConditionExpression:"#p = :p AND taskId = :t AND eventId = :e AND updatedAt = :v",ExpressionAttributeNames:{"#p":"profile"},ExpressionAttributeValues:{":p":old.profile,":t":old.taskId,":e":old.eventId,":v":old.updatedAt}}
        : {ConditionExpression:"attribute_not_exists(pk)"};
      tx.push(row.item ? {Put:{TableName:table,Item:row.item,...condition}} : {Delete:{TableName:table,Key:row.key,...condition}});
    }
    for (const link of links) tx.push({Delete:{TableName:table,Key:key(`RECURRENCE#${link.profile}#${link.seriesId}`),
      ConditionExpression:"#p = :p AND taskId = :t AND eventId = :e AND updatedAt = :v AND #o = :o",ExpressionAttributeNames:{"#p":"profile","#o":"owner"},
      ExpressionAttributeValues:{":p":link.profile,":t":link.taskId,":e":link.eventId,":v":link.updatedAt,":o":link.owner}}});
    for (const profile of allProfiles) if (profile !== mapping.profile) tx.push({ConditionCheck:{TableName:table,Key:key(`TASK#${profile}#${mapping.taskId}`,"MAP"),ConditionExpression:"attribute_not_exists(pk)"}});
    tx.push({ConditionCheck:{TableName:table,Key:key(`COMPLETED_EVENT#${mapping.profile}#${mapping.eventId}`),ConditionExpression:"attribute_not_exists(pk)"}});
    tx.push({Put:{TableName:table,Item:{...receiptKey,profile:mapping.profile,taskId:mapping.taskId,eventId:mapping.eventId,updatedAt:now()},ConditionExpression:"attribute_not_exists(pk)"}});
    try { await client.send(new TransactWriteCommand({TransactItems:tx as never})); return true; }
    catch(error) {
      const cancelled=error as {name?:string;CancellationReasons?:Array<{Code?:string}>};
      if (conditionalFailure(error) || cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some(reason=>reason.Code==="ConditionalCheckFailed")
        && cancelled.CancellationReasons.every(reason=>reason.Code==="None" || reason.Code==="ConditionalCheckFailed")) return false;
      throw error;
    }
  }

  async putMapping(mapping: Mapping): Promise<void> {
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    const item = { ...mapping, updatedAt: now() };
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) } } },
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"), ...mappingLookupAttributes(mapping) } } },
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`TASKOWNER#${mapping.taskId}`, "MAP"), ...mappingOwnerLookupAttributes(mapping) } } },
      ],
    }));
  }

  async listMappings(profile: Profile): Promise<Mapping[]> {
    return readProfileLookup<Mapping>({
      client, profile, operation: "future_series_mapping_ownership",
      component: "state-repository",
      queryInput: mappingLookupQueryInput(this.ensureTable(), profile),
    });
  }

  /**
   * Historical ownership is not necessarily indexed by the Calendar master:
   * Calendar-owned recurrences put EVENT mappings on individual instances.
   * Refuse if any profile owns the master/instances, an old series link exists,
   * or completed history anywhere refers to that master.
   */
  async assertHistoricalSeriesUnowned(
    masterEventId: string,
    instanceIds: string[],
    allowed?: { mapping?: Mapping; link?: RecurrenceLink },
  ): Promise<void> {
    const ids = new Set([masterEventId, ...instanceIds]);
    if (ids.size > 1000) throw new Error("Too many historical occurrences for guarded ownership inventory");
    for (const profile of allProfiles) {
      const [mappings, links] = await Promise.all([
        this.listMappings(profile), this.listRecurrenceLinks(profile),
      ]);
      if (mappings.some((mapping) => {
        const matches = ids.has(mapping.eventId) || mapping.masterEventId === masterEventId
          || (mapping.activeInstanceId && ids.has(mapping.activeInstanceId));
        return matches && !(allowed?.mapping
          && mapping.profile === allowed.mapping.profile
          && mapping.taskId === allowed.mapping.taskId
          && mapping.eventId === allowed.mapping.eventId
          && mapping.updatedAt === allowed.mapping.updatedAt
          && mapping.recurrenceOwner === allowed.mapping.recurrenceOwner
          && mapping.masterEventId === allowed.mapping.masterEventId);
      })) {
        throw new Error("Another Calendar master/instance mapping still owns historical occurrences");
      }
      if (links.some((link) => {
        const matches = link.masterEventId === masterEventId || ids.has(link.eventId)
          || (link.activeInstanceId && ids.has(link.activeInstanceId));
        return matches && !(allowed?.link
          && link.profile === allowed.link.profile
          && link.seriesId === allowed.link.seriesId
          && link.taskId === allowed.link.taskId
          && link.masterEventId === allowed.link.masterEventId
          && link.updatedAt === allowed.link.updatedAt);
      })) {
        throw new Error("An existing recurrence link owns the old Calendar master/instances");
      }
      for (const id of ids) {
        if (await this.getCompletedCalendarProjectionByEvent(profile, id)) {
          throw new Error("A historical Calendar instance is referenced by completed task history");
        }
      }
    }
    // Detect *other-task* completion records for instance IDs no longer in
    // the finite provider window (including previously deleted exceptions).
    const found = await pacedScan<CompletedCalendarProjection>({
      TableName: this.ensureTable(),
      FilterExpression: "begins_with(pk, :prefix) AND masterEventId = :master",
      ExpressionAttributeValues: {
        ":prefix": "COMPLETED_EVENT#", ":master": masterEventId,
      },
      ProjectionExpression: "pk,taskId,eventId,masterEventId",
    }, { operation: "future_series_historical_completion_preflight" });
    if (found.items.length) {
      throw new Error("Another completed Calendar projection references this historical master");
    }
  }

  /** One global task claim prevents concurrent splits in different profiles. */
  async getFutureSeriesSplitAnyProfile(taskId: string): Promise<
    { profile: Profile; taskId: string; oldMasterId: string; newMasterId: string; previousOccurrence?: string; status: string } | undefined
  > {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`FUTURE_SPLIT#TASK#${taskId}`),
      ConsistentRead: true,
    }));
    const split = result.Item as ({
      profile: Profile; taskId: string; oldMasterId: string; newMasterId: string; previousOccurrence?: string; status: string;
      startedAt?: string; expiresAt?: number;
    } | undefined);
    if (!split || split.status !== "pending") return split;
    const startedAt = Date.parse(split.startedAt || "");
    const leaseExpired = typeof split.expiresAt === "number"
      ? split.expiresAt <= Math.floor(Date.now() / 1000)
      : !Number.isFinite(startedAt)
        || startedAt + FUTURE_SERIES_SPLIT_LEASE_SECONDS * 1000 <= Date.now();
    if (!leaseExpired) return split;
    try {
      await client.send(new DeleteCommand({
        TableName: this.ensureTable(),
        Key: key(`FUTURE_SPLIT#TASK#${taskId}`),
        ConditionExpression: split.startedAt
          ? "#status = :pending AND startedAt = :startedAt"
          : "#status = :pending AND attribute_not_exists(startedAt)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: split.startedAt
          ? { ":pending": "pending", ":startedAt": split.startedAt }
          : { ":pending": "pending" },
      }));
      await this.audit(split.profile, "future_series_split_inflight_lease_expired", {
        taskId, oldMasterId: split.oldMasterId, newMasterId: split.newMasterId,
      });
      return undefined;
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const latest = await client.send(new GetCommand({
        TableName: this.ensureTable(), Key: key(`FUTURE_SPLIT#TASK#${taskId}`), ConsistentRead: true,
      }));
      return latest.Item as typeof split;
    }
  }

  async beginFutureSeriesSplit(profile: Profile, taskId: string, oldMasterId: string, newMasterId: string, previousOccurrence?: string): Promise<void> {
    await assertReplayAdmissionIfEnabled({profile,taskId,eventIds:[
      ...new Set([oldMasterId,newMasterId,previousOccurrence].filter((id):id is string=>typeof id==="string"&&id.length>0)),
    ]});
    const previous = await this.getFutureSeriesSplitAnyProfile(taskId);
    if (previous) {
      if (previous.profile !== profile || previous.taskId !== taskId
        || previous.oldMasterId !== oldMasterId || previous.newMasterId !== newMasterId
        || previous.previousOccurrence !== previousOccurrence) {
        throw new Error("Another pending/completed recurrence split owns this Todoist task");
      }
      return;
    }
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(),
        Item: {
          ...key(`FUTURE_SPLIT#TASK#${taskId}`),
          profile, taskId, oldMasterId, newMasterId,
          ...(previousOccurrence ? { previousOccurrence } : {}),
          status: "pending", startedAt: now(),
          expiresAt: Math.floor(Date.now() / 1000) + FUTURE_SERIES_SPLIT_LEASE_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const raced = await this.getFutureSeriesSplitAnyProfile(taskId);
      if (!raced || raced.profile !== profile || raced.oldMasterId !== oldMasterId
        || raced.newMasterId !== newMasterId || raced.previousOccurrence !== previousOccurrence) throw error;
    }
  }

  async completeFutureSeriesSplit(profile: Profile, taskId: string, newMasterId: string): Promise<void> {
    const split = await this.getFutureSeriesSplitAnyProfile(taskId);
    await assertReplayAdmissionIfEnabled({profile,taskId,eventIds:[
      ...new Set([split?.oldMasterId,newMasterId].filter((id):id is string=>typeof id==="string"&&id.length>0)),
    ]});
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(),
      Key: key(`FUTURE_SPLIT#TASK#${taskId}`),
      UpdateExpression: "SET #status = :done, completedAt = :now, expiresAt = :expire",
      ConditionExpression: "profile = :profile AND newMasterId = :newMaster AND taskId = :task AND #status IN (:pending, :done)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":done": "completed", ":pending": "pending", ":profile": profile, ":now": now(),
        ":expire": ttl(90), ":newMaster": newMasterId, ":task": taskId,
      },
    }));
  }

  /**
   * Install a NEW Todoist-owned recurrence mapping, all three identity indexes
   * and the recurrence link atomically. No unconditional reassignment or
   * resurrection of archived / completed projections is permitted.
   */
  async putNewRecurrenceMappingIfUnowned(mapping: Mapping, link: RecurrenceLink): Promise<boolean> {
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    await assertReplayAdmissionIfEnabled({profile:link.profile,taskId:link.taskId,
      eventIds:[...new Set([link.eventId,link.masterEventId].filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    if (mapping.recurrenceOwner !== "todoist" || mapping.seriesId !== mapping.taskId
      || mapping.masterEventId !== mapping.eventId || link.owner !== "todoist"
      || link.seriesId !== mapping.seriesId || link.masterEventId !== mapping.masterEventId
      || link.taskId !== mapping.taskId || link.eventId !== mapping.eventId
      || link.profile !== mapping.profile) {
      throw new Error("Future-series mapping and recurrence ownership are inconsistent");
    }
    const table = this.ensureTable();
    const tx: Array<Record<string, unknown>> = [
      { ConditionCheck: {
        TableName: table,
        Key: key(`FUTURE_SPLIT#TASK#${mapping.taskId}`),
        ConditionExpression: "#status = :pending AND profile = :profile AND newMasterId = :master",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pending": "pending", ":profile": mapping.profile, ":master": mapping.eventId,
        },
      } },
      { ConditionCheck: {
        TableName: table,
        Key: key(`COMPLETED_EVENT#${mapping.profile}#${mapping.eventId}`),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ];
    for (const other of allProfiles) {
      if (other === mapping.profile) continue;
      tx.push({ ConditionCheck: {
        TableName: table,
        Key: key(`TASK#${other}#${mapping.taskId}`, "MAP"),
        ConditionExpression: "attribute_not_exists(pk)",
      } });
    }
    const inserts = [
      { ...mapping, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) },
      { ...mapping, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"), ...mappingLookupAttributes(mapping) },
      { ...mapping, ...key(`TASKOWNER#${mapping.taskId}`, "MAP"), ...mappingOwnerLookupAttributes(mapping) },
      { ...link, ...key(`RECURRENCE#${mapping.profile}#${link.seriesId}`, "STATE"), ...recurrenceLookupAttributes(link) },
    ];
    for (const item of inserts) tx.push({ Put: {
      TableName: table, Item: item, ConditionExpression: "attribute_not_exists(pk)",
    } });
    try {
      await client.send(new TransactWriteCommand({ TransactItems: tx as never }));
      return true;
    } catch (error) {
      const reason = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (reason.name === "TransactionCanceledException"
        && reason.CancellationReasons?.some((item) => item.Code === "ConditionalCheckFailed")
        && reason.CancellationReasons.every((item) => item.Code === "ConditionalCheckFailed" || item.Code === "None")) {
        return false;
      }
      throw error;
    }
  }

  async getConsolidatedTask(profile: Profile, taskId: string): Promise<{
    retainedTaskId: string; decisionId: string; cancelledEventId?: string; previousMapping?: Mapping;
  } | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(), Key: key(`CONSOLIDATED_TASK#${profile}#${taskId}`), ConsistentRead: true,
    }));
    if (typeof result.Item?.retainedTaskId !== "string" || typeof result.Item?.decisionId !== "string") return undefined;
    return {
      retainedTaskId: result.Item.retainedTaskId,
      decisionId: result.Item.decisionId,
      ...(typeof result.Item.cancelledEventId === "string" ? { cancelledEventId: result.Item.cancelledEventId } : {}),
      ...(result.Item.previousMapping && typeof result.Item.previousMapping === "object"
        ? { previousMapping: result.Item.previousMapping as Mapping } : {}),
    };
  }

  /** Durable webhook guard written before the first Calendar mutation. */
  async putConsolidationGuard(
    profile: Profile, discardedTaskId: string, retainedTaskId: string, decisionId: string,
    cancelledEventId?: string, previousMapping?: Mapping,
  ): Promise<void> {
    await assertReplayAdmissionIfEnabled({profile,taskId:discardedTaskId,
      ...(cancelledEventId?{eventIds:[cancelledEventId]}:{})});
    await assertReplayAdmissionIfEnabled({profile,taskId:retainedTaskId});
    if(previousMapping)await assertReplayAdmissionIfEnabled(mappingReplayIdentity(previousMapping));
    const item = {
      ...key(`CONSOLIDATED_TASK#${profile}#${discardedTaskId}`),
      profile, discardedTaskId, retainedTaskId, decisionId, status: "pending", updatedAt: now(),
      ...(cancelledEventId ? { cancelledEventId } : {}),
      ...(previousMapping ? { previousMapping } : {}),
    };
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(), Item: item,
        ConditionExpression: "attribute_not_exists(pk) OR (retainedTaskId = :retained AND decisionId = :decision)",
        ExpressionAttributeValues: { ":retained": retainedTaskId, ":decision": decisionId },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      throw new Error("The duplicate task is already reserved by a different consolidation");
    }
  }

  /**
   * Atomically replace a Calendar-owned mirror mapping with the approved
   * Todoist-owned recurrence mapping. The duplicate webhook guard, canceled
   * projection tombstone removal, and all mapping indexes change together.
   */
  async commitRecurrenceConsolidation(input: {
    mapping: Mapping;
    link: RecurrenceLink;
    previousMapping: Mapping;
    previousLink: RecurrenceLink;
    discardedTaskId: string;
    decisionId: string;
    cancelledEventId?: string;
  }): Promise<boolean> {
    const { mapping, link, previousMapping, previousLink, discardedTaskId, decisionId } = input;
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(previousMapping));
    await assertReplayAdmissionIfEnabled({profile:mapping.profile,taskId:discardedTaskId,
      ...(input.cancelledEventId?{eventIds:[input.cancelledEventId]}:{})});
    if (mapping.recurrenceOwner !== "todoist" || mapping.taskId === discardedTaskId
      || mapping.seriesId !== mapping.taskId || link.owner !== "todoist"
      || link.seriesId !== mapping.seriesId || link.taskId !== mapping.taskId
      || link.eventId !== mapping.eventId || link.masterEventId !== mapping.masterEventId
      || previousMapping.taskId !== discardedTaskId || previousMapping.recurrenceOwner !== "calendar"
      || previousLink.taskId !== discardedTaskId || previousLink.owner !== "calendar"
      || previousLink.seriesId !== previousMapping.seriesId) {
      throw new Error("Recurrence consolidation identities are inconsistent");
    }
    const table = this.ensureTable();
    const previousValues = {
      ":profile": previousMapping.profile,
      ":task": previousMapping.taskId,
      ":event": previousMapping.eventId,
      ":updated": previousMapping.updatedAt,
      ":owner": "calendar",
      ":master": previousMapping.masterEventId,
      ":series": previousMapping.seriesId,
    };
    const samePrevious = "#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND recurrenceOwner = :owner AND masterEventId = :master AND seriesId = :series";
    const tx: Array<Record<string, unknown>> = [
      { Delete: { TableName: table, Key: key(`EVENT#${previousMapping.profile}#${previousMapping.eventId}`, "MAP"), ConditionExpression: samePrevious, ExpressionAttributeNames: { "#profile": "profile" }, ExpressionAttributeValues: previousValues } },
      { Delete: { TableName: table, Key: key(`TASK#${previousMapping.profile}#${discardedTaskId}`, "MAP"), ConditionExpression: samePrevious, ExpressionAttributeNames: { "#profile": "profile" }, ExpressionAttributeValues: previousValues } },
      { Delete: { TableName: table, Key: key(`TASKOWNER#${discardedTaskId}`, "MAP"), ConditionExpression: samePrevious, ExpressionAttributeNames: { "#profile": "profile" }, ExpressionAttributeValues: previousValues } },
      { Delete: { TableName: table, Key: key(`RECURRENCE#${previousLink.profile}#${previousLink.seriesId}`), ConditionExpression: "profile = :profile AND taskId = :task AND eventId = :event AND #owner = :owner AND updatedAt = :updated", ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":profile": previousLink.profile, ":task": previousLink.taskId, ":event": previousLink.eventId, ":owner": "calendar", ":updated": previousLink.updatedAt } } },
      { Put: { TableName: table, Item: { ...mapping, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: table, Item: { ...mapping, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"), ...mappingLookupAttributes(mapping) }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: table, Item: { ...mapping, ...key(`TASKOWNER#${mapping.taskId}`, "MAP"), ...mappingOwnerLookupAttributes(mapping) }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: table, Item: { ...link, ...key(`RECURRENCE#${link.profile}#${link.seriesId}`), ...recurrenceLookupAttributes(link) }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: table, Item: {
        ...key(`CONSOLIDATED_TASK#${mapping.profile}#${discardedTaskId}`),
        profile: mapping.profile, discardedTaskId, retainedTaskId: mapping.taskId, decisionId,
        status: "pending", updatedAt: now(), previousMapping,
        ...(input.cancelledEventId ? { cancelledEventId: input.cancelledEventId } : {}),
      }, ConditionExpression: "attribute_not_exists(pk) OR (retainedTaskId = :retained AND decisionId = :decision)", ExpressionAttributeValues: { ":retained": mapping.taskId, ":decision": decisionId } } },
    ];
    const split = await this.getFutureSeriesSplitAnyProfile(mapping.taskId);
    if (!split || split.profile !== mapping.profile || split.status !== "pending" || split.newMasterId !== mapping.eventId) {
      const completed = await this.getMappingByTask(mapping.profile, mapping.taskId);
      const alias = await this.getConsolidatedTask(mapping.profile, discardedTaskId);
      if (completed?.eventId === mapping.eventId && completed.seriesId === completed.taskId
        && alias?.retainedTaskId === mapping.taskId && alias.decisionId === decisionId) return true;
      throw new Error("The approved future-series operation is not pending");
    }
    tx.push({ ConditionCheck: {
      TableName: table, Key: key(`FUTURE_SPLIT#TASK#${mapping.taskId}`),
      ConditionExpression: "#status = :pending AND profile = :profile AND newMasterId = :master",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":profile": mapping.profile, ":master": mapping.eventId },
    } });
    try {
      await client.send(new TransactWriteCommand({ TransactItems: tx as never }));
      return true;
    } catch (error) {
      const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")
        && cancelled.CancellationReasons.every((reason) => reason.Code === "None" || reason.Code === "ConditionalCheckFailed")) return false;
      throw error;
    }
  }

  private async deleteProfileMappingIndexes(mapping: Mapping): Promise<void> {
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.ensureTable(),
              Key: key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"),
              ConditionExpression: "taskId = :taskId",
              ExpressionAttributeValues: { ":taskId": mapping.taskId },
            },
          },
          {
            Delete: {
              TableName: this.ensureTable(),
              Key: key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"),
              ConditionExpression: "eventId = :eventId",
              ExpressionAttributeValues: { ":eventId": mapping.eventId },
            },
          },
        ],
      }));
    } catch (error) {
      // A newer mapping may have replaced either stale index between owner
      // inspection and cleanup. Conditional cancellation means there is
      // nothing safe to delete; leave the newer index untouched.
      if ((error as { name?: string }).name === "TransactionCanceledException") return;
      throw error;
    }
  }


  /**
   * An earlier cancelled Calendar instance is not the series's live mirror.
   * Purge ONLY that instance's EVENT/canonical rows, plus historical task
   * indexes if they still refer to a distinct, discarded task. The active
   * recurrence link and all three active mapping indexes are CAS-guarded and
   * are never written by this transaction.
   */
  async purgeEarlierCancelledCalendarOccurrence(
    link: RecurrenceLink,
    occurrenceId: string,
    staleMapping?: Mapping,
  ): Promise<boolean> {
    await assertReplayAdmissionIfEnabled({profile:link.profile,taskId:link.taskId,
      eventIds:[...new Set([occurrenceId,link.eventId,link.masterEventId,link.activeInstanceId]
        .filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    if (link.owner !== "calendar" || !link.masterEventId || !link.activeInstanceId
      || occurrenceId === link.activeInstanceId || occurrenceId === link.masterEventId
      || (staleMapping && (staleMapping.profile !== link.profile
        || staleMapping.eventId !== occurrenceId || staleMapping.recurrenceOwner !== "calendar"
        || staleMapping.seriesId !== link.seriesId || staleMapping.masterEventId !== link.masterEventId))) {
      throw new Error("Earlier Calendar occurrence cleanup requires a distinct, same-series inactive event");
    }
    const table = this.ensureTable();
    const canonicalKey = key(`CANONICAL#${link.profile}#calendar#${occurrenceId}`);
    const canonical = await client.send(new GetCommand({
      TableName: table, Key: canonicalKey, ConsistentRead: true,
    }));
    if (!staleMapping && !canonical.Item) return false;
    // Canonical identities are independently rewritten by reconciliation.
    // Never remove a row whose identity or write version has changed since
    // this strongly consistent read, even if the EVENT mapping is still old.
    const canonicalSnapshot = canonical.Item;
    if (canonicalSnapshot && (canonicalSnapshot.profile !== link.profile
      || canonicalSnapshot.side !== "calendar" || canonicalSnapshot.providerId !== occurrenceId
      || typeof canonicalSnapshot.updatedAt !== "string" || !canonicalSnapshot.updatedAt
      || !canonicalSnapshot.identity || typeof canonicalSnapshot.identity !== "object")) {
      return false;
    }

    const baseValues = {
      ":owner": "calendar",
      ":series": link.seriesId,
      ":master": link.masterEventId,
      ":active": link.activeInstanceId,
      ":task": link.taskId,
    };
    const activeGuard = "eventId = :active AND taskId = :task AND recurrenceOwner = :owner AND seriesId = :series AND masterEventId = :master";
    const items: Record<string, unknown>[] = [
      { ConditionCheck: {
        TableName: table, Key: key(`RECURRENCE#${link.profile}#${link.seriesId}`),
        ConditionExpression: "#owner = :owner AND masterEventId = :master AND activeInstanceId = :active AND eventId = :active AND taskId = :task",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": "calendar", ":master": link.masterEventId, ":active": link.activeInstanceId, ":task": link.taskId },
      } },
      { ConditionCheck: {
        TableName: table, Key: key(`EVENT#${link.profile}#${link.activeInstanceId}`, "MAP"),
        ConditionExpression: activeGuard, ExpressionAttributeValues: baseValues,
      } },
      { ConditionCheck: {
        TableName: table, Key: key(`TASK#${link.profile}#${link.taskId}`, "MAP"),
        ConditionExpression: activeGuard, ExpressionAttributeValues: baseValues,
      } },
      { ConditionCheck: {
        TableName: table, Key: key(`TASKOWNER#${link.taskId}`, "MAP"),
        ConditionExpression: `#profile = :profile AND ${activeGuard}`,
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: { ...baseValues, ":profile": link.profile },
      } },
      { Delete: {
        TableName: table, Key: key(`EVENT#${link.profile}#${occurrenceId}`, "MAP"),
        ConditionExpression: staleMapping
          ? "taskId = :oldTask AND recurrenceOwner = :owner AND seriesId = :series AND masterEventId = :master AND updatedAt = :oldUpdated"
          : "attribute_not_exists(pk)",
        ExpressionAttributeValues: staleMapping
          ? { ":oldTask": staleMapping.taskId, ":owner": "calendar", ":series": link.seriesId, ":master": link.masterEventId, ":oldUpdated": staleMapping.updatedAt }
          : undefined,
      } },
      { Delete: {
        TableName: table, Key: canonicalKey,
        ConditionExpression: canonicalSnapshot
          ? "#profile = :canonicalProfile AND #side = :canonicalSide AND providerId = :canonicalProvider AND updatedAt = :canonicalUpdated AND #identity = :canonicalIdentity"
          : "attribute_not_exists(pk)",
        ExpressionAttributeNames: canonicalSnapshot
          ? { "#profile": "profile", "#side": "side", "#identity": "identity" }
          : undefined,
        ExpressionAttributeValues: canonicalSnapshot
          ? { ":canonicalProfile": link.profile, ":canonicalSide": "calendar",
            ":canonicalProvider": occurrenceId, ":canonicalUpdated": canonicalSnapshot.updatedAt,
            ":canonicalIdentity": canonicalSnapshot.identity }
          : undefined,
      } },
    ];
    if (staleMapping && staleMapping.taskId !== link.taskId) {
      for (const index of [
        key(`TASK#${link.profile}#${staleMapping.taskId}`, "MAP"),
        key(`TASKOWNER#${staleMapping.taskId}`, "MAP"),
      ]) {
        items.push({ Delete: {
          TableName: table, Key: index,
          ConditionExpression: "attribute_not_exists(pk) OR (#profile = :profile AND eventId = :oldEvent AND taskId = :oldTask)",
          ExpressionAttributeNames: { "#profile": "profile" },
          ExpressionAttributeValues: { ":profile": link.profile, ":oldEvent": occurrenceId, ":oldTask": staleMapping.taskId },
        } });
      }
    }
    try {
      await client.send(new TransactWriteCommand({ TransactItems: items as never }));
      return true;
    } catch (error) {
      // Ownership or index changes require another read; never erase newer
      // mappings on the strength of a delayed Google notification.
      const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")
        && cancelled.CancellationReasons.every((reason) => reason.Code === "None" || reason.Code === "ConditionalCheckFailed")) {
        return false;
      }
      throw error;
    }
  }

  async deleteMapping(mapping: Mapping): Promise<void> {
    const owner = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`TASKOWNER#${mapping.taskId}`, "MAP"),
      ConsistentRead: true,
    }));

    if (owner.Item?.profile !== mapping.profile || owner.Item?.eventId !== mapping.eventId) {
      await this.deleteProfileMappingIndexes(mapping);
      return;
    }

    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.ensureTable(), Key: key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP") } },
          { Delete: { TableName: this.ensureTable(), Key: key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP") } },
          {
            Delete: {
              TableName: this.ensureTable(),
              Key: key(`TASKOWNER#${mapping.taskId}`, "MAP"),
              ConditionExpression: "#profile = :profile AND eventId = :eventId",
              ExpressionAttributeNames: { "#profile": "profile" },
              ExpressionAttributeValues: { ":profile": mapping.profile, ":eventId": mapping.eventId },
            },
          },
        ],
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== "TransactionCanceledException") throw error;

      const currentOwner = await client.send(new GetCommand({
        TableName: this.ensureTable(),
        Key: key(`TASKOWNER#${mapping.taskId}`, "MAP"),
        ConsistentRead: true,
      }));
      if (currentOwner.Item?.profile !== mapping.profile || currentOwner.Item?.eventId !== mapping.eventId) {
        await this.deleteProfileMappingIndexes(mapping);
        return;
      }
      throw error;
    }
  }

  /**
   * Retire a Todoist-owned recurring projection only after its task and every
   * currently referenced Calendar resource have been verified absent by the
   * reconciliation worker. Provider verification happens before this call.
   *
   * The four index deletes are one transaction: a racing new series owner,
   * active repair, or a completed-history guard prevents partial retirement.
   */
  async retireDeletedTodoistRecurrenceIfUnchanged(mapping: Mapping, expectedLink: RecurrenceLink): Promise<boolean> {
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    await assertReplayAdmissionIfEnabled({profile:expectedLink.profile,taskId:expectedLink.taskId,
      eventIds:[...new Set([expectedLink.eventId,expectedLink.masterEventId,expectedLink.activeInstanceId]
        .filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    if (mapping.recurrenceOwner !== "todoist" || !mapping.seriesId || !mapping.updatedAt
      || expectedLink.owner !== "todoist" || !expectedLink.updatedAt
      || expectedLink.profile !== mapping.profile || expectedLink.seriesId !== mapping.seriesId
      || expectedLink.taskId !== mapping.taskId || expectedLink.eventId !== mapping.eventId
      || expectedLink.masterEventId !== mapping.masterEventId
      || expectedLink.activeInstanceId !== mapping.activeInstanceId) return false;
    const table = this.ensureTable();
    const values: Record<string, unknown> = {
      ":profile": mapping.profile, ":task": mapping.taskId, ":event": mapping.eventId,
      ":updated": mapping.updatedAt, ":owner": "todoist", ":series": mapping.seriesId,
    };
    const optional = (row: Mapping | RecurrenceLink, field: string, values: Record<string, unknown>): string => {
      const value = (row as unknown as Record<string, unknown>)[field];
      if (value === undefined || value === null) return `attribute_not_exists(${field})`;
      const placeholder = `:${field}`;
      values[placeholder] = value;
      return `${field} = ${placeholder}`;
    };
    const mappingFields = ["recurrenceId", "masterEventId", "activeInstanceId",
      "originalStart", "activeEffectiveStart"];
    const mapCondition = "#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND recurrenceOwner = :owner AND seriesId = :series AND "
      + mappingFields.map(field => optional(mapping, field, values)).join(" AND ");
    const linkValues: Record<string, unknown> = {
      ":profile": mapping.profile, ":task": mapping.taskId, ":event": mapping.eventId,
      ":updated": expectedLink.updatedAt, ":owner": "todoist", ":series": mapping.seriesId,
    };
    const linkCondition = "#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND #owner = :owner AND seriesId = :series AND "
      + ["masterEventId", "activeInstanceId", "originalStart", "activeEffectiveStart"]
        .map(field => optional(expectedLink, field, linkValues)).join(" AND ");
    const mappingKeys = [
      key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"),
      key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"),
      key(`TASKOWNER#${mapping.taskId}`, "MAP"),
    ];
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        ...mappingKeys.map(Key => ({ Delete: {
          TableName: table, Key, ConditionExpression: mapCondition,
          ExpressionAttributeNames: { "#profile": "profile" },
          ExpressionAttributeValues: values,
        } })),
        { Delete: { TableName: table, Key: key(`RECURRENCE#${mapping.profile}#${mapping.seriesId}`),
          ConditionExpression: linkCondition, ExpressionAttributeNames: { "#profile": "profile", "#owner": "owner" },
          ExpressionAttributeValues: linkValues } },
        ...[
          `SYNC_CONTROL#${mapping.profile}:todoist:${mapping.taskId}`,
          ...[...new Set([mapping.eventId, mapping.masterEventId, mapping.activeInstanceId].filter((id): id is string => Boolean(id)))]
            .map(id => `SYNC_CONTROL#${mapping.profile}:calendar:${id}`),
        ].map(controlKey => ({ ConditionCheck: {
          TableName: table, Key: key(controlKey),
          ConditionExpression: "attribute_not_exists(activeRepair) AND (attribute_not_exists(excluded) OR excluded = :no)",
          ExpressionAttributeValues: { ":no": false },
        } })),
        ...[...new Set([mapping.eventId, mapping.masterEventId, mapping.activeInstanceId].filter((id): id is string => Boolean(id)))]
          .map(eventId => ({ ConditionCheck: { TableName: table, Key: key(`COMPLETED_EVENT#${mapping.profile}#${eventId}`),
            ConditionExpression: "attribute_not_exists(pk)" } })),
      ] }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name !== "TransactionCanceledException") throw error;
      return false;
    }
  }

  /** Delete an exact standalone mapping only when every primary index still has its previewed version. */
  async deleteMappingIfUnchanged(mapping: Mapping): Promise<boolean> {
    if (!mapping.updatedAt || mapping.recurrenceOwner || mapping.recurrenceId || mapping.seriesId || mapping.masterEventId || mapping.activeInstanceId) return false;
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    const table=this.ensureTable();
    const conditions=(taskOwner=false)=>({
      ConditionExpression: taskOwner
        ? "#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND attribute_not_exists(recurrenceOwner) AND attribute_not_exists(recurrenceId) AND attribute_not_exists(seriesId) AND attribute_not_exists(masterEventId) AND attribute_not_exists(activeInstanceId)"
        : "profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND attribute_not_exists(recurrenceOwner) AND attribute_not_exists(recurrenceId) AND attribute_not_exists(seriesId) AND attribute_not_exists(masterEventId) AND attribute_not_exists(activeInstanceId)",
      ...(taskOwner?{ExpressionAttributeNames:{"#profile":"profile"}}:{}),
      ExpressionAttributeValues:{":profile":mapping.profile,":task":mapping.taskId,":event":mapping.eventId,":updated":mapping.updatedAt},
    });
    try {
      await client.send(new TransactWriteCommand({TransactItems:[
        {Delete:{TableName:table,Key:key(`EVENT#${mapping.profile}#${mapping.eventId}`,"MAP"),...conditions()}},
        {Delete:{TableName:table,Key:key(`TASK#${mapping.profile}#${mapping.taskId}`,"MAP"),...conditions()}},
        {Delete:{TableName:table,Key:key(`TASKOWNER#${mapping.taskId}`,"MAP"),...conditions(true)}},
      ] as never}));
      return true;
    } catch(error) {
      if((error as {name?:string}).name!=="TransactionCanceledException") throw error;
      const [event,task,owner]=await Promise.all([
        client.send(new GetCommand({TableName:table,Key:key(`EVENT#${mapping.profile}#${mapping.eventId}`,"MAP"),ConsistentRead:true})),
        client.send(new GetCommand({TableName:table,Key:key(`TASK#${mapping.profile}#${mapping.taskId}`,"MAP"),ConsistentRead:true})),
        client.send(new GetCommand({TableName:table,Key:key(`TASKOWNER#${mapping.taskId}`,"MAP"),ConsistentRead:true})),
      ]);
      if(!event.Item&&!task.Item&&!owner.Item) return true;
      return false;
    }
  }

  /**
   * Remove only an elapsed Calendar event's EVENT row. The task-side indexes
   * are removed only when they still point to that exact event; if they point
   * to the approved current/future counterpart, conditional checks retain them.
   */
  async commitElapsedCalendarHistoryDetach(input:{
    operationId:string; profile:Profile; eventId:string; taskId:string; eventMapping?:Mapping; taskMapping?:Mapping; retainedEventMappings?:Mapping[];
  }):Promise<boolean> {
    const {operationId,profile,eventId,taskId,eventMapping,taskMapping,retainedEventMappings=[]}=input;
    await assertReplayAdmissionIfEnabled({profile,taskId,eventIds:[...new Set([
      eventId,eventMapping?.eventId,taskMapping?.eventId,
      ...retainedEventMappings.map(mapping=>mapping.eventId),
      ...[eventMapping,taskMapping,...retainedEventMappings].flatMap(mapping=>mapping
        ?[mapping.masterEventId,mapping.activeInstanceId]:[]),
    ].filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    const same=(mapping:Mapping|undefined,event:string)=>Boolean(mapping&&mapping.profile===profile
      &&mapping.taskId===taskId&&mapping.eventId===event&&mapping.updatedAt);
    if(eventMapping&&!same(eventMapping,eventId))throw new Error("Elapsed Calendar mapping identity is invalid");
    if(taskMapping&&(!taskMapping.updatedAt||taskMapping.profile!==profile||taskMapping.taskId!==taskId))throw new Error("Elapsed Calendar task mapping identity is invalid");
    if(retainedEventMappings.some(mapping=>!mapping.updatedAt||mapping.profile!==profile||mapping.taskId!==taskId
      ||mapping.eventId===eventId))throw new Error("Elapsed Calendar retained event mapping identity is invalid");
    const retainedMappings=[...new Map(retainedEventMappings.map(mapping=>[mapping.eventId,mapping])).values()]
      .filter(mapping=>mapping.eventId!==taskMapping?.eventId);
    const table=this.ensureTable(),receiptKey=key(`ELAPSED_HISTORY_DETACH#${operationId}`);
    const receipt=await client.send(new GetCommand({TableName:table,Key:receiptKey,ConsistentRead:true}));
    if(receipt.Item) {
      if(receipt.Item.profile!==profile||receipt.Item.eventId!==eventId||receipt.Item.taskId!==taskId) throw new Error("Elapsed Calendar detach receipt belongs to another event");
      const [eventRow,taskRow,ownerRow]=await Promise.all([
        client.send(new GetCommand({TableName:table,Key:key(`EVENT#${profile}#${eventId}`,"MAP"),ConsistentRead:true})),
        client.send(new GetCommand({TableName:table,Key:key(`TASK#${profile}#${taskId}`,"MAP"),ConsistentRead:true})),
        client.send(new GetCommand({TableName:table,Key:key(`TASKOWNER#${taskId}`,"MAP"),ConsistentRead:true})),
      ]);
      const expected=taskMapping&&taskMapping.eventId!==eventId?taskMapping:undefined;
      const matches=(item:Record<string,unknown>|undefined,mapping:Mapping|undefined)=>mapping
        ?item?.profile===mapping.profile&&item.taskId===mapping.taskId&&item.eventId===mapping.eventId&&item.updatedAt===mapping.updatedAt
        :!item;
      return !eventRow.Item&&matches(taskRow.Item,expected)&&matches(ownerRow.Item,expected);
    }
    const condition=(expected?:Mapping)=>expected?{
      ConditionExpression:"#p = :p AND taskId = :t AND eventId = :e AND updatedAt = :v",
      ExpressionAttributeNames:{"#p":"profile"},
      ExpressionAttributeValues:{":p":profile,":t":taskId,":e":expected.eventId,":v":expected.updatedAt},
    }:{ConditionExpression:"attribute_not_exists(pk)"};
    const rowItems=(expected:Mapping|undefined, rowKey:Record<string,string>, removeIfOld:boolean) => {
      if(removeIfOld&&same(expected,eventId))return {Delete:{TableName:table,Key:rowKey,...condition(expected)}};
      return {ConditionCheck:{TableName:table,Key:rowKey,...condition(expected)}};
    };
    const items:Array<Record<string,unknown>>=[
      ...(eventMapping
        ? [{Delete:{TableName:table,Key:key(`EVENT#${profile}#${eventId}`,"MAP"),...condition(eventMapping)}}]
        : [{ConditionCheck:{TableName:table,Key:key(`EVENT#${profile}#${eventId}`,"MAP"),ConditionExpression:"attribute_not_exists(pk)"}}]),
      rowItems(taskMapping,key(`TASK#${profile}#${taskId}`,"MAP"),true),
      rowItems(taskMapping,key(`TASKOWNER#${taskId}`,"MAP"),true),
      ...(taskMapping&&taskMapping.eventId!==eventId?[{ConditionCheck:{TableName:table,
        Key:key(`EVENT#${profile}#${taskMapping.eventId}`,"MAP"),...condition(taskMapping)}}]:[]),
      ...retainedMappings.map(mapping=>({ConditionCheck:{TableName:table,
        Key:key(`EVENT#${profile}#${mapping.eventId}`,"MAP"),...condition(mapping)}})),
      ...allProfiles.filter(candidate=>candidate!==profile).map(candidate=>({ConditionCheck:{TableName:table,
        Key:key(`TASK#${candidate}#${taskId}`,"MAP"),ConditionExpression:"attribute_not_exists(pk)"}})),
      {Put:{TableName:table,Item:{...receiptKey,operationId,profile,eventId,taskId,updatedAt:now()},ConditionExpression:"attribute_not_exists(pk)"}},
    ];
    try { await client.send(new TransactWriteCommand({TransactItems:items as never})); return true; }
    catch(error) {
      const cancelled=error as {name?:string;CancellationReasons?:Array<{Code?:string}>};
      if(cancelled.name==="TransactionCanceledException"&&cancelled.CancellationReasons?.some(reason=>reason.Code==="ConditionalCheckFailed")
        &&cancelled.CancellationReasons.every(reason=>reason.Code==="None"||reason.Code==="ConditionalCheckFailed"))return false;
      throw error;
    }
  }

  async acceptTaskVersion(profile: Profile, taskId: string, updatedAt: string | undefined, deliveryId?: string): Promise<boolean> {
    await assertReplayAdmissionIfEnabled({profile,taskId});
    if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return true;
    const versionKey = key(`VERSION#TASK#${taskId}`);
    const id = deliveryId || "";
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(),
        Item: { ...versionKey, sourceUpdatedAt: updatedAt, deliveryId: id, updatedAt: now(), expiresAt: ttl(90) },
        ConditionExpression: "attribute_not_exists(sourceUpdatedAt) OR sourceUpdatedAt < :sourceUpdatedAt OR (:deliveryId <> :empty AND sourceUpdatedAt = :sourceUpdatedAt AND deliveryId = :deliveryId)",
        ExpressionAttributeValues: { ":sourceUpdatedAt": updatedAt, ":deliveryId": id, ":empty": "" },
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async putRecurrenceLink(link: RecurrenceLink): Promise<void> {
    await assertReplayAdmissionIfEnabled({profile:link.profile,taskId:link.taskId,
      eventIds:[...new Set([link.eventId,link.masterEventId].filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let next = link;
      let conditionExpression: string | undefined;
      let expressionAttributeValues: Record<string, unknown> | undefined;

      if (link.owner === "calendar") {
        const existing = await this.getRecurrenceLink(link.profile, link.seriesId);
        const mapped = await this.getMappingByTask(link.profile, link.taskId);
        const mappedCalendar = mapped?.recurrenceOwner === "calendar" && mapped.seriesId === link.seriesId ? mapped : undefined;
        const calendarProgressVersion = link.calendarProgressVersion
          ?? mappedCalendar?.calendarProgressVersion
          ?? existing?.calendarProgressVersion;
        const completedThroughOriginalStart = latestOriginalStart(
          existing?.completedThroughOriginalStart,
          mappedCalendar?.completedThroughOriginalStart,
          link.completedThroughOriginalStart,
        );
        next = {
          ...link,
          ...(calendarProgressVersion === 1 ? { calendarProgressVersion: 1 as const } : {}),
          ...(completedThroughOriginalStart ? { completedThroughOriginalStart } : {}),
        };

        const conditions: string[] = [];
        const values: Record<string, unknown> = {};
        if (existing?.completedThroughOriginalStart) {
          conditions.push("completedThroughOriginalStart = :expectedCompletedThroughOriginalStart");
          values[":expectedCompletedThroughOriginalStart"] = existing.completedThroughOriginalStart;
        } else {
          conditions.push("attribute_not_exists(completedThroughOriginalStart)");
        }
        if (existing?.calendarProgressVersion === 1) {
          conditions.push("calendarProgressVersion = :expectedCalendarProgressVersion");
          values[":expectedCalendarProgressVersion"] = 1;
        } else {
          conditions.push("attribute_not_exists(calendarProgressVersion)");
        }
        conditionExpression = conditions.join(" AND ");
        expressionAttributeValues = Object.keys(values).length ? values : undefined;
      }

      try {
        await client.send(new PutCommand({
          TableName: this.ensureTable(),
          Item: { ...next, updatedAt: now(), ...key(`RECURRENCE#${next.profile}#${next.seriesId}`), ...recurrenceLookupAttributes(next) },
          ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
          ...(expressionAttributeValues ? { ExpressionAttributeValues: expressionAttributeValues } : {}),
        }));
        return;
      } catch (error) {
        if (link.owner === "calendar" && conditionalFailure(error) && attempt < 4) continue;
        throw error;
      }
    }
    throw new Error(`Unable to persist recurrence progress for ${link.profile}/${link.seriesId} because state changed repeatedly`);
  }

  async getRecurrenceLink(profile: Profile, seriesId: string): Promise<RecurrenceLink | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`RECURRENCE#${profile}#${seriesId}`),
      ConsistentRead: true,
    }));
    return result.Item as RecurrenceLink | undefined;
  }

  async deleteRecurrenceLink(profile: Profile, seriesId: string): Promise<void> {
    const link=await this.getRecurrenceLink(profile,seriesId);
    if(!link)return;
    if(!link.taskId||!link.eventId)throw new Error("Recurrence deletion requires a complete identity snapshot");
    await assertReplayAdmissionIfEnabled({profile:link.profile,taskId:link.taskId,
      eventIds:[...new Set([link.eventId,link.masterEventId,link.activeInstanceId]
        .filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    const names:Record<string,string>={"#profile":"profile"};
    const values:Record<string,unknown>={":profile":link.profile,":task":link.taskId,":event":link.eventId};
    const conditions=["#profile = :profile","taskId = :task","eventId = :event"];
    for(const [field,value] of Object.entries({owner:link.owner,seriesId:link.seriesId,
      masterEventId:link.masterEventId,activeInstanceId:link.activeInstanceId,updatedAt:link.updatedAt})) {
      if(value===undefined||value===null)conditions.push(`attribute_not_exists(${field})`);
      else {
        const placeholder=`:${field}`;
        if(field==="owner")names["#owner"]="owner";
        conditions.push(`${field==="owner"?"#owner":field} = ${placeholder}`);
        values[placeholder]=value;
      }
    }
    try {
      await client.send(new DeleteCommand({TableName:this.ensureTable(),Key: key(`RECURRENCE#${profile}#${seriesId}`),
        ConditionExpression:conditions.join(" AND "),ExpressionAttributeNames:names,ExpressionAttributeValues:values}));
    } catch(error) {
      if(!conditionalFailure(error))throw error;
    }
  }

  async listRecurrenceLinks(profile: Profile): Promise<RecurrenceLink[]> {
    const table = this.ensureTable();
    return readProfileLookup<RecurrenceLink>({
      client,
      profile,
      operation: "list_recurrence_links",
      component: "state-repository",
      queryInput: recurrenceLookupQueryInput(table, profile),
    });
  }

  async getRecurrenceLinkByTaskAnyProfile(taskId: string): Promise<RecurrenceLink | undefined> {
    const matches: RecurrenceLink[] = [];
    for (const profile of allProfiles) {
      for (const link of await this.listRecurrenceLinks(profile)) {
        if (link.taskId === taskId) matches.push(link);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Todoist task ${taskId} is claimed by multiple recurrence links; resolve the profile/series ownership before review`);
    }
    return matches[0];
  }

  async getCompletedCalendarProjectionByEvent(profile: Profile, eventId: string): Promise<CompletedCalendarProjection | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`COMPLETED_EVENT#${profile}#${eventId}`),
      ConsistentRead: true,
    }));
    return result.Item?.completedAt ? result.Item as CompletedCalendarProjection : undefined;
  }

  async listCompletedCalendarProjectionsByTask(profile: Profile, taskId: string): Promise<CompletedCalendarProjection[]> {
    const items: CompletedCalendarProjection[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(new QueryCommand({
        TableName: this.ensureTable(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :event)",
        ExpressionAttributeValues: {
          ":pk": `COMPLETED_TASK#${profile}#${taskId}`,
          ":event": "EVENT#",
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items || []) as CompletedCalendarProjection[]);
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return items;
  }

  async listCompletedCalendarProjectionsByTaskAnyProfile(taskId: string): Promise<CompletedCalendarProjection[]> {
    const results: CompletedCalendarProjection[] = [];
    for (const profile of allProfiles) {
      results.push(...await this.listCompletedCalendarProjectionsByTask(profile, taskId));
    }
    return results;
  }

  /**
   * A short-lived cross-invocation fence serialises Todoist Calendar writes
   * with completion guard creation. A lease outlives the AWS Lambda maximum
   * invocation time (15 minutes); after a crashed invocation, the next worker
   * can recover without permanently blocking the task.
   */
  async beginTodoistCalendarWrite(taskId: string): Promise<string> {
    for(const profile of allProfiles)await assertReplayAdmissionIfEnabled({profile,taskId});
    const nowMs = Date.now();
    const token = randomUUID();
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: {
        ...key(`CALENDAR_WRITE#${taskId}`), token,
        leaseUntilMs: nowMs + 16 * 60_000,
        expiresAt: Math.floor((nowMs + 16 * 60_000) / 1000),
      },
      ConditionExpression: "attribute_not_exists(pk) OR leaseUntilMs < :now",
      ExpressionAttributeValues: { ":now": nowMs },
    }));
    return token;
  }

  async endTodoistCalendarWrite(taskId: string, token: string): Promise<void> {
    // Releasing a caller-owned lease must remain possible after a blocked write.
    try {
      await client.send(new DeleteCommand({
        TableName: this.ensureTable(), Key: key(`CALENDAR_WRITE#${taskId}`),
        ConditionExpression: "#token = :token",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":token": token },
      }));
    } catch (error) {
      // An expired lease may have been replaced by another invocation.
      if (!conditionalFailure(error)) throw error;
    }
  }

  async putCompletedCalendarProjection(projection: CompletedCalendarProjection): Promise<void> {
    await assertReplayAdmissionIfEnabled({profile:projection.profile,
      taskId:projection.taskId,eventIds:[projection.eventId]});
    // Once the event-side marker exists it is immutable. A retry must neither
    // reset the seven-day clock nor recreate a task-side index retired by
    // maintenance. Atomic creation avoids half-written history pairs.
    const completedAtMs = Date.parse(projection.completedAt);
    if (!Number.isFinite(completedAtMs) || completedAtMs > Date.now())
      throw new Error("Completed projection requires a valid, non-future completion timestamp");
    const item = { ...projection, updatedAt: now(),
      expiresAt: Math.floor(completedAtMs / 1000) + 7 * 24 * 60 * 60 };
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          // Completion cannot become durable during an in-flight Calendar write.
          // A contended completion delivery fails and is retried, not acknowledged.
          { ConditionCheck: {
            TableName: this.ensureTable(), Key: key(`CALENDAR_WRITE#${projection.taskId}`),
            ConditionExpression: "attribute_not_exists(pk) OR leaseUntilMs < :now",
            ExpressionAttributeValues: { ":now": Date.now() },
          } },
          {
            Put: {
              TableName: this.ensureTable(),
              Item: { ...item, ...key(`COMPLETED_EVENT#${projection.profile}#${projection.eventId}`) },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: this.ensureTable(),
              Item: { ...item, ...key(`COMPLETED_TASK#${projection.profile}#${projection.taskId}`, `EVENT#${projection.eventId}`) },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          ...(projection.terminalVerified === true && projection.seriesId === projection.taskId
            ? [{ Put: {
              TableName: this.ensureTable(),
              Item: {
                ...key(`COMPLETED_SERIES#${projection.profile}#${projection.seriesId}`),
                profile: projection.profile, seriesId: projection.seriesId,
                masterEventId: projection.masterEventId,
                terminalCompletedAt: projection.completedAt, terminalEventId: projection.eventId,
                expiresAt: Math.floor(completedAtMs / 1000) + 7 * 24 * 60 * 60,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            } }] : []),
        ],
      }));
    } catch (error) {
      annotateProviderAction(error, "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem");
      if ((error as { name?: string }).name !== "TransactionCanceledException") throw error;
      const saved = await this.getCompletedCalendarProjectionByEvent(projection.profile, projection.eventId);
      if (!saved || saved.taskId !== projection.taskId || saved.completedAt !== projection.completedAt) {
        // A replay can legitimately have a different delivery timestamp. The
        // existing immutable event-side identity is sufficient to dedupe it.
        if (saved?.taskId === projection.taskId && saved.profile === projection.profile) return;
        throw error;
      }
    }
  }

  /** Retain verified finite-series completion history for seven days. */
  async verifyTerminalCompletedCalendarProjection(
    projection: CompletedCalendarProjection,
    expectedMapping: Mapping,
  ): Promise<boolean> {
    await assertReplayAdmissionIfEnabled({profile:projection.profile,taskId:projection.taskId,
      eventIds:[...new Set([projection.eventId,projection.masterEventId,expectedMapping.eventId,
        expectedMapping.masterEventId,expectedMapping.activeInstanceId]
        .filter((id):id is string=>typeof id==="string"&&id.length>0))]});
    if (!projection.seriesId || !projection.masterEventId
      || expectedMapping.profile !== projection.profile || expectedMapping.seriesId !== projection.seriesId
      || expectedMapping.taskId !== projection.taskId || expectedMapping.eventId !== projection.eventId
      || expectedMapping.masterEventId !== projection.masterEventId) return false;
    const table = this.ensureTable();
    const identity = { ":task": projection.taskId, ":profile": projection.profile };
    const historyValues = { ...identity, ":completed": projection.completedAt, ":yes": true };
    const sameHistory = "#profile = :profile AND taskId = :task AND completedAt = :completed";
    const tx: Array<Record<string, unknown>> = [
      { Update: {
        TableName: table, Key: key(`COMPLETED_EVENT#${projection.profile}#${projection.eventId}`),
        UpdateExpression: "SET terminalVerified = :yes",
        ConditionExpression: sameHistory,
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: historyValues,
      } },
      { Update: {
        TableName: table, Key: key(`COMPLETED_TASK#${projection.profile}#${projection.taskId}`, `EVENT#${projection.eventId}`),
        UpdateExpression: "SET terminalVerified = :yes",
        ConditionExpression: sameHistory,
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: historyValues,
      } },
      { Put: {
        TableName: table,
        Item: {
          ...key(`COMPLETED_SERIES#${projection.profile}#${projection.seriesId}`),
          profile: projection.profile, seriesId: projection.seriesId,
          masterEventId: projection.masterEventId,
          terminalCompletedAt: projection.completedAt, terminalEventId: projection.eventId,
          expiresAt: Math.floor(Date.parse(projection.completedAt) / 1000) + 7 * 24 * 60 * 60,
        },
        ConditionExpression: "attribute_not_exists(pk) OR terminalCompletedAt = :completed",
        ExpressionAttributeValues: { ":completed": projection.completedAt },
      } },
    ];
    try {
      await client.send(new TransactWriteCommand({ TransactItems: tx as never }));
      return true;
    } catch (error) {
      const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")
        && cancelled.CancellationReasons.every((reason) => reason.Code === "None" || reason.Code === "ConditionalCheckFailed")) return false;
      throw error;
    }
  }

  /**
   * An explicit uncompletion re-enables a still-retained standalone mapping
   * without touching Google Calendar. A task whose indexes have been retired
   * is deliberately NOT restored, even if provider comments still exist.
   */
  async reopenRetainedStandaloneMapping(mapping: Mapping, taskUpdatedAt: string | undefined): Promise<boolean> {
    await assertReplayAdmissionIfEnabled(mappingReplayIdentity(mapping));
    if (mapping.recurrenceOwner || mapping.recurrenceId || mapping.seriesId || mapping.masterEventId
      || mapping.activeInstanceId || mapping.originalStart || mapping.activeEffectiveStart
      || !taskUpdatedAt || !Number.isFinite(Date.parse(taskUpdatedAt))) return false;
    const table = this.ensureTable();
    const history = await this.getCompletedCalendarProjectionByEvent(mapping.profile, mapping.eventId);
    const legacyHistory = history as (CompletedCalendarProjection & { recurrenceId?: string; activeInstanceId?: string }) | undefined;
    if (!history || history.taskId !== mapping.taskId || history.recurrenceOwner
      || legacyHistory?.recurrenceId || history.seriesId || history.masterEventId
      || legacyHistory?.activeInstanceId || history.originalStart || history.terminalVerified
      || !Number.isFinite(Date.parse(history.completedAt))
      || Date.parse(taskUpdatedAt) <= Date.parse(history.completedAt)
      || Date.now() - Date.parse(history.completedAt) >= 7 * 24 * 60 * 60_000) return false;
    const values = { ":profile": mapping.profile, ":task": mapping.taskId,
      ":event": mapping.eventId, ":completed": history.completedAt };
    const identity = "#profile = :profile AND taskId = :task AND eventId = :event AND completedAt = :completed";
    const standaloneGuard = " AND attribute_not_exists(recurrenceOwner) AND attribute_not_exists(recurrenceId) AND attribute_not_exists(seriesId) AND attribute_not_exists(masterEventId) AND attribute_not_exists(activeInstanceId) AND attribute_not_exists(originalStart) AND attribute_not_exists(activeEffectiveStart)";
    const matchingMap = "#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :mappingUpdated" + standaloneGuard;
    const tx: Array<Record<string, unknown>> = [
      { Delete: { TableName: table, Key: key(`COMPLETED_EVENT#${mapping.profile}#${mapping.eventId}`),
        ConditionExpression: identity + standaloneGuard,
        ExpressionAttributeNames: { "#profile": "profile" }, ExpressionAttributeValues: values } },
      { Delete: { TableName: table, Key: key(`COMPLETED_TASK#${mapping.profile}#${mapping.taskId}`, `EVENT#${mapping.eventId}`),
        ConditionExpression: identity + standaloneGuard,
        ExpressionAttributeNames: { "#profile": "profile" }, ExpressionAttributeValues: values } },
      ...[
        key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"),
        key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"),
        key(`TASKOWNER#${mapping.taskId}`, "MAP"),
      ].map((rowKey) => ({ ConditionCheck: { TableName: table, Key: rowKey,
        ConditionExpression: matchingMap + " AND attribute_not_exists(recurrenceOwner)",
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: {
          ":profile": mapping.profile, ":task": mapping.taskId,
          ":event": mapping.eventId, ":mappingUpdated": mapping.updatedAt,
        } } })),
      { ConditionCheck: { TableName: table, Key: key(`ERASURE#${mapping.profile}`, "FENCE"),
        ConditionExpression: "attribute_not_exists(pk)" } },
    ];
    try {
      await client.send(new TransactWriteCommand({ TransactItems: tx as never }));
      return true;
    } catch (error) {
      const cancelled = error as { name?: string; CancellationReasons?: Array<{Code?: string}> };
      if (conditionalFailure(error) || cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")
        && cancelled.CancellationReasons.every((reason) => reason.Code === "None" || reason.Code === "ConditionalCheckFailed")) return false;
      throw error;
    }
  }

  async deleteCompletedCalendarProjection(projection: CompletedCalendarProjection): Promise<void> {
    await assertReplayAdmissionIfEnabled({profile:projection.profile,taskId:projection.taskId,eventIds:[projection.eventId]});
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: this.ensureTable(), Key: key(`COMPLETED_EVENT#${projection.profile}#${projection.eventId}`) } },
        { Delete: { TableName: this.ensureTable(), Key: key(`COMPLETED_TASK#${projection.profile}#${projection.taskId}`, `EVENT#${projection.eventId}`) } },
      ],
    }));
  }

  async mutationAllowed(profile: Profile): Promise<boolean> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`CIRCUIT#${profile}`) }));
    return Number(result.Item?.openUntil || 0) <= Date.now();
  }

  async recordMutation(profile: Profile): Promise<void> {
    const circuitKey = key(`CIRCUIT#${profile}`);
    const existing = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: circuitKey }));
    const cutoff = Date.now() - CIRCUIT_WINDOW_MS;
    const recent = (Array.isArray(existing.Item?.recent) ? existing.Item.recent : [])
      .map(Number)
      .filter((timestamp: number) => Number.isFinite(timestamp) && timestamp >= cutoff);
    recent.push(Date.now());
    const openUntil = recent.length >= CIRCUIT_MUTATION_LIMIT ? Date.now() + CIRCUIT_OPEN_MS : Number(existing.Item?.openUntil || 0);
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: { ...circuitKey, recent, openUntil, updatedAt: now() },
    }));
  }


  private async beginConflictIncident(profile: Profile, fingerprint: string, detail: Record<string, unknown>): Promise<string> {
    const entity = retainedConflictEntity(detail);
    if (!entity) throw new Error("A deduplicated conflict must have a stable provider identity");
    const entityHash = createHash("sha256").update(entity).digest("hex");
    const fingerprintHash = createHash("sha256").update(fingerprint).digest("hex");
    const stateKey = key(`CONFLICT_STATE#${profile}#${entityHash}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await client.send(new GetCommand({
        TableName: this.ensureTable(),
        Key: stateKey,
        ConsistentRead: true,
      }));
      const current = existing.Item as { active?: boolean; fingerprint?: string; incidentId?: string } | undefined;
      const incidentId = retainedConflictIncidentId(
        current as import("./audit-policy.js").RetainedConflictLifecycle | undefined,
        fingerprintHash,
        `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
      );
      if (current?.active && current.fingerprint === fingerprintHash && current.incidentId) return incidentId;
      try {
        await client.send(new PutCommand({
          TableName: this.ensureTable(),
          Item: { ...stateKey, active: true, fingerprint: fingerprintHash, incidentId, updatedAt: now() },
          ConditionExpression: "attribute_not_exists(pk) OR #active = :false OR fingerprint <> :fingerprint",
          ExpressionAttributeNames: { "#active": "active" },
          ExpressionAttributeValues: { ":false": false, ":fingerprint": fingerprintHash },
        }));
        return incidentId;
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
      }
    }
    throw new Error("Conflict lifecycle changed repeatedly while assigning an incident");
  }

  async getConflictIncidentCase(profile: Profile, action: string, detail: Record<string, unknown>): Promise<{ caseId:string; caseStatus:string } | undefined> {
    const fingerprint = retainedConflictIdentity(action, detail);
    const entity = retainedConflictEntity(detail);
    if (!fingerprint || !entity) return undefined;
    const entityHash = createHash("sha256").update(entity).digest("hex");
    const stateResult = await client.send(new GetCommand({
      TableName:this.ensureTable(), Key:key(`CONFLICT_STATE#${profile}#${entityHash}`), ConsistentRead:true,
    }));
    const lifecycle = stateResult.Item as { fingerprint?:string; incidentId?:string } | undefined;
    const fingerprintHash = createHash("sha256").update(fingerprint).digest("hex");
    if (lifecycle?.fingerprint !== fingerprintHash || !lifecycle.incidentId) return undefined;
    const auditKey = `AUDIT#${profile}#CONFLICT#${fingerprintHash}#${lifecycle.incidentId}`;
    const caseId = `incident-${reviewHash(auditKey).slice(0,32)}`;
    const item = await new SyncReviewStore().getCase(caseId);
    return { caseId, caseStatus:item?.status || "case_not_found" };
  }

  /** End the active incident only after reconciliation has verified recovery. */
  async resolveConflictAudits(profile: Profile, detail: Record<string, unknown>): Promise<void> {
    const entity = retainedConflictEntity(detail);
    if (!entity) return;
    const entityHash = createHash("sha256").update(entity).digest("hex");
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`CONFLICT_STATE#${profile}#${entityHash}`),
        UpdateExpression: "SET #active = :false, resolvedAt = :resolvedAt",
        ConditionExpression: "attribute_exists(pk) AND #active = :true",
        ExpressionAttributeNames: { "#active": "active" },
        ExpressionAttributeValues: { ":false": false, ":true": true, ":resolvedAt": now() },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async audit(profile: Profile, action: string, detail: Record<string, unknown>): Promise<void> {
    const disposition = classifyAuditAction(action);
    const safeDetail = sanitizeTelemetryDetail(detail);
    logEvent(action, { profile, auditClass: disposition, ...safeDetail }, "state-repository");
    if (disposition === "routine") return;

    // Fingerprint the original allowlisted identity before telemetry sanitization;
    // valid Calendar IDs can exceed the log field length limit.
    const fingerprint = retainedConflictIdentity(action, detail);
    const incidentId = fingerprint ? await this.beginConflictIncident(profile, fingerprint, detail) : undefined;
    const conflictHash = fingerprint ? createHash("sha256").update(fingerprint).digest("hex") : undefined;
    const auditId = conflictHash
      ? `AUDIT#${profile}#CONFLICT#${conflictHash}#${incidentId}`
      : `AUDIT#${profile}#${Date.now()}#${Math.random().toString(36).slice(2, 8)}`;
    const auditRecord = {
      ...key(auditId),
      action,
      detail: safeDetail,
      createdAt: now(),
      expiresAt: auditExpiresAt(),
    };
    try {
      await client.send(new PutCommand({
        TableName: this.ensureTable(),
        Item: auditRecord,
        ...(conflictHash ? {
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
        } : {}),
      }));
    } catch (error) {
      // Every observation is logged. An already-retained incident row is the
      // only write failure that can be safely treated as a duplicate.
      if (!(conflictHash && conditionalFailure(error))) throw error;
    }
    // Audit references are only emitted for conflict-class observations.
    // They permit later exact-ID cleanup without a table-wide Scan. Historical
    // unindexed audit rows still expire under their original seven-day TTL.
    if (/(?:conflict|ambiguous|blocked)/.test(action) && !/(?:operational|dlq)/.test(action)) {
      const related = retainedAuditProviderIds(detail);
      const refs = [
        ...related.taskIds.map(id => ({ side: "todoist", id })),
        ...related.eventIds.map(id => ({ side: "calendar", id })),
      ];
      if (refs.length <= 20) {
        for (const ref of refs) {
          try {
            await client.send(new PutCommand({ TableName: this.ensureTable(),
              Item: { pk: `AUDIT_REF#${profile}#${ref.side}#${ref.id}`,
                sk: `AUDIT#${createHash("sha256").update(auditId).digest("hex")}`,
                auditKey: auditId, profile, expiresAt: auditRecord.expiresAt },
              ConditionExpression: "attribute_not_exists(pk)",
            }));
          } catch (error) {
            if (!conditionalFailure(error)) console.warn(JSON.stringify({
              event: "conflict_audit_reverse_index_deferred", profile, action,
              reason: error instanceof Error ? error.name : "unknown",
            }));
          }
        }
      }
    }
    if (fingerprint && incidentId) {
      try {
        await new SyncReviewStore().observeConflictIncident(profile, fingerprint, incidentId, auditRecord);
      } catch (error) {
        // Inbox indexing is secondary to the durable audit record. The seeder
        // can repair an indexing failure without losing the conflict audit.
        console.warn(JSON.stringify({ service: "todoist-calendar-sync", event: "review_case_index_failed", profile,
          action, error: error instanceof Error ? error.name : "unknown" }));
      }
    }
  }

}
