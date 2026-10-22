import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewStore } from "../dist/review-store.js";

test("repair submission is idempotent for its preview and rejects a different key",async()=>{
  const actor={subject:"operator-1",email:"operator@example.test"};
  const preview={id:"preview-1",actor,intent:{caseId:"case-1",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  const rows=new Map([["REPAIR_PREVIEW#"+preview.id,{...preview,pk:"REPAIR_PREVIEW#"+preview.id,sk:"STATE"}]]);
  const db={async send(command){
    if(command instanceof GetCommand)return {Item:rows.get(command.input.Key.pk)};
    if(command instanceof TransactWriteCommand){
      const [update,put]=command.input.TransactItems;
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
