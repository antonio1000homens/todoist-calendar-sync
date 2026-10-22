import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPLETED_TASK_GRACE_MS, terminalCompletionDecision, protectUnmappedCompletedHistory,
} from "../dist/completed-history-policy.js";

const completedAt = "2026-10-01T12:00:00.000Z";
const boundary = Date.parse(completedAt) + COMPLETED_TASK_GRACE_MS;
const oneOff = (extra = {}) => ({
  profile: "home", taskId: "task-1", eventId: "event-1", completedAt, ...extra,
});

test("seven full days, not calendar days or last updatedAt, determine eligibility", () => {
  const projection = oneOff({ updatedAt: "2026-10-08T13:00:00Z" });
  assert.equal(terminalCompletionDecision([projection], boundary - 1), "too_recent");
  assert.equal(terminalCompletionDecision([projection], boundary), "eligible");
  assert.equal(terminalCompletionDecision([projection], boundary + 1), "eligible");
  assert.equal(protectUnmappedCompletedHistory([projection], boundary - 1), false);
  assert.equal(protectUnmappedCompletedHistory([projection], boundary), true);
});

test("all three profiles support one-off terminal cleanup and malformed state fails closed", () => {
  for (const profile of ["home", "antonio", "work"]) {
    assert.equal(terminalCompletionDecision([oneOff({ profile })], boundary), "eligible");
  }
  assert.equal(terminalCompletionDecision([oneOff({ completedAt: "not-a-date" })], boundary), "ambiguous");
  assert.equal(terminalCompletionDecision([oneOff({ profile: "other" })], boundary), "ambiguous");
  assert.equal(terminalCompletionDecision([oneOff(), oneOff({ eventId: "event-2", taskId: "new-task" })], boundary), "ambiguous");
  assert.equal(terminalCompletionDecision([oneOff({ completedAt: "2026-10-31T12:00:00Z" })], boundary), "ambiguous");
});

test("weekly/yearly active recurrence occurrence history is never terminal by age", () => {
  for (const owner of ["calendar", "todoist"]) {
    const previous = oneOff({ recurrenceOwner: owner, seriesId: "series-1" });
    const another = oneOff({ ...previous, eventId: "next-instance", completedAt: "2026-10-05T12:00:00Z" });
    assert.equal(terminalCompletionDecision([previous], boundary + 365 * 86_400_000), "ambiguous");
    assert.equal(terminalCompletionDecision([previous, another], boundary + 365 * 86_400_000), "ambiguous");
    const verified = { ...another, terminalVerified: true };
    assert.equal(terminalCompletionDecision([previous, verified], Date.parse(verified.completedAt) + COMPLETED_TASK_GRACE_MS - 1), "too_recent");
    assert.equal(terminalCompletionDecision([previous, verified], Date.parse(verified.completedAt) + COMPLETED_TASK_GRACE_MS), "eligible");
    assert.equal(terminalCompletionDecision([previous, { ...verified, seriesId: "different" }], boundary + 365 * 86_400_000), "ambiguous");
  }
});
