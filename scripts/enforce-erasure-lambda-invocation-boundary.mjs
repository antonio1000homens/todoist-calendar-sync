#!/usr/bin/env node
/**
 * Apply and verify explicit resource-policy boundaries for the canonical
 * Todoist Calendar Sync Lambda functions. Numeric versions are never directly
 * invokable. Unqualified functions and aliases accept invocations only from
 * AWS services or through their configured Function URL. Existing policy
 * statements are preserved and policy replacements use revision checks.
 */
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {
  GetFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  GetResourcePolicyCommand,
  LambdaClient,
  ListAliasesCommand,
  ListEventSourceMappingsCommand,
  ListVersionsByFunctionCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-lambda";
import {expectedTemplateFunctions} from "./audit-erasure-lambda-invokers.mjs";

const PREFIX="todoist-calendar-sync";
const STAGE="production";
const MAX_PAGES=1000;
const DENY_VERSION_SID="DenyUnreviewedQualifiedInvocation";
const DENY_DIRECT_SID="DenyDirectInvocationOutsideFunctionUrlOrAwsService";
const INVOKE_ACTIONS=["lambda:InvokeFunction","lambda:InvokeAsync"];
const denied=new Set(["ResourceConflictException","PreconditionFailedException","TooManyRequestsException"]);

function canonical(value) {
  return JSON.stringify(value&&typeof value==="object"&&!Array.isArray(value)
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalValue(value[key])])):value);
}
function canonicalValue(value) {
  if(Array.isArray(value))return value.map(canonicalValue);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort()
    .map(key=>[key,canonicalValue(value[key])]));
  return value;
}
function statementsOf(policy) {
  const statements=policy?.Statement;
  return statements===undefined?[]:Array.isArray(statements)?statements:[statements];
}

export function invocationBoundaryStatement(resourceArn,kind) {
  if(typeof resourceArn!=="string"||!/^arn:[^:]+:lambda:[^:]+:\d{12}:function:[A-Za-z0-9_-]+(?::(?:\$LATEST|[1-9]\d*|[A-Za-z0-9_-]+))?$/.test(resourceArn))
    throw new Error("A complete canonical Lambda resource ARN is required");
  if(kind==="version"&&!/:[1-9]\d*$/.test(resourceArn))
    throw new Error("Version boundary requires an exact published numeric version ARN");
  if(kind==="direct"&&/:[1-9]\d*$/.test(resourceArn))
    throw new Error("Direct boundary cannot target a numeric version");
  if(kind!=="version"&&kind!=="direct")throw new Error("Unknown Lambda boundary kind");
  return kind==="version"
    ?{Sid:DENY_VERSION_SID,Effect:"Deny",Principal:"*",Action:INVOKE_ACTIONS,Resource:resourceArn}
    :{Sid:DENY_DIRECT_SID,Effect:"Deny",Principal:"*",Action:INVOKE_ACTIONS,Resource:resourceArn,
      Condition:{BoolIfExists:{"aws:PrincipalIsAWSService":"false","lambda:InvokedViaFunctionUrl":"false"}}};
}

export function mergeInvocationBoundary(policyText,resourceArn,kind) {
  let policy={Version:"2012-10-17",Statement:[]};
  if(policyText!==undefined&&policyText!==null) {
    try {policy=JSON.parse(policyText);} catch {throw new Error("Existing Lambda resource policy is not valid JSON");}
    if(!policy||typeof policy!=="object"||Array.isArray(policy)||typeof policy.Version!=="string")
      throw new Error("Existing Lambda resource policy is malformed");
  }
  const expected=invocationBoundaryStatement(resourceArn,kind);
  const statements=statementsOf(policy);
  const sameSid=statements.filter(statement=>statement?.Sid===expected.Sid);
  if(sameSid.length>1)throw new Error("Lambda resource policy contains duplicate invocation-boundary statements");
  if(sameSid.length===1) {
    if(canonical(sameSid[0])!==canonical(expected))
      throw new Error("Existing Lambda invocation-boundary statement differs from the reviewed policy");
    return {policy:{...policy,Statement:statements},changed:false,statement:expected};
  }
  if(statements.some(statement=>statement?.Sid===DENY_VERSION_SID||statement?.Sid===DENY_DIRECT_SID))
    throw new Error("Lambda resource policy has an unexpected invocation-boundary statement");
  return {policy:{...policy,Statement:[...statements,expected]},changed:true,statement:expected};
}

async function allPages(client,Command,key,input={}) {
  const result=[],seen=new Set();let marker;
  for(let page=0;page<MAX_PAGES;page++) {
    const response=await client.send(new Command({...input,...(marker?{Marker:marker}:{})}));
    if(!Array.isArray(response?.[key]))throw new Error(`Incomplete Lambda ${key} inventory`);
    result.push(...response[key]);
    const next=response.NextMarker;
    if(!next)return result;
    if(typeof next!=="string"||seen.has(next))throw new Error(`Repeated Lambda ${key} pagination marker`);
    seen.add(next);marker=next;
  }
  throw new Error(`Lambda ${key} inventory exceeded the page limit`);
}

function resourceArnForFunction(functionArn,qualifier) {
  const base=functionArn.replace(/:\$LATEST$/,"" );
  return qualifier?`${base}:${qualifier}`:base;
}
function isMissingPolicy(error) { return error?.name==="ResourceNotFoundException"; }
function isPolicyRace(error) { return denied.has(error?.name); }

async function readPolicy(client,ResourceArn) {
  try {
    const response=await client.send(new GetResourcePolicyCommand({ResourceArn}));
    if(typeof response.Policy!=="string"||typeof response.RevisionId!=="string")
      throw new Error("Lambda resource policy readback was incomplete");
    return {Policy:response.Policy,RevisionId:response.RevisionId};
  } catch(error) {
    if(isMissingPolicy(error))return {Policy:undefined,RevisionId:undefined};
    throw error;
  }
}

export async function ensureBoundary(client,resourceArn,kind) {
  for(let attempt=0;attempt<4;attempt++) {
    const before=await readPolicy(client,resourceArn);
    const merged=mergeInvocationBoundary(before.Policy,resourceArn,kind);
    if(!merged.changed)return {changed:false};
    try {
      await client.send(new PutResourcePolicyCommand({ResourceArn:resourceArn,
        Policy:JSON.stringify(merged.policy),...(before.RevisionId?{RevisionId:before.RevisionId}:{})}));
    } catch(error) {
      if(isPolicyRace(error)&&attempt<3)continue;
      throw error;
    }
    const after=await readPolicy(client,resourceArn);
    const actual=mergeInvocationBoundary(after.Policy,resourceArn,kind);
    if(actual.changed)throw new Error("Lambda invocation boundary was not present after resource-policy update");
    for(const prior of statementsOf(before.Policy?JSON.parse(before.Policy):undefined)) {
      if(!statementsOf(JSON.parse(after.Policy)).some(statement=>canonical(statement)===canonical(prior)))
        throw new Error("Lambda resource-policy update did not preserve all prior permission statements");
    }
    return {changed:true};
  }
  throw new Error("Lambda resource policy changed repeatedly during compare-and-swap");
}

export async function enforceInvocationBoundaries(client,{region,templateText}) {
  if(typeof region!=="string"||!/^([a-z]{2}-[a-z]+-\d+)$/.test(region))
    throw new Error("A valid deployment region is required");
  const names=expectedTemplateFunctions(templateText,PREFIX,STAGE);
  if(!names.length)throw new Error("Canonical Lambda inventory is empty");
  const functions=[];
  for(const name of names) {
    const config=await client.send(new GetFunctionConfigurationCommand({FunctionName:name}));
    const baseArn=config.FunctionArn;
    if(typeof baseArn!=="string"||!baseArn.includes(`:lambda:${region}:`)
      ||!baseArn.endsWith(`:function:${name}`))throw new Error("Lambda function ARN did not match the expected name and region");
    const [versions,aliases]=await Promise.all([
      allPages(client,ListVersionsByFunctionCommand,"Versions",{FunctionName:name}),
      allPages(client,ListAliasesCommand,"Aliases",{FunctionName:name}),
    ]);
    if(!versions.some(item=>item.Version==="$LATEST")
      ||versions.some(item=>typeof item.Version!=="string")
      ||new Set(versions.map(item=>item.Version)).size!==versions.length)
      throw new Error("Lambda version inventory is incomplete or duplicated");
    if(aliases.some(item=>typeof item.Name!=="string"||!item.Name||item.FunctionVersion==="$LATEST"))
      throw new Error("Lambda alias inventory is malformed");
    const targets=[];
    for(const version of versions.filter(item=>item.Version!=="$LATEST")) {
      if(!/^[1-9]\d*$/.test(version.Version))throw new Error("Unexpected published Lambda version qualifier");
      targets.push({arn:resourceArnForFunction(baseArn,version.Version),kind:"version",qualifier:version.Version});
    }
    targets.push({arn:resourceArnForFunction(baseArn,undefined),kind:"direct",qualifier:"unqualified"});
    for(const alias of aliases) {
      const aliasArn=resourceArnForFunction(baseArn,alias.Name);
      await client.send(new GetFunctionUrlConfigCommand({FunctionName:name,Qualifier:alias.Name}))
        .catch(error=>{if(error?.name!=="ResourceNotFoundException")throw error;});
      targets.push({arn:aliasArn,kind:"direct",qualifier:alias.Name});
    }
    functions.push({name,baseArn,targets});
  }

  const mappings=await allPages(client,ListEventSourceMappingsCommand,"EventSourceMappings",{MaxItems:100});
  const numericTargets=new Set(functions.flatMap(item=>item.targets.filter(target=>target.kind==="version")
    .map(target=>target.arn)));
  if(mappings.some(mapping=>typeof mapping.FunctionArn==="string"&&numericTargets.has(mapping.FunctionArn)))
    throw new Error("A live event-source mapping targets a numeric published version; refusing to deny it automatically");

  let changedVersionPolicies=0,changedDirectPolicies=0,unchangedPolicies=0;
  for(const item of functions)for(const target of item.targets) {
    const result=await ensureBoundary(client,target.arn,target.kind);
    if(!result.changed)unchangedPolicies++;
    else if(target.kind==="version")changedVersionPolicies++;
    else changedDirectPolicies++;
  }
  return {status:"verified",functionCount:functions.length,
    publishedVersionCount:functions.reduce((sum,item)=>sum+item.targets.filter(target=>target.kind==="version").length,0),
    directResourceCount:functions.reduce((sum,item)=>sum+item.targets.filter(target=>target.kind==="direct").length,0),
    changedVersionPolicies,changedDirectPolicies,unchangedPolicies,
    numericEventSourceMappings:0};
}

function option(argv,name) {
  const matches=argv.filter(arg=>arg.startsWith(`--${name}=`));
  if(matches.length!==1)throw new Error(`Exactly one --${name}=... is required`);
  return matches[0].slice(name.length+3);
}

export async function main(argv=process.argv.slice(2)) {
  if(argv.length!==1||!/^--region=[a-z]{2}-[a-z]+-\d+$/.test(argv[0]))
    throw new Error("Usage: node scripts/enforce-erasure-lambda-invocation-boundary.mjs --region=eu-west-2");
  const region=option(argv,"region");
  const templateText=readFileSync(new URL("../template.yaml",import.meta.url),"utf8");
  const client=new LambdaClient({region,maxAttempts:5});
  try {
    const result=await enforceInvocationBoundaries(client,{region,templateText});
    process.stdout.write(JSON.stringify({service:"todoist-calendar-sync-lambda-invocation-boundary",...result})+"\n");
  } finally {client.destroy();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{process.stderr.write("Lambda invocation boundary enforcement failed: "+error.message+"\n");process.exitCode=1;});
