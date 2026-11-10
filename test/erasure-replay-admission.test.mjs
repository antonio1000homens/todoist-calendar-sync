import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {StateRepository} from "../dist/repository.js";
import {
  assertReplayAdmissionIfEnabled, mappingReplayIdentity,
  ErasureReplayUnavailableError,
} from "../dist/erasure-replay-barrier.js";
import {RetirementDispositionBlockedError} from "../dist/recurrence-retirement-disposition.js";

const mapping={
  profile:"work",taskId:"task-203",eventId:"event-203",
  masterEventId:"master-203",activeInstanceId:"instance-203",
  updatedAt:"2026-10-29T14:30:00.000Z",
};

function setEnvironment(t,entries){
  const before=Object.fromEntries(Object.keys(entries).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(entries)) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  t.after(()=>{for(const [key,value] of Object.entries(before)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
}

test("mapping identity protects the task and every resolved master/instance alias",()=>{
  assert.deepEqual(mappingReplayIdentity(mapping),{profile:"work",taskId:"task-203",
    eventIds:["event-203","master-203","instance-203"]});
});

test("retirement admission remains enforced when the obsolete HMAC gate is disabled",async t=>{
  setEnvironment(t,{
    STATE_TABLE_NAME:"test-state",RETIREMENT_DISPOSITION_VERSION:"1",
    ERASURE_REPLAY_BARRIER_VERSION:"0",
  });
  let reads=0,writes=0;
  t.mock.method(documentClient,"send",async command=>{
    if(command.constructor.name==="GetCommand"){
      reads++;
      assert.equal(command.input.ConsistentRead,true);
      assert.match(command.input.Key.pk,/^RETIREMENT#work#/);
      return {Item:{
        profile:"work",operationId:"op-203",status:"retired",
        taskId:mapping.taskId,seriesId:"series-203",masterEventId:mapping.masterEventId,
        createdAt:"2026-11-10T12:00:00.000Z",
      }};
    }
    writes++;throw new Error("unexpected state mutation");
  });
  await assert.rejects(new StateRepository().putMapping(mapping),RetirementDispositionBlockedError);
  assert.equal(reads,1);
  assert.equal(writes,0);
});

test("obsolete HMAC gate reactivation cannot permit new state writes or reads",async t=>{
  setEnvironment(t,{
    STATE_TABLE_NAME:"test-state",RETIREMENT_DISPOSITION_VERSION:"0",
    ERASURE_REPLAY_BARRIER_VERSION:"1",
  });
  let accesses=0;
  t.mock.method(documentClient,"send",async()=>{accesses++;throw Error("legacy DDB access");});
  await assert.rejects(new StateRepository().putMapping(mapping),ErasureReplayUnavailableError);
  await assert.rejects(assertReplayAdmissionIfEnabled({profile:"work",taskId:mapping.taskId}),ErasureReplayUnavailableError);
  assert.equal(accesses,0);
});
