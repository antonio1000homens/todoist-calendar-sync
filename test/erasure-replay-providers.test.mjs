import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {guardReplayProviderClients} from "../dist/erasure-replay-providers.js";
import {ErasureReplayBlockedError,ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";

const original={
  version:process.env.ERASURE_REPLAY_BARRIER_VERSION,
  keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
  current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
};
process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({v1:Buffer.alloc(32,8).toString("base64")});
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="v1";
test.after(()=>{for(const [key,value] of [
  ["ERASURE_REPLAY_BARRIER_VERSION",original.version],
  ["ERASURE_REPLAY_HMAC_KEYS",original.keys],
  ["ERASURE_REPLAY_HMAC_CURRENT_KEY",original.current],
])if(value===undefined)delete process.env[key];else process.env[key]=value;});

function fixture(){
  const called=[];
  const wrap=guardReplayProviderClients("work",{
    calendar:{
      async upsertEvent(...args){called.push(["calendar.upsertEvent",...args]);return {id:"event-new"};},
      async upsertEventIfUnchanged(...args){called.push(["calendar.upsertEventIfUnchanged",...args]);return {id:"event-old"};},
      async deleteEvent(...args){called.push(["calendar.deleteEvent",...args]);},
      async getEvent(id){return {id};},
    },
    todoist:{
      async upsertTask(...args){called.push(["todoist.upsertTask",...args]);return {id:"task-new"};},
      async upsertComment(...args){called.push(["todoist.upsertComment",...args]);return {id:"comment"};},
      async createTaskOnce(...args){called.push(["todoist.createTaskOnce",...args]);return {id:"task-new"};},
      async deleteComment(...args){called.push(["todoist.deleteComment",...args]);},
      async getTask(id){return {id};},
    },
  });
  return {clients:wrap,called};
}
test("staged provider boundary blocks erased Calendar events and Todoist tasks before API methods",async t=>{
  const reads=[];
  t.mock.method(documentClient,"send",async cmd=>{
    assert.equal(cmd.constructor.name,"GetCommand");
    assert.equal(cmd.input.ConsistentRead,true);
    reads.push(cmd.input.Key);
    return {Item:{markerVersion:1}};
  });
  const {clients,called}=fixture();
  await assert.rejects(clients.calendar.upsertEvent({id:"event-old",extendedProperties:{shared:{taskId:"task-erased"}}}),ErasureReplayBlockedError);
  await assert.rejects(clients.calendar.upsertEventIfUnchanged({id:"event-old"},"event-old","etag-1"),ErasureReplayBlockedError);
  await assert.rejects(clients.calendar.deleteEvent("event-old"),ErasureReplayBlockedError);
  await assert.rejects(clients.todoist.upsertTask({content:"updated"},"task-erased"),ErasureReplayBlockedError);
  await assert.rejects(clients.todoist.upsertComment("task-erased","some comment"),ErasureReplayBlockedError);
  assert.equal(called.length,0);
  assert.ok(reads.length>=5);
  assert.ok(reads.every(r=>r.pk==="ERASURE_REPLAY#work"));
});

test("unknown task creation, comment deletion and anonymous Calendar creation fail closed",async t=>{
  let reads=0;
  t.mock.method(documentClient,"send",async()=>{reads++;return {};});
  const {clients,called}=fixture();
  await assert.rejects(clients.todoist.upsertTask({content:"Calendar-origin task"}),ErasureReplayUnavailableError);
  await assert.rejects(clients.todoist.createTaskOnce({content:"Calendar-origin task"},"repair-request-key"),ErasureReplayUnavailableError);
  await assert.rejects(clients.todoist.deleteComment("comment-with-unknown-owner"),ErasureReplayUnavailableError);
  await assert.rejects(clients.calendar.upsertEvent({id:"",summary:"anonymous event"}),ErasureReplayUnavailableError);
  assert.equal(reads,0,"cannot read marker for a non-existent proven identity");
  assert.equal(called.length,0);
});

test("known identities pass under the enabled gate when no marker exists, and reads bind exact profiles",async t=>{
  const read=[];
  t.mock.method(documentClient,"send",async cmd=>{
    assert.equal(cmd.input.ConsistentRead,true);
    read.push(cmd.input.Key);
    return {};
  });
  const {clients,called}=fixture();
  await clients.todoist.upsertTask({content:"safe"},"safe-task");
  await clients.calendar.upsertEvent({id:"safe-event",extendedProperties:{shared:{taskId:"safe-task"}}});
  assert.equal(called.length,2);
  assert.ok(read.some(key=>key.sk.startsWith("TASK#")));
  assert.ok(read.some(key=>key.sk.startsWith("EVENT#")));
});

test("the disabled rollout gate does not alter existing provider behaviour",async t=>{
  const prior=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  t.after(()=>{process.env.ERASURE_REPLAY_BARRIER_VERSION=prior;});
  const {clients,called}=fixture();
  await clients.todoist.createTaskOnce({content:"legacy"},"request-id");
  await clients.calendar.upsertEvent({id:""});
  assert.equal(called.length,2);
});

test("missing HMAC configuration refuses writes rather than silently bypassing admission",async t=>{
  const keys=process.env.ERASURE_REPLAY_HMAC_KEYS;
  delete process.env.ERASURE_REPLAY_HMAC_KEYS;
  t.after(()=>{process.env.ERASURE_REPLAY_HMAC_KEYS=keys;});
  const {clients,called}=fixture();
  await assert.rejects(clients.todoist.upsertTask({content:"safe"},"existing-task"),ErasureReplayUnavailableError);
  assert.equal(called.length,0);
});
