import test from "node:test";
import assert from "node:assert/strict";
import { Todoist } from "../dist/providers.js";
import { profiles, rememberTodoistTokenProject } from "../dist/config.js";
import { parseMappingComment, serializeMappingComment } from "../dist/mapping-comments.js";

const oldMapping = {
  profile: "antonio", projectId: profiles.antonio.todoistProjectId,
  taskId: "smoke-task", eventId: "old-master",
  recurrenceOwner: "todoist", seriesId: "smoke-task", masterEventId: "old-master",
  updatedAt: "2026-10-19T09:00:00Z", mappingRevision: 2,
};
const oldComment = {
  id: "old-project-comment", project_id: profiles.antonio.todoistProjectId,
  content: serializeMappingComment(oldMapping, profiles.antonio.todoistProjectId, undefined, 2),
};

test("approved future-series cutover moves the canonical project breadcrumb rather than adding a competing old mapping", async () => {
  const token = "test-split-comment-token";
  rememberTodoistTokenProject(token, profiles.antonio.todoistProjectId);
  const api = new Todoist(token);
  api.listProjectComments = async () => [oldComment];
  let updated;
  api.upsertProjectComment = async () => { throw new Error("must not create a competing mapping comment"); };
  api.updateComment = async (existingId, content) => {
    updated = { content, existingId };
    return { id: existingId };
  };
  const replacement = { ...oldMapping, eventId: "new-master", masterEventId: "new-master", updatedAt: "2026-10-19T22:00:00Z" };
  const result = await api.upsertComment(
    replacement.taskId, "todoist-calendar-sync\ncalendarEventId=new-master\ncalendarUrl=https://calendar/new-master",
    oldComment.id, replacement, oldMapping.eventId,
  );
  assert.equal(result.id, oldComment.id);
  assert.equal(updated.existingId, oldComment.id);
  const parsed = parseMappingComment({ id: oldComment.id, content: updated.content });
  assert.equal(parsed.payload.eventId, "new-master");
  assert.equal(parsed.payload.masterEventId, "new-master");
  assert.equal(parsed.payload.mappingRevision, 3);
});

test("Calendar-owned project comment evidence cannot be migrated to Todoist recurrence", async () => {
  const token = "test-split-conflicting-comment";
  rememberTodoistTokenProject(token, profiles.antonio.todoistProjectId);
  const api = new Todoist(token);
  api.listProjectComments = async () => [{
    ...oldComment, content: serializeMappingComment({
      ...oldMapping, recurrenceOwner: "calendar",
    }, profiles.antonio.todoistProjectId, undefined, 2),
  }];
  api.upsertProjectComment = async () => { throw new Error("must not mutate"); };
  await assert.rejects(
    api.upsertComment("smoke-task", "todoist-calendar-sync\ncalendarEventId=new-master",
      oldComment.id, { ...oldMapping, eventId: "new-master" }, "old-master"),
    /Cannot migrate conflicting/,
  );
});

test("an old comment that cannot be updated is never duplicated on the successor", async () => {
  const token = "test-split-comment-failure";
  rememberTodoistTokenProject(token, profiles.antonio.todoistProjectId);
  const api = new Todoist(token);
  api.listProjectComments = async () => [oldComment];
  api.updateComment = async () => {
    throw Object.assign(new Error("Comment is not yours"), { status: 400 });
  };
  api.upsertProjectComment = async () => { throw new Error("Created a forbidden competing comment"); };
  await assert.rejects(api.upsertComment(
    "smoke-task", "todoist-calendar-sync\ncalendarEventId=new-master",
    oldComment.id, { ...oldMapping, eventId: "new-master" }, "old-master",
  ), /Comment is not yours/);
});
