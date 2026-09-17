import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositorySource = await readFile(new URL("../src/repository.ts", import.meta.url), "utf8");

function method(name, nextName) {
  return repositorySource.match(new RegExp(`async ${name}\\([\\s\\S]*?\\n  async ${nextName}\\(`))?.[0] || "";
}

test("Calendar recurrence-link persistence uses compare-and-swap retries", () => {
  const body = method("putRecurrenceLink", "getRecurrenceLink");
  assert.match(body, /for \(let attempt = 0; attempt < 5; attempt \+= 1\)/);
  assert.match(body, /completedThroughOriginalStart = :expectedCompletedThroughOriginalStart/);
  assert.match(body, /attribute_not_exists\(completedThroughOriginalStart\)/);
  assert.match(body, /calendarProgressVersion = :expectedCalendarProgressVersion/);
  assert.match(body, /attribute_not_exists\(calendarProgressVersion\)/);
  assert.match(body, /conditionalFailure\(error\) && attempt < 4/);
  assert.match(body, /latestOriginalStart\([\s\S]*existing\?\.completedThroughOriginalStart[\s\S]*mappedCalendar\?\.completedThroughOriginalStart[\s\S]*link\.completedThroughOriginalStart/);
});

test("recurrence-link compare-and-swap reads current state consistently", () => {
  const body = repositorySource.match(/async getRecurrenceLink\([\s\S]*?\n  async deleteRecurrenceLink\(/)?.[0] || "";
  assert.match(body, /ConsistentRead:\s*true/);
});
