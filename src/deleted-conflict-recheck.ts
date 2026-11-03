import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { ReviewStore } from "./review-store.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import type { StateRepository } from "./repository.js";
import type { Delivery, Profile } from "./types.js";

/** Index every affected case before scheduling one coalesced refresh.
 * Pending-refresh markers force a second generation if the first is already
 * processing; a failed enqueue is retried without losing those markers.
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
  const matching = [];
  const references = new Map<string, { profile: Profile; side: "todoist" | "calendar"; id: string }>();
  do {
    const page = await review.listCases(profile, cursor, false);
    for (const item of page.items) {
      if (++examined > 200) throw new Error("Deleted-conflict case inventory exceeded its bounded limit");
      if (item.status !== "open") continue;
      const { taskIds, eventIds } = reviewCaseEvidenceIds(item);
      if (!taskIds.some(id => tasks.has(id)) && !eventIds.some(id => events.has(id))) continue;
      matching.push(item);
      for (const id of taskIds) references.set(`todoist:${id}`, { profile, side: "todoist", id });
      for (const id of eventIds) references.set(`calendar:${id}`, { profile, side: "calendar", id });
    }
    cursor = page.cursor as Record<string, unknown> | undefined;
  } while (cursor);
  if (!matching.length) return false;

  // The guard must be in place for EVERY case before a reconciliation can run.
  for (const item of matching) await review.indexDeletedConflictCase(item);
  const pendingRefreshRefs = await review.markDeletedReviewPendingRefresh([...references.values()]);
  const result = await requestReconciliation(state, profile, "manual", enqueue,
    { requester: "verified-deletion-recheck", pendingRefreshRefs });
  if (!result.queued && !result.coalesced) {
    throw new Error("Verified-deletion conflict refresh could not enqueue: " + (result.enqueueError || "unknown queue failure"));
  }
  return true;
}
