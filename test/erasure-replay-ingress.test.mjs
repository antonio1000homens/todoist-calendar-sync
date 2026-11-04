import assert from "node:assert/strict";
import test from "node:test";
import {createHmac} from "node:crypto";
import {SSMClient,GetParameterCommand} from "@aws-sdk/client-ssm";
import {SQSClient,SendMessageCommand} from "@aws-sdk/client-sqs";
import {GetCommand,DeleteCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {handler} from "../dist/handler.js";

const before={
  version:process.env.ERASURE_REPLAY_BARRIER_VERSION,
  protocol:process.env.ERASURE_PROTOCOL_VERSION,
  keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
  current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
  proxy:process.env.PROXY_SHARED_SECRET_PARAMETER,
  todoist:process.env.TODOIST_WEBHOOK_SECRET_PARAMETER,
};
process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
process.env.ERASURE_PROTOCOL_VERSION="1";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({v1:Buffer.alloc(32,9).toString("base64")});
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="v1";
process.env.PROXY_SHARED_SECRET_PARAMETER="/test/replay/proxy";
process.env.TODOIST_WEBHOOK_SECRET_PARAMETER="/test/replay/todoist";
test.after(()=>{
  for(const [key,value] of [
    ["ERASURE_REPLAY_BARRIER_VERSION",before.version],
    ["ERASURE_PROTOCOL_VERSION",before.protocol],
    ["ERASURE_REPLAY_HMAC_KEYS",before.keys],
    ["ERASURE_REPLAY_HMAC_CURRENT_KEY",before.current],
    ["PROXY_SHARED_SECRET_PARAMETER",before.proxy],
    ["TODOIST_WEBHOOK_SECRET_PARAMETER",before.todoist],
  ])if(value===undefined)delete process.env[key];else process.env[key]=value;
});
function webhook(body){
  const signature=createHmac("sha256","todoist-secret").update(body).digest("base64");
  return {rawPath:"/todoist-work",headers:{
    "x-gcp-proxy-auth":"proxy-secret","x-todoist-hmac-sha256":signature,
    "x-todoist-delivery-id":"delayed-replay",
  },body,isBase64Encoded:false,requestContext:{http:{method:"POST"}}};
}
function setup(t,read){
  t.mock.method(SSMClient.prototype,"send",async command=>{
    assert.ok(command instanceof GetParameterCommand);
    return {Parameter:{Value:command.input.Name==="/test/replay/proxy"?"proxy-secret":"todoist-secret"}};
  });
  const writes=[];
  t.mock.method(documentClient,"send",async command=>{
    if(command instanceof GetCommand&&command.input.Key.pk==="ERASURE_REPLAY#work"){
      assert.equal(command.input.ConsistentRead,true);
      return read(command);
    }
    writes.push(command);
    throw new Error("Webhook must not be enqueued or persist a receipt");
  });
  return writes;
}
test("valid signed delayed webhook with erased task never enters SQS or creates identity-bearing receipts",async t=>{
  const writes=setup(t,()=>({Item:{markerVersion:1}}));
  const body=JSON.stringify({event_name:"item:updated",event_data:{id:"task-erased",content:"private title"}});
  const result=await handler(webhook(body));
  assert.equal(result.statusCode,202);
  assert.deepEqual(JSON.parse(result.body),{accepted:true,suppressed:true});
  assert.equal(writes.length,0);
});
test("unavailable replay marker lookup rejects incoming webhook without queue side effects",async t=>{
  const writes=setup(t,()=>{throw new Error("DynamoDB AccessDenied");});
  const result=await handler(webhook(JSON.stringify({event_name:"item:updated",event_data:{id:"task-one"}})));
  assert.equal(result.statusCode,503);
  assert.equal(JSON.parse(result.body).accepted,false);
  assert.equal(writes.length,0);
});
test("signed webhook with no identity is not accepted as a new delivery",async t=>{
  const writes=setup(t,()=>{throw new Error("should not query markers without identity");});
  const result=await handler(webhook(JSON.stringify({event_name:"item:updated"})));
  assert.equal(result.statusCode,503);
  assert.equal(JSON.parse(result.body).error,"replay_identity_unavailable");
  assert.equal(writes.length,0);
});

function setupLeasedEnqueue(t, markerAfterIngress=false) {
  const previous={
    protocol:process.env.ERASURE_PROTOCOL_VERSION,
    queue:process.env.QUEUE_URL,
  };
  process.env.ERASURE_PROTOCOL_VERSION="1";
  process.env.QUEUE_URL="https://sqs.eu-west-2.amazonaws.com/111111111111/test.fifo";
  t.after(()=>{
    for(const [name,value] of [
      ["ERASURE_PROTOCOL_VERSION",previous.protocol],
      ["QUEUE_URL",previous.queue],
    ])if(value===undefined)delete process.env[name];else process.env[name]=value;
  });
  t.mock.method(SSMClient.prototype,"send",async command=>{
    assert.ok(command instanceof GetParameterCommand);
    return {Parameter:{Value:command.input.Name==="/test/replay/proxy"?"proxy-secret":"todoist-secret"}};
  });
  const counts={reads:0,leases:0,releases:0,sends:0};
  let leaseHeld=false;
  t.mock.method(documentClient,"send",async command=>{
    if(command instanceof GetCommand) {
      if(command.input.Key.pk==="ERASURE_REPLAY#work") {
        assert.equal(command.input.ConsistentRead,true);
        counts.reads++;
        if(markerAfterIngress&&counts.reads===2)return {Item:{markerVersion:1}};
        return {};
      }
      if(command.input.Key.sk==="EPOCH")return {Item:{epoch:7}};
    }
    if(command instanceof TransactWriteCommand) {
      assert.ok(command.input.TransactItems.some(item=>item.Put?.Item?.sk?.startsWith("ADMISSION#")));
      leaseHeld=true;
      counts.leases++;
      return {};
    }
    if(command instanceof DeleteCommand&&command.input.Key.sk.startsWith("ADMISSION#")) {
      assert.equal(leaseHeld,true);
      leaseHeld=false;
      counts.releases++;
      return {};
    }
    throw new Error("Unexpected DynamoDB write in leased replay test");
  });
  t.mock.method(SQSClient.prototype,"send",async command=>{
    assert.ok(command instanceof SendMessageCommand);
    assert.equal(leaseHeld,true,"SQS send must run while the admission lease is held");
    assert.equal(counts.reads,2,"both ingress and leased marker reads must precede SQS");
    assert.equal(JSON.parse(command.input.MessageBody).erasureEpoch,7);
    counts.sends++;
    return {MessageId:"sqs-message"};
  });
  return counts;
}

test("a marker installed after ingress check but before leased enqueue suppresses the webhook",async t=>{
  const counts=setupLeasedEnqueue(t,true);
  const body=JSON.stringify({event_name:"item:updated",event_data:{id:"late-erased-task",content:"private title"}});
  const result=await handler(webhook(body));
  assert.equal(result.statusCode,202);
  assert.deepEqual(JSON.parse(result.body),{accepted:true,suppressed:true});
  assert.deepEqual(counts,{reads:2,leases:1,releases:1,sends:0});
});

test("an admitted Todoist webhook is checked under a lease held through SQS acknowledgement",async t=>{
  const counts=setupLeasedEnqueue(t,false);
  const body=JSON.stringify({event_name:"item:updated",event_data:{id:"live-task"}});
  const result=await handler(webhook(body));
  assert.equal(result.statusCode,202);
  assert.equal(JSON.parse(result.body).accepted,true);
  assert.deepEqual(counts,{reads:2,leases:1,releases:1,sends:1});
});

test("a replay-enabled Todoist ingress refuses to enqueue without the erasure lease protocol",async t=>{
  const previous=process.env.ERASURE_PROTOCOL_VERSION;
  process.env.ERASURE_PROTOCOL_VERSION="0";
  t.after(()=>{if(previous===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;else process.env.ERASURE_PROTOCOL_VERSION=previous;});
  t.mock.method(SSMClient.prototype,"send",async command=>{
    assert.ok(command instanceof GetParameterCommand);
    return {Parameter:{Value:command.input.Name==="/test/replay/proxy"?"proxy-secret":"todoist-secret"}};
  });
  let reads=0;
  t.mock.method(documentClient,"send",async command=>{
    assert.ok(command instanceof GetCommand);
    reads++;
    return {};
  });
  let sends=0;
  t.mock.method(SQSClient.prototype,"send",async()=>{sends++;return {};});
  const result=await handler(webhook(JSON.stringify({event_name:"item:updated",event_data:{id:"unleased-task"}})));
  assert.equal(result.statusCode,503);
  assert.equal(JSON.parse(result.body).accepted,false);
  assert.equal(reads,0,"mismatched barrier/lease configuration is rejected before any state read");
  assert.equal(sends,0);
});
