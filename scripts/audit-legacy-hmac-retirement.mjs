#!/usr/bin/env node
/**
 * Issue #347: bounded, read-only live-runtime readiness audit before retiring
 * the disabled legacy DynamoDB/HMAC *admission reader*.
 *
 * IMPORTANT: zero markers and no active keyring DO NOT establish the safety of
 * historical Lambda invocations, IAM principals, rollback or out-of-scope rows.
 * This audit never changes DynamoDB, IAM, Lambda, provider data or settings.
 * It must not be used as authorization to enable exceptional erasure.
 */
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient,QueryCommand} from "@aws-sdk/lib-dynamodb";
import {LambdaClient,GetFunctionConfigurationCommand,ListAliasesCommand} from "@aws-sdk/client-lambda";
import {fromIni} from "@aws-sdk/credential-provider-ini";

const PROFILES=Object.freeze(["home","antonio","work"]);
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const PROFILE=/^[A-Za-z0-9+=,.@_-]{1,128}$/;
const STACK=/^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const ACCOUNT=/^\d{12}$/;
const MAX_ALIAS_PAGES=20;
const LEGACY_ENV=[
  "ERASURE_REPLAY_BARRIER_VERSION",
  "ERASURE_REPLAY_HMAC_KEYS",
  "ERASURE_REPLAY_HMAC_CURRENT_KEY",
];

function assertInputs(tableName,functions) {
  if(typeof tableName!=="string"||!tableName.trim()||tableName.length>255
    ||!Array.isArray(functions)||!functions.length
    ||functions.some(fn=>!fn||typeof fn.name!=="string"||!fn.name.trim()
      ||typeof fn.logicalId!=="string"||!fn.logicalId.trim())
    ||new Set(functions.map(fn=>fn.logicalId)).size!==functions.length)
    throw new Error("A complete CloudFormation table and Lambda inventory is required");
}

function envSummary(configuration) {
  if(configuration?.Environment?.Error)throw new Error("Lambda environment cannot be inspected");
  const vars=configuration?.Environment?.Variables;
  if(!vars||typeof vars!=="object"||Array.isArray(vars)
    ||vars.ERASURE_PROTOCOL_VERSION!=="1")
    throw new Error("Lambda environment or writer protocol could not be verified");
  const present=Object.fromEntries(LEGACY_ENV.map(key=>[key,Object.hasOwn(vars,key)]));
  return {
    legacyGateConfigured:present.ERASURE_REPLAY_BARRIER_VERSION,
    hmacKeyRingConfigured:present.ERASURE_REPLAY_HMAC_KEYS,
    hmacCurrentKeyConfigured:present.ERASURE_REPLAY_HMAC_CURRENT_KEY,
    // Never return secret values, even if a historical configuration has them.
    legacyHmacSettingsPresent:LEGACY_ENV.some(key=>present[key]),
  };
}

async function aliasesFor(lambda,name) {
  const all=[],seen=new Set();
  let marker;
  for(let page=0;page<MAX_ALIAS_PAGES;page++) {
    const data=await lambda.send(new ListAliasesCommand({
      FunctionName:name,...(marker?{Marker:marker}:{})
    }));
    if(!Array.isArray(data.Aliases))throw new Error("Incomplete Lambda alias inventory");
    all.push(...data.Aliases);
    if(!data.NextMarker)return all;
    if(typeof data.NextMarker!=="string"||seen.has(data.NextMarker))
      throw new Error("Repeated or invalid Lambda alias pagination cursor");
    seen.add(data.NextMarker);
    marker=data.NextMarker;
  }
  throw new Error("Lambda alias inventory exceeds the safety limit");
}

async function functionCheck(lambda,fn) {
  const aliases=await aliasesFor(lambda,fn.name);
  if(new Set(aliases.map(alias=>alias.Name)).size!==aliases.length)
    throw new Error("Duplicate Lambda alias in inventory");
  const qualifiers=new Set(["$LATEST"]);
  const aliasTargets=new Map();
  for(const alias of aliases) {
    if(typeof alias.Name!=="string"||!alias.Name||typeof alias.FunctionVersion!=="string")
      throw new Error("Invalid Lambda alias identity");
    qualifiers.add(alias.Name);
    aliasTargets.set(alias.Name,alias.FunctionVersion);
    for(const version of Object.keys(alias.RoutingConfig?.AdditionalVersionWeights||{})) {
      if(!/^\d+$/.test(version))throw new Error("Invalid weighted Lambda alias version");
      qualifiers.add(version);
    }
  }
  const configurations=[];
  for(const qualifier of qualifiers) {
    const response=await lambda.send(new GetFunctionConfigurationCommand({
      FunctionName:fn.name,...(qualifier==="$LATEST"?{}:{Qualifier:qualifier}),
    }));
    if(!response||response.FunctionName!==fn.name||typeof response.Version!=="string"
      ||(qualifier==="$LATEST"&&response.Version!=="$LATEST")
      ||(aliasTargets.has(qualifier)&&response.Version!==aliasTargets.get(qualifier))
      ||(/^\\d+$/.test(qualifier)&&response.Version!==qualifier))
      throw new Error("Lambda configuration missing or changed");
    configurations.push({qualifier,version:response.Version,...envSummary(response)});
  }
  return {logicalId:fn.logicalId,configurations};
}

async function markerCheck(db,tableName,profile) {
  const result=await db.send(new QueryCommand({
    TableName:tableName,KeyConditionExpression:"pk = :partition",
    ExpressionAttributeValues:{":partition":`ERASURE_REPLAY#${profile}`},
    ConsistentRead:true,Select:"COUNT",Limit:1,
  }));
  if(!Number.isInteger(result?.Count)||result.Count<0||result.Count>1)
    throw new Error("Incomplete DynamoDB marker-partition query");
  if(result.LastEvaluatedKey&&result.Count===0)
    throw new Error("DynamoDB marker partition was not conclusively empty");
  return {profile,legacyMarkerPresent:result.Count>0};
}

/** Fails closed on missing/partial reads; returns no provider IDs or secrets. */
export async function auditLegacyHmacCurrentRuntime({db,lambda,tableName,functions}) {
  assertInputs(tableName,functions);
  const [partitions,lambdaFunctions]=await Promise.all([
    Promise.all(PROFILES.map(profile=>markerCheck(db,tableName,profile))),
    Promise.all(functions.map(fn=>functionCheck(lambda,fn))),
  ]);
  const liveMarkersPresent=partitions.some(entry=>entry.legacyMarkerPresent);
  const legacySettingsPresent=lambdaFunctions.some(fn=>
    fn.configurations.some(config=>config.legacyHmacSettingsPresent));
  return {
    scope:"current stack $LATEST, aliases and weighted alias targets; exact legacy marker PKs",
    status:liveMarkersPresent||legacySettingsPresent
      ?"BLOCKED_LEGACY_HMAC_PRESENT":"CURRENT_RUNTIME_HMAC_INACTIVE",
    partitions,lambdaFunctions,
    currentRuntimeClean:!liveMarkersPresent&&!legacySettingsPresent,
    historicalVersionsAndIAMVerified:false,
    retirementApproved:false,
    providerWrites:0,awsMutations:0,secretValuesReturned:false,
  };
}

function option(argv,name) {
  const matches=argv.filter(arg=>arg.startsWith(`--${name}=`));
  if(matches.length!==1)throw new Error(`Exactly one --${name}=... is required`);
  return matches[0].slice(name.length+3);
}

function awsJson(profile,region,commandArgs) {
  return JSON.parse(execFileSync("aws",[...commandArgs,"--profile",profile,"--region",region,
    "--no-cli-pager","--output","json"],{encoding:"utf8",maxBuffer:16*1024*1024,
    env:{...process.env,AWS_RETRY_MODE:"standard",AWS_MAX_ATTEMPTS:"5"}}));
}

export async function main(argv=process.argv.slice(2)) {
  if(argv.length!==4||argv.some(arg=>!/^--(?:profile|region|expected-account|stack)=/.test(arg)))
    throw new Error("Usage: node scripts/audit-legacy-hmac-retirement.mjs --profile=<aws> --expected-account=<12 digits> --region=eu-west-2 --stack=todoist-calendar-sync");
  const profile=option(argv,"profile"),region=option(argv,"region"),
    account=option(argv,"expected-account"),stack=option(argv,"stack");
  if(!PROFILE.test(profile)||!REGION.test(region)||!ACCOUNT.test(account)||!STACK.test(stack))
    throw new Error("Invalid AWS profile, region, expected account or stack");
  const identity=awsJson(profile,region,["sts","get-caller-identity"]);
  if(identity.Account!==account)throw new Error("Expected AWS account does not match");
  const resources=awsJson(profile,region,["cloudformation","list-stack-resources","--stack-name",stack]);
  if(!Array.isArray(resources.StackResourceSummaries))throw new Error("Incomplete CloudFormation stack");
  const state=resources.StackResourceSummaries.find(r=>r.LogicalResourceId==="SyncState"
    &&r.ResourceType==="AWS::DynamoDB::Table");
  const functions=resources.StackResourceSummaries.filter(r=>r.ResourceType==="AWS::Lambda::Function")
    .map(r=>({logicalId:r.LogicalResourceId,name:r.PhysicalResourceId}));
  const credentials=fromIni({profile});
  const dynamo=new DynamoDBClient({region,credentials});
  const db=DynamoDBDocumentClient.from(dynamo);
  const lambda=new LambdaClient({region,credentials});
  try {
    const audit=await auditLegacyHmacCurrentRuntime({
      db,lambda,tableName:state?.PhysicalResourceId,functions,
    });
    process.stdout.write(JSON.stringify({accountVerified:true,region,stack,...audit},null,2)+"\n");
    if(!audit.currentRuntimeClean)process.exitCode=2;
  } finally {db.destroy();dynamo.destroy();lambda.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{process.stderr.write("Legacy HMAC readiness audit INCOMPLETE: "+error.message+"\n");process.exitCode=2;});
