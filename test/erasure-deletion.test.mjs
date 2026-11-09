import test from "node:test";
import assert from "node:assert/strict";
import { executeErasureDeletionStep } from "../dist/erasure-deletion.js";
import { ErasureGateDriftError } from "../dist/erasure-executor.js";
import { fingerprint } from "../scripts/item-purge-policy.mjs";
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

test("confirmed erasure replaces the project mapping comment with a readback-verified bounded tombstone",async()=>{
  let deletes=0;
  const original=serializeMappingComment({profile:"home",projectId:"test-home-project",taskId:"task-1",eventId:"event-1",updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project");
  let current={id:"project-1",project_id:"test-home-project",content:original};
  const todoist={getComment:async id=>{assert.equal(id,"project-1");return current;},
    updateComment:async(id,content)=>{assert.equal(id,"project-1");current={...current,content};return current;},
    deleteComment:async()=>{deletes++;}};
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}],
    comments:[{id:"project-1",kind:"project",digest:fingerprint(original)}]}};
  const startedAt=Date.now();
  const result=await executeErasureDeletionStep(operation,{stage:"comments",commentIndex:0,stateIndex:0,startedAt:Date.parse("2026-11-08T12:00:00.000Z")},
    {db:{send:async()=>({})},clients:{todoist,calendar:{}},inspectFence:async()=>({leases:[]})});
  const tombstone=parseDeletionTombstoneComment(current);
  assert.equal(result.progress.commentIndex,1);
  assert.equal(tombstone.taskId,"task-1");
  assert.deepEqual(tombstone.eventIds,["event-1"]);
  assert.ok(Date.parse(tombstone.createdAt)>=startedAt);
  assert.equal(Date.parse(tombstone.expiresAt)-Date.parse(tombstone.createdAt),PROJECT_DELETION_TOMBSTONE_RETENTION_MS);
  assert.equal(deletes,0,"the project note must remain as the temporary replay marker");
});

test("a repeated project-comment deletion step accepts only its exact tombstone after a lost checkpoint acknowledgement",async()=>{
  const original=serializeMappingComment({profile:"home",projectId:"test-home-project",taskId:"task-1",eventId:"event-1",
    updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project");
  let comment={id:"project-1",project_id:"test-home-project",content:original};
  let updates=0;
  const todoist={getComment:async()=>comment,
    updateComment:async(id,content)=>{updates++;comment={...comment,id,content};return comment;}};
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}],
    comments:[{id:"project-1",kind:"project",digest:fingerprint(original)}]}};
  const staleProgress={stage:"comments",commentIndex:0,stateIndex:0,startedAt:Date.parse("2026-11-08T12:00:00.000Z")};
  const dependencies={db:{send:async()=>({})},clients:{todoist,calendar:{}},inspectFence:async()=>({leases:[]})};
  const first=await executeErasureDeletionStep(operation,staleProgress,dependencies);
  assert.equal(parseDeletionTombstoneComment(comment)?.taskId,"task-1");
  assert.equal(updates,1);

  // Simulate provider success followed by a lost DynamoDB progress ACK: retry
  // the same operation step from the original checkpoint.
  const replay=await executeErasureDeletionStep(operation,staleProgress,dependencies);
  assert.equal(replay.progress.commentIndex,first.progress.commentIndex);
  assert.equal(updates,1,"replay verifies the existing marker without rewriting its expiry");
  assert.equal(comment.id,"project-1","the existing project comment ID is preserved");
});

test("provider deletion leaves replay identity in Todoist and scrubs completed receipt identities from DynamoDB",async()=>{
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
      identityRefs:{taskIds:["task-1"],eventIds:["event-1"],seriesIds:[]},
      completedAt:"2026-11-08T12:00:00.000Z",expiresAt:1_800_000_000},
    {pk:"AUDIT#home#event-1",sk:"STATE",detail:{taskId:"task-1",eventId:"event-1"}},
  ];
  const unrelatedRow={pk:"TASK#home#unrelated",sk:"MAPPING",taskId:"unrelated-task",eventId:"unrelated-event",profile:"home"};
  const rows=new Map([...identityRows,unrelatedRow].map(row=>[`${row.pk}|${row.sk}`,row]));
  const todoist={
    async getComment(id){assert.equal(id,"project-1");if(!comment)throw Object.assign(new Error("not found"),{status:404});return comment;},
    async updateComment(id,content){assert.equal(id,"project-1");comment={...comment,content};return comment;},
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
        scrubbedDigest:fingerprint({...row,identityRefs:{...row.identityRefs,taskIds:[],eventIds:[]}})}:{})})),
    actionPlan:{...baseOperation.actionPlan,calendarEvent:{id:"event-1",etag:"etag-approved",digest:fingerprint(event)},
      knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}],
      projectCommentIds:["project-1"],scrubCompletedDeliveryIdentityRefsAfterTombstone:true,
      comments:[{id:"project-1",kind:"project",digest:fingerprint(original)}]}};
  const dependencies={db,clients:{todoist,calendar},inspectFence:async()=>({fence:{operationId:"erase-1"},leases:[]})};
  let progress={stage:"comments",commentIndex:0,stateIndex:0,startedAt:Date.parse("2026-11-08T12:00:00.000Z")};
  while(progress.stage!=="verify"){
    const result=await executeErasureDeletionStep(operation,progress,dependencies);
    progress=result.progress;
  }
  const tombstone=parseDeletionTombstoneComment(comment);
  assert.equal(tombstone?.taskId,"task-1");
  assert.deepEqual(tombstone?.eventIds,["event-1"]);
  assert.equal(task,undefined);
  assert.equal(event.status,"cancelled");
  assert.equal(rows.size,2,"identity-bearing mappings are removed while unrelated state and an identity-free receipt remain");
  assert.equal(rows.get(`${unrelatedRow.pk}|${unrelatedRow.sk}`),unrelatedRow);
  const receipt=[...rows.values()].find(row=>row.pk.startsWith("DELIVERY#"));
  assert.deepEqual(receipt.identityRefs,{taskIds:[],eventIds:[],seriesIds:[]});
  const remainingDynamoRows=JSON.stringify([...rows.values()]);
  assert.doesNotMatch(remainingDynamoRows,/task-1|event-1/,
    "DynamoDB no longer contains the deleted task or Calendar event identity");
  assert.equal(tombstone.taskId,"task-1","the bounded replay identity remains in the Todoist project comment");
  assert.deepEqual(tombstone.eventIds,["event-1"]);
});

test("confirmed erasure cannot advance when its project tombstone comment is missing",async()=>{
  const operation={...baseOperation,actionPlan:{...baseOperation.actionPlan,
    comments:[{id:"project-1",kind:"project",digest:fingerprint("mapping")}]}};
  await assert.rejects(executeErasureDeletionStep(operation,{stage:"comments",commentIndex:0,stateIndex:0,startedAt:1},
    {db:{send:async()=>({})},clients:{todoist:{getComment:async()=>{throw Object.assign(new Error("missing"),{status:404});}},calendar:{}},inspectFence:async()=>({leases:[]})}),/missing/);
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

test("completed receipt identity scrubbing requires the confirmed active project tombstone on every step",async()=>{
  const receipt={pk:"DELIVERY#receipt",sk:"COMPLETED",profile:"home",kind:"todoist",
    identityRefs:{taskIds:["task-1"],eventIds:["event-1"],seriesIds:[]},
    completedAt:"2026-11-08T12:00:00.000Z",expiresAt:1_800_000_000};
  const scrubbed={...receipt,identityRefs:{...receipt.identityRefs,taskIds:[],eventIds:[]}};
  const operation={...baseOperation,inventory:[{type:"DELIVERY",key:{pk:receipt.pk,sk:receipt.sk},
    digest:fingerprint(receipt),scrubbedDigest:fingerprint(scrubbed),receiptCleanup:"scrub_identity_refs",
    classification:"selected-only"}],actionPlan:{...baseOperation.actionPlan,
    projectCommentIds:["project-1"],scrubCompletedDeliveryIdentityRefsAfterTombstone:true,
    knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-1"}],
    comments:[{id:"project-1",kind:"project",digest:fingerprint("mapping")}]} };
  const db={send:async command=>command.constructor.name.includes("Get")?{Item:receipt}:({})};
  const noMarker={todoist:{getComment:async()=>({id:"project-1",project_id:"test-home-project",content:"mapping"})},calendar:{}};
  await assert.rejects(executeErasureDeletionStep(operation,{stage:"state",commentIndex:0,stateIndex:0,startedAt:1},
    {db,clients:noMarker,inspectFence:async()=>({fence:{operationId:"erase-1"},leases:[]})}),ErasureGateDriftError);

  const createdAt=new Date().toISOString();
  const marker=serializeDeletionTombstoneComment({schemaVersion:1,profile:"home",projectId:"test-home-project",
    taskId:"task-1",eventIds:["event-1"],createdAt,
    expiresAt:new Date(Date.parse(createdAt)+PROJECT_DELETION_TOMBSTONE_RETENTION_MS).toISOString()});
  let current=receipt,writeApplied=false;
  const clients={todoist:{getComment:async()=>({id:"project-1",project_id:"test-home-project",
    content:marker})},calendar:{}};
  const guardedDb={send:async command=>{
    if(command.constructor.name.includes("Get"))return {Item:current};
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      current={...current,identityRefs:{...current.identityRefs,taskIds:values[":tasks"],eventIds:values[":events"]}};
      writeApplied=true;
      throw new Error("simulated lost DynamoDB update acknowledgement");
    }
    throw new Error("Unexpected database command");
  }};
  const result=await executeErasureDeletionStep(operation,{stage:"state",commentIndex:0,stateIndex:0,startedAt:1},
    {db:guardedDb,clients,inspectFence:async()=>({fence:{operationId:"erase-1"},leases:[]})});
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
