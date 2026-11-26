import {createHash} from "node:crypto";
import type {PhaseBNativeMovePlan} from "./todoist-phase-b-native-move.js";
import type {Mapping,Profile,RecurrenceLink} from "./types.js";

const key=(pk:string,sk="STATE")=>({pk,sk});

/** Must stay until a verified resume or a successful handoff; no TTL silently
 * removes a partially applied Calendar cutover. Success deletes it atomically. */
export interface PhaseBNativeMoveStage{
  operationId:string;
  taskId:string;
  sourceProfile:Profile;
  destinationProfile:Profile;
  sourceMasterId:string;
  successorMasterId:string;
  sourceMappingUpdatedAt:string;
  sourceLinkUpdatedAt:string;
  sourceEtag:string;
  /** Captured immutable original master DTSTART; recovery cannot infer it from a modified provider master. */
  originalAnchor:string;
  sourceRule:string;
  historyRule:string;
  historicalLastOccurrence:string;
  destinationStart:string;
  destinationRule:string;
}
export interface PhaseBNativeMoveHandoff{
  plan:PhaseBNativeMovePlan;
  sourceMapping:Mapping;
  sourceLink:RecurrenceLink;
  destinationMapping:Mapping;
  destinationLink:RecurrenceLink;
}
export function phaseBNativeMoveStage(input:Pick<PhaseBNativeMoveHandoff,
"plan"|"sourceMapping"|"sourceLink">):PhaseBNativeMoveStage{
  const {plan,sourceMapping:m,sourceLink:l}=input;
  if(!plan.taskId || !plan.sourceMasterId || !plan.successorMasterId
    || plan.sourceProfile===plan.destinationProfile || !plan.historyRule
    || !plan.sourceEtag || !plan.originalAnchor || !plan.historicalLastOccurrence
    || !plan.destinationStart || !plan.destinationRule
    || !m.updatedAt || !l.updatedAt || m.todoistPhaseBVersion!==1
    || m.profile!==plan.sourceProfile || m.taskId!==plan.taskId
    || m.eventId!==plan.sourceMasterId || m.masterEventId!==plan.sourceMasterId
    || m.seriesId!==plan.taskId
    || l.profile!==m.profile || l.taskId!==m.taskId
    || l.owner!=="todoist" || l.masterEventId!==m.masterEventId
    || l.eventId!==m.eventId || l.seriesId!==m.seriesId)
    throw new Error("Phase B move handoff requires a verified native source mapping and link");
  const operationId="phase-b-move-"+createHash("sha256").update(JSON.stringify([
    plan.taskId,plan.sourceProfile,plan.destinationProfile,plan.sourceMasterId,
    plan.successorMasterId,plan.originalAnchor,plan.sourceRule,plan.historyRule,
    plan.destinationStart,plan.destinationRule,plan.sourceEtag,m.updatedAt,l.updatedAt,
  ])).digest("hex").slice(0,32);
  return {operationId,taskId:plan.taskId,sourceProfile:plan.sourceProfile,
    destinationProfile:plan.destinationProfile,sourceMasterId:plan.sourceMasterId,
    successorMasterId:plan.successorMasterId,sourceMappingUpdatedAt:m.updatedAt,
    sourceLinkUpdatedAt:l.updatedAt,sourceEtag:plan.sourceEtag,originalAnchor:plan.originalAnchor,sourceRule:plan.sourceRule,
    historyRule:plan.historyRule,historicalLastOccurrence:plan.historicalLastOccurrence,
    destinationStart:plan.destinationStart,destinationRule:plan.destinationRule};
}
export function phaseBNativeMoveControlKeys(stage:PhaseBNativeMoveStage){
  return [
    key(`SYNC_CONTROL#${stage.sourceProfile}:todoist:${stage.taskId}`),
    key(`SYNC_CONTROL#${stage.sourceProfile}:calendar:${stage.sourceMasterId}`),
    key(`SYNC_CONTROL#${stage.destinationProfile}:todoist:${stage.taskId}`),
    key(`SYNC_CONTROL#${stage.destinationProfile}:calendar:${stage.successorMasterId}`),
  ];
}
export function phaseBNativeMoveStageKey(taskId:string){return key(`PHASE_B_NATIVE_MOVE#${taskId}`);}

/** This transaction places durable task/calendar controls on BOTH profiles
 * before any external provider write. Failure changes no DynamoDB rows. */
export function phaseBNativeMoveBeginTransaction(table:string,
  input:Pick<PhaseBNativeMoveHandoff,"plan"|"sourceMapping"|"sourceLink">,
  createdAt:string):Record<string,unknown>[]{
  const stage=phaseBNativeMoveStage(input),m=input.sourceMapping,l=input.sourceLink;
  if(!table || !createdAt)throw new Error("Move stage needs table and timestamp");
  const controls=phaseBNativeMoveControlKeys(stage).map(Key=>({
    Update:{TableName:table,Key,UpdateExpression:"SET activeRepair = :id",
      ConditionExpression:"(attribute_not_exists(activeRepair) OR activeRepair = :id) AND (attribute_not_exists(excluded) OR excluded = :false)",
      ExpressionAttributeValues:{":id":stage.operationId,":false":false}},
  }));
  return [
    {Put:{TableName:table,Item:{...phaseBNativeMoveStageKey(stage.taskId),...stage,createdAt},
      ConditionExpression:"attribute_not_exists(pk)"}},
    ...controls,
  ];
}

/** Finalize only transient coordination state after provider comments, masters,
 * and occurrences have independently verified the completed handoff. */
export function phaseBNativeMoveCommitTransaction(table:string,
  input:PhaseBNativeMoveHandoff, now:string):Record<string,unknown>[]{
  const stage=phaseBNativeMoveStage(input);
  if(!table||!now)throw new Error("Phase B move finalization needs table and timestamp");
  const controls=phaseBNativeMoveControlKeys(stage).map(Key=>({
    Update:{TableName:table,Key,
      UpdateExpression:"SET fencedAt = :now, providerUpdatedAt = :empty REMOVE activeRepair",
      ConditionExpression:"activeRepair = :id",
      ExpressionAttributeValues:{":id":stage.operationId,":now":now,":empty":""}},
  }));
  return [
    {Delete:{TableName:table,Key:phaseBNativeMoveStageKey(stage.taskId),
      ConditionExpression:"operationId = :id",
      ExpressionAttributeValues:{":id":stage.operationId}}},
    ...controls,
  ];
}
