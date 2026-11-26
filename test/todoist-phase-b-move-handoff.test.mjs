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
  assert.equal(tx.length,5);
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
  assert.equal(itemFor(tx,"TASKOWNER#task-123").length,0);
  assert.equal(itemFor(tx,"RECURRENCE#home#task-123").length,0);
  assert.equal(itemFor(tx,"TASK#antonio#task-123").length,0);
});
test("successful handoff finalizes only transient stage and controls",()=>{
  const f=fixture();
  const tx=phaseBNativeMoveCommitTransaction("state-table",f,stamp);
  const stage=phaseBNativeMoveStage(f);
  assert.equal(tx.length,5);
  for(const pk of ["EVENT#home#source-native","TASK#home#task-123",
    "RECURRENCE#home#task-123",`TASK#work#task-123`,
    `RECURRENCE#work#task-123`,"TASKOWNER#task-123"])
    assert.equal(itemFor(tx,pk).length,0,"provider correlation rows are not transaction state");
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
});
test("stage identity requires the verified provider-correlated native source",()=>{
  const f=fixture();
  assert.throws(()=>phaseBNativeMoveStage({...f,sourceMapping:{...f.sourceMapping,todoistPhaseBVersion:undefined}}));
  assert.throws(()=>phaseBNativeMoveStage({...f,sourceLink:{...f.sourceLink,owner:"calendar"}}));
});
