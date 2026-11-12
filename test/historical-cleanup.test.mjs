import test from "node:test";
import assert from "node:assert/strict";
import { cleanVerifiedDeletedCase } from "../dist/historical-cleanup.js";

const taskId="6hxGHMrqcFPwVqFf",eventId="p1dk5e55fotqv011l4cibo2bt0",projectId="test-work-project";
const item={id:"work-standalone_todoist_task_deleted-87777683ac200c57191a",profile:"work",title:"Deleted pair",reason:"deleted",status:"open",taskId,eventId,
  decision:{type:"standalone_todoist_task_deleted",taskId,eventId},createdAt:"2026-11-12T00:00:00.000Z",updatedAt:"v1"};
const ownedComment=()=>({id:"comment-1",project_id:projectId,content:`todoist-calendar-sync:mapping:v1\n${JSON.stringify({schemaVersion:1,profile:"work",projectId,taskId,eventId,mappingRevision:1,updatedAt:"2026-11-11T00:00:00.000Z"})}`});
function harness({event={id:eventId,status:"cancelled",htmlLink:"https://calendar.test/event"},calendarEvents,instances=[],recurrenceLink,
  caseItem=item,comments=[ownedComment()],taskExists=false,changedComment=false}={}){
  const calendarState=new Map(calendarEvents||[[eventId,event]]);
  let currentComments=[...comments],calendarUpdates=0,taskDeletes=0,eventDeletes=0,creations=0,closed=0;
  let commentReadChanged=changedComment;
  const todoist={
    listProjectComments:async()=>currentComments.map(x=>({...x})),
    getComment:async id=>{const found=currentComments.find(x=>x.id===id);if(!found)throw Object.assign(new Error("gone"),{status:404});return commentReadChanged?{...found,content:"user changed this"}:{...found};},
    deleteComment:async id=>{currentComments=currentComments.filter(x=>x.id!==id);},
    findLegacyTaskComment:async()=>undefined,
    deleteTask:async()=>{taskDeletes++;},createTask:async()=>{creations++;},
  };
  const calendar={getEvent:async id=>{const value=calendarState.get(id);if(!value)throw Object.assign(new Error("gone"),{status:404});return {...value,extendedProperties:structuredClone(value.extendedProperties||{})};},
    listEventInstances:async()=>instances,
    updateSharedEventPropertiesIfUnchanged:async(id,etag,patch)=>{calendarUpdates++;const value=calendarState.get(id);for(const key of Object.keys(patch))delete value.extendedProperties.shared[key];value.etag="etag-2";},
    deleteEvent:async()=>{eventDeletes++;},createEvent:async()=>{creations++;}};
  let checkpoint,lastExpected,resolvedCase,recurrenceRemoved=false;
  const store={lastVerifiedDeletionBlocker:undefined,
    inventoryVerifiedDeletedMappings:async()=>[],
    getCase:async()=>resolvedCase||caseItem,
    getHistoricalCleanupCheckpoint:async()=>checkpoint,
    saveHistoricalCleanupCheckpoint:async(input)=>{checkpoint={...(checkpoint||{}),...input.patch,fingerprint:input.fingerprint};if(input.release)checkpoint.leaseUntil=0;return true;},
    resolveVerifiedDeletedCase:async(_id,expected)=>{lastExpected=expected;if(!expected.dryRun){closed++;recurrenceRemoved=true;resolvedCase={...caseItem,status:"resolved",result:"resolved_deleted: both provider objects verified absent; stale conflict retired",taskId:undefined,eventId:undefined,decision:undefined};}assert.deepEqual(expected.taskIds,[taskId]);assert.ok(expected.eventIds.includes(eventId));return true;}};
  store.inventoryVerifiedDeletedMappings=async()=>[];
  const engine={snapshot:async ref=>({object:ref.side==="todoist"?(taskExists?{id:taskId}:null):calendarState.get(ref.id)}),clients:async()=>({todoist,calendar}),state:{
    getMappingByTask:async()=>undefined,getMappingByTaskAnyProfile:async()=>undefined,getMappingByEvent:async()=>undefined,
    getRecurrenceLink:async(profile,seriesId)=>!recurrenceRemoved&&recurrenceLink?.profile===profile&&recurrenceLink.seriesId===seriesId?recurrenceLink:undefined,
    getCompletedCalendarProjectionByEvent:async()=>undefined,
  }};
  return {input:{item:caseItem,store,engine},setCommentReadChanged:value=>{commentReadChanged=value;},get state(){return{currentComments,calendarUpdates,taskDeletes,eventDeletes,creations,closed,calendarState,lastExpected,checkpoint};}};
}

test("offline Work deleted-pair fixture clears exact comment and retires case without provider task/event deletion",async()=>{
  const f=harness();
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.equal(result.deletedComments,1);
  assert.equal(f.state.currentComments.length,0);
  assert.equal(f.state.calendarUpdates,0,"cancelled events are never patched");
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
  assert.equal(f.state.closed,1);
});

test("a foreign user comment is preserved while the exact app mapping is removed",async()=>{
  const foreign={id:"user-note",project_id:projectId,content:"My note about this task"};
  const f=harness({comments:[ownedComment(),foreign]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.deepEqual(f.state.currentComments,[foreign]);
});

test("changed app comment blocks closure and leaves the case open",async()=>{
  const f=harness({changedComment:true});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"blocked");
  assert.equal(result.blocker,"todoist_mapping_comment_changed");
  assert.equal(f.state.closed,0);
});

test("a blocked attempt releases its exact checkpoint for a safe retry",async()=>{
  const f=harness({changedComment:true});
  const first=await cleanVerifiedDeletedCase(f.input);
  assert.equal(first.status,"blocked");
  assert.equal(first.blocker,"todoist_mapping_comment_changed");
  assert.equal(f.state.checkpoint.status,"retryable");
  assert.equal(f.state.currentComments.length,1);
  f.setCommentReadChanged(false);
  const retry=await cleanVerifiedDeletedCase(f.input);
  assert.equal(retry.status,"complete");
  assert.equal(retry.deletedComments,1);
  assert.equal(f.state.currentComments.length,0);
  assert.equal(f.state.closed,1);
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
});

test("unrelated case types cannot use historical cleanup even when provider IDs are present",async()=>{
  const f=harness({caseItem:{...item,decision:{type:"calendar_owned_task_deleted",taskId,eventId}}});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"blocked");
  assert.equal(result.blocker,"case_type_not_eligible_for_historical_cleanup");
  assert.equal(f.state.currentComments.length,1);
  assert.equal(f.state.closed,0);
});

test("retained live one-off event loses only task link properties with ETag readback",async()=>{
  const event={id:eventId,status:"confirmed",etag:"etag-1",summary:"Keep this event",description:"User content",
    extendedProperties:{shared:{taskId,taskUrl:"https://todoist.test/task",originalSummary:"Old summary",syncMarker:"owned",userField:"keep"},private:{userPrivate:"keep"}}};
  const f=harness({event,comments:[]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.equal(f.state.calendarUpdates,1);
  assert.equal(event.summary,"Keep this event");
  assert.deepEqual(event.extendedProperties.shared,{userField:"keep"});
  assert.deepEqual(event.extendedProperties.private,{userPrivate:"keep"});
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
});

test("a live event with foreign task ownership is a hard blocker",async()=>{
  const f=harness({event:{id:eventId,status:"confirmed",etag:"etag-1",extendedProperties:{shared:{taskId:"other-task"}}},comments:[]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"blocked");
  assert.equal(result.blocker,"calendar_link_provenance_ambiguous");
  assert.equal(f.state.closed,0);
});

test("verified cancelled recurrence retires only the exact Todoist-owned link after full instance inventory",async()=>{
  const masterId="master-1",seriesId="ical-series-1";
  const master={id:masterId,status:"cancelled",etag:"master-etag",iCalUID:seriesId,recurrence:["RRULE:FREQ=WEEKLY;COUNT=2"]};
  const active={id:eventId,status:"cancelled",etag:"active-etag",recurringEventId:masterId,iCalUID:seriesId};
  const recurrenceLink={profile:"work",owner:"todoist",seriesId:taskId,taskId,eventId,masterEventId:masterId,activeInstanceId:eventId,updatedAt:"2026-11-11T00:00:00.000Z"};
  const recurrenceCase={...item,eventId:undefined,decision:{type:"todoist_owned_recurrence_task_deleted",taskId,eventId,
    masterEventId:masterId,activeInstanceId:eventId,seriesId:taskId,mappingSnapshot:{profile:"work",taskId,eventId,
      masterEventId:masterId,activeInstanceId:eventId,seriesId:taskId}}};
  const f=harness({caseItem:recurrenceCase,calendarEvents:[[masterId,master],[eventId,active]],instances:[active],recurrenceLink,comments:[]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.equal(f.state.lastExpected.staleLinks.length,1);
  assert.equal(f.state.lastExpected.staleLinks[0].seriesId,taskId);
  assert.deepEqual(f.state.lastExpected.seriesKeys.sort(),[taskId,eventId,masterId,seriesId].sort());
  assert.equal(f.state.calendarUpdates,0);
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
});
