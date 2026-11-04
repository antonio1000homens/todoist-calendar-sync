import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReplayAdmission, atomicReplayRelease, ErasureReplayBlockedError,
  ErasureReplayUnavailableError, REPLAY_PROFILES,
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
  assert.equal(reads.length,2);
  assert.ok(reads.every(row=>row.pk==="ERASURE_REPLAY#home"));
  assert.ok(reads.every(row=>row.sk.startsWith("EVENT#")));
});

function proof(){
  return {
    operationId:"operator-operation-id",epoch:7,
    confirmationId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    inspectedFingerprint:"a".repeat(64),postflightFingerprint:"b".repeat(64),
    originalPreviewFingerprint:"c".repeat(64),
    reviewedAt:"2026-11-03T19:40:00.000Z",
    identity:{profile:"work",taskId:"deleted-task",eventIds:["deleted-event","deleted-alias"]},
    calendarAliases:{home:[],antonio:[],work:["deleted-event","deleted-alias"]},
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
  assert.ok(tx.some(x=>x.Delete?.Key.pk.startsWith("ERASURE_POSTWRITE_CONFIRMATION#")
    &&x.Delete.ConditionExpression.includes("#status=:consumed")));
  assert.ok(tx.some(x=>x.Delete?.Key.pk.startsWith("ERASURE_OPERATION#")
    &&x.Delete.ConditionExpression.includes("postwriteReview.mode=:mode")
    &&x.Delete.ConditionExpression.includes("postwriteReview.postflightFingerprint=:postflight")
    &&x.Delete.ConditionExpression.includes("postwriteReview.#status=:reviewed")
    &&x.Delete.ConditionExpression.includes("attribute_not_exists(recovery)")));
  // Every action's value map must match its own condition exactly. DynamoDB
  // rejects unused values (even if used by a neighbouring transaction action).
  for (const action of tx) {
    const entry=action.Put||action.Delete||action.ConditionCheck||action.Update;
    const expressions=[entry.ConditionExpression,entry.UpdateExpression,
      entry.FilterExpression].filter(Boolean).join(" ");
    const referenced=[...new Set(expressions.match(/:[A-Za-z][A-Za-z0-9_]*/g)||[])].sort();
    const provided=Object.keys(entry.ExpressionAttributeValues||{}).sort();
    assert.deepEqual(provided,referenced,
      `Unused or missing DynamoDB placeholders for ${JSON.stringify(entry.Key||entry.Item)}`);
  }
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
    {inspectedFingerprint:"not-a-hash"},
    {originalPreviewFingerprint:""},
    {reviewedAt:"not-a-timestamp"},
    {confirmationId:"non-uuid-token"},
    {identity:{profile:"work",taskId:"deleted-task",eventIds:[]}},
    {calendarAliases:{home:[],antonio:[],work:["deleted-event"]}},
    {calendarAliases:{home:[],work:["deleted-event","deleted-alias"]}},
    {calendarAliases:{home:[],antonio:[],work:["deleted-event","deleted-event"]}},
    {calendarAliases:{home:[],antonio:[],work:Array.from({length:33},(_,i)=>"event-"+i)}},
    {identity:{profile:"work",taskId:"deleted-task",eventIds:Array.from({length:33},(_,i)=>"event-"+i)}},
  ]) assert.throws(()=>atomicReplayRelease({...proof(),...patch}),ErasureReplayUnavailableError);
});

test("release transaction matches the exact reviewed-fenced and consumed-token schema from #304",()=>{
  const input=proof();
  const tx=atomicReplayRelease(input).input.TransactItems;
  const operation=tx.find(x=>x.Delete?.Key?.pk==="ERASURE_OPERATION#"+input.operationId)?.Delete;
  const token=tx.find(x=>x.Delete?.Key?.pk==="ERASURE_POSTWRITE_CONFIRMATION#"+input.operationId)?.Delete;
  assert.ok(operation && token);
  const sourceOperation={
    status:"review_required",profile:"work",
    selectedActions:{deleteTodoist:true,deleteCalendar:true},target:{deleteCalendar:true},
    actionPlan:{todoistTask:{id:"deleted-task"},calendarEvent:{id:"deleted-event"}},
    previewFingerprint:input.originalPreviewFingerprint,updatedAt:input.reviewedAt,
    postwriteReview:{mode:"post_write",status:"reviewed_fenced",epoch:7,
      confirmationId:input.confirmationId,inspectedFingerprint:input.inspectedFingerprint,
      postflightFingerprint:input.postflightFingerprint,reviewedAt:input.reviewedAt},
  };
  const sourceToken={
    mode:"post_write",status:"consumed",operationId:input.operationId,profile:"work",epoch:7,
    confirmationId:input.confirmationId,inspectedFingerprint:input.inspectedFingerprint,
    postflightFingerprint:input.postflightFingerprint,
    originalPreviewFingerprint:input.originalPreviewFingerprint,
  };
  // Validate each attribute referenced by the DynamoDB condition actually
  // exists on the separate durable operation and token shapes from PR #304.
  for(const key of ["status","mode","epoch","confirmationId","inspectedFingerprint",
    "postflightFingerprint","reviewedAt"])
    assert.equal(sourceOperation.postwriteReview[key], key==="status"?"reviewed_fenced":
      key==="mode"?"post_write":key==="epoch"?7:input[key]);
  for(const [name,value] of Object.entries({
    ":required":"review_required",":reviewed":"reviewed_fenced",
    ":mode":"post_write",":epoch:":7,
  })) {
    if(name===":epoch:")continue;
    assert.equal(operation.ExpressionAttributeValues[name],value);
  }
  assert.ok(operation.ConditionExpression.includes("postwriteReview.#status=:reviewed"));
  assert.ok(operation.ConditionExpression.includes("postwriteReview.reviewedAt=:reviewedAt"));
  assert.ok(operation.ConditionExpression.includes("updatedAt=:reviewedAt"));
  assert.ok(operation.ConditionExpression.includes("selectedActions.deleteCalendar=:yes"));
  assert.ok(operation.ConditionExpression.includes("selectedActions.deleteTodoist=:yes"));
  assert.ok(operation.ConditionExpression.includes("attribute_exists(actionPlan.calendarEvent)"));
  assert.ok(operation.ConditionExpression.includes("attribute_exists(actionPlan.todoistTask)"));
  assert.ok(operation.ConditionExpression.includes("attribute_not_exists(recovery)"));
  assert.ok(token.ConditionExpression.includes("originalPreviewFingerprint=:original"));
  assert.ok(token.ConditionExpression.includes("attribute_not_exists(expiresAtMs)"));
  assert.equal(token.ExpressionAttributeValues[":inspected"],sourceToken.inspectedFingerprint);
  assert.equal(token.ExpressionAttributeValues[":postflight"],sourceToken.postflightFingerprint);
  assert.equal(token.ExpressionAttributeValues[":original"],sourceToken.originalPreviewFingerprint);
  assert.equal(token.ExpressionAttributeValues[":epoch"],sourceToken.epoch);
  assert.equal(sourceOperation.updatedAt,sourceOperation.postwriteReview.reviewedAt);
  assert.equal(sourceToken.status,"consumed");
});
test("cross-profile Calendar aliases create scoped HMAC markers without blocking unrelated event IDs",()=>{
  const p={...proof(),calendarAliases:{
    home:["home-recurring-master"],antonio:["antonio-moved-instance"],
    work:["deleted-event","deleted-alias"]}};
  const tx=atomicReplayRelease(p).input.TransactItems;
  const markerPuts=tx.filter(x=>x.Put).map(x=>x.Put);
  assert.equal(markerPuts.length,REPLAY_PROFILES.length+4);
  assert.equal(markerPuts.filter(x=>x.Item.sk.startsWith("EVENT#")).length,4);
  for(const profile of REPLAY_PROFILES){
    const expected=p.calendarAliases[profile].length;
    assert.equal(markerPuts.filter(x=>x.Item.sk.startsWith("EVENT#")
      &&x.Item.pk==="ERASURE_REPLAY#"+profile).length,expected);
  }
  assert.equal(markerPuts.some(x=>Object.keys(x.Item).some(key=>key==="taskId"||key==="eventId")),false);
  assert.equal(JSON.stringify(markerPuts).includes("home-recurring-master"),false);
  assert.equal(JSON.stringify(markerPuts).includes("antonio-moved-instance"),false);
  const original=atomicReplayRelease(proof()).input.TransactItems;
  assert.equal(original.filter(x=>x.Put).length,REPLAY_PROFILES.length+2,
    "unrelated calendars are not automatically marked");
});
test("overflow of one DynamoDB transaction refuses release instead of split batches",()=>{
  const p={...proof(),identity:{
    ...proof().identity,eventIds:Array.from({length:32},(_,i)=>"work-"+i)},
    calendarAliases:{
      home:Array.from({length:32},(_,i)=>"home-"+i),
      antonio:Array.from({length:32},(_,i)=>"antonio-"+i),
      work:Array.from({length:32},(_,i)=>"work-"+i),
    }};
  assert.throws(()=>atomicReplayRelease(p),ErasureReplayUnavailableError);
});
