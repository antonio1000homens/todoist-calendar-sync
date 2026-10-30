import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReplayAdmission, atomicReplayRelease, ErasureReplayBlockedError,
  ErasureReplayUnavailableError, REPLAY_PROFILES,
} from "../dist/erasure-replay-barrier.js";

const original={table:process.env.STATE_TABLE_NAME,keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
  current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY};
const oldKey=Buffer.alloc(32,1).toString("base64");
const newKey=Buffer.alloc(32,2).toString("base64");
process.env.STATE_TABLE_NAME="test-state";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({old:oldKey,current:newKey});
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="current";
test.after(()=>{
  for(const [env,value] of [
    ["STATE_TABLE_NAME",original.table],
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
  assert.equal(reads.length,2);
  assert.ok(reads.every(row=>row.pk==="ERASURE_REPLAY#home"));
  assert.ok(reads.every(row=>row.sk.startsWith("EVENT#")));
});

function proof(){
  return {
    operationId:"operator-operation-id",epoch:7,confirmationId:"fresh-single-use-confirmation",
    recoveryFingerprint:"a".repeat(64),postflightFingerprint:"b".repeat(64),
    identity:{profile:"work",taskId:"deleted-task",eventIds:["deleted-event","deleted-alias"]},
    journalPresent:true,
  };
}
test("marker writes and fence release are ONE conditional transaction, with no plaintext identities or retained operation IDs in markers",()=>{
  const command=atomicReplayRelease(proof());
  assert.equal(command.constructor.name,"TransactWriteCommand");
  const tx=command.input.TransactItems;
  const markers=tx.filter(entry=>entry.Put).map(entry=>entry.Put);
  assert.equal(markers.length,REPLAY_PROFILES.length+2);
  assert.deepEqual(markers.filter(x=>x.Item.sk.startsWith("TASK#")).map(x=>x.Item.pk).sort(),
    REPLAY_PROFILES.map(x=>"ERASURE_REPLAY#"+x).sort());
  assert.equal(markers.filter(x=>x.Item.sk.startsWith("EVENT#")).length,2);
  assert.ok(markers.filter(x=>x.Item.sk.startsWith("EVENT#")).every(x=>x.Item.pk==="ERASURE_REPLAY#work"));
  assert.ok(markers.every(x=>x.ConditionExpression==="attribute_not_exists(pk)"));
  assert.ok(markers.every(x=>Object.keys(x.Item).sort().join(",")==="markerVersion,pk,sk"));
  assert.ok(tx.some(x=>x.Delete?.Key.sk==="FENCE"&&x.Delete.ConditionExpression.includes("operationId=:id")));
  assert.ok(tx.some(x=>x.Delete?.Key.sk==="JOURNAL"));
  assert.ok(tx.some(x=>x.ConditionCheck?.Key.sk==="EPOCH"));
  assert.ok(tx.some(x=>x.ConditionCheck?.Key.pk.startsWith("ERASURE_POSTWRITE_CONFIRMATION#")));
  assert.ok(tx.some(x=>x.Update?.Key.pk.startsWith("ERASURE_OPERATION#")
    &&x.Update.ConditionExpression.includes("recovery.mode=:mode")
    &&x.Update.ConditionExpression.includes("recovery.postflightFingerprint=:postflight")));
  const serialized=JSON.stringify(markers);
  assert.ok(!serialized.includes("deleted-task")&&!serialized.includes("deleted-event")
    &&!serialized.includes("deleted-alias")&&!serialized.includes("operator-operation-id"));
});

test("every new erasure marker uses only the current key; historical keys remain verification-only",async()=>{
  const tx=atomicReplayRelease(proof()).input.TransactItems;
  assert.ok(tx.filter(item=>item.Put).every(item=>item.Put.Item.sk.includes("#current#")));
  const seen=[];
  await assertReplayAdmission({profile:"antonio",taskId:"deleted-task"},{async send(cmd){
    seen.push(cmd.input.Key.sk);return {};
  }});
  assert.equal(seen.length,2);
  assert.ok(seen.some(x=>x.includes("#old#")));
  assert.ok(seen.some(x=>x.includes("#current#")));
});

test("missing new confirmation, epoch and oversize alias set cannot construct a release",()=>{
  for(const patch of [
    {confirmationId:""},
    {epoch:0},
    {postflightFingerprint:""},
    {identity:{profile:"work",taskId:"deleted-task",eventIds:[]}},
    {identity:{profile:"work",taskId:"deleted-task",eventIds:Array.from({length:33},(_,i)=>"event-"+i)}},
  ]) assert.throws(()=>atomicReplayRelease({...proof(),...patch}),ErasureReplayUnavailableError);
});
