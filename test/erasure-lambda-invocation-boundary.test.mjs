import test from "node:test";
import assert from "node:assert/strict";
import {GetResourcePolicyCommand,PutResourcePolicyCommand} from "@aws-sdk/client-lambda";
import {ensureBoundary,invocationBoundaryStatement,mergeInvocationBoundary} from "../scripts/enforce-erasure-lambda-invocation-boundary.mjs";

const versionArn="arn:aws:lambda:eu-west-2:243857182133:function:todoist-calendar-sync-review-api-production:139";
const aliasArn="arn:aws:lambda:eu-west-2:243857182133:function:todoist-calendar-sync-review-api-production:live";
const functionArn="arn:aws:lambda:eu-west-2:243857182133:function:todoist-calendar-sync-worker-production";

test("numeric versions receive an unconditional deny for direct invoke and legacy async",()=>{
  const statement=invocationBoundaryStatement(versionArn,"version");
  assert.deepEqual(statement,{Sid:"DenyUnreviewedQualifiedInvocation",Effect:"Deny",Principal:"*",
    Action:["lambda:InvokeFunction","lambda:InvokeAsync"],Resource:versionArn});
  assert.throws(()=>invocationBoundaryStatement(aliasArn,"version"),/numeric version ARN/);
});

test("unqualified and alias boundaries preserve service and Function URL invocation paths",()=>{
  for(const arn of [functionArn,aliasArn]) {
    const statement=invocationBoundaryStatement(arn,"direct");
    assert.equal(statement.Effect,"Deny");
    assert.equal(statement.Principal,"*");
    assert.deepEqual(statement.Action,["lambda:InvokeFunction","lambda:InvokeAsync"]);
    assert.deepEqual(statement.Condition,{BoolIfExists:{
      "aws:PrincipalIsAWSService":"false","lambda:InvokedViaFunctionUrl":"false",
    }});
    assert.equal(statement.Action.includes("lambda:InvokeFunctionUrl"),false);
  }
});

test("policy merge preserves existing URL/service permissions and is idempotent",()=>{
  const existing={Version:"2012-10-17",Statement:[
    {Sid:"FunctionUrlAllow",Effect:"Allow",Principal:"*",Action:"lambda:InvokeFunctionUrl",Resource:aliasArn},
    {Sid:"FunctionUrlInvokeAllow",Effect:"Allow",Principal:"*",Action:"lambda:InvokeFunction",
      Resource:aliasArn,Condition:{Bool:{"lambda:InvokedViaFunctionUrl":"true"}}},
  ]};
  const merged=mergeInvocationBoundary(JSON.stringify(existing),aliasArn,"direct");
  assert.equal(merged.changed,true);
  assert.deepEqual(merged.policy.Statement.slice(0,2),existing.Statement);
  const repeated=mergeInvocationBoundary(JSON.stringify(merged.policy),aliasArn,"direct");
  assert.equal(repeated.changed,false);
  assert.deepEqual(repeated.policy,merged.policy);
});

test("merge refuses a conflicting or duplicated boundary instead of replacing policy",()=>{
  const conflict={Version:"2012-10-17",Statement:[{...invocationBoundaryStatement(versionArn,"version"),Resource:"*"}]};
  assert.throws(()=>mergeInvocationBoundary(JSON.stringify(conflict),versionArn,"version"),/differs from the reviewed policy/);
  const duplicate={Version:"2012-10-17",Statement:[invocationBoundaryStatement(versionArn,"version"),invocationBoundaryStatement(versionArn,"version")]};
  assert.throws(()=>mergeInvocationBoundary(JSON.stringify(duplicate),versionArn,"version"),/duplicate/);
});

test("resource policy update uses revision compare-and-swap and verifies preserved statements",async()=>{
  const allow={Sid:"ExistingAllow",Effect:"Allow",Principal:{Service:"lambda.amazonaws.com"},
    Action:"lambda:InvokeFunction",Resource:versionArn};
  let document={Version:"2012-10-17",Statement:[allow]};
  let revision="11111111-1111-4111-8111-111111111111";
  const calls=[];
  const client={async send(command) {
    calls.push(command);
    if(command instanceof GetResourcePolicyCommand)
      return {Policy:JSON.stringify(document),RevisionId:revision};
    if(command instanceof PutResourcePolicyCommand) {
      assert.equal(command.input.RevisionId,revision);
      document=JSON.parse(command.input.Policy);
      revision="22222222-2222-4222-8222-222222222222";
      return {Policy:command.input.Policy,RevisionId:revision};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }};
  assert.deepEqual(await ensureBoundary(client,versionArn,"version"),{changed:true});
  assert.ok(document.Statement.some(item=>item.Sid==="ExistingAllow"));
  assert.ok(document.Statement.some(item=>item.Sid==="DenyUnreviewedQualifiedInvocation"));
  assert.deepEqual(await ensureBoundary(client,versionArn,"version"),{changed:false});
  assert.equal(calls.filter(item=>item instanceof PutResourcePolicyCommand).length,1);
});

test("compare-and-swap retries after a concurrent permission change and preserves it",async()=>{
  const existing={Version:"2012-10-17",Statement:[]};
  let revision="11111111-1111-4111-8111-111111111111",puts=0;
  const client={async send(command) {
    if(command instanceof GetResourcePolicyCommand)return {Policy:JSON.stringify(existing),RevisionId:revision};
    if(command instanceof PutResourcePolicyCommand) {
      puts++;
      if(puts===1) {
        existing.Statement.push({Sid:"ConcurrentAllow",Effect:"Allow",Principal:{Service:"events.amazonaws.com"},
          Action:"lambda:InvokeFunction",Resource:aliasArn});
        revision="22222222-2222-4222-8222-222222222222";
        const error=new Error("stale policy revision");error.name="PreconditionFailedException";throw error;
      }
      assert.equal(command.input.RevisionId,revision);
      Object.assign(existing,JSON.parse(command.input.Policy));
      revision="33333333-3333-4333-8333-333333333333";
      return {Policy:command.input.Policy,RevisionId:revision};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }};
  assert.deepEqual(await ensureBoundary(client,aliasArn,"direct"),{changed:true});
  assert.equal(puts,2);
  assert.ok(existing.Statement.some(item=>item.Sid==="ConcurrentAllow"));
  assert.ok(existing.Statement.some(item=>item.Sid==="DenyDirectInvocationOutsideFunctionUrlOrAwsService"));
});
