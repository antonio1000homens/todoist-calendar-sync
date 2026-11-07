import test from "node:test";
import assert from "node:assert/strict";
import {auditDeletedRecurrenceCase} from "../scripts/deleted-recurrence-audit.mjs";

const taskId="6hqp4fFR45WvJ5VV";
const masterId="agejr3i89v5p13lfl95uss11o8";
const activeId=masterId+"_20261116";
const uid=masterId+String.fromCharCode(64)+"google.com";
const caseId="antonio-todoist_owned_recurrence_task_deleted-1227dad2ad8dd7071bdb";
const link={profile:"antonio",owner:"todoist",seriesId:taskId,taskId,
  eventId:activeId,activeInstanceId:activeId,updatedAt:"2026-10-25T19:09:07.680Z"};
const item={id:caseId,profile:"antonio",status:"dismissed",taskId,eventId:activeId,
  decision:{type:"todoist_owned_recurrence_task_deleted",taskId,eventId:activeId,
    activeInstanceId:activeId,seriesId:taskId,mappingSnapshot:{...link,recurrenceOwner:"todoist"}}};
const master={id:masterId,status:"cancelled",iCalUID:uid,
  recurrence:["RRULE:FREQ=WEEKLY;COUNT=4"]};
const active={id:activeId,status:"cancelled",recurringEventId:masterId,iCalUID:uid};
const gone=()=>{throw Object.assign(new Error("not found"),{status:404});};
function fixture({task=gone,eventMaster=master,eventActive=active,foreign=false}={}){
  const reads=[],writes=[];
  const calendar={async getEvent(id){
    reads.push("calendar:"+id);
    if(id===masterId)return eventMaster;
    if(id===activeId)return eventActive;
    throw Object.assign(new Error("not found"),{status:404});
  }};
  const todoist={async getTask(id){reads.push("todoist:"+id);return task(id);}};
  const state={
    async getMappingByTaskAnyProfile(id){reads.push("task-owner:"+id);return undefined;},
    async getMappingByEvent(profile,id){reads.push("event-owner:"+profile+":"+id);return undefined;},
    async getRecurrenceLink(profile,key){reads.push("link:"+profile+":"+key);
      if(foreign && profile==="work" && key===uid) return {...link,profile:"work",owner:"calendar",seriesId:uid};
      return profile==="antonio" && key===taskId?link:undefined;},
  };
  return {provider:{calendar,todoist},state,reads,writes};
}

test("#292 legacy both-deleted dry-run derives master by readback and is repeatable and read-only",async()=>{
  const f=fixture();
  const one=await auditDeletedRecurrenceCase(item,f.provider,f.state);
  const two=await auditDeletedRecurrenceCase(item,f.provider,f.state);
  assert.equal(one.deletion.state,"stale_recurrence");
  assert.equal(two.deletion.state,"stale_recurrence");
  assert.equal(one.deletion.bothGone,true);
  assert.equal(one.deletion.masterId,masterId);
  assert.deepEqual(one.deletion.eventIds.slice().sort(),[activeId,masterId].sort());
  assert.deepEqual(one.recurrenceLinks.map(row=>row.seriesId),[taskId]);
  assert.equal(one.action,"candidate_for_guarded_reconciliation");
  assert.equal(f.reads.filter(x=>x==="calendar:"+masterId).length,2);
  assert.deepEqual(f.writes,[],"the audit cannot mutate provider or DynamoDB state");
});

test("#292 one-sided deletion, foreign owner and unverified provider never produce a cleanup candidate",async()=>{
  const cases=[
    fixture({task:async()=>({id:taskId,due:{is_recurring:true}})}),
    fixture({eventMaster:{...master,status:"confirmed"}}),
    fixture({eventActive:{...active,status:"confirmed"}}),
    fixture({foreign:true}),
    fixture({eventActive:{...active,recurringEventId:"different-master"}}),
    fixture({eventMaster:undefined}),
    fixture({task:async()=>{throw Object.assign(new Error("throttled"),{status:429});}}),
  ];
  for(const f of cases){
    const result=await auditDeletedRecurrenceCase(item,f.provider,f.state);
    assert.equal(result.action,"retain_for_manual_review");
    assert.equal(result.deletion.bothGone,false);
    assert.deepEqual(f.writes,[]);
  }
});

test("#292 unrecorded master cannot be inferred from an occurrence ID or missing direct child",async()=>{
  const f=fixture({eventActive:undefined});
  const result=await auditDeletedRecurrenceCase(item,f.provider,f.state);
  assert.equal(result.action,"retain_for_manual_review");
  assert.equal(result.deletion.bothGone,false);
  assert.ok(!f.reads.includes("calendar:"+masterId),
    "the master must not be guessed by stripping an instance ID suffix");
});
