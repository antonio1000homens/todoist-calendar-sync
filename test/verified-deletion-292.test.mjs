import assert from "node:assert/strict";
import test from "node:test";
import { cancelledOccurrenceMasterId, classifyDeletedRecurrenceLinks, readExactRecurrenceLinks, verifyCancelledSeries } from "../dist/verified-deletion.js";
import { deletedRecurrenceStatus } from "../dist/deletion-review-state.js";

const taskId="6hqp4fFR45WvJ5VV";
const master="agejr3i89v5p13lfl95uss11o8";
const active=master+"_20261116";
const completed=master+"_20261102";
const masterSeriesId=master+"-gcal-series";
const getLink=async(profile,key)=>profile==="antonio"&&key===taskId?linked:undefined;
const linked={profile:"antonio",owner:"todoist",seriesId:taskId,taskId,
  eventId:master,masterEventId:master,activeInstanceId:active,updatedAt:"2026-10-25T19:09:07.680Z"};
const deletedCase={id:"antonio-todoist_owned_recurrence_task_deleted-1227dad2ad8dd7071bdb",
  profile:"antonio",status:"open",title:"Task (Calendar-to-Todoist E2E 20261025 post-216 all-day)",
  reason:"todoist_owned_recurrence_task_deleted",
  taskId,eventId:master,createdAt:"2026-10-25T19:10:24Z",updatedAt:"2026-10-25T19:10:25Z",
  decision:{type:"todoist_owned_recurrence_task_deleted",status:"pending",taskId,eventId:master,
    masterEventId:master,activeInstanceId:active,mappingSnapshot:{...linked,recurrenceOwner:"todoist"}}};
const snapshots=[
  {ref:{profile:"antonio",side:"todoist",id:taskId},object:null,checkedAt:"2026-11-03T12:00:00Z"},
  {ref:{profile:"antonio",side:"calendar",id:master},object:{id:master,status:"cancelled",iCalUID:masterSeriesId,recurrence:["RRULE:FREQ=WEEKLY;COUNT=4"]}},
  {ref:{profile:"antonio",side:"calendar",id:active},object:{id:active,status:"cancelled",recurringEventId:master}},
];

test("production-shaped pair verifies deleted master and active while identifying the stale index",async()=>{
  const result=await deletedRecurrenceStatus(deletedCase,snapshots,getLink);
  assert.equal(result.bothGone,true);
  assert.equal(result.state,"stale_recurrence");
  assert.deepEqual(result.staleLinks.map(link=>link.seriesId),[taskId]);
  assert.equal(result.masterId,master);
  assert.equal(result.activeInstanceId,active);
});
test("one cancelled occurrence cannot retire a live master",async()=>{
  const live=snapshots.map(s=>s.ref.id===master?{...s,object:{id:master,status:"confirmed"}}:s);
  const result=await deletedRecurrenceStatus(deletedCase,live,getLink);
  assert.equal(result.state,"partial");
  assert.equal(result.bothGone,false);
});
test("lookup failures and unknown master are never treated as missing",async()=>{
  const failed=snapshots.map(s=>s.ref.id===taskId?{...s,lookupError:"HTTP 429"}:s);
  assert.equal((await deletedRecurrenceStatus(deletedCase,failed,getLink)).state,"unverified");
  const unknown={...deletedCase,decision:{...deletedCase.decision,masterEventId:undefined,mappingSnapshot:{eventId:master}}};
  assert.equal((await deletedRecurrenceStatus(unknown,snapshots,getLink)).bothGone,false);
});
test("retirement classifier rejects foreign, Calendar-owned, new and incomplete associations",()=>{
  const extra={...linked,profile:"work"};
  const calendar={...linked,owner:"calendar",seriesId:master+"-google-series"};
  const changed={...linked,eventId:"different"};
  assert.deepEqual(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[linked]),
    {stale:[linked],blocked:[]});
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[linked,extra]).blocked.length,1);
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[calendar]).stale.length,0);
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[changed]).blocked.length,1);
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[{...linked,activeInstanceId:"new-instance"}]).blocked.length,1);
});
test("completed occurrence history is not part of active recurrence deletion targets",()=>{
  const result=classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[linked]);
  assert.equal(result.stale.length,1);
  assert.ok(![master,active].includes(completed));
});

test("cancelled unrelated occurrence and missing master iCalUID cannot verify deleted series",async()=>{
  const foreign=snapshots.map(s=>s.ref.id===active?{...s,object:{id:active,status:"cancelled",recurringEventId:"another-series"}}:s);
  assert.equal((await deletedRecurrenceStatus(deletedCase,foreign,getLink)).state,"unverified");
  const noUid=snapshots.map(s=>s.ref.id===master?{...s,object:{id:master,status:"cancelled",recurrence:["RRULE:FREQ=WEEKLY"]}}:s);
  assert.equal((await deletedRecurrenceStatus(deletedCase,noUid,getLink)).bothGone,false);
});
test("incomplete active/master link is not marked stale",async()=>{
  const incomplete={...linked,activeInstanceId:undefined};
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],[incomplete]).blocked.length,1);
  const status=await deletedRecurrenceStatus(deletedCase,snapshots,
    async(profile,key)=>profile==="antonio"&&key===taskId?incomplete:undefined);
  assert.equal(status.state,"mapping_blocked");
  assert.equal(status.bothGone,false);
});
test("strong exact-key inventory finds Calendar-owned iCalUID link in another profile",async()=>{
  const foreign={...linked,profile:"work",owner:"calendar",seriesId:masterSeriesId};
  const reads=[];
  const keys=[taskId,master,active,masterSeriesId];
  const links=await readExactRecurrenceLinks(keys,async(profile,key)=>{
    reads.push(profile+"/"+key);
    return profile==="antonio"&&key===taskId?linked:profile==="work"&&key===masterSeriesId?foreign:undefined;
  });
  assert.equal(reads.length,12);
  assert.ok(reads.includes("work/"+masterSeriesId));
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],links,keys).blocked.length,1);
  const status=await deletedRecurrenceStatus(deletedCase,snapshots,
    async(profile,key)=>profile==="antonio"&&key===taskId?linked:profile==="work"&&key===masterSeriesId?foreign:undefined);
  assert.equal(status.state,"mapping_blocked");
  assert.equal(status.bothGone,false);
});
test("unrelated snapshot mapping does not block verified exact deleted IDs",async()=>{
  const extra={ref:{profile:"antonio",side:"calendar",id:"unrelated"},object:{id:"unrelated",status:"confirmed"},
    mapping:{profile:"antonio",taskId:"unrelated-task",eventId:"unrelated",updatedAt:"2026-10-25T00:00:00Z"}};
  const status=await deletedRecurrenceStatus(deletedCase,[...snapshots,extra],getLink);
  assert.equal(status.state,"stale_recurrence");
});

test("cross-matched master/active IDs are blocked even though both IDs are cancelled",async()=>{
  const swapped={...linked,masterEventId:active,activeInstanceId:master};
  const keys=[taskId,master,active,masterSeriesId];
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],
    [swapped],keys,{masterId:master,activeInstanceId:active}).stale.length,0);
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],[master,active],
    [swapped],keys,{masterId:master,activeInstanceId:active}).blocked.length,1);
  const status=await deletedRecurrenceStatus(deletedCase,snapshots,
    async(profile,key)=>profile==="antonio"&&key===taskId?swapped:undefined);
  assert.equal(status.bothGone,false);
  assert.equal(status.state,"mapping_blocked");
});

const legacyLink={...linked,eventId:active,masterEventId:undefined};
const legacyCase={...deletedCase,eventId:active,
  decision:{...deletedCase.decision,eventId:active,masterEventId:undefined,
    mappingSnapshot:{...linked,eventId:active,masterEventId:undefined,activeInstanceId:active,
      recurrenceOwner:"todoist"}}};
const cancelledMaster={id:master,status:"cancelled",iCalUID:masterSeriesId,
  recurrence:["RRULE:FREQ=WEEKLY;COUNT=4"]};
const cancelledActive={id:active,status:"cancelled",recurringEventId:master,iCalUID:masterSeriesId};
const legacySnapshots=[
  {ref:{profile:"antonio",side:"todoist",id:taskId},object:null},
  {ref:{profile:"antonio",side:"calendar",id:active},object:cancelledActive},
  {ref:{profile:"antonio",side:"calendar",id:master},object:cancelledMaster},
];
test("#292 historical decision without masterEventId discovers master only by direct cancelled occurrence",async()=>{
  assert.equal(cancelledOccurrenceMasterId(active,cancelledActive),master);
  assert.equal(cancelledOccurrenceMasterId(active,{...cancelledActive,status:"confirmed"}),undefined);
  assert.equal(cancelledOccurrenceMasterId(active,{...cancelledActive,recurringEventId:""}),undefined);
  assert.equal(cancelledOccurrenceMasterId(active,{...cancelledActive,id:"other"}),undefined);
  const result=await deletedRecurrenceStatus(legacyCase,legacySnapshots,
    async(profile,key)=>profile==="antonio"&&key===taskId?legacyLink:undefined);
  assert.equal(result.bothGone,true);
  assert.equal(result.state,"stale_recurrence");
  assert.equal(result.masterId,master);
  assert.deepEqual(result.eventIds.slice().sort(),[master,active].sort());
  assert.deepEqual(result.staleLinks.map(link=>link.seriesId),[taskId]);
});
test("#292 masterless active link is blocked unless a verified legacy master proof is supplied",()=>{
  const ids=[master,active];
  const keys=[taskId,master,active,masterSeriesId];
  const ordinary={masterId:master,activeInstanceId:active};
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],ids,[legacyLink],keys,ordinary).stale.length,0);
  assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],ids,[legacyLink],keys,ordinary).blocked.length,1);
  const verified={...ordinary,legacyMasterVerified:true};
  assert.deepEqual(classifyDeletedRecurrenceLinks("antonio",[taskId],ids,[legacyLink],keys,verified).stale,[legacyLink]);
  for(const bad of [
    {...legacyLink,profile:"work"},
    {...legacyLink,eventId:master},
    {...legacyLink,activeInstanceId:"new-instance"},
    {...legacyLink,masterEventId:"different-master"},
    {...legacyLink,owner:"calendar"},
    {...legacyLink,updatedAt:undefined},
  ]) assert.equal(classifyDeletedRecurrenceLinks("antonio",[taskId],ids,[bad],keys,verified).stale.length,0);
});
test("#292 cancelled child never proves deleted master with different UID or still-live master",async()=>{
  const lookup=async(profile,key)=>profile==="antonio"&&key===taskId?legacyLink:undefined;
  for(const modified of [
    {...cancelledMaster,status:"confirmed"},
    {...cancelledMaster,iCalUID:"unrelated-uid"},
    {...cancelledMaster,recurrence:[]},
  ]) {
    const altered=legacySnapshots.map(row=>row.ref.id===master?{...row,object:modified}:row);
    assert.equal((await deletedRecurrenceStatus(legacyCase,altered,lookup)).bothGone,false);
  }
  const changedChild=legacySnapshots.map(row=>row.ref.id===active
    ?{...row,object:{...cancelledActive,recurringEventId:"different-master"}}:row);
  assert.equal((await deletedRecurrenceStatus(legacyCase,changedChild,lookup)).bothGone,false);
  const errorChild=legacySnapshots.map(row=>row.ref.id===active?{...row,lookupError:"HTTP 429"}:row);
  assert.equal((await deletedRecurrenceStatus(legacyCase,errorChild,lookup)).state,"unverified");
  const missingMaster=legacySnapshots.filter(row=>row.ref.id!==master);
  assert.equal((await deletedRecurrenceStatus(legacyCase,missingMaster,lookup)).state,"unverified");
  assert.equal(verifyCancelledSeries(master,active,[master,active],
    new Map([[master,cancelledMaster],[active,{...cancelledActive,iCalUID:"another-uid"}]])).valid,false);
});
