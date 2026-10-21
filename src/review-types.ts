import type { CalendarEvent, Mapping, Profile, RecurrenceLink, TodoistTask } from "./types.js";
import type { ManualDecision } from "./manual-intervention.js";
import type { FutureSeriesSplitPlan } from "./recurrence-split.js";
export type Side = "todoist" | "calendar";
export interface ReviewActor { subject: string; email: string }
export interface EntityRef { profile: Profile; side: Side; id: string }
export interface ReviewCase {
  id: string; profile: Profile; title: string; reason: string;
  status: "open" | "dismissed" | "repairing" | "resolved" | "excluded";
  decision?: ManualDecision; taskId?: string; eventId?: string;
  createdAt: string; updatedAt: string; operationId?: string; result?: string;
}
export interface RepairIntent {
  caseId: string; profile: Profile;
  action: "link" | "separate" | "create" | "exclude" | "decision" | "verify" | "move";
  taskId?: string; eventId?: string;
  winner: Side | "none";
  owner?: Side; scope: "occurrence" | "series" | "future";
  leftovers: Record<string, "exclude" | "create">;
  decisionAction?: string; targetProfile?: Profile;
}
export interface ReviewSnapshot {
  ref: EntityRef; object: TodoistTask | CalendarEvent | null;
  mapping?: Mapping; control?: Record<string, unknown>;
  recurrence?: RecurrenceLink; calendarProjectionId?: string;
}
export interface RepairPreview {
  id: string; actor: ReviewActor; intent: RepairIntent; case: ReviewCase;
  snapshots: ReviewSnapshot[]; fingerprint: string; createdAt: string; expiresAt: number;
  changes: string[]; warnings: string[]; splitPlan?: FutureSeriesSplitPlan;
}
export interface RepairStep { id: string; status: "running" | "done"; result?: unknown; startedAt: string; completedAt?: string }
export interface RepairOperation {
  id: string; preview: RepairPreview; actor: ReviewActor; attempt: number;
  status: "queued" | "running" | "succeeded" | "needs_review" | "failed";
  createdAt: string; updatedAt: string; steps: Record<string, RepairStep>;
  error?: string; nextAction?: string; notificationPending: boolean; notificationReplyTs?: string;
  notificationText?: string; verified?: Array<{ taskId: string; eventId: string; profile: Profile }>;
  outcomes?: Array<{ entity: string; outcome: "missing" | "history" | "excluded"; checkedAt: string }>;
  expectedProviders?: Record<string, TodoistTask | CalendarEvent | null>;
  recurrenceBindings?: Mapping[];
}
export interface RepairRelease { ref: EntityRef; providerUpdatedAt?: string; clearExclusion?: boolean }
export function entityKey(ref: EntityRef): string { return `${ref.profile}:${ref.side}:${ref.id}`; }
export const REVIEW_PROFILES: Profile[] = ["home", "antonio", "work"];
