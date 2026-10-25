import { createSign, randomUUID } from "node:crypto";
import { profileForTodoistProject, todoistProjectForToken } from "./config.js";
import { buildProjectMappingIndex, findProjectMappingComment, recoverMappingFromProjectComment, serializeMappingComment, LEGACY_TASK_COMMENT_MARKERS, type TodoistCommentRecord } from "./mapping-comments.js";
import type { CalendarEvent, GoogleCredentials, Mapping, Profile, TodoistTask } from "./types.js";

const CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3";
const TODOIST_ROOT = "https://api.todoist.com/api/v1";
const TODOIST_COMMENTS_ROOT = "https://api.todoist.com/api/v1/comments";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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

  async findByTodoistTaskId(taskId: string): Promise<CalendarEvent | undefined> {
    // The first Google result is not necessarily the active projection. Its
    // ordering is unspecified, and showDeleted can return old cancelled copies.
    // Never silently pick a candidate that could delete or overwrite another.
    const query = new URLSearchParams({
      showDeleted: "true",
      maxResults: "2500",
      sharedExtendedProperty: `taskId=${taskId}`,
    });
    const found = new Map<string, CalendarEvent>();
    let pages = 0;
    while (true) {
      if (++pages > 20) throw new Error("Calendar task link lookup exceeded page limit");
      const response = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`,
      );
      for (const event of response.items || []) {
        found.set(event.id, event);
        if (found.size > 10000) throw new Error("Calendar task link lookup exceeded candidate limit");
      }
      if (!response.nextPageToken) break;
      query.set("pageToken", response.nextPageToken);
    }
    return selectLinkedCalendarEvent(taskId, [...found.values()]);
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
    const tasks: TodoistTask[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams();
      if (projectId) query.set("project_id", projectId);
      if (cursor) query.set("cursor", cursor);
      const suffix = query.size ? `?${query}` : "";
      const page = await this.request<{ results?: TodoistTask[]; next_cursor?: string }>(`/tasks${suffix}`);
      tasks.push(...(page.results || []));
      cursor = page.next_cursor || undefined;
    } while (cursor);
    return tasks;
  }

  async getTask(taskId: string): Promise<TodoistTask> {
    return this.request<TodoistTask>(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async upsertTask(task: Omit<TodoistTask, "id">, existingId?: string): Promise<TodoistTask> {
    const path = existingId ? `/tasks/${encodeURIComponent(existingId)}` : "/tasks";
    const projectId = todoistProjectForToken(this.token);
    const payload = todoistTaskPayload(existingId ? task : { ...task, ...(task.project_id || !projectId ? {} : { project_id: projectId }) });
    if (existingId) delete payload.project_id;
    return this.request<TodoistTask>(path, { method: "POST", body: JSON.stringify(payload) });
  }

  async createTaskOnce(task: Omit<TodoistTask, "id">, requestKey: string): Promise<TodoistTask> {
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
    const comments: TodoistCommentRecord[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ project_id: projectId });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<{ results?: TodoistCommentRecord[]; next_cursor?: string }>(`?${query}`, {}, true);
      comments.push(...(page.results || []));
      cursor = page.next_cursor || undefined;
    } while (cursor);
    this.projectCommentCache.set(projectId, comments.slice());
    return comments;
  }

  async listTaskComments(taskId: string): Promise<TodoistCommentRecord[]> {
    const comments: TodoistCommentRecord[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ task_id: taskId });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<{ results?: TodoistCommentRecord[]; next_cursor?: string }>(`?${query}`, {}, true);
      comments.push(...(page.results || []));
      cursor = page.next_cursor || undefined;
    } while (cursor);
    return comments;
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
