import assert from "node:assert/strict";
import test from "node:test";
import worker, { canonicalChannelId, profileForChannel } from "./worker.js";

const env = {
  TODOIST_CALENDAR_SYNC_AWS_INGRESS_URL: "https://lambda.example.test/ignored",
  TODOIST_CALENDAR_SYNC_PROXY_SHARED_SECRET: "proxy-secret",
};

test("maps legacy, v2, and current v3 Calendar channels", () => {
  assert.equal(profileForChannel("home1000homens-nrwindsor"), "home");
  assert.equal(profileForChannel("antonio1000homens-calendar-sync-v2"), "antonio");
  assert.equal(profileForChannel("work1000homens-calendar-sync-v3-1720000000000-ab12cd"), "work");
  assert.equal(profileForChannel("work1000homens-calendar-sync-v3"), undefined);
  assert.equal(profileForChannel("unknown"), undefined);
  assert.equal(canonicalChannelId("home1000homens-calendar-sync-v2"), "home1000homens-nrwindsor");
});

test("forwards a Calendar notification with provider headers and replacement auth", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, init) => {
    forwarded = { url: String(url), headers: new Headers(init.headers), body: init.body };
    return new Response("downstream", { status: 202, headers: { "x-downstream": "kept" } });
  };
  try {
    const response = await worker.fetch(new Request("https://calendar-sync.alf-broadcast.co.uk/calendar?source=google", {
      method: "POST",
      headers: {
        "x-goog-channel-id": "home1000homens-calendar-sync-v2",
        "x-goog-message-number": "7",
        "x-goog-resource-id": "resource-1",
        "x-goog-resource-state": "exists",
        "x-gcp-proxy-auth": "spoofed",
        "x-worker-verified": "spoofed",
      },
      body: "{}",
    }), env);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "downstream");
    assert.equal(forwarded.url, "https://lambda.example.test/calendar?source=google");
    assert.equal(forwarded.headers.get("x-goog-message-number"), "7");
    assert.equal(forwarded.headers.get("x-goog-resource-state"), "exists");
    assert.equal(forwarded.headers.get("x-goog-channel-id"), "home1000homens-nrwindsor");
    assert.equal(forwarded.headers.get("x-gcp-proxy-auth"), "proxy-secret");
    assert.equal(forwarded.headers.get("x-worker-verified"), null);
    assert.equal(await new Response(forwarded.body).text(), "{}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects wrong method, path, and channel without forwarding", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("unexpected"); };
  try {
    assert.equal((await worker.fetch(new Request("https://calendar-sync.alf-broadcast.co.uk/calendar", { method: "GET" }), env)).status, 405);
    assert.equal((await worker.fetch(new Request("https://calendar-sync.alf-broadcast.co.uk/other", { method: "POST" }), env)).status, 404);
    assert.equal((await worker.fetch(new Request("https://calendar-sync.alf-broadcast.co.uk/calendar", { method: "POST", headers: { "x-goog-channel-id": "unknown" } }), env)).status, 404);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves downstream failures and fails closed when unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("failed", { status: 503 });
  try {
    const request = new Request("https://calendar-sync.alf-broadcast.co.uk/calendar", { method: "POST", headers: { "x-goog-channel-id": "work1000homens-calendar-sync-v3-1-a" } });
    assert.equal((await worker.fetch(request, env)).status, 503);
    const missing = { ...env };
    delete missing.TODOIST_CALENDAR_SYNC_PROXY_SHARED_SECRET;
    assert.equal((await worker.fetch(new Request(request), missing)).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
