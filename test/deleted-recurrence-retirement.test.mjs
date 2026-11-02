import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";
import { ReviewStore, reviewHash } from "../dist/review-store.js";

const mapping=()=>({profile:"home",taskId:"task-1",eventId:"master-1",
  updatedAt:"2026-10-25T19:00:00Z",recurrenceOwner:"todoist",seriesId:"task-1",
  masterEventId:"master-1",activeInstanceId:"master-1_20261101"});
const link=()=>({profile:"home",owner:"todoist",seriesId:"task-1",taskId:"task-1",
  eventId:"master-1",masterEventId:"master-1",activeInstanceId:"master-1_20261101",
  updatedAt:"2026-10-25T19:00:00Z"});

test("deleted recurrence retirement validates all index versions, series and active occurrence atomically",async()=>{
  const old=documentClient.send;
  let transaction;
  documentClient.send=async(command)=>{
    assert.ok(command instanceof TransactWriteCommand);
    transaction=command.input.TransactItems;
    return {};
  };
  try {
    assert.equal(await new StateRepository().retireDeletedTodoistRecurrenceIfUnchanged(mapping(),link()),true);
    const deletes=transaction.filter(x=>x.Delete).map(x=>x.Delete);
    assert.equal(deletes.length,4);
    assert.deepEqual(deletes.map(x=>x.Key.pk),[
      "EVENT#home#master-1","TASK#home#task-1","TASKOWNER#task-1","RECURRENCE#home#task-1"]);
    for(const item of deletes){
      assert.match(item.ConditionExpression,/updatedAt = :updated/);
      assert.match(item.ConditionExpression,/taskId = :task/);
      assert.match(item.ConditionExpression,/eventId = :event/);
      assert.match(item.ConditionExpression,/seriesId = :series/);
      assert.match(item.ConditionExpression,/activeInstanceId = :activeInstanceId/);
      for(const placeholder of Object.keys(item.ExpressionAttributeValues))
        assert.ok(item.ConditionExpression.includes(placeholder),"unused transaction placeholder "+placeholder);
    }
    const checks=transaction.filter(x=>x.ConditionCheck).map(x=>x.ConditionCheck);
    assert.ok(checks.some(x=>x.Key.pk==="SYNC_CONTROL#home:todoist:task-1"));
    assert.ok(checks.some(x=>x.Key.pk==="SYNC_CONTROL#home:calendar:master-1"));
    assert.ok(checks.some(x=>x.Key.pk==="SYNC_CONTROL#home:calendar:master-1_20261101"));
    assert.ok(checks.some(x=>x.Key.pk==="COMPLETED_EVENT#home#master-1"));
    assert.ok(checks.some(x=>x.Key.pk==="COMPLETED_EVENT#home#master-1_20261101"));
    assert.ok(checks.filter(x=>x.Key.pk.startsWith("SYNC_CONTROL#"))
      .every(x=>x.ConditionExpression.includes("attribute_not_exists(activeRepair)")));
  }finally{documentClient.send=old;}
});

test("recurrence index cleanup rejects link reassignment and conditional-write races",async()=>{
  const old=documentClient.send;
  let writes=0;
  documentClient.send=async(command)=>{
    if(command instanceof TransactWriteCommand) {
      writes++;
      throw Object.assign(new Error("changed owner"),{name:"TransactionCanceledException"});
    }
    throw new Error("unexpected DynamoDB command");
  };
  try {
    const state=new StateRepository();
    assert.equal(await state.retireDeletedTodoistRecurrenceIfUnchanged(mapping(),{...link(),taskId:"another-task"}),false);
    assert.equal(writes,0);
    assert.equal(await state.retireDeletedTodoistRecurrenceIfUnchanged(mapping(),link()),false);
    assert.equal(writes,1);
  }finally{documentClient.send=old;}
});

test("verified deletion resolves only exact open case, tombstones pending decision and removes attributable audit pointer",async()=>{
  const id="incident-dead";
  const auditKey="AUDIT#home#CONFLICT#"+("a".repeat(64))+"#1234";
  const current={id,profile:"home",status:"open",createdAt:"2026-10-25T12:00:00Z",
    updatedAt:"2026-10-25T12:00:01Z",taskId:"task-1",eventId:"master-1",
    reason:"todoist_unmapped_conflict",conflictKey:reviewHash("fingerprint"),sourceAuditKey:auditKey};
  const manual={status:"pending",profile:"home",decisionId:id,createdAt:current.createdAt};
  const audit={pk:auditKey,action:"todoist_snapshot_reconcile_unmapped_conflict",
    createdAt:current.createdAt,detail:{taskId:"task-1",eventId:"master-1"}};
  let tx;
  const review=new ReviewStore({send:async(command)=>{
    if(command instanceof GetCommand){
      if(command.input.Key.pk==="REVIEW_CASE#"+id)return {Item:current};
      if(command.input.Key.pk==="MANUAL#"+id)return {Item:manual};
      if(command.input.Key.pk===auditKey)return {Item:audit};
      if(command.input.Key.pk.startsWith("REVIEW_CONFLICT#"))return {Item:{incidentId:id}};
      return {};
    }
    if(command instanceof TransactWriteCommand){tx=command.input.TransactItems;return {};}
    throw new Error("unexpected operation "+command.constructor.name);
  }});
  const verified={profile:"home",taskIds:["task-1"],eventIds:["master-1"]};
  assert.equal(await review.resolveVerifiedDeletedCase(id,verified),true);
  assert.ok(tx.some(x=>x.Update?.Key.pk==="REVIEW_CASE#"+id
    && x.Update.UpdateExpression.includes("REMOVE decision, taskId, eventId, sourceAuditKey")));
  assert.ok(tx.some(x=>x.Update?.Key.pk==="MANUAL#"+id
    && x.Update.UpdateExpression.includes("REMOVE lookupPk, lookupSk, #context")));
  assert.ok(tx.some(x=>x.Delete?.Key.pk===auditKey));
  assert.ok(tx.some(x=>x.Delete?.Key.pk.startsWith("REVIEW_CONFLICT#")));
  assert.equal(await review.resolveVerifiedDeletedCase(id,{profile:"home",taskIds:["different"],eventIds:["master-1"]}),false);
});
