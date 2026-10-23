import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { syncMessageGroupId } from "../dist/types.js";

const template = await readFile(new URL("../template.yaml", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const handlerSource = await readFile(new URL("../src/handler.ts", import.meta.url), "utf8");
const erasureProtocolSource = await readFile(new URL("../src/erasure-protocol.ts", import.meta.url), "utf8");
const repositorySource = await readFile(new URL("../src/repository.ts", import.meta.url), "utf8");
const reconciliationSource = await readFile(new URL("../src/reconciliation.ts", import.meta.url), "utf8");
const queueSource = await readFile(new URL("../src/queue.ts", import.meta.url), "utf8");
const healthSource = await readFile(new URL("../src/reconcile.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
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

test("DLQ quarantines after one receive and retains messages for 24 hours", () => {
  const dlqBlock = template.match(/SyncDlq:[\s\S]*?SyncQueue:/)?.[0] || "";
  const queueBlock = template.match(/SyncQueue:[\s\S]*?AlertTopic:/)?.[0] || "";
  assert.match(dlqBlock, /MessageRetentionPeriod:\s*86400/);
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

test("webhooks never start full reconciliation and the scheduled health check is read-only", () => {
  assert.match(workerSource, /let meaningfulMutation = false/);
  assert.match(workerSource, /meaningfulMutation = true/);
  assert.match(workerSource, /let calendarMutationBlocked = false/);
  assert.match(workerSource, /calendarMutationBlocked = true/);
  assert.doesNotMatch(workerSource, /requestReconciliation\(/);
  assert.match(workerSource, /calendar_sync_token_withheld_circuit_block/);
  assert.match(workerSource, /incremental_sync_completed/);
  assert.doesNotMatch(healthSource, /requestReconciliation|enqueueDelivery|listDelta|listTasks/);
  assert.match(template, /ScheduleExpression:\s*rate\(5 minutes\)/);
  const healthBlock = template.match(/ReconcilerFunction:[\s\S]*?ReconcilerFunctionEveryFifteenMinutes:/)?.[0] || "";
  assert.doesNotMatch(healthBlock, /SQSSendMessagePolicy/);
});

test("Calendar snapshot continuations run to exhaustion before terminal reconciliation status", () => {
  assert.match(workerSource, /continuation\?\.phase === "calendar" \? undefined : await reconciler\.reconcile/);
  assert.match(workerSource, /continuation\?\.phase === "calendar" \? continuation : \{ phase: "calendar", sequence: continuation\?\.sequence \|\| 0 \}/);
  assert.match(workerSource, /if \(calendarRecovery\.continuation\)/);
  assert.match(workerSource, /await state\.completeReconciliation\(delivery\.profile, generation, unresolved, aggregate\)/);
  assert.match(workerSource, /return \{ continuationRequired: false, continuationQueued: true \}/);
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
  assert.match(deployPolicy, /repo:antonio1000homens@36929120\/todoist-calendar-sync@1370572332:environment:production/);
});

test("ingress no longer claims DynamoDB delivery state before SQS enqueue", () => {
  assert.doesNotMatch(handlerSource, /claimDelivery\s*\(/);
  assert.match(handlerSource, /await enqueueDelivery\(delivery\)/);
});

test("ingress grants only the DynamoDB table actions required by admission lease protocol", () => {
  const ingressBlock = template.match(/IngressFunction:[\s\S]*?ReviewApiLogGroup:/)?.[0] || "";
  const tablePolicy = ingressBlock.match(/Action:\n((?:\s+- dynamodb:[^\n]+\n)+)\s+Resource: !GetAtt SyncState\.Arn/)?.[1] || "";
  const granted = new Set([...tablePolicy.matchAll(/dynamodb:([A-Za-z]+)/g)].map((match) => match[1]));

  const epochRead = erasureProtocolSource.match(/export async function getErasureEpoch[\s\S]*?\n}\n/)?.[0] || "";
  const admissionLease = erasureProtocolSource.match(/export async function acquireErasureProtocolLease[\s\S]*?\n}\n/)?.[0] || "";
  assert.ok(epochRead && admissionLease, "expected epoch read and admission lease implementations");

  const required = new Set();
  if (/new GetCommand\(/.test(epochRead) || /new GetCommand\(/.test(admissionLease)) required.add("GetItem");
  if (/ConditionCheck\s*:/.test(admissionLease)) required.add("ConditionCheckItem");
  if (/\bPut\s*:/.test(admissionLease)) required.add("PutItem");
  if (/new DeleteCommand\(/.test(admissionLease)) required.add("DeleteItem");

  for (const action of required) assert.ok(granted.has(action), `IngressFunction must allow dynamodb:${action}`);
  assert.deepEqual([...granted].sort(), ["ConditionCheckItem", "DeleteItem", "GetItem", "PutItem", "UpdateItem"].sort(),
    "the state-table policy should contain only current ingress state and admission-lease actions");
  assert.match(ingressBlock, /Resource: !GetAtt SyncState\.Arn/);
  assert.doesNotMatch(tablePolicy, /\*/);
});

test("failed webhook admission returns a retryable non-2xx response without claiming acceptance", () => {
  const enqueueCatch = handlerSource.match(/await enqueueDelivery\(delivery\);([\s\S]*?)log\("webhook_enqueued"/)?.[1] || "";
  assert.match(enqueueCatch, /logError\("webhook_enqueue_failed"/);
  assert.match(enqueueCatch, /return response\(503,\s*\{\s*error:\s*"enqueue_failed",\s*accepted:\s*false/);
  assert.doesNotMatch(enqueueCatch, /response\(202/);
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

test("profile lookup GSI is additive and validated hot paths are query-only", () => {
  assert.match(template, /IndexName:\s*ProfileLookupIndex/);
  assert.match(template, /AttributeName:\s*lookupPk/);
  assert.match(template, /AttributeName:\s*lookupSk/);
  assert.match(template, /DeletionPolicy:\s*Retain/);
  const mappingMethod = repositorySource.match(/async listRecurrenceLinks[\s\S]*?\n  }/)?.[0] || "";
  assert.match(mappingMethod, /readProfileLookup/);
  assert.doesNotMatch(mappingMethod, /scan_fallback|pacedScan/);
  assert.match(repositorySource, /mappingEventLookupAttributes\(mapping\)/);
  assert.match(repositorySource, /mappingLookupAttributes\(mapping\)/);
  assert.match(repositorySource, /mappingOwnerLookupAttributes\(mapping\)/);
  assert.match(repositorySource, /recurrenceLookupAttributes\(next\)/);
  assert.match(repositorySource, /recurrenceLookupQueryInput\(table, profile\)/);
  assert.match(reconciliationSource, /readProfileLookup/);
  assert.doesNotMatch(reconciliationSource, /list_reconciliation_mappings_scan_fallback|pacedScan/);
  assert.match(reconciliationSource, /mappingLookupQueryInput\(table, profile\)/);
  assert.match(backfillSource, /Limit:\s*25/);
  assert.match(backfillSource, /profileLookupBackfillCondition\(lookup\)/);
  assert.match(backfillSource, /PROFILE_LOOKUP_READY_KEY/);
});
