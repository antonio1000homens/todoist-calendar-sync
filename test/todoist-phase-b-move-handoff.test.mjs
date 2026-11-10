import assert from "node:assert/strict";
import test from "node:test";
import {
  phaseBNativeMoveStage,phaseBNativeMoveStageKey,
  phaseBNativeMoveBeginTransaction,phaseBNativeMoveCommitTransaction,
} from "../dist/todoist-phase-b-move-handoff.js";

const stamp="2027-03-01T12:00:00.000Z",sourceMasterId="source-native",
  destinationMasterId="0123456789abcdef0123456789abcdef";
const plan={
  taskId:"task-123",sourceProfile:"home",destinationProfile:"work",
  sourceMasterId,sourceEtag:"source-etag-1",successorMasterId:destinationMasterId,
  originalAnchor:"2027-01-10",sourceRule:"RRULE:FREQ=MONTHLY;INTERVAL=3",
  historyRule:"RRULE:FREQ=MONTHLY;INTERVAL=3;UNTIL=20270110",
  historicalLastOccurrence:"2027-01-10",destinationStart:"2027-04-10",
  destinationRule:"RRULE:FREQ=MONTHLY;INTERVAL=3",
  firstThreeDestinationOccurrences:["2027-04-10","2027-07-10","2027-10-10"],
  historyTaskId:"task-123",
};
function fixture(){
  const sourceMapping={profile:"home",taskId:plan.taskId,eventId:sourceMasterId,
    masterEventId:sourceMasterId,seriesId:plan.taskId,recurrenceOwner:"todoist",
    todoistPhaseBVersion:1,activeInstanceId:"current-april",
    originalStart:"2027-04-10",activeEffectiveStart:"2027-04-10",updatedAt:"source-map-v1"};
  const sourceLink={profile:"home",owner:"todoist",taskId:plan.taskId,eventId:sourceMasterId,
    masterEventId:sourceMasterId,seriesId:plan.taskId,activeInstanceId:"current-april",
    originalStart:"2027-04-10",activeEffectiveStart:"2027-04-10",updatedAt:"source-link-v1"};
  const destinationMapping={...sourceMapping,profile:"work",eventId:destinationMasterId,
    masterEventId:destinationMasterId,activeInstanceId:"destination-april",
    projectId:"destination-work-project",updatedAt:stamp};
  const destinationLink={...sourceLink,profile:"work",eventId:destinationMasterId,
    masterEventId:destinationMasterId,activeInstanceId:"destination-april",updatedAt:stamp};
  return {plan,sourceMapping,sourceLink,destinationMapping,destinationLink};
}
function key(item){return item?.Put?.Item?.pk||item?.Put?.Item?.pk
  ||item?.Delete?.Key?.pk||item?.Update?.Key?.pk||item?.ConditionCheck?.Key?.pk;}
function itemFor(tx,pk){return tx.filter(x=>key(x)===pk);}
test("stage atomically claims exact task+master controls on both profiles before provider mutation",()=>{
  const f=fixture();
  const tx=phaseBNativeMoveBeginTransaction("state-table",f,stamp);
  const stage=phaseBNativeMoveStage(f);
  assert.match(stage.operationId,/^phase-b-move-[a-f0-9]{32}$/);
  assert.deepEqual(phaseBNativeMoveStage(f),stage);
  assert.equal(phaseBNativeMoveStageKey(f.plan.taskId).pk,"PHASE_B_NATIVE_MOVE#task-123");
  assert.equal(tx[0].Put.Item.pk,phaseBNativeMoveStageKey(f.plan.taskId).pk);
  assert.equal(tx[0].Put.ConditionExpression,"attribute_not_exists(pk)");
  assert.equal(tx.length,10);
  for(const pk of [
    "SYNC_CONTROL#home:todoist:task-123",
    "SYNC_CONTROL#home:calendar:source-native",
    "SYNC_CONTROL#work:todoist:task-123",
    `SYNC_CONTROL#work:calendar:${destinationMasterId}`,
  ]){
    const [update]=itemFor(tx,pk);
    assert.equal(update.Update.ExpressionAttributeValues[":id"],stage.operationId);
    assert.match(update.Update.ConditionExpression,/attribute_not_exists\(activeRepair\)/);
  }
  assert.equal(itemFor(tx,"TASKOWNER#task-123")[0].ConditionCheck.ExpressionAttributeValues[":updated"],"source-map-v1");
  assert.equal(itemFor(tx,"RECURRENCE#home#task-123")[0].ConditionCheck.ExpressionAttributeValues[":updated"],"source-link-v1");
  assert.equal(itemFor(tx,"TASK#antonio#task-123")[0].ConditionCheck.ConditionExpression,"attribute_not_exists(pk)");
});
test("successful handoff CASes all six indexes and releases stage/fences atomically",()=>{
  const f=fixture();
  const tx=phaseBNativeMoveCommitTransaction("state-table",f,stamp);
  const stage=phaseBNativeMoveStage(f);
  assert.equal(tx.length,14);
  for(const pk of ["EVENT#home#source-native","TASK#home#task-123",
    "RECURRENCE#home#task-123"]){
    const [item]=itemFor(tx,pk);
    assert.ok(item.Delete,"old source indexed relationship is removed");
    assert.equal(item.Delete.ExpressionAttributeValues[":updated"],
      pk.startsWith("RECURRENCE")?"source-link-v1":"source-map-v1");
  }
  for(const pk of [
    `EVENT#work#${destinationMasterId}`,"TASK#work#task-123",
    `RECURRENCE#work#task-123`]){
    const [row]=itemFor(tx,pk);
    assert.equal(row.Put.ConditionExpression,"attribute_not_exists(pk)");
    assert.equal(row.Put.Item.profile,"work");
    assert.equal(row.Put.Item.todoistPhaseBVersion,
      pk.startsWith("RECURRENCE")?undefined:1);
  }
  const [owner]=itemFor(tx,"TASKOWNER#task-123");
  assert.ok(owner.Put);
  assert.equal(owner.Put.Item.profile,"work");
  assert.equal(owner.Put.Item.masterEventId,destinationMasterId);
  assert.equal(owner.Put.ExpressionAttributeValues[":updated"],"source-map-v1");
  const [receipt]=itemFor(tx,"PHASE_B_NATIVE_MOVE#task-123");
  assert.ok(receipt.Delete);
  assert.equal(receipt.Delete.ExpressionAttributeValues[":id"],stage.operationId);
  for(const pk of [
    "SYNC_CONTROL#home:todoist:task-123",
    "SYNC_CONTROL#home:calendar:source-native",
    "SYNC_CONTROL#work:todoist:task-123",
    `SYNC_CONTROL#work:calendar:${destinationMasterId}`,
  ]){
    const [update]=itemFor(tx,pk);
    assert.match(update.Update.UpdateExpression,/REMOVE activeRepair$/);
    assert.equal(update.Update.ExpressionAttributeValues[":id"],stage.operationId);
  }
  assert.equal(itemFor(tx,"COMPLETED_EVENT#home#source-native").length,0,
    "completed source history must never be purged by cross-profile transfer");
  assert.equal(itemFor(tx,`COMPLETED_EVENT#work#${destinationMasterId}`)[0]
    .ConditionCheck.ConditionExpression,"attribute_not_exists(pk)");
});
test("all mutations are refused for mismatched destination identity or missing native markers",()=>{
  const f=fixture();
  for(const mapping of [
    {...f.destinationMapping,profile:"home"},
    {...f.destinationMapping,eventId:"other"},
    {...f.destinationMapping,masterEventId:"other"},
    {...f.destinationMapping,recurrenceOwner:"calendar"},
    {...f.destinationMapping,todoistPhaseBVersion:undefined},
    {...f.destinationMapping,originalStart:"2027-07-10"},
    {...f.destinationMapping,activeInstanceId:undefined},
  ])assert.throws(()=>phaseBNativeMoveCommitTransaction("table",{...f,destinationMapping:mapping},stamp));
  assert.throws(()=>phaseBNativeMoveStage({...f,sourceMapping:{...f.sourceMapping,todoistPhaseBVersion:undefined}}));
  assert.throws(()=>phaseBNativeMoveStage({...f,sourceLink:{...f.sourceLink,owner:"calendar"}}));
});
