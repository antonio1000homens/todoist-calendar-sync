import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { normalizedText } from "./security.js";
import type { CalendarEvent, Profile, TodoistTask } from "./types.js";

export type CanonicalIdentitySide = "calendar" | "todoist";

export interface CanonicalIdentity {
  normalizedTitle: string;
  normalizedStart: string;
  allDay: boolean;
}

export interface CanonicalIdentityRecord {
  profile: Profile;
  side: CanonicalIdentitySide;
  providerId: string;
  identity: CanonicalIdentity;
  updatedAt: string;
}

export interface CanonicalTodoistDue {
  date?: string | null;
  datetime?: string | null;
  timezone?: string | null;
}

const DEFAULT_RETENTION_DAYS = 90;

function hasOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function localDateTime(value: string, timeZone: string): string {
  if (!hasOffset(value)) return value.slice(0, 19);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 19);
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function timedIdentity(value: string, timeZone?: string | null): string {
  return localDateTime(value, timeZone || "Europe/London");
}

export function calendarCanonicalIdentity(event: CalendarEvent): CanonicalIdentity | undefined {
  const title = normalizedText(event.summary).toLowerCase();
  const date = event.start?.date;
  const dateTime = event.start?.dateTime;
  if (!title || (!date && !dateTime)) return undefined;
  if (date && !dateTime) {
    return { normalizedTitle: title, normalizedStart: date.slice(0, 10), allDay: true };
  }
  if (!dateTime) return undefined;
  return {
    normalizedTitle: title,
    normalizedStart: timedIdentity(dateTime, event.start?.timeZone),
    allDay: false,
  };
}

export function todoistCanonicalIdentityFromFields(content: string | undefined, due: CanonicalTodoistDue | null | undefined): CanonicalIdentity | undefined {
  const title = normalizedText(content).toLowerCase();
  const dateTime = due?.datetime || (due?.date?.includes("T") ? due.date : undefined);
  const date = due?.date;
  if (!title || (!date && !dateTime)) return undefined;
  if (date && !dateTime) {
    return { normalizedTitle: title, normalizedStart: date.slice(0, 10), allDay: true };
  }
  if (!dateTime) return undefined;
  return {
    normalizedTitle: title,
    normalizedStart: timedIdentity(dateTime, due?.timezone),
    allDay: false,
  };
}

export function todoistCanonicalIdentity(task: TodoistTask | undefined): CanonicalIdentity | undefined {
  if (!task) return undefined;
  return todoistCanonicalIdentityFromFields(task.content, task.due);
}

export function sameCanonicalIdentity(a: CanonicalIdentity | undefined, b: CanonicalIdentity | undefined): boolean {
  return Boolean(a && b
    && a.normalizedTitle === b.normalizedTitle
    && a.normalizedStart === b.normalizedStart
    && a.allDay === b.allDay);
}

function identityKey(profile: Profile, side: CanonicalIdentitySide, providerId: string): { pk: string; sk: string } {
  return { pk: `CANONICAL#${profile}#${side}#${providerId}`, sk: "STATE" };
}

function retentionDays(): number {
  const configured = Number(process.env.TODOIST_CALENDAR_SYNC_CANONICAL_IDENTITY_RETENTION_DAYS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
}

export interface CanonicalIdentityRepository {
  get(profile: Profile, side: CanonicalIdentitySide, providerId: string): Promise<CanonicalIdentityRecord | undefined>;
  put(profile: Profile, side: CanonicalIdentitySide, providerId: string, identity: CanonicalIdentity): Promise<void>;
}

export class CanonicalIdentityStore implements CanonicalIdentityRepository {
  private readonly table = process.env.STATE_TABLE_NAME || "";

  async get(profile: Profile, side: CanonicalIdentitySide, providerId: string): Promise<CanonicalIdentityRecord | undefined> {
    if (!this.table) return undefined;
    const result = await documentClient.send(new GetCommand({
      TableName: this.table,
      Key: identityKey(profile, side, providerId),
      ConsistentRead: true,
    }));
    if (!result.Item?.identity) return undefined;
    return {
      profile,
      side,
      providerId,
      identity: result.Item.identity as CanonicalIdentity,
      updatedAt: String(result.Item.updatedAt || ""),
    };
  }

  async put(profile: Profile, side: CanonicalIdentitySide, providerId: string, identity: CanonicalIdentity): Promise<void> {
    if (!this.table) return;
    const updatedAt = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + retentionDays() * 24 * 60 * 60;
    await documentClient.send(new PutCommand({
      TableName: this.table,
      Item: {
        ...identityKey(profile, side, providerId),
        profile,
        side,
        providerId,
        identity,
        updatedAt,
        expiresAt,
      },
    }));
  }
}
