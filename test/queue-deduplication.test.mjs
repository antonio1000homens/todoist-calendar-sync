import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { enqueueDelivery, messageDeduplicationId } from "../dist/queue.js";

test("deduplication IDs retain valid values and hash values SQS cannot accept", () => {
  assert.equal(messageDeduplicationId("delivery:home:gen-1"), "delivery:home:gen-1");
  assert.equal(messageDeduplicationId("a".repeat(128)), "a".repeat(128));

  const reportedId = "136357225910187fbd02c4c321c241fa57494e8c036e01a168373ec3c8506a43:orphan:6tgjepj170rjeb9icgs68b9k6orjgbb1cksmcb9o68pm8c3161h3ep32cc:6hpX9fgPf652P79j";
  const oversized = "a".repeat(128) + "b";
  for (const id of [reportedId, oversized, "has spaces", "contains-☃", ""]) {
    const deduplicationId = messageDeduplicationId(id);
    assert.equal(deduplicationId, `sha256:${createHash("sha256").update(id).digest("hex")}`);
    assert.ok(deduplicationId.length <= 128);
    assert.match(deduplicationId, /^[\x21-\x7e]+$/);
    assert.equal(messageDeduplicationId(id), deduplicationId);
  }
  assert.notEqual(messageDeduplicationId("x".repeat(129)), messageDeduplicationId("x".repeat(128) + "y"));
});

test("enqueueDelivery sends a valid token while retaining the original delivery ID in the body", async () => {
  const originalSend = SQSClient.prototype.send;
  let command;
  SQSClient.prototype.send = async function (value) {
    command = value;
    return {};
  };
  process.env.QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/123456789012/test.fifo";

  const delivery = {
    id: `source:${"event".repeat(30)}:${"task".repeat(30)}`,
    kind: "orphan",
    profile: "home",
    mode: "aws",
    receivedAt: "2026-10-20T00:00:00.000Z",
    headers: {},
    body: "",
  };

  try {
    await enqueueDelivery(delivery);
  } finally {
    SQSClient.prototype.send = originalSend;
  }

  assert.equal(command.input.MessageDeduplicationId, messageDeduplicationId(delivery.id));
  assert.equal(command.input.MessageBody, JSON.stringify(delivery));
  assert.equal(command.input.MessageGroupId, "sync:home");
});
