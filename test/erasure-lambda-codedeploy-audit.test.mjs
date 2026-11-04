import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {collectCodeDeployReferences} from "../scripts/audit-erasure-lambda-codedeploy.mjs";

class FakeClient {
  constructor(responses){this.responses=responses;this.calls=[];}
  async send(command){
    this.calls.push(command);
    const response=this.responses[command.constructor.name];
    if(response instanceof Error)throw response;
    if(typeof response==="function")return response(command);
    if(response===undefined)throw new Error("unexpected command: "+command.constructor.name);
    return response;
  }
}
const target=(id,currentVersion)=>({deploymentTargetType:"LambdaTarget",lambdaTarget:{targetId:id,status:"Succeeded",
  lambdaFunctionInfo:{functionName:"todoist-calendar-sync-ingress-production",functionAlias:"live",
    currentVersion,targetVersion:"12",targetVersionWeight:0.2}}});
function baseResponses(){return {
  ListDeploymentsCommand:{deployments:["d-123"]},
  GetDeploymentCommand:{deploymentInfo:{deploymentId:"d-123",status:"Succeeded"}},
  ListDeploymentTargetsCommand:{targetIds:["t-1"]},
  BatchGetDeploymentTargetsCommand:{deploymentTargets:[target("t-1","11")]},
};}

test("CodeDeploy collector records both rollback endpoints and deployment status",async()=>{
  const client=new FakeClient(baseResponses());
  const result=await collectCodeDeployReferences(client,{application:"todoist-calendar-sync",groups:["ingress-production"]});
  assert.equal(result.status,"BLOCKED_NOT_APPROVAL_FOR_VERSION_REMOVAL");
  assert.equal(result.awsMutationsPerformed,false);
  assert.equal(result.deploymentCount,1);
  assert.equal(result.deployments[0].status,"Succeeded");
  assert.deepEqual(result.deployments[0].targets[0],{
    targetId:"t-1",targetStatus:"Succeeded",functionName:"todoist-calendar-sync-ingress-production",
    functionAlias:"live",currentVersion:"11",targetVersion:"12",targetVersionWeight:0.2});
  assert.ok(client.calls.every(c=>!/^Delete|^Update|^Put|^Create/.test(c.constructor.name)));
});

test("collector paginates and batches target reads without dropping references",async()=>{
  const client=new FakeClient({
    ListDeploymentsCommand:command=>command.input.nextToken
      ?{deployments:["d-2"]}:{deployments:["d-1"],nextToken:"page-2"},
    GetDeploymentCommand:command=>({deploymentInfo:{deploymentId:command.input.deploymentId,status:"Succeeded"}}),
    ListDeploymentTargetsCommand:command=>({targetIds:[command.input.deploymentId+"-target"]}),
    BatchGetDeploymentTargetsCommand:command=>({deploymentTargets:command.input.targetIds.map(id=>target(id,"11"))}),
  });
  const report=await collectCodeDeployReferences(client,{application:"app",groups:["group"]});
  assert.equal(report.deploymentCount,2);
  assert.deepEqual(report.deployments.map(x=>x.deploymentId),["d-1","d-2"]);
  assert.equal(report.deployments.reduce((n,x)=>n+x.targets.length,0),2);
});

test("collector rejects partial target pages, unknown target types and repeated tokens",async()=>{
  const partial=new FakeClient({...baseResponses(),BatchGetDeploymentTargetsCommand:{deploymentTargets:[]}});
  await assert.rejects(()=>collectCodeDeployReferences(partial,{application:"app",groups:["group"]}));
  const unknown=new FakeClient({...baseResponses(),BatchGetDeploymentTargetsCommand:{deploymentTargets:[{
    deploymentTargetType:"EC2Target",lambdaTarget:{targetId:"t-1"}}]}});
  await assert.rejects(()=>collectCodeDeployReferences(unknown,{application:"app",groups:["group"]}));
  const repeated=new FakeClient({ListDeploymentsCommand:command=>({deployments:[],nextToken:command.input.nextToken||"same"})});
  await assert.rejects(()=>collectCodeDeployReferences(repeated,{application:"app",groups:["group"]}));
});

test("collector source imports only read APIs",()=>{
  const source=readFileSync(new URL("../scripts/audit-erasure-lambda-codedeploy.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(source,/DeleteDeployment|StopDeployment|UpdateDeploymentGroup|CreateDeployment/);
});
