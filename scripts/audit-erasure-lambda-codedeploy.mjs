#!/usr/bin/env node
/**
 * Issue #307: read-only inventory of versions referenced by CodeDeploy.
 * This report is evidence for human review only; it never approves deletion.
 */
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {
  CodeDeployClient, GetDeploymentCommand, ListDeploymentsCommand, ListDeploymentTargetsCommand,
  BatchGetDeploymentTargetsCommand,
} from "@aws-sdk/client-codedeploy";

const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const IDENT=/^[A-Za-z0-9_-]{1,100}$/;
const MAX_PAGES=1000;
const BATCH_SIZE=25;

function option(argv,name,{many=false}={}) {
  const values=argv.filter(arg=>arg.startsWith(`--${name}=`)).map(arg=>arg.slice(name.length+3));
  if((many?values.length<1:values.length!==1)||values.some(v=>!v))
    throw new Error(`${many?"At least one":"Exactly one"} --${name}=... is required`);
  return many?values:values[0];
}

async function collectPages(client,Command,key,input) {
  const rows=[],seen=new Set();let token;
  for(let page=0;page<MAX_PAGES;page++) {
    const response=await client.send(new Command({...input,...(token?{nextToken:token}:{})}));
    if(!Array.isArray(response?.[key]))throw new Error(`Missing CodeDeploy ${key}; audit incomplete`);
    rows.push(...response[key]);
    const next=response.nextToken;
    if(next===undefined||next===null||next==="")return rows;
    if(typeof next!=="string"||seen.has(next))throw new Error(`Repeated/invalid CodeDeploy ${key} token`);
    seen.add(next);token=next;
  }
  throw new Error(`CodeDeploy ${key} exceeded page limit`);
}

export async function collectCodeDeployReferences(client,{application,groups}) {
  if(!IDENT.test(application)||!Array.isArray(groups)||!groups.length||groups.some(g=>!IDENT.test(g))
    ||new Set(groups).size!==groups.length)throw new Error("Explicit unique valid application and deployment groups are required");
  const deployments=[];
  for(const deploymentGroup of groups) {
    const ids=await collectPages(client,ListDeploymentsCommand,"deployments",{applicationName:application,deploymentGroupName:deploymentGroup});
    for(const deploymentId of ids) {
      if(typeof deploymentId!=="string"||!deploymentId)throw new Error("Invalid deployment id");
      const deploymentInfo=await client.send(new GetDeploymentCommand({deploymentId}));
      if(deploymentInfo?.deploymentInfo?.deploymentId!==deploymentId||
        typeof deploymentInfo.deploymentInfo.status!=="string")
        throw new Error(`Incomplete deployment status for ${deploymentId}`);
      const targetIds=await collectPages(client,ListDeploymentTargetsCommand,"targetIds",{deploymentId});
      if(!targetIds.length)throw new Error(`Deployment ${deploymentId} has no target inventory`);
      const targets=[];
      for(let i=0;i<targetIds.length;i+=BATCH_SIZE) {
        const batch=targetIds.slice(i,i+BATCH_SIZE);
        const response=await client.send(new BatchGetDeploymentTargetsCommand({deploymentId,targetIds:batch}));
        if(!Array.isArray(response?.deploymentTargets)||response.deploymentTargets.length!==batch.length)
          throw new Error(`Incomplete target batch for deployment ${deploymentId}`);
        targets.push(...response.deploymentTargets);
      }
      const seen=new Set();
      const normalized=targets.map(target=>{
        const info=target;
        const lambda=info?.lambdaTarget;
        const id=lambda?.targetId;
        if(typeof id!=="string"||seen.has(id))throw new Error(`Invalid/duplicate target in deployment ${deploymentId}`);
        seen.add(id);
        if(info?.deploymentTargetType!=="LambdaTarget")throw new Error(`Unknown target type in deployment ${deploymentId}`);
        const functionInfo=lambda?.lambdaFunctionInfo;
        if(typeof functionInfo?.functionName!=="string"||typeof functionInfo?.currentVersion!=="string"
          ||typeof functionInfo?.targetVersion!=="string"||typeof functionInfo?.functionAlias!=="string")
          throw new Error(`Incomplete Lambda version reference in deployment ${deploymentId}`);
        return {targetId:id,targetStatus:lambda.status??"UNKNOWN",functionName:functionInfo.functionName,
          functionAlias:functionInfo.functionAlias,currentVersion:functionInfo.currentVersion,
          targetVersion:functionInfo.targetVersion,targetVersionWeight:functionInfo.targetVersionWeight??null};
      });
      deployments.push({deploymentId,deploymentGroup,status:deploymentInfo.deploymentInfo.status,targets:normalized});
    }
  }
  return {purpose:"issue-307-read-only-codedeploy-version-references",
    status:"BLOCKED_NOT_APPROVAL_FOR_VERSION_REMOVAL",application,
    deploymentGroups:groups,deploymentCount:deployments.length,deployments,
    awsMutationsPerformed:false,versionRemovalApproved:false};
}

export async function main(argv=process.argv.slice(2)) {
  const allowed=/^--(?:profile|region|application|deployment-group)=[A-Za-z0-9_-]+$|^--expected-account=\d{12}$/;
  if(argv.some(arg=>!allowed.test(arg))||argv.length<5)
    throw new Error("Usage: node scripts/audit-erasure-lambda-codedeploy.mjs --profile=windsor --expected-account=243857182133 --region=eu-west-2 --application=... --deployment-group=... [--deployment-group=...]");
  const profile=option(argv,"profile"),region=option(argv,"region"),application=option(argv,"application");
  const expectedAccount=option(argv,"expected-account"),groups=option(argv,"deployment-group",{many:true});
  if(!IDENT.test(profile)||!REGION.test(region)||!/^\d{12}$/.test(expectedAccount))
    throw new Error("Invalid AWS profile, region or expected account");
  const identity=JSON.parse(execFileSync("aws",["sts","get-caller-identity","--profile",profile,"--no-cli-pager","--output","json"],{encoding:"utf8",maxBuffer:1024*1024}));
  if(identity.Account!==expectedAccount)throw new Error("AWS profile account did not match --expected-account");
  const client=new CodeDeployClient({region,profile,maxAttempts:5});
  try {
    const report=await collectCodeDeployReferences(client,{application,groups});
    process.stdout.write(JSON.stringify({region,verifiedAccount:identity.Account,...report},null,2)+"\n");
    process.exitCode=2;
  } finally {client.destroy();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{process.stderr.write("Erasure CodeDeploy audit INCOMPLETE: "+error.message+"\n");process.exitCode=2;});
