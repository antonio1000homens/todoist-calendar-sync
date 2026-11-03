import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewStore } from "../dist/review-store.js";

test("one-sided deleted conflict puts bounded exact task and master/occurrence guards",async()=>{
  const writes=[];
  const store=new ReviewStore({send:async command=>{
    assert.ok(command instanceof PutCommand);
    writes.push(command.input.Item);
    return {};
  }});
  await store.indexDeletedConflictCase({
    id:"case-278",profile:"home",status:"open",title:"Conflict",reason:"todoist_unmapped_conflict",
    createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-02T00:00:00Z",
    taskId:"task-1",eventId:"master-1",
    decision:{context:{candidateTaskIds:["task-2"],candidateEventIds:["occ-1"]}},
  });
  assert.deepEqual(writes.map(x=>x.pk).sort(),[
    "DELETION_REVIEW#home#calendar#master-1",
    "DELETION_REVIEW#home#calendar#occ-1",
    "DELETION_REVIEW#home#todoist#task-1",
    "DELETION_REVIEW#home#todoist#task-2",
  ]);
  assert.ok(writes.every(x=>x.sk==="CASE#case-278"));
  assert.ok(writes.every(x=>x.expiresAt>Date.now()/1000));
  assert.ok(writes.every(x=>x.expiresAt<Date.now()/1000+100*86400));
});

test("deletion guard blocks only open current case and never coalesced, resolved or unrelated IDs",async()=>{
  let candidate={id:"case-278",profile:"home",status:"open",
    taskId:"task-1",eventId:"master-1",createdAt:"2026-11-01T00:00:00Z",
    updatedAt:"2026-11-02T00:00:00Z",title:"Conflict",reason:"deleted"};
  const store=new ReviewStore({send:async cmd=>{
    if(cmd instanceof QueryCommand)return {Items:[{caseId:"case-278",expiresAt:Math.floor(Date.now()/1000)+3600}]};
    if(cmd instanceof GetCommand) return {Item:candidate};
    throw new Error("unexpected "+cmd.constructor.name);
  }});
  assert.equal(await store.hasActiveDeletionGuard("home","todoist","task-1"),true);
  assert.equal(await store.hasActiveDeletionGuard("home","calendar","other"),false);
  candidate={...candidate,status:"resolved",result:"resolved_deleted"};
  assert.equal(await store.hasActiveDeletionGuard("home","todoist","task-1"),false);
  candidate={...candidate,status:"dismissed"};
  assert.equal(await store.hasActiveDeletionGuard("home","todoist","task-1"),false);
});

test("deletion guard fails closed on pointer pagination without guessing case identity",async()=>{
  const store=new ReviewStore({send:async cmd=>{
    if(cmd instanceof QueryCommand)return {Items:[],LastEvaluatedKey:{pk:"more",sk:"more"}};
    throw new Error("unexpected");
  }});
  assert.equal(await store.hasActiveDeletionGuard("work","calendar","master-1"),true);
});
