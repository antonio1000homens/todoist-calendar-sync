import test from "node:test";
import assert from "node:assert/strict";
import { planRecurrenceRetirement, previewRecurrenceRetirement } from "../dist/recurrence-retirement-preview.js";

const target={profile:"work",generation:"1793982837494-t1u4ucsa",taskId:"task351",eventId:"occ_20261021",
  seriesId:"series-uid-351"};
const mapping={profile:"work",taskId:target.taskId,eventId:target.eventId,seriesId:target.seriesId,
  recurrenceOwner:"calendar",masterEventId:"master",activeInstanceId:target.eventId,updatedAt:"2026-10-22T10:00:00Z",
  projectCommentId:"project-comment-351"};
const link={profile:"work",taskId:target.taskId,eventId:target.eventId,seriesId:target.seriesId,
  owner:"calendar",masterEventId:"master",activeInstanceId:target.eventId,updatedAt:mapping.updatedAt};
const master={id:"master",iCalUID:target.seriesId,status:"confirmed",etag:"m-etag",
  recurrence:["RRULE:FREQ=DAILY;COUNT=2"],extendedProperties:{shared:{taskId:target.taskId}}};
const occurrence={id:target.eventId,iCalUID:target.seriesId,recurringEventId:"master",status:"confirmed",
  etag:"o-etag",start:{dateTime:"2026-10-21T08:30:00Z"}};
const completion={profile:"work",taskId:target.taskId,eventId:target.eventId,
  seriesId:target.seriesId,recurrenceOwner:"calendar",masterEventId:"master",
  completedAt:"2026-10-21T13:00:00Z",terminalVerified:true};
const terminal={profile:"work",seriesId:target.seriesId,recurrenceOwner:"calendar",
  masterEventId:"master",terminalCompletedAt:"2026-10-21T13:00:00Z"};
const recorded={...target,action:"todoist_snapshot_reconcile_recurring_deferred",
  reason:"recurrence_owned_mapping_deferred",sourceDeliveryId:"generation-351",
  observedAt:"2026-11-06T16:34:34Z",detail:{}};
const inspection={
  target,checkedAt:"2026-11-06T18:00:00Z",previewFingerprint:"sample-inspection-fingerprint",
  diagnostic:recorded,task:{status:"completed_verified",
    value:{id:target.taskId,content:"Threat modelling",completed_at:"2026-10-21T13:00:00Z"},source:"Todoist completed"},
  calendar:{master,occurrence,instances:[occurrence],source:"Calendar direct"},
  mapping,recurrenceLink:link,completionHistory:[completion],terminalSeries:terminal,
  indexKeys:[],historicalRowCounts:{},otherProfileReferences:[],blockers:[],
  eligibleForFutureApproval:true,providerWrites:false,
};
const kv=(pk,sk,rest={})=>({pk,sk,...rest});
function rows(){
  return [
    kv("TASK#work#"+target.taskId,"MAP",mapping),
    kv("TASKOWNER#"+target.taskId,"MAP",mapping),
    kv("EVENT#work#"+target.eventId,"MAP",mapping),
    kv("RECURRENCE#work#"+target.seriesId,"STATE",link),
    kv("BASELINE#work#TASK#"+target.taskId,"RECONCILE",{updatedAt:"2026-10-21T14:00:00Z",baseline:{todoist:{},calendar:{}}}),
    kv("CANONICAL#work#todoist#"+target.taskId,"STATE",{profile:"work",side:"todoist",providerId:target.taskId,identity:{x:1},updatedAt:"2026-10-21"}),
    kv("CANONICAL#work#calendar#"+target.eventId,"STATE",{profile:"work",side:"calendar",providerId:target.eventId,identity:{x:2},updatedAt:"2026-10-21"}),
    kv("COMPLETED_SERIES#work#"+target.seriesId,"STATE",terminal),
    kv("COMPLETED_EVENT#work#"+target.eventId,"STATE",{...completion}),
    kv("SYNC_CONTROL#work:todoist:"+target.taskId,"STATE",{pendingRefresh:false}),
    kv("AUDIT#work#old-incident","STATE",{detail:{taskId:target.taskId,eventId:target.eventId}}),
    kv("REVIEW_CASE#unrelated","STATE",{status:"dismissed",detail:{taskId:"somebody-else"}}),
  ];
}
test("#351 effect preview makes mapping, baseline and canonical removals explicit but never executes writes",()=>{
  const result=planRecurrenceRetirement(inspection,rows());
  assert.equal(result.status,"reviewable");
  assert.equal(result.indexRemovalCandidates.length,4);
  assert.equal(result.conditionalCleanupCandidates.length,3);
  assert.equal(result.incidentEvidenceForSeparateReview.length,1);
  assert.equal(result.protectedRecords.length,3);
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.applyAvailable,false);
  assert.equal(result.providerWrites,false);
  assert.equal(result.stateWrites,false);
  assert.ok(result.futureSuppressionIdentityKeys.includes("RETIREMENT#work#SERIES#"+target.seriesId));
  assert.ok(result.providerMetadataHazards.some(s=>s.includes("Todoist mapping comment")));
  assert.ok(result.providerMetadataHazards.some(s=>s.includes("Calendar shared taskId")));
  assert.ok(result.indexRemovalCandidates.every(x=>x.recordFingerprint.length===64));
  assert.ok(result.protectedRecords.some(x=>x.pk==="COMPLETED_EVENT#work#"+target.eventId));
});
test("#351 incomplete mapping inventory or unexpected index revision fails closed",()=>{
  const list=rows().filter(x=>x.pk!=="TASKOWNER#"+target.taskId);
  const result=planRecurrenceRetirement(inspection,list);
  assert.equal(result.status,"blocked");
  assert.match(result.blockers.join(" / "),/expected mapping\/link state key missing/i);
  const bad=planRecurrenceRetirement(inspection,[...list,
    kv("TASKOWNER#"+target.taskId,"SOME_OTHER_KEY",mapping)]);
  assert.equal(bad.status,"blocked");
  assert.match(bad.blockers.join(" / "),/Unexpected index sort key/i);
});
test("#351 past dates alone never override provider/terminal blockers",()=>{
  const result=planRecurrenceRetirement({...inspection,blockers:["A future Calendar occurrence exists"]},rows());
  assert.equal(result.status,"blocked");
  assert.deepEqual(result.blockers,["A future Calendar occurrence exists"]);
  assert.equal(result.applyAvailable,false);
});
test("#351 shared audit references are preserved, not proposed as deletable",()=>{
  const list=rows().concat(kv("AUDIT#work#shared","STATE",{
    detail:{taskId:target.taskId,eventId:"different-calendar-item"},
  }));
  const result=planRecurrenceRetirement(inspection,list);
  assert.ok(result.protectedRecords.some(x=>x.pk==="AUDIT#work#shared"));
  assert.ok(!result.incidentEvidenceForSeparateReview.some(x=>x.pk==="AUDIT#work#shared"));
});
test("#351 future/current mapping under another profile is not surfaced as a deletion candidate",()=>{
  const list=rows().concat(kv("TASK#home#"+target.taskId,"MAP",{profile:"home",taskId:target.taskId,eventId:target.eventId}));
  const result=planRecurrenceRetirement({...inspection,blockers:["Other profile references prevent retirement"]},list);
  assert.equal(result.status,"blocked");
  assert.ok(result.protectedRecords.some(x=>x.pk==="TASK#home#"+target.taskId));
  assert.ok(!result.indexRemovalCandidates.some(x=>x.pk==="TASK#home#"+target.taskId));
});
test("#351 preview fingerprint is order-independent but changes on state revision",()=>{
  const first=planRecurrenceRetirement(inspection,rows());
  const reverse=planRecurrenceRetirement(inspection,rows().reverse());
  const changed=rows();
  changed.find(x=>x.pk==="BASELINE#work#TASK#"+target.taskId).updatedAt="2026-11-06T19:00:00Z";
  const updated=planRecurrenceRetirement(inspection,changed);
  assert.equal(first.planFingerprint,reverse.planFingerprint);
  assert.notEqual(first.planFingerprint,updated.planFingerprint);
});
test("#351 duplicate state keys and malformed canonical/baseline rows produce blockers",()=>{
  const duplicate=planRecurrenceRetirement(inspection,[...rows(),rows()[0]]);
  assert.match(duplicate.blockers.join(" / "),/duplicate keys/i);
  const invalid=rows().map(x=>x.pk==="CANONICAL#work#calendar#"+target.eventId
    ? {...x,providerId:"unrelated"} :x.pk==="BASELINE#work#TASK#"+target.taskId
      ? {...x,baseline:undefined}:x);
  const result=planRecurrenceRetirement(inspection,invalid);
  assert.match(result.blockers.join(" / "),/baseline has no verified snapshot/i);
  assert.match(result.blockers.join(" / "),/Canonical identity is malformed/i);
});
test("#351 a preview fetch repeats full provider and state evidence readback without writes",async()=>{
  const calls=[];
  const state={
    async listReconciliationDiagnostics(...args){calls.push("diagnostics");return {items:[recorded]};},
    async getMappingByTask(){calls.push("taskIndex");return mapping;},
    async getTaskOwnerMapping(){calls.push("ownerIndex");return mapping;},
    async getMappingByEvent(){calls.push("eventIndex");return mapping;},
    async getRecurrenceLink(){calls.push("link");return link;},
    async listCompletedCalendarProjectionsByTask(){calls.push("history");return [completion];},
  };
  const clientFactory=async()=>({
    todoist:{
      async getTask(){calls.push("getTask");throw Object.assign(new Error("404"),{status:404});},
      async findCompletedTaskById(){calls.push("getCompletedTask");return {id:target.taskId,
        content:"Historical",completed_at:"2026-10-21T13:00:00Z",is_deleted:false};},
    },
    calendar:{
      async getEvent(id){calls.push("getEvent");return id==="master"?master:occurrence;},
      async listEventInstances(){calls.push("listInstances");return [occurrence];},
    },
  });
  const inventory=async()=>{calls.push("inventory");return rows();};
  const result=await previewRecurrenceRetirement(target,{state,clientFactory,inventory});
  assert.equal(result.preview.status,"reviewable");
  assert.ok(result.preview.planFingerprint);
  assert.equal(calls.filter(x=>x==="inventory").length,1);
  assert.equal(calls.filter(x=>x==="getEvent").length,2);
  assert.equal(calls.filter(x=>x==="getCompletedTask").length,1);
  assert.ok(calls.every(x=>!/(delete|update|write|save|put|patch)/i.test(x)));
  const repeated=await previewRecurrenceRetirement(target,{state,clientFactory,inventory});
  assert.equal(calls.filter(x=>x==="inventory").length,2);
  assert.equal(repeated.preview.planFingerprint,result.preview.planFingerprint);
});
