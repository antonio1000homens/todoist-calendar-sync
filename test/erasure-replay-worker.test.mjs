import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {handler} from "../dist/worker.js";

test("retired HMAC gate fails queued delivery closed before any DynamoDB state writes",async t=>{
  const names=["STATE_TABLE_NAME","ERASURE_PROTOCOL_VERSION","ERASURE_REPLAY_BARRIER_VERSION"];
  const original=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{
    STATE_TABLE_NAME:"replay-worker-test",
    ERASURE_PROTOCOL_VERSION:"1",
    ERASURE_REPLAY_BARRIER_VERSION:"1",
  });
  t.after(()=>{for(const [key,value] of Object.entries(original)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  const observed=[];
  t.mock.method(documentClient,"send",async command=>{
    observed.push(command);
    throw new Error("legacy marker gate must reject before DynamoDB access");
  });
  const delivery=JSON.stringify({
    id:"stale-delivery",kind:"todoist",profile:"work",mode:"aws",
    receivedAt:"2026-11-08T00:00:00.000Z",
    headers:{},body:JSON.stringify({event_name:"item:updated",event_data:{id:"task-1"}}),
    erasureEpoch:7,
  });
  const result=await handler({Records:[{
    messageId:"stale-sqs-message",body:delivery,
    attributes:{ApproximateReceiveCount:"1"},messageAttributes:{},
    eventSourceARN:"arn:aws:sqs:eu-west-2:111111111111:sync.fifo",
    awsRegion:"eu-west-2",
  }]},{awsRequestId:"stale-sqs-test"});
  assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"stale-sqs-message"}]});
  assert.deepEqual(observed,[],"obsolete HMAC gate must never authorise provider or state writes");
});
