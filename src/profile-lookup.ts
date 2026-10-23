import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Mapping, Profile, RecurrenceLink } from "./types.js";
import { logEvent } from "./observability.js";

export const PROFILE_LOOKUP_INDEX_NAME = "ProfileLookupIndex";
export const PROFILE_LOOKUP_READY_KEY = "SYSTEM#PROFILE_LOOKUP_INDEX";
export const PROFILE_LOOKUP_READY_SORT_KEY = "READY";
export const PROFILE_LOOKUP_MIGRATION_VERSION = 3;
export const MANUAL_PENDING_LOOKUP_PREFIX = "MANUAL#PENDING#";

export interface ProfileLookupParity {
  missing: string[];
  unexpected: string[];
}

export function profileLookupParity(expected: Set<string>, actual: Set<string>): ProfileLookupParity {
  return {
    missing: [...expected].filter((identity) => !actual.has(identity)),
    unexpected: [...actual].filter((identity) => !expected.has(identity)),
  };
}

type TerminalReviewCase = {
  id?: unknown;
  profile?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  result?: unknown;
  decision?: { decisionId?: unknown };
};
type PendingManualDecision = {
  decisionId?: unknown;
  profile?: unknown;
  status?: unknown;
};

/**
 * A terminal review case is authoritative only for the same decision ID and
 * profile. Orphaned operational decisions remain pending for operator review.
 */
export function terminalManualDecisionRepair(
  reviewCase: TerminalReviewCase | undefined,
  manual: PendingManualDecision,
): { decisionId: string; profile: Profile; caseStatus: "dismissed" | "resolved" | "excluded"; caseUpdatedAt: string; resolution: string } | undefined {
  if (!reviewCase || manual.status !== "pending"
    || typeof manual.decisionId !== "string" || typeof manual.profile !== "string"
    || reviewCase.id !== manual.decisionId || reviewCase.profile !== manual.profile
    || (reviewCase.decision?.decisionId !== undefined && reviewCase.decision.decisionId !== manual.decisionId)
    || !["dismissed", "resolved", "excluded"].includes(String(reviewCase.status))
    || typeof reviewCase.updatedAt !== "string") return undefined;
  const profile = manual.profile;
  if (profile !== "home" && profile !== "antonio" && profile !== "work") return undefined;
  const caseStatus = reviewCase.status as "dismissed" | "resolved" | "excluded";
  const resolution = typeof reviewCase.result === "string" && reviewCase.result.trim()
    ? reviewCase.result : `Closed from review as ${caseStatus}`;
  return { decisionId: manual.decisionId, profile, caseStatus, caseUpdatedAt: reviewCase.updatedAt, resolution };
}

/** Conditional transaction keeps a stale pending row from outliving its terminal case. */
export function terminalManualDecisionRepairItems(tableName: string, repair: NonNullable<ReturnType<typeof terminalManualDecisionRepair>>) {
  return [
    { Update: {
      TableName: tableName,
      Key: { pk: `MANUAL#${repair.decisionId}`, sk: "STATE" },
      UpdateExpression: "SET #status = :resolved, resolution = :resolution, resolvedAt = :resolvedAt REMOVE lookupPk, lookupSk",
      ConditionExpression: "#status = :pending AND profile = :profile AND (attribute_not_exists(decisionId) OR decisionId = :decisionId)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pending": "pending", ":resolved": "resolved", ":profile": repair.profile,
        ":decisionId": repair.decisionId, ":resolution": repair.resolution, ":resolvedAt": repair.caseUpdatedAt,
      },
    } },
    { ConditionCheck: {
      TableName: tableName,
      Key: { pk: `REVIEW_CASE#${repair.decisionId}`, sk: "STATE" },
      ConditionExpression: "#status = :caseStatus AND profile = :profile AND id = :decisionId AND updatedAt = :caseUpdatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":caseStatus": repair.caseStatus, ":profile": repair.profile,
        ":decisionId": repair.decisionId, ":caseUpdatedAt": repair.caseUpdatedAt,
      },
    } },
  ];
}

export function profileLookupPk(profile: Profile): string {
  return `PROFILE#${profile}`;
}

export function mappingLookupSk(kind: "event" | "task" | "owner", id: string): string {
  return `MAPPING#${kind.toUpperCase()}#${id}`;
}

export function recurrenceLookupSk(seriesId: string): string {
  return `RECURRENCE#${seriesId}`;
}

export function manualPendingLookupAttributes(input: Pick<{ profile: Profile; decisionId: string; createdAt: string }, "profile" | "decisionId" | "createdAt">): Record<string, string> {
  return {
    lookupPk: profileLookupPk(input.profile),
    lookupSk: `${MANUAL_PENDING_LOOKUP_PREFIX}${input.createdAt}#${input.decisionId}`,
  };
}

export function profileLookupBackfillCondition(lookup: { lookupSk: string }): {
  expression: string;
  names?: Record<string, string>;
  values: Record<string, string>;
} {
  const base = "attribute_exists(pk) AND attribute_exists(sk) AND attribute_not_exists(lookupPk) AND attribute_not_exists(lookupSk)";
  if (!lookup.lookupSk.startsWith(MANUAL_PENDING_LOOKUP_PREFIX)) {
    return { expression: base, values: {} };
  }
  return {
    expression: `${base} AND #status = :pending`,
    names: { "#status": "status" },
    values: { ":pending": "pending" },
  };
}

export function mappingLookupAttributes(mapping: Pick<Mapping, "profile" | "eventId" | "taskId">): Record<string, string> {
  return {
    lookupPk: profileLookupPk(mapping.profile),
    lookupSk: mappingLookupSk("task", mapping.taskId),
  };
}

export function mappingEventLookupAttributes(mapping: Pick<Mapping, "profile" | "eventId">): Record<string, string> {
  return {
    lookupPk: profileLookupPk(mapping.profile),
    lookupSk: mappingLookupSk("event", mapping.eventId),
  };
}

export function mappingOwnerLookupAttributes(mapping: Pick<Mapping, "profile" | "taskId">): Record<string, string> {
  return {
    lookupPk: profileLookupPk(mapping.profile),
    lookupSk: mappingLookupSk("owner", mapping.taskId),
  };
}

export function recurrenceLookupAttributes(link: Pick<RecurrenceLink, "profile" | "seriesId">): Record<string, string> {
  return {
    lookupPk: profileLookupPk(link.profile),
    lookupSk: recurrenceLookupSk(link.seriesId),
  };
}

export function mappingLookupQueryInput(tableName: string, profile: Profile): Record<string, unknown> {
  return {
    TableName: tableName,
    IndexName: PROFILE_LOOKUP_INDEX_NAME,
    KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
    ExpressionAttributeValues: { ":lookupPk": profileLookupPk(profile), ":lookupSk": mappingLookupSk("task", "") },
  };
}

export function recurrenceLookupQueryInput(tableName: string, profile: Profile): Record<string, unknown> {
  return {
    TableName: tableName,
    IndexName: PROFILE_LOOKUP_INDEX_NAME,
    KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
    ExpressionAttributeValues: { ":lookupPk": profileLookupPk(profile), ":lookupSk": "RECURRENCE#" },
  };
}

interface ProfileLookupQueryOptions {
  client: { send: (command: any) => Promise<any> };
  profile: Profile;
  operation: string;
  component: string;
  queryInput: Record<string, unknown>;
}

export async function readProfileLookup<T>(options: ProfileLookupQueryOptions): Promise<T[]> {
  const startedAt = Date.now();
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  let evaluatedCount = 0;
  let consumedCapacityUnits = 0;

  do {
    const result = await options.client.send(new QueryCommand({
      ...options.queryInput,
      ExclusiveStartKey: exclusiveStartKey,
    } as any));
    pages += 1;
    evaluatedCount += Number(result.ScannedCount || 0);
    consumedCapacityUnits += Number(result.ConsumedCapacity?.CapacityUnits || 0);
    items.push(...((result.Items || []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  logEvent("dynamodb_query_complete", {
    operation: options.operation,
    profile: options.profile,
    accessMethod: "query",
    pages,
    returnedCount: items.length,
    evaluatedCount,
    consumedCapacityUnits,
    durationMs: Date.now() - startedAt,
  }, options.component);
  return items;
}
