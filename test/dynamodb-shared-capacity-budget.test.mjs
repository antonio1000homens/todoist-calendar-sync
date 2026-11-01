import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FREE_TIER_RCU, FREE_TIER_WCU, assertSharedFreeTierCapacity,
  provisionedDynamoDbSummary,
} from "../scripts/check-dynamodb-capacity.mjs";

const template = readFileSync(new URL("../template.yaml", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
const deployWorkflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("all provisioned DynamoDB table and GSI defaults sum to 25/25 or less", () => {
  const actual = assertSharedFreeTierCapacity(template);
  assert.equal(FREE_TIER_RCU, 25);
  assert.equal(FREE_TIER_WCU, 25);
  assert.equal(actual.rcu, 25);
  assert.equal(actual.wcu, 25);
  assert.deepEqual(actual.resources, [
    { resource: "SyncState", rcu: 20, wcu: 20 },
    { resource: "SyncState/GSI-1", rcu: 5, wcu: 5 },
  ]);
});

test("deployed capacity overrides are independent and cannot silently exceed the shared budget", () => {
  assert.deepEqual(
    assertSharedFreeTierCapacity(template, {
      StateTableReadCapacity: "19", StateTableWriteCapacity: "20",
      ProfileLookupIndexReadCapacity: "6", ProfileLookupIndexWriteCapacity: "5",
    }).resources,
    [{resource:"SyncState",rcu:19,wcu:20},{resource:"SyncState/GSI-1",rcu:6,wcu:5}],
  );
  assert.throws(() => assertSharedFreeTierCapacity(template, {
    StateTableReadCapacity: "25", ProfileLookupIndexReadCapacity: "5",
    StateTableWriteCapacity: "25", ProfileLookupIndexWriteCapacity: "5",
  }), /exceeds shared free-tier allowance/);
  assert.throws(() => assertSharedFreeTierCapacity(template, { StateTableWriteCapacity: "0" }), /Invalid provisioned capacity/);
  assert.throws(() => assertSharedFreeTierCapacity(template, { StateTableReadCapacity: "abc" }), /Invalid provisioned capacity/);
  const paid = assertSharedFreeTierCapacity(template, {
    StateTableReadCapacity: 25, StateTableWriteCapacity: 25,
  }, true);
  assert.equal(paid.rcu, 30);
  assert.equal(paid.wcu, 30);
});

test("increasing IaC defaults past shared allowance fails even with an operator paid override", () => {
  const changed = template.replace(
    /StateTableReadCapacity:\n    Type: Number\n    Default: 20/,
    "StateTableReadCapacity:\n    Type: Number\n    Default: 21",
  );
  assert.notEqual(changed, template);
  assert.throws(() => assertSharedFreeTierCapacity(changed, {}, true), /IaC default throughput.*exceeds/);
});

test("deployment keeps all four capacity overrides and rejects unapproved production reductions", () => {
  for(const key of [
    "StateTableReadCapacity", "StateTableWriteCapacity",
    "ProfileLookupIndexReadCapacity", "ProfileLookupIndexWriteCapacity",
  ]) {
    assert.match(deployScript, new RegExp(`"${key}=\\$[a-z_]+"`),
      `${key} must be passed to sam deploy explicitly`);
  }
  assert.match(deployWorkflow, /DYNAMODB_CAPACITY_REDUCTION_APPROVED:.*vars\.DYNAMODB_CAPACITY_REDUCTION_APPROVED/);
  assert.match(deployScript, /if \[ "\$capacity_reduction_approved" != "true" \]; then/);
  assert.match(deployScript, /aws cloudformation describe-stacks/);
  assert.match(deployScript, /current_table_read/);
  assert.match(deployScript, /profile_lookup_index_write_capacity < current_index_write/);
  assert.match(deployScript, /DYNAMODB_CAPACITY_REDUCTION_APPROVED=true/);
});

test("new provisioned GSI or table cannot evade the budget guard", () => {
  const extraGsiWithoutCapacity = template.replace(
    "        - IndexName: ProfileLookupIndex",
    "        - IndexName: AccidentalIndex\n        - IndexName: ProfileLookupIndex",
  );
  assert.throws(() => provisionedDynamoDbSummary(extraGsiWithoutCapacity), /expected one capacity declaration/);

  const secondTable = template.replace(
    "  SyncDlq:\n    Type: AWS::SQS::Queue",
    `  ExtraState:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PROVISIONED
      ProvisionedThroughput:
        ReadCapacityUnits: 1
        WriteCapacityUnits: 1
  SyncDlq:
    Type: AWS::SQS::Queue`,
  );
  assert.throws(() => assertSharedFreeTierCapacity(secondTable), /exceeds shared free-tier allowance/);
});
