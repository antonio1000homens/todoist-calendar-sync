#!/usr/bin/env node
/**
 * Read-only, redacted Lambda environment-flag inventory for issue #307.
 * Reads every published qualifier and $LATEST. It never returns environment
 * values, and a complete inventory is still not approval to release replay.
 */
import {pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
import {fromIni} from "@aws-sdk/credential-provider-ini";
import {GetFunctionConfigurationCommand,LambdaClient,ListAliasesCommand,ListVersionsByFunctionCommand} from "@aws-sdk/client-lambda";

const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const FUNCTION=/^[A-Za-z0-9_-]{2,64}$/;
const PROFILE=/^[A-Za-z0-9+=,.@_-]{1,128}$/;
const ACCOUNT=/^\d{12}$/;
const MAX_PAGES=1000;
const MAX_CONCURRENCY=2;
const MAX_RATE_RETRIES=3;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function requiredOption(argv,name) {
  const values=argv.filter(arg=>arg.startsWith(`--${name}=`));
  if(values.length!==1)throw new Error(`Exactly one --${name}=... is required`);
  return values[0].slice(name.length+3);
}
export function verifyExpectedAccount(identity,expectedAccount) {
  if(!ACCOUNT.test(expectedAccount)||!identity||identity.Account!==expectedAccount)
    throw new Error("AWS profile account did not match --expected-account");
  return identity.Account;
}
async function sendRead(client,command,delay=sleep) {
  for(let attempt=0;;attempt++) {
    try {return await client.send(command);}
    catch(error) {
      const throttled=["TooManyRequestsException","ThrottlingException","RequestLimitExceeded"].includes(error?.name)
        ||error?.$metadata?.httpStatusCode===429;
      if(!throttled||attempt>=MAX_RATE_RETRIES)throw error;
      const retryAfter=Number(error?.$response?.headers?.["retry-after"]);
      await delay(Number.isFinite(retryAfter)&&retryAfter>0?Math.min(8_000,retryAfter*1000):Math.min(8_000,250*2**attempt));
    }
  }
}
async function collectPages(client,Command,key,input={},delay=sleep) {
  const results=[],seen=new Set();let marker;
  for(let page=0;page<MAX_PAGES;page++) {
    const response=await sendRead(client,new Command({...input,...(marker?{Marker:marker}:{})}),delay);
    if(!Array.isArray(response?.[key]))throw new Error(`Incomplete Lambda ${key} inventory`);
    results.push(...response[key]);
    const next=response.NextMarker;
    if(next===undefined||next===null||next==="")return results;
    if(typeof next!=="string"||seen.has(next))throw new Error(`Repeated or invalid Lambda ${key} pagination marker`);
    seen.add(next);marker=next;
  }
  throw new Error(`Lambda ${key} inventory exceeded its page limit`);
}
async function mapLimit(items,limit,fn) {
  let index=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(index<items.length) {const item=items[index++];await fn(item);}
  }));
}
function summarizeEnvironment(config) {
  if(config.Environment?.Error)throw new Error("Lambda environment configuration could not be read");
  const variables=config.Environment?.Variables||{};
  const state=(name)=>{
    if(!Object.hasOwn(variables,name))return "absent";
    if(name==="ERASURE_REPLAY_BARRIER_VERSION"||name==="ERASURE_POSTWRITE_REVIEW_VERSION")
      return variables[name]==="1"?"enabled":"present_other";
    if(name==="ERASURE_PROTOCOL_VERSION")return variables[name]==="1"?"enabled":"present_other";
    return variables[name]==="true"?"enabled":"present_other";
  };
  return {replayBarrier:state("ERASURE_REPLAY_BARRIER_VERSION"),
    replayHmacKeyRing:Object.hasOwn(variables,"ERASURE_REPLAY_HMAC_KEYS")?"present":"absent",
    replayHmacCurrentKey:Object.hasOwn(variables,"ERASURE_REPLAY_HMAC_CURRENT_KEY")?"present":"absent",
    postwriteReview:state("ERASURE_POSTWRITE_REVIEW_VERSION"),
    erasureExecution:state("ERASURE_EXECUTION_ENABLED"),
    erasureProtocol:state("ERASURE_PROTOCOL_VERSION")};
}
function normalizedAliases(aliases) {
  const normalized=aliases.map(alias=>({name:alias.Name,version:alias.FunctionVersion,
    revisionId:alias.RevisionId||null,weightedTargets:alias.RoutingConfig?.AdditionalVersionWeights||{}}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  if(new Set(normalized.map(alias=>alias.name)).size!==normalized.length)
    throw new Error("Duplicate Lambda alias in inventory");
  return normalized;
}

export async function collectRuntimeConfigAudit(client,{functionNames,region,sleep:delay=sleep}) {
  if(!REGION.test(region)||!Array.isArray(functionNames)||!functionNames.length
    ||functionNames.some(name=>typeof name!=="string"||!FUNCTION.test(name)))
    throw new Error("Explicit valid region and Lambda function names are required");
  const functions=[];
  for(const functionName of [...new Set(functionNames)].sort()) {
    const versions=await collectPages(client,ListVersionsByFunctionCommand,"Versions",{FunctionName:functionName},delay);
    if(!versions.length||!versions.some(item=>item.Version==="$LATEST"))
      throw new Error(`Incomplete Lambda version inventory for ${functionName}`);
    const qualifiers=new Set(versions.map(item=>item.Version));
    if(qualifiers.size!==versions.length||versions.some(item=>typeof item.Version!=="string"
      ||typeof item.CodeSha256!=="string"||!item.CodeSha256))
      throw new Error(`Invalid Lambda version inventory for ${functionName}`);
    const aliases=await collectPages(client,ListAliasesCommand,"Aliases",{FunctionName:functionName},delay);
    for(const alias of aliases) {
      if(typeof alias.Name!=="string"||typeof alias.FunctionVersion!=="string"
        ||!qualifiers.has(alias.FunctionVersion))
        throw new Error(`Alias target is absent from version inventory for ${functionName}`);
      const weighted=alias.RoutingConfig?.AdditionalVersionWeights||{};
      if(Object.keys(weighted).some(version=>!qualifiers.has(version)))
        throw new Error(`Weighted alias target is absent from version inventory for ${functionName}`);
    }
    const configs=[];
    await mapLimit(versions,MAX_CONCURRENCY,async version=>{
      const config=await sendRead(client,new GetFunctionConfigurationCommand({FunctionName:functionName,Qualifier:version.Version}),delay);
      if(config.FunctionName!==functionName||config.Version!==version.Version
        ||config.CodeSha256!==version.CodeSha256)
        throw new Error(`Lambda configuration changed during audit for ${functionName}:${version.Version}`);
      configs.push({version:version.Version,codeSha256:version.CodeSha256,...summarizeEnvironment(config)});
    });
    const current=versions.find(item=>item.Version==="$LATEST");
    const latestAgain=await sendRead(client,new GetFunctionConfigurationCommand({FunctionName:functionName,Qualifier:"$LATEST"}),delay);
    const latestSummary={version:"$LATEST",codeSha256:latestAgain.CodeSha256,...summarizeEnvironment(latestAgain)};
    if(latestAgain.FunctionName!==functionName||latestAgain.Version!=="$LATEST"
      ||latestAgain.CodeSha256!==current.CodeSha256
      ||JSON.stringify(latestSummary)!==JSON.stringify(configs.find(item=>item.version==="$LATEST")))
      throw new Error(`Lambda $LATEST configuration changed during audit for ${functionName}`);
    const aliasesAgain=await collectPages(client,ListAliasesCommand,"Aliases",{FunctionName:functionName},delay);
    if(JSON.stringify(normalizedAliases(aliases))!==JSON.stringify(normalizedAliases(aliasesAgain)))
      throw new Error(`Lambda aliases changed during audit for ${functionName}`);
    configs.sort((a,b)=>a.version==="$LATEST"?1:b.version==="$LATEST"?-1:Number(a.version)-Number(b.version));
    const count=key=>configs.filter(item=>item[key]==="enabled").length;
    functions.push({functionName,versionCount:versions.length,
      publishedVersionCount:versions.filter(item=>item.Version!=="$LATEST").length,
      aliases:normalizedAliases(aliases),
      configs,replayBarrierEnabledCount:count("replayBarrier"),
      replayBarrierPresentCount:configs.filter(item=>item.replayBarrier!=="absent").length,
      replayHmacKeyRingPresentCount:configs.filter(item=>item.replayHmacKeyRing==="present").length,
      replayHmacCurrentKeyPresentCount:configs.filter(item=>item.replayHmacCurrentKey==="present").length,
      postwriteReviewEnabledCount:count("postwriteReview"),
      postwriteReviewPresentCount:configs.filter(item=>item.postwriteReview!=="absent").length,
      erasureExecutionEnabledCount:count("erasureExecution"),
      erasureExecutionReadyCount:configs.filter(item=>item.erasureExecution==="enabled"
        &&item.erasureProtocol==="enabled").length});
  }
  return {purpose:"issue-307-redacted-lambda-version-configuration-inventory",region,
    status:"BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW",functions,
    erasureExecutionReadyCount:functions.reduce((n,item)=>n+item.erasureExecutionReadyCount,0),
    environmentValuesOmitted:true,awsMutationsPerformed:false,
    replayBarrierMayBeEnabled:false,executableRecoveryMayBeEnabled:false};
}

export async function main(argv=process.argv.slice(2)) {
  const allowed=/^--(?:region|function|profile)=[A-Za-z0-9+=,.@_-]+$/;
  if(argv.some(arg=>!allowed.test(arg)&&!/^--expected-account=\d{12}$/.test(arg))
    ||!argv.some(arg=>arg.startsWith("--region="))
    ||!argv.some(arg=>arg.startsWith("--profile="))
    ||!argv.some(arg=>arg.startsWith("--expected-account=")))
    throw new Error("Usage: node scripts/audit-erasure-lambda-config.mjs --profile=<name> --expected-account=<12 digits> --region=eu-west-2 --function=<name> [--function=<name> ...]");
  const region=requiredOption(argv,"region"),profile=requiredOption(argv,"profile");
  const expectedAccount=requiredOption(argv,"expected-account");
  const functionNames=argv.filter(arg=>arg.startsWith("--function=")).map(arg=>arg.slice(11));
  if(!REGION.test(region)||!PROFILE.test(profile)||!ACCOUNT.test(expectedAccount))
    throw new Error("Invalid region, profile or expected account");
  const identity=JSON.parse(execFileSync("aws",["sts","get-caller-identity","--profile",profile,
    "--no-cli-pager","--output","json"],{encoding:"utf8",maxBuffer:1024*1024,
    env:{...process.env,AWS_RETRY_MODE:"standard",AWS_MAX_ATTEMPTS:"8"}}));
  const verifiedAccount=verifyExpectedAccount(identity,expectedAccount);
  // Bind SDK reads to the verified profile; ambient environment credentials must not override STS.
  const client=new LambdaClient({region,credentials:fromIni({profile}),maxAttempts:5});
  try {
    const report=await collectRuntimeConfigAudit(client,{functionNames,region});
    process.stdout.write(JSON.stringify({verifiedAccount,...report},null,2)+"\n");
    process.exitCode=2;
  } finally {client.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{process.stderr.write("Erasure Lambda config audit INCOMPLETE: "+error.message+"\n");process.exitCode=2;});
