import test from "node:test";
import assert from "node:assert/strict";
import { assessRecurrenceRetirement, inspectRecurrenceRetirement } from "../dist/recurrence-retirement-inspection.js";

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
  status:"confirmed",start:{dateTime:past},etag:"occurrence-version",iCalUID:target.seriesId};
const master={id:"master",iCalUID:target.seriesId,status:"confirmed",etag:"master-version",
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

test("#358 legacy recurrence without a series certificate can use complete provider proof after explicit operator approval",()=>{
  assert.deepEqual(assessRecurrenceRetirement(input({terminal:undefined})),[]);
  assert.match(assessRecurrenceRetirement(input({terminal:undefined,completedTask:undefined})).join(" / "),/independently prove this exact task completed/i);
  const future={...instance,id:"future-instance",start:{dateTime:"2026-12-03T10:00:00Z"}};
  assert.match(assessRecurrenceRetirement(input({terminal:undefined,instances:[instance,future]})).join(" / "),/future/i);
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

test("#351 mapping indexes must agree on all recurrence progress and metadata fields",()=>{
  for(const field of [
    ["activeEffectiveStart","2026-10-20T09:00:00Z"],
    ["completedThroughOriginalStart","2026-10-20T08:30:00Z"],
    ["calendarProgressVersion",1],
    ["calendarNativeRecurring",true],
    ["syncedTitle","changed"],
  ]) {
    const [key,value]=field;
    const disagree=assessRecurrenceRetirement(input({
      eventIndex:{...mapping,[key]:value,lookupPk:"PROFILE#work",lookupSk:"MAP#EVENT"},
    }));
    assert.match(disagree.join(" / "),/indexes do not agree/,key);
  }
  // DynamoDB's pk/sk and lookupPk/lookupSk differ on the triplet legitimately.
  assert.deepEqual(assessRecurrenceRetirement(input({
    taskIndex:{...mapping,pk:"TASK#work#id",sk:"MAP",lookupPk:"PROFILE#work",lookupSk:"TASK#id"},
    eventIndex:{...mapping,pk:"EVENT#work#id",sk:"MAP",lookupPk:"PROFILE#work",lookupSk:"EVENT#id"},
    ownerIndex:{...mapping,pk:"TASKOWNER#id",sk:"MAP",lookupPk:"PROFILE#work",lookupSk:"OWNER#id"},
  })),[]);
});
test("#351 selected occurrence must be the current active mapping instance",()=>{
  assert.match(assessRecurrenceRetirement(input({
    mapping:{...mapping,activeInstanceId:"other-occurrence"},
  })).join(" / "),/mapping active instance/i);
  assert.match(assessRecurrenceRetirement(input({
    mapping:{...mapping,activeInstanceId:undefined},
  })).join(" / "),/mapping active instance/i);
});
test("#351 changed iCalUID, occurrence series, or foreign instance series are blockers",()=>{
  assert.match(assessRecurrenceRetirement(input({
    master:{...master,iCalUID:"another-series"},
  })).join(" / "),/master series identity/i);
  assert.match(assessRecurrenceRetirement(input({
    occurrence:{...instance,iCalUID:"another-series"},
  })).join(" / "),/occurrence series identity/i);
  assert.match(assessRecurrenceRetirement(input({
    instances:[{...instance,iCalUID:"foreign-series"}],
  })).join(" / "),/instance inventory includes another/i);
});

const diagnostic={
  ...target,action:"todoist_snapshot_reconcile_recurring_deferred",
  reason:"recurrence_owned_mapping_deferred",outcome:"deferred",
  observedAt:"2026-11-06T16:34:34Z",sourceDeliveryId:"reconcile-1",
  detail:{},caseStatus:"not_actionable",
};
function inspectionFixture({
  recorded=diagnostic, rows=[],calendarMaster=master,
  getTaskStatus=404,completedStatus=200,inventoryError,historyOverride=history,
  instanceOverride=[instance],taskValue,
  diagnosticsPages,
}={}) {
  const calls=[];
  const row=(pk,sk,details={})=>({pk,sk,...details});
  const inventory=[
    row("TASK#work#"+target.taskId,"MAP",mapping),
    row("TASKOWNER#"+target.taskId,"MAP",mapping),
    row("EVENT#work#"+target.eventId,"MAP",mapping),
    row("RECURRENCE#work#"+target.seriesId,"STATE",link),
    row("COMPLETED_SERIES#work#"+target.seriesId,"STATE",terminal),
    ...rows,
  ];
  const db={
    async listReconciliationDiagnostics(profile,generation,limit,after){
      calls.push(["diagnostic",profile,generation,after]);
      if(diagnosticsPages)return diagnosticsPages(after);
      return {items:[recorded],next:undefined};
    },
    async getMappingByTask(profile,id){calls.push(["taskIndex",profile,id]);return mapping;},
    async getTaskOwnerMapping(id){calls.push(["ownerIndex",id]);return mapping;},
    async getMappingByEvent(profile,id){calls.push(["eventIndex",profile,id]);return mapping;},
    async getRecurrenceLink(profile,id){calls.push(["link",profile,id]);return link;},
    async listCompletedCalendarProjectionsByTask(profile,id){calls.push(["history",profile,id]);return historyOverride;},
  };
  const clientFactory=async profile=>{
    calls.push(["clientFactory",profile]);
    return {
      todoist:{
        async getTask(id) {
          calls.push(["getTask",id]);
          if(getTaskStatus!==200)throw Object.assign(new Error("task unavailable"),{status:getTaskStatus});
          return taskValue||{id:target.taskId,content:"Active task",due:{date:"2026-12-03"},is_completed:false};
        },
        async findCompletedTaskById(id,at){
          calls.push(["completed",id,at]);
          if(completedStatus!==200)throw Object.assign(new Error("completed unavailable"),{status:completedStatus});
          return confirmedTask;
        },
      },
      calendar:{
        async getEvent(id){
          calls.push(["getEvent",id]);
          if(id==="master") {
            if(!calendarMaster)throw Object.assign(new Error("master not found"),{status:404});
            return calendarMaster;
          }
          if(id===target.eventId)return instance;
          throw Object.assign(new Error("unexpected ID"),{status:404});
        },
        async listEventInstances(id){
          calls.push(["listEventInstances",id]);
          if(inventoryError)throw inventoryError;
          return instanceOverride;
        },
      },
    };
  };
  const dependencies={state:db,clientFactory,inventory:async()=>{calls.push(["inventory"]);return inventory;}};
  return {calls,dependencies};
}
test("#351 inspector orchestration binds exact recorded generation and does not make writes",async()=>{
  const {calls,dependencies}=inspectionFixture();
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.providerWrites,false);
  assert.equal(result.eligibleForFutureApproval,true);
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.task.status,"completed_verified");
  assert.ok(calls.some(([name])=>name==="completed"));
  assert.ok(calls.some(([name])=>name==="listEventInstances"));
  assert.ok(calls.every(([name])=>!/(delete|update|put|write|patch|save)/i.test(name)));
  assert.equal(result.previewFingerprint.length,64);
});

test("#358 a direct Todoist task read marked completed is not misclassified as active, and completed history is rechecked",async()=>{
  const {calls,dependencies}=inspectionFixture({getTaskStatus:200,
    taskValue:{id:target.taskId,content:"Threat modelling",is_completed:true}});
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.task.status,"completed_verified");
  assert.equal(result.task.value.completed_at,completed);
  assert.ok(calls.some(([name])=>name==="completed"),"completed-task endpoint is checked even when direct GET returns an item");
  assert.ok(!result.blockers.some(reason=>/active task/i.test(reason)));
});

test("#358 a retained direct completion timestamp corroborated by Todoist completed history is verified",async()=>{
  const {dependencies}=inspectionFixture({getTaskStatus:200,
    taskValue:{id:target.taskId,content:"Threat modelling",completed_at:completed}});
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.task.status,"completed_verified");
  assert.equal(result.task.value.completed_at,completed);
  assert.ok(!result.blockers.some(reason=>/active task/i.test(reason)));
});

test("#358 a re-opened Todoist task remains an active-task blocker despite older completion history",async()=>{
  const {dependencies}=inspectionFixture({getTaskStatus:200,
    taskValue:{id:target.taskId,content:"Threat modelling",is_completed:false}});
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.task.status,"active");
  assert.ok(result.blockers.some(reason=>/active task/i.test(reason)));
});
test("#351 wrong diagnostic IDs or reason fail before provider reads",async()=>{
  const {calls,dependencies}=inspectionFixture({recorded:{...diagnostic,taskId:"unrelated-task"}});
  await assert.rejects(()=>inspectRecurrenceRetirement(target,dependencies),/exact recorded recurring diagnostic/i);
  assert.deepEqual(calls.map(([name])=>name),["diagnostic"]);
});
test("#351 diagnostic search is paginated without silently dropping the intended generation",async()=>{
  const {calls,dependencies}=inspectionFixture({
    diagnosticsPages:after=>after?{items:[diagnostic]}:{items:[],next:"ITEM#"+("a".repeat(64))},
  });
  const out=await inspectRecurrenceRetirement(target,dependencies);
  assert.ok(out.eligibleForFutureApproval);
  assert.equal(calls.filter(([name])=>name==="diagnostic").length,2);
});
test("#351 absence of Calendar master or completed lookup evidence never implies retirement",async()=>{
  const {dependencies}=inspectionFixture({calendarMaster:null,completedStatus:429});
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.eligibleForFutureApproval,false);
  assert.equal(result.task.status,"unverified");
  assert.match(result.blockers.join(" / "),/intact Calendar master/i);
  assert.match(result.blockers.join(" / "),/unavailable or incomplete/i);
});
test("#351 incomplete Calendar instance pagination fails closed (no partial success)",async()=>{
  const {dependencies}=inspectionFixture({inventoryError:new Error("Calendar pagination unavailable")});
  await assert.rejects(()=>inspectRecurrenceRetirement(target,dependencies),/pagination unavailable/);
});
test("#351 inspector discovers other profile mapping keys even when only key contains the ID",async()=>{
  const {dependencies}=inspectionFixture({rows:[{pk:"TASK#home#"+target.taskId,sk:"MAP"}]});
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.eligibleForFutureApproval,false);
  assert.match(result.blockers.join(" / "),/Other profile/i);
});
test("#351 inspector checks exact compound sync-control keys with no standalone task ID",async()=>{
  const {dependencies}=inspectionFixture({rows:[
    {pk:"SYNC_CONTROL#work:calendar:master",sk:"STATE",activeRepair:"repair-7"},
    {pk:"SYNC_CONTROL#work:todoist:"+target.taskId,sk:"STATE",pendingRefresh:true},
  ]});
  const result=await inspectRecurrenceRetirement(target,dependencies);
  assert.equal(result.eligibleForFutureApproval,false);
  assert.match(result.blockers.join(" / "),/concurrent repair/i);
  assert.equal(result.historicalRowCounts.SYNC_CONTROL,2);
});
test("#351 fingerprints do not depend on scan order, even when pk has different sk",async()=>{
  const rows=[
    {pk:"AUDIT#work#same",sk:"A",taskId:target.taskId},
    {pk:"AUDIT#work#same",sk:"B",taskId:target.taskId},
  ];
  const first=await inspectRecurrenceRetirement(target,inspectionFixture({rows}).dependencies);
  const second=await inspectRecurrenceRetirement(target,inspectionFixture({rows:rows.slice().reverse()}).dependencies);
  assert.equal(first.previewFingerprint,second.previewFingerprint);
});
