import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, pacedScan } from "./dynamodb-capacity.js";
import { googleCredentials, profileForTodoistProject, profiles, todoistToken } from "./config.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import { GoogleCalendar, Todoist } from "./providers.js";
import { StateRepository } from "./repository.js";
import { normalizedText } from "./security.js";
import { hasCanonicalState, Synchronizer, toCalendarEvent, toTodoistTask } from "./sync.js";
import { logEvent } from "./observability.js";
import { mappingLookupSk, profileLookupIndexReady, profileLookupPk, PROFILE_LOOKUP_INDEX_NAME } from "./profile-lookup.js";
import type { CalendarEvent, Delivery, Mapping, Profile, ReconciliationContinuation, TodoistTask } from "./types.js";

interface TodoistCanonicalState {
  content: string;
  description: string;
  due: {
    date: string | null;
    datetime: string | null;
    timezone: string | null;
    isRecurring: boolean;
  } | null;
}

interface CalendarCanonicalState {
  status: string;
  summary: string;
  description: string;
  start: { date: string | null; dateTime: string | null; timeZone: string | null } | null;
}

export interface ReconciliationBaseline {
  todoist: TodoistCanonicalState;
  calendar: CalendarCanonicalState;
  updatedAt: string;
}

interface ReconciliationStore {
  listMappings(profile: Profile): Promise<Mapping[]>;
  getBaseline(profile: Profile, taskId: string): Promise<ReconciliationBaseline | undefined>;
  putBaseline(profile: Profile, taskId: string, task: TodoistTask, event: CalendarEvent): Promise<void>;
  deleteBaseline(profile: Profile, taskId: string): Promise<void>;
}

type ClientPair = { calendar: GoogleCalendar; todoist: Todoist };
type ClientFactory = (profile: Profile) => Promise<ClientPair>;
type RepairCurrentState = (delivery: Delivery) => Promise<void>;
type ReconcileRecurrence = (profile: Profile) => Promise<void>;

type ReconcileOutcome =
  | "noop"
  | "baseline"
  | "converged"
  | "todoist_to_calendar"
  | "calendar_to_todoist"
  | "removed"
  | "moved"
  | "created"
  | "blocked"
  | "conflict"
  | "recurring_deferred";

export interface SnapshotReconciliationResult {
  continuation?: ReconciliationContinuation;
  processedCandidates: number;
  counts: Record<ReconcileOutcome, number>;
}

const DEFAULT_RECONCILIATION_CANDIDATE_LIMIT = 20;
const tableName = process.env.STATE_TABLE_NAME || "";

function reconciliationCandidateLimit(): number {
  const configured = Number(process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RECONCILIATION_CANDIDATE_LIMIT;
}

function key(pk: string, sk = "STATE"): { pk: string; sk: string } {
  return { pk, sk };
}

function ttl(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

function canonicalTodoist(task: TodoistTask): TodoistCanonicalState {
  const due = task.due && (task.due.date || task.due.datetime)
    ? {
        date: task.due.date || null,
        datetime: task.due.datetime || null,
        timezone: task.due.timezone || null,
        isRecurring: Boolean(task.due.is_recurring),
      }
    : null;
  return {
    content: normalizedText(task.content),
    description: normalizedText(task.description),
    due,
  };
}

function canonicalCalendar(event: CalendarEvent): CalendarCanonicalState {
  const point = (value: CalendarEvent["start"]): CalendarCanonicalState["start"] => value
    ? {
        date: value.date || null,
        dateTime: value.dateTime || null,
        timeZone: value.timeZone || null,
      }
    : null;
  return {
    status: event.status || "confirmed",
    summary: normalizedText(event.summary),
    description: normalizedText(event.description),
    start: point(event.start),
  };
}

function same(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entry]) => [key, stable(entry)]));
    }
    return value;
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function todoistDiffFields(left: TodoistCanonicalState | null, right: TodoistCanonicalState | null): string[] {
  const fields: string[] = [];
  for (const field of ["content", "description"] as const) {
    if (!same(left?.[field] ?? null, right?.[field] ?? null)) fields.push(field);
  }
  if (!same(left?.due ?? null, right?.due ?? null)) {
    if (Boolean(left?.due) !== Boolean(right?.due)) fields.push("due");
    else {
      for (const field of ["date", "datetime", "timezone", "isRecurring"] as const) {
        if (!same(left?.due?.[field] ?? null, right?.due?.[field] ?? null)) fields.push(`due.${field}`);
      }
    }
  }
  return fields;
}

function calendarDiffFields(left: CalendarCanonicalState | null, right: CalendarCanonicalState | null): string[] {
  const fields: string[] = [];
  for (const field of ["status", "summary", "description"] as const) {
    if (!same(left?.[field] ?? null, right?.[field] ?? null)) fields.push(field);
  }
  if (!same(left?.start ?? null, right?.start ?? null)) {
    if (Boolean(left?.start) !== Boolean(right?.start)) fields.push("start");
    else {
      for (const field of ["date", "dateTime", "timeZone"] as const) {
        if (!same(left?.start?.[field] ?? null, right?.start?.[field] ?? null)) fields.push(`start.${field}`);
      }
    }
  }
  return fields;
}

function hasDue(task: TodoistTask | undefined): boolean {
  return Boolean(task?.due?.date || task?.due?.datetime);
}

function isBlockedCalendarStatus(event: CalendarEvent | undefined): boolean {
  return Boolean(event?.status && event.status !== "confirmed" && event.status !== "cancelled");
}

function isStrictlyNewer(candidate: string | undefined, baseline: string): boolean {
  const candidateTime = candidate ? Date.parse(candidate) : Number.NaN;
  const baselineTime = Date.parse(baseline);
  return Number.isFinite(candidateTime) && Number.isFinite(baselineTime) && candidateTime > baselineTime;
}

function taskComment(event: CalendarEvent): string {
  return `todoist-calendar-sync\ncalendarEventId=${event.id}\ncalendarUrl=${event.htmlLink || ""}`;
}

function emptyCounts(): Record<ReconcileOutcome, number> {
  return {
    noop: 0,
    baseline: 0,
    converged: 0,
    todoist_to_calendar: 0,
    calendar_to_todoist: 0,
    removed: 0,
    moved: 0,
    created: 0,
    blocked: 0,
    conflict: 0,
    recurring_deferred: 0,
  };
}

class DynamoReconciliationStore implements ReconciliationStore {
  private ensureTable(): string {
    if (!tableName) throw new Error("STATE_TABLE_NAME is not configured");
    return tableName;
  }

  async listMappings(profile: Profile): Promise<Mapping[]> {
    const table = this.ensureTable();
    if (!await profileLookupIndexReady(documentClient, table)) {
      const result = await pacedScan<Mapping>({
        TableName: table,
        FilterExpression: "begins_with(pk, :prefix) AND sk = :map",
        ExpressionAttributeValues: { ":prefix": `TASK#${profile}#`, ":map": "MAP" },
      }, { operation: "list_reconciliation_mappings_scan_fallback", profile });
      return result.items;
    }

    const items: Mapping[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const result = await documentClient.send(new QueryCommand({
        TableName: table,
        IndexName: PROFILE_LOOKUP_INDEX_NAME,
        KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :lookupSk)",
        ExpressionAttributeValues: { ":lookupPk": profileLookupPk(profile), ":lookupSk": mappingLookupSk("task", "") },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      pages += 1;
      items.push(...((result.Items || []) as Mapping[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    logEvent("dynamodb_query_complete", { operation: "list_reconciliation_mappings", profile, accessMethod: "query", pages, returnedCount: items.length }, "reconciliation");
    return items;
  }

  async getBaseline(profile: Profile, taskId: string): Promise<ReconciliationBaseline | undefined> {
    const result = await documentClient.send(new GetCommand({
      TableName: this.ensureTable(),
      Key: key(`BASELINE#${profile}#TASK#${taskId}`, "RECONCILE"),
    }));
    return result.Item?.baseline as ReconciliationBaseline | undefined;
  }

  async putBaseline(profile: Profile, taskId: string, task: TodoistTask, event: CalendarEvent): Promise<void> {
    const baseline: ReconciliationBaseline = {
      todoist: canonicalTodoist(task),
      calendar: canonicalCalendar(event),
      updatedAt: new Date().toISOString(),
    };
    await documentClient.send(new PutCommand({
      TableName: this.ensureTable(),
      Item: {
        ...key(`BASELINE#${profile}#TASK#${taskId}`, "RECONCILE"),
        baseline,
        updatedAt: baseline.updatedAt,
        expiresAt: ttl(90),
      },
    }));
  }

  async deleteBaseline(profile: Profile, taskId: string): Promise<void> {
    await documentClient.send(new DeleteCommand({
      TableName: this.ensureTable(),
      Key: key(`BASELINE#${profile}#TASK#${taskId}`, "RECONCILE"),
    }));
  }
}

export class SnapshotReconciler {
  constructor(
    private readonly state = new StateRepository(),
    private readonly clientFactory?: ClientFactory,
    private readonly store: ReconciliationStore = new DynamoReconciliationStore(),
    private readonly repairCurrentState?: RepairCurrentState,
    private readonly reconcileRecurrence?: ReconcileRecurrence,
  ) {}

  private async clients(profile: Profile): Promise<ClientPair> {
    if (this.clientFactory) return this.clientFactory(profile);
    return {
      calendar: new GoogleCalendar(await googleCredentials(profile), profiles[profile].calendarId),
      todoist: new Todoist(await todoistToken(profile)),
    };
  }

  private async repair(delivery: Delivery): Promise<void> {
    if (this.repairCurrentState) return this.repairCurrentState(delivery);
    return new ProjectAwareSynchronizer(this.state).process(delivery);
  }

  private async reconcileExistingRecurrence(profile: Profile): Promise<void> {
    if (this.reconcileRecurrence) return this.reconcileRecurrence(profile);
    return new Synchronizer(this.state).reconcile(profile);
  }

  private reconcileDelivery(profile: Profile, task: TodoistTask, oldProjectId: string, suffix: string): Delivery {
    const receivedAt = new Date().toISOString();
    return {
      id: `snapshot-reconcile:${profile}:${task.id}:${suffix}:${receivedAt}`,
      kind: "todoist",
      profile,
      mode: "aws",
      receivedAt,
      headers: { "x-todoist-calendar-sync-reconcile": "true" },
      body: JSON.stringify({
        event_name: "item:updated",
        event_data: task,
        event_data_extra: { old_item: { ...task, project_id: oldProjectId } },
      }),
    };
  }

  private async currentEvent(calendar: GoogleCalendar, eventId: string): Promise<CalendarEvent | undefined> {
    try {
      return await calendar.getEvent(eventId);
    } catch (error) {
      if ([404, 410].includes(Number((error as { status?: number }).status))) return undefined;
      throw error;
    }
  }

  private async currentTask(todoist: Todoist, taskId: string): Promise<TodoistTask | undefined> {
    try {
      return await todoist.getTask(taskId);
    } catch (error) {
      if (Number((error as { status?: number }).status) === 404) return undefined;
      throw error;
    }
  }

  private async applyTodoistChange(
    profile: Profile,
    mapping: Mapping,
    task: TodoistTask | undefined,
    event: CalendarEvent | undefined,
    clients: ClientPair,
  ): Promise<ReconcileOutcome> {
    if (!hasDue(task)) {
      if (event && event.status !== "cancelled") {
        await clients.calendar.deleteEvent(event.id).catch((error: unknown) => {
          if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        });
      }
      await this.state.putCalendarProjectionTombstone(profile, mapping.taskId, task?.updated_at || new Date().toISOString());
      if (mapping.commentId) await clients.todoist.deleteComment(mapping.commentId).catch(() => undefined);
      await this.state.deleteMapping(mapping);
      await this.store.deleteBaseline(profile, mapping.taskId);
      await this.state.recordMutation(profile);
      await this.state.audit(profile, "todoist_snapshot_reconcile_projection_removed", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        reason: task ? "undated" : "todoist_missing",
      });
      return "removed";
    }

    if (!task) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_missing_task_conflict", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
      });
      return "conflict";
    }

    if (!event || event.status === "cancelled") {
      await this.state.audit(profile, "todoist_snapshot_reconcile_calendar_missing_blocked", {
        taskId: task.id,
        eventId: mapping.eventId,
      });
      return "blocked";
    }

    const stored = await clients.calendar.upsertEvent(toCalendarEvent(task, event), event.id);
    const existingComment = mapping.commentId ? { id: mapping.commentId } : await clients.todoist.findComment(task.id, stored.id);
    const comment = await clients.todoist.upsertComment(task.id, taskComment(stored), existingComment?.id);
    const nextMapping: Mapping = {
      ...mapping,
      projectId: task.project_id || mapping.projectId,
      eventId: stored.id,
      commentId: comment.id,
      updatedAt: new Date().toISOString(),
    };
    await this.state.putMapping(nextMapping);
    await this.store.putBaseline(profile, task.id, task, stored);
    await this.state.recordMutation(profile);
    await this.state.audit(profile, "todoist_snapshot_reconcile_calendar_updated", {
      taskId: task.id,
      eventId: stored.id,
    });
    return "todoist_to_calendar";
  }

  private async applyCalendarChange(
    profile: Profile,
    mapping: Mapping,
    task: TodoistTask | undefined,
    event: CalendarEvent | undefined,
    clients: ClientPair,
  ): Promise<ReconcileOutcome> {
    if (!event || event.status === "cancelled") {
      if (task) {
        await clients.todoist.deleteTask(task.id).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
      }
      if (mapping.commentId) await clients.todoist.deleteComment(mapping.commentId).catch(() => undefined);
      await this.state.deleteMapping(mapping);
      await this.store.deleteBaseline(profile, mapping.taskId);
      await this.state.recordMutation(profile);
      await this.state.audit(profile, "todoist_snapshot_reconcile_task_removed", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        reason: event?.status === "cancelled" ? "calendar_cancelled" : "calendar_missing",
      });
      return "removed";
    }

    if (!task) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_missing_task_conflict", {
        taskId: mapping.taskId,
        eventId: event.id,
      });
      return "conflict";
    }

    const nextTask = await clients.todoist.upsertTask(toTodoistTask(event), task.id);
    const nextMapping: Mapping = {
      ...mapping,
      projectId: nextTask.project_id || mapping.projectId,
      updatedAt: new Date().toISOString(),
    };
    await this.state.putMapping(nextMapping);
    await this.store.putBaseline(profile, task.id, nextTask, event);
    await this.state.recordMutation(profile);
    await this.state.audit(profile, "todoist_snapshot_reconcile_todoist_updated", {
      taskId: task.id,
      eventId: event.id,
    });
    return "calendar_to_todoist";
  }

  private async reconcileMapping(
    profile: Profile,
    mapping: Mapping,
    listedTask: TodoistTask | undefined,
    clients: ClientPair,
  ): Promise<ReconcileOutcome> {
    if (mapping.recurrenceOwner) return "recurring_deferred";

    const task = listedTask || await this.currentTask(clients.todoist, mapping.taskId);
    if (task) {
      const currentProfile = profileForTodoistProject(task.project_id);
      if (currentProfile !== profile) {
        const sourceProjectId = mapping.projectId || profiles[profile].todoistProjectId;
        await this.repair(this.reconcileDelivery(profile, task, sourceProjectId, "project-change"));
        await this.store.deleteBaseline(profile, task.id);
        return "moved";
      }
    }

    const event = await this.currentEvent(clients.calendar, mapping.eventId);
    if (isBlockedCalendarStatus(event)) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_calendar_status_blocked", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        calendarStatus: event?.status,
      });
      return "blocked";
    }

    const baseline = await this.store.getBaseline(profile, mapping.taskId);

    if (!baseline) {
      if (task && event && event.status !== "cancelled" && hasCanonicalState(event, task)) {
        await this.store.putBaseline(profile, mapping.taskId, task, event);
        await this.state.audit(profile, "todoist_snapshot_reconcile_baseline_established", {
          taskId: mapping.taskId,
          eventId: mapping.eventId,
        });
        return "baseline";
      }
      await this.state.audit(profile, "todoist_snapshot_reconcile_baseline_missing_conflict", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        todoistPresent: Boolean(task),
        calendarPresent: Boolean(event),
        calendarStatus: event?.status,
      });
      return "conflict";
    }

    const todoistCurrent = task ? canonicalTodoist(task) : null;
    const calendarCurrent = event ? canonicalCalendar(event) : null;
    const todoistChangedFields = todoistDiffFields(todoistCurrent, baseline.todoist);
    const calendarChangedFields = calendarDiffFields(calendarCurrent, baseline.calendar);
    const todoistChanged = todoistChangedFields.length > 0;
    const calendarChanged = calendarChangedFields.length > 0;

    if (!todoistChanged && !calendarChanged) return "noop";

    if (todoistChanged && calendarChanged) {
      if (!task && (!event || event.status === "cancelled")) {
        await this.state.deleteMapping(mapping);
        await this.store.deleteBaseline(profile, mapping.taskId);
        await this.state.audit(profile, "todoist_snapshot_reconcile_converged_deletion", {
          taskId: mapping.taskId,
          eventId: mapping.eventId,
        });
        return "converged";
      }
      if (task && event && event.status !== "cancelled" && hasCanonicalState(event, task)) {
        await this.store.putBaseline(profile, task.id, task, event);
        await this.state.audit(profile, "todoist_snapshot_reconcile_converged", {
          taskId: task.id,
          eventId: event.id,
          todoistChangedFields,
          calendarChangedFields,
          todoistChangedFromBaseline: true,
          calendarChangedFromBaseline: true,
          providerStatesAgree: true,
        });
        return "converged";
      }
      await this.state.audit(profile, "todoist_snapshot_reconcile_conflict_both_sides_changed", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        todoistPresent: Boolean(task),
        calendarPresent: Boolean(event),
        calendarStatus: event?.status,
        taskTitle: task?.content,
        todoistDue: task?.due?.datetime || task?.due?.date,
        calendarTitle: event?.summary,
        calendarStart: event?.start?.dateTime || event?.start?.date,
      });
      return "conflict";
    }

    if (todoistChanged) return this.applyTodoistChange(profile, mapping, task, event, clients);
    return this.applyCalendarChange(profile, mapping, task, event, clients);
  }

  private async reconcileUnmappedTask(profile: Profile, task: TodoistTask, clients: ClientPair): Promise<ReconcileOutcome> {
    if (!hasDue(task)) return "noop";

    const baseline = await this.store.getBaseline(profile, task.id);
    const tombstone = await this.state.getCalendarProjectionTombstone(profile, task.id);
    const existing = await clients.calendar.findByTodoistTaskId(task.id);
    const genericTombstoneRecreationAllowed = Boolean(
      tombstone
      && tombstone.reason !== "project_exit"
      && isStrictlyNewer(task.updated_at, tombstone.sourceUpdatedAt),
    );

    if (isBlockedCalendarStatus(existing)) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_calendar_status_blocked", {
        taskId: task.id,
        eventId: existing?.id,
        calendarStatus: existing?.status,
      });
      return "blocked";
    }

    if (existing?.status === "cancelled" && tombstone?.reason !== "project_exit" && !genericTombstoneRecreationAllowed) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_cancelled_projection_blocked", {
        taskId: task.id,
        eventId: existing.id,
        tombstoneReason: tombstone?.reason,
      });
      return "blocked";
    }

    if (baseline && !tombstone) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_prior_projection_without_mapping_blocked", {
        taskId: task.id,
      });
      return "blocked";
    }

    if (existing && existing.status !== "cancelled" && !hasCanonicalState(existing, task)) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_unmapped_conflict", {
        taskId: task.id,
        eventId: existing.id,
      });
      return "conflict";
    }

    await this.repair(this.reconcileDelivery(profile, task, "reconcile-unmapped", "projection-create"));
    const mapping = await this.state.getMappingByTask(profile, task.id);
    if (!mapping) return "blocked";
    const stored = await this.currentEvent(clients.calendar, mapping.eventId);
    if (stored && !isBlockedCalendarStatus(stored) && stored.status !== "cancelled") {
      await this.store.putBaseline(profile, task.id, task, stored);
    }
    return "created";
  }

  async reconcile(
    profile: Profile,
    continuation?: ReconciliationContinuation,
    maxCandidates = reconciliationCandidateLimit(),
  ): Promise<SnapshotReconciliationResult> {
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new Error("Reconciliation candidate limit must be a positive integer");
    if (!continuation) await this.reconcileExistingRecurrence(profile);

    const clients = await this.clients(profile);
    const tasks = (await clients.todoist.listTasks()).slice().sort((a, b) => a.id.localeCompare(b.id));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const mappings = (await this.store.listMappings(profile)).slice().sort((a, b) => a.taskId.localeCompare(b.taskId));
    const mappedTaskIds = new Set(mappings.map((mapping) => mapping.taskId));
    const unmappedTasks = tasks.filter((task) => !mappedTaskIds.has(task.id));
    const counts = emptyCounts();
    let processedCandidates = 0;
    const nextSequence = (continuation?.sequence || 0) + 1;

    const finishChunk = async (next: ReconciliationContinuation): Promise<SnapshotReconciliationResult> => {
      await this.state.audit(profile, "todoist_snapshot_reconcile_chunk_completed", {
        processedCandidates,
        candidateLimit: maxCandidates,
        continuation: next,
        taskCount: tasks.length,
        mappingCount: mappings.length,
        counts,
      });
      return { continuation: next, processedCandidates, counts };
    };

    if (!continuation || continuation.phase === "mapped") {
      const afterTaskId = continuation?.phase === "mapped" ? continuation.afterTaskId : undefined;
      const candidates = mappings.filter((mapping) => !afterTaskId || mapping.taskId > afterTaskId);
      for (let index = 0; index < candidates.length; index += 1) {
        const mapping = candidates[index];
        counts[await this.reconcileMapping(profile, mapping, taskById.get(mapping.taskId), clients)] += 1;
        processedCandidates += 1;

        if (processedCandidates >= maxCandidates) {
          const moreMapped = index < candidates.length - 1;
          if (moreMapped) {
            return finishChunk({ sequence: nextSequence, phase: "mapped", afterTaskId: mapping.taskId });
          }
          if (unmappedTasks.length) {
            return finishChunk({ sequence: nextSequence, phase: "unmapped" });
          }
        }
      }
    }

    const afterUnmappedTaskId = continuation?.phase === "unmapped" ? continuation.afterTaskId : undefined;
    const unmappedCandidates = unmappedTasks.filter((task) => !afterUnmappedTaskId || task.id > afterUnmappedTaskId);
    for (let index = 0; index < unmappedCandidates.length; index += 1) {
      const task = unmappedCandidates[index];
      counts[await this.reconcileUnmappedTask(profile, task, clients)] += 1;
      processedCandidates += 1;

      if (processedCandidates >= maxCandidates && index < unmappedCandidates.length - 1) {
        return finishChunk({ sequence: nextSequence, phase: "unmapped", afterTaskId: task.id });
      }
    }

    await this.state.audit(profile, "todoist_snapshot_reconcile_completed", {
      taskCount: tasks.length,
      mappingCount: mappings.length,
      processedCandidates,
      continuationSequence: continuation?.sequence || 0,
      counts,
    });
    return { processedCandidates, counts };
  }
}
