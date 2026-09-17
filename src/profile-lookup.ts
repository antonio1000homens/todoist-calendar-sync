import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Mapping, Profile, RecurrenceLink } from "./types.js";
import { logEvent } from "./observability.js";

export const PROFILE_LOOKUP_INDEX_NAME = "ProfileLookupIndex";
export const PROFILE_LOOKUP_READY_KEY = "SYSTEM#PROFILE_LOOKUP_INDEX";
export const PROFILE_LOOKUP_READY_SORT_KEY = "READY";
export const PROFILE_LOOKUP_MIGRATION_VERSION = 1;

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

export function profileLookupPk(profile: Profile): string {
  return `PROFILE#${profile}`;
}

export function mappingLookupSk(kind: "event" | "task" | "owner", id: string): string {
  return `MAPPING#${kind.toUpperCase()}#${id}`;
}

export function recurrenceLookupSk(seriesId: string): string {
  return `RECURRENCE#${seriesId}`;
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

export async function profileLookupIndexReady(
  client: { send: (command: any) => Promise<any> },
  tableName: string,
): Promise<boolean> {
  const result = await client.send(new GetCommand({
    TableName: tableName,
    Key: { pk: PROFILE_LOOKUP_READY_KEY, sk: PROFILE_LOOKUP_READY_SORT_KEY },
    ConsistentRead: true,
  }));
  return result.Item?.ready === true && result.Item.version === PROFILE_LOOKUP_MIGRATION_VERSION;
}

interface ProfileLookupQueryOptions {
  client: { send: (command: any) => Promise<any> };
  tableName: string;
  profile: Profile;
  operation: string;
  component: string;
  queryInput: Record<string, unknown>;
  fallback: () => Promise<unknown[]>;
}

export async function readProfileLookup<T>(options: ProfileLookupQueryOptions): Promise<T[]> {
  if (!await profileLookupIndexReady(options.client, options.tableName)) {
    return (await options.fallback()) as T[];
  }

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
