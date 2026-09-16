import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { syncMessageGroupId } from "../dist/types.js";

const template = await readFile(new URL("../template.yaml", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const handlerSource = await readFile(new URL("../src/handler.ts", import.meta.url), "utf8");
const repositorySource = await readFile(new URL("../src/repository.ts", import.meta.url), "utf8");
const reconciliationSource = await readFile(new URL("../src/reconciliation.ts", import.meta.url), "utf8");
const queueSource = await readFile(new URL("../src/queue.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
const profileLookupSource = await readFile(new URL("../src/profile-lookup.ts", import.meta.url), "utf8");
const backfillSource = await readFile(new URL("../scripts/backfill-profile-lookup-index.mjs", import.meta.url), "utf8");
const deployPolicy = await readFile(new URL("../infrastructure/github-actions-deploy-role.yaml", import.meta.url), "utf8");

test("FIFO ordering is isolated by profile", () => {
  assert.equal(syncMessageGroupId("home"), "sync:home");
  assert.equal(syncMessageGroupId("antonio"), "sync:antonio");
  assert.equal(syncMessageGroupId("work"), "sync:work");
  assert.equal(new Set(["home", "antonio", "work"].map(syncMessageGroupId)).size, 3);
});

test("worker remains single-concurrency while project moves lack cross-profile coordination", () => {
  const workerBlock = template.match(/WorkerFunction:[\s\S]*?ReconcilerFunction:/)?.[0] || "";
  assert.match(workerBlock, /ReservedConcurrentExecutions:\s*1/);
});

test("DLQ quarantines after one receive and retains messages for seven days", () => {
  const dlqBlock = template.match(/SyncDlq:[\s\S]*?SyncQueue:/)?.[0] || "";
  const queueBlock = template.match(/SyncQueue:[\s\S]*?AlertTopic:/)?.[0] || "";
  assert.match(dlqBlock, /MessageRetentionPeriod:\s*604800/);
  assert.match(queueBlock, /maxReceiveCount:\s*1/);
});

test("worker emits a searchable structured log before returning a DLQ failure", () => {
  assert.match(workerSource, /delivery_failed_for_dlq/);
  assert.match(workerSource, /messageGroupId/);
  assert.match(workerSource, /receiveCount/);
  assert.match(workerSource, /providerBody/);
  assert.match(workerSource, /deliverySummary/);
});

test("capped or circuit-blocked reconciliation keeps its durable generation pending", () => {
  assert.match(workerSource, /calendarRecovery\.mutationCapReached/);
  assert.match(workerSource, /calendarRecovery\.blocked > 0/);
  assert.match(workerSource, /reconciliation_circuit_open_deferred/);
  assert.match(workerSource, /reconciliation_calendar_snapshot_circuit_deferred/);
  assert.match(workerSource, /reconciliation_continuation_required/);
  assert.match(workerSource, /completedDeliveryMarkerWritten:\s*false/);
  assert.match(workerSource, /continuationRequired/);
});

test("webhook-triggered reconciliation ignores echoes but retains uncertain Calendar work", () => {
  assert.match(workerSource, /let meaningfulMutation = false/);
  assert.match(workerSource, /meaningfulMutation = true/);
  assert.match(workerSource, /let calendarMutationBlocked = false/);
  assert.match(workerSource, /calendarMutationBlocked = true/);
  assert.match(workerSource, /if \(meaningfulMutation \|\| baselineRecovery \|\| calendarMutationBlocked\)/);
  assert.match(workerSource, /calendar_sync_token_withheld_circuit_block/);
  assert.match(workerSource, /reconciliation_not_requested_for_noop_delivery/);
});

test("stale mapping cleanup cannot delete a newer counterpart index", () => {
  const cleanup = repositorySource.match(/private async deleteProfileMappingIndexes[\s\S]*?\n  }\n\n  async deleteMapping/)?.[0] || "";
  assert.match(cleanup, /ConditionExpression:\s*"taskId = :taskId"/);
  assert.match(cleanup, /ConditionExpression:\s*"eventId = :eventId"/);
});

test("transaction cancellation fallback confirms ownership before cleanup", () => {
  const cancellationBlock = repositorySource.match(/catch \(error\) \{[\s\S]*?currentOwner[\s\S]*?throw error;\n    \}/)?.[0] || "";
  assert.match(cancellationBlock, /TransactionCanceledException/);
  assert.match(cancellationBlock, /ConsistentRead:\s*true/);
  assert.match(cancellationBlock, /currentOwner\.Item\?\.profile/);
  assert.match(cancellationBlock, /currentOwner\.Item\?\.eventId/);
  assert.match(cancellationBlock, /throw error/);
});

test("reconciliation API does not expose an unimplemented dry-run mode", () => {
  assert.doesNotMatch(queueSource, /dryRun/);
  assert.doesNotMatch(typesSource, /dryRun/);
});

test("standalone deployment role scopes SNS and cannot write application secrets", () => {
  const snsBlock = deployPolicy.match(/- Sid: ManageApplicationAlertTopic[\s\S]*?\nOutputs:/)?.[0] || "";
  assert.match(snsBlock, /arn:\$\{AWS::Partition\}:sns:\$\{AWS::Region\}:\$\{AWS::AccountId\}:\$\{ResourceNamePrefix\}-alerts-\*/);
  assert.match(deployPolicy, /ResourceNamePrefix:[\s\S]*?Default:\s*todoist-calendar-sync/);
  assert.match(snsBlock, /\$\{LegacyResourceNamePrefix\}-alerts-\*/);
  assert.doesNotMatch(snsBlock, /Resource:\s*"\*"/);
  assert.doesNotMatch(snsBlock, /StringLikeIfExists/);
  assert.doesNotMatch(deployPolicy, /ssm:PutParameter/);
  assert.match(deployPolicy, /ssm:GetParameter/);
  assert.match(deployPolicy, /parameter\/todoist-calendar-sync\/\*/);
  assert.match(deployPolicy, /repo:antonio1000homens\/todoist-calendar-sync:environment:production/);
});

test("ingress no longer claims DynamoDB delivery state before SQS enqueue", () => {
  assert.doesNotMatch(handlerSource, /claimDelivery\s*\(/);
  assert.match(handlerSource, /await enqueueDelivery\(delivery\)/);
});

test("state table uses fixed 25/25 provisioned capacity, remains protected and worker can transact mappings", () => {
  assert.match(template, /BillingMode:\s*PROVISIONED/);
  assert.match(template, /StateTableReadCapacity:[\s\S]*?Default:\s*25/);
  assert.match(template, /StateTableWriteCapacity:[\s\S]*?Default:\s*25/);
  assert.match(template, /ReadCapacityUnits:\s*!Ref StateTableReadCapacity/);
  assert.match(template, /WriteCapacityUnits:\s*!Ref StateTableWriteCapacity/);
  assert.doesNotMatch(template, /AWS::ApplicationAutoScaling::/);
  assert.match(template, /DeletionProtectionEnabled:\s*true/);
  assert.match(template, /PointInTimeRecoveryEnabled:\s*true/);
  assert.match(template, /dynamodb:TransactWriteItems/);
});

test("profile lookup GSI is additive and hot paths query it after backfill", () => {
  assert.match(template, /IndexName:\s*ProfileLookupIndex/);
  assert.match(template, /AttributeName:\s*lookupPk/);
  assert.match(template, /AttributeName:\s*lookupSk/);
  assert.match(template, /DeletionPolicy:\s*Retain/);
  assert.match(profileLookupSource, /PROFILE_LOOKUP_READY_KEY/);
  assert.match(profileLookupSource, /ConsistentRead:\s*true/);
  const mappingMethod = repositorySource.match(/async listRecurrenceLinks[\s\S]*?\n  }/)?.[0] || "";
  assert.match(mappingMethod, /QueryCommand/);
  assert.match(mappingMethod, /list_recurrence_links_scan_fallback/);
  assert.match(repositorySource, /lookupPk: profileLookupPk/);
  assert.match(repositorySource, /lookupSk: recurrenceLookupSk/);
  assert.match(reconciliationSource, /QueryCommand/);
  assert.match(reconciliationSource, /list_reconciliation_mappings_scan_fallback/);
  assert.match(reconciliationSource, /mappingLookupSk\("task", ""\)/);
  assert.match(backfillSource, /Limit:\s*25/);
  assert.match(backfillSource, /attribute_not_exists\(lookupPk\)/);
  assert.match(backfillSource, /PROFILE_LOOKUP_READY_KEY/);
});
