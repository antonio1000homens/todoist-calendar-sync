import type { CalendarEvent, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";
import type { ManualDecision } from "./manual-intervention.js";
import type { FutureSeriesSplitPlan } from "./recurrence-split.js";
import type { StandaloneAnnualPlan } from "./standalone-annual-repair.js";
export type Side = "todoist" | "calendar";
export interface ReviewActor { subject: string; email: string }
export interface EntityRef { profile: Profile; side: Side; id: string }
export interface ReviewCase {
  id: string; profile: Profile; title: string; reason: string;
  status: "open" | "dismissed" | "repairing" | "resolved" | "excluded";
  decision?: ManualDecision; taskId?: string; eventId?: string;
  /** Hash of the active provider-pair conflict state used to coalesce audit and decision cases. */
  conflictKey?: string; sourceAuditKey?: string; coalescedInto?: string;
  createdAt: string; updatedAt: string; operationId?: string; result?: string;
  reconciliationGeneration?: string;
  progressCheckpoint?: { phase?: "mapped" | "unmapped" | "calendar"; sequence?: number; deliveryId?: string;
    nextDeliveryId?: string; afterTaskId?: string; afterEventId?: string; observedAt: string };
}
export interface RepairIntent {
  caseId: string; profile: Profile;
  action: "link" | "transfer" | "separate" | "create" | "exclude" | "decision" | "verify" | "move";
  taskId?: string; eventId?: string;
  winner: Side | "none";
  owner?: Side; scope: "occurrence" | "series" | "future";
  leftovers: Record<string, "exclude" | "create" | "unchanged" | "retain-unlinked">;
  decisionAction?: string; targetProfile?: Profile;
}
export interface ReviewSnapshot {
  ref: EntityRef; object: TodoistTask | CalendarEvent | null;
  checkedAt?: string;
  mapping?: Mapping; control?: Record<string, unknown>;
  recurrence?: RecurrenceLink; calendarProjectionId?: string;
  destination?: { profile:Profile; eventId?:string };
}
export interface RepairPreview {
  id: string; actor: ReviewActor; intent: RepairIntent; case: ReviewCase;
  snapshots: ReviewSnapshot[]; fingerprint: string; createdAt: string; expiresAt: number;
  changes: string[]; warnings: string[]; splitPlan?: FutureSeriesSplitPlan; annualPlan?: StandaloneAnnualPlan;
  /** Exact provider refs and per-object planned effects, matched to frozen snapshots. */
  itemPlan: Array<{ ref:EntityRef; operation:string; result:string }>;
}
export interface RepairStep { id: string; status: "running" | "done"; result?: unknown; startedAt: string; completedAt?: string }
export interface RepairOperation {
  id: string; preview: RepairPreview; actor: ReviewActor; attempt: number;
  status: "queued" | "running" | "succeeded" | "needs_review" | "failed";
  createdAt: string; updatedAt: string; steps: Record<string, RepairStep>;
  error?: string; nextAction?: string; abandoned?: boolean; notificationPending: boolean; notificationReplyTs?: string;
  /** Persisted before any non-validation execution step so no-write abandonment can race safely with retries. */
  writeStarted?: boolean;
  notificationText?: string; verified?: Array<{ taskId: string; eventId: string; profile: Profile }>;
  outcomes?: Array<{ entity: string; outcome: "missing" | "history" | "excluded" | "unchanged" | "retained-unlinked"; checkedAt: string }>;
  /** Controls sampled before claiming extra, non-preview move destination locks. */
  claimSnapshots?: ReviewSnapshot[];
  expectedProviders?: Record<string, TodoistTask | CalendarEvent | null>;
  recurrenceBindings?: Mapping[];
  creations?: Record<string, { profile:Profile; side:Side; requestId:string; fingerprint:string; startedAt:string; result?:TodoistTask|CalendarEvent }>;
}
export function operationHasWriteEvidence(operation: RepairOperation): boolean {
  const snapshotObjects = new Map((operation.preview?.snapshots || []).map(snapshot => [entityKey(snapshot.ref), snapshot.object ?? null]));
  const providerProgress = Object.entries(operation.expectedProviders || {}).some(([key, object]) =>
    !snapshotObjects.has(key) || stableOperationValue(object) !== stableOperationValue(snapshotObjects.get(key)));
  return operation.writeStarted === true
    || Object.keys(operation.steps || {}).some(name => name !== "validated")
    || Object.keys(operation.creations || {}).length > 0
    || providerProgress
    || operation.outcomes !== undefined || operation.verified !== undefined
    || operation.recurrenceBindings !== undefined;
}
function stableOperationValue(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key, child])=>[key,normalize(child)]))
    : item;
  return JSON.stringify(normalize(value)) ?? "undefined";
}
export interface RepairRelease { ref: EntityRef; providerUpdatedAt?: string; clearExclusion?: boolean; preserveControlState?: boolean }
export function entityKey(ref: EntityRef): string { return `${ref.profile}:${ref.side}:${ref.id}`; }
export const REVIEW_PROFILES: Profile[] = ["home", "antonio", "work"];
