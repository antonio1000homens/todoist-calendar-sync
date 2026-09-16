import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Profile } from "./types.js";

export const PROFILE_LOOKUP_INDEX_NAME = "ProfileLookupIndex";
export const PROFILE_LOOKUP_READY_KEY = "SYSTEM#PROFILE_LOOKUP_INDEX";
export const PROFILE_LOOKUP_READY_SORT_KEY = "READY";
export const PROFILE_LOOKUP_MIGRATION_VERSION = 1;

export function profileLookupPk(profile: Profile): string {
  return `PROFILE#${profile}`;
}

export function mappingLookupSk(kind: "event" | "task" | "owner", id: string): string {
  return `MAPPING#${kind.toUpperCase()}#${id}`;
}

export function recurrenceLookupSk(seriesId: string): string {
  return `RECURRENCE#${seriesId}`;
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
