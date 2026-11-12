import test from "node:test";
import assert from "node:assert/strict";
import { executeErasureDeletionStep, erasureProjectCommentsAbsent } from "../dist/erasure-deletion.js";
import { ErasureGateDriftError } from "../dist/erasure-executor.js";
import { fingerprint } from "../scripts/item-purge-policy.mjs";
import { unlinkedCalendarEventDigest } from "../dist/erasure-calendar-link.js";
import { parseDeletionTombstoneComment, PROJECT_DELETION_TOMBSTONE_RETENTION_MS,
  serializeDeletionTombstoneComment, serializeMappingComment } from "../dist/mapping-comments.js";

const baseOperation={operationId:"erase-1",profile:"home",target:{taskId:"task-1",eventId:"event-1",deleteCalendar:false},
  selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[],actionPlan:{todoistTask:{id:"task-1",digest:fingerprint({id:"task-1",project_id:"test-home-project"})},comments:[]}};

test("comment deletion rejects a provider response whose ID differs from the inventoried comment",async()=>{
  let deletes=0;
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    comments:[{id:"comment-1",kind:"project",digest:fingerprint("mapping")}]}};
  await assert.rejects(executeErasureDeletionStep(operation,{stage:"comments",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{getComment:async()=>({id:"other-comment",content:"mapping"}),deleteComment:async()=>{deletes++;}},calendar:{}},inspectFence:async()=>({leases:[]})}),
    ErasureGateDriftError);
  assert.equal(deletes,0);
});

test("nuclear erasure immediately deletes the exact project mapping comment",async()=>{
  const original=serializeMappingComment({profile:"home",projectId:"test-home-project",taskId:"task-1",eventId:"event-1",updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project");
  let comment={id:"project-1",project_id:"test-home-project",content:original};
  let deletes=0,updates=0;
  const todoist={
    getComment:async id=>{assert.equal(id,"project-1");if(!comment)throw Object.assign(new Error("gone"),{status:404});return comment;},
    deleteComment:async id=>{assert.equal(id,"project-1");deletes++;comment=undefined;},
    updateComment:async()=>{updates++;},
  };
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    comments:[{id:"project-1",kind:"project",digest:fingerprint(original)}]}};
  const progress={stage:"comments",commentIndex:0,stateIndex:0,startedAt:1};
  const dependencies={db:{send:async()=>({})},clients:{todoist,calendar:{}},inspectFence:async()=>({leases:[]})};
  const first=await executeErasureDeletionStep(operation,progress,dependencies);
  assert.equal(first.progress.commentIndex,1);
  assert.equal(comment,undefined);
  assert.equal(deletes,1);
  assert.equal(updates,0,"no replay tombstone is written");
  const replay=await executeErasureDeletionStep(operation,progress,dependencies);
  assert.equal(replay.progress.commentIndex,1);
  assert.equal(deletes,1,"already deleted comment is not deleted again");
});

test("provider deletion leaves no Todoist tombstone and scrubs completed receipt identities from DynamoDB",async()=>{
  const original=serializeMappingComment({profile:"home",projectId:"test-home-project",taskId:"task-1",eventId:"event-1",
    updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project");
  let comment={id:"project-1",project_id:"test-home-project",content:original};
  let task={id:"task-1",project_id:"test-home-project"};
  let event={id:"event-1",etag:"etag-approved",status:"confirmed"};
  const identityRows=[
    {pk:"TASK#task-1",sk:"META",taskId:"task-1",profile:"home",revision:7},
    {pk:"TASK#home#task-1",sk:"MAPPING",taskId:"task-1",eventId:"event-1",profile:"home"},
    {pk:"BASELINE#home#TASK#task-1",sk:"RECONCILE",taskId:"task-1",lastEventId:"event-1",profile:"home"},
    {pk:"CANONICAL#home#calendar#event-1",sk:"EVENT",eventId:"event-1",profile:"home"},
    {pk:"DELIVERY#opaque-receipt",sk:"COMPLETED",profile:"home",kind:"calendar",
      identityRefs:{taskIds:["task-1","unrelated-task"],eventIds:["event-1","alias-2","alias-3","unrelated-event"],seriesIds:["unrelated-series"]},
      completedAt:"2026-11-08T12:00:00.000Z",expiresAt:1_800_000_000},
    {pk:"AUDIT#home#event-1",sk:"STATE",detail:{taskId:"task-1",eventId:"event-1"}},
  ];
  const unrelatedRow={pk:"TASK#home#unrelated",sk:"MAPPING",taskId:"unrelated-task",eventId:"unrelated-event",profile:"home"};
  const rows=new Map([...identityRows,unrelatedRow].map(row=>[`${row.pk}|${row.sk}`,row]));
  const todoist={
    async getComment(id){assert.equal(id,"project-1");if(!comment)throw Object.assign(new Error("not found"),{status:404});return comment;},
    async updateComment(id,content){assert.equal(id,"project-1");comment={...comment,content};return comment;},
    async deleteComment(id){assert.equal(id,"project-1");comment=undefined;},
    async getTask(id){assert.equal(id,"task-1");if(!task)throw Object.assign(new Error("not found"),{status:404});return task;},
    async deleteTask(id){assert.equal(id,"task-1");task=undefined;},
  };
  const calendar={
    async getEvent(id){assert.equal(id,"event-1");if(!event)throw Object.assign(new Error("not found"),{status:404});return event;},
    async deleteEvent(id,etag){assert.equal(id,"event-1");assert.equal(etag,"etag-approved");event={...event,status:"cancelled"};},
  };
  const db={async send(command){
    const input=command.input;
    if(command.constructor.name.includes("Get"))return {Item:rows.get(`${input.Key.pk}|${input.Key.sk}`)};
    if(command.constructor.name.includes("Update")){
      const key=`${input.Key.pk}|${input.Key.sk}`,current=rows.get(key);
      assert.ok(current,"the inventoried receipt is present until its identity-scrub step");
      rows.set(key,{...current,identityRefs:{...current.identityRefs,
        taskIds:input.ExpressionAttributeValues[":tasks"],eventIds:input.ExpressionAttributeValues[":events"]}});
      return {};
    }
    if(command.constructor.name.includes("Delete")){
      const key=`${input.Key.pk}|${input.Key.sk}`;
      const current=rows.get(key);
      assert.ok(current,"the inventoried row is present until its deletion step");
      rows.delete(key);
      return {};
    }
    throw new Error(`Unexpected database command ${command.constructor.name}`);
  }};
  const operation={...baseOperation,target:{...baseOperation.target,deleteCalendar:true},
    selectedActions:{deleteTodoist:true,deleteCalendar:true},
    inventory:identityRows.map(row=>({type:row.pk.split("#")[0],key:{pk:row.pk,sk:row.sk},digest:fingerprint(row),classification:"selected-only",
      ...(row.pk.startsWith("DELIVERY#")?{receiptCleanup:"scrub_identity_refs",
        scrubbedDigest:fingerprint({...row,identityRefs:{...row.identityRefs,
          taskIds:["unrelated-task"],eventIds:["unrelated-event"],seriesIds:["unrelated-series"]}})}:{})})),
    actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:"event-1",etag:"etag-approved",digest:fingerprint(event)},
      knownCalendarAliases:["event-1","alias-2","alias-3"].map(eventId=>({profile:"home",calendarId:"home@example.test",eventId})),
      knownCalendarAliasesComplete:true,
      projectCommentIds:["project-1"],scrubCompletedDeliveryIdentityRefsAfterTombstone:true,
      comments:[{id:"project-1",kind:"project",digest:fingerprint(original)}]}};
  const dependencies={db,clients:{todoist,calendar},inspectFence:async()=>({fence:{operationId:"erase-1"},leases:[]})};
  let progress={stage:"comments",commentIndex:0,stateIndex:0,startedAt:Date.parse("2026-11-08T12:00:00.000Z")};
  while(progress.stage!=="verify"){
    const result=await executeErasureDeletionStep(operation,progress,dependencies);
    progress=result.progress;
  }
  assert.equal(comment,undefined,"the original project mapping comment is deleted");
  assert.equal(task,undefined);
  assert.equal(event.status,"cancelled");
  assert.equal(rows.size,2,"identity-bearing mappings are removed while unrelated state and an identity-free receipt remain");
  assert.equal(rows.get(`${unrelatedRow.pk}|${unrelatedRow.sk}`),unrelatedRow);
  const receipt=[...rows.values()].find(row=>row.pk.startsWith("DELIVERY#"));
  assert.deepEqual(receipt.identityRefs,{taskIds:["unrelated-task"],eventIds:["unrelated-event"],seriesIds:["unrelated-series"]});
  const remainingDynamoRows=JSON.stringify([...rows.values()]);
  assert.doesNotMatch(remainingDynamoRows,/task-1|event-1|alias-2|alias-3/,
    "DynamoDB no longer contains the deleted task or any known Calendar alias");
  assert.equal(comment,undefined,"no deleted-task identity remains in project comments");
});

test("a missing exact project comment is treated as already deleted",async()=>{
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    comments:[{id:"project-1",kind:"project",digest:fingerprint("mapping")}]}};
  const result=await executeErasureDeletionStep(operation,{stage:"comments",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{getComment:async()=>{throw Object.assign(new Error("missing"),{status:404});}},calendar:{}},inspectFence:async()=>({leases:[]})});
  assert.equal(result.progress.commentIndex,1);
});

test("task deletion rejects malformed live responses instead of treating them as absent",async()=>{
  let deletes=0;
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,comments:[]}};
  await assert.rejects(executeErasureDeletionStep(operation,{stage:"todoist",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{getTask:async()=>({project_id:"test-home-project"}),deleteTask:async()=>{deletes++;}},calendar:{}},inspectFence:async()=>({leases:[]})}),
    ErasureGateDriftError);
  assert.equal(deletes,0);
});

test("state deletion uses an exact conditional match for every inventoried attribute",async()=>{
  const row={pk:"TASK#task-1",sk:"META",taskId:"task-1",profile:"home",revision:7};
  const operation={...baseOperation,inventory:[{type:"TASK",key:{pk:row.pk,sk:row.sk},digest:fingerprint(row),classification:"selected"}]};
  let deleteInput;
  const db={send:async command=>{
    if(command.constructor.name.includes("Get"))return {Item:row};
    if(command.constructor.name.includes("Delete")){deleteInput=command.input;return {};}
    throw new Error("Unexpected database command");
  }};
  const result=await executeErasureDeletionStep(operation,{stage:"state",commentIndex:0,stateIndex:0,startedAt:1},
    {db,clients:{todoist:{},calendar:{}},inspectFence:async()=>({leases:[]})});
  assert.equal(result.progress.stateIndex,1);
  assert.match(deleteInput.ConditionExpression,/#a\d+ = :v\d+/);
  assert.ok(Object.values(deleteInput.ExpressionAttributeNames).includes("revision"));
  assert.ok(Object.values(deleteInput.ExpressionAttributeValues).includes(7));
});

test("completed receipt identity scrubbing requires an operation-owned fence, not a tombstone",async()=>{
  const receipt={pk:"DELIVERY#receipt",sk:"COMPLETED",profile:"home",kind:"todoist",
    identityRefs:{taskIds:["task-1"],eventIds:["event-1"],seriesIds:[]},
    completedAt:"2026-11-08T12:00:00.000Z",expiresAt:1_800_000_000};
  const scrubbed={...receipt,identityRefs:{...receipt.identityRefs,taskIds:[],eventIds:[]}};
  const operation={...baseOperation,inventory:[{type:"DELIVERY",key:{pk:receipt.pk,sk:receipt.sk},
    digest:fingerprint(receipt),scrubbedDigest:fingerprint(scrubbed),receiptCleanup:"scrub_identity_refs",
    classification:"selected-only"}],actionPlan:{...baseOperation.actionPlan,
    projectCommentIds:["project-1"],scrubCompletedDeliveryIdentityRefsAfterTombstone:true,
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}],
    knownCalendarAliasesComplete:true,comments:[{id:"project-1",kind:"project",digest:fingerprint("mapping")}]} };
  let current=receipt,writeApplied=false;
  const db={send:async command=>{
    if(command.constructor.name.includes("Get"))return {Item:current};
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      current={...current,identityRefs:{...current.identityRefs,taskIds:values[":tasks"],eventIds:values[":events"]}};
      writeApplied=true;
      throw new Error("simulated lost DynamoDB update acknowledgement");
    }
    throw new Error("Unexpected database command");
  }};
  const deps=fence=>({db,clients:{todoist:{getComment:async()=>{throw new Error("Tombstones must not be read");}},calendar:{}},
    inspectFence:async()=>({fence,leases:[]})});
  const progress={stage:"state",commentIndex:0,stateIndex:0,startedAt:1};
  await assert.rejects(executeErasureDeletionStep(operation,progress,deps({operationId:"another-operation"})),ErasureGateDriftError);
  assert.equal(writeApplied,false,"another fence owner must block receipt changes");
  const result=await executeErasureDeletionStep(operation,progress,deps({operationId:"erase-1"}));
  assert.equal(result.progress.stateIndex,1);
  assert.equal(writeApplied,true);
  assert.deepEqual(current.identityRefs,{taskIds:[],eventIds:[],seriesIds:[]});
});

test("Calendar deletion is bound to the approved event ETag",async()=>{
  const event={id:"event-1",etag:"etag-approved",status:"confirmed",summary:"Exact event"};
  const operation={...baseOperation,target:{...baseOperation.target,deleteCalendar:true},
    selectedActions:{...baseOperation.selectedActions,deleteCalendar:true},
    actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:event.id,etag:event.etag,digest:fingerprint(event)}}};
  let deletes=[];
  const calendar={getEvent:async()=>deletes.length?{id:event.id,status:"cancelled"}:event,
    deleteEvent:async(id,etag)=>deletes.push({id,etag})};
  const result=await executeErasureDeletionStep(operation,{stage:"calendar",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{},calendar},inspectFence:async()=>({leases:[]})});
  assert.deepEqual(deletes,[{id:"event-1",etag:"etag-approved"}]);
  assert.equal(result.progress.stage,"state");
});

test("Calendar changes after approval block deletion",async()=>{
  const event={id:"event-1",etag:"etag-current",status:"confirmed",summary:"Changed event"};
  const operation={...baseOperation,target:{...baseOperation.target,deleteCalendar:true},
    selectedActions:{...baseOperation.selectedActions,deleteCalendar:true},
    actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:event.id,etag:"etag-approved",digest:fingerprint({id:event.id,etag:"etag-approved",status:"confirmed",summary:"Old event"})}}};
  let deletes=0;
  await assert.rejects(executeErasureDeletionStep(operation,{stage:"calendar",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{},calendar:{getEvent:async()=>event,deleteEvent:async()=>{deletes++;}}},inspectFence:async()=>({leases:[]})}),
    ErasureGateDriftError);
  assert.equal(deletes,0);
});

test("retained Calendar event loses only the exact Todoist link and verifies after a lost patch acknowledgement",async()=>{
  const taskId="task-1";
  const original={id:"event-1",calendarId:"home@example.test",etag:"etag-approved",updated:"2026-11-08T12:00:00Z",
    sequence:3,status:"confirmed",summary:"Keep this event",extendedProperties:{shared:{taskId,taskUrl:"https://app.todoist.com/app/task/task-1",
      syncSource:"todoist-calendar-sync",customColour:"blue"}}};
  const retained={...original,etag:"etag-after-patch",updated:"2026-11-08T12:01:00Z",sequence:4,
    extendedProperties:{shared:{customColour:"blue"}}};
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:original.id,
    calendarId:original.calendarId,digest:fingerprint(original),etag:original.etag,unlinkTodoistTask:taskId,
    unlinkDigest:unlinkedCalendarEventDigest(original,taskId)}}};
  let current=original,patches=0,reads=0;
  const calendar={getEvent:async()=>{reads++;return current;},
    updateSharedEventPropertiesIfUnchanged:async(id,etag,patch)=>{
      assert.equal(id,original.id);assert.equal(etag,original.etag);
      assert.deepEqual(patch,{taskId:null,taskUrl:null,syncSource:null});
      patches++;current=retained;
      throw new Error("connection dropped after Calendar accepted the patch");
    }};
  const progress={stage:"calendar",commentIndex:0,stateIndex:0,startedAt:1};
  await assert.rejects(executeErasureDeletionStep(operation,progress,
    {db:{send:async()=>({})},clients:{todoist:{},calendar},inspectFence:async()=>({leases:[]})}),/connection dropped/);
  const result=await executeErasureDeletionStep(operation,progress,
    {db:{send:async()=>({})},clients:{todoist:{},calendar:{...calendar,updateSharedEventPropertiesIfUnchanged:async()=>assert.fail("the exact postimage must not be patched twice")}},inspectFence:async()=>({leases:[]})});
  assert.equal(patches,1);
  assert.ok(reads>=3,"the uncertain write and retry are checked by direct Calendar readback");
  assert.deepEqual(current.extendedProperties.shared,{customColour:"blue"});
  assert.equal(result.progress.stage,"state");
});

test("Calendar direct read accepts exact 404 and deleted-resource 410 as already absent",async()=>{
  const operation={...baseOperation,target:{...baseOperation.target,deleteCalendar:true},
    selectedActions:{...baseOperation.selectedActions,deleteCalendar:true},
    actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:"event-1",etag:"etag-approved",digest:fingerprint({id:"event-1"})}}};
  for(const error of [
    Object.assign(new Error("not found"),{status:404}),
    Object.assign(new Error("gone"),{status:410,body:JSON.stringify({error:{errors:[{reason:"deleted"}]}})}),
  ]) {
    const calendar={getEvent:async id=>{assert.equal(id,"event-1");throw error;},
      deleteEvent:async()=>assert.fail("an already absent event must not be deleted again")};
    const result=await executeErasureDeletionStep(operation,{stage:"calendar",commentIndex:0,stateIndex:0,startedAt:1},
      {db:{send:async()=>({})},clients:{todoist:{},calendar},inspectFence:async()=>({leases:[]})});
    assert.equal(result.progress.stage,"state");
  }
});

test("Calendar 410 without exact deleted-resource evidence remains an error after a delete attempt",async()=>{
  const event={id:"event-1",etag:"etag-approved",status:"confirmed"};
  const operation={...baseOperation,target:{...baseOperation.target,deleteCalendar:true},
    selectedActions:{...baseOperation.selectedActions,deleteCalendar:true},
    actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:event.id,etag:event.etag,digest:fingerprint(event)}}};
  let reads=0,deletes=0;
  const calendar={getEvent:async()=>{
    if(reads++===0)return event;
    throw Object.assign(new Error("expired sync token"),{status:410,
      body:JSON.stringify({error:{errors:[{reason:"fullSyncRequired"}]}})});
  },deleteEvent:async()=>{deletes++;}};
  await assert.rejects(executeErasureDeletionStep(operation,{stage:"calendar",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{},calendar},inspectFence:async()=>({leases:[]})}),/expired sync token/);
  assert.equal(deletes,1,"the exact ETag-bound delete is attempted once");
  assert.equal(reads,2,"the uncertain delete outcome is checked with a direct readback");
});

test("legacy final-comments checkpoint retains only exact operation-owned project tombstones",async()=>{
  const { serializeDeletionTombstoneComment }=await import("../dist/mapping-comments.js");
  const original={
    schemaVersion:1,profile:"home",projectId:"test-home-project",taskId:"task-1",
    eventIds:["event-1"],createdAt:"2026-11-08T12:00:00.000Z",
    expiresAt:"2026-11-26T12:00:00.000Z",
  };
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    projectCommentIds:["project-1"],
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}]}};
  for(const mismatch of [
    {...original,taskId:"another-task"}, {...original,projectId:"another-project"},
    {...original,eventIds:["different-event"]},
  ]){
    let deletions=0;
    const comment={id:"project-1",project_id:"test-home-project",
      content:serializeDeletionTombstoneComment(mismatch)};
    const clients={todoist:{
      getComment:async()=>comment,
      deleteComment:async()=>{deletions++;},
    }};
    await assert.rejects(executeErasureDeletionStep(operation,
      {stage:"finalize_comments",commentIndex:0,stateIndex:0,finalCommentIndex:0,startedAt:1},
      {db:{send:async()=>({})},clients,inspectFence:async()=>({leases:[]})}),
      ErasureGateDriftError);
    assert.equal(deletions,0,"unrelated project content must not be deleted");
  }
});
test("legacy final-comments checkpoint retains an active verified tombstone",async()=>{
  const { serializeDeletionTombstoneComment }=await import("../dist/mapping-comments.js");
  const marker={schemaVersion:1,profile:"home",projectId:"test-home-project",taskId:"task-1",
    eventIds:["event-1"],createdAt:"2026-11-08T12:00:00.000Z",expiresAt:"2026-11-26T12:00:00.000Z"};
  const comment={id:"project-1",project_id:"test-home-project",content:serializeDeletionTombstoneComment(marker)};
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    projectCommentIds:["project-1"],
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}]}};
  let deletes=0;
  const result=await executeErasureDeletionStep(operation,
    {stage:"finalize_comments",commentIndex:0,stateIndex:0,finalCommentIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{
      getComment:async()=>comment,deleteComment:async()=>{deletes++;},
    }},inspectFence:async()=>({leases:[]})});
  assert.equal(result.progress.finalCommentIndex,1);
  assert.equal(deletes,0);
});


test("postflight requires the exact active tombstone and ignores unrelated notes",async()=>{
  const {serializeDeletionTombstoneComment}=await import("../dist/mapping-comments.js");
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    projectCommentIds:["original-1"],knownCalendarAliases:[
      {profile:"home",calendarId:"home@example.test",eventId:"event-1"}]}};
  const originalContent=serializeMappingComment({
    profile:"home",projectId:"test-home-project",taskId:"task-1",eventId:"event-1",
    updatedAt:"2026-11-08T12:00:00.000Z",
  },"test-home-project");
  const markerContent=serializeDeletionTombstoneComment({
    schemaVersion:1,profile:"home",projectId:"test-home-project",taskId:"task-1",
    eventIds:["event-1"],createdAt:"2026-11-08T12:00:00.000Z",
    expiresAt:"2026-11-26T12:00:00.000Z",
  });
  const unrelated={id:"unrelated",project_id:"test-home-project",content:"User's personal shopping note"};
  const now=Date.parse("2026-11-09T12:00:00.000Z");
  assert.equal(erasureProjectTombstonesPresent(operation,[unrelated,{...unrelated,id:"original-1",content:markerContent}],now),true);
  const overbroadMarker=serializeDeletionTombstoneComment({
    schemaVersion:1,profile:"home",projectId:"test-home-project",taskId:"task-1",
    eventIds:["event-1","unrelated-event"],createdAt:"2026-11-08T12:00:00.000Z",
    expiresAt:"2026-11-26T12:00:00.000Z",
  });
  assert.equal(erasureProjectTombstonesPresent(operation,[unrelated,{...unrelated,id:"original-1",content:overbroadMarker}],now),false,
    "a tombstone containing a receipt alias owned by another task must not pass postflight");
  assert.equal(erasureProjectTombstonesPresent(operation,[unrelated],now),false,"selected tombstone must remain");
  assert.equal(erasureProjectTombstonesPresent(operation,[unrelated,{...unrelated,id:"original-1",content:originalContent}],now),false,
    "an unconverted mapping comment cannot pass postflight");
  assert.equal(erasureProjectTombstonesPresent(operation,[unrelated,{...unrelated,id:"original-1",content:markerContent}],
    Date.parse("2026-11-27T12:00:00.000Z")),false,"expired tombstones cannot pass postflight");
});
