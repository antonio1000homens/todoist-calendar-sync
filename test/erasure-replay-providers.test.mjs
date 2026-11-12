import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {calendarReplaySourceIds,guardReplayProviderClients} from "../dist/erasure-replay-providers.js";
import {ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";
import {RetirementDispositionBlockedError} from "../dist/recurrence-retirement-disposition.js";
import {projectDeletionTombstoneExpiry,serializeDeletionTombstoneComment,serializeMappingComment} from "../dist/mapping-comments.js";

function configure(t,values){
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  for(const [key,value] of Object.entries(values)) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  t.after(()=>{for(const [key,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
}
function fixture(){
  const calls=[];
  const clients=guardReplayProviderClients("work",{
    calendar:{
      async deleteEvent(...args){calls.push(["calendar.deleteEvent",...args]);},
      async upsertEvent(...args){calls.push(["calendar.upsertEvent",...args]);return {id:"event-new"};},
    },
    todoist:{
      async upsertTask(...args){calls.push(["todoist.upsertTask",...args]);return {id:"task-new"};},
      async createTaskOnce(...args){calls.push(["todoist.createTaskOnce",...args]);return {id:"task-new"};},
      async updateComment(...args){calls.push(["todoist.updateComment",...args]);},
    },
  });
  return {clients,calls};
}

test("normal provider operations do not query retired HMAC markers when gate is disabled",async t=>{
  configure(t,{ERASURE_REPLAY_BARRIER_VERSION:"0",RETIREMENT_DISPOSITION_VERSION:"0"});
  let reads=0;
  t.mock.method(documentClient,"send",async()=>{reads++;throw Error("legacy DDB marker lookup");});
  const {clients,calls}=fixture();
  await clients.calendar.deleteEvent("event-1");
  await clients.todoist.upsertTask({content:"updated"},"task-1");
  assert.deepEqual(calls.map(call=>call[0]),["calendar.deleteEvent","todoist.upsertTask"]);
  assert.equal(reads,0);
});

test("attempting to reactivate the obsolete HMAC gate refuses all provider mutations",async t=>{
  configure(t,{ERASURE_REPLAY_BARRIER_VERSION:"1",RETIREMENT_DISPOSITION_VERSION:"0"});
  const {clients,calls}=fixture();
  const invalid=[
    ()=>clients.calendar.deleteEvent("event-1"),
    ()=>clients.calendar.upsertEvent({id:"event-1"}),
    ()=>clients.todoist.upsertTask({content:"changed"},"task-1"),
    ()=>clients.todoist.createTaskOnce({content:"new"},"request-id",["calendar-id"]),
  ];
  for(const invoke of invalid)await assert.rejects(invoke(),ErasureReplayUnavailableError);
  assert.deepEqual(calls,[]);
});

test("recurrence retirement receipt still blocks matched provider writes without the HMAC gate",async t=>{
  configure(t,{
    STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
    RETIREMENT_DISPOSITION_VERSION:"1",
  });
  const reads=[];
  t.mock.method(documentClient,"send",async command=>{
    assert.equal(command.constructor.name,"GetCommand");
    assert.equal(command.input.ConsistentRead,true);
    reads.push(command.input.Key.pk);
    return {Item:{profile:"work",status:"retired",operationId:"op-1",
      taskId:"task-1",seriesId:"series-1",masterEventId:"event-1",createdAt:"2026-11-10T12:00:00.000Z"}};
  });
  const {clients,calls}=fixture();
  await assert.rejects(clients.calendar.deleteEvent("event-1"),RetirementDispositionBlockedError);
  await assert.rejects(clients.todoist.upsertTask({content:"changed"},"task-1"),RetirementDispositionBlockedError);
  assert.deepEqual(reads,["RETIREMENT#work#EVENT#event-1","RETIREMENT#work#TASK#task-1"]);
  assert.deepEqual(calls,[]);
});

test("project tombstone update is admitted using its task and Calendar identity",async t=>{
  configure(t,{STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  const reads=[];
  t.mock.method(documentClient,"send",async command=>{
    reads.push(command.input.Key.pk);
    return {};
  });
  const tombstone=serializeDeletionTombstoneComment({schemaVersion:1,profile:"work",projectId:"project-work",
    taskId:"task-1",eventIds:["event-1","master-1"],createdAt:"2026-11-10T12:00:00.000Z",
    expiresAt:"2026-11-28T12:00:00.000Z"});
  const {clients,calls}=fixture();
  await clients.todoist.updateComment("comment-1",tombstone);
  assert.deepEqual(reads,["RETIREMENT#work#TASK#task-1","RETIREMENT#work#EVENT#event-1",
    "RETIREMENT#work#EVENT#master-1"]);
  assert.deepEqual(calls.map(call=>call[0]),["todoist.updateComment"]);
});

test("project tombstone update rejects a mismatched profile before the provider call",async t=>{
  configure(t,{STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  const {clients,calls}=fixture();
  const tombstone=serializeDeletionTombstoneComment({schemaVersion:1,profile:"home",projectId:"project-home",
    taskId:"task-1",eventIds:["event-1"],createdAt:"2026-11-10T12:00:00.000Z",
    expiresAt:"2026-11-28T12:00:00.000Z"});
  await assert.rejects(clients.todoist.updateComment("comment-1",tombstone),ErasureReplayUnavailableError);
  assert.deepEqual(calls,[]);
});

test("comment deletion derives exact owner identity from a current provider read before deleting",async t=>{
  configure(t,{STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  const mapping={profile:"work",taskId:"task-delete",eventId:"event-delete",masterEventId:"master-delete",
    activeInstanceId:"instance-delete",projectId:"project-work",updatedAt:"2026-11-10T12:00:00.000Z"};
  const comment={id:"comment-delete",project_id:"project-work",
    content:serializeMappingComment(mapping,"project-work")};
  const order=[],reads=[];
  t.mock.method(documentClient,"send",async command=>{
    assert.equal(command.constructor.name,"GetCommand");
    reads.push(command.input.Key.pk);order.push("disposition-read");return {};
  });
  const clients=guardReplayProviderClients("work",{calendar:{},todoist:{
    async getComment(id){order.push("provider-read");assert.equal(id,comment.id);return comment;},
    async deleteComment(id){order.push("provider-delete");assert.equal(id,comment.id);},
  }});
  await clients.todoist.deleteComment(comment.id);
  assert.deepEqual(reads,["RETIREMENT#work#TASK#task-delete","RETIREMENT#work#EVENT#event-delete",
    "RETIREMENT#work#EVENT#master-delete","RETIREMENT#work#EVENT#instance-delete"]);
  assert.equal(order[0],"provider-read");
  assert.equal(order.at(-1),"provider-delete");
});

test("comment deletion fails closed for unowned comments and retains live erasure tombstones",async t=>{
  configure(t,{STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  let comment={id:"user-comment",project_id:"project-work",content:"A user-authored note"};
  let deletes=0,reads=0;
  t.mock.method(documentClient,"send",async()=>{reads++;return {};});
  const clients=guardReplayProviderClients("work",{calendar:{},todoist:{
    async getComment(){return comment;},async deleteComment(){deletes++;},
  }});
  await assert.rejects(clients.todoist.deleteComment(comment.id),/verified owner identity/);
  const createdAt=new Date().toISOString();
  comment={id:"live-tombstone",project_id:"project-work",content:serializeDeletionTombstoneComment({
    schemaVersion:1,profile:"work",projectId:"project-work",taskId:"task-live",eventIds:["event-live"],
    createdAt,expiresAt:projectDeletionTombstoneExpiry(createdAt),
  })};
  await assert.rejects(clients.todoist.deleteComment(comment.id),/retained as replay fences/);
  assert.equal(deletes,0);
  assert.equal(reads,0);
});

test("expired project tombstones can be deleted only after their recorded identity is read",async t=>{
  configure(t,{STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  const now=Date.now();
  const createdAt=new Date(now-19*24*60*60*1000).toISOString();
  const comment={id:"expired-tombstone",project_id:"project-work",content:serializeDeletionTombstoneComment({
    schemaVersion:1,profile:"work",projectId:"project-work",taskId:"task-expired",eventIds:["event-expired"],
    createdAt,expiresAt:projectDeletionTombstoneExpiry(createdAt),
  })};
  const reads=[];let deleted=0;
  t.mock.method(documentClient,"send",async command=>{reads.push(command.input.Key.pk);return {};});
  const clients=guardReplayProviderClients("work",{calendar:{},todoist:{
    async getComment(){return comment;},async deleteComment(){deleted++;},
  }});
  await clients.todoist.deleteComment(comment.id);
  assert.deepEqual(reads,["RETIREMENT#work#TASK#task-expired","RETIREMENT#work#EVENT#event-expired"]);
  assert.equal(deleted,1);
});

test("Calendar source provenance remains exact and bounded",()=>{
  assert.deepEqual(calendarReplaySourceIds({id:"instance-1",recurringEventId:"master-1"}),["instance-1","master-1"]);
  assert.throws(()=>calendarReplaySourceIds({id:""}),ErasureReplayUnavailableError);
  assert.throws(()=>calendarReplaySourceIds({id:"event-1"},""),ErasureReplayUnavailableError);
  assert.throws(()=>calendarReplaySourceIds({id:"event-1"},...Array.from({length:33},(_,i)=>"alias-"+i)),ErasureReplayUnavailableError);
});
