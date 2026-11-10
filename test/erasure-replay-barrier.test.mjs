import assert from "node:assert/strict";
import test from "node:test";
import {
  ErasureReplayUnavailableError, atomicConfirmedErasureCompletion,
  verifyConfirmedErasureCompletion, replayAdmissionEnabled,
  assertReplayAdmission, mappingReplayIdentity,
} from "../dist/erasure-replay-barrier.js";

test("legacy HMAC replay gate stays disabled and any attempted reactivation fails closed",async t=>{
  const prior=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  t.after(()=>{if(prior===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=prior;});
  for(const disabled of [undefined,"","0"]) {
    if(disabled===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=disabled;
    assert.equal(replayAdmissionEnabled(),false);
  }
  for(const unexpected of ["1","2","unrecognised"]) {
    process.env.ERASURE_REPLAY_BARRIER_VERSION=unexpected;
    assert.throws(()=>replayAdmissionEnabled(),ErasureReplayUnavailableError);
  }
});

test("direct HMAC marker admission is retired and performs no DynamoDB reads",async()=>{
  let reads=0;
  await assert.rejects(assertReplayAdmission({profile:"work",taskId:"task-1"},{
    async send(){reads++;throw new Error("a legacy marker must not be read");}
  }),ErasureReplayUnavailableError);
  assert.equal(reads,0);
});

test("mapping identity retains all known recurrence aliases for retirement admission",()=>{
  assert.deepEqual(mappingReplayIdentity({
    profile:"work",taskId:"task-203",eventId:"event-203",
    masterEventId:"master-203",activeInstanceId:"instance-203",
  }),{
    profile:"work",taskId:"task-203",
    eventIds:["event-203","master-203","instance-203"],
  });
});

test("confirmed erasure releases its fence only against recorded project tombstones and writes no DynamoDB identity",async()=>{
  const previous=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  const proof={operationId:"op-atomic",profile:"work",taskId:"deleted-task",deleteCalendar:true,
    eventId:"deleted-event",calendarId:"work@example.test",knownCalendarAliasesComplete:true,
    knownCalendarAliases:[{profile:"work",calendarId:"work@example.test",eventId:"deleted-event"},
      {profile:"antonio",calendarId:"personal-archive@example.test",eventId:"moved-event"}],
    projectCommentIds:["project-comment-1"],
    confirmationId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",previewFingerprint:"d".repeat(64),epoch:7};
  try{
    const tx=atomicConfirmedErasureCompletion(proof).input.TransactItems;
    assert.equal(tx.some(item=>item.Put?.Item?.pk.startsWith("ERASURE_REPLAY#")),false);
    assert.equal(tx.some(item=>item.Put?.Item?.markerVersion===1),false,
      "the transaction persists no task/event tombstone row");
    assert.ok(tx.some(item=>item.Delete?.Key?.sk==="FENCE"));
    assert.ok(tx.some(item=>item.ConditionCheck?.Key?.sk==="EPOCH"));
    assert.ok(tx.some(item=>item.Delete?.Key?.pk==="ERASURE_OPERATION#op-atomic"
      &&item.Delete.ConditionExpression.includes("contains(actionPlan.projectCommentIds, :comment0)")));
    process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
    assert.ok(atomicConfirmedErasureCompletion(proof),"the confirmed comment model uses no new DynamoDB replay flag");
    process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  }finally{if(previous===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous;}
});

test("confirmed erasure refuses missing, duplicated or unverified project tombstones and Calendar aliases",()=>{
  const base={
    operationId:"op-current",profile:"home",taskId:"task-current",
    deleteCalendar:true,eventId:"event-current",calendarId:"home@example.test",
    knownCalendarAliasesComplete:true,
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-current"}],
    projectCommentIds:["project-comment-current"],
    confirmationId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    previewFingerprint:"d".repeat(64),epoch:3,
  };
  const cases=[
    {name:"no exact original project comment",patch:{projectCommentIds:[]}},
    {name:"duplicated project comment",patch:{projectCommentIds:["same","same"]}},
    {name:"Calendar alias inventory incomplete",patch:{knownCalendarAliasesComplete:false}},
    {name:"selected Calendar ID absent from aliases",patch:{knownCalendarAliases:[]}},
    {name:"wrong selected event",patch:{eventId:"different"}},
    {name:"invalid epoch",patch:{epoch:0}},
    {name:"invalid confirmation",patch:{confirmationId:"not-a-confirmation"}},
  ];
  for(const {name,patch} of cases) {
    assert.throws(()=>atomicConfirmedErasureCompletion({...base,...patch}),
      ErasureReplayUnavailableError,name);
  }
});

test("confirmed erasure completion readback only succeeds after owned fence and operation disappear",async()=>{
  const proof={
    operationId:"op-current",profile:"home",taskId:"task-current",
    deleteCalendar:false,projectCommentIds:["project-comment-current"],
    confirmationId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    previewFingerprint:"d".repeat(64),epoch:4,
  };
  const key=command=>command.input.Key.pk+"|"+command.input.Key.sk;
  const rows=new Map([["ERASURE#home|EPOCH",{epoch:4}]]);
  const reads=[];
  const db={async send(command){
    assert.equal(command.constructor.name,"GetCommand");
    assert.equal(command.input.ConsistentRead,true);
    reads.push(key(command));
    return {Item:rows.get(key(command))};
  }};
  assert.equal(await verifyConfirmedErasureCompletion(proof,db),true);
  assert.equal(reads.length,5);
  rows.set("ERASURE#home|FENCE",{operationId:"op-current",state:"active"});
  assert.equal(await verifyConfirmedErasureCompletion(proof,db),false);
  rows.delete("ERASURE#home|FENCE");
  rows.delete("ERASURE#home|EPOCH");
  assert.equal(await verifyConfirmedErasureCompletion(proof,db),false);
  await assert.rejects(verifyConfirmedErasureCompletion(proof,{
    async send(){throw new Error("DDB unavailable");}
  }),ErasureReplayUnavailableError);
});
