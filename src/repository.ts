import { ReviewStore as SyncReviewStore, SyncControls, reviewHash } from "./review-store.js";
import { createHash } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient as client, pacedScan } from "./dynamodb-capacity.js";
import {
  auditExpiresAt,
  classifyAuditAction,
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

const tableName = process.env.STATE_TABLE_NAME || "";
const allProfiles: Profile[] = ["home", "antonio", "work"];
const CIRCUIT_MUTATION_LIMIT = 20;
const CIRCUIT_WINDOW_MS = 20_000;
const CIRCUIT_OPEN_MS = 5 * 60_000;

export type CalendarProjectionTombstoneReason = "project_exit";

export interface CalendarProjectionTombstone {
  sourceUpdatedAt: string;
  reason?: CalendarProjectionTombstoneReason;
}

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

export class StateRepository {
  constructor(readonly repairOperationId?: string) {}

  async syncBlocked(profile: Profile, ids: {taskId?: string; eventId?: string}): Promise<boolean> {
    return new SyncControls().blocked(profile, ids, this.repairOperationId);
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

  async markCalendarWatchNotification(profile: Profile, receivedAt = now()): Promise<void> {
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(),
      Key: key(`WATCH#${profile}`),
      UpdateExpression: "SET lastNotificationAt = :receivedAt",
      ExpressionAttributeValues: { ":receivedAt": receivedAt },
    }));
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
        const next: ReconciliationState = {
          ...current,
          reason,
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
              ":reason": reason,
              ":lastRequestedAt": requestedAt,
              ":requester": current.requester || context.requester || "operator",
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
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET lastStartedAt = :now, lastProgressAt = :now, #status = :running, queueState = :running, expiresAt = :expiresAt"
          + (deliveryId ? ", lastStartedDeliveryId = :deliveryId" : "") + " REMOVE lastHealthAlertAt",
        ConditionExpression: "#pending = :true AND generation = :generation AND attribute_not_exists(lastFailedAt)",
        ExpressionAttributeNames: { "#pending": "pending", "#status": "status" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
          ":running": "running",
          ":now": now(),
          ...(deliveryId ? { ":deliveryId": deliveryId } : {}),
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
    const current = await this.getReconciliationState(profile);
    if (!current || current.generation !== generation || !current.pending) return;
    const aggregate = { ...(current.result || {}) };
    for (const [name, count] of Object.entries(counts)) aggregate[name] = (aggregate[name] || 0) + count;
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`),
      UpdateExpression: "SET #result = :result, lastProgressAt = :now, expiresAt = :expiresAt"
        + (checkpoint ? ", progressCheckpoint = :checkpoint" : "") + " REMOVE lastHealthAlertAt",
      ConditionExpression: "#pending = :true AND generation = :generation",
      ExpressionAttributeNames: { "#pending": "pending", "#result": "result" },
      ExpressionAttributeValues: { ":result": aggregate, ":now": now(), ":expiresAt": ttl(30), ":true": true, ":generation": generation,
        ...(checkpoint ? { ":checkpoint": { ...checkpoint, observedAt: now() } } : {}) },
    }));
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
    const outcome = { ...current, ...terminal, notificationPending: true };
    if (terminal.status !== "failed") {
      delete outcome.lastFailedAt;
      delete outcome.lastError;
    }
    try {
      // The terminal result and its notification become durable together.
      await client.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`), ...update,
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
      UpdateExpression: "SET #pending = :false, #status = :status, queueState = :terminal, unresolved = :unresolved, #result = :result, lastCompletedAt = :now, lastProgressAt = :now, notificationPending = :true, notificationText = :notification, expiresAt = :expiresAt REMOVE lastEnqueuedAt, lastStartedAt, lastFailedAt, lastError",
      ExpressionAttributeNames: { "#pending": "pending", "#status": "status", "#result": "result" },
      ExpressionAttributeValues: {
        ":true": true, ":false": false, ":status": status, ":terminal": "terminal", ":unresolved": unresolved, ":result": counts,
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
      UpdateExpression: "SET lastFailedAt = :now, lastProgressAt = :now, #status = :failed, queueState = :terminal, lastError = :message, notificationPending = :true, notificationText = :message, expiresAt = :expiresAt"
        + (failureContext ? ", failureContext = :failureContext" : ""),
      ExpressionAttributeNames: { "#pending": "pending", "#status": "status" },
      ExpressionAttributeValues: {
        ":true": true, ":generation": generation, ":now": failedAt, ":message": lastError, ":failed": "failed", ":terminal": "terminal", ":expiresAt": ttl(30),
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
    const item = { ...mapping, updatedAt: now() };
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) } } },
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"), ...mappingLookupAttributes(mapping) } } },
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`TASKOWNER#${mapping.taskId}`, "MAP"), ...mappingOwnerLookupAttributes(mapping) } } },
      ],
    }));
  }

  /**
   * Transfer one Calendar-owned series association from its displaced task to
   * an already-recurring Todoist task without changing either provider's
   * recurrence. The series occurrence index, task indexes, and recurrence
   * owner change in one conditional transaction.
   */
  async transferCalendarSeriesMapping(input: {
    previous?: Mapping;
    expectedLink?: RecurrenceLink;
    mapping: Mapping;
    link: RecurrenceLink;
  }): Promise<boolean> {
    const { previous, expectedLink, mapping, link } = input;
    if (mapping.recurrenceOwner !== "calendar" || link.owner !== "calendar"
      || mapping.profile !== link.profile || mapping.taskId !== link.taskId
      || mapping.eventId !== link.eventId || mapping.masterEventId !== link.masterEventId
      || mapping.seriesId !== link.seriesId || mapping.activeInstanceId !== link.activeInstanceId
      || !mapping.seriesId || !mapping.masterEventId || !mapping.activeInstanceId
      || previous?.taskId === mapping.taskId
      || (previous && (previous.profile !== mapping.profile || previous.recurrenceOwner !== "calendar"
        || previous.seriesId !== mapping.seriesId || previous.masterEventId !== mapping.masterEventId))
      || (expectedLink && (expectedLink.owner !== "calendar" || expectedLink.profile !== mapping.profile
        || expectedLink.seriesId !== mapping.seriesId || expectedLink.taskId !== previous?.taskId))) {
      throw new Error("Invalid Calendar series transfer mapping");
    }
    const currentTarget = await this.getMappingByTask(mapping.profile, mapping.taskId);
    const currentLink = await this.getRecurrenceLink(mapping.profile, mapping.seriesId);
    if (currentTarget && currentTarget.taskId === mapping.taskId && currentTarget.eventId === mapping.eventId
      && currentTarget.masterEventId === mapping.masterEventId && currentTarget.activeInstanceId === mapping.activeInstanceId
      && currentTarget.recurrenceOwner === "calendar" && currentLink?.owner === "calendar"
      && currentLink.taskId === mapping.taskId && currentLink.eventId === mapping.eventId
      && currentLink.masterEventId === mapping.masterEventId && currentLink.activeInstanceId === mapping.activeInstanceId) return true;
    const table = this.ensureTable();
    const identityValues = {
      ":profile": mapping.profile, ":task": mapping.taskId, ":event": mapping.eventId,
      ":updated": mapping.updatedAt,
    };
    const oldIdentityValues = previous ? {
      ":oldProfile": previous.profile, ":oldTask": previous.taskId,
      ":oldEvent": previous.eventId, ":oldUpdated": previous.updatedAt,
    } : undefined;
    const items: Array<Record<string, unknown>> = [];
    if (previous) {
      if (!previous.updatedAt) throw new Error("The displaced mapping has no version; refresh affected items");
      if (previous.eventId === mapping.eventId) {
        items.push({ Put: {
          TableName: table,
          Item: { ...mapping, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) },
          ConditionExpression: "#profile = :oldProfile AND taskId = :oldTask AND eventId = :oldEvent AND updatedAt = :oldUpdated",
          ExpressionAttributeNames: { "#profile": "profile" },
          ExpressionAttributeValues: oldIdentityValues,
        } });
      } else {
        items.push({ Delete: {
          TableName: table, Key: key(`EVENT#${previous.profile}#${previous.eventId}`, "MAP"),
          ConditionExpression: "#profile = :oldProfile AND taskId = :oldTask AND eventId = :oldEvent AND updatedAt = :oldUpdated",
          ExpressionAttributeNames: { "#profile": "profile" },
          ExpressionAttributeValues: oldIdentityValues,
        } });
        items.push({ Put: {
          TableName: table,
          Item: { ...mapping, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) },
          ConditionExpression: "attribute_not_exists(pk)",
        } });
      }
      items.push({ Delete: {
        TableName: table, Key: key(`TASK#${previous.profile}#${previous.taskId}`, "MAP"),
        ConditionExpression: "#profile = :oldProfile AND taskId = :oldTask AND eventId = :oldEvent AND updatedAt = :oldUpdated",
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: oldIdentityValues,
      } });
      items.push({ Delete: {
        TableName: table, Key: key(`TASKOWNER#${previous.taskId}`, "MAP"),
        ConditionExpression: "#profile = :oldProfile AND taskId = :oldTask AND eventId = :oldEvent AND updatedAt = :oldUpdated",
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: oldIdentityValues,
      } });
    } else {
      items.push({ Put: {
        TableName: table,
        Item: { ...mapping, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"), ...mappingEventLookupAttributes(mapping) },
        ConditionExpression: "attribute_not_exists(pk)",
      } });
    }
    items.push(
      { Put: {
        TableName: table,
        Item: { ...mapping, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"), ...mappingLookupAttributes(mapping) },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: table,
        Item: { ...mapping, ...key(`TASKOWNER#${mapping.taskId}`, "MAP"), ...mappingOwnerLookupAttributes(mapping) },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: table,
        Item: { ...link, ...key(`RECURRENCE#${link.profile}#${link.seriesId}`), ...recurrenceLookupAttributes(link) },
        ...(expectedLink ? {
          ConditionExpression: "#owner = :oldOwner AND taskId = :oldTask AND eventId = :oldEvent AND updatedAt = :oldLinkUpdated",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: {
            ":oldOwner": expectedLink.owner, ":oldTask": expectedLink.taskId,
            ":oldEvent": expectedLink.eventId, ":oldLinkUpdated": expectedLink.updatedAt,
          },
        } : { ConditionExpression: "attribute_not_exists(pk)" }),
      } },
    );
    for (const profile of allProfiles) {
      if (profile === mapping.profile) continue;
      items.push({ ConditionCheck: {
        TableName: table, Key: key(`TASK#${profile}#${mapping.taskId}`, "MAP"),
        ConditionExpression: "attribute_not_exists(pk)",
      } });
    }
    try {
      await client.send(new TransactWriteCommand({ TransactItems: items as never }));
      return true;
    } catch (error) {
      const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed")
        && cancelled.CancellationReasons.every(reason => reason.Code === "None" || reason.Code === "ConditionalCheckFailed")) return false;
      throw error;
    }
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
    return result.Item as {
      profile: Profile; taskId: string; oldMasterId: string; newMasterId: string; previousOccurrence?: string; status: string;
    } | undefined;
  }

  async beginFutureSeriesSplit(profile: Profile, taskId: string, oldMasterId: string, newMasterId: string, previousOccurrence?: string): Promise<void> {
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
          // No TTL while pending: automatic reconciliation must remain blocked
          // until an operator finishes or explicitly compensates the split.
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
        Key: key(`PROJECTION#${mapping.profile}#TASK#${mapping.taskId}`, "TOMBSTONE"),
        ConditionExpression: "attribute_not_exists(pk)",
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
      tx.push({ ConditionCheck: {
        TableName: table,
        Key: key(`PROJECTION#${other}#TASK#${mapping.taskId}`, "TOMBSTONE"),
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
    expectedTombstone?: CalendarProjectionTombstone;
    cancelledEventId?: string;
  }): Promise<boolean> {
    const { mapping, link, previousMapping, previousLink, discardedTaskId, decisionId, expectedTombstone } = input;
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
      if (completed?.eventId === mapping.eventId && completed.recurrenceOwner === "todoist"
        && alias?.retainedTaskId === mapping.taskId && alias.decisionId === decisionId) return true;
      throw new Error("The approved future-series operation is not pending");
    }
    tx.push({ ConditionCheck: {
      TableName: table, Key: key(`FUTURE_SPLIT#TASK#${mapping.taskId}`),
      ConditionExpression: "#status = :pending AND profile = :profile AND newMasterId = :master",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":profile": mapping.profile, ":master": mapping.eventId },
    } });
    if (expectedTombstone) {
      tx.push({ Delete: {
        TableName: table, Key: key(`PROJECTION#${mapping.profile}#TASK#${mapping.taskId}`, "TOMBSTONE"),
        ConditionExpression: "sourceUpdatedAt = :sourceUpdatedAt",
        ExpressionAttributeValues: { ":sourceUpdatedAt": expectedTombstone.sourceUpdatedAt },
      } });
    } else {
      tx.push({ ConditionCheck: {
        TableName: table, Key: key(`PROJECTION#${mapping.profile}#TASK#${mapping.taskId}`, "TOMBSTONE"),
        ConditionExpression: "attribute_not_exists(pk)",
      } });
    }
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
   * Recover missing TASK / TASKOWNER indexes only from an unchanged EVENT row.
   * Ordinary putMapping() is intentionally unconditional and MUST NOT be used
   * for this path: another profile may now own the same Todoist task.
   *
   * The read-side preflight makes errors actionable; the transaction remains
   * authoritative if ownership, recurrence, completion or tombstone state
   * changes between the reads and the repair.
   */
  async restoreMappingIndexesIfOwned(mapping: Mapping, expectedLink?: RecurrenceLink): Promise<boolean> {
    const current = await this.getMappingByEvent(mapping.profile, mapping.eventId);
    if (!current || current.taskId !== mapping.taskId || current.updatedAt !== mapping.updatedAt
      || current.profile !== mapping.profile) return false;

    const owner = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`TASKOWNER#${mapping.taskId}`, "MAP"),
      ConsistentRead: true,
    }));
    const compatible = (candidate: Mapping | undefined): boolean =>
      !candidate || (candidate.profile === mapping.profile
        && candidate.taskId === mapping.taskId && candidate.eventId === mapping.eventId
        && candidate.updatedAt === mapping.updatedAt
        && candidate.recurrenceOwner === mapping.recurrenceOwner
        && candidate.seriesId === mapping.seriesId
        && candidate.completedThroughOriginalStart === mapping.completedThroughOriginalStart);
    if (!compatible(owner.Item as Mapping | undefined)
      || !compatible(await this.getMappingByTask(mapping.profile, mapping.taskId))) return false;

    // A stale non-owner TASK row is still an unresolved split-brain, not
    // permission to overwrite the global owner index.
    for (const other of allProfiles) {
      if (other === mapping.profile) continue;
      if (await this.getMappingByTask(other, mapping.taskId)) return false;
    }
    if (await this.getCalendarProjectionTombstone(mapping.profile, mapping.taskId)
      || await this.getCompletedCalendarProjectionByEvent(mapping.profile, mapping.eventId)) return false;

    if (mapping.recurrenceOwner) {
      if (!mapping.seriesId || !expectedLink) return false;
      const live = await this.getRecurrenceLink(mapping.profile, mapping.seriesId);
      if (!live || live.updatedAt !== expectedLink.updatedAt
        || live.owner !== mapping.recurrenceOwner
        || live.taskId !== mapping.taskId || live.eventId !== mapping.eventId
        || live.profile !== mapping.profile || live.seriesId !== mapping.seriesId
        || live.masterEventId !== mapping.masterEventId
        || live.activeInstanceId !== mapping.activeInstanceId
        || live.originalStart !== mapping.originalStart
        || live.activeEffectiveStart !== mapping.activeEffectiveStart
        || live.completedThroughOriginalStart !== mapping.completedThroughOriginalStart
        || live.calendarProgressVersion !== mapping.calendarProgressVersion
        || live.completedThroughOriginalStart !== expectedLink.completedThroughOriginalStart
        || live.calendarProgressVersion !== expectedLink.calendarProgressVersion) return false;
    } else if (mapping.seriesId || mapping.masterEventId || mapping.activeInstanceId) {
      return false;
    }

    const table = this.ensureTable();
    const identityValues = {
      ":profile": mapping.profile, ":task": mapping.taskId, ":event": mapping.eventId,
      ":updated": mapping.updatedAt,
    };
    const compatibleWrite = "attribute_not_exists(pk) OR (#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated)";
    const transactItems: Array<Record<string, unknown>> = [
      { ConditionCheck: {
        TableName: table,
        Key: key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP"),
        ConditionExpression: "#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated",
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: { ...identityValues, ":updated": mapping.updatedAt },
      } },
      { ConditionCheck: {
        TableName: table,
        Key: key(`PROJECTION#${mapping.profile}#TASK#${mapping.taskId}`, "TOMBSTONE"),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { ConditionCheck: {
        TableName: table,
        Key: key(`COMPLETED_EVENT#${mapping.profile}#${mapping.eventId}`),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: table,
        Item: { ...mapping, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP"), ...mappingLookupAttributes(mapping) },
        ConditionExpression: compatibleWrite,
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: identityValues,
      } },
      { Put: {
        TableName: table,
        Item: { ...mapping, ...key(`TASKOWNER#${mapping.taskId}`, "MAP"), ...mappingOwnerLookupAttributes(mapping) },
        ConditionExpression: compatibleWrite,
        ExpressionAttributeNames: { "#profile": "profile" },
        ExpressionAttributeValues: identityValues,
      } },
    ];
    for (const other of allProfiles) {
      if (other === mapping.profile) continue;
      transactItems.push({ ConditionCheck: {
        TableName: table,
        Key: key(`TASK#${other}#${mapping.taskId}`, "MAP"),
        ConditionExpression: "attribute_not_exists(pk)",
      } });
    }
    if (expectedLink && mapping.seriesId) {
      transactItems.push({ ConditionCheck: {
        TableName: table,
        Key: key(`RECURRENCE#${mapping.profile}#${mapping.seriesId}`),
        ConditionExpression: "taskId = :task AND eventId = :event AND #owner = :owner AND updatedAt = :updated",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: {
          ":task": mapping.taskId, ":event": mapping.eventId,
          ":owner": mapping.recurrenceOwner, ":updated": expectedLink.updatedAt,
        },
      } });
    }
    try {
      await client.send(new TransactWriteCommand({ TransactItems: transactItems as never }));
      return true;
    } catch (error) {
      const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (cancelled.name === "TransactionCanceledException"
        && cancelled.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")
        && cancelled.CancellationReasons.every((reason) => reason.Code === "None" || reason.Code === "ConditionalCheckFailed")) {
        return false;
      }
      throw error;
    }
  }

  private async deleteProfileMappingIndexes(mapping: Mapping): Promise<void> {
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

  async acceptTaskVersion(profile: Profile, taskId: string, updatedAt: string | undefined, deliveryId?: string): Promise<boolean> {
    void profile;
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
    await client.send(new DeleteCommand({ TableName: this.ensureTable(), Key: key(`RECURRENCE#${profile}#${seriesId}`) }));
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

  async getCalendarProjectionTombstone(profile: Profile, taskId: string): Promise<CalendarProjectionTombstone | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`PROJECTION#${profile}#TASK#${taskId}`, "TOMBSTONE"),
      ConsistentRead: true,
    }));
    if (typeof result.Item?.sourceUpdatedAt !== "string") return undefined;
    return {
      sourceUpdatedAt: result.Item.sourceUpdatedAt,
      ...(result.Item.reason === "project_exit" ? { reason: "project_exit" as const } : {}),
    };
  }

  async putCalendarProjectionTombstone(
    profile: Profile,
    taskId: string,
    sourceUpdatedAt: string,
    reason?: CalendarProjectionTombstoneReason,
  ): Promise<void> {
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: {
        ...key(`PROJECTION#${profile}#TASK#${taskId}`, "TOMBSTONE"),
        sourceUpdatedAt,
        reason,
        updatedAt: now(),
        expiresAt: ttl(30),
      },
    }));
  }

  async deleteCalendarProjectionTombstone(profile: Profile, taskId: string): Promise<void> {
    await client.send(new DeleteCommand({
      TableName: this.ensureTable(),
      Key: key(`PROJECTION#${profile}#TASK#${taskId}`, "TOMBSTONE"),
    }));
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

  async putCompletedCalendarProjection(projection: CompletedCalendarProjection): Promise<void> {
    // Once the event-side marker exists it is immutable. A retry must neither
    // reset the seven-day clock nor recreate a task-side index retired by
    // maintenance. Atomic creation avoids half-written history pairs.
    const item = { ...projection, updatedAt: now() };
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
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
          ...(projection.terminalVerified === true && projection.recurrenceOwner === "todoist" && projection.seriesId
            ? [{ Put: {
              TableName: this.ensureTable(),
              Item: {
                ...key(`COMPLETED_SERIES#${projection.profile}#${projection.seriesId}`),
                profile: projection.profile, seriesId: projection.seriesId,
                recurrenceOwner: projection.recurrenceOwner, masterEventId: projection.masterEventId,
                terminalCompletedAt: projection.completedAt, terminalEventId: projection.eventId,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            } }] : []),
        ],
      }));
    } catch (error) {
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

  /**
   * Mark a finite Calendar-owned series terminal ONLY while retiring its exact
   * unchanged recurrence link. If a successor takes ownership, the transaction
   * aborts and the occurrence stays historical but not cleanup-eligible.
   */
  async verifyTerminalCompletedCalendarProjection(
    projection: CompletedCalendarProjection,
    expectedLink: RecurrenceLink,
  ): Promise<boolean> {
    if (projection.recurrenceOwner !== "calendar" || !projection.seriesId
      || expectedLink.owner !== "calendar" || expectedLink.profile !== projection.profile
      || expectedLink.seriesId !== projection.seriesId || expectedLink.taskId !== projection.taskId
      || expectedLink.eventId !== projection.eventId) return false;
    const table = this.ensureTable();
    const identity = { ":task": projection.taskId, ":profile": projection.profile };
    const historyValues = { ...identity, ":completed": projection.completedAt, ":yes": true };
    const sameHistory = "#profile = :profile AND taskId = :task AND completedAt = :completed";
    const tx: Array<Record<string, unknown>> = [
      { Delete: {
        TableName: table, Key: key(`RECURRENCE#${projection.profile}#${projection.seriesId}`),
        ConditionExpression: "taskId = :task AND #profile = :profile AND #owner = :owner AND seriesId = :series AND updatedAt = :updated",
        ExpressionAttributeNames: { "#profile": "profile", "#owner": "owner" },
        ExpressionAttributeValues: { ...identity, ":owner": "calendar", ":series": projection.seriesId, ":updated": expectedLink.updatedAt },
      } },
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
          recurrenceOwner: "calendar", masterEventId: projection.masterEventId,
          terminalCompletedAt: projection.completedAt, terminalEventId: projection.eventId,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { ConditionCheck: {
        TableName: table, Key: key(`TASKOWNER#${projection.taskId}`, "MAP"),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ];
    for (const candidateProfile of allProfiles) {
      tx.push({ ConditionCheck: {
        TableName: table, Key: key(`TASK#${candidateProfile}#${projection.taskId}`, "MAP"),
        ConditionExpression: "attribute_not_exists(pk)",
      } });
      tx.push({ ConditionCheck: {
        TableName: table, Key: key(`EVENT#${candidateProfile}#${projection.eventId}`, "MAP"),
        ConditionExpression: "attribute_not_exists(pk)",
      } });
    }
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

  async deleteCompletedCalendarProjection(projection: CompletedCalendarProjection): Promise<void> {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: this.ensureTable(), Key: key(`COMPLETED_EVENT#${projection.profile}#${projection.eventId}`) } },
        { Delete: { TableName: this.ensureTable(), Key: key(`COMPLETED_TASK#${projection.profile}#${projection.taskId}`, `EVENT#${projection.eventId}`) } },
      ],
    }));
  }

  async recordRecurrence(profile: Profile, eventId: string, recurrence: string[] | undefined): Promise<void> {
    if (!recurrence?.length) return;
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: { ...key(`RECURRENCE#${profile}#${eventId}`), recurrence, updatedAt: now() },
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
