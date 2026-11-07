/**
 * #378: source-intent policy for a cancelled standalone Calendar mapping.
 * This is preflight evidence, never permission to write by itself. The
 * synchronizer must still inventory providers, indexes, controls and erasure
 * fences under its existing lease before the conditional reset.
 */
import { createHash } from "node:crypto";
import { operationHasWriteEvidence, entityKey, type RepairOperation, type ReviewCase } from "./review-types.js";
import { todoistRecurrenceToRrule } from "./todoist-recurrence.js";
import type { CalendarEvent, Mapping, Profile, TodoistTask } from "./types.js";

export type RecoveryPolicy = "standalone" | "weekly" | "monthly" | "yearly";
export type RecoveryDenial =
  | "ELIGIBLE" | "UNSUPPORTED_SOURCE" | "STALE_SOURCE_VERSION" | "UNSUPPORTED_RECURRENCE"
  | "SOURCE_UNCHANGED" | "FOREIGN_OR_RECURRING_MAPPING" | "REPAIR_WRITE_EVIDENCE"
  | "REPAIR_NOT_DISMISSED" | "REPAIR_IDENTITY_MISMATCH" | "AMBIGUOUS_REPAIR_SNAPSHOT"
  | "CANCELLED_PROVIDER_VERSION_UNVERIFIED" | "CANCELLED_PROVIDER_NEWER"
  | "STATE_GUARD_BLOCKED" | "PROVIDER_GUARD_BLOCKED" | "SOURCE_READBACK_CHANGED"
  | "MAPPING_INDEX_MISMATCH" | "REPAIR_CONTROL_MISMATCH" | "TRANSACTION_RACED";

export interface RecoveryEligibility {
  eligible: boolean;
  reason: RecoveryDenial;
  policy?: RecoveryPolicy;
  taskRef: { profile: Profile; side: "todoist"; id: string };
  calendarRefs: Array<{ profile: Profile; side: "calendar"; id: string }>;
  sourceVersion?: string;
  mappingVersion?: string;
  cancelledVersion?: string;
  repairVersion?: string;
  repairId?: string;
  caseId?: string;
  caseOwned: boolean;
  noWriteProof: boolean;
  guards: { completed: boolean; crossProfile: boolean; retirement: boolean; erasure: boolean };
  actions: ReadonlyArray<"retire_old_mapping" | "release_exact_repair" | "project_new_calendar" | "verify_ack">;
}

const profiles: Profile[] = ["home", "antonio", "work"];
const validSourceDate = (v: string | undefined): boolean => Boolean(v &&
  (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"))
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v))));
export const recoverySourceValue = (task: TodoistTask): string | undefined =>
  task.due?.datetime || task.due?.date;

export function recoveryPolicyForTask(task: TodoistTask): RecoveryPolicy | undefined {
  if (!validSourceDate(recoverySourceValue(task))) return undefined;
  if (!task.due?.is_recurring) return "standalone";
  const rrule = todoistRecurrenceToRrule(task);
  if (!rrule) return undefined;
  const freq = /^RRULE:FREQ=(WEEKLY|MONTHLY|YEARLY)(?:;|$)/.exec(rrule)?.[1];
  return freq ? freq.toLowerCase() as RecoveryPolicy : undefined;
}

/** Exact source revision + projection-sensitive fields; excludes volatile URLs. */
export function recoverySourceFingerprint(task: TodoistTask): string {
  const canonical = {
    id: task.id, projectId: task.project_id || "", version: task.updated_at || "",
    content: task.content, description: task.description || "",
    dueDate: task.due?.date || "", dueDatetime: task.due?.datetime || "",
    dueTimezone: task.due?.timezone || "", dueString: task.due?.string || "",
    dueRecurring: task.due?.is_recurring === true,
    rrule: todoistRecurrenceToRrule(task) || "",
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function evaluateCancelledMappingRecovery(
  profile: Profile, task: TodoistTask, mapping: Mapping, operation: RepairOperation,
  reviewCase: ReviewCase,
): RecoveryEligibility {
  const snapshots = operation.preview?.snapshots;
  const calendarRefs = Array.isArray(snapshots)
    ? snapshots.filter(s => s?.ref?.side === "calendar" && !!s.ref.id).map(s => ({
      profile:s.ref.profile, side:"calendar" as const, id:s.ref.id,
    })) : [];
  const caseOwned = reviewCase.profile === profile && reviewCase.operationId === operation.id
    && reviewCase.status === "dismissed";
  const noWriteProof = operation.status === "failed" && !operation.abandoned
    && !operation.nonResumable && !operationHasWriteEvidence(operation)
    && operation.steps?.validated?.status === "done";
  const base: RecoveryEligibility = {
    eligible:false, reason:"UNSUPPORTED_SOURCE",
    taskRef:{profile,side:"todoist",id:task.id},calendarRefs,
    sourceVersion:task.updated_at,mappingVersion:mapping.updatedAt,
    repairVersion:operation.updatedAt,repairId:operation.id,caseId:reviewCase.id,
    caseOwned,noWriteProof,
    guards:{completed:!!task.is_completed || !!task.completed_at,crossProfile:false,retirement:false,erasure:false},
    actions:[],
  };
  const deny = (reason:RecoveryDenial):RecoveryEligibility => ({...base,reason});
  if (!profiles.includes(profile) || !task.id || task.is_deleted || task.is_completed
    || task.completed_at || !task.project_id) return deny("UNSUPPORTED_SOURCE");
  const policy = recoveryPolicyForTask(task);
  if (!policy) return deny(task.due?.is_recurring ? "UNSUPPORTED_RECURRENCE" : "UNSUPPORTED_SOURCE");
  if (task.id !== mapping.taskId || mapping.profile !== profile || mapping.recurrenceOwner
    || mapping.seriesId || mapping.masterEventId || mapping.activeInstanceId) return deny("FOREIGN_OR_RECURRING_MAPPING");
  const sourceAt = Date.parse(task.updated_at || "");
  if (!Number.isFinite(sourceAt) || !mapping.updatedAt || !Number.isFinite(Date.parse(mapping.updatedAt))
    || !operation.updatedAt || !Number.isFinite(Date.parse(operation.updatedAt))
    || sourceAt <= Date.parse(mapping.updatedAt) || sourceAt <= Date.parse(operation.updatedAt))
    return deny("STALE_SOURCE_VERSION");
  if (!noWriteProof || Object.keys(operation.steps || {}).some(step => step !== "validated"))
    return deny("REPAIR_WRITE_EVIDENCE");
  if (!caseOwned) return deny("REPAIR_NOT_DISMISSED");
  if (operation.preview.intent.profile !== profile || operation.preview.intent.taskId !== task.id
    || operation.preview.intent.caseId !== reviewCase.id || operation.preview.case?.id !== reviewCase.id)
    return deny("REPAIR_IDENTITY_MISMATCH");
  if (!Array.isArray(snapshots) || snapshots.length < 2 || snapshots.length > 15
    || snapshots.some(s => !s?.ref?.id || s.ref.profile !== profile || s.lookupError)
    || new Set(snapshots.map(s => entityKey(s.ref))).size !== snapshots.length
    || !snapshots.some(s => s.ref.side === "calendar" && s.ref.id === operation.preview.intent.eventId)
    || !snapshots.some(s => s.ref.side === "todoist" && s.ref.id === task.id && s.object))
    return deny("AMBIGUOUS_REPAIR_SNAPSHOT");
  const old = snapshots.find(s => s.ref.side === "todoist" && s.ref.id === task.id)!.object as TodoistTask;
  if (old.updated_at && (Number.isNaN(Date.parse(old.updated_at)) || sourceAt <= Date.parse(old.updated_at)))
    return deny("STALE_SOURCE_VERSION");
  if (recoverySourceFingerprint({...old, updated_at:task.updated_at}) === recoverySourceFingerprint(task))
    return deny("SOURCE_UNCHANGED");
  // A previously recurring/Calendar-owned mapping must not enter this
  // *standalone* recovery policy by merely looking like a deleted event.
  if (old.due?.is_recurring === true) return deny("FOREIGN_OR_RECURRING_MAPPING");
  return {
    ...base, eligible:true, reason:"ELIGIBLE", policy,
    actions:["retire_old_mapping","release_exact_repair","project_new_calendar","verify_ack"],
  };
}

/** For new policy families we require authoritative cancellation timestamps
 * on every exact old Calendar identity. Missing timestamps fail closed.
 * The original proven yearly all-day #369 case is backward compatible. */
export function validateCancelledProviderVersions(
  task: TodoistTask, policy: RecoveryPolicy, events: CalendarEvent[],
): {ok:true;version?:string} | {ok:false;reason:RecoveryDenial} {
  let latest: string | undefined;
  for (const event of events) {
    if (event.status !== "cancelled") return {ok:false,reason:"PROVIDER_GUARD_BLOCKED"};
    if (!event.updated || !Number.isFinite(Date.parse(event.updated))) {
      if (policy !== "yearly" || task.due?.datetime || !/^\d{4}-\d{2}-\d{2}$/.test(task.due?.date || ""))
        return {ok:false,reason:"CANCELLED_PROVIDER_VERSION_UNVERIFIED"};
      continue;
    }
    if (!task.updated_at || Date.parse(task.updated_at) <= Date.parse(event.updated))
      return {ok:false,reason:"CANCELLED_PROVIDER_NEWER"};
    if (!latest || Date.parse(event.updated) > Date.parse(latest)) latest = event.updated;
  }
  return {ok:true,version:latest};
}

export interface RecoveryReceipt {
  oldEventId: string; sourceDueDate: string; sourceUpdatedAt: string;
  sourceFingerprint?: string; sourcePolicy?: RecoveryPolicy;
}
/** Legacy annual receipts have no fingerprint; keep their original guard. */
export function recoveryReceiptMatchesTask(receipt:RecoveryReceipt,task:TodoistTask):boolean {
  if (receipt.sourceFingerprint) {
    return receipt.sourceUpdatedAt === task.updated_at
      && recoveryPolicyForTask(task) === receipt.sourcePolicy
      && recoverySourceFingerprint(task) === receipt.sourceFingerprint;
  }
  return receipt.sourceDueDate === task.due?.date
    && recoveryPolicyForTask(task) === "yearly"
    && todoistRecurrenceToRrule(task) === "RRULE:FREQ=YEARLY";
}
