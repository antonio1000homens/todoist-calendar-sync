import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {StateRepository} from "../dist/repository.js";
import {DynamoReconciliationStore} from "../dist/reconciliation.js";
import {CanonicalIdentityStore} from "../dist/canonical-identity.js";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";

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

test("retired HMAC setting denies identity state writes instead of checking old marker rows",async t=>{
  const names=["ERASURE_REPLAY_BARRIER_VERSION","RETIREMENT_DISPOSITION_VERSION","STATE_TABLE_NAME"];
  const before=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{
    ERASURE_REPLAY_BARRIER_VERSION:"1",RETIREMENT_DISPOSITION_VERSION:"0",STATE_TABLE_NAME:"test-state",
  });
  t.after(()=>{for(const [key,value] of Object.entries(before)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  const reads=[],writes=[];
  t.mock.method(documentClient,"send",async command=>{
    if(command.constructor.name==="GetCommand"){
      reads.push(command.input.Key.pk);
      if(command.input.Key.pk==="RECURRENCE#work#blocked-series")
        return {Item:{profile:"work",owner:"calendar",seriesId:"blocked-series",
          taskId:"blocked-task",eventId:"blocked-event",masterEventId:"blocked-master",
          updatedAt:"2026-11-04T00:00:00.000Z"}};
      return {};
    }
    writes.push(command.constructor.name);
    throw Error("obsolete gate must not authorise any state write");
  });
  const identity={normalizedTitle:"task",normalizedStart:"2026-11-04",allDay:true};
  const calls=[
    ()=>new StateRepository().deleteMapping({profile:"work",taskId:"blocked-task",
      eventId:"blocked-event",updatedAt:"2026-11-04T00:00:00.000Z"}),
    ()=>new DynamoReconciliationStore().deleteBaselineIfUnchanged("work","blocked-task",null),
    ()=>new CanonicalIdentityStore().put("work","calendar","blocked-event",identity),
    ()=>new CanonicalIdentityStore().deleteIfUnchanged({
      profile:"work",side:"calendar",providerId:"blocked-event",identity,
      updatedAt:"2026-11-04T00:00:00.000Z",
    }),
    ()=>new StateRepository().deleteRecurrenceLink("work","blocked-series"),
  ];
  for(const invoke of calls)
    await assert.rejects(invoke(),ErasureReplayUnavailableError);
  assert.deepEqual(writes,[]);
  assert.ok(reads.every(pk=>!pk.startsWith("ERASURE_REPLAY#")));
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

