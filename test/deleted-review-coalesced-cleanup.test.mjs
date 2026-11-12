import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand,QueryCommand,ScanCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {ReviewStore} from "../dist/review-store.js";

const profile="home",parentId="home-deleted-pair",fingerprint="f".repeat(64);
const prefix="REVIEW_CONFLICT#"+profile+"#"+fingerprint;
const primary={id:parentId,profile,status:"open",title:"Conflict",reason:"todoist_unmapped_conflict",
  taskId:"task-dead",eventId:"event-dead",conflictKey:fingerprint,
  createdAt:"2026-10-25T00:00:00Z",updatedAt:"2026-10-25T00:01:00Z"};
const sibling=(id,changes={})=>({
  id,profile,status:"dismissed",title:"Old conflict",reason:"calendar_snapshot_recurring_identity_conflict",
  taskId:"task-dead",eventId:"event-dead",coalescedInto:parentId,conflictKey:fingerprint,
  sourceAuditKey:"AUDIT#home#"+id,createdAt:"2026-10-25T00:00:00Z",
  updatedAt:"2026-10-25T00:01:00Z",...changes,
});
const pointer=id=>({pk:prefix,sk:"INCIDENT#"+id,profile,conflictKey:fingerprint,incidentId:id});
const audit=(id,detail={taskId:"task-dead",eventId:"event-dead"})=>({
  action:"calendar_snapshot_recurring_identity_conflict",createdAt:"2026-10-25T00:00:00Z",
  detail,
});

function fixture({child=sibling("incident-closed"),other,invalidPointer=false,race=false}={}){
  const auditPk=child?.sourceAuditKey;
  const records=new Map([
    ["REVIEW_CASE#"+parentId,primary],
    ...(child?[["REVIEW_CASE#"+child.id,child]]:[]),
    ...(auditPk?[ [auditPk,audit(child.id)] ]:[]),
    ...(other?[["REVIEW_CASE#"+other.id,other],
      [other.sourceAuditKey,audit(other.id,{taskId:"task-dead",eventId:"live-other"})]]:[]),
  ]);
  const points=[
    ...(child?[pointer(child.id)]:[]),
    ...(other?[pointer(other.id)]:[]),
  ];
  if(invalidPointer)points.push({...pointer("incident-wrong"),profile:"work"});
  let tx,queries=0;
  const store=new ReviewStore({send:async command=>{
    if(command instanceof GetCommand)return {Item:records.get(command.input.Key.pk)};
    if(command instanceof QueryCommand){
      queries++;
      const key=command.input.ExpressionAttributeValues[":pk"];
      return {Items:key===prefix?points:[]};
    }
    if(command instanceof ScanCommand)return{Items:[]};
    if(command instanceof TransactWriteCommand){
      tx=command.input.TransactItems;
      if(race)throw Object.assign(new Error("Concurrent claim"),{name:"TransactionCanceledException"});
      return {};
    }
    throw Error("Unexpected test DynamoDB command");
  }});
  return {store,tx:()=>tx,queries:()=>queries};
}

test("#278 terminal deleted parent also retires exact coalesced child receipt, audit and conflict pointer",async()=>{
  const f=fixture();
  assert.equal(await f.store.resolveVerifiedDeletedCase(parentId,{
    profile,taskIds:["task-dead"],eventIds:["event-dead"],
  }),true);
  const ops=f.tx();
  assert.ok(ops.some(o=>o.Update?.Key.pk==="REVIEW_CASE#"+parentId));
  const child=ops.find(o=>o.Update?.Key.pk==="REVIEW_CASE#incident-closed")?.Update;
  assert.ok(child);
  assert.match(child.ConditionExpression,/coalescedInto = :keeper/);
  assert.match(child.ConditionExpression,/sourceAuditKey = :audit/);
  assert.match(child.UpdateExpression,/REMOVE sourceAuditKey, lookupPk, lookupSk, conflictKey, coalescedInto/);
  const pointerDelete=ops.find(o=>o.Delete?.Key.pk===prefix && o.Delete.Key.sk==="INCIDENT#incident-closed")?.Delete;
  assert.ok(pointerDelete);
  assert.match(pointerDelete.ConditionExpression,/incidentId = :id/);
  assert.equal(ops.filter(o=>o.Delete?.Key.pk==="AUDIT#home#incident-closed").length,1);
  assert.equal(f.queries(),16,"all-profile deletion-review, audit, and completed-history inventories are bounded and exact");
  assert.ok(!ops.some(o=>o.Delete?.Key.pk?.startsWith("COMPLETED_")));
  const keys=ops.map(o=>o.Update?.Key||o.Delete?.Key||o.ConditionCheck?.Key||o.Put?.Item)
    .filter(Boolean).map(k=>k.pk+"|"+k.sk);
  assert.equal(new Set(keys).size,keys.length,"DynamoDB transaction cannot target a key more than once");
});

test("#278 active/foreign/unrelated coalesced incidents and audit evidence survive terminal parent",async()=>{
  for(const other of [
    sibling("incident-live",{status:"open"}),
    sibling("incident-foreign",{eventId:"live-other"}),
    sibling("incident-other-keeper",{coalescedInto:"different-parent"}),
    sibling("incident-operation",{operationId:"repair-active"}),
    sibling("incident-other-profile",{profile:"work"}),
  ]){
    const f=fixture({child:other});
    assert.equal(await f.store.resolveVerifiedDeletedCase(parentId,{
      profile,taskIds:["task-dead"],eventIds:["event-dead"],
    }),true);
    const operations=f.tx();
    assert.ok(!operations.some(o=>o.Update?.Key.pk==="REVIEW_CASE#"+other.id));
    assert.ok(!operations.some(o=>o.Delete?.Key.pk===prefix&&o.Delete.Key.sk==="INCIDENT#"+other.id));
    assert.ok(!operations.some(o=>o.Delete?.Key.pk===other.sourceAuditKey));
  }
});

test("#278 ambiguous changed conflict pointer or transaction race fails closed for all siblings",async()=>{
  const invalid=fixture({invalidPointer:true});
  assert.equal(await invalid.store.resolveVerifiedDeletedCase(parentId,{
    profile,taskIds:["task-dead"],eventIds:["event-dead"],
  }),false);
  assert.equal(invalid.tx(),undefined);
  const raced=fixture({race:true});
  assert.equal(await raced.store.resolveVerifiedDeletedCase(parentId,{
    profile,taskIds:["task-dead"],eventIds:["event-dead"],
  }),false);
  assert.ok(raced.tx().some(o=>o.Update?.Key.pk==="REVIEW_CASE#incident-closed"));
});

test("#278 conflict pointers with other keepers are never swept along with this parent",async()=>{
  const f=fixture({other:sibling("incident-unrelated",{
    coalescedInto:"other-case",eventId:"live-other",
  })});
  assert.equal(await f.store.resolveVerifiedDeletedCase(parentId,{
    profile,taskIds:["task-dead"],eventIds:["event-dead"],
  }),true);
  assert.ok(f.tx().some(o=>o.Delete?.Key.pk===prefix&&o.Delete.Key.sk==="INCIDENT#incident-closed"));
  assert.ok(!f.tx().some(o=>o.Delete?.Key.pk===prefix&&o.Delete.Key.sk==="INCIDENT#incident-unrelated"));
});
