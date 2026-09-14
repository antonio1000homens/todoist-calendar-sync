import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { calendarWatchToken, profileForChannel, profileForTodoistRoute, proxySharedSecret, todoistWebhookSecret } from "./config.js";
import { enqueueDelivery } from "./queue.js";
import { equalSecret, sha256, validTodoistSignature } from "./security.js";
import type { Delivery, Profile } from "./types.js";

const RETIRED_ROUTES = new Set(["/oauth", "/github", "/todoist-lambda", "/slackevents", "/gmail-webhook", "/mail-webhooks", "/slackmodals"]);

function response(statusCode: number, payload: Record<string, unknown>): LambdaFunctionURLResult {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(payload) };
}

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-ingress", event, ...detail }));
}

function logError(event: string, error: unknown, detail: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    service: "todoist-calendar-sync-ingress",
    event,
    ...detail,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  }));
}

function normalizedHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => [key.toLowerCase(), value]));
}

function sanitizedProviderMetadata(kind: Delivery["kind"], headers: Record<string, string>): Record<string, string> {
  const allowed = kind === "calendar"
    ? ["x-goog-channel-id", "x-goog-message-number", "x-goog-resource-id", "x-goog-resource-state"]
    : ["x-todoist-delivery-id", "x-request-id"];
  return Object.fromEntries(allowed.flatMap((name) => headers[name] ? [[name, headers[name]]] : []));
}

function rawBody(event: LambdaFunctionURLEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function deliveryId(kind: Delivery["kind"], profile: Profile, headers: Record<string, string>, body: string): string {
  const providerId = kind === "calendar"
    ? `${headers["x-goog-channel-id"] || ""}:${headers["x-goog-message-number"] || ""}`
    : headers["x-todoist-delivery-id"] || headers["x-request-id"] || "";
  return sha256([kind, profile, providerId, body].join("\n"));
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const path = event.rawPath || "/";
  const method = event.requestContext.http.method;
  if (method === "GET" && path === "/healthz") return response(200, { ok: true, service: "todoist-calendar-sync" });
  if (RETIRED_ROUTES.has(path)) return response(410, { error: "route_retired" });
  if (method !== "POST") return response(405, { error: "method_not_allowed" });

  const headers = normalizedHeaders(event.headers);
  if (!equalSecret(headers["x-gcp-proxy-auth"], await proxySharedSecret())) {
    log("webhook_rejected", { path, reason: "unauthorized_proxy" });
    return response(401, { error: "unauthorized_proxy" });
  }

  const body = rawBody(event);
  let kind: Delivery["kind"];
  let profile: Profile | undefined;
  if (path === "/calendar") {
    kind = "calendar";
    profile = profileForChannel(headers["x-goog-channel-id"]);
    if (!profile || !equalSecret(headers["x-goog-channel-token"], await calendarWatchToken())) {
      log("webhook_rejected", { path, kind, profile, reason: "invalid_calendar_channel" });
      return response(401, { error: "invalid_calendar_channel" });
    }
  } else {
    kind = "todoist";
    profile = profileForTodoistRoute(path);
    if (!profile) return response(404, { error: "not_found" });
    if (!validTodoistSignature(body, headers["x-todoist-hmac-sha256"], await todoistWebhookSecret())) {
      log("webhook_rejected", { path, kind, profile, reason: "invalid_todoist_signature" });
      return response(401, { error: "invalid_todoist_signature" });
    }
  }

  const mode = "aws" as const;
  const id = deliveryId(kind, profile, headers, body);
  const delivery: Delivery = {
    id,
    kind,
    profile,
    mode,
    receivedAt: new Date().toISOString(),
    headers: sanitizedProviderMetadata(kind, headers),
    body,
  };

  log("webhook_validated", {
    deliveryId: id,
    kind,
    profile,
    bodyBytes: Buffer.byteLength(body),
    providerMetadata: delivery.headers,
  });

  try {
    await enqueueDelivery(delivery);
  } catch (error) {
    logError("webhook_enqueue_failed", error, { deliveryId: id, kind, profile });
    throw error;
  }

  log("webhook_enqueued", { deliveryId: id, kind, profile, messageGroup: `sync:${profile}` });
  return response(202, { accepted: true, profile, mode, deliveryId: id });
}
