import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {assessUnmappedConflictDeletion} from "../dist/unmapped-deletion-assessment.js";

const profile="home";
const taskId="6hqpHPG5fPWF33Hj";
const masterId="ln6kesr1avdg9ob1ptprcsdar0";
const activeId=masterId+"_20271101";
const base={
  id:"home-todoist_unmapped_conflict-b5ddd1bdb8d270d07ce1",
  profile,status:"open",title:"Annual fixture",reason:"calendar_snapshot_recurring_identity_conflict",
  eventId:activeId,createdAt:"2026-10-25T20:01:31Z",updatedAt:"2026-10-25T20:01:31Z",
  decision:{type:"todoist_unmapped_conflict",eventId:activeId,masterEventId:masterId,
    context:{candidateTaskIds:[taskId],masterEventId:masterId,eventId:activeId}},
};
const observedAt="2026-11-07T12:00:00Z";
const snapshot=(side,id,object,extra={})=>({ref:{profile,side,id},object,checkedAt:observedAt,...extra});
const task=snapshot("todoist",taskId,null);
const master=snapshot("calendar",masterId,{id:masterId,status:"cancelled",
  recurrence:["RRULE:FREQ=YEARLY"]});
const occurrence=snapshot("calendar",activeId,{id:activeId,status:"cancelled",recurringEventId:masterId});
const records=[task,master,occurrence];

test("#278 fully deleted unmapped annual fixture is visible as provider-deleted, not an approved purge",()=>{
  const result=assessUnmappedConflictDeletion(base,records);
  assert.equal(result?.state,"providers_deleted");
  assert.equal(result?.bothGone,true);
  assert.deepEqual(result.taskIds,[taskId]);
  assert.deepEqual(result.eventIds.slice().sort(),[activeId,masterId].sort());
  assert.match(result.reason,/still require guarded reconciliation/);
  const reverse=assessUnmappedConflictDeletion(base,[occurrence,task,master]);
  assert.deepEqual(reverse,result,"the order of provider deletion/readback must not change eligibility");
});

test("#478 deleted standalone Todoist and one-off Calendar identities become guarded-cleanup evidence",()=>{
  const oneOffTask="6hxGHMrqcFPwVqFf",oneOffEvent="p1dk5e55fotqv011l4cibo2bt0";
  const item={id:"work-standalone_todoist_task_deleted-fixture",profile:"work",status:"open",
    title:"Disposable one-off",reason:"standalone_todoist_task_deleted",taskId:oneOffTask,eventId:oneOffEvent,
    decision:{type:"standalone_todoist_task_deleted",taskId:oneOffTask,eventId:oneOffEvent}};
  const evidence=[{...snapshot("todoist",oneOffTask,null),ref:{profile:"work",side:"todoist",id:oneOffTask}},
    {...snapshot("calendar",oneOffEvent,{id:oneOffEvent,status:"cancelled"}),ref:{profile:"work",side:"calendar",id:oneOffEvent}}];
  const result=assessUnmappedConflictDeletion(item,evidence);
  assert.equal(result?.state,"providers_deleted");
  assert.equal(result?.bothGone,true);
  assert.match(result.reason,/one-off provider identities are deleted/);
  assert.deepEqual(result.taskStates,[{id:oneOffTask,state:"deleted"}]);
  assert.deepEqual(result.eventStates,[{id:oneOffEvent,state:"deleted"}]);
  assert.equal(assessUnmappedConflictDeletion(item,[evidence[0],{...evidence[1],lookupError:"HTTP 429"}])?.bothGone,false);
});

test("#278 live Calendar master protects the annual fixture even after Todoist 404 and cancelled occurrence",()=>{
  const liveMaster=snapshot("calendar",masterId,{id:masterId,status:"confirmed",
    recurrence:["RRULE:FREQ=YEARLY"]});
  const result=assessUnmappedConflictDeletion(base,[task,liveMaster,occurrence]);
  assert.equal(result?.state,"partial");
  assert.equal(result?.bothGone,false);
  assert.deepEqual(result.eventStates.find(x=>x.id===masterId),{id:masterId,state:"live"});
});

test("#278 deleted Calendar but still-active Todoist task also remains one-sided",()=>{
  const liveTask=snapshot("todoist",taskId,{id:taskId,is_deleted:false,
    content:"Annual test",due:{is_recurring:true,string:"every 1 November"}});
  const result=assessUnmappedConflictDeletion(base,[liveTask,master,occurrence]);
  assert.equal(result?.state,"partial");
  assert.equal(result?.bothGone,false);
  assert.deepEqual(result.taskStates,[{id:taskId,state:"live"}]);
});

test("#278 incomplete snapshots, errors, unrelated profile, missing master or ambiguous status fail closed",()=>{
  const altered=[
    records.slice(0,2),
    [task,master,{...occurrence,lookupError:"HTTP 429"}],
    [task,master,{...occurrence,checkedAt:undefined}],
    [task,master,{...occurrence,object:{id:"other",status:"cancelled"}}],
    [task,master,{...occurrence,ref:{profile:"work",side:"calendar",id:activeId}}],
    [task,master,{...occurrence,object:{id:activeId,status:"tentative"}}],
    [task,master,occurrence,occurrence],
  ];
  for(const rows of altered){
    const result=assessUnmappedConflictDeletion(base,rows);
    assert.equal(result?.state,"unverified");
    assert.equal(result?.bothGone,false);
  }
});

test("#278 no cross-issue deletion preview for operation failures or incomplete case identity",()=>{
  const operational={...base,reason:"operational_dlq",decision:{type:"operational_dlq"}};
  assert.equal(assessUnmappedConflictDeletion(operational,records),undefined);
  const incomplete={...base,eventId:undefined,decision:{type:"todoist_unmapped_conflict"}};
  assert.equal(assessUnmappedConflictDeletion(incomplete,records)?.state,"unverified");
});

test("#278 review API refresh and UI use same non-mutating evidence, with no repair for both absent",async()=>{
  const [api,ui]=await Promise.all([
    readFile(new URL("../src/review-api.ts",import.meta.url),"utf8"),
    readFile(new URL("../review-ui/main.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(api,/assessUnmappedConflictDeletion\(item,snapshots\)/);
  assert.match(api,/return response\(200,\{item,snapshots,deletionCleanup,unmappedDeletion\}/);
  assert.match(ui,/unmappedDeletion:result\.unmappedDeletion/);
  assert.match(ui,/orphanItemsForCase\(\{item:details\.item,snapshots:details\.snapshots\|\|\[\]\}\)\.length>0/);
  assert.match(ui,/<OrphanDeletionPanel/);
  assert.match(ui,/\(hasProviderIds\|\|hasLiveIdentity\)&&<div className="preview">/);
  assert.match(ui,/One-sided deletion — no automatic purge/);
  assert.match(ui,/Retry guarded cleanup for this alert via/);
  assert.match(ui,/Recheck this alert&apos;s provider items \(read-only\)/);
  assert.match(ui,/Resolved — verified deletion \/ stale state retired/);
});
