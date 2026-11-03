import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {
  collectLambdaInventory, expectedTemplateFunctions, pages,
} from "../scripts/audit-erasure-lambda-invokers.mjs";
import {ListFunctionsCommand} from "@aws-sdk/client-lambda";

const prefix="todoist-calendar-sync";
const stage="production";
const base="arn:aws:lambda:eu-west-2:111122223333:function:";
const ingress=prefix+"-ingress-"+stage;
const worker=prefix+"-worker-"+stage;

test("template inventory discovers expected functions without hardcoding deployment names",()=>{
  const template=[
    "FunctionName: !Sub "+"$"+"{ResourceNamePrefix}-worker-"+"$"+"{Stage}",
    "FunctionName: !Sub "+"$"+"{ResourceNamePrefix}-review-api-"+"$"+"{Stage}",
    "SomeOtherName: other",
  ].join("\n");
  assert.deepEqual(expectedTemplateFunctions(template,prefix,stage),[
    prefix+"-review-api-"+stage,worker,
  ]);
  assert.throws(()=>expectedTemplateFunctions("Resources: {}",prefix,stage),/No deployed Lambda/);
});

function fakeClient({loop=false,failOnPolicy=false}={}) {
  const seen=[];
  return {
    seen,
    async send(command) {
      const kind=command.constructor.name,input=command.input;
      seen.push({kind,input});
      switch(kind) {
        case "ListFunctionsCommand":
          return input.Marker?{Functions:[{FunctionName:worker,FunctionArn:base+worker}],...(loop?{NextMarker:"repeat"}:{})}:
            {Functions:[{FunctionName:ingress,FunctionArn:base+ingress}],NextMarker:loop?"repeat":"second"};
        case "ListEventSourceMappingsCommand":
          return {EventSourceMappings:[
            {FunctionArn:base+worker+":live",EventSourceArn:"arn:aws:sqs:eu-west-2:111122223333:q",State:"Enabled"},
          ]};
        case "ListVersionsByFunctionCommand":
          return {Versions:[
            {Version:"$LATEST",CodeSha256:"new"},
            {Version:"3",CodeSha256:"old"},
          ]};
        case "ListAliasesCommand":
          return {Aliases:[{Name:"live",FunctionVersion:"3"}]};
        case "GetPolicyCommand":
          if(failOnPolicy)throw Object.assign(new Error("denied"),{name:"AccessDeniedException"});
          if(input.Qualifier==="3")return {Policy:JSON.stringify({
            Statement:[{Effect:"Allow",Principal:"*",Action:"lambda:InvokeFunction"}],
          })};
          throw Object.assign(new Error("not found"),{name:"ResourceNotFoundException"});
        case "GetFunctionUrlConfigCommand":
          throw Object.assign(new Error("not found"),{name:"ResourceNotFoundException"});
        default: throw new Error("Unsafe/unexpected AWS action: "+kind);
      }
    },
  };
}

test("collects ALL Lambda pages, published versions, aliases, qualified SQS triggers and policies; stays blocked",async()=>{
  const client=fakeClient();
  const report=await collectLambdaInventory(client,{prefix,stage,expected:[ingress,worker]});
  assert.equal(report.status,"BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT");
  assert.equal(report.replayBarrierMayBeEnabled,false);
  assert.equal(report.executableRecoveryMayBeEnabled,false);
  assert.deepEqual(report.missingExpected,[]);
  assert.equal(report.functions.length,2);
  const w=report.functions.find(f=>f.name===worker);
  assert.deepEqual(w.versions.map(v=>v.qualifier),["$LATEST","3"]);
  assert.deepEqual(w.aliases.map(a=>a.name),["live"]);
  assert.deepEqual(w.eventSourceMappings,[{
    qualifier:"live",state:"Enabled",sourceService:"sqs",
  }]);
  assert.deepEqual(w.policies["3"],{statementCount:1,wildcardPrincipalPresent:true});
  assert.ok(client.seen.filter(x=>x.kind==="ListFunctionsCommand").length===2);
  assert.equal(client.seen.filter(x=>/Update|Delete|Invoke|Publish|Put/.test(x.kind)).length,0);
});

test("missing expected deployed Lambda remains visible; never silently marks audit complete",async()=>{
  const report=await collectLambdaInventory(fakeClient(),{
    prefix,stage,expected:[ingress,worker,prefix+"-erasure-worker-"+stage],
  });
  assert.deepEqual(report.missingExpected,[prefix+"-erasure-worker-"+stage]);
  assert.ok(report.functions.every(f=>f.approvedForReplayRelease===false));
});

test("repeated pagination markers and denied policy reads fail closed",async()=>{
  await assert.rejects(pages(fakeClient({loop:true}),ListFunctionsCommand,"Functions"),/Repeated/);
  await assert.rejects(collectLambdaInventory(fakeClient({failOnPolicy:true}),{
    prefix,stage,expected:[ingress,worker],
  }),/denied/);
});

test("inventory imports only Lambda read commands; never mutates provider, queue or AWS state",()=>{
  const source=readFileSync(new URL("../scripts/audit-erasure-lambda-invokers.mjs",import.meta.url),"utf8");
  const imports=source.split('from "@aws-sdk/client-lambda"')[0];
  for(const forbidden of ["UpdateEventSourceMappingCommand","InvokeCommand",
    "DeleteFunctionCommand","PublishVersionCommand","AddPermissionCommand",
    "PutFunctionEventInvokeConfigCommand"])assert.equal(imports.includes(forbidden),false);
});
