import assert from "node:assert/strict";
import test from "node:test";
import { ReviewStore } from "../dist/review-store.js";
import { documentClient } from "../dist/dynamodb-capacity.js";

process.env.STATE_TABLE_NAME ||= "test-state";
const operation = () => ({ id:"repair",status:"running",steps:{},preview:{intent:{caseId:"case",profile:"home",action:"create"}} });
const releases = () => [
  {ref:{profile:"home",side:"calendar",id:"missing"}},
  {ref:{profile:"home",side:"todoist",id:"task"},providerUpdatedAt:"2026-10-21T15:00:00Z",clearExclusion:true},
];

test("successful repair result, case resolution, and every barrier release share one transaction", async t => {
  const store = new ReviewStore(), commands=[];
  store.getCase = async () => ({id:"case",createdAt:"2026-10-21T12:00:00Z"});
  t.mock.method(documentClient,"send",async command => { commands.push(command); return {}; });
  const result = await store.finalizeOperation(operation(),releases());
  assert.equal(result.status,"succeeded"); assert.equal(result.notificationPending,true);
  assert.equal(commands.length,1); assert.equal(commands[0].constructor.name,"TransactWriteCommand");
  const items = commands[0].input.TransactItems;
  assert.equal(items.length,4);
  assert.deepEqual(items.slice(0,2).map(item=>item.Update.Key.pk),["SYNC_CONTROL#home:calendar:missing","SYNC_CONTROL#home:todoist:task"]);
  assert.ok(items.slice(0,2).every(item=>item.Update.ConditionExpression === "activeRepair = :id"));
  assert.equal(items[0].Update.ExpressionAttributeValues[":now"],items[1].Update.ExpressionAttributeValues[":now"]);
  assert.match(items[1].Update.UpdateExpression,/excluded = :false/);
  assert.equal(items[2].Put.Item.status,"succeeded");
  assert.equal(items[2].Put.Item.lookupSk,"REPAIR#NOTIFY#repair");
  assert.equal(items[3].Update.ExpressionAttributeValues[":status"],"resolved");
});

test("transaction failure performs no separate release or terminal-result write",async t=>{
  const store = new ReviewStore(),commands=[];
  store.getCase=async()=>({id:"case",createdAt:"2026-10-21"});
  store.getOperation=async()=>operation();
  t.mock.method(documentClient,"send",async command=>{commands.push(command);throw new Error("Transaction cancelled");});
  await assert.rejects(store.finalizeOperation(operation(),releases()),/Transaction cancelled/);
  assert.deepEqual(commands.map(command=>command.constructor.name),["TransactWriteCommand"]);
});

test("a lost finalization response returns the durably committed success",async t=>{
  const store=new ReviewStore(); let committed;
  store.getCase=async()=>({id:"case",createdAt:"2026-10-21"});
  store.getOperation=async()=>committed;
  t.mock.method(documentClient,"send",async command=>{
    committed=command.input.TransactItems.find(item=>item.Put)?.Put.Item;
    throw new Error("Response lost after commit");
  });
  const result=await store.finalizeOperation(operation(),releases());
  assert.equal(result.status,"succeeded"); assert.equal(result.notificationPending,true);
});

test("saving stale failure state cannot overwrite an atomically completed repair",async t=>{
  const commands=[];
  t.mock.method(documentClient,"send",async command=>{commands.push(command.input);return {};});
  await new ReviewStore().saveOperation({...operation(),status:"needs_review"});
  assert.match(commands[0].ConditionExpression,/#status <> :succeeded/);
  assert.equal(commands[0].Item.status,"needs_review");
  assert.equal(commands[0].ExpressionAttributeValues[":succeeded"],"succeeded");
});

test("a previously dismissed alert can enter an explicit repair without losing its history",async t=>{
  const commands=[];
  const store=new ReviewStore();
  store.getCase=async()=>({id:"case",status:"dismissed",createdAt:"2026-10-21T12:00:00Z",operationId:""});
  t.mock.method(documentClient,"send",async command=>{commands.push(command);return {};});
  await store.updateCase("case","repairing","Repair in progress","repair-1");
  const command=commands[0].input;
  assert.match(command.ConditionExpression,/#s = :dismissed/);
  assert.equal(command.ExpressionAttributeValues[":empty"],"");
  assert.equal(command.ExpressionAttributeValues[":op"],"repair-1");
});
