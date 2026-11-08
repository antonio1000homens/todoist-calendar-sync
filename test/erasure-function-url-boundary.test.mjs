import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {SSMClient,GetParameterCommand} from "@aws-sdk/client-ssm";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {handler} from "../dist/handler.js";
import test from "node:test";

const template=readFileSync(new URL("../template.yaml",import.meta.url),"utf8");
const resources=template.split("\nResources:\n")[1]?.split("\nOutputs:\n")[0];
assert.ok(resources,"CloudFormation Resources section is present");
const resourceBlocks=new Map();
let currentName;
for(const line of resources.split("\n")) {
  const match=/^  ([A-Za-z0-9]+):\s*$/.exec(line);
  if(match) {
    currentName=match[1];
    resourceBlocks.set(currentName,[line]);
  } else if(currentName)resourceBlocks.get(currentName).push(line);
}
const resource=name=>(resourceBlocks.get(name)||[]).join("\n");

test("public Function URLs are limited to the two application-authenticated endpoints",()=>{
  const functions=[...resourceBlocks].filter(([,lines])=>lines.some(line=>/Type: AWS::Serverless::Function/.test(line)))
    .map(([name])=>name);
  const withUrl=functions.filter(name=>/FunctionUrlConfig:/.test(resource(name)));
  assert.deepEqual(withUrl.sort(),["IngressFunction","ReviewApiFunction"]);
  for(const name of withUrl)assert.match(resource(name),/FunctionUrlConfig:\n\s+AuthType: NONE/);

  const publicPermissions=["IngressUrlPermission","IngressInvokePermission",
    "ReviewApiUrlPermission","ReviewApiInvokePermission"];
  for(const name of publicPermissions)assert.ok(resource(name),`${name} is explicitly declared`);
  for(const name of ["IngressUrlPermission","ReviewApiUrlPermission"]) {
    const block=resource(name);
    assert.match(block,/Principal: "\*"/);
    assert.match(block,/Action: lambda:InvokeFunctionUrl/);
    assert.match(block,/FunctionUrlAuthType: NONE/);
  }
  for(const name of ["IngressInvokePermission","ReviewApiInvokePermission"]) {
    const block=resource(name);
    assert.match(block,/Principal: "\*"/);
    assert.match(block,/Action: lambda:InvokeFunction/);
    assert.match(block,/InvokedViaFunctionUrl: true/);
  }
});

test("direct unauthenticated ingress URL requests stop before state or queue access",async t=>{
  const previous=process.env.PROXY_SHARED_SECRET_PARAMETER;
  process.env.PROXY_SHARED_SECRET_PARAMETER="/test/function-url/proxy";
  t.after(()=>{if(previous===undefined)delete process.env.PROXY_SHARED_SECRET_PARAMETER;
    else process.env.PROXY_SHARED_SECRET_PARAMETER=previous;});
  t.mock.method(SSMClient.prototype,"send",async command=>{
    assert.ok(command instanceof GetParameterCommand);
    assert.equal(command.input.Name,"/test/function-url/proxy");
    return {Parameter:{Value:"expected-proxy-secret"}};
  });
  let stateReads=0;
  t.mock.method(documentClient,"send",async()=>{stateReads++;throw new Error("unauthenticated URL must not reach state");});
  const result=await handler({rawPath:"/todoist-home",headers:{},body:"{}",isBase64Encoded:false,
    requestContext:{http:{method:"POST"}}});
  assert.equal(result.statusCode,401);
  assert.deepEqual(JSON.parse(result.body),{error:"unauthorized_proxy"});
  assert.equal(stateReads,0);
});
