import {createHash} from "node:crypto";
import {mappingEventLookupAttributes,mappingLookupAttributes,mappingOwnerLookupAttributes,
  recurrenceLookupAttributes} from "./profile-lookup.js";
import type {PhaseBNativeMovePlan} from "./todoist-phase-b-native-move.js";
import type {Mapping,Profile,RecurrenceLink} from "./types.js";

const profiles:Profile[]=["home","antonio","work"];
const key=(pk:string,sk="STATE")=>({pk,sk});
const versionedSource=(previous:Mapping)=>({
  ConditionExpression:"#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND recurrenceOwner = :owner AND seriesId = :series AND masterEventId = :master AND todoistPhaseBVersion = :native",
  ExpressionAttributeNames:{"#profile":"profile"},
  ExpressionAttributeValues:{":profile":previous.profile,":task":previous.taskId,
    ":event":previous.eventId,":updated":previous.updatedAt,":owner":"todoist",
    ":series":previous.seriesId,":master":previous.masterEventId,":native":1},
});
const versionedLink=(link:RecurrenceLink)=>({
  ConditionExpression:"#profile = :profile AND taskId = :task AND eventId = :event AND updatedAt = :updated AND #owner = :owner AND seriesId = :series AND masterEventId = :master",
  ExpressionAttributeNames:{"#profile":"profile","#owner":"owner"},
  ExpressionAttributeValues:{":profile":link.profile,":task":link.taskId,
    ":event":link.eventId,":updated":link.updatedAt,":owner":"todoist",
    ":series":link.seriesId,":master":link.masterEventId},
});

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
    || m.recurrenceOwner!=="todoist" || m.seriesId!==plan.taskId
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
    {ConditionCheck:{TableName:table,
      Key:key(`TASKOWNER#${stage.taskId}`,"MAP"),...versionedSource(m)}},
    {ConditionCheck:{TableName:table,
      Key:key(`RECURRENCE#${stage.sourceProfile}#${stage.taskId}`),...versionedLink(l)}},
    {ConditionCheck:{TableName:table,
      Key:key(`TASK#${stage.destinationProfile}#${stage.taskId}`,"MAP"),
      ConditionExpression:"attribute_not_exists(pk)"}},
    {ConditionCheck:{TableName:table,
      Key:key(`EVENT#${stage.destinationProfile}#${stage.successorMasterId}`,"MAP"),
      ConditionExpression:"attribute_not_exists(pk)"}},
    ...profiles.filter(p=>p!==stage.sourceProfile&&p!==stage.destinationProfile).map(profile=>({
      ConditionCheck:{TableName:table,
        Key:key(`TASK#${profile}#${stage.taskId}`,"MAP"),
        ConditionExpression:"attribute_not_exists(pk)"},
    })),
  ];
}

/** Atomic handoff AFTER independent provider verification: no source row can
 * disappear before the new task owner, destination rows and link are stored.
 * Completed history on the source calendar is untouched. */
export function phaseBNativeMoveCommitTransaction(table:string,
  input:PhaseBNativeMoveHandoff, now:string):Record<string,unknown>[]{
  const stage=phaseBNativeMoveStage(input);
  const previous=input.sourceMapping,oldLink=input.sourceLink;
  const next=input.destinationMapping,newLink=input.destinationLink;
  if(!table||!now || next.profile!==stage.destinationProfile
    || next.taskId!==stage.taskId || next.eventId!==stage.successorMasterId
    || next.masterEventId!==stage.successorMasterId
    || next.recurrenceOwner!=="todoist" || next.todoistPhaseBVersion!==1
    || next.seriesId!==stage.taskId || next.originalStart!==stage.destinationStart
    || !next.activeInstanceId || !next.updatedAt
    || newLink.profile!==next.profile || newLink.taskId!==next.taskId
    || newLink.owner!=="todoist" || newLink.eventId!==next.eventId
    || newLink.masterEventId!==next.masterEventId
    || newLink.seriesId!==next.seriesId || newLink.activeInstanceId!==next.activeInstanceId
    || !newLink.updatedAt)
    throw new Error("Phase B move destination mapping must be independently verified");
  const incoming={...next,updatedAt:now};
  const destRow=(Key:{pk:string;sk:string},attributes:Record<string,string>)=>({
    Put:{TableName:table,Item:{...incoming,...Key,...attributes},
      ConditionExpression:"attribute_not_exists(pk)"},
  });
  const controls=phaseBNativeMoveControlKeys(stage).map(Key=>({
    Update:{TableName:table,Key,
      UpdateExpression:"SET fencedAt = :now, providerUpdatedAt = :empty REMOVE activeRepair",
      ConditionExpression:"activeRepair = :id",
      ExpressionAttributeValues:{":id":stage.operationId,":now":now,":empty":""}},
  }));
  return [
    {Delete:{TableName:table,
      Key:key(`EVENT#${stage.sourceProfile}#${stage.sourceMasterId}`,"MAP"),
      ...versionedSource(previous)}},
    {Delete:{TableName:table,
      Key:key(`TASK#${stage.sourceProfile}#${stage.taskId}`,"MAP"),
      ...versionedSource(previous)}},
    destRow(key(`EVENT#${stage.destinationProfile}#${stage.successorMasterId}`,"MAP"),
      mappingEventLookupAttributes(incoming)),
    destRow(key(`TASK#${stage.destinationProfile}#${stage.taskId}`,"MAP"),
      mappingLookupAttributes(incoming)),
    {Put:{TableName:table,
      Item:{...incoming,...key(`TASKOWNER#${stage.taskId}`,"MAP"),
        ...mappingOwnerLookupAttributes(incoming)},
      ...versionedSource(previous)}},
    {Delete:{TableName:table,Key:key(`RECURRENCE#${stage.sourceProfile}#${stage.taskId}`),
      ...versionedLink(oldLink)}},
    {Put:{TableName:table,Item:{...newLink,updatedAt:now,
      ...key(`RECURRENCE#${stage.destinationProfile}#${stage.taskId}`),
      ...recurrenceLookupAttributes(newLink)},
      ConditionExpression:"attribute_not_exists(pk)"}},
    {Delete:{TableName:table,Key:phaseBNativeMoveStageKey(stage.taskId),
      ConditionExpression:"operationId = :id AND sourceMappingUpdatedAt = :version AND sourceLinkUpdatedAt = :link",
      ExpressionAttributeValues:{":id":stage.operationId,":version":previous.updatedAt,
        ":link":oldLink.updatedAt}}},
    ...controls,
    {ConditionCheck:{TableName:table,Key:key(`COMPLETED_EVENT#${stage.destinationProfile}#${stage.successorMasterId}`),
      ConditionExpression:"attribute_not_exists(pk)"}},
    ...profiles.filter(p=>p!==stage.sourceProfile&&p!==stage.destinationProfile).map(profile=>({
      ConditionCheck:{TableName:table,
        Key:key(`TASK#${profile}#${stage.taskId}`,"MAP"),
        ConditionExpression:"attribute_not_exists(pk)"},
    })),
  ];
}
