import assert from "node:assert/strict";
import test from "node:test";
import { profiles, rememberTodoistTokenProject } from "../dist/config.js";
import {
  MAPPING_COMMENT_MARKER,
  buildProjectMappingIndex,
  findProjectMappingComment,
  parseMappingComment,
  serializeMappingComment,
  upsertProjectMappingComment,
} from "../dist/mapping-comments.js";
import { Todoist } from "../dist/providers.js";

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
    originalStart: "2026-09-08T09:00:00Z",
    activeEffectiveStart: "2026-09-08T09:30:00Z",
    mappingRevision: 3,
    updatedAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

test("v1 project mapping comment round-trips recurrence metadata", () => {
  const content = serializeMappingComment(mapping(), "project-home", "https://calendar.example/event", 3);
  assert.ok(content.startsWith(`${MAPPING_COMMENT_MARKER}\n`));

  const parsed = parseMappingComment({ id: "comment-1", content });
  assert.ok(parsed && !("error" in parsed));
  assert.equal(parsed.payload.profile, "home");
  assert.equal(parsed.payload.projectId, "project-home");
  assert.equal(parsed.payload.taskId, "task-1");
  assert.equal(parsed.payload.eventId, "event-1");
  assert.equal(parsed.payload.seriesId, "series-1");
  assert.equal(parsed.payload.masterEventId, "master-1");
  assert.equal(parsed.payload.activeInstanceId, "event-1");
  assert.equal(parsed.payload.mappingRevision, 3);
});

test("index ignores human comments, reports malformed mappings, and indexes task/event/series", () => {
  const valid = { id: "valid", content: serializeMappingComment(mapping(), "project-home", undefined, 3) };
  const malformed = { id: "bad", content: `${MAPPING_COMMENT_MARKER}\n{not-json` };
  const human = { id: "human", content: "Remember to buy milk" };
  const index = buildProjectMappingIndex([human, malformed, valid]);

  assert.equal(index.parsed.length, 1);
  assert.equal(index.malformed.length, 1);
  assert.equal(index.byTaskId.get("task-1")?.[0].comment.id, "valid");
  assert.equal(index.byEventId.get("event-1")?.[0].comment.id, "valid");
  assert.equal(index.bySeriesId.get("series-1")?.[0].comment.id, "valid");
});

test("referenced project comment wins only for the same mapping identity; otherwise newest exact mapping is selected", () => {
  const old = { id: "old", content: serializeMappingComment(mapping({ mappingRevision: 1 }), "project-home", undefined, 1) };
  const newer = { id: "new", content: serializeMappingComment(mapping({ mappingRevision: 2 }), "project-home", undefined, 2) };
  const unrelated = {
    id: "wrong-reference",
    content: serializeMappingComment(mapping({ taskId: "other-task", eventId: "other-event", mappingRevision: 9 }), "project-home", undefined, 9),
  };
  const index = buildProjectMappingIndex([old, newer, unrelated]);

  assert.equal(findProjectMappingComment(index, mapping())?.comment.id, "new");
  assert.equal(findProjectMappingComment(index, { ...mapping(), projectCommentId: "old" })?.comment.id, "old");
  assert.equal(findProjectMappingComment(index, { ...mapping(), projectCommentId: "wrong-reference" })?.comment.id, "new");
});

test("project mapping upsert never updates an unverified stored comment id", async () => {
  const upserts = [];
  const client = {
    async listProjectComments() { return []; },
    async upsertProjectComment(projectId, content, existingId) {
      upserts.push({ projectId, content, existingId });
      return { id: "new-project-comment", project_id: projectId, content };
    },
    async findLegacyTaskComment() { return undefined; },
    async deleteComment() {},
  };

  const migrated = await upsertProjectMappingComment(
    client,
    mapping({ projectCommentId: "stale-or-task-comment", mappingRevision: 0 }),
    "project-home",
  );

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].existingId, undefined);
  assert.equal(migrated.projectCommentId, "new-project-comment");
});

test("Todoist project comment listing consumes every next_cursor page", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.includes("cursor=next-page")) {
      return new Response(JSON.stringify({ results: [{ id: "comment-2", content: "human" }], next_cursor: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [{ id: "comment-1", content: "human" }], next_cursor: "next-page" }), { status: 200 });
  };

  const todoist = new Todoist("token");
  const comments = await todoist.listProjectComments("project-home");
  assert.deepEqual(comments.map((comment) => comment.id), ["comment-1", "comment-2"]);
  assert.equal(requests.length, 2);
  assert.match(requests[0], /project_id=project-home/);
  assert.match(requests[1], /cursor=next-page/);
});

test("Todoist provider uses canonical newest project mapping and skips task fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  const token = "canonical-selection-token";
  const projectId = profiles.home.todoistProjectId;
  rememberTodoistTokenProject(token, projectId);
  const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  const older = serializeMappingComment(mapping({ projectId, mappingRevision: 1 }), projectId, undefined, 1);
  const newer = serializeMappingComment(mapping({ projectId, mappingRevision: 4 }), projectId, undefined, 4);
  globalThis.fetch = async (url) => {
    const value = String(url);
    requests.push(value);
    assert.match(value, new RegExp(`project_id=${projectId}`));
    return new Response(JSON.stringify({
      results: [
        { id: "older", content: older, project_id: projectId },
        { id: "newer", content: newer, project_id: projectId },
      ],
      next_cursor: null,
    }), { status: 200 });
  };

  const todoist = new Todoist(token);
  assert.deepEqual(await todoist.findComment("task-1", "event-1"), { id: "newer" });
  assert.equal(requests.length, 1, "project hit must avoid legacy task-comment lookup");
});
