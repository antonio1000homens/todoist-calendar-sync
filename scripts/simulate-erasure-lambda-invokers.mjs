#!/usr/bin/env node
/**
 * Issue #307: read-only IAM policy simulation for candidate Lambda invokers.
 * The result is not a live invocation test or approval to change IAM.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

const ACCOUNT=/^\d{12}$/;
const PROFILE=/^[A-Za-z0-9+=,.@_-]{1,128}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const BATCH_SIZE=50;

function validateInputs(inventory,identityReport,accountId) {
  if(!ACCOUNT.test(accountId||"")||!inventory||inventory.verifiedAccount!==accountId
    ||inventory.purpose!=="issue-307-read-only-qualified-lambda-inventory"
    ||inventory.status!=="BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT"
    ||!REGION.test(inventory.region)||!Array.isArray(inventory.functions)||!inventory.functions.length
    ||!Array.isArray(inventory.expectedFunctions)||!inventory.expectedFunctions.length
    ||!Array.isArray(inventory.missingExpected)||inventory.missingExpected.length)
    throw new Error("Complete same-account Lambda inventory is required");
  if(!identityReport||identityReport.verifiedAccount!==accountId
    ||identityReport.purpose!=="issue-307-iam-identity-invocation-candidates"
    ||identityReport.status!=="BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF"
    ||identityReport.missingManagedDocumentCount!==0||!Array.isArray(identityReport.candidates))
    throw new Error("Complete same-account IAM identity candidate report is required");
}

export function buildLambdaInvocationTargets(inventory,accountId,partition="aws") {
  const targets=[];
  const functionNames=new Set(inventory.functions.map(fn=>fn?.name));
  if(functionNames.size!==inventory.functions.length||inventory.expectedFunctions.some(name=>!functionNames.has(name)))
    throw new Error("Lambda inventory does not cover the expected function names");
  for(const fn of inventory.functions) {
    if(typeof fn?.name!=="string"||!Array.isArray(fn.versions)||!Array.isArray(fn.aliases))
      throw new Error("Malformed Lambda qualifier inventory");
    const versions=new Set(fn.versions.map(version=>version?.qualifier));
    if(!versions.has("$LATEST")||versions.size!==fn.versions.length
      ||fn.versions.some(version=>typeof version?.qualifier!=="string"
        ||(version.qualifier!=="$LATEST"&&!/^[1-9]\d*$/.test(version.qualifier))))
      throw new Error("Incomplete Lambda published-version inventory");
    const base=`arn:${partition}:lambda:${inventory.region}:${accountId}:function:${fn.name}`;
    targets.push({arn:base,functionName:fn.name,qualifier:"unqualified"});
    for(const version of versions)if(version!=="$LATEST")
      targets.push({arn:`${base}:${version}`,functionName:fn.name,qualifier:version});
    const aliasNames=new Set();
    for(const alias of fn.aliases) {
      if(typeof alias?.name!=="string"||!alias.name||aliasNames.has(alias.name)
        ||typeof alias.version!=="string"||alias.version==="$LATEST"||!versions.has(alias.version)
        ||!alias.additionalVersions||typeof alias.additionalVersions!=="object"||Array.isArray(alias.additionalVersions))
        throw new Error("Malformed Lambda alias inventory");
      aliasNames.add(alias.name);
      for(const [version,weight] of Object.entries(alias.additionalVersions))
        if(!versions.has(version)||version==="$LATEST"||typeof weight!=="number"||!Number.isFinite(weight)||weight<0||weight>1)
          throw new Error("Weighted alias references an unknown version or has an invalid weight");
      targets.push({arn:`${base}:${alias.name}`,functionName:fn.name,qualifier:alias.name});
    }
  }
  return targets;
}

export function collectInvocationSimulations({inventory,identityReport,accountId,partition="aws",run}) {
  validateInputs(inventory,identityReport,accountId);
  if(typeof run!=="function")throw new Error("Read-only IAM simulation runner is required");
  const targets=buildLambdaInvocationTargets(inventory,accountId,partition);
  const principals=new Map();
  for(const candidate of identityReport.candidates) {
    if(!candidate||!['user','role','group'].includes(candidate.principalType)
      ||typeof candidate.principalArn!=="string"||!Array.isArray(candidate.actions))
      throw new Error("IAM candidate report contains a malformed principal");
    if(candidate.actions.includes("lambda:InvokeFunction")&&candidate.qualifiedPossible)
      principals.set(candidate.principalArn,candidate.principalType);
  }
  const results=[];
  for(const [policySourceArn,principalType] of [...principals].sort(([left],[right])=>left.localeCompare(right))) {
    const decisions=new Map();
    const policyTypeDetails=new Map();
    const missingContext=new Set();
    let permissionBoundaryDetail;
    for(let offset=0;offset<targets.length;offset+=BATCH_SIZE) {
      const batch=targets.slice(offset,offset+BATCH_SIZE);
      const response=run({policySourceArn,action:"lambda:InvokeFunction",resourceArns:batch.map(target=>target.arn),
        region:inventory.region});
      const evaluations=response?.EvaluationResults;
      if(!Array.isArray(evaluations)||evaluations.length!==1
        ||evaluations[0].EvalActionName?.toLowerCase()!=="lambda:invokefunction"
        ||!Array.isArray(evaluations[0].ResourceSpecificResults))
        throw new Error("IAM simulator returned an incomplete action/resource page");
      const evaluation=evaluations[0];
      for(const [key,value] of Object.entries(evaluation.EvalDecisionDetails||{})) {
        const values=policyTypeDetails.get(key)||new Set();values.add(value);policyTypeDetails.set(key,values);
      }
      for(const key of evaluation.MissingContextValues||[])missingContext.add(key);
      if(evaluation.PermissionsBoundaryDecisionDetail)
        permissionBoundaryDetail=evaluation.PermissionsBoundaryDecisionDetail;
      const page=new Set();
      for(const item of evaluation.ResourceSpecificResults) {
        if(typeof item?.EvalResourceName!=="string"||!batch.some(target=>target.arn===item.EvalResourceName)
          ||typeof item.EvalResourceDecision!=="string"||page.has(item.EvalResourceName))
          throw new Error("IAM simulator returned an unknown or duplicated resource result");
        page.add(item.EvalResourceName);
        decisions.set(item.EvalResourceName,item.EvalResourceDecision);
      }
      if(page.size!==batch.length)throw new Error("IAM simulator omitted one or more requested Lambda qualifiers");
    }
    const allowed=targets.filter(target=>decisions.get(target.arn)==="allowed").length;
    const denied=targets.filter(target=>decisions.has(target.arn)&&decisions.get(target.arn)!=="allowed").length;
    const qualifiedTargets=targets.filter(target=>target.qualifier!=="unqualified");
    const qualifiedAllowed=qualifiedTargets.filter(target=>decisions.get(target.arn)==="allowed").length;
    results.push({principalType,policySourceArn,evaluatedTargets:decisions.size,totalTargets:targets.length,
      allowedTargets:allowed,deniedTargets:denied,qualifiedTargets:qualifiedTargets.length,
      qualifiedAllowedTargets:qualifiedAllowed,
      policyTypeDetails:Object.fromEntries([...policyTypeDetails].map(([key,values])=>[key,[...values].sort()])),
      permissionBoundaryDetail:permissionBoundaryDetail??null,missingContextKeys:[...missingContext].sort()});
  }
  return {purpose:"issue-307-iam-lambda-invocation-simulation",status:"SIMULATED_NOT_LIVE_INVOCATION_OR_APPROVAL",
    verifiedAccount:accountId,region:inventory.region,action:"lambda:InvokeFunction",principalCount:results.length,
    targetCount:targets.length,results,
    limitations:[
      "Simulation evaluates configured identity policies and applicable SCPs, but does not verify who can assume each role",
      "STS session policies and the exact caller/session context are not proven by this simulation",
      "No Lambda resource policy was supplied; role simulations cannot evaluate resource policies, and user/group resource grants need separate review",
      "Only aws:RequestedRegion is supplied; missing context values and other conditional grants remain unresolved",
      "RCPs, all accounts/regions, legacy names and live invocation telemetry require separate evidence",
      "A simulation is not a live invocation and cannot authorize IAM changes, version retirement or replay release",
    ],replayBarrierMayBeEnabled:false,executableRecoveryMayBeEnabled:false};
}

function option(argv,key) {
  const matches=argv.filter(arg=>arg.startsWith("--"+key+"="));
  if(matches.length!==1)throw new Error("Exactly one --"+key+"=... is required");
  return matches[0].slice(key.length+3);
}
function runAws(profile,args) {
  return JSON.parse(execFileSync("aws",[...args,"--profile",profile,"--no-cli-pager","--output","json"],{
    encoding:"utf8",maxBuffer:16*1024*1024,env:{...process.env,AWS_RETRY_MODE:"standard",AWS_MAX_ATTEMPTS:"8"},
  }));
}

export function main(argv=process.argv.slice(2)) {
  if(argv.some(arg=>!/^--(?:profile|expected-account|inventory|candidates)=[^\s]+$/.test(arg))||argv.length!==4)
    throw new Error("Usage: node scripts/simulate-erasure-lambda-invokers.mjs --profile=<name> --expected-account=<12 digits> --inventory=<lambda-inventory.json> --candidates=<iam-candidates.json>");
  const profile=option(argv,"profile"),accountId=option(argv,"expected-account");
  if(!PROFILE.test(profile)||!ACCOUNT.test(accountId))throw new Error("Invalid AWS profile or account");
  const identity=runAws(profile,["sts","get-caller-identity"]);
  if(identity.Account!==accountId)throw new Error("AWS profile account did not match --expected-account");
  const inventory=JSON.parse(readFileSync(option(argv,"inventory"),"utf8"));
  const identityReport=JSON.parse(readFileSync(option(argv,"candidates"),"utf8"));
  if(inventory.verifiedAccount!==identity.Account||identityReport.verifiedAccount!==identity.Account)
    throw new Error("One or more audit inputs belong to a different AWS account");
  const partition=typeof identity.Arn==="string"?identity.Arn.split(":")[1]:"aws";
  const report=collectInvocationSimulations({inventory,identityReport,accountId,partition,
    run:request=>runAws(profile,["iam","simulate-principal-policy","--policy-source-arn",request.policySourceArn,
      "--action-names",request.action,"--resource-arns",...request.resourceArns,"--context-entries",
      `ContextKeyName=aws:RequestedRegion,ContextKeyValues=${request.region},ContextKeyType=string`])});
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.exitCode=2;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {main();} catch(error) {
    process.stderr.write("Lambda invoker policy simulation INCOMPLETE: "+error.message+"\n");
    process.exitCode=2;
  }
}
