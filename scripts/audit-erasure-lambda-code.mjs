#!/usr/bin/env node
/**
 * Read-only static marker inventory for deployed Lambda code packages.
 * This verifies AWS CodeSha256 against each downloaded package and reports
 * recognizable replay-barrier implementation strings. It is not proof that
 * a marker check dominates every mutation call, IAM invokability is safe, or
 * any version is approved for replay release.
 */
import {createHash} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {GetFunctionCommand,LambdaClient,ListVersionsByFunctionCommand} from "@aws-sdk/client-lambda";

const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const FUNCTION=/^[A-Za-z0-9_-]{2,64}$/;
const MAX_PACKAGE_BYTES=50_000_000;
const MAX_JS_BYTES=30_000_000;
const MARKERS={
  replayGate:"ERASURE_REPLAY_BARRIER_VERSION",
  markerKey:"ERASURE_REPLAY#",
  hmacKeyring:"ERASURE_REPLAY_HMAC_KEYS",
  ingressUnavailable:"replay_admission_unavailable",
  ingressSuppressed:"erased_webhook_suppressed",
  fencedReview:"reviewed_fenced",
};

function option(argv,name) {
  const matches=argv.filter(arg=>arg.startsWith(`--${name}=`));
  if(matches.length!==1)throw new Error(`Exactly one --${name}=... is required`);
  return matches[0].slice(name.length+3);
}
function run(command,args,options={}) {
  const result=spawnSync(command,args,{encoding:null,maxBuffer:MAX_PACKAGE_BYTES*2,...options});
  if(result.error||result.status!==0)throw new Error(`${command} failed during code audit`);
  return result.stdout;
}
async function listVersions(client,functionName) {
  const versions=[];let marker;const seen=new Set();
  for(let page=0;page<1000;page++) {
    const response=await client.send(new ListVersionsByFunctionCommand({FunctionName:functionName,...(marker?{Marker:marker}:{})}));
    if(!Array.isArray(response.Versions))throw new Error(`Missing Lambda version page for ${functionName}`);
    versions.push(...response.Versions);
    const next=response.NextMarker;
    if(!next)return versions;
    if(typeof next!=="string"||seen.has(next))throw new Error(`Repeated Lambda version marker for ${functionName}`);
    seen.add(next);marker=next;
  }
  throw new Error(`Lambda version paging exceeded limit for ${functionName}`);
}
function jsSource(zipPath) {
  const listing=run("unzip",["-Z1",zipPath]).toString("utf8").split(/\r?\n/).filter(Boolean);
  const jsFiles=listing.filter(name=>name.endsWith(".js"));
  if(jsFiles.length===0)throw new Error("Lambda code archive contains no JavaScript bundle");
  const chunks=[];
  for(const name of jsFiles) {
    const output=run("unzip",["-p",zipPath,name]);
    if(output.length>MAX_JS_BYTES)throw new Error("Lambda JavaScript bundle exceeds audit limit");
    chunks.push(output);
  }
  return Buffer.concat(chunks);
}
async function inspectDigest(client,functionName,versions,tempDirectory) {
  const hash=versions[0].CodeSha256;
  if(typeof hash!=="string"||!hash)throw new Error(`CodeSha256 missing for ${functionName}`);
  const representative=[...versions].sort((a,b)=>{
    const av=a.Version==="$LATEST"?Number.MAX_SAFE_INTEGER:Number(a.Version);
    const bv=b.Version==="$LATEST"?Number.MAX_SAFE_INTEGER:Number(b.Version);
    return bv-av;
  })[0];
  const deployment=await client.send(new GetFunctionCommand({FunctionName:functionName,Qualifier:representative.Version}));
  if(deployment.Configuration?.CodeSha256!==hash||typeof deployment.Code?.Location!=="string")
    throw new Error(`Lambda package metadata changed for ${functionName}:${representative.Version}`);
  const response=await fetch(deployment.Code.Location,{redirect:"follow"});
  if(!response.ok)throw new Error(`Lambda package download failed for ${functionName}:${representative.Version}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length===0||bytes.length>MAX_PACKAGE_BYTES)throw new Error(`Lambda package size invalid for ${functionName}`);
  const actual=createHash("sha256").update(bytes).digest("base64");
  if(actual!==hash)throw new Error(`Downloaded Lambda package digest mismatch for ${functionName}:${representative.Version}`);
  const zipPath=path.join(tempDirectory,`${createHash("sha256").update(functionName+hash).digest("hex")}.zip`);
  await writeFile(zipPath,bytes,{mode:0o600,flag:"wx"});
  const source=jsSource(zipPath);
  await rm(zipPath,{force:true});
  return {codeSha256:hash,versions:versions.map(item=>item.Version).sort((a,b)=>
    a==="$LATEST"?1:b==="$LATEST"?-1:Number(a)-Number(b)),packageBytes:bytes.length,
    markerStrings:Object.fromEntries(Object.entries(MARKERS).map(([key,value])=>[key,source.includes(value)]))};
}

export async function collectCodeAudit(client,{functionNames,region}) {
  if(!REGION.test(region)||!Array.isArray(functionNames)||!functionNames.length
    ||functionNames.some(name=>typeof name!=="string"||!FUNCTION.test(name)))
    throw new Error("Explicit valid region and Lambda function names are required");
  const tempDirectory=await mkdtemp(path.join(tmpdir(),"todoist-erasure-lambda-code-"));
  try {
    const functions=[];
    for(const functionName of [...new Set(functionNames)].sort()) {
      const versions=await listVersions(client,functionName);
      if(!versions.length||!versions.some(item=>item.Version==="$LATEST"))
        throw new Error(`Incomplete Lambda version inventory for ${functionName}`);
      const byHash=new Map();
      for(const version of versions) {
        if(typeof version.CodeSha256!=="string")throw new Error(`Missing code digest for ${functionName}:${version.Version}`);
        const grouped=byHash.get(version.CodeSha256)||[];grouped.push(version);byHash.set(version.CodeSha256,grouped);
      }
      const digests=[];
      for(const grouped of byHash.values())digests.push(await inspectDigest(client,functionName,grouped,tempDirectory));
      functions.push({functionName,versionCount:versions.length,publishedVersionCount:versions.filter(v=>v.Version!=="$LATEST"&&v.Version!=="1").length,
        uniqueCodeDigestCount:digests.length,verifiedPackageCount:digests.length,
        verifiedPackageBytes:digests.reduce((sum,item)=>sum+item.packageBytes,0),digests});
    }
    return {purpose:"issue-307-read-only-lambda-code-digest-and-marker-inventory",region,
      status:"BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW",functions,
      explicitLimitations:[
        "Marker strings are not proof that checks dominate every provider or DynamoDB mutation",
        "No IAM, resource policy, alias, rollback, cross-account, legacy-name or other-region approval is inferred",
        "No Lambda environment values or presigned package URLs are returned",
        "This command performs no AWS mutation, invocation, queue operation or provider write",
      ],replayBarrierMayBeEnabled:false,executableRecoveryMayBeEnabled:false};
  } finally { await rm(tempDirectory,{recursive:true,force:true}); }
}

export async function main(argv=process.argv.slice(2)) {
  const allowed=/^--(?:region|function)=[A-Za-z0-9_-]+$/;
  if(argv.some(arg=>!allowed.test(arg))||!argv.some(arg=>arg.startsWith("--region=")))
    throw new Error("Usage: node scripts/audit-erasure-lambda-code.mjs --region=eu-west-2 --function=ingress-production --function=review-api-production");
  const region=option(argv,"region"),functionNames=argv.filter(arg=>arg.startsWith("--function=")).map(arg=>arg.slice(11));
  const client=new LambdaClient({region,maxAttempts:5});
  try {
    const report=await collectCodeAudit(client,{functionNames,region});
    process.stdout.write(JSON.stringify(report,null,2)+"\n");
    process.exitCode=2;
  } finally {client.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{process.stderr.write("Erasure Lambda code audit INCOMPLETE: "+error.message+"\n");process.exitCode=2;});
