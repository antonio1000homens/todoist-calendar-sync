import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { serializeMappingComment } from "../dist/mapping-comments.js";
import { migrateProjectComments } from "../dist/project-comment-migration.js";

function mapping(overrides = {}) {
  return {
    profile: "home",
    projectId: profiles.home.todoistProjectId,
    taskId: "task-1",
    eventId: "event-1",
    updatedAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

class FakeState {
  constructor(tombstone) {
    this.tombstone = tombstone;
    this.saved = [];
    this.audits = [];
  }
  async putMapping(value) { this.saved.push(structuredClone(value)); }
  async getCalendarProjectionTombstone() { return this.tombstone; }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

function fakeClients({ projectComments = [], legacyComment, onLegacyRead } = {}) {
  const comments = projectComments.map((comment) => ({ ...comment }));
  let creates = 0;
  return {
    clients: {
      todoist: {
        async listProjectComments() { return comments.map((comment) => ({ ...comment })); },
        async findLegacyTaskComment() {
          onLegacyRead?.();
          return legacyComment ? { ...legacyComment } : undefined;
        },
        async upsertProjectComment(projectId, content, existingId) {
          if (existingId) {
            const current = comments.find((comment) => comment.id === existingId);
            if (current) {
              current.content = content;
              return { ...current };
            }
          }
          creates += 1;
          const created = { id: `project-comment-${creates}`, project_id: projectId, content };
          comments.push(created);
          return { ...created };
        },
        async deleteComment() {},
        async getTask(taskId) {
          return { id: taskId, content: "Task", project_id: profiles.home.todoistProjectId };
        },
      },
      calendar: {
        async getEvent(eventId) {
          return { id: eventId, status: "confirmed", htmlLink: `https://calendar.example/${eventId}` };
        },
      },
    },
    get creates() { return creates; },
    comments,
  };
}

test("migration uses the project index first and does not fan out to task comments", async () => {
  let legacyReads = 0;
  const source = mapping();
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment({ ...source, mappingRevision: 4 }, profiles.home.todoistProjectId, undefined, 4),
  };
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment], onLegacyRead: () => { legacyReads += 1; } });

  const summary = await migrateProjectComments("home", [source], state, fake.clients, false);

  assert.equal(summary.existingProjectCommentsReused, 1);
  assert.equal(summary.projectCommentsMissing, 0);
  assert.equal(legacyReads, 0);
  assert.equal(state.saved.length, 0);
});

test("apply backfills a missing project comment once, preserves legacy task fallback, and is idempotent", async () => {
  let legacyReads = 0;
  const state = new FakeState();
  const fake = fakeClients({
    legacyComment: { id: "legacy-task-comment", task_id: "task-1", content: "todoist-calendar-sync\ncalendarEventId=event-1" },
    onLegacyRead: () => { legacyReads += 1; },
  });

  const first = await migrateProjectComments("home", [mapping()], state, fake.clients, true);
  assert.equal(first.projectCommentsMissing, 1);
  assert.equal(first.projectCommentsCreated, 1);
  assert.equal(first.legacyTaskCommentsFound, 1);
  assert.equal(fake.creates, 1);
  assert.equal(legacyReads, 1);
  assert.equal(state.saved.length, 1);
  const migrated = state.saved[0];
  assert.equal(migrated.projectCommentId, "project-comment-1");
  assert.equal(migrated.taskCommentId, "legacy-task-comment");
  assert.equal(migrated.commentId, undefined);
  assert.equal(migrated.mappingRevision, 1);

  const secondState = new FakeState();
  const second = await migrateProjectComments("home", [migrated], secondState, fake.clients, true);
  assert.equal(second.existingProjectCommentsReused, 1);
  assert.equal(second.projectCommentsCreated, 0);
  assert.equal(fake.creates, 1, "re-running migration must not create a duplicate project comment");
  assert.equal(legacyReads, 1, "project hit must prevent fallback task-comment lookup on the second run");
  assert.equal(secondState.saved.length, 0, "already-normalized mapping should not be rewritten");
});

test("report mode validates a missing project mapping but never writes provider or DynamoDB state", async () => {
  const state = new FakeState();
  const fake = fakeClients();

  const summary = await migrateProjectComments("home", [mapping()], state, fake.clients, false);

  assert.equal(summary.mode, "report");
  assert.equal(summary.projectCommentsMissing, 1);
  assert.equal(summary.projectCommentsCreated, 0);
  assert.equal(fake.creates, 0);
  assert.equal(state.saved.length, 0);
});

test("tombstone blocks project-comment backfill so stale breadcrumbs cannot be introduced", async () => {
  const state = new FakeState({ sourceUpdatedAt: "2026-09-08T09:00:00.000Z" });
  const fake = fakeClients();

  const summary = await migrateProjectComments("home", [mapping()], state, fake.clients, true);

  assert.equal(summary.tombstonedMappings, 1);
  assert.equal(summary.projectCommentsCreated, 0);
  assert.equal(fake.creates, 0);
  assert.equal(state.saved.length, 0);
});
