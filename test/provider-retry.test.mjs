import assert from "node:assert/strict";
import test from "node:test";
import { GoogleCalendar } from "../dist/providers.js";

const credentials = { client_id: "client", client_secret: "secret", refresh_token: "refresh" };

test("Calendar reads honor Retry-After HTTP dates when retrying an explicit 429", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com/token"))
      return Response.json({ access_token: "test-token" });
    if (calls.filter((value) => value.includes("calendar/v3")).length === 1) {
      const justPassed = new Date(Date.now() - 1000).toUTCString();
      return Response.json({ error: { message: "rate limited" } }, {
        status: 429, headers: { "retry-after": justPassed },
      });
    }
    return Response.json({ items: [], nextSyncToken: "cursor" });
  };

  const calendar = new GoogleCalendar(credentials, "calendar-id", {
    rateLimitRetries: 1, maxRetryDelayMs: 0,
  });
  const result = await calendar.listDelta();
  assert.equal(result.nextSyncToken, "cursor");
  assert.equal(calls.filter((value) => value.includes("calendar/v3")).length, 2);
});

test("Calendar does not retry before a Retry-After longer than the inline retry budget", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com/token"))
      return Response.json({ access_token: "test-token" });
    return Response.json({ error: { message: "rate limited" } }, {
      status: 429, headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() },
    });
  };

  const calendar = new GoogleCalendar(credentials, "calendar-id", {
    rateLimitRetries: 3, maxRetryDelayMs: 0,
  });
  await assert.rejects(() => calendar.listDelta(), { status: 429 });
  assert.equal(calls.filter((value) => value.includes("calendar/v3")).length, 1);
});

test("Calendar incremental reads include cancellations on every page and return only the final sync token", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const urls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "test-token" });
    urls.push(new URL(value));
    if (!new URL(value).searchParams.has("pageToken"))
      return Response.json({ items: [{ id: "updated" }], nextPageToken: "page-2" });
    return Response.json({ items: [{ id: "cancelled", status: "cancelled" }], nextSyncToken: "final-cursor" });
  };

  const calendar = new GoogleCalendar(credentials, "calendar-id");
  const result = await calendar.listDelta("committed-cursor");
  assert.deepEqual(result.items.map(event => event.id), ["updated", "cancelled"]);
  assert.equal(result.items[1].status, "cancelled");
  assert.equal(result.nextSyncToken, "final-cursor");
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.searchParams.get("showDeleted"), "true");
    assert.equal(url.searchParams.get("syncToken"), "committed-cursor");
  }
});
