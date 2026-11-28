import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";

const base={profile:"home",taskId:"task-1",eventId:"event-1",updatedAt:"2026-11-28T10:00:00.000Z"};

test("verified pair purge removes only exact operational rows with observed versions",async()=>{
  const old=documentClient.send;let transaction;const readKeys=[];
  const rows=new Map([
    ["TASK#home#task-1",{...base,pk:"TASK#home#task-1",sk:"MAP"}],
    ["TASKOWNER#task-1",{...base,pk:"TASKOWNER#task-1",sk:"MAP"}],
    ["EVENT#home#event-1",{...base,pk:"EVENT#home#event-1",sk:"MAP"}],
    ["EVENT#home#master-1",{...base,eventId:"master-1",pk:"EVENT#home#master-1",sk:"MAP"}],
    ["RECURRENCE#home#series-1",{...base,seriesId:"series-1",owner:"calendar",pk:"RECURRENCE#home#series-1",sk:"STATE"}],
    ["BASELINE#home#TASK#task-1",{...base,baseline:{todoist:{},calendar:{}},pk:"BASELINE#home#TASK#task-1",sk:"RECONCILE"}],
    ["VERSION#TASK#task-1",{sourceUpdatedAt:"2026-11-28T10:00:00.000Z",updatedAt:base.updatedAt,pk:"VERSION#TASK#task-1",sk:"STATE"}],
    ["ANNUAL_RECOVERY#home#task-1",{profile:"home",taskId:"task-1",oldEventId:"event-1",operationId:"repair-1",sourceUpdatedAt:base.updatedAt,status:"pending",pk:"ANNUAL_RECOVERY#home#task-1",sk:"STATE"}],
    ["FUTURE_SPLIT#TASK#task-1",{profile:"home",taskId:"task-1",oldMasterId:"master-1",newMasterId:"event-1",status:"completed",pk:"FUTURE_SPLIT#TASK#task-1",sk:"STATE"}],
    ["CANONICAL#home#todoist#task-1",{profile:"home",side:"todoist",providerId:"task-1",identity:{id:"task-1"},updatedAt:base.updatedAt,pk:"CANONICAL#home#todoist#task-1",sk:"STATE"}],
    ["CANONICAL#home#calendar#event-1",{profile:"home",side:"calendar",providerId:"event-1",identity:{id:"event-1"},updatedAt:base.updatedAt,pk:"CANONICAL#home#calendar#event-1",sk:"STATE"}],
    ["TASK#home#unrelated-task",{profile:"home",taskId:"unrelated-task",eventId:"unrelated-event",pk:"TASK#home#unrelated-task",sk:"MAP"}],
    ["TASKOWNER#unrelated-task",{profile:"home",taskId:"unrelated-task",eventId:"unrelated-event",pk:"TASKOWNER#unrelated-task",sk:"MAP"}],
    ["EVENT#home#unrelated-event",{profile:"home",taskId:"unrelated-task",eventId:"unrelated-event",pk:"EVENT#home#unrelated-event",sk:"MAP"}],
    ["TASK#work#unrelated-task",{profile:"work",taskId:"unrelated-task",eventId:"work-event",pk:"TASK#work#unrelated-task",sk:"MAP"}],
    ["COMPLETED_EVENT#home#event-1",{profile:"home",taskId:"task-1",eventId:"event-1",pk:"COMPLETED_EVENT#home#event-1",sk:"STATE"}],
    ["AUDIT#delivery-1",{taskId:"task-1",pk:"AUDIT#delivery-1",sk:"STATE"}],
    ["DELIVERY#delivery-1",{taskId:"task-1",pk:"DELIVERY#delivery-1",sk:"COMPLETED"}],
  ]);
  documentClient.send=async command=>{
    if(command instanceof GetCommand){readKeys.push(command.input.Key.pk);return {Item:rows.get(command.input.Key.pk)};}
    if(command instanceof TransactWriteCommand){
      transaction=command.input.TransactItems;
      for(const item of transaction)if(item.Delete)rows.delete(item.Delete.Key.pk);
      return {};
    }
    throw new Error("unexpected DynamoDB command");
  };
  try {
    assert.equal(await new StateRepository().purgeDeletedPair({profile:"home",taskId:"task-1",eventIds:["event-1","master-1"],seriesIds:["series-1"]}),true);
    assert.equal(transaction.length,11,"all mapping families, task-scoped recovery records and the second event index are deleted atomically");
    const deleted=transaction.map(item=>item.Delete);
    assert.ok(deleted.every(Boolean));
    assert.ok(deleted.every(item=>item.ConditionExpression.includes("#a0 = :v0")));
    for(const item of deleted) {
      const placeholders=Object.keys(item.ExpressionAttributeValues);
      assert.ok(placeholders.every(value=>item.ConditionExpression.includes(value)));
    }
    assert.equal(new Set(readKeys).size,readKeys.length,"cleanup uses only exact strongly-consistent keys");
    for(const pk of ["TASK#home#task-1","TASKOWNER#task-1","EVENT#home#event-1","EVENT#home#master-1",
      "RECURRENCE#home#series-1","BASELINE#home#TASK#task-1","VERSION#TASK#task-1",
      "ANNUAL_RECOVERY#home#task-1","FUTURE_SPLIT#TASK#task-1",
      "CANONICAL#home#todoist#task-1","CANONICAL#home#calendar#event-1"])
      assert.equal(rows.has(pk),false,`${pk} is gone after cleanup`);
    for(const pk of ["TASK#home#unrelated-task","TASKOWNER#unrelated-task","EVENT#home#unrelated-event",
      "TASK#work#unrelated-task","COMPLETED_EVENT#home#event-1","AUDIT#delivery-1","DELIVERY#delivery-1"])
      assert.equal(rows.has(pk),true,`${pk} is preserved`);
  } finally {documentClient.send=old;}
});

test("verified pair purge refuses newer or unrelated references and reports transaction races",async()=>{
  const old=documentClient.send;let writes=0;
  documentClient.send=async command=>{
    if(command instanceof GetCommand) {
      const pk=command.input.Key.pk;
      if(pk==="TASK#home#task-1")return {Item:{...base,eventId:"successor-event",pk}};
      return {};
    }
    if(command instanceof TransactWriteCommand){writes++;throw Object.assign(new Error("conditional race"),{name:"TransactionCanceledException"});}
    throw new Error("unexpected DynamoDB command");
  };
  try {
    const state=new StateRepository();
    assert.equal(await state.purgeDeletedPair({profile:"home",taskId:"task-1",eventIds:["event-1"]}),false);
    assert.equal(writes,0,"a newer mapping must not be deleted");
    documentClient.send=async command=>{
      if(command instanceof GetCommand) {
        const pk=command.input.Key.pk;
        return pk==="EVENT#home#event-1"?{Item:{...base,pk}}:{};
      }
      if(command instanceof TransactWriteCommand){writes++;throw Object.assign(new Error("conditional race"),{name:"TransactionCanceledException"});}
      throw new Error("unexpected DynamoDB command");
    };
    assert.equal(await state.purgeDeletedPair({profile:"home",taskId:"task-1",eventIds:["event-1"]}),false);
    assert.equal(writes,1,"a concurrent update must surface as incomplete cleanup");
  } finally {documentClient.send=old;}
});
