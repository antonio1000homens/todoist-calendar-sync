import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = readFileSync(new URL("../template.yaml", import.meta.url), "utf8");
const inventory = readFileSync(new URL("../docs/cloudwatch-alarm-cost-and-coverage.md", import.meta.url), "utf8");

function resourceBlock(name) {
  const lines = template.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z][A-Za-z0-9]*:$/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

const retainedAlarms = [
  "WatchLambdaErrorsAlarm",
  "ErasureWorkerErrorsAlarm", "WorkerErrorsAlarm",
  "DynamoDbReadThrottleAlarm", "DynamoDbWriteThrottleAlarm",
  "ProfileLookupIndexReadThrottleAlarm", "ProfileLookupIndexWriteThrottleAlarm",
];

const removedAlarms = [
  "DynamoDbReadUtilizationAlarm", "DynamoDbWriteUtilizationAlarm",
  "ProfileLookupIndexReadUtilizationAlarm", "ProfileLookupIndexWriteUtilizationAlarm",
  // Explicitly authorised removals; log-derived metrics must continue to exist.
  "WatchRenewalFailureAlarm", "WatchMissingAlarm",
  "ErasureRecoveryBlockedAlarm", "ErasureReviewRequiredAlarm",
  "DlqAlarm", "ErasureDlqAlarm", "SourceQueueAgeAlarm", "SourceQueueDepthAlarm",
];

test("retains 7 worker, watch-Lambda, and throttle alarms on AlertTopic", () => {
  const alarms = [...template.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):\n    Type: AWS::CloudWatch::Alarm$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(alarms.sort(), [...retainedAlarms].sort());
  for (const name of retainedAlarms) {
    const block = resourceBlock(name);
    assert.match(block, /AlarmActions: \[!Ref AlertTopic\]/, `${name} must keep its notification action`);
  }
});

test("removes utilization, custom-metric, and SQS alarms while preserving throttles", () => {
  for (const name of removedAlarms) assert.equal(resourceBlock(name), "", `${name} should be absent`);
  for (const name of [
    "DynamoDbReadThrottleAlarm", "DynamoDbWriteThrottleAlarm",
    "ProfileLookupIndexReadThrottleAlarm", "ProfileLookupIndexWriteThrottleAlarm",
  ]) assert.notEqual(resourceBlock(name), "", `${name} must remain`);
});

test("keeps all four log-derived custom metric filters and documents the coverage tradeoff", () => {
  for (const name of ["ErasureReviewRequiredMetricFilter", "ErasureRecoveryBlockedMetricFilter",
    "WatchRenewalFailureMetricFilter", "WatchMissingMetricFilter"]) {
    assert.match(resourceBlock(name), /Type: AWS::Logs::MetricFilter/);
  }
  assert.match(inventory, /zero SNS subscriptions/);
  assert.match(inventory, /eight alarm-metric\s+units/);
  assert.match(inventory, /Capacity nears its provisioned limit before throttling/);
  assert.match(inventory, /custom metric charges can continue/i);
  assert.match(inventory, /no direct CloudWatch alarm/i);
  assert.match(inventory, /10 minutes plus up to\s+five minutes of scrape wait/);
  assert.match(inventory, /Grafana/);
});

test("documents every retained and removed alarm in the review matrix", () => {
  const suffixes = [
    "watch-renewal-failures", "watch-missing", "watch-errors", "dlq-not-empty",
    "erasure-dlq-not-empty", "erasure-worker-errors", "erasure-recovery-blocked",
    "erasure-review-required", "source-oldest-message", "source-depth", "worker-errors",
    "dynamodb-read-throttles", "dynamodb-write-throttles", "profile-lookup-read-throttles",
    "profile-lookup-write-throttles", "dynamodb-read-utilization", "dynamodb-write-utilization",
    "profile-lookup-read-utilization", "profile-lookup-write-utilization",
  ];
  for (const suffix of suffixes) assert.ok(inventory.includes(`\`${suffix}\``), `${suffix} needs an inventory row`);
});
