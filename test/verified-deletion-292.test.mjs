import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeletedRecurrenceLinks } from "../dist/verified-deletion.js";
import { deletedRecurrenceStatus } from "../dist/deletion-review-state.js";

const taskId="6hqp4fFR45WvJ5VV";
const master="agejr3i89v5p13lfl95uss11o8";
const active=master+"_20261116";
const completed=master+"_20261102";
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
  {ref:{profile:"antonio",side:"calendar",id:master},object:{id:master,status:"cancelled",recurrence:["RRULE:FREQ=WEEKLY;COUNT=4"]}},
  {ref:{profile:"antonio",side:"calendar",id:active},object:{id:active,status:"cancelled",recurringEventId:master}},
];

test("production-shaped pair verifies deleted master and active while identifying the stale index",async()=>{
  const result=await deletedRecurrenceStatus(deletedCase,snapshots,async()=>linked);
  assert.equal(result.bothGone,true);
  assert.equal(result.state,"stale_recurrence");
  assert.deepEqual(result.staleLinks.map(link=>link.seriesId),[taskId]);
  assert.equal(result.masterId,master);
  assert.equal(result.activeInstanceId,active);
});
test("one cancelled occurrence cannot retire a live master",async()=>{
  const live=snapshots.map(s=>s.ref.id===master?{...s,object:{id:master,status:"confirmed"}}:s);
  const result=await deletedRecurrenceStatus(deletedCase,live,async()=>linked);
  assert.equal(result.state,"partial");
  assert.equal(result.bothGone,false);
});
test("lookup failures and unknown master are never treated as missing",async()=>{
  const failed=snapshots.map(s=>s.ref.id===taskId?{...s,lookupError:"HTTP 429"}:s);
  assert.equal((await deletedRecurrenceStatus(deletedCase,failed,async()=>linked)).state,"unverified");
  const unknown={...deletedCase,decision:{...deletedCase.decision,masterEventId:undefined,mappingSnapshot:{eventId:master}}};
  assert.equal((await deletedRecurrenceStatus(unknown,snapshots,async()=>linked)).bothGone,false);
});
test("retirement classifier rejects foreign, Calendar-owned, new and incomplete associations",()=>{
  const extra={...linked,profile:"work"};
  const calendar={...linked,owner:"calendar",seriesId:master+"@google.com"};
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
