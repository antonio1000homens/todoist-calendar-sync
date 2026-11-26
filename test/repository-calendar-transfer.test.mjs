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

test("exact one-off mapping deletion conditions all three indexes on the previewed version",async t=>{
  const mapping={profile:"home",taskId:"duplicate-task",eventId:"duplicate-event",updatedAt:"2026-10-24T12:00:00.000Z"};
  let transaction;
  t.mock.method(documentClient,"send",async command=>{transaction=command.input.TransactItems;return {};});
  assert.equal(await new StateRepository().deleteMappingIfUnchanged(mapping),true);
  assert.equal(transaction.length,3);
  assert.deepEqual(transaction.map(item=>Object.values(item)[0].Key.pk).sort(),[
    "EVENT#home#duplicate-event","TASK#home#duplicate-task","TASKOWNER#duplicate-task",
  ]);
  for(const item of transaction) {
    const deletion=Object.values(item)[0];
    assert.match(deletion.ConditionExpression,/updatedAt = :updated/);
    assert.match(deletion.ConditionExpression,/attribute_not_exists\(seriesId\)/);
  }
});

test("exact one-off mapping cleanup refuses a partial index set rather than erasing newer ownership",async t=>{
  const mapping={profile:"home",taskId:"duplicate-task",eventId:"duplicate-event",updatedAt:"2026-10-24T12:00:00.000Z"};
  t.mock.method(documentClient,"send",async command=>{
    if(command.input.TransactItems) throw Object.assign(new Error("stale mapping"),{name:"TransactionCanceledException"});
    return command.input.Key.pk==="EVENT#home#duplicate-event"?{Item:{pk:"EVENT#home#duplicate-event",taskId:"other-task"}}:{};
  });
  assert.equal(await new StateRepository().deleteMappingIfUnchanged(mapping),false);
});

test("migration retires exact DynamoDB correlation rows and its matching recurrence link atomically",async t=>{
  const mapping={profile:"home",taskId:"legacy-task",eventId:"legacy-event",projectId:"todoist-project",
    recurrenceOwner:"calendar",seriesId:"birthday-series",masterEventId:"legacy-master",
    activeInstanceId:"legacy-event",updatedAt:"2026-10-24T12:00:00.000Z"};
  const link={profile:"home",owner:"calendar",seriesId:mapping.seriesId,taskId:mapping.taskId,
    eventId:mapping.eventId,masterEventId:mapping.masterEventId,activeInstanceId:mapping.activeInstanceId,
    updatedAt:"2026-10-24T12:00:01.000Z"};
  const rows=new Map([
    [`EVENT#home#${mapping.eventId}`,{...mapping,pk:`EVENT#home#${mapping.eventId}`,sk:"MAP"}],
    [`TASK#home#${mapping.taskId}`,{...mapping,pk:`TASK#home#${mapping.taskId}`,sk:"MAP"}],
    [`TASKOWNER#${mapping.taskId}`,{...mapping,pk:`TASKOWNER#${mapping.taskId}`,sk:"MAP"}],
    [`RECURRENCE#home#${mapping.seriesId}`,{...link,pk:`RECURRENCE#home#${mapping.seriesId}`,sk:"STATE"}],
  ]);
  let transaction;
  t.mock.method(documentClient,"send",async command=>{
    if(command.input.Key)return {Item:rows.get(command.input.Key.pk)};
    if(command.input.TransactItems){transaction=command.input.TransactItems;return {};}
    assert.fail(`Unexpected DynamoDB request ${JSON.stringify(command.input)}`);
  });

  assert.equal(await new StateRepository().retireMigratedMappingCorrelation(mapping),true);
  assert.equal(transaction.length,4);
  assert.deepEqual(transaction.map(item=>Object.values(item)[0].Key.pk).sort(),[
    `EVENT#home#${mapping.eventId}`,`RECURRENCE#home#${mapping.seriesId}`,
    `TASK#home#${mapping.taskId}`,`TASKOWNER#${mapping.taskId}`,
  ]);
  assert.ok(transaction.every(item=>Object.values(item)[0].ConditionExpression));
});

test("migration preserves changed mapping indexes and conflicting cross-profile task ownership",async t=>{
  const mapping={profile:"home",taskId:"legacy-task",eventId:"legacy-event",updatedAt:"2026-10-24T12:00:00.000Z"};
  let transactions=0;
  t.mock.method(documentClient,"send",async command=>{
    if(command.input.TransactItems){transactions++;return {};}
    if(command.input.Key.pk===`TASKOWNER#${mapping.taskId}`)
      return {Item:{profile:"work",taskId:mapping.taskId,eventId:"other-event",updatedAt:mapping.updatedAt}};
    if(command.input.Key.pk===`TASK#home#${mapping.taskId}`)
      return {Item:{profile:"home",taskId:mapping.taskId,eventId:mapping.eventId,updatedAt:"newer-version"}};
    return {};
  });

  assert.equal(await new StateRepository().retireMigratedMappingCorrelation(mapping),false);
  assert.equal(transactions,0);
});

test("completed projection transaction annotates the actual DynamoDB failure",async t=>{
  const error=Object.assign(new Error("not authorized"),{name:"AccessDeniedException"});
  t.mock.method(documentClient,"send",async()=>{throw error;});
  await assert.rejects(()=>new StateRepository().putCompletedCalendarProjection({
    profile:"home",taskId:"task-510",eventId:"event-510",completedAt:"2026-10-20T12:00:00.000Z",
  }),caught=>caught===error);
  assert.equal(error.providerAction,"dynamodb:TransactWriteItems");
  assert.equal(error.providerSubAction,"dynamodb:ConditionCheckItem");
});
