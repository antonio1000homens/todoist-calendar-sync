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
