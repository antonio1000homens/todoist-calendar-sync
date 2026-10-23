import test from "node:test";
import assert from "node:assert/strict";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureOperationStore } from "../dist/erasure-executor.js";
import { handler, parseErasureQueueRecord } from "../dist/erasure-worker.js";

const record = (body, messageId = "message-1") => ({ body, messageId, receiptHandle: "receipt", attributes: {}, messageAttributes: {}, md5OfBody: "digest", eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:eu-west-2:123:erasure", awsRegion: "eu-west-2" });

test("erasure queue record parser accepts only the versioned operation identity", () => {
  assert.equal(parseErasureQueueRecord(record('{"version":1,"operationId":"op_1"}')), "op_1");
  for (const body of ["{", "[]", "null", '{"version":2,"operationId":"op"}', '{"version":1,"operationId":"op","selection":[]}']) {
    assert.throws(() => parseErasureQueueRecord(record(body)), /Invalid erasure queue message/);
  }
});

test("worker starts only a stored queued operation and self-dispatches its identity", async t => {
  const old = { table: process.env.STATE_TABLE_NAME, queue: process.env.ERASURE_OPERATION_QUEUE_URL,
    target: process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME };
  process.env.STATE_TABLE_NAME = "test-state";
  process.env.ERASURE_OPERATION_QUEUE_URL = "https://sqs.example/erasure";
  process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME = "sync-worker";
  const sent = [], starts = [];
  const operation = { operationId: "op_1", status: "queued" };
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

test("worker respects durable next-run time and stops before provider deletion", async t => {
  const oldQueue = process.env.ERASURE_OPERATION_QUEUE_URL;
  process.env.ERASURE_OPERATION_QUEUE_URL = "https://sqs.example/erasure";
  const sent = [], advances = [];
  let operation = { operationId: "op_2", status: "fencing", lifecycle: { phase: "drain_before_fence", nextRunAt: 1 } };
  t.mock.method(ErasureOperationStore.prototype, "get", async () => operation);
  t.mock.method(ErasureOperationStore.prototype, "advanceFencedLifecycle", async id => {
    advances.push(id);
    return { phase: "install_fence", nextRunAt: Date.now() + 75_000, status: "fencing", waiting: true };
  });
  let gateReads=0;
  t.mock.method(ErasureOperationStore.prototype, "assertReadyForDelete", async () => { gateReads++; });
  t.mock.method(SQSClient.prototype, "send", async command => { sent.push(command.input); return {}; });
  try {
    let result = await handler({ Records: [record('{"version":1,"operationId":"op_2"}')], awsRequestId: "req" });
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.deepEqual(advances, ["op_2"]);
    assert.ok(sent[0].DelaySeconds >= 74 && sent[0].DelaySeconds <= 75);

    operation = { operationId: "op_2", status: "deleting", lifecycle: { phase: "ready_for_delete", nextRunAt: Date.now() } };
    sent.length = 0;
    result = await handler({ Records: [record('{"version":1,"operationId":"op_2"}')], awsRequestId: "req" });
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(sent.length, 0, "the fencing worker stops for the separate confirmed deletion slice");
    assert.equal(gateReads,1,"the full action-time gate is reread before the worker reports ready");
    assert.deepEqual(advances, ["op_2"]);
  } finally {
    if (oldQueue === undefined) delete process.env.ERASURE_OPERATION_QUEUE_URL; else process.env.ERASURE_OPERATION_QUEUE_URL = oldQueue;
  }
});

test("malformed and failed erasure messages are retried through partial batch failure", async t => {
  t.mock.method(ErasureOperationStore.prototype, "get", async () => { throw new Error("temporary read failure"); });
  const result = await handler({ Records: [record("bad", "bad-message"), record('{"version":1,"operationId":"op"}', "retry-message")], awsRequestId: "req" });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "bad-message" }, { itemIdentifier: "retry-message" }] });
});
