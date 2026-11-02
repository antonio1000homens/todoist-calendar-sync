import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { ReviewStore } from "./review-store.js";
import type { StateRepository } from "./repository.js";
import type { Delivery, Profile } from "./types.js";

/** Deletion webhooks trigger a current-state check only when an open review
 * case cites the exact provider ID, never by a title or scheduled date.
 * The queue coalesces multiple events into one per-profile generation.
 */
export async function requestDeletedConflictReview(
  state: StateRepository,
  profile: Profile,
  removed: { taskIds?: string[]; eventIds?: string[] },
  review = new ReviewStore(),
  enqueue: (delivery: Delivery) => Promise<void> = enqueueDelivery,
): Promise<boolean> {
  const tasks = new Set(removed.taskIds || []);
  const events = new Set(removed.eventIds || []);
  if (!tasks.size && !events.size) return false;
  let cursor: Record<string, unknown> | undefined;
  let examined = 0;
  do {
    const page = await review.listCases(profile, cursor, false);
    for (const item of page.items) {
      if (++examined > 200) return false;
      if (item.status !== "open") continue;
      const context = item.decision?.context || {};
      const vals = (v: unknown): string[] => Array.isArray(v) ? v.filter((id): id is string =>
        typeof id === "string" && Boolean(id)) : [];
      const candidateItems = Array.isArray(context.candidates)
        ? context.candidates.map((item: unknown) => (item as { id?: unknown } | null)?.id) : [];
      const taskIds = [item.taskId, item.decision?.taskId, context.taskId, context.masterTaskId,
        context.providerTaskId, ...vals(context.candidateTaskIds), ...candidateItems];
      const eventIds = [item.eventId, item.decision?.eventId, item.decision?.masterEventId,
        item.decision?.activeInstanceId, context.eventId, context.providerEventId,
        context.masterEventId, context.activeInstanceId, ...vals(context.candidateEventIds)];
      if (!taskIds.some(id => typeof id === "string" && tasks.has(id))
        && !eventIds.some(id => typeof id === "string" && events.has(id))) continue;
      const result = await requestReconciliation(state, profile, "manual", enqueue,
        { requester: "verified-deletion-recheck" });
      if (!result.queued && !result.coalesced) {
        throw new Error("Verified-deletion conflict refresh could not enqueue: " + (result.enqueueError || "unknown queue failure"));
      }
      return true;
    }
    cursor = page.cursor as Record<string, unknown> | undefined;
  } while (cursor && examined < 200);
  return false;
}
