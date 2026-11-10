import assert from "node:assert/strict";
import test from "node:test";
import {createHmac} from "node:crypto";
import {SSMClient,GetParameterCommand} from "@aws-sdk/client-ssm";
import {SQSClient} from "@aws-sdk/client-sqs";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {handler} from "../dist/handler.js";

test("signed webhook fails closed before SQS or DynamoDB when retired HMAC gate is reactivated",async t=>{
  const names=["ERASURE_REPLAY_BARRIER_VERSION","ERASURE_PROTOCOL_VERSION",
    "PROXY_SHARED_SECRET_PARAMETER","TODOIST_WEBHOOK_SECRET_PARAMETER"];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  Object.assign(process.env,{
    ERASURE_REPLAY_BARRIER_VERSION:"1",ERASURE_PROTOCOL_VERSION:"1",
    PROXY_SHARED_SECRET_PARAMETER:"/test/replay/proxy",
    TODOIST_WEBHOOK_SECRET_PARAMETER:"/test/replay/todoist",
  });
  t.after(()=>{for(const [key,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  t.mock.method(SSMClient.prototype,"send",async command=>{
    assert.ok(command instanceof GetParameterCommand);
    return {Parameter:{Value:command.input.Name==="/test/replay/proxy"?"proxy-secret":"todoist-secret"}};
  });
  let writes=0;
  t.mock.method(SQSClient.prototype,"send",async()=>{writes++;throw Error("SQS must not be called");});
  t.mock.method(documentClient,"send",async()=>{writes++;throw Error("DynamoDB must not be called");});
  const body=JSON.stringify({event_name:"item:updated",event_data:{id:"task-1",content:"sample"}});
  const signature=createHmac("sha256","todoist-secret").update(body).digest("base64");
  const result=await handler({
    rawPath:"/todoist-work",headers:{
      "x-gcp-proxy-auth":"proxy-secret","x-todoist-hmac-sha256":signature,
      "x-todoist-delivery-id":"test-delayed",
    },body,isBase64Encoded:false,requestContext:{http:{method:"POST"}},
  });
  assert.equal(result.statusCode,503);
  assert.equal(JSON.parse(result.body).error,"replay_admission_unavailable");
  assert.equal(writes,0);
});
