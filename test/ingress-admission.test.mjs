import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { handler } from "../dist/handler.js";

test("Todoist webhook ingress enqueues without consulting persistent erasure admission state", async (t) => {
  const proxyName = "/test/issue184/proxy";
  const webhookName = "/test/issue184/todoist";
  process.env.PROXY_SHARED_SECRET_PARAMETER = proxyName;
  process.env.TODOIST_WEBHOOK_SECRET_PARAMETER = webhookName;
  process.env.QUEUE_URL = "https://sqs.example.test/sync";

  t.mock.method(SSMClient.prototype, "send", async (command) => {
    assert.ok(command instanceof GetParameterCommand);
    const value = command.input.Name === proxyName ? "proxy-secret" : "todoist-secret";
    return { Parameter: { Value: value } };
  });
  t.mock.method(documentClient, "send", async () => { throw new Error("webhook ingress must not read DynamoDB admission state"); });
  const queued = [];
  t.mock.method(SQSClient.prototype, "send", async (command) => {
    assert.ok(command instanceof SendMessageCommand);
    queued.push(command.input);
    return {};
  });

  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const body = JSON.stringify({ event_name: "item:updated" });
  const signature = createHmac("sha256", "todoist-secret").update(body).digest("base64");
  const result = await handler({
    rawPath: "/todoist-home",
    headers: {
      "x-gcp-proxy-auth": "proxy-secret",
      "x-todoist-hmac-sha256": signature,
      "x-todoist-delivery-id": "stable-delivery-1",
    },
    body,
    isBase64Encoded: false,
    requestContext: { http: { method: "POST" } },
  });

  assert.equal(result.statusCode, 202);
  const payload = JSON.parse(result.body);
  assert.equal(payload.accepted, true);
  assert.equal(queued.length, 1);
  assert.equal(JSON.parse(queued[0].MessageBody).kind, "todoist");
  assert.doesNotMatch(errors.join("\n"), /admission|fence|tombstone/i);
});
