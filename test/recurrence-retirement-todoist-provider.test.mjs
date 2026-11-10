import test from "node:test";
import assert from "node:assert/strict";
import { Todoist } from "../dist/providers.js";

const completedAt = "2026-10-21T13:00:00Z";
const completedPath = "/api/v1/tasks/completed/by_completion_date";
const completedPage = (data) => new Response(JSON.stringify(data), {
  status: 200, headers: { "content-type": "application/json" },
});

// The stable contract is Todoist API v1: timestamp window, id identity,
// paginated "items" response and fail-closed handling of incomplete pages.
test("completed-task lookup uses Todoist API v1 datetime window, id and every page", async t => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (value, init) => {
    const url = new URL(value.toString());
    urls.push(url);
    assert.equal((init?.method || "GET").toUpperCase(), "GET");
    assert.equal(url.pathname, completedPath);
    for (const parameter of ["since", "until"]) {
      assert.match(url.searchParams.get(parameter), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
    assert.equal(url.searchParams.get("limit"), "200");
    const items = url.searchParams.has("cursor")
      ? [{ id: "expected", content: "completed", completed_at: completedAt, is_deleted: false }]
      : [{ id: "unrelated", content: "other", completed_at: "2026-10-20T12:00:00Z", is_deleted: false }];
    return completedPage({ items, next_cursor: urls.length === 1 ? "second-page" : null });
  });
  const found = await new Todoist("test-token").findCompletedTaskById("expected", completedAt);
  assert.equal(found.id, "expected");
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("cursor"), "second-page");
  assert.equal(urls[0].searchParams.get("since"), "2026-10-18T13:00:00.000Z");
  assert.equal(urls[0].searchParams.get("until"), "2026-10-24T13:00:00.000Z");
});

test("completed-task lookup rejects invalid schema and repeated pagination cursors", async t => {
  const cases = [
    {
      name: "item has deprecated task_id instead of id",
      response: { items: [{ task_id: "wrong-schema", completed_at: completedAt }], next_cursor: null },
      taskId: "wrong-schema",
      rejection: /unverified entry/,
    },
    {
      name: "provider repeats next_cursor forever",
      response: { items: [], next_cursor: "repeated" },
      taskId: "missing",
      rejection: /repeated an invalid cursor/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async subtest => {
      subtest.mock.method(globalThis, "fetch", async () => completedPage(scenario.response));
      await assert.rejects(
        new Todoist("test-token").findCompletedTaskById(scenario.taskId, completedAt),
        scenario.rejection,
      );
    });
  }
});
