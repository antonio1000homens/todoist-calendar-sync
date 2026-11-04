#!/usr/bin/env node
/**
 * Issue #307: read-only CloudWatch invocation metrics for inventoried Lambda
 * versions, aliases, alias-executed versions and unqualified functions.
 * Missing metric data is not proof that an invocation did not occur.
 */
import {execFileSync} from "node:child_process";
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const ACCOUNT=/^\d{12}$/;
const PROFILE=/^[A-Za-z0-9+=,.@_-]{1,128}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const MAX_DAYS=455;
const BATCH_SIZE=150;

function validateInventory(inventory,accountId) {
  if(!inventory||inventory.purpose!=="issue-307-read-only-qualified-lambda-inventory"
    ||inventory.status!=="BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT"
    ||inventory.verifiedAccount!==accountId||!Array.isArray(inventory.expectedFunctions)
    ||!inventory.expectedFunctions.length||!Array.isArray(inventory.missingExpected)
    ||inventory.missingExpected.length||!REGION.test(inventory.region)
    ||!Array.isArray(inventory.functions)||!inventory.functions.length)
    throw new Error("Complete same-account Lambda qualifier inventory is required");
  const names=new Set(inventory.functions.map(fn=>fn?.name));
  if(names.size!==inventory.functions.length||new Set(inventory.expectedFunctions).size!==inventory.expectedFunctions.length
    ||inventory.expectedFunctions.some(name=>!names.has(name)))
    throw new Error("Lambda inventory does not cover its expected function names");
}

export function buildInvocationMetricQueries(inventory,accountId,days=MAX_DAYS) {
  if(!ACCOUNT.test(accountId||""))throw new Error("Verified 12-digit AWS account is required");
  if(!Number.isSafeInteger(days)||days<1||days>MAX_DAYS)throw new Error("Metric window must be 1 through 455 days");
  validateInventory(inventory,accountId);
  const queries=[];
  const add=(functionName,resource,kind,qualifier,executedVersion)=>{
    const dimensions=[{Name:"FunctionName",Value:functionName},{Name:"Resource",Value:resource}];
    if(executedVersion)dimensions.push({Name:"ExecutedVersion",Value:executedVersion});
    const id=`m${queries.length.toString().padStart(4,"0")}`;
    queries.push({id,functionName,resource,kind,
      qualifier,executedVersion:executedVersion??null,
      query:{Id:id,Label:`${functionName}|${resource}|${executedVersion??""}`,
        MetricStat:{Metric:{Namespace:"AWS/Lambda",MetricName:"Invocations",Dimensions:dimensions},
          Period:86400,Stat:"Sum"},ReturnData:true}});
  };
  for(const fn of inventory.functions) {
    if(typeof fn?.name!=="string"||!Array.isArray(fn.versions)||!Array.isArray(fn.aliases))
      throw new Error("Lambda function qualifier inventory is malformed");
    const versions=new Set(fn.versions.map(version=>version?.qualifier));
    if(!versions.has("$LATEST")||versions.size!==fn.versions.length
      ||fn.versions.some(version=>typeof version?.qualifier!=="string"
        ||(version.qualifier!=="$LATEST"&&!/^[1-9]\d*$/.test(version.qualifier))))
      throw new Error("Lambda published version inventory is malformed");
    add(fn.name,fn.name,"unqualified","$LATEST");
    const published=[...versions].filter(version=>version!=="$LATEST");
    for(const version of published)add(fn.name,`${fn.name}:${version}`,"published_version",version);
    const aliases=new Set();
    for(const alias of fn.aliases) {
      if(typeof alias?.name!=="string"||!alias.name||aliases.has(alias.name)||!versions.has(alias.version)
        ||alias.version==="$LATEST"||!alias.additionalVersions||typeof alias.additionalVersions!=="object"
        ||Array.isArray(alias.additionalVersions))throw new Error("Lambda alias inventory is malformed");
      aliases.add(alias.name);
      for(const [version,weight] of Object.entries(alias.additionalVersions))
        if(!versions.has(version)||version==="$LATEST"||typeof weight!=="number"||!Number.isFinite(weight)||weight<0||weight>1)
          throw new Error("Weighted alias references an unknown version or has an invalid weight");
      const resource=`${fn.name}:${alias.name}`;
      add(fn.name,resource,"alias",alias.name);
      for(const version of published)add(fn.name,resource,"alias_executed_version",version,version);
    }
  }
  return queries.map(({query,...metadata})=>({...metadata,query}));
}

function option(argv,key,required=true) {
  const matches=argv.filter(arg=>arg.startsWith("--"+key+"="));
  if(matches.length>1||required&&matches.length!==1)throw new Error("Exactly one --"+key+"=... is required");
  return matches[0]?.slice(key.length+3);
}
function runAws(profile,args) {
  return JSON.parse(execFileSync("aws",[...args,"--profile",profile,"--no-cli-pager","--output","json"],{
    encoding:"utf8",maxBuffer:32*1024*1024,env:{...process.env,AWS_RETRY_MODE:"standard",AWS_MAX_ATTEMPTS:"8"},
  }));
}
function addResult(results,row) {
  const result=results.get(row.Id);
  if(!result)throw new Error("CloudWatch returned an unknown metric query ID");
  result.status=row.StatusCode??"UNKNOWN";
  result.messages.push(...(row.Messages??[]).map(item=>item.Value??item.Code??"CloudWatch returned a metric message"));
  const values=row.Values??[];
  result.recordedDatapoints+=values.length;
  result.sumInvocations+=values.reduce((sum,value)=>sum+value,0);
  const timestamps=row.Timestamps??[];
  if(timestamps.length) {
    const first=timestamps.reduce((left,right)=>left<right?left:right);
    const last=timestamps.reduce((left,right)=>left>right?left:right);
    result.firstDatapoint=result.firstDatapoint===null||first<result.firstDatapoint?first:result.firstDatapoint;
    result.lastDatapoint=result.lastDatapoint===null||last>result.lastDatapoint?last:result.lastDatapoint;
  }
}

export function collectMetricEvidence({profile,accountId,inventory,days=MAX_DAYS,run=runAws,now=new Date()}) {
  if(!PROFILE.test(profile||"")||!ACCOUNT.test(accountId||""))throw new Error("Explicit AWS profile and account are required");
  const queries=buildInvocationMetricQueries(inventory,accountId,days);
  const end=new Date(now);const start=new Date(end.getTime()-days*24*60*60*1000);
  const results=new Map(queries.map(item=>[item.query.Id,{status:null,messages:[],recordedDatapoints:0,
    sumInvocations:0,firstDatapoint:null,lastDatapoint:null}]));
  const tempDir=mkdtempSync(join(tmpdir(),"issue307-lambda-metrics-"));
  try {
    for(let offset=0;offset<queries.length;offset+=BATCH_SIZE) {
      const batch=queries.slice(offset,offset+BATCH_SIZE).map(item=>item.query);
      const requestFile=join(tempDir,`batch-${offset}.json`);
      writeFileSync(requestFile,JSON.stringify(batch),{mode:0o600});
      let nextToken;
      const seenTokens=new Set();
      do {
        const args=["cloudwatch","get-metric-data","--region",inventory.region,"--metric-data-queries",`file://${requestFile}`,
          "--start-time",start.toISOString(),"--end-time",end.toISOString(),"--max-datapoints","100000"];
        if(nextToken)args.push("--next-token",nextToken);
        const response=run(profile,args);
        if(!response||!Array.isArray(response.MetricDataResults))throw new Error("CloudWatch metric page is incomplete");
        for(const row of response.MetricDataResults)addResult(results,row);
        const token=response.NextToken;
        if(token!==undefined&&token!==null&&token!=="") {
          if(typeof token!=="string"||seenTokens.has(token))throw new Error("Repeated CloudWatch metric pagination token");
          seenTokens.add(token);nextToken=token;
        } else nextToken=undefined;
      } while(nextToken);
    }
  } finally { rmSync(tempDir,{recursive:true,force:true}); }
  const rows=queries.map(item=>({functionName:item.functionName,resource:item.resource,kind:item.kind,
    qualifier:item.qualifier,executedVersion:item.executedVersion,...results.get(item.query.Id),
    statuses:results.get(item.query.Id).status?[results.get(item.query.Id).status]:[]}));
  const incomplete=rows.filter(row=>row.statuses.length!==1||row.statuses[0]!=="Complete").length;
  return {purpose:"issue-307-qualified-lambda-invocation-metrics",status:"BLOCKED_METRIC_EVIDENCE_NOT_COMPLETE_AUDIT",
    verifiedAccount:accountId,region:inventory.region,windowDays:days,startTime:start.toISOString(),endTime:end.toISOString(),periodSeconds:86400,
    queryCount:rows.length,incompleteQueryCount:incomplete,results:rows,
    limitations:[
      "This report covers only the verified account, region, functions and qualifiers in the supplied Lambda snapshot",
      "A missing data point is not proof of non-invocation; metrics may be absent, expired, delayed or outside the query window",
      "Invocation metrics do not identify callers or distinguish a direct version invoke from an alias invoke unless ExecutedVersion dimensions are present",
      "No CloudTrail data-event, effective IAM, cross-account or legacy-resource conclusion is made",
      "This report cannot authorize policy changes, version retirement, replay release or executable recovery",
    ],replayBarrierMayBeEnabled:false,executableRecoveryMayBeEnabled:false};
}

export function main(argv=process.argv.slice(2)) {
  const allowed=new Set(["profile","expected-account","inventory","days"]);
  if(argv.some(arg=>!/^--[a-z-]+=[^\s]+$/.test(arg)||!allowed.has(arg.slice(2,arg.indexOf("=")))))
    throw new Error("Unknown or malformed audit option");
  const profile=option(argv,"profile"),accountId=option(argv,"expected-account"),inventoryPath=option(argv,"inventory"),daysValue=option(argv,"days",false);
  const days=daysValue===undefined?MAX_DAYS:Number(daysValue);
  if(!PROFILE.test(profile)||!ACCOUNT.test(accountId)||!Number.isSafeInteger(days)||days<1||days>MAX_DAYS)
    throw new Error("Invalid AWS profile, expected account or metric window");
  const identity=runAws(profile,["sts","get-caller-identity"]);
  if(identity.Account!==accountId)throw new Error("AWS profile account did not match --expected-account");
  const inventory=JSON.parse(readFileSync(inventoryPath,"utf8"));
  if(inventory.verifiedAccount!==identity.Account)throw new Error("Lambda inventory belongs to a different AWS account");
  const report=collectMetricEvidence({profile,accountId,inventory,days});
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.exitCode=2;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {main();} catch(error) {
    process.stderr.write("Lambda invocation metric audit INCOMPLETE: "+error.message+"\n");
    process.exitCode=2;
  }
}
