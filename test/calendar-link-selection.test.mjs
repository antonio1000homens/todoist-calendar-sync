import assert from "node:assert/strict";
import test from "node:test";
import { AmbiguousCalendarLinkError, GoogleCalendar, selectLinkedCalendarEvent } from "../dist/providers.js";

const live = { id: "live", status: "confirmed" };
const cancelled = { id: "cancelled", status: "cancelled" };

test("linked lookup refuses multiple live or mixed live/cancelled events independently of result order", () => {
  for (const candidates of [[live, cancelled], [cancelled, live], [live, { id: "other", status: "confirmed" }]]) {
    assert.throws(() => selectLinkedCalendarEvent("task-1", candidates), (error) =>
      error instanceof AmbiguousCalendarLinkError
      && error.code === "ambiguous_calendar_task_link"
      && error.taskId === "task-1"
      && error.eventIds.length === 2,
    );
  }
});

test("linked lookup accepts a unique cancelled event to preserve the deletion guard", () => {
  assert.equal(selectLinkedCalendarEvent("task-1", []), undefined);
  assert.equal(selectLinkedCalendarEvent("task-1", [cancelled]), cancelled);
  assert.equal(selectLinkedCalendarEvent("task-1", [live, live]), live);
});

test("Google task-ID lookup paginates and fails closed instead of taking first result", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    }
    const page = new URL(String(url)).searchParams.get("pageToken");
    return new Response(JSON.stringify(page
      ? { items: [live] }
      : { items: [cancelled], nextPageToken: "next" }), { status: 200 });
  };
  try {
    const calendar = new GoogleCalendar({ client_id: "id", client_secret: "secret", refresh_token: "refresh" }, "test@example.invalid");
    await assert.rejects(calendar.findByTodoistTaskId("task-1"), AmbiguousCalendarLinkError);
    assert.equal(calls.filter((url) => url.includes("/events?")).length, 2);
    assert.match(calls.at(-1), /pageToken=next/);
    assert.match(calls.at(-1), /showDeleted=true/);
  } finally {
    globalThis.fetch = original;
  }
});
