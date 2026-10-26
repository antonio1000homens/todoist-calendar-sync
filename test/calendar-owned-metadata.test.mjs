import assert from "node:assert/strict";
import test from "node:test";
import { calendarOwnedMetadataResolution } from "../dist/sync.js";

const original = { syncedTitle: "Weekly test", syncedDescription: "Old notes" };
const master = (summary, description = "Old notes") => ({ id: "master", summary, description });
const task = (content, description = "Old notes") => ({ id: "task", content, description });

test("initial sync echo makes no metadata changes", () => {
  const result = calendarOwnedMetadataResolution(original, master("Weekly test"), task("Weekly test"));
  assert.deepEqual(result, { summary: "Weekly test", description: "Old notes", calendarChanged: false, todoistChanged: false, conflicts: [] });
});

test("Todoist-only rename propagates to the Calendar master", () => {
  const result = calendarOwnedMetadataResolution(original, master("Weekly test"), task("Renamed from Todoist"));
  assert.equal(result.calendarChanged, true);
  assert.equal(result.todoistChanged, false);
  assert.equal(result.summary, "Renamed from Todoist");
  assert.deepEqual(result.conflicts, []);
});

test("Calendar-only rename propagates to Todoist without touching due", () => {
  const result = calendarOwnedMetadataResolution(original, master("Renamed in Calendar"), task("Weekly test"));
  assert.equal(result.calendarChanged, false);
  assert.equal(result.todoistChanged, true);
  assert.equal(result.summary, "Renamed in Calendar");
  assert.deepEqual(result.conflicts, []);
});

test("independent edits to different metadata fields merge safely", () => {
  const result = calendarOwnedMetadataResolution(original, master("Calendar title"), task("Weekly test", "Todoist notes"));
  assert.equal(result.calendarChanged, true);
  assert.equal(result.todoistChanged, true);
  assert.equal(result.summary, "Calendar title");
  assert.equal(result.description, "Todoist notes");
  assert.deepEqual(result.conflicts, []);
});

test("divergent concurrent changes to the same title fail closed", () => {
  const result = calendarOwnedMetadataResolution(original, master("Title A"), task("Title B"));
  assert.deepEqual(result.conflicts, ["title"]);
  assert.equal(result.calendarChanged, false);
  assert.equal(result.todoistChanged, false);
});

test("legacy mapping with no safe baseline must not guess which system edited metadata", () => {
  const result = calendarOwnedMetadataResolution({}, master("Title A"), task("Title B"));
  assert.deepEqual(result.conflicts, ["title"]);
});
