#!/usr/bin/env node
/**
 * Issue #307: READ-ONLY Lambda invoker/qualifier evidence collection.
 *
 * This is NOT an admission audit approval. Published versions can still be
 * invoked directly; resource policies do not reveal all identity-policy
 * permissions, external event rules, or other accounts/regions.
 *
 * No update, invoke, publish, queue or provider write operation is imported.
 */
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {
  LambdaClient, ListFunctionsCommand, ListVersionsByFunctionCommand,
  ListAliasesCommand, ListEventSourceMappingsCommand, GetPolicyCommand,
  GetFunctionUrlConfigCommand,
} from "@aws-sdk/client-lambda";

const NAME=/^[a-z0-9-]{2,64}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const MAX_PAGES=1000;

export function expectedTemplateFunctions(template,prefix,stage) {
  const start="$"+"{ResourceNamePrefix}-";
  const end="-"+"$"+"{Stage}";
  const names=new Set();
  for(const line of template.split(/\r?\n/)) {
    const marker="FunctionName: !Sub ";
    const trimmed=line.trim();
    if(!trimmed.startsWith(marker))continue;
    const value=trimmed.slice(marker.length).trim().replace(/^["']|["']$/g,"");
    if(value.startsWith(start)&&value.endsWith(end)) {
      const suffix=value.slice(start.length,-end.length);
      if(!NAME.test(suffix))throw new Error("Unexpected templated Lambda function suffix");
      names.add(prefix+"-"+suffix+"-"+stage);
    }
  }
  if(names.size===0)throw new Error("No deployed Lambda names identified in template; cannot audit");
  return [...names].sort();
}

export async function pages(client,Command,key,inputs={}) {
  const output=[];
  const seen=new Set();
  let marker;
  for(let page=0;page<MAX_PAGES;page++) {
    const response=await client.send(new Command({...inputs,...(marker?{Marker:marker}:{})}));
    if(!response||!Array.isArray(response[key]))throw new Error("Missing Lambda "+key+" page; incomplete inventory");
    output.push(...response[key]);
    const next=response.NextMarker;
    if(next===undefined||next===null||next==="")return output;
    if(typeof next!=="string"||seen.has(next))throw new Error("Repeated/invalid Lambda pagination marker");
    seen.add(next);
    marker=next;
  }
  throw new Error("Lambda pagination exceeded limit; incomplete inventory");
}

async function policySummary(client,name,qualifier) {
  try {
    const input={FunctionName:name,...(qualifier?{Qualifier:qualifier}:{})};
    const response=await client.send(new GetPolicyCommand(input));
    if(typeof response.Policy!=="string")throw new Error("Missing Lambda invocation policy body");
    const parsed=JSON.parse(response.Policy);
    const statements=Array.isArray(parsed.Statement)?parsed.Statement:
      parsed.Statement?[parsed.Statement]:[];
    return {statementCount:statements.length,
      wildcardPrincipalPresent:statements.some(s=>s.Principal==="*"||
        s.Principal?.AWS==="*"||
        (Array.isArray(s.Principal?.AWS)&&s.Principal.AWS.includes("*")))};
  } catch(error) {
    if(error?.name==="ResourceNotFoundException")return {statementCount:0,wildcardPrincipalPresent:false};
    throw error;
  }
}

async function functionUrlSummary(client,name,qualifier) {
  try {
    const result=await client.send(new GetFunctionUrlConfigCommand({
      FunctionName:name,...(qualifier?{Qualifier:qualifier}:{})}));
    return {authType:result.AuthType??"UNKNOWN",invokeMode:result.InvokeMode??"UNKNOWN"};
  } catch(error) {
    if(error?.name==="ResourceNotFoundException")return null;
    throw error;
  }
}

function sourceService(arn) {
  if(!arn)return "unknown";
  const pieces=arn.split(":");
  return pieces.length>2?pieces[2]:"unknown";
}

export async function collectLambdaInventory(client,{prefix,stage,expected=[]}) {
  if(!NAME.test(prefix)||!NAME.test(stage))throw new Error("Explicit valid prefix/stage are required");
  if(!Array.isArray(expected)||expected.some(n=>typeof n!=="string"))
    throw new Error("Expected Lambda name list is required");

  // Enumerate the whole region's mappings, including qualified targets.
  // Filtering ListEventSourceMappings by unqualified function may miss aliases.
  const [allFunctions,allMappings]=await Promise.all([
    pages(client,ListFunctionsCommand,"Functions"),
    pages(client,ListEventSourceMappingsCommand,"EventSourceMappings"),
  ]);
  const functions=allFunctions.filter(f=>typeof f.FunctionName==="string"&&
    f.FunctionName.startsWith(prefix+"-")&&f.FunctionName.endsWith("-"+stage))
    .sort((a,b)=>a.FunctionName.localeCompare(b.FunctionName));
  const names=new Set(functions.map(f=>f.FunctionName));
  const missingExpected=expected.filter(name=>!names.has(name));
  const inventory=[];
  for(const f of functions) {
    if(typeof f.FunctionArn!=="string"||!f.FunctionArn.includes(":function:"))
      throw new Error("Lambda function ARN unavailable: "+f.FunctionName);
    const [versions,aliases]=await Promise.all([
      pages(client,ListVersionsByFunctionCommand,"Versions",{FunctionName:f.FunctionName}),
      pages(client,ListAliasesCommand,"Aliases",{FunctionName:f.FunctionName}),
    ]);
    if(!versions.length||!versions.some(v=>v.Version==="$LATEST"))
      throw new Error("Missing current Lambda version: "+f.FunctionName);

    const targets=allMappings.filter(m=>
      m.FunctionArn===f.FunctionArn||
      (typeof m.FunctionArn==="string"&&m.FunctionArn.startsWith(f.FunctionArn+":")));
    const qualifierNames=[...new Set([
      ...versions.map(v=>v.Version).filter(v=>v&&v!=="$LATEST"),
      ...aliases.map(a=>a.Name).filter(Boolean),
    ])].sort();
    const policies={unqualified:await policySummary(client,f.FunctionName)};
    for(const qualifier of qualifierNames) {
      policies[qualifier]=await policySummary(client,f.FunctionName,qualifier);
    }
    const urls={unqualified:await functionUrlSummary(client,f.FunctionName)};
    for(const alias of aliases) {
      if(!alias.Name)throw new Error("Alias with no name: "+f.FunctionName);
      urls[alias.Name]=await functionUrlSummary(client,f.FunctionName,alias.Name);
    }
    inventory.push({
      name:f.FunctionName,
      versions:versions.map(v=>({
        qualifier:v.Version??"UNKNOWN",codeSha256:v.CodeSha256??null,
        lastModified:v.LastModified??null,runtime:v.Runtime??null,
      })),
      aliases:aliases.map(a=>({
        name:a.Name??"UNKNOWN",version:a.FunctionVersion??"UNKNOWN",
        additionalVersions:a.RoutingConfig?.AdditionalVersionWeights??{},
      })),
      eventSourceMappings:targets.map(m=>({
        qualifier:m.FunctionArn===f.FunctionArn?"unqualified":
          m.FunctionArn.slice(f.FunctionArn.length+1),
        state:m.State??"UNKNOWN",sourceService:sourceService(m.EventSourceArn),
      })),
      policies,urls,
      // IAM identity policies, legacy functions and direct invocations are not
      // established by these read-only Lambda APIs.
      approvedForReplayRelease:false,
    });
  }
  return {
    purpose:"issue-307-read-only-qualified-lambda-inventory",
    status:"BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT",
    prefix,stage,
    expectedFunctions:expected,
    missingExpected,
    functions:inventory,
    unverifiedRequirements:[
      "Review admission code for EVERY returned version, including old published versions",
      "Review all IAM identity-based invokers, schedules, external accounts and Lambda resource policies",
      "Repeat inventory across all deployed regions/accounts and nonstandard/legacy prefixes",
      "Prove SQS/DLQ, webhook, recurrence and cross-profile lease/barrier ordering",
      "Approve privacy/HMAC key retention, all-profile alias evidence and Work-profile fault injection",
    ],
    replayBarrierMayBeEnabled:false,
    executableRecoveryMayBeEnabled:false,
  };
}

function option(argv,key) {
  const matches=argv.filter(arg=>arg.startsWith("--"+key+"="));
  if(matches.length!==1)throw new Error("Exactly one --"+key+"=... is required");
  return matches[0].slice(key.length+3);
}

export async function main(argv=process.argv.slice(2)) {
  if(argv.some(arg=>!/^--(?:prefix|stage|region)=[A-Za-z0-9-]+$/.test(arg))||
    argv.length!==3)throw new Error("Usage: node scripts/audit-erasure-lambda-invokers.mjs --prefix=... --stage=... --region=...");
  const prefix=option(argv,"prefix"),stage=option(argv,"stage"),region=option(argv,"region");
  if(!NAME.test(prefix)||!NAME.test(stage)||!REGION.test(region))
    throw new Error("Invalid region/prefix/stage");
  const template=readFileSync(new URL("../template.yaml",import.meta.url),"utf8");
  const expected=expectedTemplateFunctions(template,prefix,stage);
  const client=new LambdaClient({region,maxAttempts:5});
  try {
    const report=await collectLambdaInventory(client,{prefix,stage,expected});
    process.stdout.write(JSON.stringify({region,...report},null,2)+"\n");
    // Inventory is never proof of safe erasure or authorisation to release.
    // Non-zero by design: fail closed for automation/CI consumers.
    process.exitCode=2;
  } finally {
    client.destroy();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    process.stderr.write("Erasure writer inventory INCOMPLETE: "+error.message+"\n");
    process.exitCode=2;
  });
}
