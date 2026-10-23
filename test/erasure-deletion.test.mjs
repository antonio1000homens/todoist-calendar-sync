import test from "node:test";
import assert from "node:assert/strict";
import { executeErasureDeletionStep } from "../dist/erasure-deletion.js";
import { ErasureGateDriftError } from "../dist/erasure-executor.js";
import { fingerprint } from "../scripts/item-purge-policy.mjs";

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
