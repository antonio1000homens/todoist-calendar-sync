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


test("Calendar multiline description propagates to Todoist without flattening paragraphs", () => {
  const result = calendarOwnedMetadataResolution(
    { syncedTitle: "Weekly test", syncedDescription: "updated in todoist" },
    master("Weekly test", "updated in todoist\nupdated in calendar"),
    task("Weekly test", "updated in todoist"),
  );
  assert.equal(result.description, "updated in todoist\nupdated in calendar");
  assert.equal(result.todoistChanged, true);
  assert.equal(result.calendarChanged, false);
  assert.deepEqual(result.conflicts, []);
});

test("Todoist multiline description propagates to Calendar while preserving line breaks", () => {
  const result = calendarOwnedMetadataResolution(
    { syncedTitle: "Weekly test", syncedDescription: "first line" },
    master("Weekly test", "first line"),
    task("Weekly test", "first line\nsecond line\n\nthird paragraph"),
  );
  assert.equal(result.description, "first line\nsecond line\n\nthird paragraph");
  assert.equal(result.calendarChanged, true);
  assert.equal(result.todoistChanged, false);
});

test("Windows newlines compare equal to Unix newlines without a spurious provider write", () => {
  const result = calendarOwnedMetadataResolution(
    { syncedTitle: "Weekly test", syncedDescription: "first line\nsecond line" },
    master("Weekly test", "first line\r\nsecond line\r\n"),
    task("Weekly test", "first line\nsecond line"),
  );
  assert.equal(result.description, "first line\nsecond line");
  assert.equal(result.calendarChanged, false);
  assert.equal(result.todoistChanged, false);
  assert.deepEqual(result.conflicts, []);
});

test("description-only line break edits are not silently considered equal", () => {
  const result = calendarOwnedMetadataResolution(
    { syncedTitle: "Weekly test", syncedDescription: "first line second line" },
    master("Weekly test", "first line\nsecond line"),
    task("Weekly test", "first line second line"),
  );
  assert.equal(result.todoistChanged, true);
  assert.equal(result.description, "first line\nsecond line");
});
