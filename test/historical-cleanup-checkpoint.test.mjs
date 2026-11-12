import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewStore } from "../dist/review-store.js";

function checkpointStore(){
  const rows=new Map();
  const db={async send(command){
    const input=command.input,key=`${input.Key?.pk||input.Item?.pk}/${input.Key?.sk||input.Item?.sk}`;
    if(command instanceof GetCommand)return{Item:rows.get(key)};
    if(command instanceof PutCommand){
      const old=rows.get(key),values=input.ExpressionAttributeValues||{};
      if(input.ConditionExpression==="attribute_not_exists(pk)"&&old)throw Object.assign(new Error("condition"),{name:"ConditionalCheckFailedException"});
      if(old&&input.ConditionExpression?.startsWith("updatedAt =")){
        if(old.updatedAt!==values[":version"]||old.fingerprint!==values[":fingerprint"]
          ||(old.leaseUntil>values[":now"]&&old.leaseOwner!==values[":owner"]))
          throw Object.assign(new Error("condition"),{name:"ConditionalCheckFailedException"});
      }
      rows.set(key,input.Item);return{};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  }};
  return {store:new ReviewStore(db),rows};
}

test("historical cleanup checkpoint CAS preserves exact identity, exclusive lease, and retryable progress",async()=>{
  const {store}=checkpointStore(),common={caseId:"case-1",profile:"work",fingerprint:"a".repeat(64)};
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-1",patch:{status:"running",phase:"clearing_todoist_comments"}}),true);
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-2",patch:{status:"running",phase:"checking_calendar_links"}}),false);
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-1",patch:{pendingProviderWrite:{type:"comment",id:"c1"}}}),true);
  assert.equal((await store.getHistoricalCleanupCheckpoint("case-1")).pendingProviderWrite.id,"c1");
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-1",patch:{status:"retryable"},release:true}),true);
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-2",patch:{phase:"checking_calendar_links"}}),true);
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,fingerprint:"b".repeat(64),owner:"request-3",patch:{status:"running"}}),false);
});

test("completed historical cleanup checkpoint is terminal and cannot be overwritten",async()=>{
  const {store}=checkpointStore(),common={caseId:"case-2",profile:"work",fingerprint:"c".repeat(64)};
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-1",patch:{status:"running"}}),true);
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-1",patch:{status:"complete"},release:true}),true);
  assert.equal(await store.saveHistoricalCleanupCheckpoint({...common,owner:"request-2",patch:{status:"running",phase:"checking_providers"}}),true);
  const final=await store.getHistoricalCleanupCheckpoint("case-2");
  assert.equal(final.status,"complete");
});
