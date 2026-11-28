import { createHash } from "node:crypto";
import {defaultProviderClientFactory} from "./mutation-budget.js";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { ReviewStore, reviewHash } from "./review-store.js";
import { cancelledOccurrenceMasterId, verifyCancelledSeries, verifyCancelledSeriesInstances } from "./verified-deletion.js";
import { googleCredentials, profileForTodoistProject, profiles, todoistToken } from "./config.js";
import { buildProjectMappingIndex, deleteMappingComments, mappingFromProjectMappingComment } from "./mapping-comments.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import { AmbiguousCalendarLinkError, GoogleCalendar, Todoist } from "./providers.js";
import { StateRepository } from "./repository.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { isMutationBudgetExhausted } from "./mutation-budget.js";
import { ReconciliationItemError, reconciliationFailureDetails, type ReconciliationFailureContext } from "./reconciliation-diagnostics.js";
import { normalizedText } from "./security.js";
import { compatibleCalendarCandidateOwnerConflicts, discoverCompatibleCalendarCandidates, hasCanonicalState, startsMatch, Synchronizer, toCalendarEvent, toTodoistTask } from "./sync.js";
import { calendarRecurrenceMatchesTodoist, todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import { recoveryPolicyForTask, recoveryReceiptMatchesTask } from "./cancelled-mapping-recovery-policy.js";
import { logEvent } from "./observability.js";
import { providerSyncBaseline } from "./provider-sync-baseline.js";
import type { CalendarEvent, Delivery, Mapping, Profile, ProviderSyncBaseline, ReconciliationContinuation,
  RecurrenceReconciliationSummary, TodoistTask } from "./types.js";

interface TodoistCanonicalState {
  content: string;
  description: string;
  due: {
    date: string | null;
    datetime: string | null;
    timezone: string | null;
    isRecurring: boolean;
  } | null;
  recurrence: string | null;
}

// The reconciled Calendar projection deliberately excludes end/duration:
// Todoist has no equivalent, so end-only edits cannot count as Calendar-side
// changes or trigger a both-sides-changed conflict.
interface CalendarCanonicalState {
  status: string;
  summary: string;
  description: string;
  start: { date: string | null; dateTime: string | null; timeZone: string | null } | null;
  recurrence: string[] | null;
}

export interface ReconciliationBaseline {
  todoist: TodoistCanonicalState;
  calendar: CalendarCanonicalState;
  updatedAt: string;
}

interface ReconciliationStore {
  listMappings?(profile: Profile): Promise<Mapping[]>;
  getBaseline(profile: Profile, taskId: string): Promise<ReconciliationBaseline | undefined>;
  putBaseline(profile: Profile, taskId: string, task: TodoistTask, event: CalendarEvent): Promise<void>;
  deleteBaseline(profile: Profile, taskId: string): Promise<void>;
}

type ClientPair = { calendar: GoogleCalendar; todoist: Todoist };
type ClientFactory = (profile: Profile) => Promise<ClientPair>;
type RepairCurrentState = (delivery: Delivery) => Promise<void>;
type ReconcileRecurrence = (profile: Profile) => Promise<RecurrenceReconciliationSummary | void>;

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
  | "completed_retained"
  | "deleted_retired"
  | "recurrence_converged"
  | "recurrence_repaired"
  | "recurrence_unsupported"
  | "recurrence_excluded"
  | "recurrence_blocked"
  | "recurrence_stale"
  | "recurrence_unverified"
  | "recurrence_reported"
  | "recurrence_total";

export interface SnapshotReconciliationResult {
  continuation?: ReconciliationContinuation;
  processedCandidates: number;
  counts: Record<ReconcileOutcome, number>;
  recurrence?: RecurrenceReconciliationSummary;
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
    recurrence: task.due?.is_recurring ? normalizedText(task.due.string) || null : null,
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
    recurrence: event.recurrence?.length ? [...event.recurrence] : null,
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function fieldHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function providerBaseline(task: TodoistTask, event: CalendarEvent): ProviderSyncBaseline {
  return providerSyncBaseline(task, event);
}

function todoistDiffFields(left: TodoistCanonicalState | null, right: TodoistCanonicalState | null): string[] {
  const fields: string[] = [];
  for (const field of ["content", "description", "recurrence"] as const) {
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
  if (!same(left?.recurrence ?? null, right?.recurrence ?? null)) fields.push("recurrence");
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

function todoistProviderDiffFields(current: TodoistCanonicalState | null, baseline: ProviderSyncBaseline): string[] {
  return [
    ...(fieldHash(current?.content ?? null) !== baseline.todoist.content ? ["content"] : []),
    ...(fieldHash(current?.description ?? null) !== baseline.todoist.description ? ["description"] : []),
    ...(fieldHash(current?.due ?? null) !== baseline.todoist.due ? ["due"] : []),
    ...(baseline.todoist.recurrence && fieldHash(current?.recurrence ?? null) !== baseline.todoist.recurrence ? ["recurrence"] : []),
  ];
}

function calendarProviderDiffFields(current: CalendarCanonicalState | null, baseline: ProviderSyncBaseline): string[] {
  return [
    ...(fieldHash(current?.status ?? null) !== baseline.calendar.status ? ["status"] : []),
    ...(fieldHash(current?.summary ?? null) !== baseline.calendar.summary ? ["summary"] : []),
    ...(fieldHash(current?.description ?? null) !== baseline.calendar.description ? ["description"] : []),
    ...(fieldHash(current?.start ?? null) !== baseline.calendar.start ? ["start"] : []),
    ...(baseline.calendar.recurrence && fieldHash(current?.recurrence ?? null) !== baseline.calendar.recurrence ? ["recurrence"] : []),
  ];
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


function unmappedMismatchCategories(event: CalendarEvent, task: TodoistTask): string[] {
  const categories: string[] = [];
  if (normalizedText(event.summary) !== normalizedText(task.content)) categories.push("title_mismatch");
  if (normalizedText(event.description) !== normalizedText(task.description)) categories.push("description_mismatch");
  if (todoistRecurrenceToRrule(task)) {
    categories.push(calendarRecurrenceMatchesTodoist(event, task)
      ? "recurrence_anchor_mismatch"
      : "recurrence_mismatch");
  } else if (!startsMatch(event, task)) {
    categories.push("start_mismatch");
  }
  return categories.length ? categories.sort() : ["canonical_state_mismatch"];
}

function isResolvedConflictOutcome(outcome: ReconcileOutcome): boolean {
  return !["conflict", "blocked"].includes(outcome);
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
    completed_retained: 0,
    deleted_retired: 0,
    recurrence_converged: 0,
    recurrence_repaired: 0,
    recurrence_unsupported: 0,
    recurrence_excluded: 0,
    recurrence_blocked: 0,
    recurrence_stale: 0,
    recurrence_unverified: 0,
    recurrence_reported: 0,
    recurrence_total: 0,
  };
}

export class DynamoReconciliationStore implements ReconciliationStore {
  private ensureTable(): string {
    if (!tableName) throw new Error("STATE_TABLE_NAME is not configured");
    return tableName;
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

  async deleteBaselineIfUnchanged(profile:Profile,taskId:string,expected:ReconciliationBaseline|null|undefined,allowAbsentAfterCheckpoint=false):Promise<boolean> {
    if(!tableName) throw new Error("STATE_TABLE_NAME is not configured");
    const key= {pk:`BASELINE#${profile}#TASK#${taskId}`,sk:"RECONCILE"};
    const current=await documentClient.send(new GetCommand({TableName:tableName,Key:key,ConsistentRead:true}));
    if(!expected) return !current.Item;
    if(!current.Item) return allowAbsentAfterCheckpoint;
    if(reviewHash(current.Item.baseline)!==reviewHash(expected) || current.Item.updatedAt!==expected.updatedAt) return false;
    try {
      await documentClient.send(new DeleteCommand({TableName:tableName,Key:key,
        ConditionExpression:"updatedAt = :updated AND baseline = :baseline",
        ExpressionAttributeValues:{":updated":expected.updatedAt,":baseline":expected}}));
      return true;
    } catch(error) {
      if((error as {name?:string}).name!=="ConditionalCheckFailedException") throw error;
      return false;
    }
  }
}

export class SnapshotReconciler {
  private readonly clientPairs = new Map<Profile, Promise<ClientPair>>();

  constructor(
    private readonly state = new StateRepository(),
    private readonly clientFactory?: ClientFactory,
    private readonly store?: ReconciliationStore,
    private readonly repairCurrentState?: RepairCurrentState,
    private readonly reconcileRecurrence?: ReconcileRecurrence,
  ) {}

  private async clients(profile: Profile): Promise<ClientPair> {
    let pending = this.clientPairs.get(profile);
    if (!pending) {
      pending = this.clientFactory
        ? this.clientFactory(profile)
        : defaultProviderClientFactory(profile);
      this.clientPairs.set(profile, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.clientPairs.get(profile) === pending) this.clientPairs.delete(profile);
      throw error;
    }
  }

  private async providerMappings(profile: Profile, todoist?: Todoist): Promise<Mapping[]> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (typeof client.listProjectComments !== "function") {
      return this.store?.listMappings ? this.store.listMappings(profile)
        : await this.state.listMappings?.(profile) || [];
    }
    const providerMappings = buildProjectMappingIndex(
      await client.listProjectComments(profiles[profile].todoistProjectId, true),
    ).parsed
      .filter(entry => entry.payload.profile === profile
        && entry.payload.projectId === profiles[profile].todoistProjectId)
      .map(mappingFromProjectMappingComment);
    const legacyMappings = this.store?.listMappings
      ? await this.store.listMappings(profile)
      : await this.state.listMappings?.(profile) || [];
    const providerTasks = new Set(providerMappings.map(mapping => mapping.taskId));
    const providerEvents = new Set(providerMappings.flatMap(mapping =>
      [mapping.eventId, mapping.masterEventId, mapping.activeInstanceId].filter((id): id is string => Boolean(id))));
    return [...providerMappings, ...legacyMappings.filter(mapping =>
      !providerTasks.has(mapping.taskId) && !providerEvents.has(mapping.eventId))];
  }

  private async providerCommentMappings(profile: Profile, todoist: Todoist): Promise<Mapping[]> {
    return buildProjectMappingIndex(await todoist.listProjectComments(profiles[profile].todoistProjectId)).parsed
      .filter(entry => entry.payload.profile === profile && entry.payload.projectId === profiles[profile].todoistProjectId)
      .map(mappingFromProjectMappingComment);
  }

  private async reconciliationBaseline(mapping: Mapping): Promise<ReconciliationBaseline | ProviderSyncBaseline | undefined> {
    if (mapping.syncBaseline) return mapping.syncBaseline;
    // Older unit fixtures use a repository double. Production baselines live
    // in the provider-owned project correlation comment and never fall back
    // to DynamoDB.
    if (process.env.NODE_ENV === "test") return this.store?.getBaseline(mapping.profile, mapping.taskId);
    return undefined;
  }

  private async persistReconciliationBaseline(
    mapping: Mapping, task: TodoistTask, event: CalendarEvent, clients: ClientPair,
  ): Promise<Mapping> {
    if (process.env.NODE_ENV === "test" && this.store) {
      await this.store.putBaseline(mapping.profile, task.id, task, event);
      return mapping;
    }
    return this.persistProviderMapping({ ...mapping, syncBaseline: providerBaseline(task, event) }, clients);
  }

  private async deleteReconciliationBaseline(profile: Profile, taskId: string): Promise<void> {
    if (process.env.NODE_ENV === "test") await this.store?.deleteBaseline(profile, taskId);
  }

  private async purgeVerifiedDeletion(profile:Profile,mapping:Mapping):Promise<void> {
    const eventIds=[mapping.eventId,mapping.masterEventId,mapping.activeInstanceId].filter((id):id is string=>Boolean(id));
    const ok=await this.state.purgeDeletedPair?.({profile,taskId:mapping.taskId,eventIds,
      seriesIds:[mapping.seriesId,mapping.masterEventId].filter((id):id is string=>Boolean(id))});
    if(ok===false) throw new Error(`Verified deletion cleanup changed concurrently for task ${mapping.taskId}; retry or review`);
  }

  private async providerMappingByTaskAnyProfile(taskId: string): Promise<Mapping | undefined> {
    const client = (await this.clients("home")).todoist;
    if (typeof client.listProjectComments !== "function") {
      for (const profile of Object.keys(profiles) as Profile[]) {
        const mapping = await this.legacyMappingByTask(profile, taskId);
        if (mapping) return mapping;
      }
      return undefined;
    }
    const values = (await Promise.all((Object.keys(profiles) as Profile[]).map(async profile =>
      this.providerMappingByTask(profile, taskId)))).filter((value): value is Mapping => Boolean(value));
    if (values.length > 1) return undefined;
    return values[0];
  }

  private async providerMappingByEvent(profile: Profile, eventId: string, todoist?: Todoist): Promise<Mapping | undefined> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (typeof client.listProjectComments !== "function") {
      return this.legacyMappingByEvent(profile, eventId);
    }
    const provider = (await this.providerCommentMappings(profile, client)).find(mapping => mapping.eventId === eventId
      || mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
    if (provider) return provider;
    return this.legacyMappingByEvent(profile, eventId);
  }

  private async providerMappingByTask(profile: Profile, taskId: string, todoist?: Todoist): Promise<Mapping | undefined> {
    const client = todoist || (await this.clients(profile)).todoist;
    if (typeof client.listProjectComments !== "function") {
      return this.legacyMappingByTask(profile, taskId);
    }
    const provider = (await this.providerCommentMappings(profile, client)).find(mapping => mapping.taskId === taskId);
    return provider || this.legacyMappingByTask(profile, taskId);
  }

  private async legacyMappingByTask(profile: Profile, taskId: string): Promise<Mapping | undefined> {
    if (typeof this.state.getMappingByTask === "function") {
      const mapping = await this.state.getMappingByTask(profile, taskId);
      if (mapping?.profile === profile) return mapping;
    }
    if (this.store?.listMappings) return (await this.store.listMappings(profile)).find(mapping => mapping.taskId === taskId);
    return typeof this.state.getMappingByTask === "function" ? undefined
      : (await this.state.listMappings?.(profile) || []).find(mapping => mapping.taskId === taskId);
  }

  private async legacyMappingByEvent(profile: Profile, eventId: string): Promise<Mapping | undefined> {
    if (typeof this.state.getMappingByEvent === "function") {
      const direct = await this.state.getMappingByEvent(profile, eventId);
      if (direct?.profile === profile) return direct;
      if (this.store?.listMappings) return (await this.store.listMappings(profile)).find(mapping =>
        mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
      return typeof this.state.getMappingByEvent === "function" ? undefined
        : (await this.state.listMappings?.(profile) || []).find(mapping =>
          mapping.eventId === eventId || mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
    }
    return (this.store?.listMappings ? await this.store.listMappings(profile)
      : await this.state.listMappings?.(profile) || []).find(mapping =>
      mapping.eventId === eventId || mapping.masterEventId === eventId || mapping.activeInstanceId === eventId);
  }

  private async persistProviderMapping(mapping: Mapping, clients: ClientPair): Promise<Mapping> {
    return new Synchronizer(this.state, undefined, async () => clients)
      .persistProviderMapping(mapping, clients.todoist);
  }

  private isLegacyTestAdapter(client: Todoist): boolean {
    return process.env.NODE_ENV === "test" && !(client instanceof Todoist);
  }

  private async completedProjection(profile: Profile, eventId: string) {
    const state = this.state as unknown as Partial<Pick<StateRepository, "getCompletedCalendarProjectionByEvent">>;
    return state.getCompletedCalendarProjectionByEvent?.(profile, eventId);
  }

  private async retainCompletedProjectionIfMarked(profile: Profile, mapping: Mapping): Promise<ReconcileOutcome | undefined> {
    const completedProjection = await this.completedProjection(profile, mapping.eventId);
    if (completedProjection?.taskId !== mapping.taskId) return undefined;
    // The mapping is kept throughout the seven-day completion grace.
    // The maintenance worker retires all three indexes transactionally.
    // Reconciliation must not delete these rows early or mutate providers.
    await this.state.audit(profile, "todoist_snapshot_completed_projection_retained", {
      taskId: mapping.taskId,
      eventId: mapping.eventId,
      completedAt: completedProjection.completedAt,
    });
    return "completed_retained";
  }

  private async repair(delivery: Delivery): Promise<void> {
    if (this.repairCurrentState) return this.repairCurrentState(delivery);
    return new ProjectAwareSynchronizer(this.state).process(delivery);
  }

  private async rethrowCandidateError(
    profile: Profile, error: unknown, context: ReconciliationFailureContext,
  ): Promise<never> {
    // Mutation-budget failures are handled by the worker's deferred, non-DLQ
    // path; never turn them into an item/provider incident.
    if (isMutationBudgetExhausted(error)) throw error;
    const failure = new ReconciliationItemError(error, context);
    const detail = reconciliationFailureDetails(failure);
    logEvent("todoist_snapshot_reconcile_item_failed", { profile, ...detail }, "reconciliation");
    try {
      await this.state.audit(profile, "todoist_snapshot_reconcile_item_failed", detail);
    } catch {
      // Audit availability must not replace or hide the original provider error.
      logEvent("todoist_snapshot_reconcile_failure_audit_failed", { profile, ...detail }, "reconciliation");
    }
    throw failure;
  }

  private async reconcileExistingRecurrence(profile: Profile): Promise<RecurrenceReconciliationSummary | void> {
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
      if ([404, 410].includes(Number((error as { status?: number }).status))) return undefined;
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
    const completedOutcome = await this.retainCompletedProjectionIfMarked(profile, mapping);
    if (completedOutcome) return completedOutcome;
    if (!hasDue(task)) {
      if (event && event.status !== "cancelled") {
        await clients.calendar.deleteEvent(event.id).catch((error: unknown) => {
          if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        });
      }
      await deleteMappingComments(clients.todoist, mapping);
      if(!task) await this.purgeVerifiedDeletion(profile,mapping);
      await this.deleteReconciliationBaseline(profile, mapping.taskId);
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
      await clients.todoist.deleteTask(task.id).catch((error: unknown) => {
        if (Number((error as { status?: number }).status) !== 404) throw error;
      });
      await deleteMappingComments(clients.todoist, mapping);
      await this.purgeVerifiedDeletion(profile,mapping);
      await this.deleteReconciliationBaseline(profile, mapping.taskId);
      await this.state.recordMutation(profile);
      await this.state.audit(profile, "todoist_snapshot_reconcile_calendar_deletion_propagated", {
        taskId: task.id, eventId: mapping.eventId,
      });
      return "removed";
    }

    const stored = await clients.calendar.upsertEvent(toCalendarEvent(task, event), event.id);
    const projectId = task.project_id || mapping.projectId || profiles[profile].todoistProjectId;
    const draftMapping: Mapping = {
      ...mapping,
      projectId,
      eventId: stored.id,
      updatedAt: new Date().toISOString(),
    };
    const nextMapping = await this.persistProviderMapping(draftMapping, clients);
    await this.persistReconciliationBaseline(nextMapping, task, stored, clients);
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
    const completedOutcome = await this.retainCompletedProjectionIfMarked(profile, mapping);
    if (completedOutcome) return completedOutcome;
    if (!event || event.status === "cancelled") {
      // #369: a newer, still-live annual Todoist source must never be
      // destroyed by the cancelled Calendar projection's stale baseline.
      // The guarded reset may have already retired the old mapping in a
      // transaction while this reconciliation held an older snapshot.
      const pending = await this.state.getCancelledAnnualRecoveryReceipt?.(profile,mapping.taskId);
      const recoveryLock=task && await this.state.getCancelledAnnualRecoveryLock?.(profile,mapping.taskId);
      const newerSourceWithProof=Boolean(recoveryLock && task && !task.is_deleted
        && !task.is_completed && !task.completed_at && recoveryPolicyForTask(task)
        && task.updated_at && event?.updated
        && Date.parse(task.updated_at)>Date.parse(event.updated)
        && profileForTodoistProject(task.project_id)===profile);
      const newerAnnual = Boolean(task && !task.is_deleted && !task.is_completed
        && task.due?.is_recurring && todoistRecurrenceToRrule(task)==="RRULE:FREQ=YEARLY"
        && task.updated_at && mapping.updatedAt
        && Date.parse(task.updated_at)>Date.parse(mapping.updatedAt)
        && (!event?.updated || Date.parse(task.updated_at)>Date.parse(event.updated)));
      if ((pending && pending.oldEventId===mapping.eventId) || newerAnnual || newerSourceWithProof) {
        await this.state.audit(profile,"calendar_cancelled_annual_todoist_protected",{
          taskId:mapping.taskId,eventId:mapping.eventId,
          pendingReset:Boolean(pending),
        });
        return "blocked";
      }
      if (task) {
        await clients.todoist.deleteTask(task.id).catch((error: unknown) => {
          if (Number((error as { status?: number }).status) !== 404) throw error;
        });
      }
      await deleteMappingComments(clients.todoist, mapping);
      await this.purgeVerifiedDeletion(profile,mapping);
      await this.deleteReconciliationBaseline(profile, mapping.taskId);
      await this.state.recordMutation(profile);
      await this.state.audit(profile, "todoist_snapshot_reconcile_task_removed", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        reason: event?.status === "cancelled" ? "calendar_cancelled" : "calendar_missing",
      });
      return "removed";
    }

    if (!task) {
      if (event.status !== "cancelled") await clients.calendar.deleteEvent(event.id).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
      await deleteMappingComments(clients.todoist, mapping);
      await this.purgeVerifiedDeletion(profile,mapping);
      await this.deleteReconciliationBaseline(profile, mapping.taskId);
      await this.state.recordMutation(profile);
      await this.state.audit(profile, "todoist_snapshot_reconcile_task_deletion_propagated", {
        taskId: mapping.taskId, eventId: event.id,
      });
      return "removed";
    }

    let nextTask: TodoistTask;
    try {
      nextTask = await clients.todoist.upsertTask(toTodoistTask(event), task.id);
    } catch (error) {
      // The snapshot list and this write are not atomic. A task can be deleted
      // after listTasks() returns it. Re-read the exact ID before deciding
      // whether this is deletion or an actual provider write failure.
      if (Number((error as { status?: number }).status) !== 404) throw error;
      const liveTask = await this.currentTask(clients.todoist, task.id);
      if (!liveTask) {
        await clients.calendar.deleteEvent(event.id).catch((deleteError: unknown) => {
          if (![404, 410].includes(Number((deleteError as { status?: number }).status))) throw deleteError;
        });
        await deleteMappingComments(clients.todoist, mapping);
        await this.purgeVerifiedDeletion(profile,mapping);
        await this.deleteReconciliationBaseline(profile, mapping.taskId);
        await this.state.recordMutation(profile);
        await this.state.audit(profile, "todoist_snapshot_reconcile_task_deletion_propagated", {
          taskId: mapping.taskId, eventId: event.id, reason: "task_disappeared_during_provider_update",
        });
        return "removed";
      }
      throw error;
    }
    const nextMapping: Mapping = {
      ...mapping,
      projectId: nextTask.project_id || mapping.projectId,
      updatedAt: new Date().toISOString(),
    };
    await this.persistProviderMapping(nextMapping, clients);
    await this.persistReconciliationBaseline(nextMapping, nextTask, event, clients);
    await this.state.recordMutation(profile);
    await this.state.audit(profile, "todoist_snapshot_reconcile_todoist_updated", {
      taskId: task.id,
      eventId: event.id,
    });
    return "calendar_to_todoist";
  }

  /** Apply a simultaneous-edit merge to both providers. Calendar is written
   * first so a partial failure leaves Todoist's source edits available for the
   * next fresh reconciliation; a second pass can safely finish the Todoist
   * update from the now-converged Calendar values. */
  private async applyMergedChanges(
    profile: Profile,
    mapping: Mapping,
    task: TodoistTask,
    event: CalendarEvent,
    mergedTask: TodoistTask,
    mergedEvent: CalendarEvent,
    clients: ClientPair,
  ): Promise<ReconcileOutcome> {
    const calendarChanged = !hasCanonicalState(event, mergedTask);
    const todoistChanged = JSON.stringify(canonicalTodoist(task)) !== JSON.stringify(canonicalTodoist(mergedTask));
    const storedEvent = calendarChanged
      ? await clients.calendar.upsertEvent(mergedEvent, event.id)
      : event;
    const nextTask = todoistChanged
      ? await clients.todoist.upsertTask(toTodoistTask(mergedEvent), task.id)
      : task;
    const nextMapping: Mapping = {
      ...mapping,
      projectId: nextTask.project_id || mapping.projectId,
      eventId: storedEvent.id,
      updatedAt: new Date().toISOString(),
    };
    const persistedMapping = await this.persistProviderMapping(nextMapping, clients);
    await this.persistReconciliationBaseline(persistedMapping, nextTask, storedEvent, clients);
    if (calendarChanged || todoistChanged) await this.state.recordMutation(profile);
    return calendarChanged && !todoistChanged ? "todoist_to_calendar"
      : todoistChanged && !calendarChanged ? "calendar_to_todoist" : "converged";
  }

  /**
   * The recurrence reconciler deliberately defers Todoist-owned series. Before
   * deferring, however, verify whether their exact task and Calendar resources
   * were both deleted. A cancelled master is not a live Calendar event.
   */
  private async retireDeletedTodoistRecurrence(
    profile: Profile, mapping: Mapping, clients: ClientPair,
  ): Promise<ReconcileOutcome | undefined> {
    if (mapping.seriesId !== mapping.taskId || mapping.masterEventId !== mapping.eventId
      || mapping.calendarProgressVersion === 1) return undefined;
    const task = await this.currentTask(clients.todoist, mapping.taskId);
    if (task) return undefined;
    const eventIds = [...new Set([mapping.eventId, mapping.masterEventId, mapping.activeInstanceId]
      .filter((id): id is string => Boolean(id)))];
    if (!eventIds.length) return undefined;
    for (const eventId of eventIds) {
      const current = await this.currentEvent(clients.calendar, eventId);
      if (current && current.status !== "cancelled") return undefined;
      if (await this.completedProjection(profile, eventId)) return undefined;
    }
    // The exact task/master/instance IDs from the provider-native mapping and
    // fresh provider reads above are the deletion proof. A legacy DynamoDB
    // recurrence row may be stale or absent after migration and must not gate
    // cleanup of an otherwise verified deleted pair.
    // Keep only the short-lived concurrency barrier around destructive
    // retirement.
    if (await this.state.syncBlocked(profile, { taskId: mapping.taskId, eventId: mapping.masterEventId })) return undefined;
    await deleteMappingComments(clients.todoist, mapping);
    await this.purgeVerifiedDeletion(profile,mapping);
    await this.deleteReconciliationBaseline(profile, mapping.taskId);
    await this.state.audit(profile, "todoist_snapshot_reconcile_verified_deletion_retired", {
      taskId: mapping.taskId, eventId: mapping.eventId, seriesId: mapping.seriesId,
      reason: "todoist_task_absent_calendar_projection_cancelled_or_missing",
    });
    return "deleted_retired";
  }

  /** Remove stale review identities only when every exact provider ID is gone.
   * This is intentionally bounded and never infers an ID from title/date.
   * A one-sided deletion remains actionable, including recurring masters.
   */
  private async retireVerifiedDeletedCases(profile: Profile, clients: ClientPair, includeHistory = false): Promise<void> {
    if (!(this.state instanceof StateRepository)) return;
    const review = new ReviewStore();
    let cursor = await review.deletionSweepCursor(profile, includeHistory);
    let examined = 0;
    do {
      const page = await review.listCases(profile, cursor, includeHistory, 10);
      for (const item of page.items) {
        examined += 1;
        if (item.status !== (includeHistory ? "dismissed" : "open") || item.operationId
          || item.reason.startsWith("operational_")) continue;
        const { taskIds, eventIds } = reviewCaseEvidenceIds(item);
        if (!taskIds.length || !eventIds.length || taskIds.length + eventIds.length > 20) continue;
        const recurring = item.decision?.type?.includes("recurrence_task_deleted") === true;
        const contextMaster = typeof item.decision?.context?.masterEventId === "string"
          ? item.decision.context.masterEventId : undefined;
        const unmappedRecurring = !recurring
          && (item.decision?.type === "todoist_unmapped_conflict"
            || item.reason === "calendar_snapshot_recurring_identity_conflict")
          && Boolean(item.decision?.masterEventId || contextMaster);
        const recordedMasterId = item.decision?.masterEventId
          || item.decision?.mappingSnapshot?.masterEventId
          || (unmappedRecurring ? contextMaster : undefined);
        const activeInstanceId = item.decision?.activeInstanceId
          || item.decision?.mappingSnapshot?.activeInstanceId
          || (unmappedRecurring ? item.decision?.eventId || item.eventId : undefined);
        if ((recurring || unmappedRecurring)
          && (!activeInstanceId || !eventIds.includes(activeInstanceId)
            || !recordedMasterId && unmappedRecurring)) continue;
        // Legacy Todoist-owned recurrence mappings did not persist masterEventId.
        // Recover only from the cancelled active occurrence's direct provider
        // recurringEventId; independently verify the cancelled master below.
        const legacyMaster = recurring && !recordedMasterId;
        const masterId = legacyMaster
          ? cancelledOccurrenceMasterId(activeInstanceId,
            await this.currentEvent(clients.calendar, activeInstanceId!))
          : recordedMasterId;
        const recurringIdentity = recurring || unmappedRecurring;
        if (recurringIdentity && (!masterId || masterId === activeInstanceId)) continue;
        const verifiedEventIds = recurringIdentity
          ? [...new Set([...eventIds,masterId!])]
          : eventIds;
        if (taskIds.length + verifiedEventIds.length > 20) continue;

        const readProviders = async (): Promise<{
          absent: boolean; masterSeriesId?: string; reason?: string;
          legacyMasterProof?: { master: CalendarEvent; occurrence: CalendarEvent };
          legacyInstanceFingerprint?: string;
        }> => {
          for (const taskId of taskIds) {
            if (await this.currentTask(clients.todoist, taskId)
              || await this.providerMappingByTaskAnyProfile(taskId)) return { absent: false };
          }
          const events = new Map<string, CalendarEvent | undefined>();
          for (const eventId of verifiedEventIds) {
            const event = await this.currentEvent(clients.calendar, eventId);
            events.set(eventId, event);
            if (event && event.status !== "cancelled") return { absent: false };
            if ((await Promise.all((["home", "antonio", "work"] as const)
              .map(candidate => this.providerMappingByEvent(candidate, eventId)))).some(Boolean)
            ) return { absent: false };
          }
          if (!recurringIdentity) return { absent: true };
          // An unmapped conflict is not a recurrence-deletion decision, but a
          // recorded Calendar master and active instance still represent a
          // whole series. A cancelled master/child alone cannot justify purging
          // its audit history if another instance or exception survives.
          const relationship = verifyCancelledSeries(masterId, activeInstanceId, verifiedEventIds, events);
          const active = events.get(activeInstanceId!);
          // A recovered master must remain the one independently named by
          // the cancelled occurrence at BOTH preflight reads.
          const legacyVerified = legacyMaster && relationship.valid
            && cancelledOccurrenceMasterId(activeInstanceId,active) === masterId;
          let legacyInstanceFingerprint: string | undefined;
          if(legacyVerified || unmappedRecurring && relationship.valid){
            // A cancelled master with a surviving live/exception occurrence is
            // not a fully deleted series. Inventory every page; a historical
            // confirmed child is allowed only with an immutable completion
            // marker, and that marker is never deleted by this operation.
            let instances: CalendarEvent[];
            try {instances=await clients.calendar.listEventInstances(masterId!);}
            catch {return {absent:false,reason:"Complete cancelled-series instance inventory unavailable"};}
            const checked=await verifyCancelledSeriesInstances({
              profile,taskIds,masterId:masterId!,masterSeriesId:relationship.masterSeriesId!,
              activeInstanceId:activeInstanceId!,instances,nowMs:Date.now(),
            },id=>this.state.getCompletedCalendarProjectionByEvent(profile,id));
            if(!checked.valid)return {absent:false,reason:checked.reason};
            legacyInstanceFingerprint=checked.fingerprint;
          }
          return { absent: relationship.valid && (!legacyMaster || legacyVerified),
            masterSeriesId: relationship.masterSeriesId,
            ...(legacyVerified ? {legacyMasterProof: {
              master: events.get(masterId!)!, occurrence: active!,
            }} : {}),
            ...(legacyVerified || unmappedRecurring ? {legacyInstanceFingerprint} : {}),
            reason: relationship.reason };
        };
        const first = await readProviders();
        if (!first.absent || recurringIdentity && !first.masterSeriesId
          || legacyMaster && !first.legacyMasterProof) continue;
        const seriesKeys = recurringIdentity
          ? [...new Set([...taskIds, ...verifiedEventIds, first.masterSeriesId!,
            item.decision?.seriesId, item.decision?.mappingSnapshot?.seriesId]
            .filter((id): id is string => typeof id === "string" && id.length > 0))]
          : [...new Set([...taskIds, ...verifiedEventIds])];
        if (seriesKeys.length > 20) continue;

        // Re-read all provider identities immediately before cleanup. Exact
        // provider absence and the independently verified recurring master
        // relationship are authoritative; legacy DynamoDB recurrence rows
        // are not correlation or ownership evidence.
        const final = await readProviders();
        if (!final.absent || recurringIdentity && final.masterSeriesId !== first.masterSeriesId
          || (legacyMaster && !final.legacyMasterProof)
          || (legacyMaster || unmappedRecurring)
            && final.legacyInstanceFingerprint!==first.legacyInstanceFingerprint) continue;
        const closed = await review.resolveVerifiedDeletedCase(item.id, {
          profile, taskIds, eventIds: verifiedEventIds,
          ...(recurring ? { seriesKeys,
            masterId, activeInstanceId, masterSeriesId: first.masterSeriesId,
            ...(legacyMaster ? {legacyMasterProof: final.legacyMasterProof} : {}),
          } : {}),
        });
        if (closed) {
          await this.state.audit(profile, "verified_deletion_cleanup_completed", {
            taskId: taskIds[0], eventId: eventIds[0],
          });
        } else {
          await review.noteVerifiedDeletionCleanupDeferred(item.id, item.updatedAt,
            review.lastVerifiedDeletionBlocker || "case_or_provider_snapshot_changed_before_cleanup");
          await this.state.audit(profile, "verified_deletion_cleanup_deferred", {
            taskId: taskIds[0], eventId: eventIds[0],
            reason: review.lastVerifiedDeletionBlocker || "case_or_provider_snapshot_changed_before_cleanup",
          });
        }
      }
      cursor = page.cursor as Record<string, unknown> | undefined;
    } while (cursor && examined < 40);
    await review.saveDeletionSweepCursor(profile, includeHistory, cursor);
  }

  private async reconcileMapping(
    profile: Profile,
    mapping: Mapping,
    listedTask: TodoistTask | undefined,
    clients: ClientPair,
  ): Promise<ReconcileOutcome> {
    // Operator retirement is a terminal no-op, not another blocked or deferred
    // diagnostic. The future Apply transaction will remove this mapping.
    const completedOutcome = await this.retainCompletedProjectionIfMarked(profile, mapping);
    if (completedOutcome) return completedOutcome;
    const todoistNativeSeries = mapping.seriesId === mapping.taskId
      && mapping.masterEventId === mapping.eventId
      && mapping.calendarProgressVersion !== 1;
    if (todoistNativeSeries) {
      const retired = await this.retireDeletedTodoistRecurrence(profile, mapping, clients);
      if (retired) return retired;
    }
    // Recurring mappings were processed by reconcileExistingRecurrence() at
    // the start of this full snapshot run. This mapped-item pass handles only
    // standalone projections; emitting a deferred outcome here would count a
    // successfully handled series as unresolved and reintroduce the obsolete
    // second reconciliation path.
    if (mapping.seriesId || mapping.masterEventId || mapping.activeInstanceId) return "noop";

    // Inventory supplies candidates, never mutation authority. Real provider
    // clients re-read the exact task immediately before comparison; lean test
    // adapters without a direct GET use their supplied snapshot.
    const task = typeof clients.todoist.getTask === "function"
      ? await this.currentTask(clients.todoist, mapping.taskId)
      : listedTask;
    if (task) {
      const currentProfile = profileForTodoistProject(task.project_id);
      if (currentProfile !== profile) {
        const sourceProjectId = mapping.projectId || profiles[profile].todoistProjectId;
        await this.repair(this.reconcileDelivery(profile, task, sourceProjectId, "project-change"));
        await this.deleteReconciliationBaseline(profile, task.id);
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

    const baseline = await this.reconciliationBaseline(mapping);

    if (!baseline) {
      if (!task?.is_deleted && (task?.is_completed || task?.completed_at)) {
        if (event && event.status !== "cancelled") {
          const completedAt = task.completed_at || task.updated_at || new Date().toISOString();
          await this.state.putCompletedCalendarProjection({
            profile, taskId: mapping.taskId, eventId: event.id, completedAt,
            ...(mapping.seriesId ? { seriesId: mapping.seriesId } : {}),
            ...(mapping.masterEventId ? { masterEventId: mapping.masterEventId } : {}),
            ...(mapping.originalStart ? { originalStart: mapping.originalStart } : {}),
          });
          await this.state.audit(profile, "todoist_snapshot_reconcile_completed_projection_retained", {
            taskId: mapping.taskId, eventId: event.id, completedAt, reason: "exact_live_task_reports_completion",
          });
          return "completed_retained";
        }
        return this.applyTodoistChange(profile, mapping, undefined, event, clients);
      }
      if (task && event && event.status !== "cancelled" && hasCanonicalState(event, task)) {
        await this.persistReconciliationBaseline(mapping, task, event, clients);
        await this.state.audit(profile, "todoist_snapshot_reconcile_baseline_established", {
          taskId: mapping.taskId,
          eventId: mapping.eventId,
        });
        return "baseline";
      }
      await this.state.audit(profile, "todoist_snapshot_reconcile_baseline_missing_repaired_from_live_pair", {
        taskId: mapping.taskId,
        eventId: mapping.eventId,
        todoistPresent: Boolean(task),
        calendarPresent: Boolean(event),
        calendarStatus: event?.status,
        tieBreak: "calendar_for_unbased_shared_fields",
      });
      // The provider IDs in this mapping establish the exact pair. A lost
      // baseline is not evidence for a conflict: use current provider reads,
      // apply the documented Calendar tie-break when both live values differ,
      // and propagate a confirmed one-sided deletion. Provider read failures
      // throw earlier and are retried through the normal reconciliation path.
      if (!task || task.is_deleted)
        return this.applyTodoistChange(profile, mapping, undefined, event, clients);
      return this.applyCalendarChange(profile, mapping, task, event, clients);
    }

    const todoistCurrent = task ? canonicalTodoist(task) : null;
    const calendarCurrent = event ? canonicalCalendar(event) : null;
    const todoistChangedFields = "version" in baseline
      ? todoistProviderDiffFields(todoistCurrent, baseline)
      : todoistDiffFields(todoistCurrent, baseline.todoist);
    const calendarChangedFields = "version" in baseline
      ? calendarProviderDiffFields(calendarCurrent, baseline)
      : calendarDiffFields(calendarCurrent, baseline.calendar);
    const todoistChanged = todoistChangedFields.length > 0;
    const calendarChanged = calendarChangedFields.length > 0;

    if (!todoistChanged && !calendarChanged) return "noop";

    if (todoistChanged && calendarChanged) {
      if (!task && (!event || event.status === "cancelled")) {
        await deleteMappingComments(clients.todoist, mapping);
        await this.deleteReconciliationBaseline(profile, mapping.taskId);
        await this.state.audit(profile, "todoist_snapshot_reconcile_converged_deletion", {
          taskId: mapping.taskId,
          eventId: mapping.eventId,
        });
        return "converged";
      }
      if (task && event && event.status !== "cancelled" && hasCanonicalState(event, task)) {
        await this.persistReconciliationBaseline(mapping, task, event, clients);
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
      if (task && event && event.status !== "cancelled") {
        // Merge independent fields. When both providers changed the same
        // field, use provider timestamps only when both parse and differ;
        // equal/missing timestamps use the documented Calendar tie-break.
        const todoistUpdatedAt = Date.parse(task.updated_at || "");
        const calendarUpdatedAt = Date.parse(event.updated || "");
        const todoistIsNewer = Number.isFinite(todoistUpdatedAt) && Number.isFinite(calendarUpdatedAt)
          && todoistUpdatedAt > calendarUpdatedAt;
        const todoistChangedSummary = todoistChangedFields.includes("content");
        const calendarChangedSummary = calendarChangedFields.includes("summary");
        const todoistChangedDescription = todoistChangedFields.includes("description");
        const calendarChangedDescription = calendarChangedFields.includes("description");
        const todoistChangedDue = todoistChangedFields.some(field => field === "due" || field.startsWith("due."));
        const calendarChangedStart = calendarChangedFields.some(field => field === "start" || field.startsWith("start."));
        const todoistWinsSummary = todoistChangedSummary
          && (!calendarChangedSummary || todoistIsNewer);
        const todoistWinsDescription = todoistChangedDescription
          && (!calendarChangedDescription || todoistIsNewer);
        const todoistWinsDue = todoistChangedDue && (!calendarChangedStart || todoistIsNewer);
        const taskProjection = hasDue(task) ? toCalendarEvent(task, event) : event;
        const mergedEvent: CalendarEvent = { ...event };
        if (todoistWinsSummary) mergedEvent.summary = task.content;
        if (todoistWinsDescription) mergedEvent.description = task.description || "";
        if (todoistWinsDue) {
          mergedEvent.start = taskProjection.start;
          mergedEvent.end = taskProjection.end;
        }
        const mergedTaskProjection = toTodoistTask(mergedEvent);
        const mergedTask: TodoistTask = {
          ...task,
          ...(todoistWinsSummary
            ? { content: task.content } : { content: mergedTaskProjection.content }),
          ...(todoistWinsDescription
            ? { description: task.description } : { description: mergedTaskProjection.description }),
          due: mergedTaskProjection.due,
        };
        const outcome = await this.applyMergedChanges(profile, mapping, task, event, mergedTask, mergedEvent, clients);
        await this.state.audit(profile, "todoist_snapshot_reconcile_simultaneous_edits_merged", {
          taskId: task.id, eventId: event.id, todoistChangedFields, calendarChangedFields,
          sameFieldWinner: todoistIsNewer ? "todoist_newer_provider_timestamp" : "calendar_default",
        });
        return outcome;
      }
      return this.applyCalendarChange(profile, mapping, task, event, clients);
    }

    if (todoistChanged) return this.applyTodoistChange(profile, mapping, task, event, clients);
    return this.applyCalendarChange(profile, mapping, task, event, clients);
  }

  private async reconcileUnmappedTask(
    profile: Profile,
    listedTask: TodoistTask,
    clients: ClientPair,
    calendarInventory?: CalendarEvent[],
  ): Promise<ReconcileOutcome> {
    // listTasks is a paginated snapshot, not proof the source still exists.
    // Re-read the exact Todoist ID before repairing an unmapped projection so
    // a concurrent deletion cannot be replayed into a new Calendar event.
    let task = listedTask;
    if (typeof clients.todoist.getTask === "function") {
      task = await this.currentTask(clients.todoist, listedTask.id) as TodoistTask;
      if (!task) {
        await this.state.audit(profile, "todoist_snapshot_reconcile_inactive_task_ignored", {
          taskId: listedTask.id, reason: "exact_provider_read_not_found",
        });
        return "noop";
      }
    }
    // Scheduled inventory can race a provider deletion or completion. A
    // stale list entry is not an active source and must never create a fresh
    // Calendar projection in the absence of an exact live mapping.
    if (task.is_deleted || task.is_completed || task.completed_at) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_inactive_task_ignored", {
        taskId: task.id, deleted: Boolean(task.is_deleted), completed: Boolean(task.is_completed || task.completed_at),
      });
      return "noop";
    }
    if (!hasDue(task)) return "noop";
    // #369: a reset that committed before its Todoist webhook/provider POST
    // finished must remain retryable. Reconciliation drives the normal
    // source-upsert path from the exact current Todoist task; it must not
    // interpret preserved cancelled provider aliases as a new conflict.
    const pendingAnnual = await this.state.getCancelledAnnualRecoveryReceipt?.(profile,task.id);
    if (pendingAnnual) {
      if (task.is_deleted || task.is_completed || task.completed_at
        || !recoveryReceiptMatchesTask(pendingAnnual,task)) {
        await this.state.audit(profile,"todoist_snapshot_annual_reset_source_changed",{
          taskId:task.id,
        });
        return "blocked";
      }
      await this.repair(this.reconcileDelivery(profile,task,"reconcile-unmapped","projection-create"));
      const next=await this.providerMappingByTask(profile, task.id, clients.todoist);
      const standalone=pendingAnnual.sourcePolicy==="standalone";
      if (!next || (standalone
        ? Boolean(next.masterEventId || next.seriesId || next.activeInstanceId)
        : next.seriesId!==next.taskId || !next.masterEventId
          || next.masterEventId!==next.eventId)) {
        await this.state.audit(profile,"todoist_snapshot_annual_reset_recheck_required",{taskId:task.id});
        return "blocked";
      }
      const event=await this.currentEvent(clients.calendar,next.eventId);
      if (!event || event.status!=="confirmed"
        || (standalone
          ? Boolean(event.recurrence?.length || event.recurringEventId) || !hasCanonicalState(event,task)
          : !calendarRecurrenceMatchesTodoist(event,task) || !hasCanonicalState(event,task))) {
        await this.state.audit(profile,"todoist_snapshot_annual_reset_recheck_required",{taskId:task.id});
        return "blocked";
      }
      await this.persistReconciliationBaseline(next, task, event, clients);
      return "created";
    }
    let existing: CalendarEvent | undefined;
    let discoveredCandidate: Awaited<ReturnType<typeof discoverCompatibleCalendarCandidates>>[number] | undefined;
    try {
      existing = await clients.calendar.findByTodoistTaskId(task.id);
    } catch (error) {
      if (!(error instanceof AmbiguousCalendarLinkError)) throw error;
      await this.state.audit(profile, "todoist_snapshot_reconcile_unmapped_ambiguous", {
        taskId: task.id,
        candidateEventIds: error.eventIds,
      });
      return "conflict";
    }
    if (!existing && typeof clients.calendar.listDelta === "function") {
      const inventory = calendarInventory || (await clients.calendar.listDelta()).items;
      const compatible = await discoverCompatibleCalendarCandidates(task, inventory, clients.calendar);
      if (compatible.length > 1) {
        await this.state.audit(profile, "todoist_snapshot_reconcile_unmapped_ambiguous", {
          taskId: task.id, candidateEventIds: compatible.map(candidate => candidate.master.id).sort(),
          reason: "multiple_exact_compatible_calendar_events",
        });
        return "conflict";
      }
      if (compatible.length === 1) {
        discoveredCandidate = compatible[0];
        existing = discoveredCandidate.master;
      }
    }
    // A cancelled provider object is the deletion evidence. A later live
    // Todoist edit can intentionally recreate its projection; no durable
    // deletion tombstone is needed to distinguish the two states.
    const cancelledProjectionRecreationAllowed = Boolean(existing?.status === "cancelled"
      && isStrictlyNewer(task.updated_at, existing.updated || ""));

    if (isBlockedCalendarStatus(existing)) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_calendar_status_blocked", {
        taskId: task.id,
        eventId: existing?.id,
        calendarStatus: existing?.status,
      });
      return "blocked";
    }

    if (existing?.status === "cancelled" && !cancelledProjectionRecreationAllowed) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_cancelled_projection_blocked", {
        taskId: task.id,
        eventId: existing.id,
        taskUpdatedAt: task.updated_at,
        calendarUpdatedAt: existing.updated,
        calendarEtag: existing.etag,
      });
      return "blocked";
    }

    // A retained completed occurrence is history, never a fresh active link.
    // Check before baseline and recovery decisions; only deletion decisions
    // may intentionally change these terminal records.
    if (existing && existing.status !== "cancelled") {
      const completed = await this.completedProjection(profile, existing.id);
      if (completed?.taskId === task.id) {
        await this.state.audit(profile, "todoist_snapshot_completed_projection_retained", {
          taskId: task.id, eventId: existing.id, completedAt: completed.completedAt,
        });
        return "completed_retained";
      }
      if (completed) {
        await this.state.audit(profile, "todoist_snapshot_reconcile_completed_owner_conflict", {
          taskId: task.id, eventId: existing.id, ownerTaskId: completed.taskId,
        });
        return "conflict";
      }
    }

    if (existing && existing.status !== "cancelled") {
      const synchronizer = new Synchronizer(this.state, undefined, async () => clients);
      if (discoveredCandidate) {
        const refreshed = await discoverCompatibleCalendarCandidates(task, [discoveredCandidate.master], clients.calendar);
        if (refreshed.length !== 1 || refreshed[0].master.id !== discoveredCandidate.master.id
          || refreshed[0].event.id !== discoveredCandidate.event.id) {
          await this.state.audit(profile, "todoist_snapshot_reconcile_candidate_changed", {
            taskId: task.id, candidateEventIds: [discoveredCandidate.master.id, discoveredCandidate.event.id],
          });
          return "conflict";
        }
        discoveredCandidate = refreshed[0];
        existing = discoveredCandidate.master;
      }
      const identityIds = discoveredCandidate
        ? [...new Set([discoveredCandidate.master.id, discoveredCandidate.event.id])]
        : [existing.id];
      const identityOwners = await synchronizer.providerMappingsForCalendarIdentity(profile, identityIds, clients.todoist);
      const conflictingOwners = discoveredCandidate
        ? compatibleCalendarCandidateOwnerConflicts(discoveredCandidate, identityOwners, task.id, profile)
        : identityOwners.filter(owner => owner.taskId !== task.id).map(owner => owner.taskId);
      const byCalendar = synchronizer.mappingFromCalendarCorrelation(profile, existing);
      if (conflictingOwners.length || byCalendar && byCalendar.taskId !== task.id) {
        await this.state.audit(profile, "todoist_snapshot_reconcile_mapping_owner_conflict", {
          taskId: task.id, eventId: existing.id,
          ownerTaskId: conflictingOwners[0] || byCalendar?.taskId,
        });
        return "conflict";
      }
      const byComment = await this.providerMappingByEvent(profile, existing.id, clients.todoist);
      const correlation = byComment || byCalendar;
      if ((byComment && byComment.taskId !== task.id) || (byCalendar && byCalendar.taskId !== task.id)) {
        await this.state.audit(profile, "todoist_snapshot_reconcile_mapping_owner_conflict", {
          taskId: task.id, eventId: existing.id, ownerTaskId: correlation?.taskId,
        });
        return "conflict";
      }
      if (discoveredCandidate) {
        const discovered: Mapping = discoveredCandidate.master.recurrence?.length
          ? { profile, eventId: discoveredCandidate.master.id, taskId: task.id,
            projectId: profiles[profile].todoistProjectId, seriesId: task.id,
            masterEventId: discoveredCandidate.master.id, activeInstanceId: discoveredCandidate.event.id,
            originalStart: discoveredCandidate.event.originalStartTime?.dateTime
              || discoveredCandidate.event.originalStartTime?.date
              || discoveredCandidate.event.start?.dateTime || discoveredCandidate.event.start?.date,
            activeEffectiveStart: discoveredCandidate.event.start?.dateTime || discoveredCandidate.event.start?.date,
            updatedAt: new Date().toISOString() }
          : { profile, eventId: discoveredCandidate.event.id, taskId: task.id,
            projectId: profiles[profile].todoistProjectId, updatedAt: new Date().toISOString() };
        const persisted = await this.persistProviderMapping(discovered, clients);
        await this.persistReconciliationBaseline(persisted, task, discoveredCandidate.event, clients);
        await this.state.audit(profile, "todoist_snapshot_reconcile_provider_pair_recovered", {
          taskId: task.id, eventId: discoveredCandidate.event.id,
          masterEventId: discoveredCandidate.master.id,
          tieBreak: "unique_exact_compatible_match",
        });
        return "baseline";
      }
      if (correlation?.taskId === task.id) {
        if (hasCanonicalState(existing, task)) {
          await this.persistReconciliationBaseline({ ...correlation, ...byCalendar }, task, existing, clients);
          await this.state.audit(profile, "todoist_snapshot_reconcile_provider_correlation_recovered", {
            taskId: task.id, eventId: existing.id,
          });
          return "baseline";
        }
        const outcome = await this.applyCalendarChange(profile, { ...correlation, ...byCalendar }, task, existing, clients);
        await this.state.audit(profile, "todoist_snapshot_reconcile_provider_pair_repaired", {
          taskId: task.id, eventId: existing.id, tieBreak: "calendar_without_baseline",
        });
        return outcome;
      }
    }

    if (existing && existing.status !== "cancelled" && !hasCanonicalState(existing, task)) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_unmapped_conflict", {
        taskId: task.id,
        eventId: existing.id,
        mismatchCategories: unmappedMismatchCategories(existing, task),
        taskUpdatedAt: task.updated_at,
        calendarUpdatedAt: existing.updated,
        calendarEtag: existing.etag,
      });
      return "conflict";
    }

    if (existing && existing.status !== "cancelled") {
      const mapping = await this.persistProviderMapping({
        profile, eventId: existing.recurringEventId || existing.id, taskId: task.id,
        projectId: profiles[profile].todoistProjectId,
        ...(existing.recurringEventId || existing.recurrence?.length
          ? { seriesId: existing.iCalUID || existing.recurringEventId || existing.id,
            masterEventId: existing.recurringEventId || existing.id }
          : {}),
        updatedAt: new Date().toISOString(),
      }, clients);
      await this.persistReconciliationBaseline(mapping, task, existing, clients);
      await this.state.audit(profile, "todoist_snapshot_reconcile_provider_pair_recovered", {
        taskId: task.id, eventId: existing.id, tieBreak: "unique_exact_compatible_match",
      });
      return "baseline";
    }

    await this.repair(this.reconcileDelivery(profile, task, "reconcile-unmapped", "projection-create"));
    const mapping = await this.providerMappingByTask(profile, task.id, clients.todoist);
    if (!mapping) {
      await this.state.audit(profile, "todoist_snapshot_reconcile_mapping_missing_after_repair", {
        taskId: task.id, reason: "projection_repair_did_not_persist_mapping",
      });
      return "blocked";
    }
    const stored = await this.currentEvent(clients.calendar, mapping.eventId);
    if (stored && !isBlockedCalendarStatus(stored) && stored.status !== "cancelled") {
      await this.persistReconciliationBaseline(mapping, task, stored, clients);
    }
    return "created";
  }

  async reconcile(
    profile: Profile,
    continuation?: ReconciliationContinuation,
    maxCandidates = reconciliationCandidateLimit(),
  ): Promise<SnapshotReconciliationResult> {
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new Error("Reconciliation candidate limit must be a positive integer");
    // Reuse one provider client per profile within this snapshot so cached
    // project comment pages are shared across mapping lookups. A new
    // reconciliation gets a fresh provider inventory.
    this.clientPairs.clear();
    const clients = await this.clients(profile);
    const recurrence = continuation?.recurrence
      ?? (await this.reconcileExistingRecurrence(profile))
      ?? { total: 1, converged: 0, repaired: 0, unsupported: 0, excluded: 0, blocked: 0, stale: 0, unverified: 1 };

    const tasks = (await clients.todoist.listTasks()).slice().sort((a, b) => a.id.localeCompare(b.id));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const mappings = (await this.providerMappings(profile, clients.todoist)).slice().sort((a, b) => a.taskId.localeCompare(b.taskId));
    const mappedTaskIds = new Set(mappings.map((mapping) => mapping.taskId));
    const unmappedTasks = tasks.filter((task) => !mappedTaskIds.has(task.id));
    const counts = emptyCounts();
    if (!continuation?.recurrence && recurrence) {
      counts.recurrence_reported = 1;
      counts.recurrence_total += recurrence.total;
      counts.recurrence_converged += recurrence.converged;
      counts.recurrence_repaired += recurrence.repaired;
      counts.recurrence_unsupported += recurrence.unsupported;
      counts.recurrence_excluded += recurrence.excluded;
      counts.recurrence_blocked += recurrence.blocked;
      counts.recurrence_stale += recurrence.stale;
      counts.recurrence_unverified += recurrence.unverified;
    }
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
        recurrence,
      });
      return { continuation: { ...next, ...(recurrence ? { recurrence } : {}) }, processedCandidates, counts, recurrence };
    };

    if (!continuation || continuation.phase === "mapped") {
      const afterTaskId = continuation?.phase === "mapped" ? continuation.afterTaskId : undefined;
      const candidates = mappings.filter((mapping) => !afterTaskId || mapping.taskId > afterTaskId);
      for (let index = 0; index < candidates.length; index += 1) {
        const mapping = candidates[index];
        const outcome = await this.reconcileMapping(profile, mapping, taskById.get(mapping.taskId), clients)
          .catch((error: unknown) => this.rethrowCandidateError(profile, error, { stage: "mapped", taskId: mapping.taskId, eventId: mapping.eventId }));
        counts[outcome] += 1;
        if (isResolvedConflictOutcome(outcome)) {
          const resolve = (this.state as StateRepository & { resolveConflictAudits?: StateRepository["resolveConflictAudits"] }).resolveConflictAudits;
          await resolve?.call(this.state, profile, { taskId: mapping.taskId });
        }
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
    const calendarInventory = unmappedCandidates.length && typeof clients.calendar.listDelta === "function"
      ? (await clients.calendar.listDelta()).items : undefined;
    for (let index = 0; index < unmappedCandidates.length; index += 1) {
      const task = unmappedCandidates[index];
        const outcome = await this.reconcileUnmappedTask(profile, task, clients, calendarInventory)
        .catch((error: unknown) => this.rethrowCandidateError(profile, error, { stage: "unmapped", taskId: task.id }));
      counts[outcome] += 1;
      if (isResolvedConflictOutcome(outcome)) {
        const resolve = (this.state as StateRepository & { resolveConflictAudits?: StateRepository["resolveConflictAudits"] }).resolveConflictAudits;
        await resolve?.call(this.state, profile, { taskId: task.id });
      }
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
      recurrence,
    });
    await this.retireVerifiedDeletedCases(profile, clients);
    await this.retireVerifiedDeletedCases(profile, clients, true);
    return { processedCandidates, counts, recurrence };
  }
}
