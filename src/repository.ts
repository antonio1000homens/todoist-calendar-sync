import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient as client, pacedScan } from "./dynamodb-capacity.js";
import { auditExpiresAt, classifyAuditAction } from "./audit-policy.js";
import { logEvent, sanitizeTelemetryDetail } from "./observability.js";
import type { Mapping, Profile, ReconciliationReason, RecurrenceLink } from "./types.js";

const tableName = process.env.STATE_TABLE_NAME || "";
const allProfiles: Profile[] = ["home", "antonio", "work"];
const CIRCUIT_MUTATION_LIMIT = 20;
const CIRCUIT_WINDOW_MS = 20_000;
const CIRCUIT_OPEN_MS = 5 * 60_000;
const RECONCILE_REENQUEUE_MS = 5 * 60_000;

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

export class StateRepository {
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
  ): Promise<{ state: ReconciliationState; shouldEnqueue: boolean; created: boolean }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getReconciliationState(profile);
      const requestedAt = now();
      if (current?.pending) {
        const lastEnqueued = current.lastEnqueuedAt ? Date.parse(current.lastEnqueuedAt) : Number.NaN;
        const staleOrNeverEnqueued = !Number.isFinite(lastEnqueued) || Date.now() - lastEnqueued >= RECONCILE_REENQUEUE_MS;
        const next: ReconciliationState = {
          ...current,
          reason,
          lastRequestedAt: requestedAt,
        };
        try {
          await client.send(new UpdateCommand({
            TableName: this.ensureTable(),
            Key: key(`RECONCILE#${profile}`),
            UpdateExpression: "SET reason = :reason, lastRequestedAt = :lastRequestedAt, expiresAt = :expiresAt",
            ConditionExpression: "#pending = :true AND generation = :generation",
            ExpressionAttributeNames: { "#pending": "pending" },
            ExpressionAttributeValues: {
              ":true": true,
              ":generation": current.generation,
              ":reason": reason,
              ":lastRequestedAt": requestedAt,
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
        ...(current?.lastCompletedAt ? { lastCompletedAt: current.lastCompletedAt } : {}),
      };
      try {
        await client.send(new PutCommand({
          TableName: this.ensureTable(),
          Item: {
            ...key(`RECONCILE#${profile}`),
            ...state,
            expiresAt: ttl(30),
          },
          ConditionExpression: "attribute_not_exists(pk) OR #pending = :false",
          ExpressionAttributeNames: { "#pending": "pending" },
          ExpressionAttributeValues: { ":false": false },
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
        UpdateExpression: "SET lastStartedAt = :now, expiresAt = :expiresAt",
        ConditionExpression: "#pending = :true AND generation = :generation",
        ExpressionAttributeNames: { "#pending": "pending" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
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

  async completeReconciliation(profile: Profile, generation: string): Promise<void> {
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET #pending = :false, lastCompletedAt = :now, expiresAt = :expiresAt REMOVE lastEnqueuedAt, lastStartedAt, lastFailedAt, lastError",
        ConditionExpression: "#pending = :true AND generation = :generation",
        ExpressionAttributeNames: { "#pending": "pending" },
        ExpressionAttributeValues: {
          ":true": true,
          ":false": false,
          ":generation": generation,
          ":now": now(),
          ":expiresAt": ttl(30),
        },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async recordReconciliationFailure(profile: Profile, generation: string, message: string): Promise<void> {
    try {
      await client.send(new UpdateCommand({
        TableName: this.ensureTable(),
        Key: key(`RECONCILE#${profile}`),
        UpdateExpression: "SET lastFailedAt = :now, lastError = :message, expiresAt = :expiresAt",
        ConditionExpression: "#pending = :true AND generation = :generation",
        ExpressionAttributeNames: { "#pending": "pending" },
        ExpressionAttributeValues: {
          ":true": true,
          ":generation": generation,
          ":now": now(),
          ":message": message.slice(0, 1000),
          ":expiresAt": ttl(30),
        },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async getMappingByEvent(profile: Profile, eventId: string): Promise<Mapping | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`EVENT#${profile}#${eventId}`, "MAP") }));
    return result.Item as Mapping | undefined;
  }

  async getMappingByTask(profile: Profile, taskId: string): Promise<Mapping | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`TASK#${profile}#${taskId}`, "MAP") }));
    return result.Item as Mapping | undefined;
  }

  async getMappingByTaskAnyProfile(taskId: string): Promise<Mapping | undefined> {
    const owner = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`TASKOWNER#${taskId}`, "MAP") }));
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
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`EVENT#${mapping.profile}#${mapping.eventId}`, "MAP") } } },
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`TASK#${mapping.profile}#${mapping.taskId}`, "MAP") } } },
        { Put: { TableName: this.ensureTable(), Item: { ...item, ...key(`TASKOWNER#${mapping.taskId}`, "MAP") } } },
      ],
    }));
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
    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: { ...link, updatedAt: now(), ...key(`RECURRENCE#${link.profile}#${link.seriesId}`) },
    }));
  }

  async getRecurrenceLink(profile: Profile, seriesId: string): Promise<RecurrenceLink | undefined> {
    const result = await client.send(new GetCommand({ TableName: this.ensureTable(), Key: key(`RECURRENCE#${profile}#${seriesId}`) }));
    return result.Item as RecurrenceLink | undefined;
  }

  async deleteRecurrenceLink(profile: Profile, seriesId: string): Promise<void> {
    await client.send(new DeleteCommand({ TableName: this.ensureTable(), Key: key(`RECURRENCE#${profile}#${seriesId}`) }));
  }

  async listRecurrenceLinks(profile: Profile): Promise<RecurrenceLink[]> {
    const result = await pacedScan<RecurrenceLink>({
      TableName: this.ensureTable(),
      FilterExpression: "begins_with(pk, :prefix)",
      ExpressionAttributeValues: { ":prefix": `RECURRENCE#${profile}#` },
    }, {
      operation: "list_recurrence_links",
      profile,
    });
    return result.items;
  }

  async getCalendarProjectionTombstone(profile: Profile, taskId: string): Promise<CalendarProjectionTombstone | undefined> {
    const result = await client.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`PROJECTION#${profile}#TASK#${taskId}`, "TOMBSTONE"),
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

  async audit(profile: Profile, action: string, detail: Record<string, unknown>): Promise<void> {
    const disposition = classifyAuditAction(action);
    const safeDetail = sanitizeTelemetryDetail(detail);
    logEvent(action, { profile, auditClass: disposition, ...safeDetail }, "state-repository");
    if (disposition === "routine") return;

    await client.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: {
        ...key(`AUDIT#${profile}#${Date.now()}#${Math.random().toString(36).slice(2, 8)}`),
        action,
        detail: safeDetail,
        createdAt: now(),
        expiresAt: auditExpiresAt(),
      },
    }));
  }
}
