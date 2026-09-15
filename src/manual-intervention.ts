import { createHash } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient, pacedScan } from "./dynamodb-capacity.js";
import { secureParameter } from "./config.js";
import { createBudgetedClientFactory, defaultProviderClientFactory, isMutationBudgetExhausted, ReconciliationMutationBudget, type ProviderClientFactory } from "./mutation-budget.js";
import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { InterventionPolicyStore, type EffectiveInterventionPolicy, type InterventionPolicyScope, type InterventionResponseMode } from "./intervention-policy.js";
import { StateRepository } from "./repository.js";
import { hasCanonicalState, toCalendarEvent, toTodoistTask } from "./sync.js";
import type { CalendarEvent, Delivery, Mapping, Profile, RecurrenceLink, TodoistTask, TodoistWebhookPayload } from "./types.js";

const DEFAULT_DECISION_RETENTION_DAYS = 30;
const DEFAULT_DECISION_DEADLINE_DAYS = 7;
const MAX_MANUAL_BULK_MUTATIONS = 10;
const MANUAL_CALENDAR_MUTATIONS = new Set(["upsertEvent", "deleteEvent"]);
const MANUAL_TODOIST_MUTATIONS = new Set(["upsertTask", "updateRecurringOccurrence", "deleteTask", "upsertComment", "deleteComment"]);

class ManualCircuitOpenError extends Error {
  constructor(readonly profile: Profile, readonly operation: string) {
    super(`Manual intervention blocked by the mutation circuit for ${profile} before ${operation}`);
    this.name = "ManualCircuitOpenError";
  }
}

export type ManualDecisionStatus = "pending" | "resolved" | "stale" | "cancelled" | "expired";
export type ManualDecisionSeverity = "info" | "warning" | "destructive";
export type ManualDecisionType =
  | "calendar_owned_recurrence_task_deleted"
  | "todoist_owned_recurrence_task_deleted"
  | "standalone_todoist_task_deleted"
  | "calendar_snapshot_unmapped_ambiguous"
  | "calendar_snapshot_recurring_ambiguous"
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
  /** Explicitly eligible for unattended execution after the user saves an auto policy. */
  autoAllowed?: boolean;
}

export interface ManualDecisionPolicy {
  title: string;
  severity: ManualDecisionSeverity;
  actions: ManualActionDefinition[];
  detection: "pre_mutation" | "audit_conflict" | "operational" | "future";
  defaultMode?: InterventionResponseMode;
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
    actions: actions(
      ["delete_calendar_series", "Delete Calendar series", true],
      ["keep_calendar_unlinked", "Keep Calendar and unlink", false, true],
      ["restore_todoist_task", "Restore Todoist task", false, true],
    ),
  },
  standalone_todoist_task_deleted: {
    title: "Todoist task deleted — mapped Calendar event still exists",
    severity: "destructive",
    detection: "pre_mutation",
    actions: actions(
      ["delete_calendar_event", "Delete Calendar event", true],
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
    actions: actions(["reconcile_now", "Request another reconciliation", false, true]),
  },
  operational_circuit_open: {
    title: "Sync circuit breaker is open",
    severity: "warning",
    detection: "operational",
    actions: actions(["reconcile_now", "Retry through normal reconciliation", false, true]),
  },
  operational_reconciliation_stuck: {
    title: "Reconciliation has remained pending too long",
    severity: "warning",
    detection: "future",
    actions: actions(["reconcile_now", "Resume reconciliation"]),
  },
  operational_dlq: {
    title: "A sync delivery was quarantined",
    severity: "warning",
    detection: "operational",
    actions: actions(["reconcile_now", "Request fresh reconciliation", false, true]),
  },
  operational_provider_auth: {
    title: "Provider authentication or authorization failed",
    severity: "warning",
    detection: "operational",
    actions: actions(["reconcile_now", "Retry after credentials are fixed", false, true]),
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

function decisionKey(profile: Profile, type: ManualDecisionType, identity: Record<string, unknown>): { decisionId: string; fingerprint: string } {
  const stateFingerprint = fingerprint(identity);
  return {
    decisionId: `${profile}-${type}-${stateFingerprint}`,
    fingerprint: stateFingerprint,
  };
}

function providerNotFound(error: unknown): boolean {
  return [404, 410].includes(Number((error as { status?: number }).status));
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
    if (current) return { decision: current, created: false };
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
        expiresAt: epochDays(DEFAULT_DECISION_RETENTION_DAYS),
      },
    }));
    return { decision, created: true };
  }

  async listPending(profile?: Profile): Promise<ManualDecision[]> {
    const values: Record<string, unknown> = { ":prefix": "MANUAL#", ":pending": "pending" };
    let filter = "begins_with(pk, :prefix) AND #status = :pending";
    if (profile) {
      filter += " AND #profile = :profile";
      values[":profile"] = profile;
    }
    const result = await pacedScan<StoredDecision>({
      TableName: tableName(),
      FilterExpression: filter,
      ExpressionAttributeNames: { "#status": "status", "#profile": "profile" },
      ExpressionAttributeValues: values,
    }, {
      operation: "list_pending_manual_decisions",
      profile,
    });
    return result.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      UpdateExpression: "SET #status = :status, resolution = :resolution, resolvedAt = :resolvedAt, resolvedBySlackUserId = :user, expiresAt = :expiresAt",
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
  }
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
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

async function slackApi(method: "chat.postMessage" | "chat.update", payload: Record<string, unknown>): Promise<SlackApiResponse> {
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
    case "todoist_owned_recurrence_task_deleted":
      return "*Choose one:* Delete the Calendar series if the Todoist deletion was intentional, keep it and unlink it, or restore the Todoist task. No provider action happens until you choose.";
    case "calendar_owned_recurrence_task_deleted":
      return "*Choose one:* Skip this occurrence, delete this and future occurrences, delete the whole Calendar series, or restore the Todoist task. No provider action happens until you choose.";
    default:
      return undefined;
  }
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
  const lines = [
    `*Profile:* \`${decision.profile}\``,
    sameTitle && displayTaskTitle ? `*Item:* ${displayTaskTitle}` : undefined,
    !sameTitle && displayTaskTitle ? `*Todoist task:* ${displayTaskTitle}` : undefined,
    !sameTitle && displayCalendarTitle ? `*Calendar event:* ${displayCalendarTitle}` : undefined,
    displayTaskDue ? `*Todoist due:* ${displayTaskDue}` : undefined,
    displayCalendarStart ? `*Calendar start:* ${displayCalendarStart}` : undefined,
    changeSummary(decision) ? `*What changed:* ${changeSummary(decision)}` : undefined,
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
  const allActions = [...decision.permittedActions, ...dynamicActions];
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
  blocks.push(technicalContextBlock(decision));
  return blocks;
}

export class SlackManualNotifier {
  constructor(private readonly store = new ManualDecisionStore()) {}

  async postDecision(decision: ManualDecision): Promise<void> {
    if (!slackEnabled()) return;
    try {
      const result = await slackApi("chat.postMessage", {
        channel: decision.slackChannelId || defaultSlackChannel(),
        text: MANUAL_DECISION_CATALOG[decision.type].title,
        blocks: decisionBlocks(decision),
      });
      if (result.channel && result.ts) await this.store.setSlackLocation(decision.decisionId, result.channel, result.ts);
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-manual",
        event: "slack_decision_post_failed",
        decisionId: decision.decisionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async postText(text: string, channel?: string): Promise<void> {
    if (!slackEnabled()) return;
    try {
      await slackApi("chat.postMessage", { channel: channel || defaultSlackChannel(), text });
    } catch (error) {
      console.error(JSON.stringify({ service: "todoist-calendar-sync-manual", event: "slack_status_post_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async updateResolution(decision: ManualDecision, text: string, blocks?: unknown[]): Promise<void> {
    if (!slackEnabled()) return;
    const fresh = await this.store.get(decision.decisionId) || decision;
    if (!fresh.slackChannelId || !fresh.slackMessageTs) {
      await this.postText(`${MANUAL_DECISION_CATALOG[fresh.type].title}\n${contextLines(fresh).join("\n")}\n${text}\n${technicalContextText(fresh)}`);
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

  private async providerClients(profile: Profile) {
    return (this.executionClientFactory || this.clients)(profile);
  }

  private createManualExecutionClientFactory(
    state: StateRepository,
    budget: ReconciliationMutationBudget,
  ): ProviderClientFactory {
    const budgeted = createBudgetedClientFactory(budget, this.clients);
    const circuitWrapped = <T extends object>(target: T, profile: Profile, mutatingMethods: Set<string>): T => new Proxy(target, {
      get(current, property, receiver) {
        const value = Reflect.get(current, property, receiver);
        if (typeof value !== "function") return value;
        const operation = String(property);
        if (!mutatingMethods.has(operation)) return value.bind(current);
        return async (...args: unknown[]) => {
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
    const effective = await this.policies.resolve(profile, type, seriesId, catalog.defaultMode || "prompt");
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
      if (existing) return { decision: existing, mode };
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
    if (mode === "prompt" && result.created) await this.notifier.postDecision(result.decision);
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
    if (effective.mode === "prompt") {
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

  async observeAudit(
    delivery: Delivery,
    profile: Profile,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabled || delivery.kind === "manual") return;
    let type: ManualDecisionType | undefined;
    if (action === "calendar_snapshot_unmapped_ambiguous") type = "calendar_snapshot_unmapped_ambiguous";
    else if (action === "calendar_snapshot_recurring_ambiguous") type = "calendar_snapshot_recurring_ambiguous";
    else if (action === "todoist_snapshot_reconcile_conflict_both_sides_changed") type = "both_sides_changed";
    else if (action === "reconciliation_mutation_budget_exhausted" || action === "calendar_snapshot_reconcile_mutation_budget_exhausted") type = "operational_mutation_budget";
    else if (action.includes("circuit_open") || action.includes("circuit_deferred")) type = "operational_circuit_open";
    if (!type) return;

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

    await this.createDecision(
      profile,
      type,
      { action, eventId, taskId, seriesId, detail },
      {
        sourceDeliveryId: delivery.id,
        sourceAuditAction: action,
        eventId,
        taskId,
        seriesId,
        masterEventId: typeof detail.masterEventId === "string" ? detail.masterEventId : undefined,
        activeInstanceId: typeof detail.activeInstanceId === "string" ? detail.activeInstanceId : undefined,
      },
      context,
    );
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
      { sourceDeliveryId: delivery.id },
      { kind: delivery.kind, status, error: error instanceof Error ? error.message : String(error) },
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
      { type: "button", action_id: "gcp_sync_policy", text: { type: "plain_text", text: "Default for profile" }, value: value("prompt", "profile") },
      ...(decision.seriesId ? [{ type: "button", action_id: "gcp_sync_policy", text: { type: "plain_text", text: "Default for series" }, value: value("prompt", "series") }] : []),
      ...(action.autoAllowed ? [{ type: "button", action_id: "gcp_sync_policy", style: "primary", text: { type: "plain_text", text: "Auto-apply for profile" }, value: value("auto", "profile") }] : []),
      ...(action.autoAllowed && decision.seriesId ? [{ type: "button", action_id: "gcp_sync_policy", style: "primary", text: { type: "plain_text", text: "Auto for series" }, value: value("auto", "series") }] : []),
      { type: "button", action_id: "gcp_sync_policy", text: { type: "plain_text", text: "Always ask" }, value: JSON.stringify({ realm: "gcp-sync", profile: decision.profile, decisionId: decision.decisionId, decisionType: decision.type, policyOperation: "set", policyScope: "profile", policyMode: "prompt" }) },
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

  private async markStale(decision: ManualDecision, reason: string, slackUserId?: string): Promise<void> {
    await this.store.finish(decision.decisionId, "stale", reason, slackUserId).catch(() => undefined);
    await this.notifier.updateResolution(decision, `⚠️ No action was taken because this request became stale.\n${reason}`);
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
      return this.finishAndReconcile(decision, state, "restore_todoist_task", slackUserId);
    }

    if (decision.type === "standalone_todoist_task_deleted" && action === "delete_calendar_event") {
      await pair.calendar.deleteEvent(mapping.eventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
      await state.deleteMapping(mapping);
      return this.finishAndReconcile(decision, state, action, slackUserId);
    }

    if (decision.type === "todoist_owned_recurrence_task_deleted") {
      if (action === "delete_calendar_series") {
        await pair.calendar.deleteEvent(mapping.masterEventId || mapping.eventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishAndReconcile(decision, state, action, slackUserId);
      }
      if (action === "keep_calendar_unlinked") {
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishAndReconcile(decision, state, action, slackUserId);
      }
    }

    if (decision.type === "calendar_owned_recurrence_task_deleted" && mapping.masterEventId) {
      if (action === "delete_whole_series") {
        await pair.calendar.deleteEvent(mapping.masterEventId).catch((error: unknown) => { if (!providerNotFound(error)) throw error; });
        await state.deleteMapping(mapping);
        if (mapping.seriesId) await state.deleteRecurrenceLink(decision.profile, mapping.seriesId);
        return this.finishAndReconcile(decision, state, action, slackUserId);
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
        return this.finishAndReconcile(decision, state, action, slackUserId);
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
        return this.finishAndReconcile(decision, state, action, slackUserId);
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
    return this.finishAndReconcile(decision, state, action, slackUserId);
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
    return this.finishAndReconcile(decision, state, action, slackUserId);
  }

  async processManualDelivery(delivery: Delivery, state: StateRepository): Promise<void> {
    const manual = delivery.manual;
    if (!manual) throw new Error("Manual delivery is missing manual payload");

    if (manual.command) {
      const channel = manual.slackChannelId;
      if (manual.command === "reconcile_now" || manual.command === "resume_pending_reconciliation") {
        const result = await requestReconciliation(state, delivery.profile, "manual");
        await this.notifier.postText(`🔄 Reconciliation for *${delivery.profile}*: ${result.coalesced ? "already pending/coalesced" : result.queued ? "queued" : "pending"}${result.enqueueError ? ` — enqueue error: ${result.enqueueError}` : ""}`, channel);
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
          await this.notifier.postText(`Decision \`${manual.targetId}\` is not pending.`, channel);
          return;
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

    const actionAllowed = decision.permittedActions.some((candidate) => candidate.id === manual.action)
      || manual.action.startsWith("bind_task:");
    if (!actionAllowed) throw new Error(`Action ${manual.action} is not permitted for ${decision.type}`);

    const budget = new ReconciliationMutationBudget(MAX_MANUAL_BULK_MUTATIONS);
    this.executionClientFactory = this.createManualExecutionClientFactory(state, budget);
    try {
      if (manual.action === "reconcile_now") {
        await this.finishAndReconcile(decision, state, manual.action, manual.slackUserId);
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
      if (error instanceof ManualCircuitOpenError || isMutationBudgetExhausted(error)) {
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
