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

test("mapped Todoist-owned series transfer conditionally removes its old master index and recurrence link",async t=>{
  const f=transferFixture();
  const replaced={profile:"home",taskId:"annual-task",eventId:"old-master",projectId:"todoist-project",
    recurrenceOwner:"todoist",seriesId:"annual-task",masterEventId:"old-master",activeInstanceId:"old-occurrence",updatedAt:"old-map-version"};
  const replacedLink={profile:"home",owner:"todoist",seriesId:"annual-task",taskId:"annual-task",eventId:"old-master",
    masterEventId:"old-master",activeInstanceId:"old-occurrence",updatedAt:"old-link-version"};
  let transaction;
  t.mock.method(documentClient,"send",async command=>{
    const input=command.input;
    if(input.TransactItems){transaction=input.TransactItems;return {};}
    if(input.Key?.pk==="TASK#home#annual-task")return {Item:replaced};
    if(input.Key?.pk==="RECURRENCE#home#birthday-series")return {Item:f.expectedLink};
    if(input.Key?.pk==="RECURRENCE#home#annual-task")return {Item:replacedLink};
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(input)}`);
  });
  assert.equal(await new StateRepository().transferCalendarSeriesMapping({...f,replaced,replacedLink}),true);
  const operations=transaction.flatMap(item=>Object.entries(item).map(([kind,operation])=>({kind,...operation})));
  const sourceEventDelete=operations.find(item=>item.kind==="Delete"&&item.Key.pk==="EVENT#home#old-master");
  assert.match(sourceEventDelete.ConditionExpression,/updatedAt = :oldUpdated/);
  assert.match(sourceEventDelete.ConditionExpression,/recurrenceOwner = :oldOwner/);
  assert.ok(operations.some(item=>item.kind==="Delete"&&item.Key.pk==="RECURRENCE#home#annual-task"
    &&item.ConditionExpression.includes("updatedAt = :updated")));
  for(const key of ["TASK#home#annual-task","TASKOWNER#annual-task"]) {
    const put=operations.find(item=>item.kind==="Put"&&item.Item.pk===key);
    assert.equal(put.Item.eventId,"active");
    assert.match(put.ConditionExpression,/oldUpdated/,"existing task indexes are replaced conditionally");
  }
  assert.ok(operations.some(item=>item.kind==="Put"&&item.Item.pk==="RECURRENCE#home#birthday-series"));
  assert.equal(new Set(operations.map(item=>`${item.kind}:${item.Key?.pk||item.Item?.pk}`)).size,operations.length,
    "every transaction row has one unique key operation");
});

test("mapped transfer aborts without a transaction when its source recurrence version is stale",async t=>{
  const f=transferFixture();
  const replaced={profile:"home",taskId:"annual-task",eventId:"old-master",recurrenceOwner:"todoist",seriesId:"annual-task",
    masterEventId:"old-master",activeInstanceId:"old-occurrence",updatedAt:"old-map-version"};
  const replacedLink={profile:"home",owner:"todoist",seriesId:"annual-task",taskId:"annual-task",eventId:"old-master",
    masterEventId:"old-master",activeInstanceId:"old-occurrence",updatedAt:"preview-link-version"};
  let transactionCount=0;
  t.mock.method(documentClient,"send",async command=>{
    const input=command.input;
    if(input.TransactItems){transactionCount++;return {};}
    if(input.Key?.pk==="TASK#home#annual-task")return {Item:replaced};
    if(input.Key?.pk==="RECURRENCE#home#birthday-series")return {Item:f.expectedLink};
    if(input.Key?.pk==="RECURRENCE#home#annual-task")return {Item:{...replacedLink,updatedAt:"new-live-link-version"}};
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(input)}`);
  });
  assert.equal(await new StateRepository().transferCalendarSeriesMapping({...f,replaced,replacedLink}),false);
  assert.equal(transactionCount,0,"stale source link prevents every mapping write");
});

test("mapped transfer recognizes a committed transaction after its acknowledgement is lost",async t=>{
  const f=transferFixture(), replaced={profile:"home",taskId:"annual-task",eventId:"old-master",recurrenceOwner:"todoist",
    seriesId:"annual-task",masterEventId:"old-master",activeInstanceId:"old-occurrence",updatedAt:"old-map-version"};
  const replacedLink={profile:"home",owner:"todoist",seriesId:"annual-task",taskId:"annual-task",eventId:"old-master",
    masterEventId:"old-master",activeInstanceId:"old-occurrence",updatedAt:"old-link-version"};
  let transactionCount=0;
  t.mock.method(documentClient,"send",async command=>{
    const pk=command.input.Key?.pk;
    if(command.input.TransactItems){transactionCount++;return {};}
    if(pk===`TASK#home#${f.mapping.taskId}`||pk===`EVENT#home#${f.mapping.eventId}`||pk===`TASKOWNER#${f.mapping.taskId}`) return {Item:f.mapping};
    if(pk===`RECURRENCE#home#${f.mapping.seriesId}`) return {Item:f.link};
    if(pk===`EVENT#home#${replaced.eventId}`||pk===`RECURRENCE#home#${replacedLink.seriesId}`) return {};
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(command.input)}`);
  });
  assert.equal(await new StateRepository().transferCalendarSeriesMapping({...f,replaced,replacedLink}),true);
  assert.equal(transactionCount,0,"readback proves the atomic replacement already committed");
});
