import assert from "node:assert/strict";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { enqueueDelivery, messageDeduplicationId } from "../dist/queue.js";

const reportedId = "136357225910187fbd02c4c321c241fa57494e8c036e01a168373ec3c8506a43:orphan:6tgjepj170rjeb9icgs68b9k6orjgbb1cksmcb9o68pm8c3161h3ep32cc:6hpX9fgPf652P79j";
const identity = { profile: "home", kind: "orphan", id: reportedId };

test("all delivery IDs become fixed-length SQS tokens, including short and long provider IDs", () => {
  assert.equal(reportedId.length, 147);
  for (const id of ["short-id", "a".repeat(128), reportedId, "x".repeat(4096), "has spaces", "unicode-\u00e9", ""]) {
    for (const kind of ["calendar", "todoist", "orphan", "reconcile", "manual"]) {
      const delivery = { ...identity, id, kind };
      const token = messageDeduplicationId(delivery);
      assert.match(token, /^[a-f0-9]{64}$/);
      assert.notEqual(token, id);
      assert.equal(messageDeduplicationId({ ...delivery }), token);
    }
  }
});

test("deduplication separates profiles, kinds, and complete logical IDs", () => {
  const deliveries = [
    identity,
    { ...identity, profile: "work" },
    { ...identity, profile: "antonio" },
    { ...identity, kind: "calendar" },
    { ...identity, id: reportedId.replace(/^1/, "2") }, // Different parent notification.
    { ...identity, id: reportedId.replace(":orphan:6", ":orphan:7") }, // Different event.
    { ...identity, id: reportedId.slice(0, -1) + "k" }, // Different task beyond character 128.
    { profile: "home", kind: "reconcile", id: "reconcile:home:generation-1:chunk:1" },
    { profile: "home", kind: "reconcile", id: "reconcile:home:generation-1:chunk:2" },
    { profile: "home", kind: "reconcile", id: "reconcile:home:generation-2:chunk:1" },
  ];
  assert.equal(new Set(deliveries.map(messageDeduplicationId)).size, deliveries.length);
});

test("retry metadata does not change the token for the same logical delivery", () => {
  assert.equal(
    messageDeduplicationId({ ...identity, receivedAt: "2026-10-20T00:00:00Z", headers: {}, body: "first" }),
    messageDeduplicationId({ ...identity, receivedAt: "2026-10-20T00:01:00Z", headers: { retry: "2" }, body: "second" }),
  );
});

test("enqueueDelivery hashes every kind while preserving its body and per-profile ordering", async () => {
  const originalSend = SQSClient.prototype.send;
  const originalDocumentSend = documentClient.send;
  const originalQueueUrl = process.env.QUEUE_URL;
  const originalProtocolVersion = process.env.ERASURE_PROTOCOL_VERSION;
  const commands = [];
  SQSClient.prototype.send = async function (command) {
    commands.push(command);
    return {};
  };
  documentClient.send = async () => ({});
  process.env.QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/123456789012/test.fifo";
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  const deliveries = ["calendar", "todoist", "orphan", "reconcile", "manual"].map((kind) => ({
    ...identity,
    kind,
    mode: "aws",
    receivedAt: "2026-10-20T00:00:00.000Z",
    headers: {},
    body: "",
  }));
  const originalBodies = deliveries.map((delivery) => JSON.stringify(delivery));
  try {
    for (const delivery of deliveries) await enqueueDelivery(delivery);
  } finally {
    SQSClient.prototype.send = originalSend;
    documentClient.send = originalDocumentSend;
    if (originalQueueUrl === undefined) delete process.env.QUEUE_URL;
    else process.env.QUEUE_URL = originalQueueUrl;
    if (originalProtocolVersion === undefined) delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION = originalProtocolVersion;
  }

  assert.equal(commands.length, deliveries.length);
  commands.forEach((command, index) => {
    assert.match(command.input.MessageDeduplicationId, /^[a-f0-9]{64}$/);
    assert.equal(command.input.MessageDeduplicationId, messageDeduplicationId(deliveries[index]));
    assert.equal(command.input.MessageBody, JSON.stringify({ ...deliveries[index], erasureEpoch: 0 }));
    assert.equal(JSON.stringify(deliveries[index]), originalBodies[index]);
    assert.equal(command.input.MessageGroupId, "sync:home");
  });
});
