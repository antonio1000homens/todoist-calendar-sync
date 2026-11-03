import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import type { Profile, RecurrenceLink } from "./types.js";
import type { ReviewCase, ReviewSnapshot } from "./review-types.js";

export type DeletedRecurrenceStatus = {
  state: "unverified" | "partial" | "stale_recurrence" | "mapping_blocked" | "pending_cleanup" | "closed";
  bothGone: boolean;
  taskIds: string[];
  eventIds: string[];
  masterId?: string;
  activeInstanceId?: string;
  staleLinks: Array<{ profile: Profile; taskId: string; seriesId: string; eventId: string; masterEventId?: string; activeInstanceId?: string }>;
  reason?: string;
};

/** Read-only status for the exact case identities. A failed lookup, missing
 * master identity, or a live occurrence never counts as verified deletion. */
export async function deletedRecurrenceStatus(
  item: ReviewCase,
  snapshots: ReviewSnapshot[],
  getLink: (profile: Profile, seriesId: string) => Promise<RecurrenceLink | undefined>,
): Promise<DeletedRecurrenceStatus | undefined> {
  if (!item.decision?.type?.includes("recurrence_task_deleted")) return undefined;
  const { taskIds, eventIds } = reviewCaseEvidenceIds(item);
  const masterId = item.decision.masterEventId || item.decision.mappingSnapshot?.masterEventId;
  const activeInstanceId = item.decision.activeInstanceId || item.decision.mappingSnapshot?.activeInstanceId;
  const common = { taskIds, eventIds, masterId, activeInstanceId, staleLinks: [] };
  if (!masterId || !taskIds.length || !eventIds.includes(masterId) || taskIds.length + eventIds.length > 20)
    return { ...common, state: "unverified", bothGone: false, reason: "The recorded series master or provider identity is unverified" };
  const verified = (side: "todoist" | "calendar", id: string): "gone" | "live" | "unverified" => {
    const snapshot = snapshots.find(s => s.ref.profile === item.profile && s.ref.side === side && s.ref.id === id);
    if (!snapshot || snapshot.lookupError || snapshot.object && snapshot.object.id !== id) return "unverified";
    if (snapshot.object === null) return "gone";
    if (!snapshot.object) return "unverified";
    if (side === "calendar") return "status" in snapshot.object && snapshot.object.status === "cancelled" ? "gone" : "live";
    return "live"; // A normal Todoist response is not a verified 404/410.
  };
  const statuses = [...taskIds.map(id => verified("todoist", id)),
    ...eventIds.map(id => verified("calendar", id))];
  if (statuses.includes("unverified"))
    return { ...common, state: "unverified", bothGone: false, reason: "One or more exact provider reads were incomplete" };
  if (statuses.includes("live"))
    return { ...common, state: "partial", bothGone: false, reason: "At least one mapped task, master or instance remains live" };
  if (snapshots.some(s => s.ref.profile === item.profile && s.mapping))
    return { ...common, state: "mapping_blocked", bothGone: true, reason: "A current mapping still references these provider identities" };
  const staleLinks: DeletedRecurrenceStatus["staleLinks"] = [];
  for (const taskId of taskIds) {
    let link: RecurrenceLink | undefined;
    try { link = await getLink(item.profile, taskId); }
    catch {
      return { ...common, state: "unverified", bothGone: false, reason: "Unable to verify the DynamoDB recurrence index" };
    }
    if (!link) continue;
    if (link.profile !== item.profile || link.owner !== "todoist" || link.taskId !== taskId
      || link.seriesId !== taskId || !eventIds.includes(link.eventId)
      || link.masterEventId && !eventIds.includes(link.masterEventId)
      || link.activeInstanceId && !eventIds.includes(link.activeInstanceId))
      return { ...common, state: "mapping_blocked", bothGone: true, reason: "A recurrence link has ambiguous or changed ownership" };
    staleLinks.push({ profile: link.profile, taskId: link.taskId, seriesId: link.seriesId,
      eventId: link.eventId, masterEventId: link.masterEventId, activeInstanceId: link.activeInstanceId });
  }
  if (staleLinks.length) return { ...common, staleLinks, state: "stale_recurrence", bothGone: true };
  return { ...common, state: item.status === "resolved" ? "closed" : "pending_cleanup", bothGone: true };
}
