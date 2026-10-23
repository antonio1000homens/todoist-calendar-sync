import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { handler } from "../dist/handler.js";

test("DynamoDB admission failure is logged and returned to the provider as retryable, unaccepted", async (t) => {
  const proxyName = "/test/issue184/proxy";
  const webhookName = "/test/issue184/todoist";
  process.env.PROXY_SHARED_SECRET_PARAMETER = proxyName;
  process.env.TODOIST_WEBHOOK_SECRET_PARAMETER = webhookName;
  process.env.ERASURE_PROTOCOL_VERSION = "1";

  t.mock.method(SSMClient.prototype, "send", async (command) => {
    assert.ok(command instanceof GetParameterCommand);
    const value = command.input.Name === proxyName ? "proxy-secret" : "todoist-secret";
    return { Parameter: { Value: value } };
  });
  t.mock.method(documentClient, "send", async (command) => {
    assert.ok(command instanceof GetCommand, "admission must fail at the epoch read before transacting");
    throw Object.assign(new Error("missing dynamodb:GetItem permission"), { name: "AccessDeniedException" });
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

  assert.equal(result.statusCode, 503);
  const payload = JSON.parse(result.body);
  assert.equal(payload.accepted, false);
  assert.equal(payload.error, "enqueue_failed");
  assert.ok(payload.deliveryId);
  assert.match(errors.join("\n"), /webhook_enqueue_failed/);
  assert.match(errors.join("\n"), /AccessDeniedException/);
});
