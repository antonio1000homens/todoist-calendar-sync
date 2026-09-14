import { createSign, randomUUID } from "node:crypto";
import { profileForTodoistProject, todoistProjectForToken } from "./config.js";
import { buildProjectMappingIndex, findProjectMappingComment, serializeMappingComment, type TodoistCommentRecord } from "./mapping-comments.js";
import type { CalendarEvent, GoogleCredentials, Mapping, Profile, TodoistTask } from "./types.js";

const CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3";
const TODOIST_ROOT = "https://api.todoist.com/api/v1";
const TODOIST_COMMENTS_ROOT = "https://api.todoist.com/api/v1/comments";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = new Error(`Provider request failed: ${response.status} ${response.url}`) as Error & { status: number; body: string };
    error.status = response.status;
    error.body = await response.text();
    throw error;
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
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
    const query = new URLSearchParams({
      showDeleted: "true",
      maxResults: "1",
      sharedExtendedProperty: `taskId=${taskId}`,
    });
    const response = await this.request<{ items?: CalendarEvent[] }>(`/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`);
    return response.items?.[0];
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

  async upsertEvent(event: CalendarEvent, existingId?: string): Promise<CalendarEvent> {
    const path = `/calendars/${encodeURIComponent(this.calendarId)}/events${existingId ? `/${encodeURIComponent(existingId)}` : ""}`;
    return this.request(path, { method: existingId ? "PUT" : "POST", body: JSON.stringify(event) });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.request<void>(`/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  }
}

export class Todoist {
  private readonly projectCommentCache = new Map<string, TodoistCommentRecord[]>();

  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}, comments = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return responseJson<T>(await fetch(`${comments ? TODOIST_COMMENTS_ROOT : TODOIST_ROOT}${path}`, { ...init, headers }));
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
    return comments.find((comment) => String(comment.content || "").includes(`calendarEventId=${eventId}`));
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
  async upsertComment(taskId: string, content: string, existingId?: string): Promise<{ id: string }> {
    const projectId = todoistProjectForToken(this.token);
    const profile = profileForTodoistProject(projectId);
    if (!projectId || !profile) throw new Error("Todoist mapping project is not configured for this token");
    const { eventId, calendarUrl } = this.legacyCommentFields(content);
    const comments = await this.listProjectComments(projectId);
    const index = buildProjectMappingIndex(comments);
    const existing = findProjectMappingComment(index, { taskId, eventId, projectCommentId: existingId });
    const revision = Math.max(0, existing?.payload.mappingRevision || 0) + 1;
    const mapping: Mapping = {
      profile,
      projectId,
      taskId,
      eventId,
      mappingRevision: revision,
      updatedAt: new Date().toISOString(),
    };
    const projectComment = await this.upsertProjectComment(
      projectId,
      serializeMappingComment(mapping, projectId, calendarUrl, revision),
      existing?.comment.id,
    );
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
