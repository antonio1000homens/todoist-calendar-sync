import test from "node:test";
import assert from "node:assert/strict";
import {buildLambdaInvocationTargets,collectInvocationSimulations} from "../scripts/simulate-erasure-lambda-invokers.mjs";

const accountId="123456789012";
const inventory={purpose:"issue-307-read-only-qualified-lambda-inventory",
  status:"BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT",verifiedAccount:accountId,region:"eu-west-2",
  expectedFunctions:["sync-api"],missingExpected:[],functions:[{name:"sync-api",
    versions:[{qualifier:"$LATEST"},{qualifier:"8"},{qualifier:"9"}],
    aliases:[{name:"live",version:"9",additionalVersions:{"8":0.1}}]}]};
const candidates={purpose:"issue-307-iam-identity-invocation-candidates",
  status:"BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF",verifiedAccount:accountId,missingManagedDocumentCount:0,
  candidates:[
    {principalType:"role",principalArn:`arn:aws:iam::${accountId}:role/worker`,actions:["lambda:InvokeFunction"],qualifiedPossible:true},
    {principalType:"user",principalArn:`arn:aws:iam::${accountId}:user/operator`,actions:["lambda:InvokeFunctionUrl"],qualifiedPossible:true},
    {principalType:"user",principalArn:`arn:aws:iam::${accountId}:user/read-only`,actions:["lambda:InvokeFunction"],qualifiedPossible:false},
  ]};

test("builds exact same-account resource ARNs for latest, published versions and aliases",()=>{
  const targets=buildLambdaInvocationTargets(inventory,accountId);
  assert.equal(targets.length,4);
  assert.deepEqual(targets.map(item=>item.qualifier),["unqualified","8","9","live"]);
  assert.equal(buildLambdaInvocationTargets(inventory,accountId,"aws-us-gov")[0].arn.startsWith("arn:aws-us-gov:"),true);
});

test("simulates every candidate against every target in bounded pages and preserves blockers",()=>{
  const manyVersions=[{qualifier:"$LATEST"},...Array.from({length:60},(_,index)=>({qualifier:String(index+1)}))];
  const largeInventory={...inventory,functions:[{...inventory.functions[0],versions:manyVersions,
    aliases:[{name:"live",version:"60",additionalVersions:{}}]}]};
  let calls=0;
  const report=collectInvocationSimulations({inventory:largeInventory,identityReport:candidates,accountId,
    run(request){
      calls++;
      assert.equal(request.action,"lambda:InvokeFunction");
      assert.ok(request.resourceArns.length<=50);
      return {EvaluationResults:[{EvalActionName:request.action,EvalDecision:"allowed",EvalDecisionDetails:{},
        ResourceSpecificResults:request.resourceArns.map(EvalResourceName=>({EvalResourceName,EvalResourceDecision:"allowed"}))}]};
    }});
  assert.equal(calls,2);
  assert.equal(report.principalCount,1);
  assert.equal(report.targetCount,62);
  assert.equal(report.results[0].evaluatedTargets,62);
  assert.equal(report.results[0].qualifiedAllowedTargets,61);
  assert.equal(report.results[0].allowedTargets,62);
  assert.equal(report.status,"SIMULATED_NOT_LIVE_INVOCATION_OR_APPROVAL");
  assert.equal(report.executableRecoveryMayBeEnabled,false);
  assert.ok(report.limitations.some(item=>item.includes("role")));
});

test("mismatched account, missing simulator results and duplicate results fail closed",()=>{
  assert.throws(()=>collectInvocationSimulations({inventory:{...inventory,verifiedAccount:"999999999999"},
    identityReport:candidates,accountId,run:()=>({})}),/same-account/);
  assert.throws(()=>collectInvocationSimulations({inventory,identityReport:{...candidates,verifiedAccount:"999999999999"},
    accountId,run:()=>({})}),/same-account/);
  assert.throws(()=>collectInvocationSimulations({inventory,identityReport:candidates,accountId,
    run:()=>({EvaluationResults:[{EvalActionName:"lambda:InvokeFunction",ResourceSpecificResults:[]}]})}),/omitted/);
  assert.throws(()=>collectInvocationSimulations({inventory,identityReport:candidates,accountId,
    run:request=>({EvaluationResults:[{EvalActionName:request.action,ResourceSpecificResults:[
      {EvalResourceName:request.resourceArns[0],EvalResourceDecision:"allowed"},
      {EvalResourceName:request.resourceArns[0],EvalResourceDecision:"allowed"},
    ]}]})}),/duplicated/);
});
