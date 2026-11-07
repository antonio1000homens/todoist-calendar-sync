/**
 * #376: an operational DLQ created by the recovery's own *pre-write*
 * DynamoDB expression validation must not permanently deadlock that same
 * verified recovery. All other DLQ/error/conflict cases remain blockers.
 *
 * This classifier is intentionally exact. A generic DLQ may follow a real
 * provider write and must NEVER be assumed safe because it is operational.
 */
import type { Profile } from "./types.js";
import type { ReviewCase } from "./review-types.js";
import type { ReviewStore } from "./review-store.js";

const KNOWN_PREWRITE_RECOVERY_VALIDATION =
  "Invalid ConditionExpression: Attribute name is a reserved keyword; reserved keyword: token";

export function knownPrewriteRecoveryValidationCase(
  reviewCase:ReviewCase, profile:Profile, taskId:string,
):boolean {
  const decision=reviewCase.decision;
  const context=decision?.context;
  return Boolean(
    taskId
    && reviewCase.status==="open"
    && reviewCase.reason==="operational_dlq"
    && reviewCase.profile===profile
    && reviewCase.taskId===taskId
    && !reviewCase.eventId && !reviewCase.operationId
    && decision?.type==="operational_dlq"
    && decision?.profile===profile
    && decision.status==="pending"
    && decision.decisionId===reviewCase.id
    && typeof decision.sourceDeliveryId==="string" && decision.sourceDeliveryId.length>0
    && context?.kind==="todoist"
    && context.providerTaskId===taskId
    && context.deliveryId===decision.sourceDeliveryId
    && context.failure===KNOWN_PREWRITE_RECOVERY_VALIDATION
  );
}

/**
 * Called ONLY after the new Calendar series and 3-way DynamoDB mapping were
 * confirmed and the pending reset receipt was atomically removed.
 * Dismissal uses ReviewStore's own case+manual CAS transaction; failure does
 * not unwind a successful Calendar write or create duplicate masters.
 */
export async function dismissResolvedPrewriteRecoveryIncidents(
  profile:Profile, taskId:string, review:Pick<ReviewStore,"listCases"|"dismissCase">,
):Promise<number> {
  let cursor:Record<string,unknown>|undefined;
  let complete=false, count=0;
  // Fully enumerate before mutating; an incomplete inventory must not hide
  // another case. We never resolve an unrelated open case.
  const candidates:ReviewCase[]=[];
  for(let page=0;page<20;page++) {
    const result=await review.listCases(profile,cursor,false,50);
    candidates.push(...result.items.filter(item=>knownPrewriteRecoveryValidationCase(item,profile,taskId)));
    cursor=result.cursor as Record<string,unknown>|undefined;
    if(!cursor){complete=true;break;}
  }
  if(!complete)throw new Error("Recovery incident inventory exceeded safe page bound");
  for(const incident of candidates) {
    await review.dismissCase(incident.id,
      "Automatically acknowledged after verified new recurring Calendar projection; prior DynamoDB validation rejected all writes.");
    count++;
  }
  return count;
}
