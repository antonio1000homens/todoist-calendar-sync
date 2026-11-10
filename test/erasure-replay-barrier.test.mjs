import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReplayAdmission, ErasureReplayBlockedError,
  ErasureReplayUnavailableError, atomicConfirmedErasureCompletion, verifyConfirmedErasureCompletion,
} from "../dist/erasure-replay-barrier.js";

const original={table:process.env.STATE_TABLE_NAME,protocol:process.env.ERASURE_PROTOCOL_VERSION,keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
  current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY};
const oldKey=Buffer.alloc(32,1).toString("base64");
const newKey=Buffer.alloc(32,2).toString("base64");
process.env.STATE_TABLE_NAME="test-state";
process.env.ERASURE_PROTOCOL_VERSION="1";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({old:oldKey,current:newKey});
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="current";
test.after(()=>{
  for(const [env,value] of [
    ["STATE_TABLE_NAME",original.table],
    ["ERASURE_PROTOCOL_VERSION",original.protocol],
    ["ERASURE_REPLAY_HMAC_KEYS",original.keys],
    ["ERASURE_REPLAY_HMAC_CURRENT_KEY",original.current],
  ]) if(value===undefined)delete process.env[env];else process.env[env]=value;
});

test("admission checks each historical key with strongly consistent reads and fails closed on marker",async()=>{
  const reads=[];
  const db={async send(command) {
    assert.equal(command.constructor.name,"GetCommand");
    assert.equal(command.input.ConsistentRead,true);
    reads.push(command.input.Key);
    if(reads.length===2)return {Item:{markerVersion:1}};
    return {};
  }};
  await assert.rejects(assertReplayAdmission({profile:"work",taskId:"deleted-task"},db),ErasureReplayBlockedError);
  assert.equal(reads.length,2);
  assert.equal(new Set(reads.map(x=>x.pk)).size,1);
  assert.equal(new Set(reads.map(x=>x.sk)).size,2,"historical key IDs must remain readable");
});

test("unavailable storage, absent HMAC keyring and unidentified identity are denied without provider writes",async()=>{
  const identity={profile:"work",taskId:"deleted-task"};
  const unavailable={async send(){throw new Error("provider unavailable");}};
  await assert.rejects(assertReplayAdmission(identity,unavailable),ErasureReplayUnavailableError);
  const keys=process.env.ERASURE_REPLAY_HMAC_KEYS;
  delete process.env.ERASURE_REPLAY_HMAC_KEYS;
  try {
    await assert.rejects(assertReplayAdmission(identity,{async send(){throw new Error("must not read");}}),ErasureReplayUnavailableError);
  } finally {
    process.env.ERASURE_REPLAY_HMAC_KEYS=keys;
  }
  await assert.rejects(assertReplayAdmission({profile:"work"},{}),ErasureReplayUnavailableError);
  await assert.rejects(assertReplayAdmission({profile:"work",eventIds:["x","x"]},{}),ErasureReplayUnavailableError);
});

test("calendar IDs are profile-scoped: unrelated profile event IDs are not rejected",async()=>{
  const reads=[];
  await assertReplayAdmission({profile:"home",eventIds:["shared-calendar-id"]},{
    async send(command){reads.push(command.input.Key);return {};}
  });
  assert.equal(reads.length,4,"check calendar-scoped and legacy markers for both retained keys");
  assert.ok(reads.every(row=>row.pk==="ERASURE_REPLAY#home"));
  assert.ok(reads.every(row=>row.sk.startsWith("EVENT#")));
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
