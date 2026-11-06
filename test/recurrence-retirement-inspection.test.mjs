import test from "node:test";
import assert from "node:assert/strict";
import { assessRecurrenceRetirement } from "../dist/recurrence-retirement-inspection.js";

const target={profile:"work",generation:"1793982837494-t1u4ucsa",
  taskId:"6hjvhXv24HmhgFx7",eventId:"occ_20261021T083000Z",
  seriesId:"series-uid-351"};
const past="2026-10-21T08:30:00Z";
const completed="2026-10-21T13:00:00Z";
const mapping={profile:"work",taskId:target.taskId,eventId:target.eventId,
  recurrenceOwner:"calendar",seriesId:target.seriesId,
  masterEventId:"master",activeInstanceId:target.eventId,
  updatedAt:"2026-10-22T10:00:00Z"};
const link={profile:"work",owner:"calendar",seriesId:target.seriesId,taskId:target.taskId,
  eventId:target.eventId,masterEventId:"master",activeInstanceId:target.eventId,
  updatedAt:"2026-10-22T10:00:00Z"};
const instance={id:target.eventId,recurringEventId:"master",
  status:"confirmed",start:{dateTime:past},etag:"occurrence-version"};
const master={id:"master",status:"confirmed",etag:"master-version",
  recurrence:["RRULE:FREQ=DAILY;COUNT=2"]};
const history=[{profile:"work",taskId:target.taskId,eventId:target.eventId,
  recurrenceOwner:"calendar",seriesId:target.seriesId,masterEventId:"master",
  completedAt:completed,terminalVerified:true}];
const terminal={profile:"work",seriesId:target.seriesId,recurrenceOwner:"calendar",
  masterEventId:"master",terminalCompletedAt:completed};
const confirmedTask={id:target.taskId,content:"Threat modelling",completed_at:completed,is_deleted:false};
function input(overrides={}) {
  return {
    nowMs:Date.parse("2026-11-06T17:00:00Z"),target,mapping,taskIndex:mapping,
    ownerIndex:mapping,eventIndex:mapping,link,master,occurrence:instance,
    instances:[{...instance,id:"cancelled_20261020",status:"cancelled",
      start:{dateTime:"2026-10-20T08:30:00Z"}},instance],
    completedTask:confirmedTask,completedLookupFailed:false,history,terminal,
    otherOwners:[],activeReviews:[],inFlightControls:[],...overrides,
  };
}

test("#351 exact ended series with independent completed-task and terminal-series evidence has no read-only policy blockers",()=>{
  assert.deepEqual(assessRecurrenceRetirement(input()),[]);
});

test("#351 future December occurrence cannot be retired even if a past instance completed",()=>{
  const future={...instance,id:"future_20261203",start:{dateTime:"2026-12-03T10:00:00Z"}};
  assert.match(assessRecurrenceRetirement(input({instances:[instance,future]})).join(" / "),/future/i);
});

test("#351 missing completion proof is not interpreted as a deleted or completed task",()=>{
  const errors=assessRecurrenceRetirement(input({completedTask:undefined,completedLookupFailed:true}));
  assert.ok(errors.some(s=>s.includes("independently prove")));
  assert.ok(errors.some(s=>s.includes("unavailable or incomplete")));
});

test("#351 missing terminal history or active recurrence fails closed",()=>{
  assert.match(assessRecurrenceRetirement(input({history:[],terminal:undefined})).join(" / "),/immutable terminal/i);
  assert.match(assessRecurrenceRetirement(input({activeTask:{id:target.taskId,content:"Active"}})).join(" / "),/active task/i);
  assert.match(assessRecurrenceRetirement(input({master:{...master,recurrence:["RRULE:FREQ=DAILY"]}})).join(" / "),/unbounded/i);
});

test("#351 version mismatch, shared ownership, active review and pending repair are blockers",()=>{
  const errors=assessRecurrenceRetirement(input({
    eventIndex:{...mapping,updatedAt:"2026-11-06T10:00:00Z"},
    otherOwners:["TASK#home#"+target.taskId],activeReviews:["REVIEW_CASE#active"],
    inFlightControls:["SYNC_CONTROL#work:todoist:"+target.taskId],
  })).join(" / ");
  assert.match(errors,/indexes do not agree/i);
  assert.match(errors,/Other profile/i);
  assert.match(errors,/open review/i);
  assert.match(errors,/concurrent repair/i);
});

test("#351 incomplete Calendar inventory, provider master version and wrong owner fail closed",()=>{
  const errors=assessRecurrenceRetirement(input({
    mapping:{...mapping,recurrenceOwner:"todoist"},
    master:{...master,etag:undefined},
    instances:[],
  })).join(" / ");
  assert.match(errors,/Calendar-owned mapping/i);
  assert.match(errors,/ETag/i);
  assert.match(errors,/instance inventory/i);
});

test("#351 only expired terminal history qualifies, never elapsed occurrence alone",()=>{
  const errors=assessRecurrenceRetirement(input({
    nowMs:Date.parse("2026-10-23T12:00:00Z"),
  })).join(" / ");
  assert.match(errors,/seven-day/i);
});
