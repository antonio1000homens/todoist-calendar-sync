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
  // A Calendar delta can contain thousands of cancellations. Never issue a
  // DynamoDB partition lookup per event. One coalesced full reconciliation
  // already sweeps dismissed review history; it is both cheaper and safer.
  const needsBulkSweep=tasks.size+events.size>40;
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
  // Previously dismissed deletion conflicts are not present in the Open
  // review GSI. Read only exact, expiring per-ID pointers: never scan all
  // closed cases, mistake a dismissal for repair, or turn it back into a
  // write-blocking open conflict. A later *real provider deletion* still
  // merits one guarded reconciliation to retire exclusively attributable
  // state. The worker independently verifies all provider IDs again.
  const matchedIds=new Set(matching.map(item=>item.id).filter(Boolean));
  for(const [side,ids] of [
    ["todoist",tasks],["calendar",events],
  ] as const){
    for(const id of needsBulkSweep?[]:ids){
      const pointers=await review.listDeletedConflictCaseIds(profile,side,id);
      for(const caseId of pointers){
        if(matchedIds.has(caseId))continue;
        const item=await review.getCase(caseId);
        if(!item||item.profile!==profile||item.status!=="dismissed"||item.operationId
          ||!item.id||item.id!==caseId)continue;
        const recorded=reviewCaseEvidenceIds(item);
        if(!recorded.taskIds.length||!recorded.eventIds.length
          ||recorded.taskIds.length+recorded.eventIds.length>20
          ||!(side==="todoist"?recorded.taskIds:recorded.eventIds).includes(id))continue;
        const type=item.decision?.type;
        if(type!=="todoist_unmapped_conflict"
          && !type?.includes("recurrence_task_deleted")
          && item.reason!=="calendar_snapshot_recurring_identity_conflict")continue;
        if(++examined>200)
          throw new Error("Deleted-conflict review inventory exceeded its bounded limit");
        matchedIds.add(caseId);
        matching.push(item);
        for(const taskId of recorded.taskIds)references.set(`todoist:${taskId}`,
          {profile,side:"todoist",id:taskId});
        for(const eventId of recorded.eventIds)references.set(`calendar:${eventId}`,
          {profile,side:"calendar",id:eventId});
      }
    }
  }
  if (!matching.length&&!needsBulkSweep) return false;

  // Only actionable cases receive active deletion fences. Dismissed cases
  // stay dismissed while their exact-ID refresh is coalesced.
  for (const item of matching) if(item.status==="open")
    await review.indexDeletedConflictCase(item);
  const pendingRefreshRefs = await review.markDeletedReviewPendingRefresh([...references.values()]);
  const result = await requestReconciliation(state, profile, "manual", enqueue,
    { requester: "verified-deletion-recheck", pendingRefreshRefs });
  if (!result.queued && !result.coalesced) {
    throw new Error("Verified-deletion conflict refresh could not enqueue: " + (result.enqueueError || "unknown queue failure"));
  }
  return true;
}
