import assert from "node:assert/strict";
import test from "node:test";
import {
  orphanReplayInstallTransaction, assertOrphanReplayGuard,
  assertReplayAdmission, ErasureReplayBlockedError, ErasureReplayUnavailableError,
} from "../dist/erasure-replay-barrier.js";

const previous={
  STATE_TABLE_NAME:process.env.STATE_TABLE_NAME,
  ERASURE_PROTOCOL_VERSION:process.env.ERASURE_PROTOCOL_VERSION,
  ERASURE_REPLAY_BARRIER_VERSION:process.env.ERASURE_REPLAY_BARRIER_VERSION,
  ORPHAN_DELETION_EXECUTION_ENABLED:process.env.ORPHAN_DELETION_EXECUTION_ENABLED,
  ERASURE_REPLAY_HMAC_CURRENT_KEY:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
  ERASURE_REPLAY_HMAC_KEYS:process.env.ERASURE_REPLAY_HMAC_KEYS,
};
process.env.STATE_TABLE_NAME="test-state";
process.env.ERASURE_PROTOCOL_VERSION="1";
process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
process.env.ORPHAN_DELETION_EXECUTION_ENABLED="true";
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="key1";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({
  previous:Buffer.alloc(32,1).toString("base64"),
  key1:Buffer.alloc(32,2).toString("base64"),
});
test.after(()=>{
  for(const [name,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
const op=(side="todoist")=>({
  id:"orphan-operation-287",caseId:"case-287",profile:"home",
  caseUpdatedAt:"2026-11-03T20:40:00.000Z",
  side,targetId:side==="todoist"?"task-123":"cal-123",
  providerDigest:"a".repeat(64),...(side==="calendar"?{providerEtag:"etag-123"}:{}),
  actorSubject:"actor-287",phase:"fenced",version:1,
  confirmedAt:"2026-11-03T20:39:00.000Z",
  confirmationExpiresAt:"2026-11-03T20:44:00.000Z",
  createdAt:"2026-11-03T20:39:00.000Z",
  updatedAt:"2026-11-03T20:40:00.000Z",
});
const split=command=>{
  const items=command.input.TransactItems;
  return {items,markers:items.filter(x=>x.Put?.Item?.markerVersion===1
    &&x.Put.Item.sk!=="STATE").map(x=>x.Put),
    guard:items.find(x=>x.Put?.Item?.pk?.startsWith("ORPHAN_REPLAY_GUARD#"))?.Put,
    checks:items.filter(x=>x.ConditionCheck).map(x=>x.ConditionCheck)};
};
test("a Todoist singleton installs HMAC markers for all 3 profiles with exact journal, case and fence CAS",()=>{
  const input=op(),transaction=orphanReplayInstallTransaction(input,7);
  assert.equal(transaction.constructor.name,"TransactWriteCommand");
  const {markers,guard,checks}=split(transaction);
  assert.equal(markers.length,3);
  assert.deepEqual(markers.map(p=>p.Item.pk).sort(),
    ["ERASURE_REPLAY#home","ERASURE_REPLAY#antonio","ERASURE_REPLAY#work"].sort());
  assert.ok(markers.every(p=>p.Item.sk.startsWith("TASK#key1#")));
  assert.ok(markers.every(p=>p.ConditionExpression==="attribute_not_exists(pk)"));
  assert.ok(markers.every(p=>Object.keys(p.Item).sort().join(",")==="markerVersion,pk,sk"));
  assert.equal(guard.Item.operationId,input.id);
  assert.equal(guard.Item.markerCount,3);
  assert.equal(guard.Item.keyId,"key1");
  assert.equal(guard.Item.targetId,undefined);
  assert.equal(guard.ConditionExpression,"attribute_not_exists(pk)");
  const byKey=Object.fromEntries(checks.map(x=>[x.Key.pk+"|"+x.Key.sk,x]));
  const o=byKey["ORPHAN_DELETE#"+input.id+"|STATE"];
  assert.ok(o.ConditionExpression.includes("#phase=:fenced"));
  assert.ok(o.ConditionExpression.includes("#version=:version"));
  assert.equal(o.ExpressionAttributeValues[":target"],input.targetId);
  assert.equal(o.ExpressionAttributeValues[":actor"],input.actorSubject);
  assert.ok(o.ConditionExpression.includes("attribute_not_exists(providerEtag)"));
  const lock=byKey["ORPHAN_CASE_LOCK#"+input.caseId+"|STATE"];
  assert.ok(lock.ConditionExpression.includes("operationId=:id"));
  assert.ok(lock.ConditionExpression.includes("caseUpdatedAt=:caseVersion"));
  const review=byKey["REVIEW_CASE#"+input.caseId+"|STATE"];
  assert.ok(review.ConditionExpression.includes("attribute_not_exists(operationId)"));
  const fence=byKey["ERASURE#home|FENCE"];
  assert.ok(fence.ConditionExpression.includes("#state=:active"));
  assert.equal(fence.ExpressionAttributeValues[":id"],input.id);
  assert.equal(byKey["ERASURE#home|EPOCH"].ExpressionAttributeValues[":epoch"],7);
  assert.equal(checks.length,5);
  for(const action of transaction.input.TransactItems){
    const entry=action.Put||action.ConditionCheck||action.Delete||action.Update;
    const tokens=[...new Set((entry.ConditionExpression||"").match(/:[A-Za-z][A-Za-z0-9_]*/g)||[])].sort();
    assert.deepEqual(Object.keys(entry.ExpressionAttributeValues||{}).sort(),tokens,
      "DynamoDB must not receive unused expression values");
  }
  const serial=JSON.stringify(markers);
  assert.equal(serial.includes(input.targetId),false);
  assert.equal(serial.includes(input.id),false);
});
test("a Calendar singleton marks only the affected calendar profile, without touching Todoist",()=>{
  const input=op("calendar");
  const {markers,checks}=split(orphanReplayInstallTransaction(input,10));
  assert.equal(markers.length,1);
  assert.equal(markers[0].Item.pk,"ERASURE_REPLAY#home");
  assert.ok(markers[0].Item.sk.startsWith("EVENT#key1#"));
  assert.equal(checks.find(c=>c.Key.pk==="ORPHAN_DELETE#"+input.id)
    .ExpressionAttributeValues[":etag"],input.providerEtag);
});
test("builder rejects ungated installs and incomplete fencing identity",()=>{
  for(const [name,value] of [
    ["ORPHAN_DELETION_EXECUTION_ENABLED","false"],
    ["ERASURE_PROTOCOL_VERSION","0"],
    ["ERASURE_REPLAY_BARRIER_VERSION","0"],
  ]){
    const before=process.env[name];
    process.env[name]=value;
    assert.throws(()=>orphanReplayInstallTransaction(op(),7),ErasureReplayUnavailableError);
    process.env[name]=before;
  }
  for(const [operation,epoch] of [
    [{...op(),phase:"confirmed"},7],
    [{...op(),phase:"provider_absent"},7],
    [{...op(),providerDigest:"not-a-digest"},7],
    [{...op(),targetId:"bad\nid"},7],
    [{...op(),profile:"foreign"},7],
    [{...op(),side:"calendar"},7],
    [{...op(),version:0},7],
    [op(),0],
    [op(),Number.NaN],
  ]) assert.throws(()=>orphanReplayInstallTransaction(operation,epoch),ErasureReplayUnavailableError);
});
test("matching persisted guard and all markers are required with strongly consistent reads",async()=>{
  const operation=op();
  const {markers,guard}=split(orphanReplayInstallTransaction(operation,7));
  const rows=new Map([...markers.map(x=>x.Item),guard.Item].map(x=>[x.pk+"|"+x.sk,x]));
  const reads=[];
  const db={send:async command=>{
    assert.equal(command.constructor.name,"GetCommand");
    assert.equal(command.input.ConsistentRead,true);
    reads.push(command.input.Key);
    return {Item:rows.get(command.input.Key.pk+"|"+command.input.Key.sk)};
  }};
  await assertOrphanReplayGuard(operation,db);
  assert.equal(reads.length,4);
  await assert.rejects(assertReplayAdmission({profile:"work",taskId:operation.targetId},db),
    ErasureReplayBlockedError);
  for(const item of markers){
    rows.delete(item.Item.pk+"|"+item.Item.sk);
    await assert.rejects(assertOrphanReplayGuard(operation,db),ErasureReplayUnavailableError);
    rows.set(item.Item.pk+"|"+item.Item.sk,item.Item);
  }
  const changed={...operation,providerDigest:"b".repeat(64)};
  await assert.rejects(assertOrphanReplayGuard(changed,db),ErasureReplayUnavailableError);
  rows.delete(guard.Item.pk+"|"+guard.Item.sk);
  await assert.rejects(assertOrphanReplayGuard(operation,db),ErasureReplayUnavailableError);
});
test("historical key retention lets an installed guard survive HMAC key rotation",async()=>{
  const operation=op("calendar");
  const {markers,guard}=split(orphanReplayInstallTransaction(operation,7));
  const rows=new Map([...markers.map(x=>x.Item),guard.Item].map(x=>[x.pk+"|"+x.sk,x]));
  process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="key2";
  process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({
    previous:Buffer.alloc(32,1).toString("base64"),
    key1:Buffer.alloc(32,2).toString("base64"),
    key2:Buffer.alloc(32,3).toString("base64"),
  });
  try {
    await assertOrphanReplayGuard(operation,{send:async command=>({
      Item:rows.get(command.input.Key.pk+"|"+command.input.Key.sk),
    })});
  } finally {
    process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="key1";
    process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({
      previous:Buffer.alloc(32,1).toString("base64"),
      key1:Buffer.alloc(32,2).toString("base64"),
    });
  }
});
test("marker verification never hides DynamoDB read failures or disabled admission",async()=>{
  const operation=op();
  await assert.rejects(assertOrphanReplayGuard(operation,{send:async()=>{throw Error("DDB error")}}),
    ErasureReplayUnavailableError);
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  try {
    await assert.rejects(assertOrphanReplayGuard(operation,{send:async()=>{throw Error("unexpected read")}}),
      ErasureReplayUnavailableError);
  } finally {process.env.ERASURE_REPLAY_BARRIER_VERSION="1";}
});
