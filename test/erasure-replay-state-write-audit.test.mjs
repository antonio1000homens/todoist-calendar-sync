import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {StateRepository} from "../dist/repository.js";
import {DynamoReconciliationStore} from "../dist/reconciliation.js";
import {CanonicalIdentityStore} from "../dist/canonical-identity.js";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {ErasureReplayBlockedError} from "../dist/erasure-replay-barrier.js";
import {enableReplayBarrierFixture} from "./helpers/replay-barrier-env.mjs";

const repositorySource=await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../src/repository.ts"),"utf8");
const reconciliationSource=await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../src/reconciliation.ts"),"utf8");
const canonicalIdentitySource=await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),"../src/canonical-identity.ts"),"utf8");
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

test("canonical identity mutators check replay admission before identity writes",()=>{
  for(const name of ["put","deleteIfUnchanged"]){
    const start=canonicalIdentitySource.indexOf(`async ${name}(`);
    assert.notEqual(start,-1,`canonical identity method ${name} is missing`);
    const next=canonicalIdentitySource.indexOf("\n  async ",start+1);
    const body=canonicalIdentitySource.slice(start,next<0?canonicalIdentitySource.length:next);
    const guard=body.indexOf("assertReplayAdmissionIfEnabled(");
    const firstWrite=body.search(/new (?:Put|Delete)Command\s*\(/);
    assert.notEqual(guard,-1,`${name} must check replay markers`);
    assert.notEqual(firstWrite,-1,`${name} must retain an explicit identity write boundary`);
    assert.ok(guard<firstWrite,`${name} must check replay markers before its DynamoDB write`);
  }
});

async function withReplayBarrier(t,send){
  t.after(enableReplayBarrierFixture({
    keySeed:19,
    extra:{STATE_TABLE_NAME:process.env.STATE_TABLE_NAME||"test-state"},
  }));
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

test("canonical identity puts and deletes refuse a replay marker before writing",async t=>{
  const calls=await withReplayBarrier(t,command=>{
    assert.equal(command.constructor.name,"GetCommand");
    return {Item:{markerVersion:1}};
  });
  const store=new CanonicalIdentityStore();
  const identity={normalizedTitle:"task",normalizedStart:"2026-11-04",allDay:true};
  await assert.rejects(store.put("work","calendar","blocked-event",identity),ErasureReplayBlockedError);
  await assert.rejects(store.deleteIfUnchanged({profile:"work",side:"calendar",providerId:"blocked-event",
    identity,updatedAt:"2026-11-04T00:00:00.000Z"}),ErasureReplayBlockedError);
  assert.equal(calls.length,2);
  assert.ok(calls.every(command=>command.constructor.name==="GetCommand"));
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
