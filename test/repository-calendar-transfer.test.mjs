import assert from "node:assert/strict";
import test from "node:test";
import { StateRepository } from "../dist/repository.js";
import { documentClient } from "../dist/dynamodb-capacity.js";

process.env.STATE_TABLE_NAME ||= "test-state";

function transferFixture() {
  const previous={profile:"home",taskId:"old-task",eventId:"active",projectId:"todoist-project",recurrenceOwner:"calendar",
    seriesId:"birthday-series",masterEventId:"master",activeInstanceId:"active",updatedAt:"2026-10-22T12:00:00.000Z"};
  const expectedLink={profile:"home",owner:"calendar",seriesId:"birthday-series",taskId:"old-task",eventId:"active",
    masterEventId:"master",activeInstanceId:"active",updatedAt:"2026-10-22T12:00:01.000Z"};
  const mapping={profile:"home",taskId:"annual-task",eventId:"active",projectId:"todoist-project",recurrenceOwner:"calendar",
    seriesId:"birthday-series",masterEventId:"master",activeInstanceId:"active",updatedAt:"2026-10-23T12:00:00.000Z"};
  const link={...expectedLink,taskId:"annual-task",updatedAt:"2026-10-23T12:00:01.000Z"};
  return {previous,expectedLink,mapping,link};
}

test("Calendar series ownership transfer atomically replaces the event, task, owner, and recurrence indexes",async t=>{
  const f=transferFixture();let transaction;
  t.mock.method(documentClient,"send",async command=>{
    const input=command.input;
    if(input.TransactItems){transaction=input.TransactItems;return {};}
    if(input.Key?.pk==="TASK#home#annual-task")return {};
    if(input.Key?.pk==="RECURRENCE#home#birthday-series")return {Item:f.expectedLink};
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(input)}`);
  });
  const result=await new StateRepository().transferCalendarSeriesMapping(f);
  assert.equal(result,true);
  const keys=transaction.flatMap(item=>Object.values(item).map(operation=>`${operation.Key?.pk||operation.Item?.pk}|${operation.Key?.sk||operation.Item?.sk||""}`));
  assert.equal(new Set(keys).size,keys.length,"the transaction contains no duplicate DynamoDB item operations");
  assert.ok(transaction.some(item=>item.Put?.Item.pk==="EVENT#home#active"&&item.Put.Item.taskId==="annual-task"));
  assert.ok(transaction.some(item=>item.Delete?.Key.pk==="TASK#home#old-task"&&/updatedAt = :oldUpdated/.test(item.Delete.ConditionExpression)));
  assert.ok(transaction.some(item=>item.Delete?.Key.pk==="TASKOWNER#old-task"));
  assert.ok(transaction.some(item=>item.Put?.Item.pk==="TASK#home#annual-task"&&item.Put.Item.eventId==="active"));
  assert.ok(transaction.some(item=>item.Put?.Item.pk==="TASKOWNER#annual-task"&&item.Put.Item.eventId==="active"));
  assert.ok(transaction.some(item=>item.Put?.Item.pk==="RECURRENCE#home#birthday-series"&&item.Put.Item.taskId==="annual-task"
    &&/updatedAt = :oldLinkUpdated/.test(item.Put.ConditionExpression)));
});

test("conditional transfer conflict returns false without treating a cancellation as success",async t=>{
  const f=transferFixture();
  t.mock.method(documentClient,"send",async command=>{
    if(command.input.TransactItems)throw Object.assign(new Error("conditional conflict"),{
      name:"TransactionCanceledException",CancellationReasons:[{Code:"ConditionalCheckFailed"},{Code:"None"}],
    });
    if(command.input.Key?.pk==="TASK#home#annual-task")return {};
    if(command.input.Key?.pk==="RECURRENCE#home#birthday-series")return {Item:f.expectedLink};
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(command.input)}`);
  });
  assert.equal(await new StateRepository().transferCalendarSeriesMapping(f),false);
});

test("Calendar series mapping repair atomically restores missing indexes for its existing owner",async t=>{
  const f=transferFixture();
  const expectedLink={...f.expectedLink,taskId:f.mapping.taskId};
  const mapping={...f.mapping};
  const link={...f.link};
  let transaction;
  t.mock.method(documentClient,"send",async command=>{
    const input=command.input;
    if(input.TransactItems){transaction=input.TransactItems;return {};}
    if(input.Key?.pk===`TASK#home#${mapping.taskId}`)return {};
    if(input.Key?.pk===`RECURRENCE#home#${mapping.seriesId}`)return {Item:expectedLink};
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(input)}`);
  });

  const result=await new StateRepository().transferCalendarSeriesMapping({expectedLink,mapping,link});
  assert.equal(result,true);
  assert.equal(transaction.filter(item=>item.Delete).length,0,"repair must not delete a displaced task or history row");
  for(const prefix of ["EVENT#home#active","TASK#home#annual-task","TASKOWNER#annual-task"]) {
    assert.ok(transaction.some(item=>item.Put?.Item.pk===prefix),`transaction restores ${prefix}`);
  }
  const recurrencePut=transaction.find(item=>item.Put?.Item.pk==="RECURRENCE#home#birthday-series").Put;
  assert.match(recurrencePut.ConditionExpression,/taskId = :oldTask/);
  assert.match(recurrencePut.ConditionExpression,/#masterEvent/);
  assert.match(recurrencePut.ConditionExpression,/#activeInstance/);
  assert.match(recurrencePut.ConditionExpression,/updatedAt = :oldLinkUpdated/);
  assert.equal(recurrencePut.ExpressionAttributeValues[":oldTask"],mapping.taskId);
});
