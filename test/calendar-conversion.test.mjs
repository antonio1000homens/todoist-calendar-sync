import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { GoogleCalendar } from "../dist/providers.js";

test("recurring-to-one-off PATCH clears recurrence metadata and preserves unrelated shared properties", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  const shared = {
    taskId: "task-1",
    unrelatedManagedProperty: "keep-me",
    syncSeriesId: "task-1",
    syncMasterEventId: "master-1",
    syncActiveInstanceId: "instance-1",
    syncOriginalStart: "2026-09-14",
    syncActiveEffectiveStart: "2026-09-14",
    syncProgressVersion: "1",
    syncCompletedThrough: "2026-09-07",
    syncTodoistPhaseBVersion: "1",
    todoistRecurrence: "every monday",
    todoistAnchorStart: "2026-09-14",
    todoistAnchorEnd: "2026-09-15",
    todoistAnchorAllDay: "true",
    todoistAnchorTimeZone: "",
    todoistTemplateSummary: "Task",
    todoistTemplateDescription: "Details",
    todoistPhaseBVersion: "1",
  };
  const current = {
    id: "master-1", status: "confirmed", etag: "etag-1", summary: "Task", description: "Details",
    start: { date: "2026-09-14" }, end: { date: "2026-09-15" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    extendedProperties: { shared, private: { privateProperty: "preserve" } },
  };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "token" });
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.recurrence, []);
      return Response.json({
        ...current, ...body, recurrence: undefined, etag: "etag-2",
        extendedProperties: { ...current.extendedProperties, ...body.extendedProperties },
      });
    }
    return Response.json(current);
  };

  const calendar = new GoogleCalendar(
    { client_id: "client", client_secret: "secret", refresh_token: "refresh" },
    profiles.home.calendarId,
  );
  const converted = await calendar.upsertEvent({
    id: "master-1", summary: "Task", description: "Details",
    start: { date: "2026-09-15" }, end: { date: "2026-09-16" }, recurrence: [],
    extendedProperties: { shared: { taskId: "task-1", taskUrl: "https://app.todoist.com/app/task/task-1" } },
  }, "master-1");

  assert.equal(converted.id, "master-1");
  assert.equal(converted.recurrence, undefined);
  assert.equal(converted.start.date, "2026-09-15");
  assert.equal(converted.extendedProperties.shared.taskId, "task-1");
  assert.equal(converted.extendedProperties.shared.unrelatedManagedProperty, "keep-me");
  assert.deepEqual(converted.extendedProperties.private, { privateProperty: "preserve" });
  for (const key of ["syncSeriesId", "syncMasterEventId", "syncActiveInstanceId", "syncOriginalStart",
    "syncActiveEffectiveStart", "syncProgressVersion", "syncCompletedThrough", "syncTodoistPhaseBVersion",
    "todoistRecurrence", "todoistAnchorStart", "todoistAnchorEnd", "todoistAnchorAllDay",
    "todoistAnchorTimeZone", "todoistTemplateSummary", "todoistTemplateDescription", "todoistPhaseBVersion"]) {
    assert.equal(converted.extendedProperties.shared[key], undefined, `${key} must not survive recurrence removal`);
  }
  assert.equal(calls.filter((call) => call.init.method === "PATCH").length, 1);
  assert.ok(calls.some((call) => (!call.init.method || call.init.method === "GET")
    && call.url.endsWith("/events/master-1")));
});
