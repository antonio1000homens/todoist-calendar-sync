/**
 * #287 read-only, case-bound orphan diagnostic.
 *
 * This is deliberately NOT a deletion preview or an authorization token.
 * A fresh 404 for a recorded ID is not proof that another provider has no
 * live counterpart; searching every canonical/reverse reference, checking
 * ownership across profiles and installing replay fences are still required.
 */
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import type { ReviewCase, ReviewSnapshot, Side } from "./review-types.js";

export interface OrphanReadinessItem {
  side: Side;
  id: string;
  title: string;
  state: "live" | "missing" | "inactive" | "unverified";
  checkedAt?: string;
  blockers: string[];
  canExecute: false;
}
export interface OrphanReadinessReport {
  caseId: string;
  profile: ReviewCase["profile"];
  checkedAt: string;
  canExecute: false;
  status: "blocked";
  /** Diagnostic only: never accepted as a persisted preview, nonce or fence. */
  items: OrphanReadinessItem[];
  blockers: string[];
}
const validId = (value: string): boolean => value.length > 0 && value.length <= 1024
  && !/[\u0000-\u001f]/.test(value);
const unique = (items: string[]) => [...new Set(items)];
function isLive(snapshot: ReviewSnapshot): boolean {
  if (!snapshot.object || snapshot.object.id !== snapshot.ref.id || snapshot.lookupError) return false;
  if (snapshot.ref.side === "todoist") {
    const task = snapshot.object as { is_deleted?: boolean; is_completed?: boolean };
    return task.is_deleted === false && task.is_completed === false;
  }
  return (snapshot.object as { status?: string }).status === "confirmed";
}
function recurring(snapshot: ReviewSnapshot): boolean {
  if (snapshot.recurrence) return true;
  const object = snapshot.object;
  if (!object) return false;
  if (snapshot.ref.side === "todoist") {
    return (object as { due?: { is_recurring?: boolean } | null }).due?.is_recurring === true;
  }
  const event = object as {
    recurringEventId?: string; recurrence?: string[];
    extendedProperties?: { shared?: { syncRecurrenceOwner?: string } };
  };
  return Boolean(event.recurringEventId || event.recurrence?.length || event.extendedProperties?.shared?.syncRecurrenceOwner);
}
function displayedTitle(snapshot: ReviewSnapshot | undefined, id: string): string {
  if (!snapshot?.object) return "Title unavailable";
  const object = snapshot.object as { content?: string; summary?: string };
  const title = snapshot.ref.side === "todoist" ? object.content : object.summary;
  return typeof title === "string" && title.trim() ? title.trim() : "Title unavailable";
}
/** Evaluates direct reads without promoting a snapshot to executable authority.
 * Call with freshly collected case snapshots; never with a cached browser graph.
 */
export function assessOrphanReadiness(
  item: ReviewCase, snapshots: ReviewSnapshot[], checkedAt = new Date().toISOString(),
): OrphanReadinessReport {
  const evidence = reviewCaseEvidenceIds(item);
  const taskIds = unique(evidence.taskIds);
  const eventIds = unique(evidence.eventIds);
  const blockers: string[] = [];
  if (item.status !== "open" || item.operationId)
    blockers.push("This alert is not open or an operation already owns the case");
  if (item.reason.startsWith("operational_") || item.decision?.type === "operational_dlq")
    blockers.push("Operational alerts do not authorize deletion of provider objects");
  if (!taskIds.length && !eventIds.length)
    blockers.push("No exact provider identity is recorded on this alert");
  if (taskIds.length + eventIds.length > 20 || [...taskIds,...eventIds].some(id => !validId(id)))
    blockers.push("Case provider identities are invalid or exceed the 20-item safety limit");
  const expected = new Set([
    ...taskIds.map(id => "todoist:" + id),
    ...eventIds.map(id => "calendar:" + id),
  ]);
  const fresh = new Map<string, ReviewSnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot?.ref || snapshot.ref.profile !== item.profile) {
      blockers.push("A snapshot belongs to another profile or has no verified reference");
      continue;
    }
    const ref = snapshot.ref;
    if (!["todoist","calendar"].includes(ref.side) || !validId(ref.id)) {
      blockers.push("A provider snapshot has an invalid reference");
      continue;
    }
    const key = ref.side + ":" + ref.id;
    if (!expected.has(key)) {
      // A read-only repair graph can discover other items through mapping,
      // shared metadata or reverse references. Never silently discard them.
      if (isLive(snapshot) || snapshot.lookupError)
        blockers.push("Additional live or unverified " + ref.side + " identity " + ref.id + " was discovered outside the recorded case identities");
      continue;
    }
    if (fresh.has(key)) {
      blockers.push("Duplicate direct provider evidence for " + key);
      continue;
    }
    fresh.set(key,snapshot);
  }
  const refs: Array<{side:Side;id:string}> = [
    ...taskIds.map(id => ({side:"todoist" as const,id})),
    ...eventIds.map(id => ({side:"calendar" as const,id})),
  ];
  const nowMs = Date.parse(checkedAt);
  const items = refs.map(({side,id}):OrphanReadinessItem => {
    const snapshot = fresh.get(side + ":" + id);
    const reasons: string[] = [];
    let state:OrphanReadinessItem["state"] = "unverified";
    if (!snapshot) reasons.push("No fresh direct provider read for this recorded identity");
    else if (snapshot.lookupError) reasons.push("Provider lookup or ownership verification failed; absence is not proved");
    else if (!snapshot.checkedAt || !Number.isFinite(Date.parse(snapshot.checkedAt))
      || !Number.isFinite(nowMs) || Math.abs(nowMs-Date.parse(snapshot.checkedAt)) > 120_000) {
      reasons.push("Provider snapshot is stale or has no authenticated read timestamp");
    } else if (snapshot.object === null) {
      state = "missing";
      reasons.push("This recorded object is already absent and cannot be deleted again");
    } else if (snapshot.object.id !== id) {
      reasons.push("Provider response does not match the exact recorded ID");
    } else if (!isLive(snapshot)) {
      state = "inactive";
      reasons.push("Provider object is cancelled, completed or lacks authoritative live status");
    } else {
      state = "live";
      if (!displayedTitle(snapshot,id) || displayedTitle(snapshot,id) === "Title unavailable")
        reasons.push("Provider title is unavailable and must be verified before deletion");
      if (snapshot.mapping) reasons.push("A mapping exists; verify all reverse and owner indexes before cleanup");
      if (snapshot.recurrence || recurring(snapshot)) reasons.push("Recurring master or instance requires scope-specific ownership verification");
      if (snapshot.control?.activeRepair || snapshot.control?.excluded || snapshot.control?.fencedAt)
        reasons.push("Sync control or another repair currently owns this object");
      if (side === "calendar"
        && (snapshot.object as { extendedProperties?: {shared?: {taskId?:string}} }).extendedProperties?.shared?.taskId)
        reasons.push("Calendar metadata references a Todoist task");
    }
    const other: Side = side === "todoist" ? "calendar" : "todoist";
    const others = [...fresh.values()].filter(value => value.ref.side === other);
    if (!others.length) reasons.push("No exact recorded counterpart was read; a missing mapping is not proof of absence");
    if (others.some(value => isLive(value)))
      reasons.push("A live " + other + " counterpart or candidate exists in the selected alert");
    if (others.some(value => value.lookupError || !value.checkedAt))
      reasons.push("A " + other + " counterpart lookup is incomplete or unverified");
    // These are mandatory, not suggestions. Do not remove the blocker until
    // a complete server-side proof AND a fenced, durable executor are wired.
    reasons.push("Exhaustive cross-provider, cross-profile, canonical and retained-history ownership proof is not implemented");
    reasons.push("Durable single-target deletion, replay fence and postflight reconciliation are not implemented");
    return {side,id,title:displayedTitle(snapshot,id),state,checkedAt:snapshot?.checkedAt,
      blockers:unique(reasons),canExecute:false};
  });
  return {caseId:item.id,profile:item.profile,checkedAt,canExecute:false,status:"blocked",
    items,blockers:unique(blockers)};
}
