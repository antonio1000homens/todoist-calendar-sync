#!/usr/bin/env node
/**
 * DynamoDB PROVISIONED capacity budget guard.
 *
 * The free-tier provisioned throughput allowance is shared across tables and
 * their global secondary indexes. Count *every* provisioned table/GSI in this
 * SAM template rather than testing the main-table parameter in isolation.
 *
 * This deliberately expects explicit (!Ref or integer) capacity values and
 * fails closed on unsupported YAML shapes. Update it deliberately if the IaC
 * model changes; never silently skip a new GSI or table.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const FREE_TIER_RCU = 25;
export const FREE_TIER_WCU = 25;

function parameterDefault(source, key) {
  const escaped = key.replace(/[^A-Za-z0-9_]/g, "\\$&");
  const match = source.match(new RegExp(`^  ${escaped}:\\r?\\n    Type: Number\\r?\\n    Default: ([0-9]+)(?:\\r?\\n|$)`, "m"));
  if (!match) throw new Error(`Missing literal numeric CloudFormation default for ${key}`);
  return Number(match[1]);
}

function resourceBlocks(source) {
  const headers = [...source.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):\r?\n    Type: ([^\r\n]+)/gm)];
  return headers.map((entry, i) => ({
    name: entry[1],
    type: entry[2],
    body: source.slice(entry.index, headers[i + 1]?.index ?? source.length),
  }));
}

function unitFromExpression(source, expr, overrides) {
  const trimmed = expr.trim();
  const key = trimmed.match(/^!Ref ([A-Za-z][A-Za-z0-9]*)$/)?.[1];
  const value = key
    ? (overrides[key] === undefined ? parameterDefault(source, key) : Number(overrides[key]))
    : /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid provisioned capacity: ${trimmed}`);
  return value;
}

export function provisionedDynamoDbSummary(source, overrides = {}) {
  const tables = resourceBlocks(source).filter(row => row.type === "AWS::DynamoDB::Table");
  if (tables.length === 0) throw new Error("No DynamoDB tables found in SAM template");
  const rows = [];
  for (const resource of tables) {
    const provisioned = /^\s+BillingMode:\s*PROVISIONED\s*$/m.test(resource.body);
    const onDemand = /^\s+BillingMode:\s*PAY_PER_REQUEST\s*$/m.test(resource.body);
    if (!provisioned && !onDemand) throw new Error(`Unrecognised or absent billing mode for ${resource.name}`);
    if (onDemand) continue;
    const matches = [...resource.body.matchAll(/^[ \t]+ProvisionedThroughput:\r?\n[ \t]+ReadCapacityUnits: ([^\r\n]+)\r?\n[ \t]+WriteCapacityUnits: ([^\r\n]+)/gm)];
    const gsiCount = (resource.body.match(/^\s+- IndexName:\s*[^\r\n]+/gm) || []).length;
    if (matches.length !== gsiCount + 1) {
      throw new Error(`${resource.name}: expected one capacity declaration for the table and each of ${gsiCount} GSIs, found ${matches.length}`);
    }
    matches.forEach((match, index) => rows.push({
      resource: index === 0 ? resource.name : `${resource.name}/GSI-${index}`,
      rcu: unitFromExpression(source, match[1], overrides),
      wcu: unitFromExpression(source, match[2], overrides),
    }));
  }
  return {
    resources: rows,
    rcu: rows.reduce((sum, row) => sum + row.rcu, 0),
    wcu: rows.reduce((sum, row) => sum + row.wcu, 0),
  };
}

export function assertSharedFreeTierCapacity(source, overrides = {}, allowPaid = false) {
  const defaults = provisionedDynamoDbSummary(source);
  if (defaults.rcu > FREE_TIER_RCU || defaults.wcu > FREE_TIER_WCU) {
    throw new Error(`IaC default throughput ${defaults.rcu} RCU / ${defaults.wcu} WCU exceeds shared ${FREE_TIER_RCU}/${FREE_TIER_WCU} free-tier allowance`);
  }
  const actual = provisionedDynamoDbSummary(source, overrides);
  if (!allowPaid && (actual.rcu > FREE_TIER_RCU || actual.wcu > FREE_TIER_WCU)) {
    throw new Error(`Deployment throughput ${actual.rcu} RCU / ${actual.wcu} WCU exceeds shared free-tier allowance; explicit paid-capacity operator opt-in required`);
  }
  return actual;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const source = readFileSync(new URL("../template.yaml", import.meta.url), "utf8");
  const overrides = Object.fromEntries([
    ["StateTableReadCapacity", process.env.STATE_TABLE_READ_CAPACITY],
    ["StateTableWriteCapacity", process.env.STATE_TABLE_WRITE_CAPACITY],
    ["ProfileLookupIndexReadCapacity", process.env.PROFILE_LOOKUP_INDEX_READ_CAPACITY],
    ["ProfileLookupIndexWriteCapacity", process.env.PROFILE_LOOKUP_INDEX_WRITE_CAPACITY],
  ].filter(([, value]) => value !== undefined && value !== ""));
  const allowPaid = process.env.DYNAMODB_ALLOW_PAID_CAPACITY === "I_ACKNOWLEDGE_PAID_CAPACITY";
  const result = assertSharedFreeTierCapacity(source, overrides, allowPaid);
  console.log(JSON.stringify({
    event: "dynamodb_provisioned_capacity_guard",
    rcu: result.rcu,
    wcu: result.wcu,
    sharedFreeTierRcu: FREE_TIER_RCU,
    sharedFreeTierWcu: FREE_TIER_WCU,
    paidCapacityOptIn: allowPaid,
    resources: result.resources,
  }));
}
