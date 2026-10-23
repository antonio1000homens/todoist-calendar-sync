import test from "node:test";
import assert from "node:assert/strict";
import { buildErasurePreview } from "../dist/erasure-preview.js";

test("erasure preview scans complete state and providers read-only and returns a canonical exact inventory", async () => {
  const commands=[];
  const db={send:async command=>{
    commands.push(command.constructor.name);
    if(command.constructor.name==="ScanCommand") return {Items:[
      {pk:"TASK#home#task-123",sk:"MAP",profile:"home",taskId:"task-123"},
      {pk:"AUDIT#home#one",sk:"STATE",detail:{taskId:"task-123"}},
    ],ScannedCount:2};
    return {};
  }};
  const clients={
    todoist:{getTask:async id=>({id,project_id:"test-home-project",content:"private title"}),
      listProjectComments:async()=>[],listTaskComments:async()=>[]},
    calendar:{getEvent:async()=>{throw Object.assign(new Error("missing"),{status:404});},
      findByTodoistTaskId:async()=>undefined},
  };
  const preview=await buildErasurePreview({profile:"home",taskId:"task-123",deleteCalendar:false},
    {db,clients,inspectFence:async()=>({leases:[]}),newOperationId:()=>"op-preview-1"});
  assert.equal(preview.operationId,"op-preview-1");
  assert.equal(preview.inventory.length,2);
  assert.ok(preview.inventory.every(row=>row.key.pk&&row.key.sk&&row.digest&&row.classification));
  assert.deepEqual(preview.blockers,[]);
  assert.equal(JSON.stringify(preview).includes("private title"),false);
  assert.deepEqual(commands.sort(),["GetCommand","ScanCommand"]);
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
