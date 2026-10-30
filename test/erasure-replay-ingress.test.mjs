import assert from "node:assert/strict";
import test from "node:test";
import {createHmac} from "node:crypto";
import {SSMClient,GetParameterCommand} from "@aws-sdk/client-ssm";
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {handler} from "../dist/handler.js";

const before={
  version:process.env.ERASURE_REPLAY_BARRIER_VERSION,
  keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
  current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
  proxy:process.env.PROXY_SHARED_SECRET_PARAMETER,
  todoist:process.env.TODOIST_WEBHOOK_SECRET_PARAMETER,
};
process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({v1:Buffer.alloc(32,9).toString("base64")});
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="v1";
process.env.PROXY_SHARED_SECRET_PARAMETER="/test/replay/proxy";
process.env.TODOIST_WEBHOOK_SECRET_PARAMETER="/test/replay/todoist";
test.after(()=>{
  for(const [key,value] of [
    ["ERASURE_REPLAY_BARRIER_VERSION",before.version],
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
