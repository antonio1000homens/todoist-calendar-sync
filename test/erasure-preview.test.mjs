import test from "node:test";
import assert from "node:assert/strict";
import { buildErasurePreview } from "../dist/erasure-preview.js";
import { serializeMappingComment } from "../dist/mapping-comments.js";

test("erasure preview scans complete state and providers read-only and returns a canonical exact inventory", async () => {
  const commands=[];
  const scanProgress=[];
  const scanAbortController=new AbortController();
  let scanSignal;
  const db={send:async (command,options)=>{
    commands.push(command.constructor.name);
    if(command.constructor.name==="ScanCommand") {
      scanSignal=options?.abortSignal;
      return {ConsumedCapacity:{CapacityUnits:2},Items:[
      {pk:"TASK#home#task-123",sk:"MAP",profile:"home",taskId:"task-123"},
      {pk:"AUDIT#home#one",sk:"STATE",detail:{taskId:"task-123"}},
      ],ScannedCount:2};
    }
    return {};
  }};
  const clients={
    todoist:{getTask:async id=>({id,project_id:"test-home-project",content:"private title"}),
      listProjectComments:async()=>[{id:"project-comment",content:serializeMappingComment({profile:"home",taskId:"task-123",eventId:"event-123",updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project")}],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>{throw Object.assign(new Error("missing"),{status:404});},
      findByTodoistTaskId:async()=>undefined},
  };
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",deleteCalendar:false},
    {db,clients,inspectFence:async()=>({leases:[]}),newOperationId:()=>"op-preview-1",
      scanAbortSignal:scanAbortController.signal,onInventoryProgress:progress=>scanProgress.push(progress)});
  assert.equal(preview.operationId,"op-preview-1");
  assert.equal(preview.inventory.length,2);
  assert.ok(preview.inventory.every(row=>row.key.pk&&row.key.sk&&row.digest&&row.classification));
  assert.deepEqual(preview.blockers,[]);
  assert.equal(JSON.stringify(preview).includes("private title"),false);
  assert.deepEqual(commands.sort(),["GetCommand","ScanCommand"]);
  assert.equal(scanSignal,scanAbortController.signal);
  assert.equal(scanProgress.length,1);
  assert.deepEqual({...scanProgress[0],elapsedMs:undefined},
    {pages:1,rowCount:2,consumedCapacityUnits:2,elapsedMs:undefined});
});

test("unsafe recurrence or active fence blocks confirmation-ready preview", async () => {
  const db={send:async command=>command.constructor.name==="ScanCommand"
    ?{Items:[{pk:"TASK#home#task-123",sk:"MAP",profile:"home",taskId:"task-123",recurrenceOwner:"todoist"}]}
    :{}};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project",due:{is_recurring:true}}),
      listProjectComments:async()=>[],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>undefined,findByTodoistTaskId:async()=>undefined}};
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",deleteCalendar:false},
    {db,clients,inspectFence:async()=>({fence:{operationId:"existing"},leases:[]}),newOperationId:()=>"op-preview-2"});
  assert.ok(preview.blockers.some(value=>value.includes("Recurring Todoist task")));
  assert.ok(preview.blockers.some(value=>value.includes("fence is active")));
});

test("erasure refuses to retain a Calendar event linked to the deleted Todoist task",async()=>{
  const taskId="task-retained-calendar",eventId="event-retained-calendar";
  const event={id:eventId,status:"confirmed",etag:"etag-retained-calendar",
    extendedProperties:{shared:{taskId}}};
  const db={send:async command=>command.constructor.name==="ScanCommand"?{Items:[],ScannedCount:0}:{}};
  const clients={
    todoist:{getTask:async id=>({id,project_id:"test-home-project",content:"disposable"}),
      listProjectComments:async()=>[{id:"project-comment",content:serializeMappingComment({
        profile:"home",taskId,eventId,updatedAt:"2026-11-08T12:00:00.000Z",
      },"test-home-project")}],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>event,findByTodoistTaskId:async()=>event},
  };
  const preview=await buildErasurePreview({profile:"home",taskId,eventId,deleteCalendar:false},
    {db,clients,inspectFence:async()=>({leases:[]}),newOperationId:()=>"retained-calendar"});
  assert.ok(preview.blockers.includes(
    "Calendar item exists; select and confirm its exact deletion or handle re-import risk manually"));
  assert.ok(preview.blockers.includes(
    "A live Calendar projection would recreate the Todoist task unless separately deleted"));
  assert.equal(preview.confirmation,undefined);
});

test("strong state scan rejects a repeated pagination cursor instead of accepting an incomplete inventory",async()=>{
  const cursor={pk:"AUDIT#home#one",sk:"STATE"};
  let scans=0;
  const db={send:async command=>{
    if(command.constructor.name!=="ScanCommand")return {};
    scans++;
    return {Items:[scans===1
      ?{pk:"TASK#home#task-123",sk:"MAP",taskId:"task-123"}
      :{pk:"AUDIT#home#second",sk:"STATE",detail:"new row"}],LastEvaluatedKey:cursor};
  }};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project"}),
      listProjectComments:async()=>[{id:"project-comment",content:serializeMappingComment({profile:"home",taskId:"task-123",eventId:"event-123",updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project")}],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>undefined,findByTodoistTaskId:async()=>undefined}};
  await assert.rejects(buildErasurePreview({profile:"home",taskId:"task-123",deleteCalendar:false},
    {db,clients,inspectFence:async()=>({leases:[]})}),/repeated a pagination cursor/);
  assert.equal(scans,2);
});

test("malformed live provider responses cannot produce an exact preview", async t => {
  for (const [name, todoistTask, calendarEvent, target] of [
    ["empty Todoist response", {}, undefined, { profile:"home", taskId:"task-123", deleteCalendar:false }],
    ["Todoist response without project identity", { id:"task-123" }, undefined, { profile:"home", taskId:"task-123", deleteCalendar:false }],
    ["empty Calendar response", { id:"task-123", project_id:"test-home-project" }, {}, { profile:"home", taskId:"task-123", eventId:"event-123", deleteCalendar:true }],
    ["Calendar response without identity", { id:"task-123", project_id:"test-home-project" }, { status:"confirmed" }, { profile:"home", taskId:"task-123", eventId:"event-123", deleteCalendar:true }],
    ["cancelled Calendar response without identity", { id:"task-123", project_id:"test-home-project" }, { status:"cancelled" }, { profile:"home", taskId:"task-123", eventId:"event-123", deleteCalendar:true }],
    ["cancelled Calendar response with wrong identity", { id:"task-123", project_id:"test-home-project" }, { id:"other-event", status:"cancelled" }, { profile:"home", taskId:"task-123", eventId:"event-123", deleteCalendar:true }],
  ]) {
    await t.test(name, async () => {
      const db={send:async command=>command.constructor.name==="ScanCommand"?{Items:[]}: {}};
      const clients={todoist:{getTask:async()=>todoistTask,listProjectComments:async()=>[],listTaskComments:async()=>[]},
        calendar:{getEvent:async()=>calendarEvent,findByTodoistTaskId:async()=>undefined}};
      const preview=await buildErasurePreview(target,{db,clients,inspectFence:async()=>({leases:[]})});
      assert.ok(preview.blockers.length>0);
      assert.equal(preview.confirmation,undefined);
    });
  }
});

test("cancelled linked lookup results require the exact selected Calendar identity", async t => {
  for (const [name, linked] of [
    ["missing linked event identity", { status:"cancelled" }],
    ["wrong linked event identity", { id:"other-event", status:"cancelled" }],
  ]) {
    await t.test(name, async () => {
      const db={send:async command=>command.constructor.name==="ScanCommand"?{Items:[]}: {}};
      const clients={todoist:{getTask:async()=>({id:"task-123",project_id:"test-home-project"}),
          listProjectComments:async()=>[],listTaskComments:async()=>[]},
        calendar:{getEvent:async()=>{throw Object.assign(new Error("missing"),{status:404});},
          findByTodoistTaskId:async()=>linked}};
      const preview=await buildErasurePreview({profile:"home",taskId:"task-123",eventId:"event-123",deleteCalendar:true},
        {db,clients,inspectFence:async()=>({leases:[]})});
      assert.ok(preview.blockers.some(value=>value.includes("Calendar projection links")));
    });
  }
});

test("deletion preview captures profile and Calendar-scoped event aliases before any mutation",async()=>{
  const db={send:async command=>command.constructor.name==="ScanCommand"
    ?{Items:[{pk:"TASK#home#task-123",sk:"MAP",profile:"home",taskId:"task-123",eventId:"event-123"}]}
    :{}};
  const event={id:"event-123",etag:"etag-123",extendedProperties:{shared:{taskId:"task-123"}}};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project"}),
      listProjectComments:async()=>[{id:"project-comment",content:serializeMappingComment({profile:"home",taskId:"task-123",eventId:"event-123",updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project")}],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>event,findByTodoistTaskId:async()=>event}};
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",eventId:"event-123",deleteCalendar:true},
    {db,clients,inspectFence:async()=>({leases:[]})});
  assert.deepEqual(preview.actionPlan.knownCalendarAliases,[
    {profile:"home",calendarId:"home@example.test",eventId:"event-123"},
  ]);
  assert.equal(preview.actionPlan.knownCalendarAliasesComplete,true);
  assert.equal(preview.actionPlan.calendarEvent.calendarId,"home@example.test");
  assert.deepEqual(preview.blockers,[]);
});

test("erasure preview binds completed delivery identity scrubbing to post-tombstone cleanup",async()=>{
  const receipt={pk:"DELIVERY#exact",sk:"COMPLETED",profile:"home",kind:"calendar",
    identityRefs:{taskIds:["task-123"],eventIds:["event-123"],seriesIds:[]},
    completedAt:"2026-11-08T12:00:00.000Z",expiresAt:1_800_000_000};
  const db={send:async command=>command.constructor.name==="ScanCommand"?{Items:[receipt]}:{}};
  const event={id:"event-123",etag:"etag-123",extendedProperties:{shared:{taskId:"task-123"}}};
  const comment={id:"project-comment",content:serializeMappingComment({profile:"home",taskId:"task-123",
    eventId:"event-123",updatedAt:"2026-11-08T12:00:00.000Z"},"test-home-project")};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project"}),
      listProjectComments:async()=>[comment],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>event,findByTodoistTaskId:async()=>event}};
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",eventId:"event-123",deleteCalendar:true},
    {db,clients,inspectFence:async()=>({leases:[]})});
  assert.deepEqual(preview.blockers,[]);
  assert.equal(preview.inventory.some(item=>item.type==="DELIVERY"&&item.key.sk==="COMPLETED"
    &&item.receiptCleanup==="scrub_identity_refs"&&/^[a-f0-9]{64}$/.test(item.scrubbedDigest)),true);
  assert.equal(preview.actionPlan.scrubCompletedDeliveryIdentityRefsAfterTombstone,true);
  assert.equal(preview.receiptSanitizationRequirements.length,1);
});

test("recorded profile moves are retained in the alias manifest and block cross-profile deletion",async()=>{
  const db={send:async command=>command.constructor.name==="ScanCommand"
    ?{Items:[{pk:"EVENT#antonio#task-123",sk:"event-1",profile:"antonio",taskId:"task-123",eventId:"moved-event"}]}
    :{}};
  const event={id:"event-123",etag:"etag-123",extendedProperties:{shared:{taskId:"task-123"}}};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project"}),
      listProjectComments:async()=>[],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>event,findByTodoistTaskId:async()=>event}};
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",eventId:"event-123",deleteCalendar:true},
    {db,clients,inspectFence:async()=>({leases:[]})});
  assert.ok(preview.actionPlan.knownCalendarAliases.some(alias=>alias.profile==="antonio"
    &&alias.calendarId==="personal@example.test"&&alias.eventId==="moved-event"));
  assert.ok(preview.blockers.length>0,"a cross-profile move is recorded but still requires review");
  assert.equal(preview.confirmation,undefined);
});

test("recurring master IDs from exact Calendar metadata are saved but remain manual-review only",async()=>{
  const db={send:async command=>command.constructor.name==="ScanCommand"
    ?{Items:[{pk:"TASK#home#task-123",sk:"MAP",profile:"home",taskId:"task-123",eventId:"event-123"}]}
    :{}};
  const event={id:"event-123",etag:"etag-123",recurringEventId:"series-master",
    extendedProperties:{shared:{taskId:"task-123"}}};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project"}),
      listProjectComments:async()=>[],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>event,findByTodoistTaskId:async()=>event}};
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",eventId:"event-123",deleteCalendar:true},
    {db,clients,inspectFence:async()=>({leases:[]})});
  assert.ok(preview.actionPlan.knownCalendarAliases.some(alias=>alias.eventId==="series-master"));
  assert.ok(preview.blockers.some(item=>item.includes("series/exception requires manual handling")));
  assert.equal(preview.confirmation,undefined);
});

test("an event reference without a trustworthy profile scope cannot produce a complete marker manifest",async()=>{
  const db={send:async command=>command.constructor.name==="ScanCommand"
    ?{Items:[{pk:"AUDIT#opaque#row",sk:"STATE",detail:{taskId:"task-123",eventId:"orphan-event"}}]}
    :{}};
  const event={id:"event-123",etag:"etag-123",extendedProperties:{shared:{taskId:"task-123"}}};
  const clients={todoist:{getTask:async id=>({id,project_id:"test-home-project"}),
      listProjectComments:async()=>[],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>event,findByTodoistTaskId:async()=>event}};
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",eventId:"event-123",deleteCalendar:true},
    {db,clients,inspectFence:async()=>({leases:[]})});
  assert.equal(preview.actionPlan.knownCalendarAliasesComplete,false);
  assert.ok(preview.blockers.some(item=>item.includes("no unambiguous profile scope")));
  assert.equal(preview.confirmation,undefined);
});
