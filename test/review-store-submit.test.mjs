import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewStore } from "../dist/review-store.js";

test("repair submission is idempotent for its preview and rejects a different key",async()=>{
  const actor={subject:"operator-1",email:"operator@example.test"};
  const preview={id:"preview-1",actor,case:{id:"case-1",createdAt:"2026-10-23",status:"resolved",operationId:"old-repair"},intent:{caseId:"case-1",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  const rows=new Map([["REPAIR_PREVIEW#"+preview.id,{...preview,pk:"REPAIR_PREVIEW#"+preview.id,sk:"STATE"}]]);
  const db={async send(command){
    if(command instanceof GetCommand)return {Item:rows.get(command.input.Key.pk)};
    if(command instanceof TransactWriteCommand){
      const [update,put,reserve]=command.input.TransactItems;
      assert.equal(reserve.Update.ExpressionAttributeValues[":expectedStatus"],"resolved");
      assert.equal(reserve.Update.ExpressionAttributeValues[":expectedOperation"],"old-repair");
      assert.equal(reserve.Update.ExpressionAttributeValues[":repairing"],"repairing");
      const previewRow=rows.get(update.Update.Key.pk);
      const submitted=previewRow.submittedOperation;
      const wanted=update.Update.ExpressionAttributeValues[":id"];
      if(submitted&&submitted!==wanted)throw Object.assign(new Error("conditional write failed"),{name:"TransactionCanceledException"});
      const operation=put.Put.Item;
      if(rows.has(operation.pk))throw Object.assign(new Error("duplicate operation"),{name:"TransactionCanceledException"});
      previewRow.submittedOperation=wanted;
      rows.set(operation.pk,operation);
      return {};
    }
    assert.fail("Unexpected DynamoDB command "+command.constructor.name);
  }};
  const store=new ReviewStore(db);
  const first=await store.submit(preview,actor,"request-key-1");
  const repeated=await store.submit(preview,actor,"request-key-1");
  assert.equal(repeated.id,first.id);
  assert.equal(rows.size,2);
  await assert.rejects(store.submit(preview,actor,"request-key-2"),error=>error.status===409);
  assert.equal(rows.size,2);
});

for (const status of ["resolved","excluded","dismissed","open"]) test(`fresh ${status} case disposition is atomically reserved with its operation`,async()=>{
  const actor={subject:"owner"}, current={id:"case",status,operationId:"previous",createdAt:"2026-10-23"};
  const preview={id:"preview",actor,case:current,intent:{caseId:"case",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  let transaction;
  const db={async send(command){
    if(command instanceof GetCommand)return {};
    transaction=command.input.TransactItems;
    return {};
  }};
  const result=await new ReviewStore(db).submit(preview,actor,"key");
  assert.equal(result.status,"queued");
  assert.equal(transaction.length,3);
  const claim=transaction[2].Update;
  assert.equal(claim.Key.pk,"REVIEW_CASE#case");
  assert.equal(claim.ConditionExpression,"#status = :expectedStatus AND operationId = :expectedOperation");
  assert.equal(claim.ExpressionAttributeValues[":expectedStatus"],status);
  assert.equal(claim.ExpressionAttributeValues[":expectedOperation"],"previous");
  assert.equal(claim.ExpressionAttributeValues[":id"],result.id);
});

test("a stale or concurrent closed-case preview cannot queue a misleading repair",async()=>{
  const actor={subject:"owner"}, preview={id:"preview",actor,case:{id:"case",status:"resolved",operationId:"old",createdAt:"2026-10-23"},intent:{caseId:"case",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  let writes=0;
  const db={async send(command){
    if(command instanceof GetCommand)return command.input.Key.pk==="REVIEW_CASE#case"?{Item:{status:"repairing",operationId:"other"}}:{};
    writes++;throw new Error("transaction canceled");
  }};
  await assert.rejects(new ReviewStore(db).submit(preview,actor,"key"),error=>error.status===409&&/fresh preview/.test(error.message));
  assert.equal(writes,1);
});

for(const abandoned of [false,true]) test(`a repairing case ${abandoned?"can supersede an atomically abandoned no-write operation":"cannot replace an active operation"}`,async()=>{
  const actor={subject:"owner"}, previous={id:"old",status:"failed",abandoned};
  const preview={id:"fresh",actor,case:{id:"case",status:"repairing",operationId:"old",createdAt:"2026-10-23"},intent:{caseId:"case",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  let items;
  const db={async send(command){
    if(command instanceof GetCommand)return command.input.Key.pk==="REPAIR#old"?{Item:previous}:{};
    items=command.input.TransactItems;return {};
  }};
  const request=new ReviewStore(db).submit(preview,actor,"key");
  if(!abandoned){await assert.rejects(request,error=>error.status===409);assert.equal(items,undefined);}
  else {await request;assert.equal(items.length,4);assert.equal(items[3].ConditionCheck.Key.pk,"REPAIR#old");assert.match(items[3].ConditionCheck.ConditionExpression,/abandoned = :yes/);}
});
