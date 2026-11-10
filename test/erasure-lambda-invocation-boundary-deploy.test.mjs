import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const workflow=readFileSync(new URL("../.github/workflows/deploy.yml",import.meta.url),"utf8");
const deploymentRole=readFileSync(new URL("../infrastructure/github-actions-deploy-role.yaml",import.meta.url),"utf8");

test("production deploy enforces the resource-policy boundary after SAM publishes versions",()=>{
  const deployIndex=workflow.indexOf("- name: Deploy todoist-calendar-sync");
  const boundaryIndex=workflow.indexOf("- name: Enforce qualified Lambda invocation boundary");
  const verifyIndex=workflow.indexOf("- name: Verify completed-history retirement schedule and Lambda mode");
  assert.ok(deployIndex>=0&&boundaryIndex>deployIndex&&verifyIndex>boundaryIndex);
  assert.match(workflow.slice(boundaryIndex,verifyIndex),/scripts\/enforce-erasure-lambda-invocation-boundary\.mjs --region="\$AWS_REGION"/);
});

test("deployment role can read and replace Lambda policies only under the app function prefix",()=>{
  const start=deploymentRole.indexOf("- Sid: ManageApplicationLambdaFunctions");
  const end=deploymentRole.indexOf("- Sid: ManageApplicationEventSourceMappings",start);
  assert.ok(start>=0&&end>start);
  const statement=deploymentRole.slice(start,end);
  assert.match(statement,/lambda:GetResourcePolicy/);
  assert.match(statement,/lambda:PutResourcePolicy/);
  assert.match(statement,/arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:\$\{ResourceNamePrefix\}-\*/);
  assert.doesNotMatch(statement,/Resource:\s*"\*"/);
});

test("deployment role can create change sets with only the two named SAM transforms",()=>{
  const start=deploymentRole.indexOf("- Sid: UseSamTransform");
  const end=deploymentRole.indexOf("- Sid: ValidateCloudFormationTemplates",start);
  assert.ok(start>=0&&end>start);
  const statement=deploymentRole.slice(start,end);
  assert.match(statement,/cloudformation:CreateChangeSet/);
  assert.match(statement,/transform\/Serverless-2016-10-31/);
  assert.match(statement,/transform\/LanguageExtensions/);
  assert.doesNotMatch(statement,/Resource:\s*"\*"/);
});
