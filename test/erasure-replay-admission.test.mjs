import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {StateRepository} from "../dist/repository.js";
import {
  assertReplayAdmissionIfEnabled, mappingReplayIdentity,
} from "../dist/erasure-replay-barrier.js";

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

test("legacy retirement markers cannot block mapping writes",async t=>{
  setEnvironment(t,{
    STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"0",
  });
  let reads=0,writes=0;
  t.mock.method(documentClient,"send",async command=>{
    if(command.constructor.name==="GetCommand")reads++;
    writes++;throw new Error("unexpected state mutation");
  });
  await assert.rejects(new StateRepository().putMapping(mapping),/unexpected state mutation/);
  assert.equal(reads,0,"provider mapping writes do not consult permanent retirement markers");
  assert.equal(writes,1,"the write proceeds to the normal mapping transaction");
});

test("obsolete HMAC gate settings do not block provider correlation writes",async t=>{
  setEnvironment(t,{
    STATE_TABLE_NAME:"test-state",ERASURE_REPLAY_BARRIER_VERSION:"1",
  });
  const commands=[];
  t.mock.method(documentClient,"send",async command=>{commands.push(command);return {};});
  await assert.doesNotReject(()=>new StateRepository().putMapping(mapping));
  await assert.doesNotReject(()=>assertReplayAdmissionIfEnabled({profile:"work",taskId:mapping.taskId}));
  assert.equal(commands.length,1,"the test adapter can persist its mapping without consulting retired HMAC markers");
  assert.equal(commands[0].constructor.name,"TransactWriteCommand");
});
