import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { classifyDeletedRecurrenceLinks, deletedSeriesKeys, readExactRecurrenceLinks, verifyCancelledSeries } from "./verified-deletion.js";
import type { CalendarEvent, Profile, RecurrenceLink } from "./types.js";
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

/** Display status is descriptive only. No read-path response grants cleanup
 * permission; the worker separately verifies providers and transaction fences. */
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
  if (!masterId || !activeInstanceId || !taskIds.length || !eventIds.includes(masterId)
    || !eventIds.includes(activeInstanceId) || taskIds.length + eventIds.length > 20)
    return { ...common, state: "unverified", bothGone: false, reason: "The recorded master, active occurrence or task identity is incomplete" };
  const find = (side: "todoist" | "calendar", id: string) =>
    snapshots.find(s => s.ref.profile === item.profile && s.ref.side === side && s.ref.id === id);
  const statuses = [...taskIds.map(id => {
    const snapshot = find("todoist", id);
    if (!snapshot || snapshot.lookupError || snapshot.object?.id !== undefined && snapshot.object.id !== id)
      return "unverified";
    return snapshot.object === null ? "gone" : snapshot.object ? "live" : "unverified";
  }), ...eventIds.map(id => {
    const snapshot = find("calendar", id);
    if (!snapshot || snapshot.lookupError || snapshot.object?.id !== undefined && snapshot.object.id !== id)
      return "unverified";
    return snapshot.object === null ? "gone"
      : "status" in snapshot.object && snapshot.object.status === "cancelled" ? "gone"
      : snapshot.object ? "live" : "unverified";
  })];
  if (statuses.includes("unverified"))
    return { ...common, state: "unverified", bothGone: false, reason: "One or more direct provider reads did not verify the exact recorded identity" };
  if (statuses.includes("live"))
    return { ...common, state: "partial", bothGone: false, reason: "At least one recorded task, master or instance is still live" };

  const calendarObjects = new Map(eventIds.map(id => {
    const event = find("calendar", id)?.object as CalendarEvent | null | undefined;
    return [id, event || undefined] as const;
  }));
  const series = verifyCancelledSeries(masterId, activeInstanceId, eventIds, calendarObjects);
  if (!series.valid || !series.masterSeriesId)
    return { ...common, state: "unverified", bothGone: false, reason: series.reason };

  // A provider snapshot may include an unrelated linked item; only actual
  // ownership of one of the exact recorded identities is a cleanup blocker.
  const tasks = new Set(taskIds), events = new Set(eventIds);
  const currentMapping = snapshots.some(s => s.mapping &&
    (tasks.has(s.mapping.taskId) || [s.mapping.eventId,s.mapping.masterEventId,s.mapping.activeInstanceId]
      .some(id => Boolean(id && events.has(id)))));
  if (currentMapping)
    return { ...common, state: "mapping_blocked", bothGone: false, reason: "A current mapping still claims a recorded task, master or instance" };

  const keys = deletedSeriesKeys(taskIds, eventIds, series.masterSeriesId,
    [item.decision.seriesId, item.decision.mappingSnapshot?.seriesId]);
  let links: RecurrenceLink[];
  try { links = await readExactRecurrenceLinks(keys, getLink); }
  catch {
    return { ...common, state: "unverified", bothGone: false,
      reason: "Unable to strongly verify all profile and Calendar-series recurrence keys" };
  }
  const classification = classifyDeletedRecurrenceLinks(item.profile, taskIds, eventIds, links, keys,
    { masterId, activeInstanceId });
  if (classification.blocked.length)
    return { ...common, state: "mapping_blocked", bothGone: false,
      reason: classification.blocked.slice(0, 3).join("; ") };
  const staleLinks = classification.stale.map(link => ({
    profile: link.profile, taskId: link.taskId, seriesId: link.seriesId,
    eventId: link.eventId, masterEventId: link.masterEventId, activeInstanceId: link.activeInstanceId,
  }));
  if (staleLinks.length) return { ...common, staleLinks, state: "stale_recurrence", bothGone: true };
  return { ...common, state: item.status === "resolved" ? "closed" : "pending_cleanup", bothGone: true };
}
