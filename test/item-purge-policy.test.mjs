import test from "node:test";
import assert from "node:assert/strict";
import { runPurgeItem } from "../scripts/purge-item-service.mjs";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import {planPurge, fingerprint, publicInventoryRecord} from "../scripts/item-purge-policy.mjs";

test("standalone purge CLI parses without provider execution",()=>{
 assert.doesNotThrow(()=>execFileSync(process.execPath,["--check","scripts/purge-item.mjs"]));
});
test("purge service returns a read-only preview through injected clients",async()=>{
 const commands=[],outputs=[];
 const db={send:async command=>{commands.push(command.constructor.name);return command.constructor.name.includes("Scan")?{Items:[],ScannedCount:0}:{};}};
 const clients={todoist:{getTask:async()=>null,listProjectComments:async()=>[],listTaskComments:async()=>[],deleteTask:async()=>{},deleteComment:async()=>{}},
  calendar:{getEvent:async()=>null,findByTodoistTaskId:async()=>null,deleteEvent:async()=>{}}};
 const preview=await runPurgeItem({profile:"home",taskId:"task-123"},{
  db,lambda:{send:async()=>({})},clients,inspectErasureFence:async()=>({leases:[]}),sleep:async()=>{},onOutput:value=>outputs.push(value),
 });
 assert.equal(preview.mode,"preview");
 assert.deepEqual(outputs,[preview]);
 assert.ok(commands.includes("ScanCommand"));
 assert.ok(commands.includes("GetCommand"));
 assert.ok(commands.every(name=>!/(Put|Delete|Update|Transact)/.test(name)),"preview service must not issue writes");
});
test("purge keeps its recovery journal through mapping restore and final commit",()=>{
 const source=readFileSync(new URL("../scripts/purge-item-service.mjs",import.meta.url),"utf8");
 const executor=readFileSync(new URL("../src/erasure-executor.ts",import.meta.url),"utf8");
 assert.match(source,/finishFencedErasure\(\{enabledMappingIds:enabledMappings/);
 const restore=executor.indexOf("await input.restoreMappings(input.enabledMappingIds)");
 const finish=executor.indexOf("await input.finishFence()");
 assert.ok(restore>=0 && finish>restore,"mapping restoration must precede journal/fence deletion");
});
test("occurrence inventory flags cannot enter a destructive apply path",()=>{
 const env={...process.env}; delete env.STATE_TABLE_NAME;
 env.SYNC_PROFILE_CONFIG_JSON=JSON.stringify(Object.fromEntries(["home","antonio","work"].map(profile=>[profile,
  {calendarId:"calendar",channelId:"channel",todoistRoute:"route",todoistProjectId:"project"}])));
 for(const args of [
  ["--profile=home","--task-id=task-123","--inventory-only","--apply"],
  ["--profile=home","--task-id=task-123","--preserve-task","--apply","--confirm=x"],
 ]) {
  const result=spawnSync(process.execPath,["scripts/purge-item.mjs",...args],{env,encoding:"utf8"});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/never supports apply|Protected-item inventory is read-only/);
 }
});
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
test("partition-key scope and rejected-pair ownership block shared erasure",()=>{
 const rows=[
   record("AUDIT#work#99","STATE",{detail:{taskId:"task-123"}}),
   record("REJECTED_PAIR#home#task-123#other-event"),
   record("SYNC_CONTROL#work:todoist:task-123"),
 ];
 const result=planPurge(rows,target);
 assert.equal(result.records.length,3);
 assert.match(result.blockers.join(" "),/different profile/);
 assert.match(result.blockers.join(" "),/shared with another task\/event/);
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
 assert.throws(()=>planPurge([], {...target,protectedEventIds:["bad,id"]}));
});
test("fingerprinting is key-order independent and changes with record revision",()=>{
 const a=fingerprint({pk:"x",nested:{b:1,a:2}});
 assert.equal(a,fingerprint({nested:{a:2,b:1},pk:"x"}));
 const original=record("AUDIT#home#123","STATE",{detail:{taskId:"task-123"}});
 const revision=record("AUDIT#home#123","STATE",{detail:{taskId:"task-123"},updatedAt:"later"});
 assert.notEqual(planPurge([original],target).inventoryDigest,planPurge([revision],target).inventoryDigest);
});

test("occurrence inventory separates a standalone duplicate from protected recurring and completed state",()=>{
 const rows=[
  record("EVENT#home#standalone","MAP",{profile:"home",eventId:"evt_123"}),
  record("CANONICAL#home#calendar#evt_123","STATE",{profile:"home",providerId:"evt_123"}),
  record("EVENT#home#annual-master","MAP",{profile:"home",eventId:"annual-master",recurrence:["RRULE:FREQ=YEARLY"]}),
  record("CANONICAL#home#calendar#annual-master","STATE",{profile:"home",providerId:"annual-master"}),
  record("TASK#home#task-123","MAP",{profile:"home",taskId:"task-123",eventId:"annual-master"}),
  record("TASKOWNER#task-123","MAP",{profile:"home",taskId:"task-123",eventId:"annual-master"}),
  record("COMPLETED_TASK#home#completed-1","STATE",{profile:"home",taskId:"completed-1",eventId:"annual-master"}),
 ];
 const plan=planPurge(rows,{...target,preserveTask:true,protectedEventIds:["annual-master"]});
 const byKey=new Map(plan.records.map(row=>[row.pk,row]));
 assert.equal(byKey.get("EVENT#home#standalone").classification,"selected-only");
 assert.equal(byKey.get("CANONICAL#home#calendar#evt_123").classification,"selected-only");
 for(const key of ["EVENT#home#annual-master","CANONICAL#home#calendar#annual-master","TASK#home#task-123","TASKOWNER#task-123","COMPLETED_TASK#home#completed-1"])
   assert.equal(byKey.get(key).classification,"shared with protected state",key);
 assert.ok(plan.blockers.length);
});

test("cancelled occurrence inventory protects the active sibling mapping and task-scoped history",()=>{
 const rows=[
  record("EVENT#work#cancelled-20","MAP",{profile:"work",eventId:"cancelled-20",status:"cancelled",masterEventId:"annual-master"}),
  record("TASK#work#active-task","MAP",{profile:"work",taskId:"active-task",eventId:"active-21"}),
  record("TASKOWNER#active-task","MAP",{profile:"work",taskId:"active-task",eventId:"active-21"}),
  record("BASELINE#work#TASK#active-task","RECONCILE",{profile:"work",taskId:"active-task",lastEventId:"cancelled-20",canonicalDueDate:"2026-10-20"}),
  record("CANONICAL#work#calendar#active-21","STATE",{profile:"work",providerId:"active-21"}),
  record("CANONICAL#work#calendar#cancelled-20","STATE",{profile:"work",providerId:"cancelled-20"}),
 ];
 const plan=planPurge(rows,{profile:"work",taskId:"active-task",eventId:"cancelled-20",preserveTask:true,protectedEventIds:["active-21","annual-master"]});
 const byKey=new Map(plan.records.map(row=>[row.pk,row]));
 assert.equal(byKey.get("EVENT#work#cancelled-20").classification,"shared with protected state");
 assert.equal(byKey.get("TASK#work#active-task").classification,"shared with protected state");
 assert.equal(byKey.get("TASKOWNER#active-task").classification,"shared with protected state");
 assert.equal(byKey.get("BASELINE#work#TASK#active-task").classification,"shared with protected state");
 assert.equal(byKey.get("CANONICAL#work#calendar#active-21").classification,"shared with protected state");
 assert.equal(byKey.get("CANONICAL#work#calendar#cancelled-20").classification,"selected-only");
});

test("transitive review and decision records remain connected to the selected occurrence",()=>{
 const audit=record("AUDIT#home#occurrence-1","STATE",{detail:{eventId:"evt_123"}});
 const review=record("REVIEW_CASE#case-1","STATE",{sourceAuditKey:audit.pk,decision:{decisionId:"decision-1"}});
 const manual=record("MANUAL#decision-1","STATE",{profile:"home",status:"resolved"});
 const plan=planPurge([audit,review,manual],target);
 assert.deepEqual(new Set(plan.records.map(row=>row.pk)),new Set([audit.pk,review.pk,manual.pk]));
 assert.ok(plan.records.every(row=>row.classification==="selected-only"));
});

test("consolidated and owner-conflict records retain references to other task IDs",()=>{
 const rows=[
  record("CONSOLIDATED_TASK#home#discarded","STATE",{profile:"home",discardedTaskId:"task-123",retainedTaskId:"retained-task",cancelledEventId:"evt_123"}),
  record("AUDIT#home#owner-conflict","STATE",{detail:{taskId:"task-123",eventId:"evt_123",ownerTaskId:"owner-task"}}),
 ];
 const plan=planPurge(rows,target);
 assert.equal(plan.records.length,2);
 assert.ok(plan.records.every(item=>item.classification==="shared with protected state"));
 assert.ok(plan.blockers.length);
});

test("completed-series certificates are inventoried and protected through exact series identity",()=>{
 const rows=[
  record("EVENT#home#evt_123","MAP",{profile:"home",eventId:"evt_123",seriesId:"series-1"}),
  record("COMPLETED_SERIES#home#series-1","STATE",{profile:"home",seriesId:"series-1",masterEventId:"master-1"}),
 ];
 const plan=planPurge(rows,target);
 const certificate=plan.records.find(item=>item.type==="COMPLETED_SERIES");
 assert.equal(certificate?.classification,"shared with protected state");
 assert.ok(plan.blockers.some(blocker=>blocker.includes("recurring series")));
});

test("identity-free and target-linked pending deliveries are classified and block erasure",()=>{
 const rows=[
  record("DELIVERY#random-receipt","COMPLETED",{profile:"home",kind:"todoist-webhook"}),
  record("DELIVERY#task-123:event-abc","STATE",{taskId:"task-123",status:"pending"}),
 ];
 const plan=planPurge(rows,target);
 const byKey=new Map(plan.records.map(row=>[row.pk,row]));
 assert.equal(byKey.get("DELIVERY#random-receipt").classification,"unattributable");
 assert.equal(byKey.get("DELIVERY#task-123:event-abc").classification,"selected-only");
 assert.equal(plan.counts.unattributable,1);
 assert.equal(plan.counts["selected-only"],1);
 assert.equal(plan.blockers.length,2);
});

test("new delivery receipts are attributable by exact references but remain replay blockers",()=>{
 const rows=[
  record("DELIVERY#exact","COMPLETED",{profile:"home",kind:"todoist",identityRefs:{taskIds:["task-123"],eventIds:[],seriesIds:[]}}),
  record("DELIVERY#other","COMPLETED",{profile:"home",kind:"calendar",identityRefs:{taskIds:["other-task"],eventIds:["other-event"],seriesIds:[]}}),
 ];
 const plan=planPurge(rows,target);
 assert.deepEqual(plan.records.map(item=>item.pk),["DELIVERY#exact"]);
 assert.equal(plan.records[0].classification,"selected-only");
 assert.equal(plan.blockers.length,1);
 assert.match(plan.blockers[0],/replayable/);
});

test("legacy receipts without exact refs remain blockers until their retention expires",()=>{
 const plan=planPurge([
  record("DELIVERY#legacy","COMPLETED",{profile:"home",kind:"todoist"}),
 ],target);
 assert.equal(plan.records[0].classification,"unattributable");
 assert.match(plan.blockers[0],/no exact selected provider identity/);
});

test("public inventory rows expose the same classifications as their summary counts",()=>{
 const inventoryRecord=planPurge([record("TASK#home#task-123","MAP",{profile:"home",taskId:"task-123"})],target).records[0];
 assert.equal(publicInventoryRecord(inventoryRecord).classification,inventoryRecord.classification);
});

test("unrecognized partition-key suffixes do not create false cross-record links",()=>{
 const rows=[
  record("REVIEW_CASE#selected-case","STATE",{taskId:"task-123",decision:{decisionId:"decision-123"}}),
  record("CUSTOM#decision-123","STATE",{value:"unrelated"}),
 ];
 const plan=planPurge(rows,target);
 assert.deepEqual(plan.records.map(item=>item.pk),["REVIEW_CASE#selected-case"]);
});

test("unknown exact ID fields are included as ambiguous instead of treated as safe",()=>{
 const plan=planPurge([record("CUSTOM#opaque","STATE",{providerIdentity:"task-123"})],target);
 assert.equal(plan.records.length,1);
 assert.equal(plan.records[0].classification,"ambiguous");
 assert.ok(plan.blockers.length);
});
