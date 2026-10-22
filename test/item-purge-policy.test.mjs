import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {planPurge, fingerprint} from "../scripts/item-purge-policy.mjs";

const target = {profile:"home",taskId:"task-123",eventId:"evt_123"};
function record(pk, sk="STATE", values={}) {return {pk,sk,...values};}
test("inventories all direct mapping indexes and other state with exact keys", () => {
  const rows=[
    record("TASK#home#task-123","MAP",{profile:"home",taskId:"task-123",eventId:"evt_123"}),
    record("EVENT#home#evt_123","MAP",{profile:"home",taskId:"task-123",eventId:"evt_123"}),
    record("TASKOWNER#task-123","MAP",{profile:"home",taskId:"task-123",eventId:"evt_123"}),
    record("BASELINE#home#TASK#task-123","RECONCILE",{taskId:"task-123"}),
    record("CANONICAL#home#todoist#task-123","STATE",{providerId:"task-123"}),
    record("CANONICAL#home#calendar#evt_123","STATE",{providerId:"evt_123"}),
    record("AUDIT#home#123","STATE",{detail:{taskId:"task-123"}}),
    record("VERSION#TASK#task-123"),
    record("DELIVERY#todoist:task-123:change"),
  ];
  const result=planPurge(rows,target);
  assert.equal(result.records.length,rows.length);
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.records.find(item=>item.type==="TASKOWNER").reasons.length>0,true);
});
test("includes hashed conflict lifecycle record without a raw provider ID",()=>{
 const hash=createHash("sha256").update("taskId:task-123").digest("hex");
 const result=planPurge([record("CONFLICT_STATE#home#"+hash)],target);
 assert.equal(result.records.length,1);
 assert.equal(result.blockers.length,0);
});
test("never matches a partial provider ID or fuzzy title",()=>{
 const rows=[
   record("TASK#home#task-12345","MAP",{profile:"home",taskId:"task-12345",eventId:"evt_12345"}),
   record("AUDIT#home#999","STATE",{detail:{title:"task-123"}}),
   record("CONFLICT_STATE#work#"+createHash("sha256").update("taskId:task-123").digest("hex")),
 ];
 assert.equal(planPurge(rows,target).records.length,0);
});
test("blocks shared records, cross-profile references, and other events",()=>{
 const rows=[
  record("REPAIR#rep1","STATE",{preview:{intent:{profile:"home",taskId:"task-123",eventId:"evt_123"},
   snapshots:[{ref:{side:"todoist",id:"different-task"}}]}}),
  record("EVENT#work#evt_123","MAP",{profile:"work",taskId:"task-123",eventId:"evt_123"}),
  record("COMPLETED_TASK#home#task-123","EVENT#different-event",{profile:"home",taskId:"task-123",eventId:"different-event"}),
 ];
 const plan=planPurge(rows,target);
 assert.equal(plan.records.length,3);
 assert.equal(plan.blockers.some(x=>x.includes("another Todoist")),true);
 assert.equal(plan.blockers.some(x=>x.includes("different profile")),true);
 assert.equal(plan.blockers.some(x=>x.includes("another Calendar")),true);
});
test("recurring mappings refuse automatically, including master ownership",()=>{
 const row=record("TASK#home#task-123","MAP",{profile:"home",taskId:"task-123",eventId:"evt_123",
  seriesId:"cal-series",masterEventId:"cal-master",recurrenceOwner:"calendar"});
 assert.match(planPurge([row],target).blockers.join(" "),/recurrence\/series/);
});
test("linked review cases are included through sourceAuditKey",()=>{
 const audit=record("AUDIT#home#77","STATE",{detail:{taskId:"task-123"}});
 const review=record("REVIEW_CASE#abc","STATE",{profile:"home",sourceAuditKey:audit.pk});
 const result=planPurge([audit,review],target);
 assert.equal(result.records.length,2);
});
test("includes redacted audit through a selected review case and referenced manual record",()=>{
 const audit=record("AUDIT#home#redacted","STATE",{detail:{redacted:true}});
 const decision=record("MANUAL#decision-xyz","STATE",{profile:"home",context:{providerTaskId:"task-123"}});
 const review=record("REVIEW_CASE#xyz","STATE",{profile:"home",taskId:"task-123",
   sourceAuditKey:audit.pk,decision:{decisionId:"decision-xyz"}});
 const result=planPurge([audit,decision,review],target);
 assert.equal(result.records.length,3);
 assert.deepEqual(result.blockers,[]);
});
test("rejects malformed selectors, malformed scan keys, and duplicate rows",()=>{
 assert.throws(()=>planPurge([], {profile:"invalid",taskId:"123"}));
 assert.throws(()=>planPurge([{pk:"oops"}],target));
 assert.throws(()=>planPurge([record("A"),record("A")],target));
});
test("fingerprinting is key-order independent and changes with record revision",()=>{
 const a=fingerprint({pk:"x",nested:{b:1,a:2}});
 assert.equal(a,fingerprint({nested:{a:2,b:1},pk:"x"}));
 const original=record("AUDIT#home#123","STATE",{detail:{taskId:"task-123"}});
 const revision=record("AUDIT#home#123","STATE",{detail:{taskId:"task-123"},updatedAt:"later"});
 assert.notEqual(planPurge([original],target).inventoryDigest,planPurge([revision],target).inventoryDigest);
});
