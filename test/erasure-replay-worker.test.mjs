import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {assertReplayAdmissionIfEnabled} from "../dist/erasure-replay-barrier.js";

test("worker write admission ignores the retired HMAC setting",async t=>{
  const previous=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  t.after(()=>{if(previous===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous;});
  let reads=0;
  t.mock.method(documentClient,"send",async()=>{reads++;throw Error("legacy marker read must not occur");});
  await assert.doesNotReject(()=>assertReplayAdmissionIfEnabled({profile:"work",taskId:"task-1"}));
  assert.equal(reads,0);
});
