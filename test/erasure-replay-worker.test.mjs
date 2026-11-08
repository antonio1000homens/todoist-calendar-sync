import assert from "node:assert/strict";
import test from "node:test";
import {DeleteCommand,GetCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {handler} from "../dist/worker.js";

const envNames=["STATE_TABLE_NAME","ERASURE_PROTOCOL_VERSION","ERASURE_REPLAY_BARRIER_VERSION",
  "ERASURE_REPLAY_HMAC_KEYS","ERASURE_REPLAY_HMAC_CURRENT_KEY"];
const originalEnv=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
Object.assign(process.env,{
  STATE_TABLE_NAME:"replay-worker-test",
  ERASURE_PROTOCOL_VERSION:"1",
  ERASURE_REPLAY_BARRIER_VERSION:"1",
  ERASURE_REPLAY_HMAC_KEYS:JSON.stringify({v1:Buffer.alloc(32,23).toString("base64")}),
  ERASURE_REPLAY_HMAC_CURRENT_KEY:"v1",
});
test.after(()=>{
  for(const [name,value] of Object.entries(originalEnv))
    if(value===undefined)delete process.env[name];else process.env[name]=value;
});

test("a queued Todoist webhook is dropped under the writer lease when its replay marker appears",async t=>{
  const observed=[];
  let writerLeaseHeld=false;
  t.mock.method(documentClient,"send",async command=>{
    observed.push(command);
    if(command instanceof GetCommand&&command.input.Key.sk==="EPOCH")
      return {Item:{epoch:7}};
    if(command instanceof TransactWriteCommand) {
      assert.ok(command.input.TransactItems.some(action=>action.Put?.Item?.kind==="writer"));
      writerLeaseHeld=true;
      return {};
    }
    if(command instanceof GetCommand&&command.input.Key.pk==="ERASURE_REPLAY#work") {
      assert.equal(writerLeaseHeld,true,"marker must be checked while the profile writer lease is held");
      assert.equal(command.input.ConsistentRead,true);
      return {Item:{markerVersion:1}};
    }
    if(command instanceof DeleteCommand&&command.input.Key.sk.startsWith("WRITER#")) {
      assert.equal(writerLeaseHeld,true);
      writerLeaseHeld=false;
      return {};
    }
    throw new Error("Stale marked delivery must not create receipts or other state");
  });

  const webhookBody=JSON.stringify({event_name:"item:updated",event_data:{id:"deleted-task",content:"private title"}});
  const delivery=JSON.stringify({id:"stale-delivery",kind:"todoist",profile:"work",mode:"aws",
    receivedAt:"2026-11-08T00:00:00.000Z",headers:{},body:webhookBody,erasureEpoch:7});
  const result=await handler({Records:[{
    messageId:"stale-sqs-message",body:delivery,
    attributes:{ApproximateReceiveCount:"1"},
    messageAttributes:{},
    eventSourceARN:"arn:aws:sqs:eu-west-2:111111111111:sync.fifo",
    awsRegion:"eu-west-2",
  }]},{awsRequestId:"stale-sqs-test"});

  assert.deepEqual(result,{batchItemFailures:[]},"the already-erased delivery is acknowledged and discarded");
  assert.equal(writerLeaseHeld,false,"the writer lease must be released on suppression");
  assert.equal(observed.filter(command=>command instanceof GetCommand&&command.input.Key.pk==="ERASURE_REPLAY#work").length,1);
  assert.equal(observed.filter(command=>command instanceof TransactWriteCommand).length,1);
  assert.equal(observed.filter(command=>command instanceof DeleteCommand).length,1);
});
