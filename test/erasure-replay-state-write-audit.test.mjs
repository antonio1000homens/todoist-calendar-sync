import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {StateRepository} from "../dist/repository.js";
import {DynamoReconciliationStore} from "../dist/reconciliation.js";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {assertReplayAdmissionIfEnabled,ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";

const reconciliationSource=await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../src/reconciliation.ts"),"utf8");
test("production reconciliation baselines are persisted with provider correlation",()=>{
  const start=reconciliationSource.indexOf("private async persistReconciliationBaseline(");
  const next=reconciliationSource.indexOf("\n  }",start);
  const body=reconciliationSource.slice(start,next);
  assert.match(body,/process\.env\.NODE_ENV === "test" && this\.store/);
  assert.match(body,/return this\.persistProviderMapping\(\{ \.\.\.mapping, syncBaseline:/);
});

test("stale retired HMAC setting does not block ordinary identity writes",async t=>{
  const names=["ERASURE_REPLAY_BARRIER_VERSION","STATE_TABLE_NAME"];
  const before=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{
    ERASURE_REPLAY_BARRIER_VERSION:"1",STATE_TABLE_NAME:"test-state",
  });
  t.after(()=>{for(const [key,value] of Object.entries(before)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  const reads=[];
  t.mock.method(documentClient,"send",async command=>{
    reads.push(command.input?.Key?.pk);
    return {};
  });
  await assert.doesNotReject(assertReplayAdmissionIfEnabled({
    profile:"work",taskId:"blocked-task",eventIds:["blocked-event"],
  }));
  assert.deepEqual(reads,[]);
});

test("recurrence deletion is conditional on the exact identity snapshot",async t=>{
  const prior=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  t.after(()=>{if(prior===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=prior;});
  let deletion;
  t.mock.method(documentClient,"send",async command=>{
    if(command.constructor.name==="GetCommand")return {Item:{profile:"work",owner:"calendar",
      seriesId:"stable-series",taskId:"stable-task",eventId:"stable-event",masterEventId:"stable-master",
      updatedAt:"2026-11-04T00:00:00.000Z"}};
    if(command.constructor.name==="DeleteCommand"){
      deletion=command.input;
      throw Object.assign(new Error("link changed after read"),{name:"ConditionalCheckFailedException"});
    }
    assert.fail("Unexpected DynamoDB command");
  });
  await new StateRepository().deleteRecurrenceLink("work","stable-series");
  assert.match(deletion.ConditionExpression,/taskId = :task AND eventId = :event/);
  assert.match(deletion.ConditionExpression,/updatedAt = :updatedAt/);
  assert.equal(deletion.ExpressionAttributeValues[":task"],"stable-task");
  assert.equal(deletion.ExpressionAttributeValues[":event"],"stable-event");
  assert.equal(deletion.ExpressionAttributeValues[":updatedAt"],"2026-11-04T00:00:00.000Z");
});

