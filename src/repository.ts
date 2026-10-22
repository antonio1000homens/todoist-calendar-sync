import { ReviewStore as SyncReviewStore, SyncControls } from "./review-store.js";
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
  pendingRefreshRefs?: Array<{ profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string }>;
  /** Refreshes requested after this run started; they require a fresh generation. */
  followUpRefreshRefs?: Array<{ profile:Profile; side:"todoist"|"calendar"; id:string; pendingRefreshAt:string }>;
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

  async markDeliveryCompleted(id: string, profile: Profile, kind: string): Promise<void> {
    const completedAt = now();
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: {
        ...key(`DELIVERY#${id}`, "COMPLETED"),
        profile,
        kind,
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

  async markReconciliationEnqueued(profile: Profile, generation: string): Promise<void> {
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET lastEnqueuedAt = :now, expiresAt = :expiresAt",
        ConditionExpression: "#pending = :true AND generation = :generation",
        ExpressionAttributeNames: { "#pending": "pending" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
          ":now": now(),
          ":expiresAt": ttl(30),
        },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async beginReconciliation(profile: Profile, generation: string): Promise<boolean> {
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET lastStartedAt = :now, lastProgressAt = :now, #status = :running, expiresAt = :expiresAt REMOVE lastHealthAlertAt",
        ConditionExpression: "#pending = :true AND generation = :generation AND attribute_not_exists(lastFailedAt)",
        ExpressionAttributeNames: { "#pending": "pending", "#status": "status" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
          ":running": "running",
          ":now": now(),
          ":expiresAt": ttl(30),
        },
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async addReconciliationProgress(profile: Profile, generation: string, counts: Record<string, number>): Promise<void> {
    const current = await this.getReconciliationState(profile);
    if (!current || current.generation !== generation || !current.pending) return;
    const aggregate = { ...(current.result || {}) };
    for (const [name, count] of Object.entries(counts)) aggregate[name] = (aggregate[name] || 0) + count;
    await client.send(new UpdateCommand({
      TableName: this.ensureTable(), Key: key(`RECONCILE#${profile}`),
      UpdateExpression: "SET #result = :result, lastProgressAt = :now, expiresAt = :expiresAt REMOVE lastHealthAlertAt",
      ConditionExpression: "#pending = :true AND generation = :generation",
      ExpressionAttributeNames: { "#pending": "pending", "#result": "result" },
      ExpressionAttributeValues: { ":result": aggregate, ":now": now(), ":expiresAt": ttl(30), ":true": true, ":generation": generation },
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
      UpdateExpression: "SET #pending = :false, #status = :status, unresolved = :unresolved, #result = :result, lastCompletedAt = :now, lastProgressAt = :now, notificationPending = :true, notificationText = :notification, expiresAt = :expiresAt REMOVE lastEnqueuedAt, lastStartedAt, lastFailedAt, lastError",
      ExpressionAttributeNames: { "#pending": "pending", "#status": "status", "#result": "result" },
      ExpressionAttributeValues: {
        ":true": true, ":false": false, ":status": status, ":unresolved": unresolved, ":result": counts,
        ":notification": notificationText, ":generation": generation, ":now": completedAt, ":expiresAt": ttl(30),
      },
    });
  }

  async recordReconciliationFailure(profile: Profile, generation: string, message: string): Promise<void> {
    const failedAt = now();
    const lastError = message.slice(0, 1000);
    await this.saveReconciliationOutcome(profile, generation, {
      status: "failed", lastFailedAt: failedAt, lastProgressAt: failedAt, lastError, notificationText: lastError,
    }, {
      UpdateExpression: "SET lastFailedAt = :now, lastProgressAt = :now, #status = :failed, lastError = :message, notificationPending = :true, notificationText = :message, expiresAt = :expiresAt",
      ExpressionAttributeNames: { "#pending": "pending", "#status": "status" },
      ExpressionAttributeValues: {
        ":true": true, ":generation": generation, ":now": failedAt, ":message": lastError, ":failed": "failed", ":expiresAt": ttl(30),
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
          profile, taskId, oldMasterId, newMasterId, previousOccurrence,
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
