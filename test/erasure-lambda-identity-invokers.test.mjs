import test from "node:test";
import assert from "node:assert/strict";
import {findLambdaInvocationCandidates} from "../scripts/audit-erasure-lambda-identity-invokers.mjs";

const accountId="123456789012";
const inventory={purpose:"issue-307-read-only-qualified-lambda-inventory",
  status:"BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT",region:"eu-west-2",
  verifiedAccount:accountId,
  expectedFunctions:["todoist-calendar-sync-review-api-production"],missingExpected:[],
  functions:[{name:"todoist-calendar-sync-review-api-production",
    versions:[{qualifier:"$LATEST"},{qualifier:"8"},{qualifier:"9"}],
    aliases:[{name:"live",version:"9",additionalVersions:{}}]}]};
const base=`arn:aws:lambda:eu-west-2:${accountId}:function:todoist-calendar-sync-review-api-production`;
function authorization({users=[],roles=[],groups=[],policies=[]}={}) {
  return {Users:users,Roles:roles,Groups:groups,Policies:policies};
}
function policy(Statement) { return {PolicyDocument:{Version:"2012-10-17",Statement}}; }

test("reports possible direct and group identity grants without calling them effective permissions",()=>{
  const result=findLambdaInvocationCandidates({inventory,accountId,authorization:authorization({
    users:[{UserName:"automation",Arn:`arn:aws:iam::${accountId}:user/automation`,GroupList:["operators"],
      UserPolicyList:[{PolicyName:"version-only",...policy({Effect:"Allow",Action:"lambda:InvokeFunction",Resource:`${base}:8`})}]}],
    roles:[{RoleName:"admin-role",Arn:`arn:aws:iam::${accountId}:role/admin-role`,PermissionsBoundary:{PermissionsBoundaryArn:"arn:aws:iam::123456789012:policy/boundary"},
      AssumeRolePolicyDocument:{Version:"2012-10-17",Statement:[
        {Effect:"Allow",Principal:{AWS:"arn:aws:iam::999999999999:root"},Action:"sts:AssumeRole",
          Condition:{StringEquals:{"aws:PrincipalOrgID":"o-example"}}},
        {Effect:"Allow",Principal:{Service:"lambda.amazonaws.com"},Action:"sts:AssumeRole",
          Condition:{ArnLike:{"aws:SourceArn":"arn:aws:lambda:eu-west-2:123456789012:function:*"},
            StringEquals:{"aws:SourceAccount":accountId}}},
      ]},
      AttachedManagedPolicies:[{PolicyName:"Admin",PolicyArn:`arn:aws:iam::${accountId}:policy/Admin`}]}],
    groups:[{GroupName:"operators",GroupPolicyList:[{PolicyName:"group-invoke",...policy({Effect:"Allow",Action:"lambda:*",Resource:"*"})}]}],
    policies:[{Arn:`arn:aws:iam::${accountId}:policy/Admin`,PolicyDocument:{Statement:{Effect:"Allow",Action:"*",Resource:"*"}}}],
  })});
  assert.equal(result.status,"BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF");
  assert.equal(result.replayBarrierMayBeEnabled,false);
  assert.equal(result.executableRecoveryMayBeEnabled,false);
  const role=result.candidates.find(item=>item.principalName==="admin-role");
  assert.equal(role.qualifiedPossible,true);
  assert.equal(role.permissionBoundaryPresent,true);
  assert.equal(role.assumeRoleTrust.status,"SUMMARY_ONLY");
  assert.equal(role.assumeRoleTrust.externalAwsPrincipalCount,1);
  assert.equal(role.assumeRoleTrust.servicePrincipalCount,1);
  assert.equal(role.assumeRoleTrust.sourceAccountConditionPresent,true);
  assert.equal(role.assumeRoleTrust.sourceArnConditionPresent,true);
  assert.equal(role.assumeRoleTrust.principalOrgConditionPresent,true);
  assert.equal(result.roleTrustSummary.observedRoleCount,1);
  assert.equal(result.roleTrustSummary.externalAwsPrincipalCount,1);
  const exact=result.candidates.find(item=>item.policyName==="version-only");
  assert.equal(exact.qualifiedPossible,true);
  assert.equal(exact.unqualifiedPossible,false);
  const group=result.candidates.find(item=>item.principalType==="group");
  assert.equal(group.qualifiedPossible,true);
  assert.equal(group.principalName,"operators");
  assert.equal(JSON.stringify(result).includes('"Effect"'),false);
  assert.equal(result.unverifiedRequirements.some(item=>item.includes("Organizations SCPs")),true);
});

test("tracks unqualified-only resources and evaluates NotAction conservatively",()=>{
  const result=findLambdaInvocationCandidates({inventory,accountId,authorization:authorization({users:[
    {UserName:"unqualified-only",UserPolicyList:[{PolicyName:"base",...policy({Effect:"Allow",Action:"lambda:InvokeFunction",Resource:base})}]},
    {UserName:"except-one-action",UserPolicyList:[{PolicyName:"not-action",...policy({Effect:"Allow",NotAction:"lambda:InvokeFunction",Resource:"*"})}]},
    {UserName:"except-every-invoke",UserPolicyList:[{PolicyName:"excluded",...policy({Effect:"Allow",NotAction:"lambda:*",Resource:"*"})}]},
  ]})});
  const unqualified=result.candidates.find(item=>item.principalName==="unqualified-only");
  assert.equal(unqualified.unqualifiedPossible,true);
  assert.equal(unqualified.qualifiedPossible,false);
  const excluded=result.candidates.find(item=>item.principalName==="except-one-action");
  assert.deepEqual(excluded.actions,["lambda:InvokeFunctionUrl","lambda:InvokeAsync"]);
  assert.equal(excluded.notActionStatement,true);
  assert.equal(result.candidates.some(item=>item.principalName==="except-every-invoke"),false);
});

test("conditions and NotResource remain candidates, and policy variables are treated as wildcards",()=>{
  const result=findLambdaInvocationCandidates({inventory,accountId,authorization:authorization({users:[
    {UserName:"conditional",UserPolicyList:[{PolicyName:"conditioned",...policy({Effect:"Allow",Action:"lambda:InvokeFunction",
      Resource:`${base}:*`,Condition:{StringEquals:{"aws:RequestedRegion":"eu-west-2"}}})}]},
    {UserName:"variable",UserPolicyList:[{PolicyName:"variable-resource",...policy({Effect:"Allow",Action:"lambda:InvokeFunction",
      Resource:"arn:${aws:Partition}:lambda:${aws:RequestedRegion}:${aws:AccountId}:function:todoist-calendar-sync-*:*"})}]},
    {UserName:"not-resource",UserPolicyList:[{PolicyName:"not-resource-policy",...policy({Effect:"Allow",Action:"lambda:InvokeFunction",
      NotResource:`${base}:8`})}]},
  ]})});
  const conditional=result.candidates.find(item=>item.principalName==="conditional");
  assert.equal(conditional.conditionPresent,true);
  assert.equal(conditional.qualifiedPossible,true);
  assert.equal(result.candidates.find(item=>item.principalName==="variable").qualifiedPossible,true);
  const excluded=result.candidates.find(item=>item.principalName==="not-resource");
  assert.equal(excluded.notResourceStatement,true);
  assert.equal(excluded.qualifiedPossible,true);
});

test("rejects incomplete inventories and invalid account identities",()=>{
  assert.throws(()=>findLambdaInvocationCandidates({inventory,accountId:"",authorization:authorization()}),/verified/);
  assert.throws(()=>findLambdaInvocationCandidates({inventory:{region:"eu-west-2",functions:[]},accountId,authorization:authorization()}),/complete Lambda/);
  assert.throws(()=>findLambdaInvocationCandidates({inventory:{...inventory,verifiedAccount:"999999999999"},accountId,authorization:authorization()}),/complete Lambda/);
  assert.throws(()=>findLambdaInvocationCandidates({inventory,accountId,authorization:{Users:[],Roles:[]}}),/IAM authorization inventory/);
});

test("marks an absent role trust document as unavailable instead of implying non-assumability",()=>{
  const result=findLambdaInvocationCandidates({inventory,accountId,authorization:authorization({roles:[
    {RoleName:"role-without-document",RolePolicyList:[{PolicyName:"invoke",...policy({Effect:"Allow",
      Action:"lambda:InvokeFunction",Resource:`${base}:8`})}]},
  ]})});
  const candidate=result.candidates.find(item=>item.principalName==="role-without-document");
  assert.equal(candidate.assumeRoleTrust.status,"UNAVAILABLE");
  assert.equal(result.roleTrustSummary.unavailableTrustPolicyCount,1);
  assert.equal(result.status,"BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF");
});
