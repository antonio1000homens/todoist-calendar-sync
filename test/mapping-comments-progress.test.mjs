import assert from "node:assert/strict";
import test from "node:test";
import {
  MAPPING_COMMENT_MARKER,
  parseMappingComment,
  serializeMappingComment,
} from "../dist/mapping-comments.js";

function mapping(overrides = {}) {
  return {
    profile: "home",
    projectId: "project-home",
    taskId: "task-1",
    eventId: "event-1",
    recurrenceOwner: "calendar",
    seriesId: "series-1",
    masterEventId: "master-1",
    activeInstanceId: "event-1",
    originalStart: "2099-09-18",
    activeEffectiveStart: "2099-09-18",
    mappingRevision: 3,
    updatedAt: "2099-09-16T10:00:00.000Z",
    ...overrides,
  };
}

test("project mapping comments round-trip Calendar progress state", () => {
  const content = serializeMappingComment(mapping({
    calendarProgressVersion: 1,
    completedThroughOriginalStart: "2099-09-17",
  }), "project-home", undefined, 3);
  const parsed = parseMappingComment({ id: "comment-1", content });
  assert.ok(parsed && !("error" in parsed));
  assert.equal(parsed.payload.calendarProgressVersion, 1);
  assert.equal(parsed.payload.completedThroughOriginalStart, "2099-09-17");
});

test("legacy project mapping comments remain valid without progress fields", () => {
  const content = serializeMappingComment(mapping(), "project-home", undefined, 3);
  const parsed = parseMappingComment({ id: "comment-legacy", content });
  assert.ok(parsed && !("error" in parsed));
  assert.equal(parsed.payload.calendarProgressVersion, undefined);
  assert.equal(parsed.payload.completedThroughOriginalStart, undefined);
});

test("mapping comments reject unknown Calendar progress versions", () => {
  const payload = {
    schemaVersion: 1,
    profile: "home",
    projectId: "project-home",
    taskId: "task-1",
    eventId: "event-1",
    recurrenceOwner: "calendar",
    seriesId: "series-1",
    calendarProgressVersion: 2,
    mappingRevision: 1,
    updatedAt: "2099-09-16T10:00:00.000Z",
  };
  const parsed = parseMappingComment({ id: "bad-version", content: `${MAPPING_COMMENT_MARKER}\n${JSON.stringify(payload)}` });
  assert.ok(parsed && "error" in parsed);
  assert.match(parsed.error, /calendarProgressVersion/);
});
