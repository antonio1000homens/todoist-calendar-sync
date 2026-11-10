import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {calendarReplaySourceIds,guardReplayProviderClients} from "../dist/erasure-replay-providers.js";
import {ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";
import {RetirementDispositionBlockedError} from "../dist/recurrence-retirement-disposition.js";

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

test("Calendar source provenance remains exact and bounded",()=>{
  assert.deepEqual(calendarReplaySourceIds({id:"instance-1",recurringEventId:"master-1"}),["instance-1","master-1"]);
  assert.throws(()=>calendarReplaySourceIds({id:""}),ErasureReplayUnavailableError);
  assert.throws(()=>calendarReplaySourceIds({id:"event-1"},""),ErasureReplayUnavailableError);
  assert.throws(()=>calendarReplaySourceIds({id:"event-1"},...Array.from({length:33},(_,i)=>"alias-"+i)),ErasureReplayUnavailableError);
});
