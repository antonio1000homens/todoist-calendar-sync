import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const readText=(path)=>readFileSync(new URL(path,import.meta.url),"utf8").replace(/\r\n/g,"\n");
const deploy=readText("../deploy.sh");
const workflow=readText("../.github/workflows/deploy.yml");
const template=readText("../template.yaml");

test("production deployment keeps item erasure disabled until guarded acceptance is complete",()=>{
  assert.match(workflow,/ERASURE_EXECUTION_ENABLED:\s*'false'/);
  assert.match(deploy,/erasure_execution_enabled="\$\{ERASURE_EXECUTION_ENABLED:-false\}"/);
  assert.match(deploy,/ErasureExecutionEnabled=\$erasure_execution_enabled/);
  assert.match(deploy,/ERASURE_EXECUTION_ENABLED must be exactly true or false/);
});

test("production deployment reads back the stack and both function gates",()=>{
  assert.match(workflow,/Verify erasure execution flag and protocol on both deployed Lambdas/);
  assert.match(workflow,/ErasureExecutionEnabled.*ParameterValue/);
  assert.match(workflow,/for logical_id in ReviewApiFunction ErasureWorkerFunction/);
  assert.match(workflow,/Environment\.Variables\.ERASURE_EXECUTION_ENABLED/);
  assert.match(workflow,/Environment\.Variables\.ERASURE_PROTOCOL_VERSION/);
  assert.match(workflow,/--qualifier live/);
});

test("production deployment rejects stale master CI and non-master manual dispatches",()=>{
  assert.match(workflow,/workflow_dispatch' && github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow,/workflow_run\.head_branch == 'master'/);
  assert.match(workflow,/workflow_run\.head_sha == github\.sha/);
  assert.match(workflow,/ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
});

test("review API publishes a new live-alias version on reviewed function-property changes",()=>{
  const review=template.split("\n  ReviewApiFunction:\n")[1]?.split("\n  ReviewApiUrlPermission:\n")[0];
  assert.ok(review,"ReviewApiFunction SAM resource is defined");
  assert.match(review,/AutoPublishAlias: live/);
  assert.match(review,/AutoPublishAliasAllProperties: true/);
  assert.match(review,/ERASURE_EXECUTION_ENABLED: !Ref ErasureExecutionEnabled/);
});

test("erasure worker reads only configured Google and Todoist credential parameters",()=>{
  const worker=template.split("\n  ErasureWorkerFunction:\n")[1]?.split("\n  ErasureRecoveryWatchdogFunction:\n")[0];
  assert.ok(worker,"ErasureWorkerFunction SAM resource is defined");
  assert.match(worker,/GOOGLE_CREDENTIALS_PARAMETER_PREFIX: !Ref GoogleCredentialsParameterPrefix/);
  assert.match(worker,/TODOIST_TOKEN_PARAMETER_PREFIX: !Ref TodoistTokenParameterPrefix/);
  assert.match(worker,/Action:\s*\n\s*- ssm:GetParameter/);
  assert.match(worker,/parameter\$\{GoogleCredentialsParameterPrefix\}\/\*/);
  assert.match(worker,/parameter\$\{TodoistTokenParameterPrefix\}\/\*/);
  assert.doesNotMatch(worker,/ssm:\*/);
});

test("pre-write recovery watchdog has independent, disabled-by-default schedule and no mapping-write IAM",()=>{
  const watchdog=template.split("\n  ErasureRecoveryWatchdogFunction:\n")[1]?.split("\n  ReconcilerFunction:\n")[0];
  assert.ok(watchdog,"independent watchdog Lambda exists");
  assert.match(watchdog,/Handler: erasure-worker\.watchdogHandler/);
  assert.match(watchdog,/Timeout: 300/);
  assert.match(watchdog,/ReservedConcurrentExecutions: 1/);
  assert.match(watchdog,/Schedule: rate\(5 minutes\)/);
  assert.match(watchdog,/Enabled: false/);
  assert.match(watchdog,/Action: dynamodb:TransactWriteItems\s*\n\s*Resource: !GetAtt SyncState\.Arn/);
  assert.match(watchdog,/Action: lambda:GetEventSourceMapping/);
  assert.doesNotMatch(watchdog,/lambda:UpdateEventSourceMapping/);
  assert.doesNotMatch(watchdog,/Type: SQS/);
});
