import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewStore } from "../dist/review-store.js";

function fixture({ race = false } = {}) {
  const c = { id:"review-a",profile:"home",status:"open",title:"Stale conflict",reason:"todoist_unmapped_conflict",
    taskId:"task-a",eventId:"event-a",createdAt:"2026-10-25T00:00:00Z",updatedAt:"2026-10-25T00:00:01Z" };
  const records=new Map([
    ["REVIEW_CASE#review-a",c],
    ["AUDIT#home#new-safe",{action:"calendar_snapshot_recurring_identity_conflict",createdAt:"2026-10-25T00:00:00Z",
      detail:{taskId:"task-a",eventId:"event-a"}}],
    ["COMPLETED_EVENT#home#history-a",{taskId:"task-a",eventId:"history-a",completedAt:"2026-10-25T00:00:00Z"}],
    ["COMPLETED_TASK#home#task-a",{taskId:"task-a",eventId:"history-a",completedAt:"2026-10-25T00:00:00Z"}],
    ["AUDIT#home#shared-live",{action:"calendar_snapshot_recurring_identity_conflict",createdAt:"2026-10-25T00:00:00Z",
      detail:{taskId:"task-a",eventId:"event-OTHER"}}],
  ]);
  const safe={pk:"AUDIT_REF#home#todoist#task-a",sk:"AUDIT#safe",auditKey:"AUDIT#home#new-safe"};
  const shared={pk:"AUDIT_REF#home#todoist#task-a",sk:"AUDIT#shared",auditKey:"AUDIT#home#shared-live"};
  const eventSafe={pk:"AUDIT_REF#home#calendar#event-a",sk:"AUDIT#safe",auditKey:"AUDIT#home#new-safe"};
  let transaction,queries=0;
  const store=new ReviewStore({send:async command=>{
    if(command instanceof GetCommand)return {Item:records.get(command.input.Key.pk)};
    if(command instanceof QueryCommand){
      queries++;
      const pk=command.input.ExpressionAttributeValues[":pk"];
      return {Items:pk==="AUDIT_REF#home#todoist#task-a"?[safe,shared]:
        pk==="AUDIT_REF#home#calendar#event-a"?[eventSafe]:[]};
    }
    if(command instanceof TransactWriteCommand){
      transaction=command.input.TransactItems;
      if(race)throw Object.assign(new Error("owner changed"),{name:"TransactionCanceledException"});
      return {};
    }
    throw new Error("Unexpected DynamoDB operation");
  }});
  return {store,caseItem:c,getTransaction:()=>transaction,getQueries:()=>queries};
}

test("deleted fixture audits are retired only when every provider ID is attributable",async()=>{
  const f=fixture();
  assert.equal(await f.store.resolveVerifiedDeletedCase("review-a",
    {profile:"home",taskIds:["task-a"],eventIds:["event-a"]}),true);
  const tx=f.getTransaction(),deletes=tx.filter(x=>x.Delete).map(x=>x.Delete.Key.pk);
  assert.ok(deletes.includes("AUDIT#home#new-safe"));
  assert.ok(!deletes.includes("AUDIT#home#shared-live"));
  assert.ok(!tx.some(x=>x.Delete?.Key.sk==="AUDIT#shared"));
  assert.ok(tx.some(x=>x.Delete?.Key.pk==="AUDIT_REF#home#calendar#event-a"));
  assert.ok(tx.some(x=>x.Delete?.Key.pk==="DELETION_REVIEW#home#todoist#task-a"));
  assert.ok(tx.some(x=>x.Delete?.Key.pk==="DELETION_REVIEW#home#calendar#event-a"));
  const receipt=tx.find(x=>x.Update?.Key.pk==="REVIEW_CASE#review-a").Update;
  assert.match(receipt.UpdateExpression,/REMOVE decision, taskId, eventId, sourceAuditKey, lookupPk, lookupSk/);
  assert.equal(receipt.ExpressionAttributeValues[":title"],"Verified deletion");
  assert.equal(receipt.ExpressionAttributeValues[":reason"],"verified_deletion");
  const checks=tx.filter(x=>x.ConditionCheck).map(x=>x.ConditionCheck);
  const checked=(pk,sk)=>checks.some(x=>x.Key.pk===pk&&x.Key.sk===sk);
  for(const profile of ["home","antonio","work"]){
    assert.ok(checked(`TASK#${profile}#task-a`,"MAP"));
    assert.ok(checked(`EVENT#${profile}#event-a`,"MAP"));
    assert.ok(!checked(`COMPLETED_EVENT#${profile}#event-a`,"STATE"));
    assert.ok(!checked(`COMPLETED_TASK#${profile}#task-a`,"EVENT#event-a"));
    assert.ok(checked(`RECURRENCE#${profile}#event-a`,"STATE"));
  }
  assert.ok(checked("TASKOWNER#task-a","MAP"));
  assert.ok(checks.some(x=>x.Key.pk==="SYNC_CONTROL#home:todoist:task-a"
    && x.ConditionExpression.includes("attribute_not_exists(activeRepair)")));
  assert.equal(f.getQueries(),2);
});

test("transaction race preserves actionable conflict and all associated audit evidence",async()=>{
  const f=fixture({race:true});
  assert.equal(await f.store.resolveVerifiedDeletedCase("review-a",
    {profile:"home",taskIds:["task-a"],eventIds:["event-a"]}),false);
  assert.ok(f.getTransaction().some(x=>x.Delete?.Key.pk==="AUDIT#home#new-safe"));
});

test("provider identity not in the exact verified-deleted set refuses cleanup before writes",async()=>{
  const f=fixture();
  assert.equal(await f.store.resolveVerifiedDeletedCase("review-a",
    {profile:"home",taskIds:["other-task"],eventIds:["event-a"]}),false);
  assert.equal(f.getTransaction(),undefined);
});

test("verified-deleted recurring task retires only the exact versioned link in the case transaction",async()=>{
  const f=fixture();
  const link={profile:"home",owner:"todoist",seriesId:"task-a",taskId:"task-a",
    eventId:"event-a",masterEventId:"event-a",activeInstanceId:"active-a",
    updatedAt:"2026-10-25T19:09:07.680Z"};
  assert.equal(await f.store.resolveVerifiedDeletedCase("review-a",
    {profile:"home",taskIds:["task-a"],eventIds:["event-a","active-a"],staleLinks:[link]}),true);
  const tx=f.getTransaction();
  const deleted=tx.find(x=>x.Delete?.Key.pk==="RECURRENCE#home#task-a");
  assert.ok(deleted);
  assert.match(deleted.Delete.ConditionExpression,/updatedAt = :updated/);
  assert.match(deleted.Delete.ConditionExpression,/masterEventId = :masterEventId/);
  assert.match(deleted.Delete.ConditionExpression,/activeInstanceId = :activeInstanceId/);
  assert.equal(deleted.Delete.ExpressionAttributeValues[":updated"],link.updatedAt);
  assert.ok(!tx.some(x=>x.Delete?.Key.pk?.startsWith("COMPLETED_")));
  assert.ok(!tx.some(x=>x.ConditionCheck?.Key.pk==="RECURRENCE#home#task-a"));
  const receipt=tx.find(x=>x.Update?.Key.pk==="REVIEW_CASE#review-a").Update;
  assert.match(receipt.UpdateExpression,/REMOVE decision, taskId, eventId/);
  assert.match(receipt.UpdateExpression,/expiresAt = :expiry/);
  assert.ok(receipt.ExpressionAttributeValues[":expiry"] > Date.now()/1000);
});

test("changed or foreign recurrence identity refuses cleanup before any transaction",async()=>{
  const f=fixture();
  const link={profile:"work",owner:"todoist",seriesId:"task-a",taskId:"task-a",
    eventId:"event-a",updatedAt:"2026-10-25T19:09:07.680Z"};
  assert.equal(await f.store.resolveVerifiedDeletedCase("review-a",
    {profile:"home",taskIds:["task-a"],eventIds:["event-a"],staleLinks:[link]}),false);
  assert.equal(f.getTransaction(),undefined);
});

test("stale link with an absent active identifier is rejected independently by transaction",async()=>{
  const f=fixture();
  const link={profile:"home",owner:"todoist",seriesId:"task-a",taskId:"task-a",
    eventId:"event-a",masterEventId:"event-a",updatedAt:"2026-10-25T19:09:07Z"};
  assert.equal(await f.store.resolveVerifiedDeletedCase("review-a",
    {profile:"home",taskIds:["task-a"],eventIds:["event-a"],staleLinks:[link]}),false);
  assert.equal(f.getTransaction(),undefined);
});
test("a verified Calendar iCalUID key is fenced on all profiles in the terminal transaction",async()=>{
  const f=fixture();
  const uid="calendar-master-series-uid";
  const result=await f.store.resolveVerifiedDeletedCase("review-a",{
    profile:"home",taskIds:["task-a"],eventIds:["event-a"],seriesKeys:["task-a","event-a",uid],
  });
  assert.equal(result,true);
  const checks=f.getTransaction().filter(x=>x.ConditionCheck).map(x=>x.ConditionCheck);
  for(const profile of ["home","antonio","work"])
    assert.ok(checks.some(c=>c.Key.pk===`RECURRENCE#${profile}#${uid}`&&c.Key.sk==="STATE"));
  assert.ok(!f.getTransaction().some(x=>x.Delete?.Key.pk?.startsWith("COMPLETED_")));
});
