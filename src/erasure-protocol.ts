import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";

function table(): string {
  if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required");
  return process.env.STATE_TABLE_NAME;
}

function fenceKey(profile: Profile) { return { pk: `ERASURE#${profile}`, sk: "FENCE" }; }
function epochKey(profile: Profile) { return { pk: `ERASURE#${profile}`, sk: "EPOCH" }; }

export async function getErasureEpoch(profile: Profile): Promise<number> {
  const result = await documentClient.send(new GetCommand({ TableName: table(), Key: epochKey(profile), ConsistentRead: true }));
  return typeof result.Item?.epoch === "number" ? result.Item.epoch : 0;
}

export class ErasureFenceActiveError extends Error {
  constructor(readonly profile: Profile) {
    super(`Item erasure is in progress for profile ${profile}; provider work is temporarily fenced`);
    this.name = "ErasureFenceActiveError";
  }
}

export class ErasureEpochChangedError extends Error {
  constructor(readonly profile: Profile) {
    super(`Erasure epoch changed while acquiring a ${profile} protocol lease`);
    this.name = "ErasureEpochChangedError";
  }
}

/**
 * Acquire a durable, profile-scoped lease before accepting queue work or
 * processing a delivery. The transaction serializes the lease against fence
 * creation, so a lease is either visible to the erasure owner or rejected.
 * Lease rows intentionally contain no Todoist or Calendar identifiers.
 */
export async function acquireErasureProtocolLease(
  profile: Profile,
  kind: "admission" | "writer",
  owner: string = randomUUID(),
  expectedEpoch: number,
): Promise<() => Promise<void>> {
  const key = fenceKey(profile);
  const leaseKey = { pk: key.pk, sk: `${kind.toUpperCase()}#${owner}` };
  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: table(), Key: key, ConditionExpression: "attribute_not_exists(pk)" } },
      { ConditionCheck: { TableName: table(), Key: epochKey(profile), ConditionExpression: "attribute_not_exists(epoch) OR epoch = :expected", ExpressionAttributeValues: { ":expected": expectedEpoch } } },
      { Put: { TableName: table(), Item: { ...leaseKey, kind, owner, acquiredAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "TransactionCanceledException" || name === "ConditionalCheckFailedException") {
      const current = await documentClient.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }));
      if (current.Item) throw new ErasureFenceActiveError(profile);
      throw new ErasureEpochChangedError(profile);
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await documentClient.send(new DeleteCommand({ TableName: table(), Key: leaseKey }));
  };
}

/** Install the profile fence. Existing leases remain visible and must drain. */
export async function beginErasureFence(profile: Profile, operationId: string): Promise<void> {
  const key = fenceKey(profile);
  const current = await documentClient.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }));
  if (current.Item) {
    if (current.Item.operationId !== operationId) throw new Error("A different item-erasure operation already owns this profile fence");
    return;
  }
  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table(), Item: {
        ...key, state: "active", operationId, createdAt: new Date().toISOString(),
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: table(), Key: epochKey(profile), UpdateExpression: "ADD #epoch :one", ExpressionAttributeNames: { "#epoch": "epoch" }, ExpressionAttributeValues: { ":one": 1 } } },
    ] }));
  } catch (error) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new Error("Another erasure operation acquired the profile fence; inspect its journal before retrying");
    }
    throw error;
  }
}

export async function inspectErasureFence(profile: Profile): Promise<{ fence?: Record<string, unknown>; leases: Record<string, unknown>[] }> {
  const key = fenceKey(profile);
  const result = await documentClient.send(new QueryCommand({
    TableName: table(), KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": key.pk }, ConsistentRead: true,
  }));
  const rows = result.Items || [];
  return {
    fence: rows.find((item) => item.sk === key.sk),
    leases: rows.filter((item) => typeof item.sk === "string" && ![key.sk, "JOURNAL", "EPOCH"].includes(item.sk)) as Record<string, unknown>[],
  };
}

/** Remove only the matching temporary fence after purge postconditions pass. */
export async function finishErasureFence(profile: Profile, operationId: string): Promise<void> {
  const key = fenceKey(profile);
  await documentClient.send(new DeleteCommand({
    TableName: table(), Key: key, ConditionExpression: "operationId = :operationId",
    ExpressionAttributeValues: { ":operationId": operationId },
  }));
}

/** Atomically remove the temporary fence and identity-bearing journal on success. */
export async function finishErasureProtocol(
  profile: Profile,
  operationId: string,
  journalKey: { pk: string; sk: string },
): Promise<void> {
  const { fence, leases } = await inspectErasureFence(profile);
  if (fence?.operationId !== operationId) throw new Error("The profile fence is not owned by this erasure operation");
  if (leases.length) throw new Error(`Erasure is not drained: ${leases.length} admission or writer lease(s) remain`);
  await documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: table(), Key: fenceKey(profile), ConditionExpression: "operationId = :operationId", ExpressionAttributeValues: { ":operationId": operationId } } },
    { Delete: { TableName: table(), Key: journalKey, ConditionExpression: "operationId = :operationId", ExpressionAttributeValues: { ":operationId": operationId } } },
  ] }));
}

