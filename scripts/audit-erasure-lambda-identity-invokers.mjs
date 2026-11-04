#!/usr/bin/env node
/**
 * Issue #307: read-only candidate inventory for IAM identity policies that
 * could invoke a qualified Lambda version or alias from a supplied snapshot.
 * This is not an effective-permission evaluator or approval to deny access.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

const ACCOUNT=/^\d{12}$/;
const NAME=/^[A-Za-z0-9+=,.@_-]{1,128}$/;
const RELEVANT_ACTIONS=["lambda:InvokeFunction","lambda:InvokeFunctionUrl","lambda:InvokeAsync"];

function asArray(value) { return value===undefined||value===null?[]:Array.isArray(value)?value:[value]; }
function globRegex(pattern,insensitive=false) {
  const variableSafe=String(pattern).replace(/\$\{[^}]+\}/g,"*");
  const escaped=variableSafe.replace(/[.+^${}()|[\]\\]/g,"\\$&").replaceAll("*",".*").replaceAll("?",".");
  return new RegExp("^"+escaped+"$",insensitive?"i":"");
}
function matchesAny(patterns,value,insensitive=false) {
  return patterns.some(pattern=>typeof pattern==="string"&&globRegex(pattern,insensitive).test(value));
}
function targetArns(inventory,account,partition="aws") {
  if(!inventory||inventory.purpose!=="issue-307-read-only-qualified-lambda-inventory"
    ||inventory.status!=="BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT"
    ||!Array.isArray(inventory.expectedFunctions)||!inventory.expectedFunctions.length
    ||!Array.isArray(inventory.missingExpected)||inventory.missingExpected.length
    ||typeof inventory.region!=="string"||!/^([a-z]{2}(?:-gov)?-[a-z]+-\d+)$/.test(inventory.region)
    ||!Array.isArray(inventory.functions)||!inventory.functions.length)
    throw new Error("A complete Lambda qualifier inventory is required");
  const names=new Set(inventory.functions.map(fn=>fn?.name));
  if(names.size!==inventory.functions.length||inventory.expectedFunctions.some(name=>!names.has(name)))
    throw new Error("Lambda qualifier inventory does not match expected function names");
  const targets=[];
  for(const fn of inventory.functions) {
    if(typeof fn?.name!=="string"||!Array.isArray(fn.versions)||!Array.isArray(fn.aliases))
      throw new Error("Incomplete Lambda qualifier inventory");
    const versions=new Set(fn.versions.map(version=>version?.qualifier));
    if(versions.size!==fn.versions.length||!versions.has("$LATEST")
      ||fn.versions.some(version=>typeof version?.qualifier!=="string"
        ||(version.qualifier!=="$LATEST"&&!/^[1-9]\d*$/.test(version.qualifier))))
      throw new Error("Lambda version inventory is malformed or incomplete");
    const base=`arn:${partition}:lambda:${inventory.region}:${account}:function:${fn.name}`;
    targets.push({arn:base,functionName:fn.name,qualifier:"unqualified"});
    for(const version of fn.versions) {
      if(typeof version?.qualifier!=="string"||version.qualifier==="$LATEST")continue;
      targets.push({arn:`${base}:${version.qualifier}`,functionName:fn.name,qualifier:version.qualifier});
    }
    for(const alias of fn.aliases) {
      if(typeof alias?.name!=="string"||!alias.name||typeof alias.version!=="string"
        ||!versions.has(alias.version)||alias.version==="$LATEST"||!alias.additionalVersions
        ||typeof alias.additionalVersions!=="object"||Array.isArray(alias.additionalVersions))
        throw new Error("Malformed Lambda alias inventory");
      targets.push({arn:`${base}:${alias.name}`,functionName:fn.name,qualifier:alias.name});
      for(const version of Object.keys(alias.additionalVersions))if(!versions.has(version)||version==="$LATEST")
        throw new Error("Weighted alias references an unknown published version");
    }
  }
  return targets;
}

function policyStatements(document) {
  let parsed=document;
  if(typeof parsed==="string") {
    try { parsed=JSON.parse(parsed); }
    catch { try { parsed=JSON.parse(decodeURIComponent(parsed)); } catch { throw new Error("Invalid IAM policy document"); } }
  }
  if(!parsed||Array.isArray(parsed)||typeof parsed!=="object"||!Object.hasOwn(parsed,"Statement"))
    throw new Error("IAM policy document has no Statement");
  const statements=asArray(parsed.Statement);
  if(!statements.length||statements.some(statement=>!statement||Array.isArray(statement)||typeof statement!=="object"))
    throw new Error("IAM policy contains a malformed statement");
  return statements;
}

function policyPatterns(value,label) {
  const values=asArray(value);
  if(!values.length||values.some(item=>typeof item!=="string"||item.length===0))
    throw new Error("IAM policy contains malformed "+label+" values");
  return values;
}

function actionMayInvoke(statement,action) {
  if(Object.hasOwn(statement,"Action"))return matchesAny(policyPatterns(statement.Action,"Action"),action,true);
  if(Object.hasOwn(statement,"NotAction"))return !matchesAny(policyPatterns(statement.NotAction,"NotAction"),action,true);
  // A malformed Allow without Action is not valid IAM, but keep the audit
  // conservative instead of claiming the candidate is absent.
  return true;
}

function resourceMatches(statement,targetArn) {
  if(Object.hasOwn(statement,"NotResource"))return !matchesAny(policyPatterns(statement.NotResource,"NotResource"),targetArn);
  if(Object.hasOwn(statement,"Resource"))return matchesAny(policyPatterns(statement.Resource,"Resource"),targetArn);
  return true;
}

export function findLambdaInvocationCandidates({inventory,accountId,partition="aws",authorization}) {
  if(!ACCOUNT.test(accountId||""))throw new Error("A verified 12-digit AWS account is required");
  if(typeof partition!=="string"||!/^aws(?:-[a-z0-9-]+)?$/.test(partition))throw new Error("Invalid AWS partition");
  const targets=targetArns(inventory,accountId,partition);
  if(!authorization||!Array.isArray(authorization.Users)||!Array.isArray(authorization.Roles)
    ||!Array.isArray(authorization.Groups)||!Array.isArray(authorization.Policies))
    throw new Error("IAM authorization inventory is incomplete");
  const managed=new Map();
  for(const policy of authorization.Policies) {
    if(typeof policy?.Arn!=="string")continue;
    const versions=asArray(policy.PolicyVersionList);
    const version=versions.find(item=>item?.IsDefaultVersion===true);
    if(version?.Document!==undefined)managed.set(policy.Arn,version.Document);
    else if(policy.PolicyDocument!==undefined)managed.set(policy.Arn,policy.PolicyDocument);
  }
  const principals=[
    ...authorization.Users.map(item=>({type:"user",item})),
    ...authorization.Roles.map(item=>({type:"role",item})),
    ...authorization.Groups.map(item=>({type:"group",item})),
  ];
  const candidates=[];
  const missingManagedDocuments=[];
  for(const {type,item} of principals) {
    const principalName=type==="user"?item.UserName:type==="role"?item.RoleName:item.GroupName;
    if(typeof principalName!=="string"||!principalName)throw new Error("IAM identity inventory contains an invalid principal");
    const boundary=item.PermissionsBoundary;
    const policies=[];
    for(const inline of asArray(item.UserPolicyList||item.RolePolicyList||item.GroupPolicyList)) {
      if(typeof inline?.PolicyName!=="string"||inline.PolicyDocument===undefined)
        throw new Error("IAM inline policy inventory is incomplete for a principal");
      policies.push({name:inline.PolicyName,arn:null,source:"inline",document:inline.PolicyDocument});
    }
    for(const attached of asArray(item.AttachedManagedPolicies)) {
      if(typeof attached?.PolicyArn!=="string")throw new Error("IAM managed policy attachment is malformed");
      const document=managed.get(attached.PolicyArn);
      if(document===undefined) {
        missingManagedDocuments.push({principalType:type,principalName,policyArn:attached.PolicyArn});
        continue;
      }
      policies.push({name:attached.PolicyName||attached.PolicyArn,arn:attached.PolicyArn,source:"managed",document});
    }
    for(const policy of policies)for(const statement of policyStatements(policy.document)) {
      if(statement.Effect!=="Allow")continue;
      const actions=RELEVANT_ACTIONS.filter(action=>actionMayInvoke(statement,action));
      if(!actions.length)continue;
      const matched=targets.filter(target=>resourceMatches(statement,target.arn));
      if(!matched.length)continue;
      candidates.push({principalType:type,principalName,principalArn:item.Arn||null,
        groupMemberships:type==="user"?asArray(item.GroupList):[],
        policyName:policy.name,policyArn:policy.arn,policySource:policy.source,
        actions,matchedFunctionCount:new Set(matched.map(target=>target.functionName)).size,
        matchedQualifierCount:matched.length,unqualifiedPossible:matched.some(target=>target.qualifier==="unqualified"),
        qualifiedPossible:matched.some(target=>target.qualifier!=="unqualified"),
        conditionPresent:statement.Condition!==undefined,notActionStatement:statement.NotAction!==undefined,
        notResourceStatement:statement.NotResource!==undefined,permissionBoundaryPresent:boundary!==undefined});
    }
  }
  candidates.sort((a,b)=>a.principalType.localeCompare(b.principalType)||a.principalName.localeCompare(b.principalName)
    ||a.policyName.localeCompare(b.policyName)||a.actions.join(",").localeCompare(b.actions.join(",")));
  return {purpose:"issue-307-iam-identity-invocation-candidates",status:"BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF",
    accountId,region:inventory.region,principalCount:principals.length,candidateGrantCount:candidates.length,
    missingManagedDocumentCount:missingManagedDocuments.length,missingManagedDocuments,candidates,
    unverifiedRequirements:[
      "Organizations SCPs and resource control policies were not evaluated",
      "Permission boundaries, session policies, trust policies and explicit denies were not evaluated as a combined decision",
      "Resource-based policies, cross-account principals and external credentials require separate review",
      "Lambda inventory and IAM authorization documents are separate reads and are not one atomic snapshot",
      "A candidate Allow does not prove an identity can assume the principal or that a request is allowed",
      "No denial, detachment, version deletion or replay-release authorization is produced",
    ],replayBarrierMayBeEnabled:false,executableRecoveryMayBeEnabled:false};
}

function option(argv,key) {
  const matches=argv.filter(arg=>arg.startsWith("--"+key+"="));
  if(matches.length!==1)throw new Error("Exactly one --"+key+"=... is required");
  return matches[0].slice(key.length+3);
}
function runAws(profile,args) {
  return JSON.parse(execFileSync("aws",[...args,"--profile",profile,"--no-cli-pager","--output","json"],{
    encoding:"utf8",maxBuffer:64*1024*1024,
    env:{...process.env,AWS_RETRY_MODE:"standard",AWS_MAX_ATTEMPTS:"8"},
  }));
}
function loadManagedPolicyDocuments(profile,authorization) {
  const attachments=new Set();
  for(const collection of [authorization.Users,authorization.Roles,authorization.Groups])for(const principal of collection||[])
    for(const policy of asArray(principal.AttachedManagedPolicies))if(typeof policy?.PolicyArn==="string")attachments.add(policy.PolicyArn);
  const docs=new Map(asArray(authorization.Policies).flatMap(policy=>{
    if(typeof policy?.Arn!=="string")return [];
    const version=asArray(policy.PolicyVersionList).find(item=>item?.IsDefaultVersion===true);
    const document=version?.Document??policy.PolicyDocument;
    return document===undefined?[]:[[policy.Arn,document]];
  }));
  for(const arn of attachments)if(!docs.has(arn)) {
    const policy=runAws(profile,["iam","get-policy","--policy-arn",arn]).Policy;
    if(typeof policy?.DefaultVersionId!=="string")throw new Error("Managed policy default version is unavailable");
    const version=runAws(profile,["iam","get-policy-version","--policy-arn",arn,"--version-id",policy.DefaultVersionId]);
    if(version.PolicyVersion?.Document===undefined)throw new Error("Managed policy document is unavailable");
    docs.set(arn,version.PolicyVersion.Document);
  }
  return docs;
}

export function main(argv=process.argv.slice(2)) {
  if(argv.some(arg=>!/^--(?:profile|expected-account|inventory)=[^\s]+$/.test(arg))||argv.length!==3)
    throw new Error("Usage: node scripts/audit-erasure-lambda-identity-invokers.mjs --profile=<name> --expected-account=<12 digits> --inventory=<lambda-inventory.json>");
  const profile=option(argv,"profile"),expectedAccount=option(argv,"expected-account"),inventoryPath=option(argv,"inventory");
  if(!NAME.test(profile)||!ACCOUNT.test(expectedAccount))throw new Error("Invalid profile or expected account");
  const identity=runAws(profile,["sts","get-caller-identity"]);
  if(identity.Account!==expectedAccount)throw new Error("AWS profile account did not match --expected-account");
  const inventory=JSON.parse(readFileSync(inventoryPath,"utf8"));
  const rawAuthorization=runAws(profile,["iam","get-account-authorization-details"]);
  const authorization={Users:rawAuthorization.UserDetailList,Roles:rawAuthorization.RoleDetailList,
    Groups:rawAuthorization.GroupDetailList,Policies:rawAuthorization.Policies};
  if(!Array.isArray(authorization.Users)||!Array.isArray(authorization.Roles)
    ||!Array.isArray(authorization.Groups)||!Array.isArray(authorization.Policies))
    throw new Error("IAM authorization response is incomplete");
  const policyDocuments=loadManagedPolicyDocuments(profile,authorization);
  const summary=findLambdaInvocationCandidates({inventory,accountId:identity.Account,
    partition:typeof identity.Arn==="string"?identity.Arn.split(":")[1]:"aws",
    authorization:{...authorization,Policies:[...policyDocuments].map(([Arn,PolicyDocument])=>({Arn,PolicyDocument}))}});
  process.stdout.write(JSON.stringify({verifiedAccount:identity.Account,...summary},null,2)+"\n");
  // Identity policy candidates cannot establish effective access or approval.
  process.exitCode=2;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {main();} catch(error) {
    process.stderr.write("IAM identity invocation audit INCOMPLETE: "+error.message+"\n");
    process.exitCode=2;
  }
}
