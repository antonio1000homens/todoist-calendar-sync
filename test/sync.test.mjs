import assert from "node:assert/strict";
import test from "node:test";
import { canRecreateCalendarProjection, hasCanonicalState, matchingTask, toCalendarEvent, toTodoistTask, todoistCalendarLifecycle } from "../dist/sync.js";
import { todoistTaskPayload } from "../dist/providers.js";
import { todoistRecurrenceToRrule } from "../dist/todoist-recurrence.js";
import { validTodoistSignature } from "../dist/security.js";
import { createHmac } from "node:crypto";

test("matches Calendar events by normalized title and all-day date", () => {
  const event = { id: "event-1", summary: "  Pay\nInvoice ", start: { date: "2026-09-01" } };
  const tasks = [
    { id: "wrong-date", content: "pay invoice", due: { date: "2026-09-02" } },
    { id: "match", content: "Pay invoice for August", due: { date: "2026-09-01" } },
  ];
  assert.equal(matchingTask(event, tasks)?.id, "match");
});

test("converts Calendar all-day and timed representations into Todoist", () => {
  const allDay = toTodoistTask({ id: "event-1", summary: "All day", start: { date: "2026-09-01" } });
  assert.deepEqual(allDay.due, { date: "2026-09-01" });
  const timed = toTodoistTask({ id: "event-2", summary: "Timed", start: { dateTime: "2026-09-01T09:30:00+01:00", timeZone: "Europe/London" } });
  assert.deepEqual(timed.due, { datetime: "2026-09-01T09:30:00+01:00", timezone: "Europe/London" });
});

test("converts Todoist all-day and timed representations into valid Calendar spans", () => {
  const allDay = toCalendarEvent({ id: "task-all-day", content: "All day", due: { date: "2026-09-01" } });
  assert.deepEqual(allDay.start, { date: "2026-09-01" });
  assert.deepEqual(allDay.end, { date: "2026-09-02" });
  assert.equal(allDay.start.dateTime, undefined);
  assert.equal(allDay.end.dateTime, undefined);
  const calendar = toCalendarEvent({ id: "task-1", content: "Timed", due: { datetime: "2026-09-01T09:30:00+01:00", timezone: "Europe/London" } });
  assert.equal(calendar.start.dateTime, "2026-09-01T09:30:00+01:00");
  assert.equal(Date.parse(calendar.end.dateTime) - Date.parse(calendar.start.dateTime), 30 * 60_000);
  assert.equal(calendar.extendedProperties.shared.taskId, "task-1");
  const v1Timed = toCalendarEvent({ id: "task-v1", content: "Timed v1", due: { date: "2026-09-01T09:30:00Z", timezone: "Europe/London" } });
  assert.equal(v1Timed.start.dateTime, "2026-09-01T09:30:00Z");
  assert.equal(v1Timed.start.date, undefined);
});

test("rejects undated Todoist tasks from Calendar projection", () => {
  assert.throws(() => toCalendarEvent({ id: "task-undated", content: "No date", due: null }), /undated Todoist task/);
  assert.throws(() => toCalendarEvent({ id: "task-empty-due", content: "No usable date", due: {} }), /undated Todoist task/);
});

test("classifies Todoist due removal separately from deletion and completion", () => {
  const due = { date: "2026-09-01" };
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-1", content: "Task", due: null }, event_data_extra: { old_item: { id: "task-1", content: "Task", due } } }), {
    action: "delete_projection",
    reason: "due_removed",
    dueAdded: false,
  });
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-empty", content: "Task", due: {} }, event_data_extra: { old_item: { id: "task-empty", content: "Task", due } } }), {
    action: "delete_projection",
    reason: "due_removed",
    dueAdded: false,
  });
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-2", content: "Task", due: null } }), {
    action: "skip",
    reason: "undated",
    dueAdded: false,
  });
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-empty-new", content: "Task", due: {} } }), {
    action: "skip",
    reason: "undated",
    dueAdded: false,
  });
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-3", content: "Task", due: { date: "2026-09-02" } }, event_data_extra: { old_item: { id: "task-3", content: "Task", due: null } } }), {
    action: "upsert",
    reason: "eligible",
    dueAdded: true,
  });
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:completed", event_data: { id: "task-4", content: "Task", due } }), {
    action: "delete_projection",
    reason: "completed",
    dueAdded: false,
  });
  assert.deepEqual(todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-5", content: "Recurring", due: null }, event_data_extra: { old_item: { id: "task-5", content: "Recurring", due: { ...due, is_recurring: true } } } }), {
    action: "skip",
    reason: "undated",
    dueAdded: false,
  });
});

test("allows a newer due-date re-add but suppresses stale dated webhooks", () => {
  const readded = todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-1", content: "Task", due: { date: "2026-09-02" }, updated_at: "2026-09-01T12:01:00Z" }, event_data_extra: { old_item: { id: "task-1", content: "Task", due: null } } });
  assert.equal(canRecreateCalendarProjection(readded, "2026-09-01T12:01:00Z", "2026-09-01T12:00:00Z"), true);
  const stale = todoistCalendarLifecycle({ event_name: "item:updated", event_data: { id: "task-1", content: "Task", due: { date: "2026-09-01" }, updated_at: "2026-09-01T11:59:00Z" }, event_data_extra: { old_item: { id: "task-1", content: "Task", due: { date: "2026-08-31" } } } });
  assert.equal(canRecreateCalendarProjection(stale, "2026-09-01T11:59:00Z", "2026-09-01T12:00:00Z"), false);
  assert.equal(canRecreateCalendarProjection(stale, "2026-09-01T12:00:00Z", "2026-09-01T12:00:00Z"), false);
});

test("preserves duration within a representation and resets it when converting representations", () => {
  const timedEvent = {
    id: "event-timed",
    summary: "Task",
    start: { dateTime: "2026-09-01T09:30:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-09-01T10:45:00+01:00", timeZone: "Europe/London" },
  };
  const timed = toCalendarEvent({ id: "task", content: "Task", due: { datetime: "2026-09-02T09:30:00+01:00", timezone: "Europe/London" } }, timedEvent);
  assert.equal(Date.parse(timed.end.dateTime) - Date.parse(timed.start.dateTime), 75 * 60_000);

  const allDay = toCalendarEvent({ id: "task", content: "Task", due: { date: "2026-09-02" } }, timedEvent);
  assert.deepEqual(allDay.start, { date: "2026-09-02" });
  assert.deepEqual(allDay.end, { date: "2026-09-03" });

  const timedFromAllDay = toCalendarEvent({ id: "task", content: "Task", due: { datetime: "2026-09-02T09:30:00Z", timezone: "Europe/London" } }, allDay);
  assert.equal(Date.parse(timedFromAllDay.end.dateTime) - Date.parse(timedFromAllDay.start.dateTime), 30 * 60_000);
});

test("detects canonical state to suppress bidirectional echo webhooks", () => {
  const task = { id: "task-1", content: "  Pay\ninvoice ", description: "  September ", due: { datetime: "2026-09-01T08:30:00Z", timezone: "Europe/London" } };
  const syncedEvent = {
    id: "event-1",
    summary: "Pay invoice",
    description: "September",
    start: { dateTime: "2026-09-01T09:30:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2026-09-01T10:00:00+01:00", timeZone: "Europe/London" },
  };
  assert.equal(hasCanonicalState(syncedEvent, task), true);
  const floatingTask = { ...task, due: { date: "2026-09-01T09:30:00" } };
  assert.equal(hasCanonicalState(syncedEvent, floatingTask), true);
  assert.equal(hasCanonicalState({ ...syncedEvent, start: { date: "2026-09-01" }, end: { date: "2026-09-02" } }, task), false);
});

test("clears stale timed Todoist fields when Calendar becomes all-day", () => {
  assert.deepEqual(todoistTaskPayload({ content: "All day", due: { date: "2026-09-01" } }), {
    content: "All day",
    description: "",
    due_date: "2026-09-01",
    due_datetime: null,
    due_timezone: null,
  });
  assert.deepEqual(todoistTaskPayload({ content: "Timed", due: { datetime: "2026-09-01T09:30:00Z", timezone: "Europe/London" } }), {
    content: "Timed",
    description: "",
    due_datetime: "2026-09-01T09:30:00Z",
    due_timezone: "Europe/London",
  });
});

test("projects supported Todoist recurrence as a Calendar RRULE master", () => {
  const task = { id: "task-1", content: "Daily", due: { date: "2026-09-01", string: "every day", is_recurring: true } };
  const event = toCalendarEvent(task);
  assert.deepEqual(event.recurrence, ["RRULE:FREQ=DAILY"]);
  assert.deepEqual(event.start, { date: "2026-09-01" });
  assert.deepEqual(event.end, { date: "2026-09-02" });
  assert.equal(event.extendedProperties.shared.syncRecurrenceOwner, "todoist");
  assert.equal(event.extendedProperties.shared.todoistRecurrence, "every day");
  assert.equal(todoistRecurrenceToRrule(task), "RRULE:FREQ=DAILY");
});

test("preserves the original RRULE anchor when Todoist advances to its next occurrence", () => {
  const first = { id: "task-1", content: "Daily", due: { date: "2026-09-01", string: "every day", is_recurring: true } };
  const master = { ...toCalendarEvent(first), id: "master-1", status: "confirmed" };
  const advanced = { ...first, due: { ...first.due, date: "2026-09-02" } };
  const updated = toCalendarEvent(advanced, master);
  assert.deepEqual(updated.start, { date: "2026-09-01" });
  assert.deepEqual(updated.end, { date: "2026-09-02" });
  assert.deepEqual(updated.recurrence, ["RRULE:FREQ=DAILY"]);
  assert.equal(hasCanonicalState(master, advanced), true);
});

test("uses rolling fallback for Todoist recurrence expressions without a lossless RRULE mapping", () => {
  const completionRelative = { id: "task-relative", content: "Water plants", due: { date: "2026-09-01", string: "every! 3 days", is_recurring: true } };
  const ordinal = { id: "task-ordinal", content: "Report", due: { date: "2026-09-01", string: "every 1st monday", is_recurring: true } };
  assert.equal(todoistRecurrenceToRrule(completionRelative), undefined);
  assert.equal(todoistRecurrenceToRrule(ordinal), undefined);
  assert.equal(toCalendarEvent(completionRelative).recurrence, undefined);
});

test("translates common interval, weekday and timed recurrence phrases", () => {
  assert.equal(todoistRecurrenceToRrule({ id: "a", content: "A", due: { date: "2026-09-01", string: "every 2 weeks", is_recurring: true } }), "RRULE:FREQ=WEEKLY;INTERVAL=2");
  assert.equal(todoistRecurrenceToRrule({ id: "b", content: "B", due: { date: "2026-09-01", string: "every monday and friday", is_recurring: true } }), "RRULE:FREQ=WEEKLY;BYDAY=MO,FR");
  assert.equal(todoistRecurrenceToRrule({ id: "c", content: "C", due: { datetime: "2026-09-01T09:00:00+01:00", timezone: "Europe/London", string: "every day at 9am", is_recurring: true } }), "RRULE:FREQ=DAILY");
});

test("validates Todoist HMAC over the exact raw body", () => {
  const body = '{"event_name":"item:added"}';
  const secret = "test secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(validTodoistSignature(body, signature, secret), true);
  assert.equal(validTodoistSignature(`${body} `, signature, secret), false);
});
