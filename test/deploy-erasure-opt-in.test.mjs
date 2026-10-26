import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const deploy=readFileSync(new URL("../deploy.sh",import.meta.url),"utf8");
const workflow=readFileSync(new URL("../.github/workflows/deploy.yml",import.meta.url),"utf8");
const template=readFileSync(new URL("../template.yaml",import.meta.url),"utf8");

test("operator opt-in is an explicit GitHub production decision, not a default template change",()=>{
  assert.match(workflow,/ERASURE_EXECUTION_ENABLED:\s*'true'/);
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

test("review API publishes a new live-alias version on reviewed function-property changes",()=>{
  const review=template.split("\n  ReviewApiFunction:\n")[1]?.split("\n  ReviewApiUrlPermission:\n")[0];
  assert.ok(review,"ReviewApiFunction SAM resource is defined");
  assert.match(review,/AutoPublishAlias: live/);
  assert.match(review,/AutoPublishAliasAllProperties: true/);
  assert.match(review,/Description: (Authenticated review API with the explicit erasure opt-in release|Recovery-aware authenticated review API)/);
  assert.match(review,/ERASURE_EXECUTION_ENABLED: !Ref ErasureExecutionEnabled/);
});
