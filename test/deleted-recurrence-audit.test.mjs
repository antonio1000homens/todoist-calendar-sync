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
function fixture({task=gone,eventMaster=master,eventActive=active,foreign=false,
  instances=[{id:activeId,status:"cancelled",recurringEventId:masterId,iCalUID:uid}]}={}){
  const reads=[],writes=[];
  const calendar={async getEvent(id){
    reads.push("calendar:"+id);
    if(id===masterId)return eventMaster;
    if(id===activeId)return eventActive;
    throw Object.assign(new Error("not found"),{status:404});
  },async listEventInstances(id){
    reads.push("instances:"+id);
    return instances;
  }};
  const todoist={async getTask(id){reads.push("todoist:"+id);return task(id);}};
  const state={
    async getCompletedCalendarProjectionByEvent(profile,id){
      reads.push("completed:"+profile+":"+id);
      return undefined;
    },
    async getMappingByTaskAnyProfile(id){reads.push("task-owner:"+id);return undefined;},
    async getMappingByEvent(profile,id){reads.push("event-owner:"+profile+":"+id);return undefined;},
    async getRecurrenceLink(profile,key){reads.push("link:"+profile+":"+key);
      if(foreign && profile==="work" && key===uid) return {...link,profile:"work",owner:"calendar",seriesId:uid};
      return profile==="antonio" && key===taskId?link:undefined;},
  };
  return {provider:{calendar,todoist},state,reads,writes};
}

test("deleted-series dry-run derives master by readback, remains repeatable and read-only",async()=>{
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
  assert.equal(f.reads.filter(x=>x==="instances:"+masterId).length,2);
  assert.equal(one.instanceAssessment.valid,true);
  assert.deepEqual(f.writes,[],"the audit cannot mutate provider or DynamoDB state");
});

async function expectReadOnlyManualReview(f, label, checkInvalidInstances = false) {
  const result = await auditDeletedRecurrenceCase(item, f.provider, f.state);
  assert.equal(result.action, "retain_for_manual_review", label);
  if (checkInvalidInstances) {
    assert.equal(result.instanceAssessment?.valid, false, label);
  } else {
    assert.equal(result.deletion.bothGone, false, label);
  }
  assert.deepEqual(f.writes, [], label + " must never mutate provider or state");
  return result;
}

test("deleted-series audit fails closed for live, foreign or unverified references", async t => {
  const scenarios = [
    { name: "Todoist task is still live", input: { task: async () => ({ id: taskId, due: { is_recurring: true } }) } },
    { name: "Calendar master is confirmed", input: { eventMaster: { ...master, status: "confirmed" } } },
    { name: "Calendar occurrence is confirmed", input: { eventActive: { ...active, status: "confirmed" } } },
    { name: "another profile owns the series", input: { foreign: true } },
    { name: "occurrence points at a different master", input: { eventActive: { ...active, recurringEventId: "different-master" } } },
    { name: "direct master lookup is missing", input: { eventMaster: null } },
    { name: "Todoist read is rate-limited", input: { task: async () => { throw Object.assign(new Error("throttled"), { status: 429 }); } } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await expectReadOnlyManualReview(fixture(scenario.input), scenario.name);
    });
  }
});

test("deleted-series audit never guesses an unrecorded master from occurrence ID",async()=>{
  const f=fixture({eventActive:null});
  const result=await auditDeletedRecurrenceCase(item,f.provider,f.state);
  assert.equal(result.action,"retain_for_manual_review");
  assert.equal(result.deletion.bothGone,false);
  assert.ok(!f.reads.includes("calendar:"+masterId),
    "the master must not be guessed by stripping an instance ID suffix");
});

test("deleted-series audit rejects missing, active and incomplete instance lists", async t => {
  const scenarios = [
    { name: "empty instance enumeration", instances: [] },
    { name: "active instance remains confirmed", instances: [
      { id: activeId, status: "confirmed", recurringEventId: masterId, iCalUID: uid },
    ] },
    { name: "future confirmed instance remains", instances: [
      { id: "future", status: "confirmed", recurringEventId: masterId, iCalUID: uid, start: { date: "2026-12-16" } },
      { id: activeId, status: "cancelled", recurringEventId: masterId, iCalUID: uid },
    ] },
    { name: "instance belongs to a different master", instances: [
      { id: activeId, status: "cancelled", recurringEventId: "foreign", iCalUID: uid },
    ] },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await expectReadOnlyManualReview(fixture({ instances: scenario.instances }), scenario.name, true);
    });
  }
});
