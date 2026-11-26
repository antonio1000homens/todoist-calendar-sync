import assert from "node:assert/strict";
import test from "node:test";
import { GoogleCalendar, Todoist, withTodoistInventoryScope } from "../dist/providers.js";

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

test("Todoist project inventories coalesce across client instances for one sync operation", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.ok(String(url).endsWith("/sync"));
    return Response.json({
      full_sync: true, sync_token: "snapshot-token", full_sync_date_utc: new Date().toISOString(),
      items: [], notes: [], projects: [{ id: "project-1" }, { id: "project-2" }],
      project_notes: [
        { id: "comment-1", project_id: "project-1", content: "mapping" },
        { id: "comment-2", project_id: "project-2", content: "other profile mapping" },
      ],
    });
  };
  await withTodoistInventoryScope(async () => {
    const first = new Todoist("inventory-scope-token");
    const second = new Todoist("inventory-scope-token");
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      (index % 2 ? first : second).listProjectComments(index % 5 ? "project-1" : "project-2", true)));
    assert.ok(results.flat().some(comment => comment.id === "comment-1"));
    assert.ok(results.flat().some(comment => comment.id === "comment-2"));
    assert.equal(calls, 1);
  });
  await withTodoistInventoryScope(async () => {
    await new Todoist("inventory-scope-token").listProjectComments("project-1", true);
  });
  assert.equal(calls, 2, "a fresh operation must fetch fresh provider evidence");
});

test("Todoist Sync timezone reads enter account pacing and share long 429 cooldowns", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error_tag: "LIMITS_REACHED", error_extra: { retry_after: 1280 } }, { status: 429 });
  };
  const token = "sync-cooldown-token";
  await assert.rejects(() => new Todoist(token).getTimeZone(), error => error.status === 429 && error.retryAfterMs === 1_280_000);
  await assert.rejects(() => new Todoist(token).listProjectComments("project-1", true), error => error.status === 429);
  assert.equal(calls, 1, "the second client must honor the first client's account cooldown");
});

test("task inventories and account timezone are reused per operation and task writes invalidate indexes", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  let title = "Initial";
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, method: init.method || "GET" });
    if (parsed.pathname.endsWith("/sync")) return Response.json({
      full_sync: true, sync_token: "snapshot-token", full_sync_date_utc: new Date().toISOString(),
      user: { timezone: "Europe/London" },
      items: [{ id: "task-1", content: title, project_id: "project-1" }],
      notes: [], project_notes: [], projects: [{ id: "project-1" }],
    });
    if (parsed.pathname.endsWith("/tasks/task-1") && init.method === "POST") {
      title = "Updated";
      return Response.json({ id: "task-1", content: title });
    }
    if (parsed.pathname.endsWith("/tasks/task-1")) return Response.json({ id: "task-1", content: title });
    return Response.json({ results: [{ id: "task-1", content: title, project_id: "project-1" }], next_cursor: null });
  };

  await withTodoistInventoryScope(async () => {
    const first = new Todoist("task-inventory-token");
    const second = new Todoist("task-inventory-token");
    const [tasksA, tasksB, zoneA, zoneB] = await Promise.all([
      first.listTasks("project-1"), second.listTasks("project-1"), first.getTimeZone(), second.getTimeZone(),
    ]);
    assert.equal(tasksA[0].content, "Initial");
    assert.equal(tasksB[0].content, "Initial");
    assert.equal(zoneA, "Europe/London");
    assert.equal(zoneB, "Europe/London");
    assert.equal(calls.filter(call => call.url.pathname.endsWith("/sync")).length, 1,
      "one full Sync snapshot supplies task inventory and account timezone");

    await first.updateTaskMetadata("task-1", { content: "Updated", description: "" });
    assert.equal((await second.listTasks("project-1"))[0].content, "Updated");
    assert.equal(calls.filter(call => call.url.pathname.endsWith("/sync")).length, 2,
      "a successful task write invalidates the scoped collection snapshot");
  });
});

test("an incomplete or stale Sync snapshot falls back to complete paginated REST comments", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/sync")) return Response.json({
      full_sync: true, sync_token: "snapshot-token",
      full_sync_date_utc: new Date(Date.now() - 10 * 60_000).toISOString(),
      items: [], notes: [], projects: [{ id: "project-1" }],
      project_notes: [{ id: "incomplete-comment", content: "mapping without project scope" }],
    });
    if (!parsed.searchParams.has("cursor")) return Response.json({
      results: [{ id: "comment-1", project_id: "project-1", content: "first" }], next_cursor: "cursor-2",
    });
    return Response.json({
      results: [{ id: "comment-2", project_id: "project-1", content: "second" }], next_cursor: null,
    });
  };
  const comments = await withTodoistInventoryScope(() =>
    new Todoist("snapshot-fallback-token").listProjectComments("project-1", true));
  assert.deepEqual(comments.map(comment => comment.id), ["comment-1", "comment-2"]);
  assert.equal(calls, 3, "one rejected snapshot is followed by the complete two-page REST traversal");
});
