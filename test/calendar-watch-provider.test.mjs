import assert from "node:assert/strict";
import test from "node:test";
import { GoogleCalendar } from "../dist/providers.js";

test("Google Calendar watch creates and stops a webhook channel", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
    }
    if (url.endsWith("/events/watch")) {
      return new Response(JSON.stringify({ resourceId: "resource-1", expiration: String(Date.now() + 86_400_000) }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  try {
    const calendar = new GoogleCalendar({ client_id: "id", client_secret: "secret", refresh_token: "refresh" }, "home@example.test");
    const created = await calendar.watch("home-calendar-sync-v3-1", "https://calendar-sync.example/calendar", "watch-token");
    await calendar.stopWatch("home-calendar-sync-v3-1", created.resourceId);
    assert.equal(calls.filter(({ url }) => url.endsWith("/events/watch")).length, 1);
    const watch = calls.find(({ url }) => url.endsWith("/events/watch"));
    assert.deepEqual(JSON.parse(watch.init.body), {
      id: "home-calendar-sync-v3-1",
      type: "web_hook",
      address: "https://calendar-sync.example/calendar",
      token: "watch-token",
    });
    assert.match(calls.at(-1).url, /\/channels\/stop$/);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { id: "home-calendar-sync-v3-1", resourceId: "resource-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
