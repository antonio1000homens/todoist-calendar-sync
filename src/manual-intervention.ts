import { createHash } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient, pacedScan, withProfileLookupDeadline } from "./dynamodb-capacity.js";
import { secureParameter } from "./config.js";
import { createBudgetedClientFactory, defaultProviderClientFactory, isMutationBudgetExhausted, ReconciliationMutationBudget, type ProviderClientFactory } from "./mutation-budget.js";
import { enqueueDelivery, requestReconciliation, type ReconciliationRequestResult } from "./queue.js";
import { clearDeadLetterMessagesForProfile } from "./dead-letter-queue.js";
import { InterventionPolicyStore, type EffectiveInterventionPolicy, type InterventionPolicyScope, type InterventionResponseMode } from "./intervention-policy.js";
import { StateRepository } from "./repository.js";
import { ReconciliationItemError } from "./reconciliation-diagnostics.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import { profiles } from "./config.js";
import { normalizedText } from "./security.js";
import { deleteMappingComments } from "./mapping-comments.js";
import { todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import { planFutureSeriesSplit, type FutureSeriesSplitPlan } from "./recurrence-split.js";
import { retainedConflictIdentity } from "./audit-policy.js";
import {
  MANUAL_PENDING_LOOKUP_PREFIX,
  manualPendingLookupAttributes,
  PROFILE_LOOKUP_INDEX_NAME,
  PROFILE_LOOKUP_MIGRATION_VERSION,
  PROFILE_LOOKUP_READY_KEY,
  PROFILE_LOOKUP_READY_SORT_KEY,
} from "./profile-lookup.js";

import { applyApprovedFutureSeriesSplit, assertApprovedHistoryCap } from "./future-split-execution.js";
import { ReviewStore, reviewHash } from "./review-store.js";
import { competingUnmappedIdentities, manualConflictWindow, unresolvedStandalonePair } from "./unmapped-resolution.js";
import { hasCanonicalState, toCalendarEvent, toTodoistTask } from "./sync.js";
import type { CalendarEvent, Delivery, Mapping, Profile, RecurrenceLink, TodoistTask, TodoistWebhookPayload } from "./types.js";

function futureSplitDescription(plan: FutureSeriesSplitPlan, anchor?: string): string {
  const history = plan.expiredUntil
    ? `Calendar RRULE ${plan.originalRule} from ${anchor || "(historical master)"} expired on ${plan.expiredUntil}; keep it unchanged`
    : `Calendar RRULE ${plan.originalRule} from ${anchor || "(historical master)"}; retain through ${plan.previousOccurrence} and stop old dates from ${plan.nextOldOccurrence}`;
  return `${history}; new master starts ${plan.newStart} with ${plan.newRule} (Calendar timezone ${plan.calendarTimeZone})`;
}
const DEFAULT_DECISION_RETENTION_DAYS = 30;
const DEFAULT_DECISION_DEADLINE_DAYS = 7;
const PENDING_DECISION_QUERY_PAGE_LIMIT = 25;
const PENDING_DECISION_QUERY_MAX_PAGES = 12;
const MAX_MANUAL_BULK_MUTATIONS = 10;
const MANUAL_CALENDAR_MUTATIONS = new Set([
  "upsertEvent", "upsertEventIfUnchanged", "updateSharedEventPropertiesIfUnchanged", "createFutureMasterOnce", "deleteEvent",
]);
const MANUAL_TODOIST_MUTATIONS = new Set(["upsertTask", "updateRecurringOccurrence", "deleteTask", "upsertComment", "deleteComment"]);

class ManualCircuitOpenError extends Error {
  constructor(readonly profile: Profile, readonly operation: string) {
    super(`Manual intervention blocked by the mutation circuit for ${profile} before ${operation}`);
    this.name = "ManualCircuitOpenError";
  }
}
class ManualSyncBlockedError extends Error {
  constructor() { super("An affected item or pairing is protected by a repair, exclusion, or rejected link. Use the review page to resolve it."); this.name = "ManualSyncBlockedError"; }
}

export type ManualDecisionStatus = "pending" | "resolved" | "stale" | "cancelled" | "expired";
export type ManualDecisionSeverity = "info" | "warning" | "destructive";
export type ManualDecisionType =
  | "calendar_owned_recurrence_task_deleted"
  | "todoist_owned_recurrence_task_deleted"
  | "standalone_todoist_task_deleted"
  | "calendar_snapshot_unmapped_ambiguous"
  | "calendar_snapshot_recurring_ambiguous"
  | "todoist_unmapped_conflict"
  | "todoist_cancelled_projection_blocked"
  | "both_sides_changed"
  | "mapping_owner_conflict"
  | "lost_mapping_calendar_only"
  | "lost_mapping_todoist_only"
  | "projection_tombstone_conflict"
  | "cross_profile_move_ambiguous"
  | "unsupported_recurrence"
  | "baseline_recovery_review"
  | "large_reconciliation_candidate_set"
  | "operational_mutation_budget"
  | "operational_circuit_open"
  | "operational_reconciliation_stuck"
  | "operational_dlq"
  | "operational_provider_auth"
  | "operational_partial_mutation";

export interface ManualActionDefinition {
  id: string;
  label: string;
  destructive?: boolean;
  /** Explicitly eligible for unattended execution under an approved policy or catalog default. */
  autoAllowed?: boolean;
}

export interface ManualDecisionPolicy {
  title: string;
  severity: ManualDecisionSeverity;
  actions: ManualActionDefinition[];
  detection: "pre_mutation" | "audit_conflict" | "operational" | "future";
  defaultMode?: InterventionResponseMode;
  defaultAction?: string;
}

const actions = (...items: Array<[string, string, boolean?, boolean?]>): ManualActionDefinition[] =>
  items.map(([id, label, destructive, autoAllowed]) => ({
    id,
    label,
    ...(destructive ? { destructive: true } : {}),
    ...(autoAllowed ? { autoAllowed: true } : {}),
  }));

/**
 * Typed policy/catalog for the human-in-the-loop use cases in issue #49.
 * Some entries are deliberately marked `future`: the control plane can store,
 * render and resolve them once their detector is connected, without adding
 * Slack-specific branching to the handler.
 */
export const MANUAL_DECISION_CATALOG: Record<ManualDecisionType, ManualDecisionPolicy> = {
  calendar_owned_recurrence_task_deleted: {
    title: "Todoist mirror deleted — Calendar recurrence still exists",
    severity: "destructive",
    detection: "pre_mutation",
    actions: actions(
      ["skip_occurrence", "Skip this occurrence", true, true],
      ["delete_this_and_future", "Delete this and future", true],
      ["delete_whole_series", "Delete whole Calendar series", true],
      ["restore_todoist_task", "Restore Todoist task", false, true],
    ),
  },
  todoist_owned_recurrence_task_deleted: {
    title: "Todoist recurrence deleted — Calendar projection still exists",
    severity: "destructive",
    detection: "pre_mutation",
    defaultMode: "auto",
    defaultAction: "delete_calendar_series",
    actions: actions(
      ["delete_calendar_series", "Delete Calendar series", true, true],
      ["keep_calendar_unlinked", "Keep Calendar and unlink", false, true],
      ["restore_todoist_task", "Restore Todoist task", false, true],
    ),
  },
  standalone_todoist_task_deleted: {
    title: "Todoist task deleted — mapped Calendar event still exists",
    severity: "destructive",
    detection: "pre_mutation",
    // A mapped standalone deletion is an ordinary one-sided sync operation,
    // not a request for a destructive-action approval (issue #229).
    defaultMode: "auto",
    defaultAction: "delete_calendar_event",
    actions: actions(
      ["delete_calendar_event", "Delete Calendar event", true, true],
      ["restore_todoist_task", "Restore Todoist task", false, true],
    ),
  },
  calendar_snapshot_unmapped_ambiguous: {
    title: "Unmapped Calendar event has multiple Todoist matches",
    severity: "warning",
    detection: "audit_conflict",
    actions: actions(["create_new_task", "Create a new Todoist task"]),
  },
  calendar_snapshot_recurring_ambiguous: {
    title: "Unmapped Calendar recurrence has multiple Todoist matches",
    severity: "warning",
    detection: "audit_conflict",
    actions: actions(["create_new_task", "Create a new Todoist mirror"]),
  },
  todoist_unmapped_conflict: {
    title: "Todoist task and Calendar projection cannot be safely relinked",
    severity: "warning",
    detection: "audit_conflict",
    actions: actions(
      ["use_todoist_recurrence", "Use Todoist recurrence", true],
      ["split_future_todoist", "Use Todoist for future — keep Calendar history", true],
      ["use_calendar_version", "Use Calendar version", true],
      ["keep_separate", "Keep separate / Ignore"],
      ["reconcile_now", "Retry guarded reconciliation"],
    ),
  },
  todoist_cancelled_projection_blocked: {
    title: "Calendar projection was cancelled — Todoist task still exists",
    severity: "warning",
    detection: "audit_conflict",
    actions: actions(
      ["acknowledge", "Keep Calendar deleted"],
      ["reconcile_now", "Retry guarded reconciliation"],
      ["consolidate_duplicate", "Keep yearly task; remove duplicate task and cancelled event", true],
    ),
  },
  both_sides_changed: {
    title: "Calendar and Todoist both changed since the baseline",
    severity: "warning",
    detection: "audit_conflict",
    actions: actions(
      ["calendar_wins", "Use Calendar version", true],
      ["todoist_wins", "Use Todoist version", true],
    ),
  },
  mapping_owner_conflict: {
    title: "Todoist task is already owned by another Calendar mapping",
    severity: "destructive",
    detection: "future",
    actions: actions(["keep_existing_owner", "Keep existing owner"], ["create_new_task", "Create separate task"]),
  },
  lost_mapping_calendar_only: {
    title: "Calendar event exists but its Todoist mapping is missing",
    severity: "warning",
    detection: "future",
    actions: actions(["create_new_task", "Create Todoist task"], ["delete_calendar_event", "Delete Calendar event", true]),
  },
  lost_mapping_todoist_only: {
    title: "Todoist task exists but its Calendar mapping is missing",
    severity: "warning",
    detection: "future",
    actions: actions(["recreate_calendar", "Recreate Calendar event"], ["keep_todoist_only", "Keep Todoist only"]),
  },
  projection_tombstone_conflict: {
    title: "Projection tombstone conflicts with current provider state",
    severity: "warning",
    detection: "future",
    actions: actions(["keep_deleted", "Keep projection deleted"], ["restore_projection", "Restore projection"]),
  },
  cross_profile_move_ambiguous: {
    title: "Cross-profile task move needs an ownership decision",
    severity: "destructive",
    detection: "future",
    actions: actions(["move_mapping", "Move mapping"], ["return_to_source", "Return to source"], ["unlink", "Unlink"]),
  },
  unsupported_recurrence: {
    title: "Todoist recurrence cannot be represented losslessly in Calendar",
    severity: "info",
    detection: "future",
    actions: actions(["rolling_mirror", "Use rolling mirror"], ["do_not_sync_recurrence", "Do not sync recurrence"]),
  },
  baseline_recovery_review: {
    title: "Baseline recovery found a large set of candidates",
    severity: "warning",
    detection: "future",
    actions: actions(["reconcile_now", "Run capped recovery"], ["review_conflicts", "Review conflicts only"]),
  },
  large_reconciliation_candidate_set: {
    title: "Reconciliation candidate set is unexpectedly large",
    severity: "warning",
    detection: "future",
    actions: actions(["reconcile_now", "Continue capped reconciliation"]),
  },
  operational_mutation_budget: {
    title: "Reconciliation reached the provider mutation cap",
    severity: "info",
    detection: "operational",
    actions: actions(["reconcile_now", "Request another reconciliation"]),
  },
  operational_circuit_open: {
    title: "Sync circuit breaker is open",
    severity: "warning",
    detection: "operational",
    actions: actions(["reconcile_now", "Retry through normal reconciliation"]),
  },
  operational_reconciliation_stuck: {
    title: "Reconciliation needed",
    severity: "warning",
    detection: "future",
    actions: actions(["reconcile_now", "Resume reconciliation"]),
  },
  operational_dlq: {
    title: "Reconciliation needed — a sync delivery was quarantined",
    severity: "warning",
    detection: "operational",
    actions: actions(["reconcile_now", "Request fresh reconciliation"]),
  },
  operational_provider_auth: {
    title: "Provider authentication or authorization failed",
    severity: "warning",
    detection: "operational",
    actions: actions(["reconcile_now", "Retry after credentials are fixed"]),
  },
  operational_partial_mutation: {
    title: "Provider and mapping state may be partially applied",
    severity: "destructive",
    detection: "future",
    actions: actions(["reconcile_now", "Reconcile current provider state"]),
  },
};

export interface ManualDecision {
  decisionId: string;
  profile: Profile;
  type: ManualDecisionType;
  severity: ManualDecisionSeverity;
  status: ManualDecisionStatus;
  createdAt: string;
  decisionDeadline: string;
  sourceDeliveryId?: string;
  sourceAuditAction?: string;
  eventId?: string;
  taskId?: string;
  seriesId?: string;
  masterEventId?: string;
  activeInstanceId?: string;
  mappingSnapshot?: Mapping;
  context: Record<string, unknown>;
  fingerprint: string;
  permittedActions: ManualActionDefinition[];
  policyMode?: InterventionResponseMode;
  policyScope?: EffectiveInterventionPolicy["source"];
  defaultAction?: string;
  slackChannelId?: string;
  slackMessageTs?: string;
  resolvedBySlackUserId?: string;
  resolution?: string;
  resolvedAt?: string;
}

interface StoredDecision extends ManualDecision {
  pk: string;
  sk: "STATE";
  expiresAt: number;
}

function tableName(): string {
  const value = process.env.STATE_TABLE_NAME;
  if (!value) throw new Error("STATE_TABLE_NAME is not configured");
  return value;
}

function isoNow(): string {
  return new Date().toISOString();
}

function epochDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 20);
}

function consolidationMasterFingerprint(event: CalendarEvent, plan: ReturnType<typeof planFutureSeriesSplit>, taskId: string): string {
  const normalized = { ...event } as Record<string, unknown>;
  delete normalized.etag;
  delete normalized.updated;
  // The approved cap intentionally changes only these recurrence ownership
  // fields. Exclude RRULE formatting here; assertApprovedHistoryCap validates it.
  delete normalized.recurrence;
  const properties = (event.extendedProperties || {}) as { shared?:Record<string,string>; [key:string]:unknown };
  const shared = { ...(properties.shared || {}) };
  delete shared.taskId;
  delete shared.syncRecurrenceOwner;
  delete shared.todoistRecurrence;
  delete shared.syncHistoryCutoff;
  Object.assign(shared, {
    syncSource:"todoist-calendar-sync", syncHistoryOnly:"true", syncHistoryTaskId:taskId,
    syncHistoryOriginalRule:plan.originalRule, syncHistorySuccessorId:plan.newMasterId,
    ...(plan.previousOccurrence ? { syncHistoryCutoff: plan.previousOccurrence } : {}),
  });
  normalized.extendedProperties = { ...properties, shared };
  return fingerprint(normalized);
}

function decisionKey(profile: Profile, type: ManualDecisionType, identity: Record<string, unknown>): { decisionId: string; fingerprint: string } {
  const stateFingerprint = fingerprint(identity);
  return {
    decisionId: `${profile}-${type}-${stateFingerprint}`,
    fingerprint: stateFingerprint,
  };
}

function providerNotFound(error: unknown): boolean {
  const provider = error as { status?: number; body?: string };
  if (Number(provider.status) === 404) return true;
  if (Number(provider.status) !== 410) return false;
  try { return JSON.parse(provider.body || "").error?.errors?.[0]?.reason === "deleted"; }
  catch { return false; }
}

function eventStart(event: CalendarEvent): string | undefined {
  return event.originalStartTime?.dateTime || event.originalStartTime?.date || event.start?.dateTime || event.start?.date;
}

function eventDisplayStart(event: CalendarEvent): string | undefined {
  return event.start?.dateTime || event.start?.date || eventStart(event);
}

function todoistDue(task: TodoistTask): string | undefined {
  return task.due?.datetime || task.due?.date;
}

function recurrenceLink(mapping: Mapping): RecurrenceLink {
  if (!mapping.seriesId) throw new Error("Recurring manual mapping is missing seriesId");
  return {
    profile: mapping.profile,
    owner: mapping.recurrenceOwner || "calendar",
    seriesId: mapping.seriesId,
    masterEventId: mapping.masterEventId,
    activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart,
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    updatedAt: mapping.updatedAt,
  };
}

export class ManualDecisionStore {
  async get(decisionId: string): Promise<ManualDecision | undefined> {
    const result = await documentClient.send(new GetCommand({
      TableName: tableName(),
      Key: { pk: `MANUAL#${decisionId}`, sk: "STATE" },
      ConsistentRead: true,
    }));
    return result.Item as StoredDecision | undefined;
  }

  async putPending(input: Omit<ManualDecision, "status" | "createdAt" | "decisionDeadline">): Promise<{ decision: ManualDecision; created: boolean }> {
    const current = await this.get(input.decisionId);
    // Deterministic decisions are one-shot history. A repeated detector with the
    // same state fingerprint must never overwrite a terminal decision.
    if (current) {
      await new ReviewStore().observeDecision(current);
      return { decision: current, created: false };
    }
    const decision: ManualDecision = {
      ...input,
      status: "pending",
      createdAt: isoNow(),
      decisionDeadline: plusDays(DEFAULT_DECISION_DEADLINE_DAYS),
    };
    await documentClient.send(new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `MANUAL#${decision.decisionId}`,
        sk: "STATE",
        ...decision,
        ...manualPendingLookupAttributes(decision),
        expiresAt: epochDays(DEFAULT_DECISION_RETENTION_DAYS),
      },
    }));
    await new ReviewStore().observeDecision(decision);
    return { decision, created: true };
  }

  /** Bind a visible future-split preview to the pending decision before approval. */
  async refreshPendingContext(decisionId: string, context: Record<string, unknown>): Promise<void> {
    await documentClient.send(new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `MANUAL#${decisionId}`, sk: "STATE" },
      UpdateExpression: "SET #context = :context",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#context": "context", "#status": "status" },
      ExpressionAttributeValues: { ":context": context, ":pending": "pending" },
    }));
  }

  async listPending(profile?: Profile, options: { deadlineAtMs?: number; requestId?: string; maxPagesPerProfile?: number } = {}): Promise<ManualDecision[]> {
    const result = await this.listPendingIndexed(profile, options);
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async setSlackLocation(decisionId: string, channel: string, ts: string): Promise<void> {
    await documentClient.send(new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `MANUAL#${decisionId}`, sk: "STATE" },
      UpdateExpression: "SET slackChannelId = :channel, slackMessageTs = :ts, expiresAt = :expiresAt",
      ExpressionAttributeValues: { ":channel": channel, ":ts": ts, ":expiresAt": epochDays(DEFAULT_DECISION_RETENTION_DAYS) },
    }));
  }

  async finish(decisionId: string, status: Exclude<ManualDecisionStatus, "pending">, resolution: string, slackUserId?: string): Promise<void> {
    await documentClient.send(new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `MANUAL#${decisionId}`, sk: "STATE" },
      UpdateExpression: "SET #status = :status, resolution = :resolution, resolvedAt = :resolvedAt, resolvedBySlackUserId = :user, expiresAt = :expiresAt REMOVE lookupPk, lookupSk",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pending": "pending",
        ":status": status,
        ":resolution": resolution,
        ":resolvedAt": isoNow(),
        ":user": slackUserId || "system",
        ":expiresAt": epochDays(DEFAULT_DECISION_RETENTION_DAYS),
      },
    }));
    const decision = await this.get(decisionId);
    if (decision) {
      const dismissal = ["acknowledge","keep_separate","ignore","dismiss","dismissed"].includes(resolution.toLowerCase());
      const reviewStatus = status === "resolved" ? dismissal ? "dismissed" : "resolved" : status === "expired" ? "dismissed" : "open";
      try { await new ReviewStore().updateCase(decisionId, reviewStatus, resolution); }
      catch (error) { if ((error as {name?:string}).name !== "ConditionalCheckFailedException") throw error; }
    }
  }

  private async listPendingIndexed(
    profile: Profile | undefined,
    options: { deadlineAtMs?: number; requestId?: string; maxPagesPerProfile?: number },
  ): Promise<ManualDecision[]> {
    const startedAt = Date.now();
    const deadlineAtMs = options.deadlineAtMs ?? startedAt + 20_000;
    const requestId = options.requestId;
    const maxPagesPerProfile = Math.max(1, Math.floor(options.maxPagesPerProfile || PENDING_DECISION_QUERY_MAX_PAGES));
    const pageLimit = PENDING_DECISION_QUERY_PAGE_LIMIT;
    const table = tableName();
    const completeByProfile: Record<string, boolean> = {};
    const results: ManualDecision[] = [];
    const owners: Profile[] = profile ? [profile] : ["home", "antonio", "work"];
    let totalPages = 0;
    let examined = 0;

    if (Date.now() >= deadlineAtMs) {
      console.warn(JSON.stringify({
        service: "todoist-calendar-sync-health",
        event: "list_pending_manual_decisions_incomplete",
        operation: "list_pending_manual_decisions",
        profile,
        requestId,
        pages: 0,
        itemsExamined: 0,
        itemsReturned: 0,
        elapsedMs: Date.now() - startedAt,
        complete: false,
        reason: "deadline_budget_exhausted",
      }));
      throw new Error("Pending manual-decision lookup deadline exhausted");
    }
    let ready: any;
    try {
      ready = await documentClient.send(new GetCommand({
        TableName: table,
        Key: { pk: PROFILE_LOOKUP_READY_KEY, sk: PROFILE_LOOKUP_READY_SORT_KEY },
        ConsistentRead: true,
      }), { abortSignal: AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now())) });
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-health",
        event: "list_pending_manual_decisions_incomplete",
        operation: "list_pending_manual_decisions",
        profile,
        requestId,
        pages: 0,
        itemsExamined: 0,
        itemsReturned: 0,
        elapsedMs: Date.now() - startedAt,
        complete: false,
        reason: Date.now() >= deadlineAtMs ? "deadline_budget_exhausted" : "readiness_check_failed",
        error: error instanceof Error ? error.name : "unknown_error",
      }));
      throw error;
    }
    if (Number(ready.Item?.version || 0) < PROFILE_LOOKUP_MIGRATION_VERSION) {
      console.warn(JSON.stringify({
        service: "todoist-calendar-sync-health",
        event: "list_pending_manual_decisions_incomplete",
        operation: "list_pending_manual_decisions",
        profile,
        requestId,
        pages: 0,
        itemsExamined: 0,
        itemsReturned: 0,
        elapsedMs: Date.now() - startedAt,
        complete: false,
        reason: "profile_lookup_index_not_ready",
      }));
      throw new Error("Pending manual-decision index is not ready; results are incomplete");
    }

    for (const owner of owners) {
      let cursor: Record<string, unknown> | undefined;
      let ownerComplete = false;
      let ownerPages = 0;
      do {
        if (Date.now() >= deadlineAtMs || ownerPages >= maxPagesPerProfile) break;
        ownerPages += 1;
        totalPages += 1;
        let result: any;
        const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now()));
        try {
          result = await documentClient.send(new QueryCommand(withProfileLookupDeadline({
            TableName: table,
            IndexName: PROFILE_LOOKUP_INDEX_NAME,
            KeyConditionExpression: "lookupPk = :lookupPk AND begins_with(lookupSk, :prefix)",
            FilterExpression: "#profile = :profile AND #status = :pending",
            ExpressionAttributeNames: { "#profile": "profile", "#status": "status" },
            ExpressionAttributeValues: {
              ":lookupPk": `PROFILE#${owner}`,
              ":profile": owner,
              ":prefix": MANUAL_PENDING_LOOKUP_PREFIX,
              ":pending": "pending",
            },
            ExclusiveStartKey: cursor,
            Limit: pageLimit,
            ReturnConsumedCapacity: "TOTAL",
          }, deadlineAtMs)), { abortSignal: deadlineSignal });
        } catch (error) {
          // The timeout signal may fire just before Date.now() reaches the absolute
          // deadline. Its aborted state is the authoritative indication that this
          // query exhausted the caller's budget.
          const deadlineExpired = Date.now() >= deadlineAtMs || deadlineSignal.aborted;
          console.error(JSON.stringify({
            service: "todoist-calendar-sync-health",
            event: "list_pending_manual_decisions_incomplete",
            operation: "list_pending_manual_decisions",
            profile: owner,
            requestId,
            pages: ownerPages,
            itemsExamined: examined,
            itemsReturned: results.length,
            elapsedMs: Date.now() - startedAt,
            complete: false,
            reason: deadlineExpired ? "deadline_budget_exhausted" : "query_failed",
            error: error instanceof Error ? error.name : "unknown_error",
          }));
          if (deadlineExpired) throw new Error(`Pending manual-decision lookup deadline exhausted for ${owner}`, { cause: error });
          throw error;
        }
        examined += Number(result.ScannedCount ?? result.Count ?? result.Items?.length ?? 0);
        results.push(...((result.Items || []) as ManualDecision[]));
        cursor = result.LastEvaluatedKey;
        if (!cursor) ownerComplete = true;
      } while (cursor);
      completeByProfile[owner] = ownerComplete;
      if (!ownerComplete) {
        console.warn(JSON.stringify({
          service: "todoist-calendar-sync-health",
          event: "list_pending_manual_decisions_incomplete",
          operation: "list_pending_manual_decisions",
          profile: owner,
          requestId,
          pages: ownerPages,
          itemsExamined: examined,
          itemsReturned: results.length,
          elapsedMs: Date.now() - startedAt,
          complete: false,
          reason: Date.now() >= deadlineAtMs ? "deadline_budget_exhausted" : "page_budget_exhausted",
        }));
        throw new Error(`Pending manual-decision lookup incomplete for ${owner}`);
      }
    }
    console.log(JSON.stringify({
      service: "todoist-calendar-sync-health",
      event: "list_pending_manual_decisions_complete",
      operation: "list_pending_manual_decisions",
      profile,
      requestId,
      pages: totalPages,
      itemsExamined: examined,
      itemsReturned: results.length,
      elapsedMs: Date.now() - startedAt,
      complete: Object.values(completeByProfile).every(Boolean),
      completeByProfile,
    }));
    return results;
  }
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
  permalink?: string;
}

function slackEnabled(): boolean {
  return String(process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED || "").toLowerCase() === "true";
}

async function slackToken(): Promise<string> {
  return secureParameter(process.env.SLACK_BOT_TOKEN_PARAMETER || "/lambdas/shared/slack-bot-token");
}

function defaultSlackChannel(): string {
  return process.env.TODOIST_CALENDAR_SYNC_SLACK_CHANNEL || "#aws-slack-alerts";
}

async function slackApi(method: "chat.postMessage" | "chat.update" | "chat.getPermalink", payload: Record<string, unknown>): Promise<SlackApiResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await slackToken()}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json() as SlackApiResponse;
  if (!response.ok || !result.ok) throw new Error(`Slack ${method} failed: ${result.error || response.status}`);
  return result;
}

function contextString(detail: Record<string, unknown>, key: string): string | undefined {
  return typeof detail[key] === "string" && detail[key] ? detail[key] as string : undefined;
}

function escapeSlackMrkdwnText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function operationalFailureContext(delivery: Delivery, error: unknown): Record<string, unknown> {
  const providerError = error as { status?: number; body?: string };
  const context: Record<string, unknown> = {
    kind: delivery.kind,
    status: Number(providerError.status) || undefined,
    failure: error instanceof Error ? error.message : String(error),
    deliveryId: delivery.id,
  };
  // Keep the durable repair reference on the incident. The operation itself is
  // loaded by the review API; never copy its plan or provider payload here.
  if (delivery.kind === "repair" && delivery.repair?.operationId) context.repairOperationId = delivery.repair.operationId;
  // Keep the provider identifiers from the failed delivery itself. Provider
  // errors often omit these, even though the queued webhook has them.
  if (delivery.orphan) {
    context.providerTaskId = delivery.orphan.taskId;
    context.providerEventId = delivery.orphan.eventId;
  }
  if (delivery.kind === "todoist") {
    try {
      const payload = JSON.parse(delivery.body) as { event_data?: { id?: unknown } };
      if (typeof payload.event_data?.id === "string" && payload.event_data.id) context.providerTaskId = payload.event_data.id;
    } catch {
      // The failure record remains useful even when a legacy webhook is malformed.
    }
  }
  if (error instanceof ReconciliationItemError) {
    context.providerTaskId = error.taskId;
    context.providerEventId = error.eventId;
    context.providerErrorTag = error.providerReason;
    context.reconcileStage = error.stage;
    context.providerSeriesId = error.seriesId;
  }
  if (delivery.reconcile) {
    context.reconcileReason = delivery.reconcile.reason;
    context.reconcileGeneration = delivery.reconcile.generation;
    const continuation = delivery.reconcile.continuation;
    if (continuation) {
      context.reconcileContinuation = `${continuation.phase} sequence ${continuation.sequence}`;
      if (continuation.afterTaskId) context.reconcileAfterTaskId = continuation.afterTaskId;
      if (continuation.afterEventId) context.reconcileAfterEventId = continuation.afterEventId;
    }
  }
  if (typeof providerError.body === "string") {
    try {
      const body = JSON.parse(providerError.body) as Record<string, unknown>;
      if (typeof body.error_tag === "string") context.providerErrorTag = body.error_tag;
      const extra = body.error_extra as Record<string, unknown> | undefined;
      if (extra && typeof extra.event_id === "string") context.providerEventId = extra.event_id;
    } catch {
      // Provider response bodies are diagnostic only; retain the safe message.
    }
  }
  const taskMatch = (error instanceof Error ? error.message : String(error)).match(/\/tasks\/([^\s/?]+)/);
  if (taskMatch) context.providerTaskId ||= taskMatch[1];
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}

function contextTitles(decision: ManualDecision): { taskTitle?: string; calendarTitle?: string } {
  const detail = decision.context;
  const legacyTitle = contextString(detail, "title");
  const legacyCalendarTitle = decision.type === "calendar_snapshot_unmapped_ambiguous"
    || decision.type === "calendar_snapshot_recurring_ambiguous";
  return {
    taskTitle: contextString(detail, "taskTitle") || (!legacyCalendarTitle ? legacyTitle : undefined),
    calendarTitle: contextString(detail, "calendarTitle") || (legacyCalendarTitle ? legacyTitle : undefined),
  };
}

function decisionDisplayTitle(decision: ManualDecision): string {
  const { taskTitle, calendarTitle } = contextTitles(decision);
  return escapeSlackMrkdwnText(taskTitle || calendarTitle || "unnamed item");
}

function candidateDue(candidate: Record<string, unknown>): string | undefined {
  if (!candidate.due || typeof candidate.due !== "object") return undefined;
  const due = candidate.due as Record<string, unknown>;
  return contextString(due, "datetime") || contextString(due, "date");
}

function changeSummary(decision: ManualDecision): string | undefined {
  switch (decision.type) {
    case "standalone_todoist_task_deleted":
      return "The Todoist task was deleted, but its mapped Calendar event still exists.";
    case "calendar_owned_recurrence_task_deleted":
      return "The Todoist mirror for this Calendar recurrence was deleted. Choose the intended Calendar scope.";
    case "todoist_owned_recurrence_task_deleted":
      return "The Todoist recurrence was deleted, but its Calendar projection still exists.";
    case "calendar_snapshot_unmapped_ambiguous":
      return "This Calendar event matches more than one Todoist task, so the sync cannot safely choose a mapping.";
    case "calendar_snapshot_recurring_ambiguous":
      return "This Calendar recurrence matches more than one Todoist task, so the sync cannot safely choose a mirror.";
    case "todoist_unmapped_conflict":
      return "The Todoist task is unmapped but a different or ambiguous Calendar projection exists. Automatic linking is unsafe.";
    case "todoist_cancelled_projection_blocked":
      return "The previous Calendar projection is cancelled. The sync will not recreate it without an intentional new action.";
    case "both_sides_changed":
      return "Both Calendar and Todoist changed since the last synchronized baseline. Choose which current version should win.";
    default:
      return undefined;
  }
}

function actionGuidance(decision: ManualDecision): string | undefined {
  switch (decision.type) {
    case "standalone_todoist_task_deleted":
      return "*Choose one:* Delete the Calendar event if the Todoist deletion was intentional, or restore the Todoist task if the Calendar event should remain. No provider action happens until you choose.";
    case "todoist_unmapped_conflict":
      return "*Choose one:* For a changed recurring Calendar master, *Use Todoist for future — keep Calendar history* cuts off only its old future dates and creates a new Todoist-owned recurrence; past Calendar occurrences stay intact. For standalone mismatches, use the original choices. Both require explicit confirmation and fresh ownership/duplicate checks. Existing cards: `/sync resume <decision ID>`.";
    case "todoist_cancelled_projection_blocked":
      return "*Choose one:* Consolidation keeps the recurring Todoist task, preserves past Calendar occurrences, starts its Todoist-owned recurrence on the next due date, then removes the matched one-off Todoist task and cancelled Calendar event. It requires confirmation and fresh ownership checks.";
    case "todoist_owned_recurrence_task_deleted":
      return "*Choose one:* Delete the Calendar series if the Todoist deletion was intentional, keep it and unlink it, or restore the Todoist task. No provider action happens until you choose.";
    case "calendar_owned_recurrence_task_deleted":
      return "*Choose one:* Skip this occurrence, delete this and future occurrences, delete the whole Calendar series, or restore the Todoist task. No provider action happens until you choose.";
    case "operational_dlq":
      return "*What should happen next?* Request a fresh reconciliation. The worker will re-read current provider state and apply only guarded repairs; it will not replay the failed delivery.";
    case "operational_provider_auth":
      return "*What should happen next?* Fix the provider credentials or permissions, then request a fresh reconciliation. No provider mutation is attempted by this alert.";
    default:
      return undefined;
  }
}

function operationalContextLines(decision: ManualDecision): string[] {
  if (!decision.type.startsWith("operational_")) return [];
  const detail = decision.context;
  const kind = contextString(detail, "kind");
  const status = typeof detail.status === "number" ? detail.status : undefined;
  const providerTaskId = contextString(detail, "providerTaskId");
  const providerEventId = contextString(detail, "providerEventId");
  const failure = contextString(detail, "failure");
  const reason = contextString(detail, "reconcileReason");
  const generation = contextString(detail, "reconcileGeneration");
  const continuation = contextString(detail, "reconcileContinuation");
  return [
    kind ? `*Delivery:* ${escapeSlackMrkdwnText(kind)}` : undefined,
    status ? `*Provider response:* HTTP ${status}` : undefined,
    providerTaskId ? `*Affected Todoist task:* \`${escapeSlackMrkdwnText(providerTaskId)}\`` : undefined,
    providerEventId ? `*Affected Calendar event:* \`${escapeSlackMrkdwnText(providerEventId)}\`` : undefined,
    failure ? `*Failure:* ${escapeSlackMrkdwnText(failure)}` : undefined,
    reason ? `*Reconciliation:* ${escapeSlackMrkdwnText(reason)}${generation ? ` (${escapeSlackMrkdwnText(generation)})` : ""}${continuation ? `, ${escapeSlackMrkdwnText(continuation)}` : ""}` : undefined,
  ].filter(Boolean) as string[];
}

function contextLines(decision: ManualDecision): string[] {
  const detail = decision.context;
  const { taskTitle, calendarTitle } = contextTitles(decision);
  const taskDue = contextString(detail, "todoistDue");
  const calendarStart = contextString(detail, "calendarStart") || contextString(detail, "start");
  const sameTitle = Boolean(taskTitle && calendarTitle && taskTitle.trim() === calendarTitle.trim());
  const displayTaskTitle = taskTitle ? escapeSlackMrkdwnText(taskTitle) : undefined;
  const displayCalendarTitle = calendarTitle ? escapeSlackMrkdwnText(calendarTitle) : undefined;
  const displayTaskDue = taskDue ? escapeSlackMrkdwnText(taskDue) : undefined;
  const displayCalendarStart = calendarStart ? escapeSlackMrkdwnText(calendarStart) : undefined;
  const todoistRecurring = typeof detail.todoistRecurring === "boolean"
    ? `*Todoist recurrence:* ${detail.todoistRecurring ? "recurring" : "not recurring"}`
    : undefined;
  const calendarStatus = contextString(detail, "calendarStatus");
  const displayCalendarStatus = calendarStatus ? `*Calendar status:* ${escapeSlackMrkdwnText(calendarStatus)}` : undefined;
  const lines = [
    `*Profile:* \`${decision.profile}\``,
    sameTitle && displayTaskTitle ? `*Item:* ${displayTaskTitle}` : undefined,
    !sameTitle && displayTaskTitle ? `*Todoist task:* ${displayTaskTitle}` : undefined,
    !sameTitle && displayCalendarTitle ? `*Calendar event:* ${displayCalendarTitle}` : undefined,
    displayTaskDue ? `*Todoist due:* ${displayTaskDue}` : undefined,
    displayCalendarStart ? `*Calendar start:* ${displayCalendarStart}` : undefined,
    todoistRecurring,
    displayCalendarStatus,
    typeof detail.futureSplitPreview === "string"
      ? `*Future-only plan:* ${escapeSlackMrkdwnText(detail.futureSplitPreview)}`
      : undefined,
    typeof detail.consolidationPreview === "string"
      ? `*Duplicate consolidation:* ${escapeSlackMrkdwnText(detail.consolidationPreview)}`
      : undefined,
    typeof detail.consolidationUnavailableReason === "string"
      ? `*Consolidation unavailable:* ${escapeSlackMrkdwnText(detail.consolidationUnavailableReason)}`
      : undefined,
    changeSummary(decision) ? `*What changed:* ${changeSummary(decision)}` : undefined,
    ...operationalContextLines(decision),
  ].filter(Boolean) as string[];
  return lines;
}

function technicalContextText(decision: ManualDecision): string {
  const values = [
    `type \`${decision.type}\``,
    decision.taskId ? `task ID \`${decision.taskId}\`` : undefined,
    decision.eventId ? `event ID \`${decision.eventId}\`` : undefined,
    decision.seriesId ? `series ID \`${decision.seriesId}\`` : undefined,
    `decision ID \`${decision.decisionId}\``,
    `expires ${decision.decisionDeadline}`,
  ].filter(Boolean);
  return `Technical details · ${values.join(" · ")}`;
}

function technicalContextBlock(decision: ManualDecision): unknown {
  return { type: "context", elements: [{ type: "mrkdwn", text: technicalContextText(decision) }] };
}

function actionLabel(decision: ManualDecision, resolution: string): string {
  const catalogAction = decision.permittedActions.find((action) => action.id === resolution);
  if (catalogAction) return catalogAction.label;
  if (resolution.startsWith("bind_task:")) {
    const taskId = resolution.slice("bind_task:".length);
    const candidates = Array.isArray(decision.context.candidates) ? decision.context.candidates as Array<Record<string, unknown>> : [];
    const candidate = candidates.find((item) => String(item.id || "") === taskId);
    const candidateName = candidate ? String(candidate.content || candidate.summary || "selected Todoist task") : "selected Todoist task";
    return `Bind ${escapeSlackMrkdwnText(candidateName)}`;
  }
  return resolution;
}

function actionValue(decision: ManualDecision, action: ManualActionDefinition, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    realm: "gcp-sync",
    profile: decision.profile,
    decisionId: decision.decisionId,
    action: action.id,
    confirmRequired: Boolean(action.destructive),
    ...extra,
  });
}

export function decisionResolutionBlocks(decision: ManualDecision, text: string, extra: unknown[] = []): unknown[] {
  const policy = MANUAL_DECISION_CATALOG[decision.type];
  return [
    { type: "header", text: { type: "plain_text", text: policy.title.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: contextLines(decision).join("\n") || `*Profile:* \`${decision.profile}\`` } },
    { type: "section", text: { type: "mrkdwn", text } },
    ...extra,
    technicalContextBlock(decision),
  ];
}

export function decisionBlocks(decision: ManualDecision): unknown[] {
  const policy = MANUAL_DECISION_CATALOG[decision.type];
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: policy.title.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: contextLines(decision).join("\n") || `*Profile:* \`${decision.profile}\`` } },
  ];
  const savedDefault = decision.defaultAction
    ? decision.permittedActions.find((action) => action.id === decision.defaultAction)
    : undefined;
  if (savedDefault) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Saved default (${decision.policyScope || "catalog"}):* ${savedDefault.label}\nThis is a remembered default, not unattended execution.`,
      },
    });
    blocks.push({
      type: "actions",
      block_id: `gcp_sync_default_${decision.decisionId.slice(-24)}`,
      elements: [{
        type: "button",
        action_id: "gcp_sync_decision_default",
        text: { type: "plain_text", text: "Apply saved default" },
        value: actionValue(decision, savedDefault, { fromSavedDefault: true }),
        ...(savedDefault.destructive ? { style: "danger" } : { style: "primary" }),
      }],
    });
  }
  const readOnlyCandidates = Array.isArray(decision.context.readOnlyCandidates)
    ? decision.context.readOnlyCandidates as Array<Record<string, unknown>>
    : [];
  if (readOnlyCandidates.length) {
    const candidateText = readOnlyCandidates.slice(0, 8).map((candidate, index) => {
      const kind = candidate.kind === "todoist_task" ? "Todoist task" : "Calendar event";
      const id = escapeSlackMrkdwnText(String(candidate.id || `candidate-${index + 1}`).slice(0, 120));
      const title = typeof candidate.title === "string" ? escapeSlackMrkdwnText(candidate.title.slice(0, 120)) : undefined;
      const date = typeof candidate.date === "string" ? escapeSlackMrkdwnText(candidate.date.slice(0, 80)) : undefined;
      const status = typeof candidate.status === "string" ? escapeSlackMrkdwnText(candidate.status) : undefined;
      const recurring = typeof candidate.recurring === "boolean" ? `recurring: ${candidate.recurring ? "yes" : "no"}` : undefined;
      const fields = [date, status, recurring].filter(Boolean);
      const unavailable = candidate.available === false ? "details unavailable" : undefined;
      return `${index + 1}. *${kind}:* \`${id}\`${title ? ` — ${title}` : ""}${fields.length || unavailable ? ` (${[...fields, unavailable].filter(Boolean).join("; ")})` : ""}`;
    }).join("\n");
    const omitted = typeof decision.context.omittedCandidateCount === "number" && decision.context.omittedCandidateCount > 0
      ? `\n…and ${decision.context.omittedCandidateCount} more candidate(s) not fetched.`
      : "";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Conflicting provider objects (read-only)*\n${candidateText}${omitted}` } });
  }
  const candidates = Array.isArray(decision.context.candidates) ? decision.context.candidates as Array<Record<string, unknown>> : [];
  if (candidates.length) {
    const candidateText = candidates.slice(0, 8).map((candidate, index) => {
      const name = escapeSlackMrkdwnText(String(candidate.content || candidate.summary || `Candidate ${index + 1}`));
      const due = candidateDue(candidate);
      const displayDue = due ? escapeSlackMrkdwnText(due) : undefined;
      return `${index + 1}. ${name}${displayDue ? ` — ${displayDue}` : ""}`;
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Candidate matches*\n${candidateText}` } });
  }
  const dynamicActions: ManualActionDefinition[] = candidates.slice(0, 8).map((candidate, index) => ({
    id: `bind_task:${String(candidate.id)}`,
    label: `Bind ${String(candidate.content || candidate.summary || `candidate ${index + 1}`).slice(0, 45)}`,
  }));
  const effectiveActions = decision.type === "todoist_unmapped_conflict"
    ? MANUAL_DECISION_CATALOG.todoist_unmapped_conflict.actions
    : decision.type === "todoist_cancelled_projection_blocked"
      ? MANUAL_DECISION_CATALOG.todoist_cancelled_projection_blocked.actions.filter((action) =>
        action.id !== "consolidate_duplicate" || (
          typeof decision.context.consolidationDuplicateTaskId === "string"
          && typeof decision.context.consolidationMasterEventId === "string"
          && typeof decision.context.consolidationPreview === "string"))
    : decision.permittedActions;
  const allActions = [...effectiveActions, ...dynamicActions];
  if (allActions.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: actionGuidance(decision) || "*What should happen next?* Choose the proposed action. Destructive choices require confirmation." } });
  }
  for (let index = 0; index < allActions.length; index += 5) {
    blocks.push({
      type: "actions",
      block_id: `gcp_sync_${decision.decisionId.slice(-24)}_${index / 5}`,
      elements: allActions.slice(index, index + 5).map((action, offset) => ({
        type: "button",
        action_id: `gcp_sync_decision_${index + offset}`,
        text: { type: "plain_text", text: action.label.slice(0, 75) },
        value: actionValue(decision, action),
        ...(action.destructive ? { style: "danger" } : {}),
      })),
    });
  }
  blocks.push({ type:"actions", elements:[{
    type:"button", action_id:"gcp_sync_decision_open_review",
    text:{type:"plain_text",text:"Open review"},
    url:"https://calendar-sync.alf-broadcast.co.uk/review/?case=" + encodeURIComponent(decision.decisionId),
  }] });
  blocks.push(technicalContextBlock(decision));
  return blocks;
}

export class SlackManualNotifier {
  constructor(private readonly store = new ManualDecisionStore()) {}

  async postDecision(decision: ManualDecision): Promise<boolean> {
    if (!slackEnabled()) return false;
    try {
      const result = await slackApi("chat.postMessage", {
        channel: decision.slackChannelId || defaultSlackChannel(),
        text: MANUAL_DECISION_CATALOG[decision.type].title,
        blocks: decisionBlocks(decision),
      });
      if (!result.channel || !result.ts) return false;
      await this.store.setSlackLocation(decision.decisionId, result.channel, result.ts);
      return true;
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-manual",
        event: "slack_decision_post_failed",
        decisionId: decision.decisionId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    }
  }

  async postText(text: string, channel?: string, threadTs?: string): Promise<string | undefined> {
    if (!slackEnabled()) return undefined;
    try {
      const result = await slackApi("chat.postMessage", { channel: channel || defaultSlackChannel(), text, ...(threadTs ? { thread_ts: threadTs } : {}) });
      return result.ts;
    } catch (error) {
      console.error(JSON.stringify({ service: "todoist-calendar-sync-manual", event: "slack_status_post_failed", error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }

  async reconciliationOutcome(channel: string | undefined, threadTs: string | undefined, text: string): Promise<string | undefined> {
    return this.postText(text, channel, threadTs);
  }

  async updateReconciliationIncident(channel: string | undefined, messageTs: string | undefined, text: string, close = false, decision?: ManualDecision): Promise<void> {
    if (!slackEnabled() || !channel || !messageTs) return;
    const blocks = !close && decision
      ? [{ type: "section", text: { type: "mrkdwn", text } }, ...decisionBlocks(decision)]
      : [];
    await slackApi("chat.update", { channel, ts: messageTs, text, blocks });
  }

  async reconciliationLocation(channel: string, threadTs: string): Promise<string> {
    const result = await slackApi("chat.getPermalink", { channel, message_ts: threadTs });
    if (!result.permalink) throw new Error("Slack did not return the active reconciliation permalink");
    return `<${result.permalink}|active reconciliation thread>`;
  }

  async deliverReconciliationOutcome(channel: string | undefined, threadTs: string | undefined, replyTs: string | undefined, text: string): Promise<string | undefined> {
    if (replyTs && channel) {
      await slackApi("chat.update", { channel, ts: replyTs, text });
      return replyTs;
    }
    return this.postText(text, channel, threadTs);
  }

  async updateResolution(decision: ManualDecision, text: string, blocks?: unknown[]): Promise<void> {
    if (!slackEnabled()) return;
    const fresh = await this.store.get(decision.decisionId) || decision;
    if (!fresh.slackChannelId || !fresh.slackMessageTs) {
      try {
        await this.postText(`${MANUAL_DECISION_CATALOG[fresh.type].title}\n${contextLines(fresh).join("\n")}\n${text}\n${technicalContextText(fresh)}`);
      } catch (error) {
        console.error(JSON.stringify({ service: "todoist-calendar-sync-manual", event: "slack_resolution_post_failed", decisionId: decision.decisionId, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    try {
      await slackApi("chat.update", {
        channel: fresh.slackChannelId,
        ts: fresh.slackMessageTs,
        text,
        blocks: blocks || decisionResolutionBlocks(fresh, text),
      });
    } catch (error) {
      console.error(JSON.stringify({ service: "todoist-calendar-sync-manual", event: "slack_resolution_update_failed", decisionId: decision.decisionId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export class ManualInterventionService {
  constructor(
    private readonly store = new ManualDecisionStore(),
    private readonly notifier = new SlackManualNotifier(store),
    private readonly clients: ProviderClientFactory = defaultProviderClientFactory,
    private readonly policies = new InterventionPolicyStore(),
  ) {}

  private executionClientFactory?: ProviderClientFactory;

  get enabled(): boolean {
    return slackEnabled();
  }

  async reconciliationOutcome(channel: string | undefined, threadTs: string | undefined, text: string): Promise<string | undefined> {
    return this.notifier.reconciliationOutcome(channel, threadTs, text);
  }

  async updateReconciliationIncident(channel: string | undefined, messageTs: string | undefined, text: string, close = false, decisionId?: string): Promise<void> {
    const decision = decisionId ? await this.store.get(decisionId) : undefined;
    return this.notifier.updateReconciliationIncident(channel, messageTs, text, close, decision);
  }

  async finishReconciliationDecision(decisionId: string, text: string): Promise<void> {
    let resolution = text;
    try {
      await this.store.finish(decisionId, "resolved", text, "reconciliation-worker");
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
      const existing = await this.store.get(decisionId);
      if (existing?.status !== "resolved") throw error;
      resolution = existing.resolution || text;
    }
    const incident = await this.store.get(decisionId);
    if (incident?.status === "resolved") await this.notifier.updateResolution(incident, resolution);
  }

  async retireStaleReconciliationIncidents(
    profile: Profile,
    generation: string,
    pending: boolean,
    lookupOptions: { deadlineAtMs?: number; requestId?: string } = {},
  ): Promise<void> {
    for (const incident of await this.store.listPending(profile, lookupOptions)) {
      if (incident.type !== "operational_reconciliation_stuck") continue;
      const alertedGeneration = typeof incident.context?.reconciliationGeneration === "string"
        ? incident.context.reconciliationGeneration : undefined;
      if (!alertedGeneration || (alertedGeneration === generation && pending)) continue;
      const resolution = `This reconciliation alert is no longer actionable: generation ${alertedGeneration} was superseded or reached a terminal state. Current generation: ${generation}.`;
      try {
        await this.store.finish(incident.decisionId, "resolved", resolution, "reconciliation-health");
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
        const existing = await this.store.get(incident.decisionId);
        if (existing?.status !== "resolved") continue;
      }
      const finished = await this.store.get(incident.decisionId);
      if (finished?.status === "resolved") await this.notifier.updateResolution(finished, finished.resolution || resolution);
    }
  }

  async deliverReconciliationOutcome(channel: string | undefined, threadTs: string | undefined, replyTs: string | undefined, text: string): Promise<string | undefined> {
    return this.notifier.deliverReconciliationOutcome(channel, threadTs, replyTs, text);
  }

  async alertReconciliationNeeded(profile: Profile, identity: string, channel: string | undefined, detail: string,
    diagnostic: Record<string, unknown> = {}): Promise<boolean> {
    const decisionId = `${profile}-operational_reconciliation_stuck-${fingerprint({ identity })}`;
    const existing = await this.store.get(decisionId);
    if (existing) {
      if (existing.status !== "pending" || existing.slackMessageTs) return true;
      return this.notifier.postDecision({ ...existing, slackChannelId: channel || existing.slackChannelId });
    }
    const now = isoNow();
    const decision: ManualDecision = {
      decisionId, profile, type: "operational_reconciliation_stuck", severity: "warning", status: "pending",
      createdAt: now, decisionDeadline: plusDays(DEFAULT_DECISION_DEADLINE_DAYS), context: { identity, detail, ...diagnostic },
      fingerprint: fingerprint({ identity }), permittedActions: MANUAL_DECISION_CATALOG.operational_reconciliation_stuck.actions,
      ...(channel ? { slackChannelId: channel } : {}),
    };
    await this.store.putPending(decision);
    return this.notifier.postDecision(decision);
  }

  private async providerClients(profile: Profile) {
    return (this.executionClientFactory || this.clients)(profile);
  }

  private createManualExecutionClientFactory(
    state: StateRepository,
    budget: ReconciliationMutationBudget,
    protectedItems: { taskIds: string[]; eventIds: string[]; decision: ManualDecision; consolidation?: { duplicateTaskId:string; oldMasterId:string; newMasterId:string; previousOccurrence?:string } },
  ): ProviderClientFactory {
    const recheckProtectedItems = async (profile: Profile) => {
      const current = await this.store.get(protectedItems.decision.decisionId);
      if (!current || current.status !== "pending" || current.fingerprint !== protectedItems.decision.fingerprint
        || current.taskId !== protectedItems.decision.taskId || current.eventId !== protectedItems.decision.eventId) {
        throw new ManualSyncBlockedError();
      }
      const sourceTaskId = protectedItems.decision.taskId;
      const sourceEventId = protectedItems.decision.eventId;
      if (sourceTaskId && sourceEventId) {
        const lookupByEvent = typeof state.getMappingByEvent === "function"
          ? state.getMappingByEvent.bind(state) : async () => undefined;
        const [byTask, byEvent] = await Promise.all([
          state.getMappingByTask(profile, sourceTaskId), lookupByEvent(profile, sourceEventId),
        ]);
        let approvedCutover = false;
        const cutover = protectedItems.consolidation;
        const currentPlan = current.context.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit> | undefined;
        if (cutover && profile === protectedItems.decision.profile && current.type === "todoist_cancelled_projection_blocked"
          && current.context.consolidationDuplicateTaskId === cutover.duplicateTaskId
          && currentPlan?.oldMasterId === cutover.oldMasterId && currentPlan.newMasterId === cutover.newMasterId
          && currentPlan.previousOccurrence === cutover.previousOccurrence) {
          const [split, alias, futureByEvent, link] = await Promise.all([
            state.getFutureSeriesSplitAnyProfile(sourceTaskId),
            state.getConsolidatedTask(profile, cutover.duplicateTaskId),
            lookupByEvent(profile, cutover.newMasterId),
            state.getRecurrenceLink(profile, sourceTaskId),
          ]);
          approvedCutover = split?.profile === profile && split.taskId === sourceTaskId
            && split.oldMasterId === cutover.oldMasterId && split.newMasterId === cutover.newMasterId
            && split.previousOccurrence === cutover.previousOccurrence && split.status === "pending"
            && alias?.retainedTaskId === sourceTaskId && alias.decisionId === current.decisionId
            && alias.previousMapping?.taskId === cutover.duplicateTaskId
            && alias.previousMapping.masterEventId === cutover.oldMasterId
            && byTask?.taskId === sourceTaskId && byTask.eventId === cutover.newMasterId
            && byTask.masterEventId === cutover.newMasterId && byTask.recurrenceOwner === "todoist"
            && futureByEvent?.taskId === sourceTaskId && futureByEvent.eventId === cutover.newMasterId
            && futureByEvent.recurrenceOwner === "todoist"
            && link?.owner === "todoist" && link.taskId === sourceTaskId && link.masterEventId === cutover.newMasterId;
        }
        if (((byTask && byTask.eventId !== sourceEventId) || (byEvent && byEvent.taskId !== sourceTaskId)) && !approvedCutover) {
          throw new ManualSyncBlockedError();
        }
      }
      for (const taskId of protectedItems.taskIds) {
        if (await state.syncBlocked(profile, { taskId })) throw new ManualSyncBlockedError();
        for (const eventId of protectedItems.eventIds) if (await state.syncBlocked(profile, { taskId, eventId })) throw new ManualSyncBlockedError();
      }
      for (const eventId of protectedItems.eventIds) if (await state.syncBlocked(profile, { eventId })) throw new ManualSyncBlockedError();
    };
    const budgeted = createBudgetedClientFactory(budget, this.clients);
    const circuitWrapped = <T extends object>(target: T, profile: Profile, mutatingMethods: Set<string>): T => new Proxy(target, {
      get(current, property, receiver) {
        const value = Reflect.get(current, property, receiver);
        if (typeof value !== "function") return value;
        const operation = String(property);
        if (!mutatingMethods.has(operation)) return value.bind(current);
        return async (...args: unknown[]) => {
          const ids = mutatingMethods === MANUAL_CALENDAR_MUTATIONS
            ? { eventId: typeof args[1] === "string" ? args[1] : typeof args[0] === "string" ? args[0] : (args[0] as CalendarEvent)?.id }
            : { taskId: operation === "updateRecurringOccurrence" ? (args[0] as TodoistTask)?.id : operation === "deleteTask" ? String(args[0]) : operation === "upsertTask" ? args[1] as string|undefined : undefined };
          await recheckProtectedItems(profile);
          if (await state.syncBlocked(profile, ids)) throw new ManualSyncBlockedError();
          if (!await state.mutationAllowed(profile)) throw new ManualCircuitOpenError(profile, operation);
          const result = await Reflect.apply(value, current, args);
          // Count every successful provider write, including each item in a bounded bulk action.
          await state.recordMutation(profile);
          return result;
        };
      },
    });
    return async (profile) => {
      const pair = await budgeted(profile);
      return {
        calendar: circuitWrapped(pair.calendar, profile, MANUAL_CALENDAR_MUTATIONS),
        todoist: circuitWrapped(pair.todoist, profile, MANUAL_TODOIST_MUTATIONS),
      };
    };
  }

  private async createDecision(
    profile: Profile,
    type: ManualDecisionType,
    identity: Record<string, unknown>,
    fields: Partial<ManualDecision>,
    context: Record<string, unknown>,
    contextEnricher?: () => Promise<Record<string, unknown>>,
  ): Promise<{ decision?: ManualDecision; mode: InterventionResponseMode }> {
    const catalog = MANUAL_DECISION_CATALOG[type];
    const seriesId = typeof fields.seriesId === "string" ? fields.seriesId : undefined;
    const resolvedPolicy = await this.policies.resolve(profile, type, seriesId, catalog.defaultMode || "prompt");
    const effective = {
      ...resolvedPolicy,
      defaultAction: resolvedPolicy.defaultAction || (resolvedPolicy.source === "catalog" ? catalog.defaultAction : undefined),
    };
    if (effective.mode === "off" || effective.mode === "observe") return { mode: effective.mode };

    let mode = effective.mode;
    let defaultAction = effective.defaultAction;
    const savedAction = defaultAction ? catalog.actions.find((action) => action.id === defaultAction) : undefined;
    if (defaultAction && !savedAction) {
      console.warn(JSON.stringify({ service: "todoist-calendar-sync-manual", event: "intervention_policy_default_invalid", profile, type, defaultAction }));
      defaultAction = undefined;
      mode = "prompt";
    }
    if (mode === "auto" && (!savedAction?.autoAllowed || !defaultAction)) {
      console.warn(JSON.stringify({ service: "todoist-calendar-sync-manual", event: "intervention_policy_auto_not_allowed", profile, type, defaultAction }));
      mode = "prompt";
    }

    const key = decisionKey(profile, type, identity);
    let decisionContext = context;
    if (mode === "prompt" && contextEnricher) {
      // Avoid provider reads for disabled/observe/auto policies and repeated deterministic decisions.
      const existing = await this.store.get(key.decisionId);
      if (existing) {
        if (typeof existing.context?.conflictKey === "string") await new ReviewStore().observeDecision(existing);
        return { decision: existing, mode };
      }
      try {
        decisionContext = { ...context, ...await contextEnricher() };
      } catch (error) {
        decisionContext = { ...context, enrichmentError: error instanceof Error ? error.message : String(error) };
      }
    }

    const result = await this.store.putPending({
      decisionId: key.decisionId,
      profile,
      type,
      severity: catalog.severity,
      fingerprint: key.fingerprint,
      permittedActions: catalog.actions,
      policyMode: mode,
      policyScope: effective.source,
      defaultAction,
      context: decisionContext,
      ...fields,
    });
    if (mode === "prompt" && (result.created
      || (effective.mode === "auto" && result.decision.status === "pending" && !result.decision.slackMessageTs))) {
      await this.notifier.postDecision(result.decision);
    }
    if (mode === "auto" && defaultAction && result.decision.status === "pending") {
      await enqueueDelivery({
        id: `manual:${profile}:${result.decision.decisionId}:${defaultAction}:auto:${Date.now()}`,
        kind: "manual",
        profile,
        mode: "aws",
        receivedAt: isoNow(),
        headers: { source: "intervention-policy" },
        body: "",
        manual: {
          decisionId: result.decision.decisionId,
          action: defaultAction,
          slackUserId: "AUTO_POLICY",
        },
      });
    }
    return { decision: result.decision, mode };
  }

  async interceptTodoistDeletion(delivery: Delivery, state: StateRepository): Promise<boolean> {
    if (!this.enabled || delivery.kind !== "todoist") return false;
    let payload: TodoistWebhookPayload;
    try { payload = JSON.parse(delivery.body) as TodoistWebhookPayload; } catch { return false; }
    const task = payload.event_data;
    if (task?.id) {
      const consolidated = await state.getConsolidatedTask?.(delivery.profile, task.id);
      if (consolidated) {
        await state.audit(delivery.profile, "todoist_consolidated_duplicate_webhook_ignored", {
          discardedTaskId: task.id,
          retainedTaskId: consolidated.retainedTaskId,
          decisionId: consolidated.decisionId,
        });
        return true;
      }
    }
    const explicitDelete = Boolean(task?.id && (/deleted/i.test(payload.event_name || "") || task.is_deleted));
    if (!task?.id || !explicitDelete) return false;
    const mapping = await state.getMappingByTask(delivery.profile, task.id);
    if (!mapping) return false;

    const type: ManualDecisionType = mapping.recurrenceOwner === "calendar" && mapping.masterEventId
      ? "calendar_owned_recurrence_task_deleted"
      : mapping.recurrenceOwner === "todoist"
        ? "todoist_owned_recurrence_task_deleted"
        : "standalone_todoist_task_deleted";
    const identity = {
      taskId: task.id,
      eventId: mapping.eventId,
      masterEventId: mapping.masterEventId,
      activeInstanceId: mapping.activeInstanceId,
      mappingUpdatedAt: mapping.updatedAt,
    };
    const effective = await this.policies.resolve(delivery.profile, type, mapping.seriesId, MANUAL_DECISION_CATALOG[type].defaultMode || "prompt");
    if (effective.mode === "prompt" || effective.mode === "auto") {
      const existing = await this.store.get(decisionKey(delivery.profile, type, identity).decisionId);
      if (existing) return true;
      const pair = await this.providerClients(delivery.profile);
      try {
        await pair.todoist.getTask(task.id);
        await state.audit(delivery.profile, "manual_decision_suppressed_current_task_exists", {
          type,
          taskId: task.id,
          eventId: mapping.eventId,
          sourceDeliveryId: delivery.id,
        });
        return true;
      } catch (error) {
        if (!providerNotFound(error)) throw error;
      }
    }
    const context: Record<string, unknown> = {
      taskTitle: task.content,
      todoistDue: todoistDue(task),
      calendarStart: mapping.activeEffectiveStart || mapping.originalStart,
      eventName: payload.event_name,
    };
    const routed = await this.createDecision(
      delivery.profile,
      type,
      identity,
      {
        sourceDeliveryId: delivery.id,
        taskId: task.id,
        eventId: mapping.eventId,
        seriesId: mapping.seriesId,
        masterEventId: mapping.masterEventId,
        activeInstanceId: mapping.activeInstanceId,
        mappingSnapshot: mapping,
      },
      context,
      async () => {
        const pair = await this.providerClients(delivery.profile);
        const preferredEventId = mapping.activeInstanceId || mapping.eventId;
        let event: CalendarEvent;
        let usingActiveOccurrence = preferredEventId !== mapping.eventId;
        try {
          event = await pair.calendar.getEvent(preferredEventId);
        } catch (error) {
          if (!usingActiveOccurrence || !providerNotFound(error)) throw error;
          event = await pair.calendar.getEvent(mapping.eventId);
          usingActiveOccurrence = false;
        }
        return {
          calendarTitle: event.summary,
          calendarStart: usingActiveOccurrence
            ? eventDisplayStart(event) || context.calendarStart
            : context.calendarStart || eventDisplayStart(event),
        };
      },
    );
    if (routed.mode === "off") {
      await state.audit(delivery.profile, "manual_detector_disabled", { type, taskId: task.id, eventId: mapping.eventId, sourceDeliveryId: delivery.id });
      return false;
    }
    if (routed.mode === "observe") {
      await state.audit(delivery.profile, "manual_detector_observed_no_mutation", { type, taskId: task.id, eventId: mapping.eventId, sourceDeliveryId: delivery.id });
      return true;
    }
    await state.audit(delivery.profile, "manual_decision_requested", {
      decisionId: routed.decision?.decisionId,
      type,
      handlingMode: routed.mode,
      taskId: task.id,
      eventId: mapping.eventId,
      sourceDeliveryId: delivery.id,
    });
    return true;
  }

  private async buildConsolidationPreview(
    profile: Profile, taskId: string, cancelledEventId: string,
    priorPlan?: ReturnType<typeof planFutureSeriesSplit>,
  ): Promise<Record<string, unknown>> {
    const pair = await this.providerClients(profile);
    const state = new StateRepository();
    const [task, cancelled, tasks] = await Promise.all([
      pair.todoist.getTask(taskId),
      pair.calendar.getEvent(cancelledEventId),
      pair.todoist.listTasks(),
    ]);
    const day = todoistDue(task);
    if (!task.due?.is_recurring || !day || cancelled.status !== "cancelled"
      || cancelled.extendedProperties?.shared?.taskId !== task.id
      || normalizedText(cancelled.summary).toLowerCase() !== normalizedText(task.content).toLowerCase()
      || eventDisplayStart(cancelled)?.slice(0, 10) !== day.slice(0, 10)) {
      throw new Error("The cancelled projection no longer matches the recurring Todoist task");
    }
    const matchingTasks = tasks.filter((candidate) => candidate.id !== task.id
      && !candidate.is_deleted && !candidate.is_completed
      && normalizedText(candidate.content).toLowerCase() === normalizedText(task.content).toLowerCase()
      && todoistDue(candidate)?.slice(0, 10) === day.slice(0, 10));
    if (matchingTasks.length !== 1 || matchingTasks[0].due?.is_recurring) {
      throw new Error("There is not exactly one matching active one-off Todoist duplicate");
    }
    const duplicate = matchingTasks[0];
    const mapping = await state.getMappingByTask(profile, duplicate.id);
    if (!mapping?.masterEventId || mapping.recurrenceOwner !== "calendar"
      || !mapping.activeInstanceId || mapping.eventId !== mapping.activeInstanceId) {
      throw new Error("The one-off task is not the active mirror of a Calendar-owned recurrence");
    }
    const [link, master, duplicateHistory, taskOwner] = await Promise.all([
      state.getRecurrenceLink(profile, mapping.seriesId || ""),
      pair.calendar.getEvent(mapping.masterEventId),
      state.listCompletedCalendarProjectionsByTaskAnyProfile(duplicate.id),
      state.getMappingByTaskAnyProfile(task.id),
    ]);
    const archived = master.extendedProperties?.shared?.syncHistoryOnly === "true";
    const active = archived ? undefined : await pair.calendar.getEvent(mapping.activeInstanceId);
    if (taskOwner || duplicateHistory.length || !link || link.owner !== "calendar"
      || link.taskId !== duplicate.id || link.masterEventId !== master.id
      || link.seriesId !== mapping.seriesId || link.activeInstanceId !== mapping.activeInstanceId
      || (!archived && (!active || active.status !== "confirmed" || active.start?.date !== day))
      || master.status !== "confirmed" || !master.recurrence?.length
      || master.recurringEventId || master.id !== mapping.masterEventId) {
      throw new Error("The current recurrence owner or occurrence changed; consolidation is unsafe");
    }
    const calendarTimeZone = await pair.calendar.getTimeZone();
    const plan = planFutureSeriesSplit(
      profile, task, master,
      archived && priorPlan?.approvedAt ? new Date(priorPlan.approvedAt) : new Date(),
      calendarTimeZone, duplicate.id,
    );
    const tombstone = await state.getCalendarProjectionTombstone(profile, task.id);
    return {
      consolidationDuplicateTaskId: duplicate.id,
      consolidationMasterEventId: master.id,
      consolidationCancelledEventId: cancelled.id,
      consolidationTaskUpdatedAt: task.updated_at,
      consolidationDuplicateUpdatedAt: duplicate.updated_at,
      consolidationMappingUpdatedAt: mapping.updatedAt,
      consolidationLinkUpdatedAt: link.updatedAt,
      consolidationCalendarEtag: master.etag,
      consolidationMasterFingerprint: consolidationMasterFingerprint(master,plan,task.id),
      consolidationTombstoneUpdatedAt: tombstone?.sourceUpdatedAt,
      consolidationFuturePlan: plan,
      consolidationPreview: `Keep recurring task ${task.id}; remove one-off task ${duplicate.id} and cancelled event ${cancelled.id}. ${futureSplitDescription(plan, master.start?.date)}; future starts on ${plan.newStart} (${calendarTimeZone}).`,
    };
  }

  async observeAudit(
    delivery: Delivery,
    profile: Profile,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<{ caseId?: string; caseStatus: string }> {
    if (!this.enabled) return { caseStatus: "detector_disabled" };
    if (delivery.kind === "manual") return { caseStatus: "not_applicable" };
    let type: ManualDecisionType | undefined;
    if (action === "calendar_snapshot_unmapped_ambiguous") type = "calendar_snapshot_unmapped_ambiguous";
    else if (action === "calendar_snapshot_recurring_ambiguous") type = "calendar_snapshot_recurring_ambiguous";
    else if (action === "todoist_snapshot_reconcile_conflict_both_sides_changed") type = "both_sides_changed";
    else if (["todoist_snapshot_reconcile_unmapped_conflict", "todoist_snapshot_reconcile_unmapped_ambiguous", "calendar_task_link_ambiguous_conflict", "calendar_snapshot_recurring_identity_conflict"].includes(action)) type = "todoist_unmapped_conflict";
    else if (action === "todoist_snapshot_reconcile_cancelled_projection_blocked") type = "todoist_cancelled_projection_blocked";
    else if (action === "reconciliation_mutation_budget_exhausted" || action === "calendar_snapshot_reconcile_mutation_budget_exhausted") type = "operational_mutation_budget";
    else if (action.includes("circuit_open") || action.includes("circuit_deferred")) type = "operational_circuit_open";
    if (!type) return { caseStatus: "not_actionable" };

    const eventId = typeof detail.eventId === "string" ? detail.eventId : undefined;
    const taskId = typeof detail.taskId === "string" ? detail.taskId : undefined;
    const seriesId = typeof detail.seriesId === "string" ? detail.seriesId : undefined;
    const context: Record<string, unknown> = { ...detail };

    if ((type === "calendar_snapshot_unmapped_ambiguous" || type === "calendar_snapshot_recurring_ambiguous") && eventId) {
      try {
        const pair = await this.providerClients(profile);
        const event = await pair.calendar.getEvent(eventId);
        const candidates = (await pair.todoist.listTasks()).filter((candidate) => hasCanonicalState(event, candidate));
        context.title = event.summary;
        context.start = eventStart(event);
        context.calendarTitle = event.summary;
        context.calendarStart = eventDisplayStart(event);
        context.candidates = candidates.map((candidate) => ({ id: candidate.id, content: candidate.content, due: candidate.due }));
      } catch (error) {
        context.enrichmentError = error instanceof Error ? error.message : String(error);
      }
    }

    const recurringConflict = type === "todoist_unmapped_conflict" || type === "todoist_cancelled_projection_blocked";
    const conflictIdentity = retainedConflictIdentity(action, detail);
    const conflictKey = conflictIdentity ? reviewHash(conflictIdentity) : undefined;
    const candidateEventIds = Array.isArray(detail.candidateEventIds)
      ? [...new Set(detail.candidateEventIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
    const candidateTaskIds = Array.isArray(detail.candidateTaskIds)
      ? [...new Set(detail.candidateTaskIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
    const canEnrichConflict = recurringConflict
      && Boolean(taskId || eventId || candidateEventIds.length || candidateTaskIds.length);
    const observed = await this.createDecision(
      profile,
      type,
      recurringConflict
        ? { taskId, eventId, seriesId, category: type, candidateEventIds, candidateTaskIds, conflictKey }
        : { action, eventId, taskId, seriesId, detail },
      {
        sourceDeliveryId: delivery.id,
        sourceAuditAction: action,
        eventId,
        taskId,
        seriesId,
        masterEventId: typeof detail.masterEventId === "string" ? detail.masterEventId : undefined,
        activeInstanceId: typeof detail.activeInstanceId === "string" ? detail.activeInstanceId : undefined,
      },
      { ...context, ...(conflictKey ? { conflictKey } : {}) },
      canEnrichConflict
        ? async () => {
            const pair = await this.providerClients(profile);
            const extra: Record<string, unknown> = {};
            if (taskId) {
              try {
                const task = await pair.todoist.getTask(taskId);
                extra.taskTitle = task.content;
                extra.todoistDue = todoistDue(task);
                extra.todoistRecurring = Boolean(task.due?.is_recurring);
                extra.todoistDescription = task.description || "";
                extra.todoistUpdatedAt = task.updated_at;
                extra.todoistRecurrenceRule = todoistRecurrenceToRrule(task);
                extra.todoistRecurrenceText = task.due?.string;
              } catch (error) {
                extra.taskReadError = error instanceof Error ? error.message : String(error);
              }
            }
            if (eventId) {
              try {
                const event = await pair.calendar.getEvent(eventId);
                extra.calendarTitle = event.summary;
                extra.calendarStart = eventDisplayStart(event);
                extra.calendarStatus = event.status;
                extra.calendarDescription = event.description || "";
                extra.calendarRecurrenceRule = event.recurrence?.[0];
                extra.calendarEtag = event.etag;
              } catch (error) {
                extra.calendarReadError = error instanceof Error ? error.message : String(error);
              }
            }
            const maxCandidateDetails = 8;
            const targets = [
              ...candidateEventIds.map((id) => ({ kind: "calendar_event" as const, id })),
              ...candidateTaskIds.map((id) => ({ kind: "todoist_task" as const, id })),
            ].filter((candidate) => candidate.id !== eventId && candidate.id !== taskId);
            const selected = targets.slice(0, maxCandidateDetails);
            const readOnlyCandidates: Array<Record<string, unknown>> = [];
            for (const candidate of selected) {
              try {
                if (candidate.kind === "calendar_event") {
                  const event = await pair.calendar.getEvent(candidate.id);
                  readOnlyCandidates.push({
                    kind: candidate.kind,
                    id: candidate.id,
                    title: event.summary,
                    date: eventDisplayStart(event),
                    status: event.status,
                    recurring: Boolean(event.recurrence?.length || event.recurringEventId),
                    available: true,
                  });
                } else {
                  const task = await pair.todoist.getTask(candidate.id);
                  readOnlyCandidates.push({
                    kind: candidate.kind,
                    id: candidate.id,
                    title: task.content,
                    date: todoistDue(task),
                    recurring: Boolean(task.due?.is_recurring),
                    available: true,
                  });
                }
              } catch {
                readOnlyCandidates.push({ kind: candidate.kind, id: candidate.id, available: false });
              }
            }
            if (taskId && eventId && !extra.taskReadError && !extra.calendarReadError) {
              try {
                const [task, event] = await Promise.all([
                  pair.todoist.getTask(taskId), pair.calendar.getEvent(eventId),
                ]);
                if (event.recurrence?.length) {
                  const calendarTimeZone = await pair.calendar.getTimeZone();
                  const preview = planFutureSeriesSplit(profile, task, event, new Date(), calendarTimeZone);
                  extra.futureSplitPlan = preview;
                  extra.futureSplitPreview = futureSplitDescription(preview, event.start?.date);
                }
              } catch (error) {
                extra.futureSplitBlockedReason = error instanceof Error ? error.message : String(error);
              }
            }
            if (type === "todoist_cancelled_projection_blocked" && taskId && eventId) {
              try {
                Object.assign(extra, await this.buildConsolidationPreview(profile, taskId, eventId));
              } catch (error) {
                extra.consolidationUnavailableReason = error instanceof Error ? error.message : String(error);
              }
            }
            if (readOnlyCandidates.length) extra.readOnlyCandidates = readOnlyCandidates;
            if (targets.length > selected.length) extra.omittedCandidateCount = targets.length - selected.length;
            return extra;
          }
        : undefined,
    );
    const decision = observed.decision;
    if (!decision) return { caseStatus: observed.mode === "off" ? "policy_off" : observed.mode === "observe" ? "observe_only" : "not_created" };
    const dismissed = new Set(["acknowledge","keep_separate","ignore","dismiss","dismissed"]);
    const status = decision.status === "pending" ? "open"
      : decision.status === "resolved" && dismissed.has(String(decision.resolution || "").toLowerCase()) ? "dismissed"
        : decision.status;
    return { caseId: decision.decisionId, caseStatus: status };
  }

  async reportDeliveryFailure(delivery: Delivery | undefined, error: unknown): Promise<void> {
    if (!this.enabled || !delivery) return;
    const status = Number((error as { status?: number }).status);
    if (delivery.kind === "manual" && delivery.manual?.decisionId) {
      const original = await this.store.get(delivery.manual.decisionId);
      if (original?.status === "pending") {
        const failedAction = delivery.manual.action ? actionLabel(original, delivery.manual.action) : "Unknown action";
        await this.notifier.updateResolution(
          original,
          `⚠️ *${failedAction}* failed and may be quarantined. The decision remains pending.\n${error instanceof Error ? error.message : String(error)}\nAfter correcting the cause, use \`/sync resume\` with the decision ID shown in *Technical details*.`,
        );
      }
    }
    const type: ManualDecisionType = [401, 403].includes(status) ? "operational_provider_auth" : "operational_dlq";
    await this.createDecision(
      delivery.profile,
      type,
      { deliveryId: delivery.id, status, message: error instanceof Error ? error.message : String(error) },
      {
        sourceDeliveryId: delivery.id,
        ...(delivery.kind === "orphan" && delivery.orphan ? {
          taskId: delivery.orphan.taskId,
          eventId: delivery.orphan.eventId,
        } : {}),
      },
      operationalFailureContext(delivery, error),
    );
  }

  private async validateMappedDecision(decision: ManualDecision, state: StateRepository): Promise<Mapping | undefined> {
    if (!decision.taskId || !decision.mappingSnapshot) return undefined;
    const current = await state.getMappingByTask(decision.profile, decision.taskId);
    if (!current
      || current.eventId !== decision.mappingSnapshot.eventId
      || current.masterEventId !== decision.mappingSnapshot.masterEventId
      || current.activeInstanceId !== decision.mappingSnapshot.activeInstanceId) return undefined;
    return current;
  }

  private resolutionPolicyBlocks(decision: ManualDecision, resolution: string): unknown[] | undefined {
    const action = MANUAL_DECISION_CATALOG[decision.type].actions.find((candidate) => candidate.id === resolution);
    if (!action) return undefined;
    const value = (mode: "prompt" | "auto", scope: InterventionPolicyScope) => JSON.stringify({
      realm: "gcp-sync",
      profile: decision.profile,
      decisionId: decision.decisionId,
      decisionType: decision.type,
      policyOperation: "set",
      policyScope: scope,
      policyMode: mode,
      policyAction: resolution,
      seriesId: decision.seriesId,
    });
  const elements: unknown[] = [
      { type: "button", action_id: "gcp_sync_policy_profile_prompt", text: { type: "plain_text", text: "Default for profile" }, value: value("prompt", "profile") },
      ...(decision.seriesId ? [{ type: "button", action_id: "gcp_sync_policy_series_prompt", text: { type: "plain_text", text: "Default for series" }, value: value("prompt", "series") }] : []),
      ...(action.autoAllowed ? [{ type: "button", action_id: "gcp_sync_policy_profile_auto", style: "primary", text: { type: "plain_text", text: "Auto-apply for profile" }, value: value("auto", "profile") }] : []),
      ...(action.autoAllowed && decision.seriesId ? [{ type: "button", action_id: "gcp_sync_policy_series_auto", style: "primary", text: { type: "plain_text", text: "Auto for series" }, value: value("auto", "series") }] : []),
      { type: "button", action_id: "gcp_sync_policy_always_ask", text: { type: "plain_text", text: "Always ask" }, value: JSON.stringify({ realm: "gcp-sync", profile: decision.profile, decisionId: decision.decisionId, decisionType: decision.type, policyOperation: "set", policyScope: "profile", policyMode: "prompt" }) },
    ];
    return [
      { type: "section", text: { type: "mrkdwn", text: "*Future handling*\nSave this choice as a suggested default, or auto-apply it when the action is explicitly auto-safe." } },
      { type: "actions", block_id: `gcp_sync_policy_${decision.decisionId.slice(-24)}`, elements: elements.slice(0, 5) },
    ];
  }

  private async finishAndReconcile(
    decision: ManualDecision,
    state: StateRepository,
    resolution: string,
    slackUserId?: string,
  ): Promise<void> {
    await this.store.finish(decision.decisionId, "resolved", resolution, slackUserId);
    const reconcile = await requestReconciliation(state, decision.profile, "manual");
    const resolvedBy = slackUserId === "AUTO_POLICY" ? "saved intervention policy" : slackUserId ? `<@${slackUserId}>` : "operator";
    const text = `✅ Resolved by ${resolvedBy}\n*Result:* ${actionLabel(decision, resolution)}\nReconciliation: ${reconcile.coalesced ? "coalesced" : reconcile.queued ? "queued" : "pending"}`;
    const policyBlocks = slackUserId === "AUTO_POLICY" ? [] : (this.resolutionPolicyBlocks(decision, resolution) || []);
    await this.notifier.updateResolution(decision, text, decisionResolutionBlocks(decision, text, policyBlocks));
  }

  private async finishResolutionWithoutReconciliation(
    decision: ManualDecision,
    state: StateRepository,
    resolution: string,
    slackUserId?: string,
  ): Promise<void> {
    await this.store.finish(decision.decisionId, "resolved", resolution, slackUserId);
    const resolvedBy = slackUserId === "AUTO_POLICY" ? "saved intervention policy" : slackUserId ? `<@${slackUserId}>` : "operator";
    const text = decision.type === "todoist_owned_recurrence_task_deleted" && resolution === "delete_calendar_series"
      ? `✅ Todoist recurrence deletion completed. The Todoist task is absent, the mapped Calendar series was deleted (or was already absent), and the sync mapping was removed.\n*Todoist task:* \`${decision.taskId || "unknown"}\`\n*Calendar series:* \`${decision.masterEventId || decision.eventId || "unknown"}\`\n*Series ID:* \`${decision.seriesId || "unknown"}\`\nIf this deletion was unintended, recreate the task and Calendar series manually.`
      : `✅ Resolved by ${resolvedBy}\n*Result:* ${actionLabel(decision, resolution)}\nA full reconciliation was not started. Use the reconciliation action when you are ready to verify provider state.`;
    const policyBlocks = slackUserId === "AUTO_POLICY" ? [] : (this.resolutionPolicyBlocks(decision, resolution) || []);
    await this.notifier.updateResolution(decision, text, decisionResolutionBlocks(decision, text, policyBlocks));
  }

  private async retryConflictReconciliation(
    decision: ManualDecision,
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    // Old queued policy deliveries must not bypass explicit Slack consent.
    if (slackUserId === "AUTO_POLICY") {
      await this.notifier.postDecision({ ...decision, permittedActions: MANUAL_DECISION_CATALOG[decision.type].actions });
      return;
    }
    let clearedDlq: Awaited<ReturnType<typeof clearDeadLetterMessagesForProfile>>;
    try {
      clearedDlq = await clearDeadLetterMessagesForProfile(decision.profile);
    } catch (error) {
      await this.notifier.reconciliationOutcome(decision.slackChannelId, decision.slackMessageTs,
        `Reconciliation was not started because the ${decision.profile} DLQ could not be cleared: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const result = await requestReconciliation(state, decision.profile, "manual", undefined, {
      requester: slackUserId || "operator",
      slackChannelId: decision.slackChannelId,
      slackMessageTs: decision.slackMessageTs,
      slackThreadTs: decision.slackMessageTs,
      slackDecisionId: decision.decisionId,
    });
    const text = await this.reconciliationAcknowledgement(result, clearedDlq.deleted);
    await this.notifier.reconciliationOutcome(decision.slackChannelId, decision.slackMessageTs, text);
  }

  private async reconciliationAcknowledgement(result: ReconciliationRequestResult, clearedDlqCount = 0): Promise<string> {
    const cleared = `Cleared ${clearedDlqCount} quarantined ${clearedDlqCount === 1 ? "delivery" : "deliveries"} for ${result.profile}. `;
    if (result.enqueueError) return `${cleared}Reconciliation could not be queued: ${result.enqueueError}`;
    if (result.coalesced) {
      const location = result.slackChannelId && result.slackThreadTs
        ? await this.notifier.reconciliationLocation(result.slackChannelId, result.slackThreadTs)
        : "status command";
      return `${cleared}Reconciliation already active. This request joined generation ${result.generation}. Follow its progress and final outcome in the ${location}.`;
    }
    return `${cleared}Reconciliation queued. I’ll post the final outcome in this thread.`;
  }

  /**
   * Explicit one-object ownership resolution, not another blind full-profile
   * retry. Only a live standalone event linked to an existing recurring task
   * can enter this path. Duplicate identities require operator investigation.
   * The normal project synchronizer performs the final mapping/comment writes
   * so recurrence metadata is identical to normal Todoist-driven creation.
   */
  private async resolveUnmappedConflict(
    decision: ManualDecision,
    action: "use_todoist_recurrence" | "use_calendar_version",
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    const refuse = (reason: string) => this.markStale(decision, reason, slackUserId);
    if (!decision.taskId || !decision.eventId
      || decision.sourceAuditAction !== "todoist_snapshot_reconcile_unmapped_conflict"
      || decision.context.candidateEventIds instanceof Array
      || decision.context.candidateTaskIds instanceof Array) {
      return refuse("This decision does not identify one unambiguous live Todoist task and Calendar event. No changes made.");
    }
    const pair = await this.providerClients(decision.profile);
    let task: TodoistTask;
    let event: CalendarEvent;
    try {
      [task, event] = await Promise.all([
        pair.todoist.getTask(decision.taskId), pair.calendar.getEvent(decision.eventId),
      ]);
    } catch (error) {
      if (providerNotFound(error)) return refuse("The task or Calendar event no longer exists. No changes made.");
      throw error;
    }
    if (task.project_id !== profiles[decision.profile].todoistProjectId
      || !unresolvedStandalonePair(task, event)) {
      return refuse("The current objects are no longer one active, same-title, same-date standalone pair with Todoist recurrence. No changes made.");
    }
    const snapshots: Array<[string, string | undefined]> = [
      ["taskTitle", task.content],
      ["calendarTitle", event.summary],
      ["todoistDue", todoistDue(task)],
      ["calendarStart", eventDisplayStart(event)],
      ["todoistDescription", task.description || ""],
      ["calendarDescription", event.description || ""],
      ["todoistUpdatedAt", task.updated_at],
    ];
    for (const [field, current] of snapshots) {
      if (typeof decision.context[field] === "string"
        && normalizedText(decision.context[field]) !== normalizedText(current)) {
        return refuse(`The ${field} changed after the decision was created. No changes made.`);
      }
    }
    if (decision.context.todoistRecurring === false || decision.context.calendarStatus !== "confirmed") {
      return refuse("The original decision did not confirm an active, recurring task and Calendar event. No changes made.");
    }
    if (action === "use_todoist_recurrence" && !todoistRecurrenceToRrule(task)) {
      return refuse("The Todoist recurrence cannot be represented as a supported Calendar RRULE. No changes made.");
    }

    const [taskMapping, eventMapping, tombstone, completion, history, baseline, linked] = await Promise.all([
      state.getMappingByTaskAnyProfile(task.id),
      state.getMappingByEvent(decision.profile, event.id),
      state.getCalendarProjectionTombstone(decision.profile, task.id),
      state.getCompletedCalendarProjectionByEvent(decision.profile, event.id),
      state.listCompletedCalendarProjectionsByTaskAnyProfile(task.id),
      documentClient.send(new GetCommand({
        TableName: tableName(),
        Key: { pk: `BASELINE#${decision.profile}#TASK#${task.id}`, sk: "RECONCILE" },
        ConsistentRead: true,
      })),
      pair.calendar.findByTodoistTaskId(task.id),
    ]);
    if (taskMapping || eventMapping || tombstone || completion || history.length || baseline.Item
      || !linked || linked.id !== event.id) {
      return refuse("Ownership, a tombstone, completion history, baseline or linked Calendar identity prevents safe relinking. No changes made.");
    }

    // Enumerate actual occurrences, not only extendedProperty matches. An
    // unrelated annual series can have a 2027 instance despite a 2024 master.
    const { start, end } = manualConflictWindow(task);
    const [tasks, occurrences] = await Promise.all([
      pair.todoist.listTasks(),
      pair.calendar.listOccurrencesInWindow(start, end),
    ]);
    const competing = competingUnmappedIdentities(task, event, tasks, occurrences);
    if (competing.taskIds.length || competing.eventIds.length || !competing.sawTarget) {
      await state.audit(decision.profile, "manual_unmapped_resolution_duplicate_blocked", {
        taskId: task.id, eventId: event.id, action,
        candidateTaskIds: competing.taskIds, candidateEventIds: competing.eventIds,
      });
      return refuse("A competing Todoist task or Calendar occurrence exists, or the original event could not be verified. No changes made; inspect duplicate identities first.");
    }

    if (!event.etag) {
      return refuse("The Calendar provider did not return an ETag for the approved event. Update-only resolution is unsafe.");
    }
    let currentTask = task;
    try {
      if (action === "use_calendar_version") {
        // Converting a recurrence to one-off changes future Todoist scheduling.
        // This is explicit and confirmation-gated in Slack.
        currentTask = await pair.todoist.upsertTask(toTodoistTask(event), task.id);
        if (currentTask.due?.is_recurring || !hasCanonicalState(event, currentTask)) {
          throw new Error("Todoist did not accept the one-off Calendar date; mapping was not written");
        }
      }
      // Only update this specific approved event. An event cancelled or
      // changed after preflight must not turn into a replacement POST.
      await new ProjectAwareSynchronizer(state, undefined, this.executionClientFactory || this.clients)
        .resolveApprovedUnmappedProjection(decision.profile, currentTask, event.id, event.etag);
      const mapped = await state.getMappingByTask(decision.profile, task.id);
      if (!mapped || mapped.eventId !== event.id
        || (action === "use_todoist_recurrence" && mapped.recurrenceOwner !== "todoist")
        || (action === "use_calendar_version" && mapped.recurrenceOwner)) {
        throw new Error("The existing synchronizer did not establish the expected mapping");
      }
      const [freshTask, freshEvent] = await Promise.all([
        pair.todoist.getTask(task.id), pair.calendar.getEvent(event.id),
      ]);
      if (!hasCanonicalState(freshEvent, freshTask)) {
        throw new Error("Post-action provider states are not canonical; decision remains open");
      }
      await state.audit(decision.profile, "manual_unmapped_resolution_applied", {
        taskId: task.id, eventId: event.id, action,
      });
    } catch (error) {
      await state.audit(decision.profile, "manual_unmapped_resolution_incomplete", {
        taskId: task.id, eventId: event.id, action,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
    return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
  }

  /** User-confirmed, future-only recurrence ownership change (#84). */
  private async resolveFutureRecurringConflict(
    decision: ManualDecision,
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    const refuse = (reason: string) => this.markStale(decision, reason, slackUserId);
    if (!decision.taskId || !decision.eventId
      || decision.sourceAuditAction !== "todoist_snapshot_reconcile_unmapped_conflict"
      || Array.isArray(decision.context.candidateEventIds) && decision.context.candidateEventIds.length
      || Array.isArray(decision.context.candidateTaskIds) && decision.context.candidateTaskIds.length) {
      return refuse("Only one identified linked Todoist task and recurring master can be split. No changes made.");
    }
    if (typeof decision.context.futureSplitPreview !== "string"
      || typeof decision.context.calendarRecurrenceRule !== "string"
      || typeof decision.context.todoistRecurrenceRule !== "string"
      || !decision.context.futureSplitPlan || typeof decision.context.futureSplitPlan !== "object"
      || typeof decision.context.calendarEtag !== "string") {
      await this.notifier.updateResolution(decision,
        `A frozen recurrence cutover preview is required before approval. No provider change was made. Refresh with \`/sync resume ${decision.decisionId}\` to see the historical cutoff and new schedule.`);
      return;
    }
    const pair = await this.providerClients(decision.profile);
    let task: TodoistTask;
    let old: CalendarEvent;
    try {
      [task, old] = await Promise.all([
        pair.todoist.getTask(decision.taskId), pair.calendar.getEvent(decision.eventId),
      ]);
    } catch (error) {
      if (providerNotFound(error)) return refuse("The approved task or historical Calendar master is missing");
      throw error;
    }
    for (const [field, current] of [
      ["taskTitle", task.content], ["todoistDue", todoistDue(task)],
      ["calendarTitle", old.summary], ["calendarStart", eventDisplayStart(old)],
      ["todoistDescription", task.description || ""],
      ["calendarDescription", old.description || ""],
      ["todoistUpdatedAt", task.updated_at],
    ] as Array<[string, string | undefined]>) {
      if (typeof decision.context[field] === "string"
        && normalizedText(current) !== normalizedText(decision.context[field])) {
        return refuse(`${field} changed after the original approval request. No changes made.`);
      }
    }
    const archived = old.extendedProperties?.shared?.syncHistoryOnly === "true";
    if (!archived && decision.context.calendarEtag !== old.etag) {
      return refuse("The Calendar event version changed after approval; review the new version.");
    }
    if (decision.context.todoistRecurrenceRule !== todoistRecurrenceToRrule(task)) {
      return refuse("The Todoist recurrence changed after the approved split preview.");
    }
    if (decision.context.calendarStatus !== "confirmed"
      || decision.context.todoistRecurring === false
      || decision.context.calendarRecurrenceRule && decision.context.calendarRecurrenceRule !== old.recurrence?.[0]
        && old.extendedProperties?.shared?.syncHistoryOriginalRule !== decision.context.calendarRecurrenceRule) {
      return refuse("The original recurring Calendar series changed since notification.");
    }
    try {
      const result = await applyApprovedFutureSeriesSplit(
        decision.profile, task, old, pair, state, {
          expectedDue: typeof decision.context.todoistDue === "string" ? decision.context.todoistDue : undefined,
          expectedRule: typeof decision.context.calendarRecurrenceRule === "string"
            ? decision.context.calendarRecurrenceRule : undefined,
          approvedPlan: decision.context.futureSplitPlan as FutureSeriesSplitPlan,
          approvedEtag: decision.context.calendarEtag as string,
        },
      );
      await this.finishResolutionWithoutReconciliation(decision, state, "split_future_todoist", slackUserId);
      await this.notifier.postText(
        `✅ ${futureSplitDescription(result.plan)}. Old master \`${result.plan.oldMasterId}\`, new master \`${result.plan.newMasterId}\`.`,
        decision.slackChannelId,
      );
    } catch (error) {
      if (error instanceof ManualCircuitOpenError || error instanceof ManualSyncBlockedError || isMutationBudgetExhausted(error)) throw error;
      await state.audit(decision.profile, "manual_future_series_split_incomplete", {
        taskId: task.id, oldMasterId: old.id, decisionId: decision.decisionId,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      await this.notifier.updateResolution(decision,
        `⚠️ Future-only series change was *not* confirmed complete: ${error instanceof Error ? error.message : String(error)}. The decision remains pending. No historical Calendar occurrences were intentionally deleted. An incomplete split can be retried only after the current provider state and ownership are rechecked.`);
    }
  }

  private async resolveDuplicateConsolidation(
    decision: ManualDecision,
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    const refuse = (reason: string) => this.markStale(decision, reason, slackUserId);
    const duplicateId = decision.context.consolidationDuplicateTaskId;
    const masterId = decision.context.consolidationMasterEventId;
    const cancelledId = decision.context.consolidationCancelledEventId;
    const approvedPlan = decision.context.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit> | undefined;
    if (!decision.taskId || !decision.eventId || typeof duplicateId !== "string"
      || typeof masterId !== "string" || typeof cancelledId !== "string" || !approvedPlan
      || decision.sourceAuditAction !== "todoist_snapshot_reconcile_cancelled_projection_blocked") {
      return refuse("This card has no verified duplicate consolidation proposal. No changes made; resume it for a fresh proposal.");
    }
    const pair = await this.providerClients(decision.profile);
    const alias = await state.getConsolidatedTask(decision.profile, duplicateId);
    if (alias && (alias.retainedTaskId !== decision.taskId || alias.decisionId !== decision.decisionId)) {
      return refuse("The duplicate task is reserved by a different consolidation. No changes made.");
    }
    if (alias) {
      const [mapping, link, split] = await Promise.all([
        state.getMappingByTask(decision.profile, decision.taskId),
        state.getRecurrenceLink(decision.profile, decision.taskId),
        state.getFutureSeriesSplitAnyProfile(decision.taskId),
      ]);
      const mappingInstalled = mapping?.recurrenceOwner === "todoist"
        && mapping.masterEventId === approvedPlan.newMasterId && mapping.eventId === approvedPlan.newMasterId
        && link?.owner === "todoist" && link.masterEventId === approvedPlan.newMasterId
        && split?.profile === decision.profile && split.newMasterId === approvedPlan.newMasterId
        && Boolean(alias.previousMapping);
      if (mappingInstalled) {
        const master = await pair.calendar.getEvent(approvedPlan.newMasterId);
        const task = await pair.todoist.getTask(decision.taskId);
        if (!hasCanonicalState(master, task)) {
          return refuse("The new recurring Calendar series does not match the retained Todoist task. No duplicate was removed.");
        }
        try {
          await deleteMappingComments(pair.todoist, alias.previousMapping!);
          const oldProjectionComment = await pair.todoist.findComment(decision.taskId, alias.cancelledEventId || cancelledId);
          if (oldProjectionComment) {
            const record = await pair.todoist.getComment(oldProjectionComment.id).catch(() => undefined);
            await deleteMappingComments(pair.todoist, {
              profile: decision.profile, taskId: decision.taskId,
              eventId: alias.cancelledEventId || cancelledId,
              updatedAt: new Date().toISOString(),
              ...(record?.project_id ? { projectCommentId: oldProjectionComment.id } : { taskCommentId: oldProjectionComment.id }),
            });
          }
          await pair.calendar.deleteEvent(alias.cancelledEventId || cancelledId).catch((error: unknown) => {
            if (!providerNotFound(error)) throw error;
          });
          await pair.todoist.deleteTask(duplicateId).catch((error: unknown) => {
            if (Number((error as { status?: number }).status) !== 404) throw error;
          });
          await state.completeFutureSeriesSplit(decision.profile, decision.taskId, approvedPlan.newMasterId);
          await state.audit(decision.profile, "manual_duplicate_consolidation_completed", {
            decisionId: decision.decisionId, retainedTaskId: decision.taskId,
            discardedTaskId: duplicateId, cancelledEventId: alias.cancelledEventId || cancelledId,
            oldMasterId: approvedPlan.oldMasterId, newMasterId: approvedPlan.newMasterId,
          });
          await this.finishAndReconcile(decision, state, "consolidate_duplicate", slackUserId);
        } catch (error) {
          if (error instanceof ManualCircuitOpenError || isMutationBudgetExhausted(error)) throw error;
          await this.notifier.updateResolution(decision,
            `⚠️ The recurrence mapping is installed, but duplicate cleanup is incomplete: ${error instanceof Error ? error.message : String(error)}. The decision remains pending and can be resumed safely.`);
        }
        return;
      }
      if (split && (split.profile !== decision.profile || split.newMasterId !== approvedPlan.newMasterId)) {
        return refuse("A different recurrence split owns the retained task. No duplicate was removed.");
      }
    }

    let fresh: Record<string, unknown>;
    try {
      fresh = await this.buildConsolidationPreview(
        decision.profile, decision.taskId, cancelledId, approvedPlan,
      );
    } catch (error) {
      return refuse(`${error instanceof Error ? error.message : String(error)}. No provider changes were made.`);
    }
    const snapshotFields = [
      "consolidationDuplicateTaskId", "consolidationMasterEventId", "consolidationCancelledEventId",
      "consolidationTaskUpdatedAt", "consolidationDuplicateUpdatedAt", "consolidationMappingUpdatedAt",
      "consolidationLinkUpdatedAt", "consolidationMasterFingerprint", "consolidationTombstoneUpdatedAt",
    ];
    if (snapshotFields.some((field) => fresh[field] !== decision.context[field])) {
      return refuse("The proposed task, Calendar series, mapping, or tombstone changed after approval. Resume for a fresh proposal.");
    }
    const livePlan = fresh.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit>;
    if (["oldMasterId", "newMasterId", "previousOccurrence", "nextOldOccurrence", "newStart", "newRule", "calendarTimeZone"]
      .some((field) => livePlan[field as keyof typeof livePlan] !== approvedPlan[field as keyof typeof approvedPlan])) {
      return refuse("The recurrence cutoff changed after approval. Resume for a fresh proposal.");
    }
    if (fresh.consolidationCalendarEtag !== decision.context.consolidationCalendarEtag) {
      const [cappedMaster, split, guard] = await Promise.all([
        pair.calendar.getEvent(masterId),
        state.getFutureSeriesSplitAnyProfile(decision.taskId),
        state.getConsolidatedTask(decision.profile, duplicateId),
      ]);
      let ownApprovedCap = false;
      try {
        assertApprovedHistoryCap(cappedMaster, approvedPlan, decision.taskId);
        ownApprovedCap = split?.profile === decision.profile && split.taskId === decision.taskId
          && split.oldMasterId === masterId && split.newMasterId === approvedPlan.newMasterId
          && split.previousOccurrence === approvedPlan.previousOccurrence && split.status === "pending"
          && guard?.retainedTaskId === decision.taskId && guard.decisionId === decision.decisionId
          && guard.previousMapping?.masterEventId === masterId
          && fresh.consolidationMasterFingerprint === decision.context.consolidationMasterFingerprint;
      } catch {
        ownApprovedCap = false;
      }
      if (!ownApprovedCap) return refuse("The Calendar master changed after approval and is not the verified history cap from this consolidation. Resume for a fresh proposal.");
    }
    const [task, duplicate, old, previousMapping] = await Promise.all([
      pair.todoist.getTask(decision.taskId),
      pair.todoist.getTask(duplicateId),
      pair.calendar.getEvent(masterId),
      state.getMappingByTask(decision.profile, duplicateId),
    ]);
    if (!previousMapping || previousMapping.masterEventId !== masterId) {
      return refuse("The one-off task no longer owns the Calendar series mirror. No changes made.");
    }
    const previousLink = await state.getRecurrenceLink(decision.profile, previousMapping.seriesId || "");
    if (!previousLink) return refuse("The Calendar recurrence link is missing. No changes made.");
    const cancelled = await pair.calendar.getEvent(cancelledId);
    if (cancelled.status !== "cancelled") return refuse("The old Calendar projection is no longer cancelled. No changes made.");
    const tombstone = await state.getCalendarProjectionTombstone(decision.profile, task.id);
    const expectedTombstoneAt = decision.context.consolidationTombstoneUpdatedAt;
    if ((tombstone?.sourceUpdatedAt) !== expectedTombstoneAt) {
      return refuse("The retained task's projection tombstone changed after approval. Resume for a fresh proposal.");
    }
    try {
      const result = await applyApprovedFutureSeriesSplit(decision.profile, task, old, pair, state, {
        expectedDue: todoistDue(task),
        expectedRule: approvedPlan.originalRule,
        approvedPlan,
        approvedEtag: approvedPlan.oldEtag,
        consolidation: {
          retainedTaskId: task.id,
          discardedTask: duplicate,
          previousMapping,
          previousLink,
          cancelledEventId: cancelledId,
          decisionId: decision.decisionId,
          tombstone,
        },
      });
      await this.finishAndReconcile(decision, state, "consolidate_duplicate", slackUserId);
      await this.notifier.updateResolution(decision,
        `✅ Kept recurring Todoist task \`${task.id}\`; removed one-off task \`${duplicate.id}\` and cancelled Calendar event \`${cancelledId}\`. Calendar history was retained through *${result.plan.previousOccurrence}*; the Todoist-owned yearly series now starts on *${result.plan.newStart}* with master \`${result.plan.newMasterId}\`.`);
    } catch (error) {
      if (error instanceof ManualCircuitOpenError || isMutationBudgetExhausted(error)) throw error;
      await state.audit(decision.profile, "manual_duplicate_consolidation_incomplete", {
        decisionId: decision.decisionId, retainedTaskId: task.id,
        discardedTaskId: duplicate.id, oldMasterId: old.id,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      await this.notifier.updateResolution(decision,
        `⚠️ Consolidation did not finish: ${error instanceof Error ? error.message : String(error)}. The decision remains pending; resume it to recheck the series, mapping and duplicate before retrying.`);
    }
  }

  /**
   * A stale approval is never reopened. Operators can explicitly refresh
   * it with /sync resume <id> after changing provider state. The new decision
   * uses a versioned identity and requires a fresh Slack approval, while
   * unchanged stale conflicts retain their terminal history.
   */
  private async refreshStaleUnmappedDecision(decision: ManualDecision): Promise<boolean> {
    if (decision.type !== "todoist_unmapped_conflict" || !decision.taskId || !decision.eventId
      || !decision.sourceAuditAction) return false;
    const pair = await this.providerClients(decision.profile);
    let task: TodoistTask;
    let event: CalendarEvent;
    try {
      [task, event] = await Promise.all([
        pair.todoist.getTask(decision.taskId), pair.calendar.getEvent(decision.eventId),
      ]);
    } catch (error) {
      if (providerNotFound(error)) return false;
      throw error;
    }
    const current: Record<string, unknown> = {
      taskTitle: task.content,
      todoistDue: todoistDue(task),
      todoistRecurring: Boolean(task.due?.is_recurring),
      todoistDescription: task.description || "",
      todoistUpdatedAt: task.updated_at,
      calendarTitle: event.summary,
      calendarStart: eventDisplayStart(event),
      calendarStatus: event.status,
      calendarDescription: event.description || "",
    };
    const changed = Object.entries(current).some(([field, value]) =>
      decision.context[field] !== undefined
      && (typeof value === "string" && typeof decision.context[field] === "string"
        ? normalizedText(value) !== normalizedText(decision.context[field])
        : value !== decision.context[field]));
    if (!changed) return false;

    const revision = fingerprint(current);
    const key = decisionKey(decision.profile, decision.type, {
      priorDecisionId: decision.decisionId,
      providerRevision: revision,
    });
    const result = await this.store.putPending({
      decisionId: key.decisionId,
      fingerprint: key.fingerprint,
      profile: decision.profile,
      type: decision.type,
      severity: MANUAL_DECISION_CATALOG[decision.type].severity,
      permittedActions: MANUAL_DECISION_CATALOG[decision.type].actions,
      policyMode: "prompt",
      policyScope: decision.policyScope,
      sourceAuditAction: decision.sourceAuditAction,
      taskId: decision.taskId,
      eventId: decision.eventId,
      seriesId: decision.seriesId,
      sourceDeliveryId: decision.sourceDeliveryId,
      context: { ...decision.context, ...current, refreshedFromDecisionId: decision.decisionId },
    });
    if (result.created) await this.notifier.postDecision(result.decision);
    return result.decision.status === "pending";
  }

  private async refreshStaleConsolidationDecision(decision: ManualDecision): Promise<boolean> {
    if (decision.type !== "todoist_cancelled_projection_blocked" || !decision.taskId || !decision.eventId
      || !decision.sourceAuditAction || typeof decision.context.consolidationDuplicateTaskId !== "string") return false;
    let fresh: Record<string, unknown>;
    try {
      fresh = await this.buildConsolidationPreview(
        decision.profile, decision.taskId, decision.eventId,
        decision.context.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit> | undefined,
      );
    } catch {
      return false;
    }
    const fields = ["consolidationDuplicateTaskId", "consolidationMasterEventId", "consolidationCancelledEventId",
      "consolidationTaskUpdatedAt", "consolidationDuplicateUpdatedAt", "consolidationMappingUpdatedAt",
      "consolidationLinkUpdatedAt", "consolidationCalendarEtag", "consolidationMasterFingerprint",
      "consolidationTombstoneUpdatedAt", "consolidationFuturePlan"];
    if (!fields.some((field) => stableStringify(fresh[field]) !== stableStringify(decision.context[field]))) return false;
    const key = decisionKey(decision.profile, decision.type, {
      priorDecisionId: decision.decisionId,
      proposalRevision: fingerprint(Object.fromEntries(fields.map((field) => [field, fresh[field]]))),
    });
    const next = await this.store.putPending({
      decisionId: key.decisionId,
      fingerprint: key.fingerprint,
      profile: decision.profile,
      type: decision.type,
      severity: MANUAL_DECISION_CATALOG[decision.type].severity,
      permittedActions: MANUAL_DECISION_CATALOG[decision.type].actions,
      policyMode: "prompt",
      policyScope: decision.policyScope,
      sourceAuditAction: decision.sourceAuditAction,
      taskId: decision.taskId,
      eventId: decision.eventId,
      seriesId: decision.seriesId,
      sourceDeliveryId: decision.sourceDeliveryId,
      context: { ...decision.context, ...fresh, refreshedFromDecisionId: decision.decisionId },
    });
    if (next.created) await this.notifier.postDecision(next.decision);
    return next.decision.status === "pending";
  }

  private async markStale(decision: ManualDecision, reason: string, slackUserId?: string): Promise<void> {
    await this.store.finish(decision.decisionId, "stale", reason, slackUserId).catch(() => undefined);
    await this.notifier.updateResolution(decision, `⚠️ No action was taken because this request became stale.\n${reason}\nIf the provider objects changed, run \`/sync resume ${decision.decisionId}\` to request a new approval. The old decision will not be reopened.`);
  }

  private async restoreTodoistFromEvent(decision: ManualDecision, mapping: Mapping, state: StateRepository): Promise<void> {
    const pair = await this.providerClients(decision.profile);
    const event = await pair.calendar.getEvent(mapping.eventId);
    const task = await pair.todoist.upsertTask(toTodoistTask(event));
    await state.deleteMapping(mapping);
    const next: Mapping = { ...mapping, taskId: task.id, updatedAt: isoNow() };
    await state.putMapping(next);
    if (next.seriesId) await state.putRecurrenceLink(recurrenceLink(next));
  }

  private async resolveMappedDeletion(
    decision: ManualDecision,
    action: string,
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    const mapping = await this.validateMappedDecision(decision, state);
    if (!mapping) return this.markStale(decision, "The current mapping no longer matches the state shown in Slack.", slackUserId);
    const pair = await this.providerClients(decision.profile);

    try {
      await pair.todoist.getTask(mapping.taskId);
      return this.markStale(decision, "The Todoist task now exists again, so the deletion decision is no longer valid.", slackUserId);
    } catch (error) {
      if (!providerNotFound(error)) throw error;
    }

    if (action === "restore_todoist_task") {
      await this.restoreTodoistFromEvent(decision, mapping, state);
      return this.finishResolutionWithoutReconciliation(decision, state, "restore_todoist_task", slackUserId);
    }

    if (decision.type === "standalone_todoist_task_deleted" && action === "delete_calendar_event") {
      if (slackUserId === "AUTO_POLICY") {
        // Auto deletion must never fall through to a series or to an event
        // reassigned after the original Todoist deletion was observed.
        if (mapping.recurrenceOwner || mapping.seriesId || mapping.masterEventId
          || (mapping.activeInstanceId && mapping.activeInstanceId !== mapping.eventId)
          || mapping.updatedAt !== decision.mappingSnapshot?.updatedAt) {
          return this.markStale(decision, "The standalone mapping changed or belongs to a recurrence; no automatic Calendar deletion was applied.", slackUserId);
        }
        const eventOwner = await state.getMappingByEvent(decision.profile, mapping.eventId);
        if (!eventOwner || eventOwner.taskId !== mapping.taskId) {
          return this.markStale(decision, "The Calendar event no longer has the same mapped Todoist owner.", slackUserId);
        }
        let event: CalendarEvent | undefined;
        try { event = await pair.calendar.getEvent(mapping.eventId); }
        catch (error) { if (!providerNotFound(error)) throw error; }
        if (event && (event.recurringEventId || event.recurrence?.length
          || (event.extendedProperties?.shared?.taskId && event.extendedProperties.shared.taskId !== mapping.taskId))) {
          return this.markStale(decision, "The Calendar event is recurring or now belongs to another Todoist task.", slackUserId);
        }
      }
      await pair.calendar.deleteEvent(mapping.eventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
      await state.deleteMapping(mapping);
      await state.recordMutation(decision.profile);
      return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
    }

    if (decision.type === "todoist_owned_recurrence_task_deleted") {
      if (action === "delete_calendar_series") {
        await pair.calendar.deleteEvent(mapping.masterEventId || mapping.eventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
      }
      if (action === "keep_calendar_unlinked") {
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
      }
    }

    if (decision.type === "calendar_owned_recurrence_task_deleted" && mapping.masterEventId) {
      if (action === "delete_whole_series") {
        await pair.calendar.deleteEvent(mapping.masterEventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
      }

      if (action === "delete_this_and_future") {
        const instances = await pair.calendar.listInstances(mapping.masterEventId);
        const threshold = Date.parse(mapping.originalStart || mapping.activeEffectiveStart || "");
        const future = instances
          .filter((event) => event.status !== "cancelled")
          .filter((event) => {
            const start = Date.parse(eventStart(event) || "");
            return !Number.isFinite(threshold) || (Number.isFinite(start) && start >= threshold);
          });
        if (future.length > MAX_MANUAL_BULK_MUTATIONS) {
          await this.notifier.updateResolution(
            decision,
            `⚠️ *Delete this and future* was refused because ${future.length} Calendar instances would be mutated, above the safety cap of ${MAX_MANUAL_BULK_MUTATIONS}. Choose *Delete whole Calendar series* instead, or narrow the series first.`,
          );
          return;
        }
        for (const event of future) {
          await pair.calendar.deleteEvent(event.id).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
        }
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
      }

      if (action === "skip_occurrence") {
        await pair.calendar.deleteEvent(mapping.eventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
        await state.deleteMapping(mapping);
        const instances = await pair.calendar.listInstances(mapping.masterEventId);
        const currentStart = Date.parse(mapping.originalStart || mapping.activeEffectiveStart || "");
        const next = instances
          .filter((event) => event.status !== "cancelled")
          .filter((event) => {
            const start = Date.parse(eventStart(event) || "");
            return Number.isFinite(start) && (!Number.isFinite(currentStart) || start > currentStart);
          })
          .sort((a, b) => String(eventStart(a)).localeCompare(String(eventStart(b))))[0];
        if (next) {
          const nextTask = await pair.todoist.upsertTask(toTodoistTask(next));
          const nextMapping: Mapping = {
            ...mapping,
            eventId: next.id,
            taskId: nextTask.id,
            activeInstanceId: next.id,
            originalStart: eventStart(next),
            activeEffectiveStart: next.start?.dateTime || next.start?.date,
            updatedAt: isoNow(),
          };
          await state.putMapping(nextMapping);
          if (nextMapping.seriesId) await state.putRecurrenceLink(recurrenceLink(nextMapping));
        } else if (mapping.seriesId) {
          await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        }
        return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
      }
    }

    throw new Error(`Action ${action} is not valid for decision type ${decision.type}`);
  }

  private async resolveSnapshotConflict(
    decision: ManualDecision,
    action: string,
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    if (!decision.eventId) return this.markStale(decision, "Calendar event ID is missing from the decision.", slackUserId);
    const pair = await this.providerClients(decision.profile);
    let event: CalendarEvent;
    try { event = await pair.calendar.getEvent(decision.eventId); }
    catch (error) { if (providerNotFound(error)) return this.markStale(decision, "The Calendar event no longer exists.", slackUserId); throw error; }
    if (await state.getMappingByEvent(decision.profile, decision.eventId)) {
      return this.markStale(decision, "The Calendar event has already been mapped.", slackUserId);
    }

    let task: TodoistTask;
    if (action.startsWith("bind_task:")) {
      const taskId = action.slice("bind_task:".length);
      task = await pair.todoist.getTask(taskId);
      if (!hasCanonicalState(event, task)) return this.markStale(decision, "The selected Todoist task no longer matches the Calendar event.", slackUserId);
      if (await state.getMappingByTaskAnyProfile(taskId)) return this.markStale(decision, "The selected Todoist task is now owned by another mapping.", slackUserId);
    } else if (action === "create_new_task") {
      task = await pair.todoist.upsertTask(toTodoistTask(event));
    } else {
      throw new Error(`Unsupported snapshot conflict action ${action}`);
    }

    const recurring = decision.type === "calendar_snapshot_recurring_ambiguous";
    const mapping: Mapping = {
      profile: decision.profile,
      eventId: event.id,
      taskId: task.id,
      recurrenceOwner: recurring ? "calendar" : undefined,
      seriesId: recurring ? decision.seriesId : undefined,
      masterEventId: recurring ? decision.masterEventId : undefined,
      activeInstanceId: recurring ? event.id : undefined,
      originalStart: recurring ? eventStart(event) : undefined,
      activeEffectiveStart: recurring ? event.start?.dateTime || event.start?.date : undefined,
      updatedAt: isoNow(),
    };
    await state.putMapping(mapping);
    if (recurring && mapping.seriesId) await state.putRecurrenceLink(recurrenceLink(mapping));
    return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
  }

  private async resolveBothSidesChanged(
    decision: ManualDecision,
    action: string,
    state: StateRepository,
    slackUserId?: string,
  ): Promise<void> {
    if (!decision.taskId || !decision.eventId) return this.markStale(decision, "Mapped provider IDs are missing.", slackUserId);
    const mapping = await state.getMappingByTask(decision.profile, decision.taskId);
    if (!mapping || mapping.eventId !== decision.eventId) return this.markStale(decision, "The mapping changed after the conflict was raised.", slackUserId);
    const pair = await this.providerClients(decision.profile);
    let event: CalendarEvent | undefined;
    let task: TodoistTask | undefined;
    try { event = await pair.calendar.getEvent(decision.eventId); }
    catch (error) { if (!providerNotFound(error)) throw error; }
    try { task = await pair.todoist.getTask(decision.taskId); }
    catch (error) { if (!providerNotFound(error)) throw error; }

    if (!event && !task) return this.markStale(decision, "Both provider objects are now missing.", slackUserId);
    if (action === "calendar_wins") {
      if (!event) return this.markStale(decision, "Calendar no longer exists, so Calendar cannot win this conflict.", slackUserId);
      if (task) {
        await pair.todoist.upsertTask(toTodoistTask(event), task.id);
      } else {
        const recreated = await pair.todoist.upsertTask(toTodoistTask(event));
        await state.deleteMapping(mapping);
        await state.putMapping({ ...mapping, taskId: recreated.id, updatedAt: isoNow() });
      }
    } else if (action === "todoist_wins") {
      if (!task) return this.markStale(decision, "Todoist no longer exists, so Todoist cannot win this conflict.", slackUserId);
      if (event) {
        await pair.calendar.upsertEvent(toCalendarEvent(task, event), event.id);
      } else {
        const recreated = await pair.calendar.upsertEvent(toCalendarEvent(task));
        await state.deleteMapping(mapping);
        await state.putMapping({ ...mapping, eventId: recreated.id, updatedAt: isoNow() });
      }
    } else throw new Error(`Unsupported conflict action ${action}`);
    return this.finishResolutionWithoutReconciliation(decision, state, action, slackUserId);
  }

  async processManualDelivery(delivery: Delivery, state: StateRepository): Promise<void> {
    const manual = delivery.manual;
    if (!manual) throw new Error("Manual delivery is missing manual payload");

    if (manual.command) {
      const channel = manual.slackChannelId;
      if (manual.command === "reconcile_now" || manual.command === "resume_pending_reconciliation") {
        if (manual.slackUserId === "AUTO_POLICY") {
          await this.notifier.postText("Reconciliation requires an explicit request in Slack.", channel);
          return;
        }
        let clearedDlq: Awaited<ReturnType<typeof clearDeadLetterMessagesForProfile>>;
        try {
          clearedDlq = await clearDeadLetterMessagesForProfile(delivery.profile);
        } catch (error) {
          await this.notifier.postText(`Reconciliation was not started because the ${delivery.profile} DLQ could not be cleared: ${error instanceof Error ? error.message : String(error)}`, channel, manual.slackMessageTs);
          return;
        }
        const threadTs = await this.notifier.postText(`Cleared ${clearedDlq.deleted} quarantined ${clearedDlq.deleted === 1 ? "delivery" : "deliveries"} for *${delivery.profile}*. Reconciliation queued; I’ll post the final outcome in this thread.`, channel, manual.slackMessageTs);
        const result = await requestReconciliation(state, delivery.profile, "manual", undefined, {
          requester: manual.slackUserId || "operator", slackChannelId: channel,
          slackMessageTs: threadTs || manual.slackMessageTs,
          slackThreadTs: manual.slackMessageTs || threadTs,
        });
        if (result.enqueueError || result.coalesced) {
          const text = await this.reconciliationAcknowledgement(result, clearedDlq.deleted);
          await this.notifier.updateReconciliationIncident(channel, threadTs, text);
          await this.notifier.reconciliationOutcome(channel, manual.slackMessageTs || threadTs, text);
        }
        return;
      }
      if (manual.command === "show_status") {
        const [reconcile, decisions] = await Promise.all([state.getReconciliationState(delivery.profile), this.store.listPending(delivery.profile)]);
        await this.notifier.postText(`*todoist-calendar-sync status — ${delivery.profile}*\nReconciliation: ${reconcile ? `pending=${reconcile.pending}, generation=${reconcile.generation}, reason=${reconcile.reason}, lastCompleted=${reconcile.lastCompletedAt || "never"}` : "no state"}\nPending manual decisions: ${decisions.length}${decisions.length ? " — interactive decision cards follow." : ""}`, channel);
        for (const decision of decisions) {
          await this.notifier.postDecision({ ...decision, slackChannelId: channel });
        }
        return;
      }
      if (manual.command === "list_conflicts") {
        const decisions = await this.store.listPending(manual.targetId === "all" ? undefined : delivery.profile);
        const text = decisions.length
          ? decisions.slice(0, 20).map((decision) => `• ${MANUAL_DECISION_CATALOG[decision.type].title} (${decision.profile}) — ${decisionDisplayTitle(decision)}`).join("\n")
          : "No pending manual decisions.";
        await this.notifier.postText(`*Pending todoist-calendar-sync decisions*\n${text}`, channel);
        return;
      }
      if (manual.command === "inspect_mapping") {
        let value: unknown;
        if (manual.targetType === "task" && manual.targetId) value = await state.getMappingByTask(delivery.profile, manual.targetId);
        else if (manual.targetType === "event" && manual.targetId) value = await state.getMappingByEvent(delivery.profile, manual.targetId);
        else if (manual.targetType === "decision" && manual.targetId) value = await this.store.get(manual.targetId);
        else value = await state.getReconciliationState(delivery.profile);
        await this.notifier.postText(`*Inspect ${manual.targetType || "profile"} — ${delivery.profile}*\n\`\`\`${JSON.stringify(value || null, null, 2).slice(0, 2800)}\`\`\``, channel);
        return;
      }
      if (manual.command === "resume_decision") {
        if (!manual.targetId) throw new Error("resume_decision requires a decision ID");
        const decision = await this.store.get(manual.targetId);
        if (!decision || decision.status !== "pending") {
          if (decision?.status === "stale" && decision.type === "todoist_unmapped_conflict") {
            const refreshed = await this.refreshStaleUnmappedDecision(decision);
            await this.notifier.postText(refreshed
              ? "A refreshed decision is available. The old approval remains stale."
              : "The decision is stale and no changed provider state could be verified; no new approval was issued.", channel);
            return;
          }
          if (decision?.status === "stale" && decision.type === "todoist_cancelled_projection_blocked") {
            const refreshed = await this.refreshStaleConsolidationDecision(decision);
            await this.notifier.postText(refreshed
              ? "A refreshed consolidation proposal is available and requires fresh approval. The old approval remains stale."
              : "The decision is stale and no changed, safe consolidation proposal could be verified; no new approval was issued.", channel);
            return;
          }
          await this.notifier.postText(`Decision \`${manual.targetId}\` is not pending.`, channel);
          return;
        }
        if (decision.type === "todoist_cancelled_projection_blocked" && decision.taskId && decision.eventId) {
          const duplicateId = typeof decision.context.consolidationDuplicateTaskId === "string"
            ? decision.context.consolidationDuplicateTaskId : undefined;
          const approvedPlan = decision.context.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit> | undefined;
          if (duplicateId && approvedPlan) {
            const [guard, split] = await Promise.all([
              state.getConsolidatedTask(decision.profile, duplicateId),
              state.getFutureSeriesSplitAnyProfile(decision.taskId),
            ]);
            if (guard?.retainedTaskId === decision.taskId && guard.decisionId === decision.decisionId
              && guard.previousMapping?.masterEventId === approvedPlan.oldMasterId
              && split?.profile === decision.profile && split.taskId === decision.taskId
              && split.oldMasterId === approvedPlan.oldMasterId && split.newMasterId === approvedPlan.newMasterId
              && split.previousOccurrence === approvedPlan.previousOccurrence && split.status === "pending") {
              // The guard and frozen plan identify an operation already in
              // progress. Keep its approved phase data intact for a safe retry.
              await this.notifier.postDecision(decision);
              return;
            }
          }
          const context = { ...decision.context };
          for (const key of Object.keys(context)) {
            if (key.startsWith("consolidation")) delete context[key];
          }
          try {
            Object.assign(context, await this.buildConsolidationPreview(
              decision.profile, decision.taskId, decision.eventId,
              decision.context.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit> | undefined,
            ));
          } catch (error) {
            context.consolidationUnavailableReason = error instanceof Error ? error.message : String(error);
          }
          await this.store.refreshPendingContext(decision.decisionId, context);
          await this.notifier.postDecision({ ...decision, context });
          return;
        }
        if (decision.type === "todoist_unmapped_conflict" && decision.taskId && decision.eventId) {
          const pair = await this.providerClients(decision.profile);
          try {
            const [task, event] = await Promise.all([
              pair.todoist.getTask(decision.taskId), pair.calendar.getEvent(decision.eventId),
            ]);
            if (event.recurrence?.length) {
              const calendarTimeZone = await pair.calendar.getTimeZone();
              const prior = decision.context.futureSplitPlan as ReturnType<typeof planFutureSeriesSplit> | undefined;
              const alreadyCapped = event.extendedProperties?.shared?.syncHistoryOnly === "true";
              const planningNow = alreadyCapped && prior?.approvedAt ? new Date(prior.approvedAt) : new Date();
              const plan = planFutureSeriesSplit(decision.profile, task, event, planningNow, calendarTimeZone);
              const current = {
                taskTitle: task.content, calendarTitle: event.summary,
                todoistDue: todoistDue(task), calendarStart: eventDisplayStart(event),
              };
              if (Object.entries(current).some(([field, value]) =>
                typeof decision.context[field] === "string"
                && normalizedText(decision.context[field]) !== normalizedText(value))) {
                await this.notifier.postText("Provider dates/titles changed since the original decision. Do not use the old approval.", channel);
                return;
              }
              const context = {
                ...decision.context,
                todoistUpdatedAt: task.updated_at,
                calendarEtag: event.etag,
                todoistRecurrenceRule: plan.newRule,
                calendarRecurrenceRule: plan.originalRule,
                futureSplitPlan: plan,
                futureSplitPreview: futureSplitDescription(plan, event.start?.date),
              };
              const changedApproval = Boolean(prior) && !alreadyCapped && (
                prior?.previousOccurrence !== plan.previousOccurrence
                || prior?.nextOldOccurrence !== plan.nextOldOccurrence
                || prior?.newStart !== plan.newStart
                || prior?.newRule !== plan.newRule
                || prior.calendarTimeZone !== calendarTimeZone
                || decision.context.calendarEtag !== event.etag
                || decision.context.todoistUpdatedAt !== task.updated_at
              );
              if (changedApproval) {
                // Never revise an already approved plan in place. Generate a
                // new revision-keyed decision and make the old action terminal.
                const revision = decisionKey(decision.profile, decision.type, {
                  previousDecisionId: decision.decisionId,
                  approvedPlan: plan,
                  calendarEtag: event.etag,
                  taskVersion: task.updated_at,
                });
                const { status: _oldStatus, createdAt: _oldCreatedAt,
                  decisionDeadline: _oldDeadline, ...retained } = decision;
                const refreshed = await this.store.putPending({
                  ...retained, decisionId: revision.decisionId,
                  fingerprint: revision.fingerprint, context,
                  permittedActions: MANUAL_DECISION_CATALOG.todoist_unmapped_conflict.actions,
                  slackMessageTs: undefined,
                });
                await this.store.finish(decision.decisionId, "stale",
                  "Recurrence cutoff or approved provider version changed; fresh consent needed");
                await this.notifier.updateResolution(decision,
                  "The approved recurrence cutoff or provider version has changed. This approval is stale; review the newly issued decision.");
                if (refreshed.decision.status === "pending") {
                  await this.notifier.postDecision(refreshed.decision);
                }
                return;
              }
              if (!prior) {
                await this.store.refreshPendingContext(decision.decisionId, context);
              }
              await this.notifier.postDecision({ ...decision, context: prior ? decision.context : context });
              return;
            }
          } catch (error) {
            await this.notifier.postText(
              `The recurrence cutover preview could not be safely prepared: ${error instanceof Error ? error.message : String(error)}. No approval was issued.`,
              channel,
            );
            return;
          }
        }
        await this.notifier.postDecision(decision);
        return;
      }
      if (manual.command === "list_policies") {
        const policies = await this.policies.list(delivery.profile);
        const text = policies.length
          ? policies.slice(0, 30).map((policy) => `• ${policy.scope}${policy.seriesId ? `:${policy.seriesId}` : ""} · \`${policy.decisionType}\` → *${policy.mode}*${policy.defaultAction ? ` / ${policy.defaultAction}` : ""}`).join("\n")
          : "No saved intervention policies; catalog defaults apply.";
        await this.notifier.postText(`*todoist-calendar-sync intervention policies — ${delivery.profile}*\n${text}`, channel);
        return;
      }
      if (manual.command === "set_policy") {
        const input = manual.policy;
        if (!input?.decisionType || !input.mode) throw new Error("set_policy requires decisionType and mode");
        if (!(input.decisionType in MANUAL_DECISION_CATALOG)) throw new Error(`Unknown intervention decision type ${input.decisionType}`);
        const type = input.decisionType as ManualDecisionType;
        const catalog = MANUAL_DECISION_CATALOG[type];
        const action = input.defaultAction ? catalog.actions.find((candidate) => candidate.id === input.defaultAction) : undefined;
        if (input.defaultAction && !action) throw new Error(`Action ${input.defaultAction} is not a stable catalog action for ${type}`);
        if (input.mode === "auto" && (!input.defaultAction || !action?.autoAllowed)) {
          await this.notifier.postText(`Cannot auto-apply ${input.defaultAction || "without an action"} for \`${type}\`. The action is not marked auto-safe; save it as a prompt default instead.`, channel);
          return;
        }
        if (input.scope === "series" && !input.seriesId) throw new Error("series policy requires seriesId");
        const policy = await this.policies.put({
          decisionType: type,
          scope: input.scope,
          mode: input.mode,
          profile: input.scope === "global" ? undefined : delivery.profile,
          seriesId: input.scope === "series" ? input.seriesId : undefined,
          defaultAction: input.mode === "prompt" || input.mode === "auto" ? input.defaultAction : undefined,
          updatedBy: manual.slackUserId || "operator",
        });
        await this.notifier.postText(`✅ Policy saved: *${policy.scope}* \`${policy.decisionType}\` → *${policy.mode}*${policy.defaultAction ? ` / ${policy.defaultAction}` : ""}.`, channel);
        return;
      }
      if (manual.command === "clear_policy") {
        const input = manual.policy;
        if (!input?.decisionType) throw new Error("clear_policy requires decisionType");
        if (input.scope === "series" && !input.seriesId) throw new Error("series policy requires seriesId");
        await this.policies.delete(input.scope, input.decisionType, input.scope === "global" ? undefined : delivery.profile, input.seriesId);
        await this.notifier.postText(`Policy cleared for \`${input.decisionType}\` (${input.scope}); the next matching event will use the next policy in the hierarchy.`, channel);
        return;
      }
      throw new Error(`Unsupported manual command ${manual.command}`);
    }

    if (!manual.decisionId || !manual.action) throw new Error("Manual decision delivery requires decisionId and action");
    const decision = await this.store.get(manual.decisionId);
    if (!decision) throw new Error(`Manual decision ${manual.decisionId} was not found`);
    if (decision.status !== "pending") {
      await this.notifier.postText(`Decision \`${decision.decisionId}\` is already ${decision.status}.`, manual.slackChannelId);
      return;
    }
    const deadline = Date.parse(decision.decisionDeadline);
    if (Number.isFinite(deadline) && deadline <= Date.now()) {
      await this.store.finish(decision.decisionId, "expired", "decision deadline elapsed", manual.slackUserId).catch(() => undefined);
      await this.notifier.updateResolution(decision, `⌛ This decision expired at ${decision.decisionDeadline}. No provider mutation was made.`);
      return;
    }
    if (decision.profile !== delivery.profile) throw new Error("Manual decision profile does not match delivery profile");

    const decisionActions = decision.type === "todoist_unmapped_conflict"
      ? MANUAL_DECISION_CATALOG.todoist_unmapped_conflict.actions
      : decision.type === "todoist_cancelled_projection_blocked"
        ? MANUAL_DECISION_CATALOG.todoist_cancelled_projection_blocked.actions
      : decision.permittedActions;
    const legacyAcknowledge = decision.type === "todoist_unmapped_conflict"
      && manual.action === "acknowledge"
      && decision.permittedActions.some((candidate) => candidate.id === "acknowledge");
    const actionAllowed = legacyAcknowledge
      || decisionActions.some((candidate) => candidate.id === manual.action)
      || manual.action.startsWith("bind_task:");
    if (!actionAllowed) throw new Error(`Action ${manual.action} is not permitted for ${decision.type}`);

    const budget = new ReconciliationMutationBudget(MAX_MANUAL_BULK_MUTATIONS);
    const mapping = decision.mappingSnapshot;
    const taskIds = [...new Set([decision.taskId, mapping?.taskId, manual.action.startsWith("bind_task:") ? manual.action.slice("bind_task:".length) : undefined].filter((value): value is string => Boolean(value)))];
    const eventIds = [...new Set([decision.eventId, decision.masterEventId, decision.activeInstanceId, mapping?.eventId, mapping?.masterEventId, mapping?.activeInstanceId].filter((value): value is string => Boolean(value)))];
    const consolidationPlan = decision.type === "todoist_cancelled_projection_blocked" && manual.action === "consolidate_duplicate"
      ? decision.context.consolidationFuturePlan as ReturnType<typeof planFutureSeriesSplit> | undefined : undefined;
    const consolidationDuplicateTaskId = typeof decision.context.consolidationDuplicateTaskId === "string"
      ? decision.context.consolidationDuplicateTaskId : undefined;
    const consolidation = consolidationPlan && consolidationDuplicateTaskId ? {
      duplicateTaskId:consolidationDuplicateTaskId, oldMasterId:consolidationPlan.oldMasterId,
      newMasterId:consolidationPlan.newMasterId, previousOccurrence:consolidationPlan.previousOccurrence,
    } : undefined;
    this.executionClientFactory = this.createManualExecutionClientFactory(state, budget, { taskIds, eventIds, decision, consolidation });
    try {
      if (manual.action === "reconcile_now") {
        await this.retryConflictReconciliation(decision, state, manual.slackUserId);
        return;
      }
      if (!["acknowledge","keep_separate"].includes(manual.action)) {
        for (const taskId of taskIds) {
          if (await state.syncBlocked(decision.profile, { taskId })) throw new ManualSyncBlockedError();
          for (const eventId of eventIds) if (await state.syncBlocked(decision.profile, { taskId, eventId })) throw new ManualSyncBlockedError();
        }
        for (const eventId of eventIds) if (await state.syncBlocked(decision.profile, { eventId })) throw new ManualSyncBlockedError();
      }
      if (decision.type === "todoist_cancelled_projection_blocked" && manual.action === "consolidate_duplicate") {
        await this.resolveDuplicateConsolidation(decision, state, manual.slackUserId);
        return;
      }
      if (decision.type === "todoist_unmapped_conflict" && manual.action === "split_future_todoist") {
        await this.resolveFutureRecurringConflict(decision, state, manual.slackUserId);
        return;
      }
      if (decision.type === "todoist_unmapped_conflict"
        && (manual.action === "use_todoist_recurrence" || manual.action === "use_calendar_version")) {
        await this.resolveUnmappedConflict(decision, manual.action, state, manual.slackUserId);
        return;
      }
      if ((manual.action === "acknowledge" && decision.type === "todoist_cancelled_projection_blocked")
        || (manual.action === "keep_separate" && decision.type === "todoist_unmapped_conflict")
        || (manual.action === "acknowledge" && decision.type === "todoist_unmapped_conflict")) {
        // Acknowledgement is not a provider operation or a mapping decision.
        await this.store.finish(decision.decisionId, "resolved", manual.action, manual.slackUserId);
        await this.notifier.updateResolution(decision, "Acknowledged. Todoist and Calendar remain unchanged.");
        return;
      }
      if (["calendar_owned_recurrence_task_deleted", "todoist_owned_recurrence_task_deleted", "standalone_todoist_task_deleted"].includes(decision.type)) {
        await this.resolveMappedDeletion(decision, manual.action, state, manual.slackUserId);
        return;
      }
      if (["calendar_snapshot_unmapped_ambiguous", "calendar_snapshot_recurring_ambiguous"].includes(decision.type)) {
        await this.resolveSnapshotConflict(decision, manual.action, state, manual.slackUserId);
        return;
      }
      if (decision.type === "both_sides_changed") {
        await this.resolveBothSidesChanged(decision, manual.action, state, manual.slackUserId);
        return;
      }
      throw new Error(`Decision type ${decision.type} does not yet have an execution handler`);
    } catch (error) {
      if (error instanceof ManualCircuitOpenError || error instanceof ManualSyncBlockedError || isMutationBudgetExhausted(error)) {
        await state.audit(decision.profile, "manual_action_deferred_safety", {
          decisionId: decision.decisionId,
          action: manual.action,
          reason: error instanceof Error ? error.message : String(error),
          mutationBudget: budget.snapshot(),
        });
        await this.notifier.updateResolution(
          decision,
          `⏸️ *${actionLabel(decision, manual.action)}* was deferred by the normal sync safety controls. No further mutation was attempted.\n${error instanceof Error ? error.message : String(error)}\nThe decision remains pending; use \`/sync resume\` with the decision ID shown in *Technical details* when the circuit/budget condition has cleared.`,
        );
        return;
      }
      throw error;
    } finally {
      this.executionClientFactory = undefined;
    }
  }
}
