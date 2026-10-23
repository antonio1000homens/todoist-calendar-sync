import test from "node:test";
import assert from "node:assert/strict";
import { SQSClient } from "@aws-sdk/client-sqs";
import { enqueueErasureOperation, erasureOperationDelaySeconds } from "../dist/erasure-queue.js";

test("erasure self-dispatch delay respects SQS bounds and durable deadlines", () => {
  assert.equal(erasureOperationDelaySeconds(undefined, 1000), 0);
  assert.equal(erasureOperationDelaySeconds(1501, 1000), 1);
  assert.equal(erasureOperationDelaySeconds(1000, 1000), 0);
  assert.equal(erasureOperationDelaySeconds(2_000_000, 1000), 900);
  assert.throws(() => erasureOperationDelaySeconds(Number.NaN), /Invalid erasure operation next-run time/);
});

test("erasure messages contain only a validated durable operation id", async t => {
  const oldUrl = process.env.ERASURE_OPERATION_QUEUE_URL;
  process.env.ERASURE_OPERATION_QUEUE_URL = "https://sqs.example/erasure";
  const sent = [];
  t.mock.method(SQSClient.prototype, "send", async command => { sent.push(command.input); return {}; });
  try {
    await enqueueErasureOperation("operation_1", 20_000,);
    assert.deepEqual(JSON.parse(sent[0].MessageBody), { version: 1, operationId: "operation_1" });
    assert.deepEqual(Object.keys(JSON.parse(sent[0].MessageBody)).sort(), ["operationId", "version"]);
    await assert.rejects(enqueueErasureOperation("bad/id"), /Invalid erasure operation ID/);
    assert.equal(sent.length, 1);
  } finally {
    if (oldUrl === undefined) delete process.env.ERASURE_OPERATION_QUEUE_URL;
    else process.env.ERASURE_OPERATION_QUEUE_URL = oldUrl;
  }
});
