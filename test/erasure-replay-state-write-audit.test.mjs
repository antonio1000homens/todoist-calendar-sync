import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {StateRepository} from "../dist/repository.js";
import {DynamoReconciliationStore} from "../dist/reconciliation.js";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {ErasureReplayBlockedError} from "../dist/erasure-replay-barrier.js";

const repositorySource=await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../src/repository.ts"),"utf8");
const reconciliationSource=await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../src/reconciliation.ts"),"utf8");
const guardedIdentityMutators=[
  "commitFlattenMapping",
  "putMapping",
  "updateCalendarOwnedMetadataIfUnchanged",
  "advanceCalendarSeriesMapping",
  "transferCalendarSeriesMapping",
  "putNewRecurrenceMappingIfUnowned",
  "putConsolidationGuard",
  "commitRecurrenceConsolidation",
  "restoreMappingIndexesIfOwned",
  "deleteProfileMappingIndexes",
  "completeFutureSeriesSplit",
  "purgeEarlierCancelledCalendarOccurrence",
  "deleteMapping",
  "retireDeletedTodoistRecurrenceIfUnchanged",
  "deleteMappingIfUnchanged",
  "commitElapsedCalendarHistoryDetach",
  "acceptTaskVersion",
  "putRecurrenceLink",
  "deleteRecurrenceLink",
  "putCalendarProjectionTombstone",
  "deleteCalendarProjectionTombstone",
  "beginTodoistCalendarWrite",
  "putCompletedCalendarProjection",
  "verifyTerminalCompletedCalendarProjection",
  "reopenRetainedStandaloneMapping",
  "deleteCompletedCalendarProjection",
  "recordRecurrence",
];

test("identity-bearing DynamoDB mutators check replay admission before their first write",()=>{
  for(const name of guardedIdentityMutators){
    const start=repositorySource.indexOf(`async ${name}(`);
    assert.notEqual(start,-1,`repository method ${name} is missing`);
    const next=repositorySource.indexOf("\n  async ",start+1);
    const body=repositorySource.slice(start,next<0?repositorySource.length:next);
    const guard=body.indexOf("assertReplayAdmissionIfEnabled(");
    const firstWrite=body.search(/new (?:Put|Update|Delete|TransactWrite)Command\s*\(/);
    assert.notEqual(guard,-1,`${name} must check erasure replay markers`);
    assert.notEqual(firstWrite,-1,`${name} must retain an explicit write boundary`);
    assert.ok(guard<firstWrite,`${name} must check replay markers before its DynamoDB write`);
  }
});

test("reconciliation baseline mutators check replay admission before state access or writes",()=>{
  for(const name of ["putBaseline","deleteBaseline","deleteBaselineIfUnchanged"]){
    const start=reconciliationSource.indexOf(`async ${name}(`);
    assert.notEqual(start,-1,`reconciliation method ${name} is missing`);
    const next=reconciliationSource.indexOf("\n  async ",start+1);
    const body=reconciliationSource.slice(start,next<0?reconciliationSource.length:next);
    const guard=body.indexOf("assertReplayAdmissionIfEnabled(");
    const firstStateAccess=body.search(/new (?:Get|Put|Delete)Command\s*\(/);
    assert.notEqual(guard,-1,`${name} must check erasure replay markers`);
    assert.notEqual(firstStateAccess,-1,`${name} must retain its state boundary`);
    assert.ok(guard<firstStateAccess,`${name} must check replay markers before accessing reconciliation state`);
  }
});

async function withReplayBarrier(t,send){
  const prior={
    version:process.env.ERASURE_REPLAY_BARRIER_VERSION,
    keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
    current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
    table:process.env.STATE_TABLE_NAME,
  };
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({v1:Buffer.alloc(32,19).toString("base64")});
  process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="v1";
  process.env.STATE_TABLE_NAME||="test-state";
  t.after(()=>{
    for(const [key,value] of Object.entries({ERASURE_REPLAY_BARRIER_VERSION:prior.version,
      ERASURE_REPLAY_HMAC_KEYS:prior.keys,ERASURE_REPLAY_HMAC_CURRENT_KEY:prior.current,
      STATE_TABLE_NAME:prior.table}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const calls=[];
  t.mock.method(documentClient,"send",async command=>{
    calls.push(command);
    return send(command);
  });
  return calls;
}

test("deleted mapping refuses marker and sends no state mutation",async t=>{
  const calls=await withReplayBarrier(t,command=>{
    assert.equal(command.constructor.name,"GetCommand");
    return {Item:{markerVersion:1}};
  });
  await assert.rejects(new StateRepository().deleteMapping({profile:"work",taskId:"blocked-task",
    eventId:"blocked-event",updatedAt:"2026-11-04T00:00:00.000Z"}),ErasureReplayBlockedError);
  assert.ok(calls.length>=1);
  assert.equal(calls.some(command=>command.constructor.name!=="GetCommand"),false);
});

test("conditional reconciliation baseline deletion refuses a replay marker",async t=>{
  const calls=await withReplayBarrier(t,command=>{
    assert.equal(command.constructor.name,"GetCommand");
    return {Item:{markerVersion:1}};
  });
  await assert.rejects(new DynamoReconciliationStore().deleteBaselineIfUnchanged("work","blocked-task",null),
    ErasureReplayBlockedError);
  assert.equal(calls.length,1);
});

test("recurrence deletion reads then checks every known alias before deleting",async t=>{
  const calls=await withReplayBarrier(t,command=>{
    if(command.input.Key?.pk==="RECURRENCE#work#blocked-series")return {Item:{profile:"work",owner:"calendar",
      seriesId:"blocked-series",taskId:"blocked-task",eventId:"blocked-event",masterEventId:"blocked-master",
      updatedAt:"2026-11-04T00:00:00.000Z"}};
    if(command.input.Key?.pk.startsWith("ERASURE_REPLAY#"))return {Item:{markerVersion:1}};
    assert.fail("Unexpected DynamoDB command before replay admission");
  });
  await assert.rejects(new StateRepository().deleteRecurrenceLink("work","blocked-series"),ErasureReplayBlockedError);
  assert.equal(calls.some(command=>command.constructor.name==="DeleteCommand"),false);
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

test("calendar write lease creation refuses a Todoist marker in any profile",async t=>{
  const calls=await withReplayBarrier(t,command=>{
    assert.equal(command.constructor.name,"GetCommand");
    if(command.input.Key.pk==="ERASURE_REPLAY#antonio")return {Item:{markerVersion:1}};
    return {};
  });
  await assert.rejects(new StateRepository().beginTodoistCalendarWrite("blocked-task"),ErasureReplayBlockedError);
  assert.equal(calls.some(command=>command.constructor.name==="PutCommand"),false);
});
