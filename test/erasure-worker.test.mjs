import test from "node:test";
import assert from "node:assert/strict";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureGateDriftError, ErasureOperationStore } from "../dist/erasure-executor.js";
import {ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";
import {ErasureRecoveryService} from "../dist/erasure-recovery.js";
import { handler, watchdogHandler, inspectStuckErasureRecovery, parseErasureQueueRecord } from "../dist/erasure-worker.js";

// The existing worker integration cases exercise an explicitly approved deployment.
process.env.ERASURE_PROTOCOL_VERSION = "1";
process.env.ERASURE_EXECUTION_ENABLED = "true";

const record = (body, messageId = "message-1") => ({ body, messageId, receiptHandle: "receipt", attributes: {}, messageAttributes: {}, md5OfBody: "digest", eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:eu-west-2:123:erasure", awsRegion: "eu-west-2" });

test("erasure queue record parser accepts only the versioned operation identity", () => {
  assert.equal(parseErasureQueueRecord(record('{"version":1,"operationId":"op_1"}')), "op_1");
  for (const body of ["{", "[]", "null", '{"version":2,"operationId":"op"}', '{"version":1,"operationId":"op","selection":[]}']) {
    assert.throws(() => parseErasureQueueRecord(record(body)), /Invalid erasure queue message/);
  }
});

test("scheduled watchdog uses three fixed fence reads, not a DynamoDB scan", async t=>{
  const old=process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME="test-state";
  const inputs=[];
  t.mock.method(documentClient,"send",async command=>{
    assert.equal(command.constructor.name,"BatchGetCommand");
    inputs.push(command.input);
    return {Responses:{"test-state":[]}};
  });
  try {
    const result=await watchdogHandler({source:"aws.events","detail-type":"Scheduled Event"});
    assert.equal(result,undefined);
    assert.equal(inputs.length,1);
    const batch=inputs[0].RequestItems["test-state"];
    assert.equal(batch.ConsistentRead,true);
    assert.deepEqual(new Set(batch.Keys.map(k=>k.pk)),
      new Set(["ERASURE#antonio","ERASURE#home","ERASURE#work"]));
    assert.equal(batch.Keys.length,3);
    await assert.rejects(watchdogHandler({source:"untrusted","detail-type":"Scheduled Event"}),
      /Unsupported erasure recovery watchdog event/);
  } finally {
    if(old===undefined)delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME=old;
  }
});

test("watchdog queues only independently eligible pre-write recovery, never deletion",async t=>{
  const old={table:process.env.STATE_TABLE_NAME,queue:process.env.ERASURE_OPERATION_QUEUE_URL};
  process.env.STATE_TABLE_NAME="test-state";
  process.env.ERASURE_OPERATION_QUEUE_URL="https://sqs.example/erasure";
  const id="44da2340-b5a1-4fe3-b5d4-a0ea146cbf4b",sent=[],recoveryCalls=[];
  t.mock.method(documentClient,"send",async()=>({Responses:{"test-state":[
    {pk:"ERASURE#work",sk:"FENCE",operationId:id}
  ]}}));
  t.mock.method(ErasureOperationStore.prototype,"get",async idValue=>({
    operationId:idValue,profile:"work",status:"review_required",lifecycle:{phase:"ready_for_delete"},
  }));
  t.mock.method(ErasureRecoveryService.prototype,"startAutomaticPreWriteRecovery",
    async operationId=>{recoveryCalls.push(operationId);return {queued:true,blockerCount:0};});
  t.mock.method(SQSClient.prototype,"send",async command=>{sent.push(command.input);return {};});
  try {
    const result=await inspectStuckErasureRecovery();
    assert.deepEqual(result,{fenced:1,queued:1,completed:0,blocked:0});
    assert.deepEqual(recoveryCalls,[id]);
    assert.equal(sent.length,1);
    assert.deepEqual(JSON.parse(sent[0].MessageBody),
      {version:1,recoveryOperationId:id},
      "scheduled recovery may not be parsed as a deletion command");
  } finally {
    for(const [k,v] of Object.entries({STATE_TABLE_NAME:old.table,
      ERASURE_OPERATION_QUEUE_URL:old.queue}))if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
});

test("watchdog automatically completes verified post-write operations without a new queue",async t=>{
  const old=process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME="test-state";
  const id="44da2340-b5a1-4fe3-b5d4-a0ea146cbf4b",sent=[],preWriteCalls=[];
  t.mock.method(documentClient,"send",async()=>({Responses:{"test-state":[
    {pk:"ERASURE#work",sk:"FENCE",operationId:id}
  ]}}));
  t.mock.method(ErasureOperationStore.prototype,"get",async idValue=>({
    operationId:idValue,profile:"work",status:"review_required",providerDeletionReady:true,
    lifecycle:{phase:"verify_deletion",evidence:{deletionStarted:{operationId:idValue,phase:"deletionStarted"}}},
  }));
  t.mock.method(ErasureRecoveryService.prototype,"completePostWriteIfSafe",
    async operationId=>({status:operationId===id?"completed":"blocked",blockers:[]}));
  t.mock.method(ErasureRecoveryService.prototype,"startAutomaticPreWriteRecovery",
    async operationId=>{preWriteCalls.push(operationId);return {queued:true,blockerCount:0};});
  t.mock.method(SQSClient.prototype,"send",async command=>{sent.push(command.input);return {};});
  try {
    const result=await inspectStuckErasureRecovery();
    assert.deepEqual(result,{fenced:1,queued:0,completed:1,blocked:0});
    assert.deepEqual(preWriteCalls,[]);
    assert.deepEqual(sent,[],"post-write completion does not create or dispatch a new queue message");
  } finally {
    if(old===undefined)delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME=old;
  }
});

test("watchdog preserves active fence and skips ambiguous, mismatched operations",async t=>{
  const old=process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME="test-state";
  const id="44da2340-b5a1-4fe3-b5d4-a0ea146cbf4b",sent=[];
  t.mock.method(documentClient,"send",async()=>({Responses:{"test-state":[
    {pk:"ERASURE#work",sk:"FENCE",operationId:id}
  ]}}));
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>({
    operationId:id,profile:"work",status:"review_required",lifecycle:{phase:"delete"},
  }));
  t.mock.method(ErasureRecoveryService.prototype,"startAutomaticPreWriteRecovery",
    async()=>({queued:false,blockerCount:2}));
  t.mock.method(SQSClient.prototype,"send",async command=>{sent.push(command.input);return {};});
  try {
    const result=await inspectStuckErasureRecovery();
    assert.equal(result.queued,0);
    assert.equal(result.blocked,1);
    assert.deepEqual(sent,[]);
  } finally {
    if(old===undefined)delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME=old;
  }
});

test("worker starts only a stored queued operation and self-dispatches its identity", async t => {
  const old = { table: process.env.STATE_TABLE_NAME, queue: process.env.ERASURE_OPERATION_QUEUE_URL,
    target: process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME };
  process.env.STATE_TABLE_NAME = "test-state";
  process.env.ERASURE_OPERATION_QUEUE_URL = "https://sqs.example/erasure";
  process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME = "sync-worker";
  const sent = [], starts = [];
  const operation = { operationId: "op_1", status: "queued", providerDeletionReady: true };
  t.mock.method(ErasureOperationStore.prototype, "get", async id => id === "op_1" ? operation : undefined);
  t.mock.method(ErasureOperationStore.prototype, "transition", async () => {});
  t.mock.method(ErasureOperationStore.prototype, "startFencedLifecycle", async (...args) => starts.push(args));
  t.mock.method(LambdaClient.prototype, "send", async () => ({ Timeout: 300 }));
  t.mock.method(SQSClient.prototype, "send", async command => { sent.push(command.input); return {}; });
  // The worker's store uses the shared DynamoDB client only outside the mocked store methods.
  t.mock.method(documentClient, "send", async () => ({}));
  try {
    const result = await handler({ Records: [record('{"version":1,"operationId":"op_1"}')], awsRequestId: "req" });
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.deepEqual(starts, [["op_1", 300]]);
    assert.equal(JSON.parse(sent[0].MessageBody).operationId, "op_1");
    assert.deepEqual(Object.keys(JSON.parse(sent[0].MessageBody)).sort(), ["operationId", "version"]);
  } finally {
    if (old.table === undefined) delete process.env.STATE_TABLE_NAME; else process.env.STATE_TABLE_NAME = old.table;
    if (old.queue === undefined) delete process.env.ERASURE_OPERATION_QUEUE_URL; else process.env.ERASURE_OPERATION_QUEUE_URL = old.queue;
    if (old.target === undefined) delete process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME; else process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME = old.target;
  }
});

test("queued erasure with unavailable replay readiness is reviewed before mapping changes or queueing",async t=>{
  const oldTarget=process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME;
  const operation={operationId:"op_no_replay",status:"queued",providerDeletionReady:true};
  let started=0,reviewed=0,queued=0;
  process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME="sync-worker";
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>operation);
  t.mock.method(ErasureOperationStore.prototype,"startFencedLifecycle",async()=>{
    started++;throw new ErasureReplayUnavailableError("Replay keyring is not configured");
  });
  t.mock.method(ErasureOperationStore.prototype,"markQueuedReplayBlocked",async()=>{
    reviewed++;operation.status="review_required";
  });
  t.mock.method(LambdaClient.prototype,"send",async()=>({Timeout:300}));
  t.mock.method(SQSClient.prototype,"send",async()=>{queued++;return {};});
  try{
    const result=await handler({Records:[record('{"version":1,"operationId":"op_no_replay"}')],awsRequestId:"req"});
    assert.deepEqual(result,{batchItemFailures:[]});
    assert.equal(started,1);assert.equal(reviewed,1);assert.equal(queued,0);
    assert.equal(operation.status,"review_required");
  }finally{if(oldTarget===undefined)delete process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME;
    else process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME=oldTarget;}
});

test("preview-only operations cannot enter the queue or install a fence", async t => {
  const old={table:process.env.STATE_TABLE_NAME,queue:process.env.ERASURE_OPERATION_QUEUE_URL,
    target:process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME};
  process.env.STATE_TABLE_NAME="test-state";process.env.ERASURE_OPERATION_QUEUE_URL="https://sqs.example/erasure";
  process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME="sync-worker";
  const starts=[],sent=[];
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>({operationId:"preview-only",status:"previewed",providerDeletionReady:false}));
  t.mock.method(ErasureOperationStore.prototype,"startFencedLifecycle",async(...args)=>starts.push(args));
  t.mock.method(SQSClient.prototype,"send",async command=>{sent.push(command.input);return {};});
  try {
    const result=await handler({Records:[record('{"version":1,"operationId":"preview-only"}')],awsRequestId:"req"});
    assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"message-1"}]});
    assert.deepEqual(starts,[]);assert.deepEqual(sent,[]);
  } finally {
    for(const [key,value] of Object.entries({STATE_TABLE_NAME:old.table,ERASURE_OPERATION_QUEUE_URL:old.queue,
      ERASURE_TARGET_WORKER_FUNCTION_NAME:old.target})) if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});

test("revoked readiness freezes an active lifecycle before any provider or queue work",async t=>{
  const operation={operationId:"active-disabled",status:"deleting",providerDeletionReady:false,
    lifecycle:{phase:"delete"}};
  let reviewed=0,advanced=0;
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>operation);
  t.mock.method(ErasureOperationStore.prototype,"markExecutionDisabledReviewRequired",async()=>{
    reviewed++;operation.status="review_required";
  });
  t.mock.method(ErasureOperationStore.prototype,"advanceFencedLifecycle",async()=>{advanced++;});
  const queued=[];t.mock.method(SQSClient.prototype,"send",async command=>{queued.push(command.input);return {};});
  const result=await handler({Records:[record('{"version":1,"operationId":"active-disabled"}')],awsRequestId:"req"});
  assert.deepEqual(result,{batchItemFailures:[]});
  assert.equal(reviewed,1);assert.equal(advanced,0);assert.equal(queued.length,0);
});

test("worker respects durable next-run time and stops before provider deletion", async t => {
  const oldQueue = process.env.ERASURE_OPERATION_QUEUE_URL;
  process.env.ERASURE_OPERATION_QUEUE_URL = "https://sqs.example/erasure";
  const sent = [], advances = [];
  let operation = { operationId: "op_2", status: "fencing", providerDeletionReady:true, lifecycle: { phase: "drain_before_fence", nextRunAt: 1 } };
  t.mock.method(ErasureOperationStore.prototype, "get", async () => operation);
  t.mock.method(ErasureOperationStore.prototype, "advanceFencedLifecycle", async id => {
    advances.push(id);
    return { phase: "install_fence", nextRunAt: Date.now() + 75_000, status: "fencing", waiting: true };
  });
  const deletionStarts=[];
  t.mock.method(ErasureOperationStore.prototype,"beginDeletion",async id=>deletionStarts.push(id));
  let gateReads=0;
  t.mock.method(ErasureOperationStore.prototype, "assertReadyForDelete", async () => { gateReads++; });
  t.mock.method(SQSClient.prototype, "send", async command => { sent.push(command.input); return {}; });
  try {
    let result = await handler({ Records: [record('{"version":1,"operationId":"op_2"}')], awsRequestId: "req" });
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.deepEqual(advances, ["op_2"]);
    assert.ok(sent[0].DelaySeconds >= 74 && sent[0].DelaySeconds <= 75);

    operation = { operationId: "op_2", status: "deleting", providerDeletionReady:true, lifecycle: { phase: "ready_for_delete", nextRunAt: Date.now() } };
    sent.length = 0;
    result = await handler({ Records: [record('{"version":1,"operationId":"op_2"}')], awsRequestId: "req" });
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(sent.length, 1, "the worker queues the first deletion step only after the full action-time gate");
    assert.deepEqual(deletionStarts,["op_2"]);
    assert.deepEqual(advances, ["op_2"]);
  } finally {
    if (oldQueue === undefined) delete process.env.ERASURE_OPERATION_QUEUE_URL; else process.env.ERASURE_OPERATION_QUEUE_URL = oldQueue;
  }
});

test("failed action-time gate becomes durable review-required state and cannot be resumed", async t => {
  let operation = { operationId:"op_drift",status:"deleting",providerDeletionReady:true,lifecycle:{phase:"ready_for_delete",nextRunAt:Date.now()} };
  let gateReads=0,reviewMarks=0;
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>operation);
  t.mock.method(ErasureOperationStore.prototype,"assertReadyForDelete",async()=>{
    gateReads++;
    throw new ErasureGateDriftError();
  });
  t.mock.method(ErasureOperationStore.prototype,"markReviewRequired",async()=>{
    reviewMarks++;
    operation={...operation,status:"review_required"};
  });
  const result=await handler({Records:[record('{"version":1,"operationId":"op_drift"}')],awsRequestId:"req"});
  assert.deepEqual(result,{batchItemFailures:[]},"the failed gate is durably recorded before acknowledging the message");
  assert.equal(operation.status,"review_required");
  assert.equal(reviewMarks,1);
  assert.equal(gateReads,1);

  const duplicate=await handler({Records:[record('{"version":1,"operationId":"op_drift"}')],awsRequestId:"req-duplicate"});
  assert.deepEqual(duplicate,{batchItemFailures:[]});
  assert.equal(gateReads,1,"a duplicate delivery cannot retry a stale deletion gate");
  assert.equal(reviewMarks,1);
});

test("missing replay-marker readiness quarantines before provider deletion and queue continuation",async t=>{
  let operation={operationId:"op_no_replay",status:"deleting",providerDeletionReady:true,
    lifecycle:{phase:"ready_for_delete",nextRunAt:Date.now()}};
  let reviewMarks=0,queued=0;
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>operation);
  t.mock.method(ErasureOperationStore.prototype,"beginDeletion",async()=>{
    throw new ErasureReplayUnavailableError("HMAC replay gate is unavailable");
  });
  t.mock.method(ErasureOperationStore.prototype,"markReviewRequired",async()=>{
    reviewMarks++;operation={...operation,status:"review_required"};
  });
  t.mock.method(SQSClient.prototype,"send",async()=>{queued++;return {};});
  const result=await handler({Records:[record('{"version":1,"operationId":"op_no_replay"}')],awsRequestId:"req"});
  assert.deepEqual(result,{batchItemFailures:[]});
  assert.equal(reviewMarks,1);
  assert.equal(queued,0);
  assert.equal(operation.status,"review_required");
});

test("transient action-time gate read failures are retried instead of marked review-required", async t => {
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>({operationId:"op_read",status:"deleting",
    providerDeletionReady:true,lifecycle:{phase:"ready_for_delete",nextRunAt:Date.now()}}));
  let reviewMarks=0;
  t.mock.method(ErasureOperationStore.prototype,"assertReadyForDelete",async()=>{throw new Error("DynamoDB throttled");});
  t.mock.method(ErasureOperationStore.prototype,"markReviewRequired",async()=>{reviewMarks++;});
  const result=await handler({Records:[record('{"version":1,"operationId":"op_read"}')],awsRequestId:"req"});
  assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"message-1"}]});
  assert.equal(reviewMarks,0,"only a definite invariant mismatch is terminal");
});

test("disabled deployment cannot start a previously approved queued operation",async t=>{
  process.env.ERASURE_EXECUTION_ENABLED="false";
  t.after(()=>{process.env.ERASURE_EXECUTION_ENABLED="true";});
  const starts=[],queues=[];
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>({
    operationId:"approved",status:"queued",providerDeletionReady:true
  }));
  t.mock.method(ErasureOperationStore.prototype,"startFencedLifecycle",async()=>starts.push(true));
  t.mock.method(SQSClient.prototype,"send",async command=>{queues.push(command);return {};});
  const result=await handler({Records:[record('{"version":1,"operationId":"approved"}')],awsRequestId:"req"});
  assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"message-1"}]});
  assert.deepEqual(starts,[]);assert.deepEqual(queues,[]);
});

test("revoking deployment flag during execution enters review-required without additional writes",async t=>{
  process.env.ERASURE_EXECUTION_ENABLED="false";
  t.after(()=>{process.env.ERASURE_EXECUTION_ENABLED="true";});
  let reviews=0,advances=0;
  t.mock.method(ErasureOperationStore.prototype,"get",async()=>({
    operationId:"active",status:"deleting",providerDeletionReady:true,lifecycle:{phase:"delete"}
  }));
  t.mock.method(ErasureOperationStore.prototype,"markExecutionDisabledReviewRequired",async()=>{reviews++;});
  t.mock.method(ErasureOperationStore.prototype,"advanceFencedLifecycle",async()=>{advances++;});
  const result=await handler({Records:[record('{"version":1,"operationId":"active"}')],awsRequestId:"req"});
  assert.deepEqual(result,{batchItemFailures:[]});
  assert.equal(reviews,1);assert.equal(advances,0);
});

test("malformed and failed erasure messages are retried through partial batch failure", async t => {
  t.mock.method(ErasureOperationStore.prototype, "get", async () => { throw new Error("temporary read failure"); });
  const result = await handler({ Records: [record("bad", "bad-message"), record('{"version":1,"operationId":"op"}', "retry-message")], awsRequestId: "req" });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "bad-message" }, { itemIdentifier: "retry-message" }] });
});
