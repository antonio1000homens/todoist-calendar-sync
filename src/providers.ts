import { createSign, randomUUID } from "node:crypto";
import { profileForTodoistProject, todoistProjectForToken } from "./config.js";
import { buildProjectMappingIndex, findProjectMappingComment, recoverMappingFromProjectComment, serializeMappingComment, LEGACY_TASK_COMMENT_MARKERS, type TodoistCommentRecord } from "./mapping-comments.js";
import type { CalendarEvent, GoogleCredentials, Mapping, Profile, TodoistTask } from "./types.js";

const CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3";
const TODOIST_ROOT = "https://api.todoist.com/api/v1";
const TODOIST_COMMENTS_ROOT = "https://api.todoist.com/api/v1/comments";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_ERASURE_AUDIT_PROJECTS=2048;
const MAX_ERASURE_AUDIT_COMMENTS=100000;
export type TodoistProjectCommentAudit={
  projects:Array<{id:string;workspaceId?:number}>;
  comments:TodoistCommentRecord[];
};

async function listTodoistCommentPages(
  readPage:(cursor?:string)=>Promise<{results?:TodoistCommentRecord[];next_cursor?:unknown}>,
  resource:string,
):Promise<TodoistCommentRecord[]> {
  const comments=new Map<string,TodoistCommentRecord>();
  const seenCursors=new Set<string>();
  let cursor:string|undefined;
  for(let page=0;page<1000;page++) {
    const result=await readPage(cursor);
    if(!result||!Array.isArray(result.results))
      throw new Error("Todoist "+resource+" comment inventory returned invalid results");
    for(const comment of result.results) {
      if(!comment||typeof comment.id!=="string"||!comment.id)
        throw new Error("Todoist "+resource+" comment inventory returned an unidentified comment");
      const previous=comments.get(comment.id);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(comment))
        throw new Error("Todoist "+resource+" comment changed during pagination");
      comments.set(comment.id,comment);
      if(comments.size>50000)
        throw new Error("Todoist "+resource+" comment inventory exceeded the result limit");
    }
    const next=result.next_cursor;
    if(next===undefined||next===null||next==="")return [...comments.values()];
    if(typeof next!=="string"||seenCursors.has(next))
      throw new Error("Todoist "+resource+" comment inventory returned a repeated/invalid cursor");
    seenCursors.add(next);
    cursor=next;
  }
  throw new Error("Todoist "+resource+" comment inventory exceeded the page limit");
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    const detail = body.trim().replace(/\s+/g, " ").slice(0, 500);
    const error = new Error(`Provider request failed: ${response.status} ${response.url}${detail ? ` — ${detail}` : ""}`) as Error & { status: number; body: string };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

/**
 * A task ID can occur on several live, legacy or cancelled Calendar
 * projections. This is a safety boundary: callers must not mutate a guessed
 * winner, especially if an intentional Calendar deletion is involved.
 */
export class AmbiguousCalendarLinkError extends Error {
  readonly code = "ambiguous_calendar_task_link";
  readonly eventIds: string[];

  constructor(readonly taskId: string, candidates: CalendarEvent[]) {
    super("Multiple Calendar projections reference the same Todoist task");
    this.name = "AmbiguousCalendarLinkError";
    this.eventIds = candidates.map((event) => event.id).sort();
  }
}

export function selectLinkedCalendarEvent(taskId: string, candidates: CalendarEvent[]): CalendarEvent | undefined {
  const distinct = [...new Map(candidates.map((event) => [event.id, event])).values()];
  if (distinct.length === 0) return undefined;
  // Even a cancelled + confirmed pair is ambiguous about user intent. Do not
  // resurrect deleted projections or silently migrate to a different event.
  if (distinct.length > 1) throw new AmbiguousCalendarLinkError(taskId, distinct);
  return distinct[0];
}

export class GoogleCalendar {
  private accessToken?: string;

  constructor(private readonly credentials: GoogleCredentials, private readonly calendarId: string) {}

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const body = "private_key" in this.credentials
      ? new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: this.serviceAccountAssertion(),
        })
      : new URLSearchParams({
          client_id: this.credentials.client_id,
          client_secret: this.credentials.client_secret,
          refresh_token: this.credentials.refresh_token,
          grant_type: "refresh_token",
        });
    const tokenUrl = "private_key" in this.credentials ? this.credentials.token_uri || GOOGLE_TOKEN_URL : GOOGLE_TOKEN_URL;
    const response = await fetch(tokenUrl, { method: "POST", body });
    const result = await responseJson<{ access_token?: string }>(response);
    if (!result.access_token) throw new Error("Google token response did not include an access token");
    this.accessToken = result.access_token;
    return this.accessToken;
  }

  private serviceAccountAssertion(): string {
    if (!("private_key" in this.credentials)) throw new Error("Service account credentials are required");
    const tokenUrl = this.credentials.token_uri || GOOGLE_TOKEN_URL;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: this.credentials.client_email,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    signer.end();
    return `${input}.${signer.sign(this.credentials.private_key).toString("base64url")}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await this.token()}`);
    if (init.body) headers.set("content-type", "application/json");
    return responseJson<T>(await fetch(`${CALENDAR_ROOT}${path}`, { ...init, headers }));
  }

  async listDelta(syncToken?: string): Promise<{ items: CalendarEvent[]; nextSyncToken?: string }> {
    const query = new URLSearchParams({ showDeleted: "true", singleEvents: "false", maxResults: "2500" });
    if (syncToken) query.set("syncToken", syncToken);
    const items: CalendarEvent[] = [];
    do {
      const response = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`,
      );
      items.push(...(response.items || []));
      if (response.nextPageToken) query.set("pageToken", response.nextPageToken);
      else return { items, nextSyncToken: response.nextSyncToken };
    } while (true);
  }

  /**
   * Return every Calendar event tagged with an exact Todoist task ID, including
   * cancelled records and explicit recurrence overrides. This is OBSERVATION,
   * not a comprehensive proof of identity or deletion: legacy untagged events,
   * recurrence master/instance relationships and cross-profile provenance
   * still require independent reads.
   */
  async listLinkedEventsByTodoistTaskId(taskId: string): Promise<CalendarEvent[]> {
    if (!/^[A-Za-z0-9_.-]{1,1024}$/.test(taskId))
      throw new Error("Calendar alias inventory requires an exact Todoist task ID");
    const query = new URLSearchParams({
      showDeleted: "true",
      singleEvents: "false",
      maxResults: "2500",
      sharedExtendedProperty: `taskId=${taskId}`,
    });
    const found = new Map<string, CalendarEvent>();
    const seenTokens = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`,
      );
      if (response.items !== undefined && !Array.isArray(response.items))
        throw new Error("Calendar linked-event inventory returned invalid items");
      for (const event of response.items || []) {
        if (!event || typeof event.id !== "string" || !event.id)
          throw new Error("Calendar linked-event inventory returned unidentified event");
        const previous = found.get(event.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event))
          throw new Error("Calendar linked-event inventory changed during pagination");
        found.set(event.id,event);
        if (found.size > 10000) throw new Error("Calendar task link lookup exceeded candidate limit");
      }
      const next = response.nextPageToken;
      if (next === undefined) return [...found.values()];
      if (typeof next !== "string" || !next || seenTokens.has(next))
        throw new Error("Calendar linked-event inventory returned repeated/invalid pagination token");
      seenTokens.add(next);
      query.set("pageToken", next);
    }
    throw new Error("Calendar task link lookup exceeded page limit");
  }

  /** Complete unfiltered Calendar event inventory for privileged read-only audits. */
  async listAllEventsForErasureAudit(): Promise<CalendarEvent[]> {
    const query=new URLSearchParams({showDeleted:"true",singleEvents:"false",maxResults:"2500"});
    const found=new Map<string,CalendarEvent>();
    const seenTokens=new Set<string>();
    for(let page=0;page<1000;page++) {
      const response=await this.request<{items?:CalendarEvent[];nextPageToken?:string}>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`,
      );
      if(response.items!==undefined&&!Array.isArray(response.items))
        throw new Error("Calendar full inventory returned invalid items");
      for(const event of response.items||[]) {
        if(!event||typeof event.id!=="string"||!/^[A-Za-z0-9_.-]{1,1024}$/.test(event.id))
          throw new Error("Calendar full inventory returned an unidentified event");
        const previous=found.get(event.id);
        if(previous&&JSON.stringify(previous)!==JSON.stringify(event))
          throw new Error("Calendar event changed during full inventory pagination");
        found.set(event.id,event);
        if(found.size>100000)throw new Error("Calendar full inventory exceeded the audit result limit");
      }
      const next=response.nextPageToken;
      if(next===undefined)return [...found.values()];
      if(typeof next!=="string"||!next||seenTokens.has(next))
        throw new Error("Calendar full inventory returned a repeated/invalid pagination token");
      seenTokens.add(next);
      query.set("pageToken",next);
    }
    throw new Error("Calendar full inventory exceeded the page limit");
  }

  async findByTodoistTaskId(taskId: string): Promise<CalendarEvent | undefined> {
    // Existing sync uses an exact UNIQUE candidate, never the first result.
    return selectLinkedCalendarEvent(taskId, await this.listLinkedEventsByTodoistTaskId(taskId));
  }

  /**
   * Read actual Calendar occurrences around a due date, including instances
   * of older recurring masters. A shared task-ID lookup alone cannot discover
   * an independently created duplicate series.
   */
  async listOccurrencesInWindow(start: string, end: string): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "2500",
      timeMin: start,
      timeMax: end,
    });
    const found = new Map<string, CalendarEvent>();
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`,
      );
      for (const event of response.items || []) {
        found.set(event.id, event);
        if (found.size > 10000) throw new Error("Calendar duplicate discovery exceeded candidate limit");
      }
      if (!response.nextPageToken) return [...found.values()];
      query.set("pageToken", response.nextPageToken);
    }
    throw new Error("Calendar duplicate discovery exceeded page limit");
  }

  async getTimeZone(): Promise<string> {
    const calendar = await this.request<{ timeZone?: string }>(
      `/calendars/${encodeURIComponent(this.calendarId)}`,
    );
    if (!calendar.timeZone) throw new Error("Calendar timezone is missing; cannot determine safe recurrence cutoff");
    try { new Intl.DateTimeFormat("en-GB", { timeZone: calendar.timeZone }); }
    catch { throw new Error("Calendar returned an invalid timezone"); }
    return calendar.timeZone;
  }

  /**
   * Google events.list(singleEvents=false,showDeleted=true) includes explicit
   * recurring overrides, independently of a time-limited instances expansion.
   * An incomplete or oversized calendar inventory fails closed. Only *explicit*
   * instances for this parent are returned.
   */
  async listExplicitSeriesExceptions(masterId: string): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({
      singleEvents: "false", showDeleted: "true", maxResults: "2500",
    });
    const found = new Map<string, CalendarEvent>();
    let examined = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`,
      );
      for (const item of result.items || []) {
        if (++examined > 10000) throw new Error("Calendar exception inventory exceeds safe limit");
        if (item.recurringEventId === masterId) found.set(item.id, item);
      }
      if (!result.nextPageToken) return [...found.values()];
      query.set("pageToken", result.nextPageToken);
    }
    throw new Error("Calendar exception inventory exceeded page limit");
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    return this.request(`/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  async listInstances(masterEventId: string, after?: string): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({ showDeleted: "true", maxResults: "2500" });
    if (after) query.set("timeMin", after);
    const items: CalendarEvent[] = [];
    do {
      const response = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(masterEventId)}/instances?${query}`,
      );
      items.push(...(response.items || []));
      if (response.nextPageToken) query.set("pageToken", response.nextPageToken);
      else return items;
    } while (true);
  }

  /**
   * Bounded complete instance observation for the #307 recovery audit. Unlike
   * date-windowed normal sync reads, this enumerates every page (including
   * cancellations and exceptions) and refuses oversized series.
   */
  async listEventInstances(masterId: string): Promise<CalendarEvent[]> {
    if (typeof masterId !== "string" || !/^[A-Za-z0-9_.-]{1,1024}$/.test(masterId))
      throw new Error("Calendar instance inventory requires an exact master ID");
    const query = new URLSearchParams({ showDeleted: "true", maxResults: "2500" });
    const found = new Map<string, CalendarEvent>();
    const seenTokens = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(masterId)}/instances?${query}`,
      );
      if (response.items !== undefined && !Array.isArray(response.items))
        throw new Error("Calendar instance inventory returned invalid items");
      for (const event of response.items || []) {
        if (!event || typeof event.id !== "string" || !/^[A-Za-z0-9_.-]{1,1024}$/.test(event.id)
          || event.recurringEventId !== masterId)
          throw new Error("Calendar instance inventory returned an unattributable instance");
        const previous = found.get(event.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event))
          throw new Error("Calendar instance inventory changed during pagination");
        found.set(event.id, event);
        if (found.size > 32) throw new Error("Calendar recurring series exceeds replay marker bound");
      }
      const next = response.nextPageToken;
      if (next === undefined) return [...found.values()];
      if (typeof next !== "string" || !next || seenTokens.has(next))
        throw new Error("Calendar instance inventory returned repeated/invalid pagination token");
      seenTokens.add(next);
      query.set("pageToken", next);
    }
    throw new Error("Calendar instance inventory exceeded page limit");
  }

  /** Bounded instance read: never expand an open-ended recurrence without limits. */
  async listInstancesInWindow(masterId: string, start: string, end: string): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({
      showDeleted: "true", maxResults: "2500", timeMin: start, timeMax: end,
    });
    const found = new Map<string, CalendarEvent>();
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(masterId)}/instances?${query}`,
      );
      for (const item of result.items || []) {
        found.set(item.id, item);
        if (found.size > 10000) throw new Error("Historical instance lookup exceeded the safe limit");
      }
      if (!result.nextPageToken) return [...found.values()];
      query.set("pageToken", result.nextPageToken);
    }
    throw new Error("Historical instance lookup exceeded the page limit");
  }

  /**
   * An explicitly addressed CREATE avoids duplicate masters after a partial
   * failure. An existing ID is a conflict unless it has the exact approved
   * task identity, rule, DTSTART and history marker.
   */
  async createFutureMasterOnce(event: CalendarEvent, historicalMasterId: string): Promise<CalendarEvent> {
    if (!/^[a-f0-9]{32}$/.test(event.id) || !historicalMasterId) {
      throw new Error("Future master needs a deterministic hexadecimal ID and history marker");
    }
    const valid = (candidate: CalendarEvent): boolean =>
      candidate.id === event.id && candidate.status === "confirmed"
      && candidate.start?.date === event.start?.date
      && JSON.stringify(candidate.recurrence) === JSON.stringify(event.recurrence)
      && candidate.extendedProperties?.shared?.taskId === event.extendedProperties?.shared?.taskId
      && candidate.extendedProperties?.shared?.syncHistoryMasterId === historicalMasterId;
    try {
      const created = await this.request<CalendarEvent>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events`,
        { method: "POST", body: JSON.stringify(event) },
      );
      if (!valid(created)) throw new Error("Created Calendar master does not match the approved future schedule");
      return created;
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 409) throw error;
      const existing = await this.getEvent(event.id);
      if (!valid(existing)) throw new Error("Deterministic Calendar ID belongs to a different series");
      return existing;
    }
  }

  async upsertEvent(event: CalendarEvent, existingId?: string): Promise<CalendarEvent> {
    const path = `/calendars/${encodeURIComponent(this.calendarId)}/events${existingId ? `/${encodeURIComponent(existingId)}` : ""}`;
    return this.request(path, { method: existingId ? "PUT" : "POST", body: JSON.stringify(event) });
  }

  /** Retry creation only for a deterministic event ID owned by this repair. */
  /** Mutate only a recurring master's metadata; never replace its recurrence or occurrences. */
  async patchEventMetadataIfUnchanged(
    masterId: string,
    etag: string,
    metadata: { summary: string; description: string },
  ): Promise<CalendarEvent> {
    if (!masterId || !etag) throw new Error("Recurring Calendar metadata update requires an ETag");
    return this.request(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(masterId)}`,
      { method: "PATCH", headers: { "If-Match": etag }, body: JSON.stringify(metadata) },
    );
  }

  async createRepairEventOnce(event: CalendarEvent, operationId: string): Promise<CalendarEvent> {
    if (!event.id || !operationId) throw new Error("Repair creation requires a deterministic event ID and operation ID");
    const desired = { ...event, extendedProperties: { ...event.extendedProperties, shared: { ...event.extendedProperties?.shared, syncRepairId: operationId } } };
    try { return await this.upsertEvent(desired); }
    catch (error) {
      if (Number((error as {status?: number}).status) !== 409) throw error;
      const existing = await this.getEvent(event.id);
      if (existing.extendedProperties?.shared?.syncRepairId !== operationId || existing.status === "cancelled") throw new Error("Deterministic repair event ID is owned by another object");
      return existing;
    }
  }

  /**
   * Manual resolution must never fall back to POST or resurrect a deleted
   * event. If it changes after approval, the If-Match update fails.
   */
  async upsertEventIfUnchanged(event: CalendarEvent, existingId: string, etag: string): Promise<CalendarEvent> {
    if (!existingId || !etag) throw new Error("Manual Calendar update requires existing event ID and ETag");
    return this.request(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(existingId)}`,
      { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify(event) },
    );
  }

  /** Patch only shared identity keys on one exact event or recurring instance. */
  async updateSharedEventPropertiesIfUnchanged(
    eventId: string,
    etag: string,
    shared: Record<string, string | null>,
  ): Promise<CalendarEvent> {
    if (!eventId || !etag || !Object.keys(shared).length) throw new Error("Manual Calendar metadata update requires an exact event ID, ETag, and properties");
    return this.request(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "PATCH", headers: { "If-Match": etag }, body: JSON.stringify({ extendedProperties: { shared } }) },
    );
  }

  async deleteEvent(eventId: string, etag?: string): Promise<void> {
    await this.request<void>(`/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE", ...(etag ? { headers: { "If-Match": etag } } : {}),
    });
  }

  /** Delete only the exact Calendar version approved by a repair preview. */
  async deleteEventIfUnchanged(eventId: string, etag: string): Promise<void> {
    if (!eventId || !etag) throw new Error("Manual Calendar deletion requires an exact event ID and ETag");
    await this.request<void>(`/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE", headers: { "If-Match": etag },
    });
  }

  async watch(channelId: string, address: string, token: string): Promise<{ resourceId: string; expiration: string }> {
    return this.request(`/calendars/${encodeURIComponent(this.calendarId)}/events/watch`, {
      method: "POST",
      body: JSON.stringify({ id: channelId, type: "web_hook", address, token }),
    });
  }

  async stopWatch(channelId: string, resourceId: string): Promise<void> {
    await this.request<void>("/channels/stop", {
      method: "POST",
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  }
}

export class Todoist {
  private readonly projectCommentCache = new Map<string, TodoistCommentRecord[]>();

  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}, comments = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("content-type", "application/json");
    const url = `${comments ? TODOIST_COMMENTS_ROOT : TODOIST_ROOT}${path}`;
    const readOnly = (init.method || "GET").toUpperCase() === "GET";
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await responseJson<T>(await fetch(url, { ...init, headers }));
      } catch (error) {
        const status = Number((error as { status?: number }).status);
        const transient = !status || status === 408 || status === 429 || status >= 500;
        if (!readOnly || !transient || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
      }
    }
  }

  private async syncCommand(type: string, args: Record<string, unknown>): Promise<void> {
    const uuid = randomUUID();
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    headers.set("content-type", "application/x-www-form-urlencoded");
    const body = new URLSearchParams({
      commands: JSON.stringify([{ type, uuid, args }]),
    });
    const result = await responseJson<{ sync_status?: Record<string, unknown> }>(
      await fetch(`${TODOIST_ROOT}/sync`, { method: "POST", headers, body }),
    );
    const status = result.sync_status?.[uuid];
    if (status !== "ok") {
      throw new Error(`Todoist sync command ${type} failed: ${JSON.stringify(status)}`);
    }
  }

  /** Read only the configured account timezone. Never retain or log the user resource. */
  async getTimeZone(): Promise<string> {
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    headers.set("content-type", "application/x-www-form-urlencoded");
    const body = new URLSearchParams({ sync_token: "*", resource_types: JSON.stringify(["user"]) });
    const result = await responseJson<{ user?: { timezone?: string; tz_info?: { timezone?: string } } }>(
      await fetch(`${TODOIST_ROOT}/sync`, { method: "POST", headers, body }),
    );
    const timeZone = result?.user?.tz_info?.timezone || result?.user?.timezone;
    if (!timeZone) throw new Error("Todoist account timezone is missing");
    try { new Intl.DateTimeFormat("en-GB", { timeZone }); }
    catch { throw new Error("Todoist account timezone is invalid"); }
    return timeZone;
  }

  async listTasks(projectId = todoistProjectForToken(this.token)): Promise<TodoistTask[]> {
    return this.readTasks(projectId);
  }

  /** Paginate the complete active-task collection for a read-only identity audit. */
  async listAllTasksForErasureAudit(): Promise<TodoistTask[]> {
    return this.readTasks(undefined);
  }

  private async readTasks(projectId?:string): Promise<TodoistTask[]> {
    const tasks=new Map<string,TodoistTask>();
    const seenCursors=new Set<string>();
    let cursor:string|undefined;
    for(let pageNumber=0;pageNumber<1000;pageNumber++) {
      const query = new URLSearchParams();
      if (projectId) query.set("project_id", projectId);
      if (cursor) query.set("cursor", cursor);
      const suffix = query.size ? `?${query}` : "";
      const page = await this.request<{ results?: TodoistTask[]; next_cursor?: string }>(`/tasks${suffix}`);
      if(!page||!Array.isArray(page.results))throw new Error("Todoist task inventory returned invalid results");
      for(const task of page.results) {
        if(!task||typeof task.id!=="string"||!task.id)
          throw new Error("Todoist task inventory returned an unidentified task");
        const previous=tasks.get(task.id);
        if(previous&&JSON.stringify(previous)!==JSON.stringify(task))
          throw new Error("Todoist task changed during inventory pagination");
        tasks.set(task.id,task);
        if(tasks.size>100000)throw new Error("Todoist task inventory exceeded the audit result limit");
      }
      const next=page.next_cursor;
      if(next===undefined||next===null||next==="")return [...tasks.values()];
      if(typeof next!=="string"||seenCursors.has(next))
        throw new Error("Todoist task inventory returned a repeated/invalid cursor");
      seenCursors.add(next);cursor=next;
    }
    throw new Error("Todoist task inventory exceeded the page limit");
  }

  async getTask(taskId: string): Promise<TodoistTask> {
    return this.request<TodoistTask>(`/tasks/${encodeURIComponent(taskId)}`);
  }

  // sourceEventIds is a trusted, provider-read Calendar provenance hint for the
  // replay-admission wrapper; it is never sent to Todoist's /tasks API.
  async upsertTask(task: Omit<TodoistTask, "id">, existingId?: string, sourceEventIds?: readonly string[]): Promise<TodoistTask> {
    const path = existingId ? `/tasks/${encodeURIComponent(existingId)}` : "/tasks";
    const projectId = todoistProjectForToken(this.token);
    const payload = todoistTaskPayload(existingId ? task : { ...task, ...(task.project_id || !projectId ? {} : { project_id: projectId }) });
    if (existingId) delete payload.project_id;
    return this.request<TodoistTask>(path, { method: "POST", body: JSON.stringify(payload) });
  }

  /** Modify only metadata; including due here could restart Todoist's native recurrence. */
  async updateTaskMetadata(taskId: string, metadata: { content: string; description: string }): Promise<TodoistTask> {
    await this.request(`/tasks/${encodeURIComponent(taskId)}`, {
      method: "POST", body: JSON.stringify(metadata),
    });
    return this.getTask(taskId);
  }

  // requestKey is an idempotency token, NOT an erasure identity. The replay
  // wrapper admits creation only when sourceEventIds are supplied and checked.
  async createTaskOnce(task: Omit<TodoistTask, "id">, requestKey: string, sourceEventIds?: readonly string[]): Promise<TodoistTask> {
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(requestKey).digest("hex");
    const uuid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
    return this.request<TodoistTask>("/tasks", { method: "POST", headers: { "X-Request-Id": uuid },
      body: JSON.stringify(todoistTaskPayload({ ...task, project_id: task.project_id || todoistProjectForToken(this.token) })) });
  }

  async moveTask(taskId: string, projectId: string): Promise<void> {
    await this.syncCommand("item_move", { id: taskId, project_id: projectId });
  }

  async updateRecurringOccurrence(task: TodoistTask, occurrence: Omit<TodoistTask, "id">): Promise<TodoistTask> {
    const recurrence = task.due;
    const occurrenceDue = occurrence.due;
    const concreteDate = occurrenceDue?.datetime || occurrenceDue?.date;
    if (!recurrence?.is_recurring || !recurrence.string || !concreteDate) {
      throw new Error(`Cannot apply recurring occurrence to Todoist task ${task.id}`);
    }
    const due: Record<string, string> = {
      date: concreteDate,
      string: recurrence.string,
    };
    const timezone = occurrenceDue?.timezone || recurrence.timezone;
    if (timezone) due.timezone = timezone;
    if (recurrence.lang) due.lang = recurrence.lang;
    await this.syncCommand("item_update", {
      id: task.id,
      content: occurrence.content,
      description: occurrence.description || "",
      due,
    });
    return this.getTask(task.id);
  }

  async deleteTask(taskId: string): Promise<void> {
    const projectId = todoistProjectForToken(this.token);
    if (projectId) {
      const current = await this.getTask(taskId);
      if (current.project_id && current.project_id !== projectId) {
        const error = new Error(`Todoist task ${taskId} moved out of the Calendar-backed project`) as Error & { status: number };
        error.status = 404;
        throw error;
      }
    }
    await this.request<void>(`/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  }

  async listProjectComments(projectId: string, refresh = false): Promise<TodoistCommentRecord[]> {
    const cached = this.projectCommentCache.get(projectId);
    if (cached && !refresh) return cached.slice();
    const comments=await listTodoistCommentPages(async cursor=>{
      const query = new URLSearchParams({ project_id: projectId });
      if (cursor) query.set("cursor", cursor);
      return this.request<{ results?: TodoistCommentRecord[]; next_cursor?: string }>(`?${query}`, {}, true);
    },"project");
    this.projectCommentCache.set(projectId, comments.slice());
    return comments;
  }

  /**
   * Read project comments across the complete accessible project inventory,
   * including archived personal and workspace projects. Todoist's comments
   * endpoint requires exactly one project_id or task_id, so querying only the
   * configured sync project would miss provenance left after a project move.
   * Inaccessible archived workspace inventories fail closed.
   */
  async listAllProjectCommentsForErasureAudit():Promise<TodoistProjectCommentAudit> {
    const projects=new Map<string,number|null|undefined>();
    const addProject=(value:unknown,workspaceId?:number)=>{
      if(!value||typeof value!=="object")throw new Error("Todoist project audit returned an invalid project");
      const project=value as {id?:unknown;workspace_id?:unknown};
      if(typeof project.id!=="string"||!project.id)
        throw new Error("Todoist project audit returned a project without an ID");
      if(workspaceId!==undefined&&project.workspace_id!==undefined&&project.workspace_id!==workspaceId)
        throw new Error("Todoist archived project disagrees with its workspace inventory");
      const owner=workspaceId??(typeof project.workspace_id==="number"?project.workspace_id:
        project.workspace_id===null?null:undefined);
      const previous=projects.get(project.id);
      if(projects.has(project.id)&&previous!==undefined&&owner!==undefined&&previous!==owner)
        throw new Error("Todoist project audit found conflicting workspace ownership");
      if(!projects.has(project.id)||previous===undefined)projects.set(project.id,owner);
      if(projects.size>MAX_ERASURE_AUDIT_PROJECTS)
        throw new Error("Todoist project audit exceeded its bounded project inventory");
    };
    const readPages=async(path:string,resultKey:"results"|"workspace_projects",workspaceId?:number)=>{
      const seenCursors=new Set<string>();let cursor:string|undefined;
      for(let pageNumber=0;pageNumber<1000;pageNumber++) {
        const query=new URLSearchParams({limit:"200"});
        if(cursor)query.set("cursor",cursor);
        const page=await this.request<Record<string,unknown>>(`${path}?${query}`);
        const items=page?.[resultKey];
        if(!Array.isArray(items))throw new Error("Todoist project audit returned an invalid page");
        for(const project of items)addProject(project,workspaceId);
        const next=page.next_cursor;
        if(next===undefined||next===null||next==="")return;
        if(typeof next!=="string"||seenCursors.has(next))
          throw new Error("Todoist project audit returned a repeated/invalid cursor");
        seenCursors.add(next);cursor=next;
      }
      throw new Error("Todoist project audit exceeded its page limit");
    };

    await readPages("/projects","results");
    await readPages("/projects/archived","results");
    const workspaces=await this.request<unknown>("/workspaces");
    if(!Array.isArray(workspaces))throw new Error("Todoist workspace audit returned an invalid inventory");
    const workspaceIds=new Set<number>();
    for(const workspace of workspaces) {
      if(!workspace||typeof workspace!=="object"
        ||!Number.isSafeInteger((workspace as {id?:unknown}).id)
        ||Number((workspace as {id:number}).id)<=0)
        throw new Error("Todoist workspace audit returned an invalid workspace ID");
      workspaceIds.add(Number((workspace as {id:number}).id));
    }
    for(const workspaceId of workspaceIds)
      await readPages(`/workspaces/${workspaceId}/projects/archived`,"workspace_projects",workspaceId);

    const comments=new Map<string,TodoistCommentRecord>();
    for(const projectId of projects.keys()) {
      const projectComments=await this.listProjectComments(projectId,true);
      for(const comment of projectComments) {
        if(comment.project_id!==undefined&&comment.project_id!==projectId)
          throw new Error("Todoist project comment audit returned a comment for another project");
        const normalized={...comment,project_id:projectId};
        const previous=comments.get(comment.id);
        if(previous&&JSON.stringify(previous)!==JSON.stringify(normalized))
          throw new Error("Todoist project comment changed across project inventories");
        comments.set(comment.id,normalized);
        if(comments.size>MAX_ERASURE_AUDIT_COMMENTS)
          throw new Error("Todoist project comment audit exceeded its bounded result limit");
      }
    }
    return {
      projects:[...projects].map(([id,workspaceId])=>({id,...(typeof workspaceId==="number"?{workspaceId}:{})}))
        .sort((left,right)=>left.id.localeCompare(right.id)),
      comments:[...comments.values()],
    };
  }

  async listTaskComments(taskId: string): Promise<TodoistCommentRecord[]> {
    return listTodoistCommentPages(async cursor=>{
      const query = new URLSearchParams({ task_id: taskId });
      if (cursor) query.set("cursor", cursor);
      return this.request<{ results?: TodoistCommentRecord[]; next_cursor?: string }>(`?${query}`, {}, true);
    },"task");
  }

  async createProjectComment(projectId: string, content: string): Promise<TodoistCommentRecord> {
    const comment = await this.request<TodoistCommentRecord>("", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, content }),
    }, true);
    const cached = this.projectCommentCache.get(projectId);
    if (cached) cached.push({ ...comment, project_id: projectId, content });
    return comment;
  }

  async updateComment(commentId: string, content: string): Promise<TodoistCommentRecord> {
    const comment = await this.request<TodoistCommentRecord>(`/${encodeURIComponent(commentId)}`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }, true);
    for (const comments of this.projectCommentCache.values()) {
      const index = comments.findIndex((entry) => entry.id === commentId);
      if (index >= 0) comments[index] = { ...comments[index], ...comment, content };
    }
    return comment;
  }

  async upsertProjectComment(projectId: string, content: string, existingId?: string): Promise<TodoistCommentRecord> {
    if (existingId) {
      try {
        return await this.updateComment(existingId, content);
      } catch (error) {
        const providerError = error as { status?: number; body?: string };
        if (![400, 404].includes(Number(providerError.status)) || (providerError.status === 400 && !providerError.body?.includes("Comment is not yours"))) throw error;
      }
    }
    return this.createProjectComment(projectId, content);
  }

  async findLegacyTaskComment(taskId: string, eventId: string): Promise<TodoistCommentRecord | undefined> {
    const comments = await this.listTaskComments(taskId);
    return comments.find((comment) => {
      const lines = String(comment.content || "").split(/\r?\n/);
      return LEGACY_TASK_COMMENT_MARKERS.has(lines[0])
        && lines.includes(`calendarEventId=${eventId}`)
        && (!comment.task_id || comment.task_id === taskId);
    });
  }

  private legacyCommentFields(content: string): { eventId: string; calendarUrl?: string } {
    const eventId = content.match(/(?:^|\n)calendarEventId=([^\n\r]+)/)?.[1]?.trim();
    const calendarUrl = content.match(/(?:^|\n)calendarUrl=([^\n\r]*)/)?.[1]?.trim();
    if (!eventId) throw new Error("Mapping comment content is missing calendarEventId");
    return { eventId, ...(calendarUrl ? { calendarUrl } : {}) };
  }

  /**
   * Compatibility surface used by existing synchronizer paths. Despite the
   * historical name this now writes only project comments. Existing task
   * comments are migration fallback evidence and are never updated here.
   */
  async upsertComment(taskId: string, content: string, existingId?: string, mappingDetails?: Mapping, migrateFromEventId?: string): Promise<{ id: string }> {
    const projectId = todoistProjectForToken(this.token);
    const profile = profileForTodoistProject(projectId);
    if (!projectId || !profile) throw new Error("Todoist mapping project is not configured for this token");
    const { eventId, calendarUrl } = this.legacyCommentFields(content);
    const comments = await this.listProjectComments(projectId);
    const index = buildProjectMappingIndex(comments);
    let existing = findProjectMappingComment(index, { taskId, eventId, projectCommentId: existingId });
    if (!existing && migrateFromEventId) {
      // An approved series split replaces the mapping identity. Updating the
      // same versioned project comment avoids leaving an old-master mapping
      // breadcrumb that would later be discovered as a competing owner.
      const oldCandidates = (index.byTaskId.get(taskId) || []).filter((item) =>
        item.payload.eventId === migrateFromEventId
        && item.payload.profile === profile
        && item.payload.projectId === projectId);
      if (oldCandidates.length > 1 || oldCandidates.some((item) =>
        item.payload.recurrenceOwner === "calendar"
        || item.payload.completedThroughOriginalStart
        || item.payload.calendarProgressVersion)) {
        throw new Error("Cannot migrate conflicting or completed historical project mapping comment");
      }
      existing = oldCandidates[0];
    }
    const revision = Math.max(0, existing?.payload.mappingRevision || 0) + 1;
    const baseMapping: Mapping = {
      ...(mappingDetails || {}),
      profile,
      projectId,
      taskId,
      eventId,
      mappingRevision: revision,
      updatedAt: new Date().toISOString(),
    };
    const mapping = existing && !mappingDetails ? recoverMappingFromProjectComment(baseMapping, existing) : baseMapping;
    const serialized = serializeMappingComment(mapping, projectId, calendarUrl, revision);
    // A failed migration must not fall back to creating a second mapping
    // comment; that would leave conflicting old/new task identities.
    const projectComment = migrateFromEventId && existing?.payload.eventId === migrateFromEventId
      ? await this.updateComment(existing.comment.id, serialized)
      : await this.upsertProjectComment(projectId, serialized, existing?.comment.id);
    return { id: projectComment.id };
  }

  /**
   * Project comments are authoritative for provider-side discovery. Legacy
   * task comments are queried only when no v1 project mapping exists.
   */
  async findComment(taskId: string, eventId: string): Promise<{ id: string } | undefined> {
    const projectId = todoistProjectForToken(this.token);
    if (projectId) {
      const index = buildProjectMappingIndex(await this.listProjectComments(projectId));
      const projectComment = findProjectMappingComment(index, { taskId, eventId });
      if (projectComment) return { id: projectComment.comment.id };
    }
    const legacy = await this.findLegacyTaskComment(taskId, eventId);
    return legacy ? { id: legacy.id } : undefined;
  }

  async getComment(commentId: string): Promise<TodoistCommentRecord> {
    return this.request<TodoistCommentRecord>(`/${encodeURIComponent(commentId)}`, {}, true);
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.request<void>(`/${encodeURIComponent(commentId)}`, { method: "DELETE" }, true);
    for (const comments of this.projectCommentCache.values()) {
      const index = comments.findIndex((entry) => entry.id === commentId);
      if (index >= 0) comments.splice(index, 1);
    }
  }
}

export function todoistTaskPayload(task: Omit<TodoistTask, "id">): Record<string, string | null> {
  const payload: Record<string, string | null> = {
    content: task.content,
    description: task.description || "",
  };
  if (task.project_id) payload.project_id = task.project_id;
  if (task.due?.is_recurring && task.due.string) {
    payload.due_string = task.due.string;
    if (task.due.lang) payload.due_lang = task.due.lang;
    return payload;
  }
  if (task.due?.datetime) {
    payload.due_datetime = task.due.datetime;
    payload.due_timezone = task.due.timezone || "Europe/London";
  } else if (task.due?.date) {
    payload.due_date = task.due.date;
    payload.due_datetime = null;
    payload.due_timezone = null;
  } else {
    payload.due_date = null;
    payload.due_datetime = null;
    payload.due_timezone = null;
  }
  return payload;
}

export function calendarForProfile(credentials: GoogleCredentials, profile: Profile, calendarId: string): GoogleCalendar {
  void profile;
  return new GoogleCalendar(credentials, calendarId);
}
