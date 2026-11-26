import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { parseMappingComment, serializeMappingComment } from "../dist/mapping-comments.js";
import { migrateProjectComments, runAutomaticProjectCommentMigration } from "../dist/project-comment-migration.js";

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
    this.completed = [];
  }
  async putMapping(value) { this.saved.push(structuredClone(value)); }
  async getCalendarProjectionTombstone() { return this.tombstone; }
  async putCompletedCalendarProjection(value) { this.completed.push(structuredClone(value)); }
  async audit(profile, action, detail) { this.audits.push({ profile, action, detail }); }
}

function fakeClients({ projectComments = [], legacyComment, onLegacyRead, deleteError, getError, completedTask = false } = {}) {
  const comments = projectComments.map((comment) => ({ ...comment }));
  const deletes = [];
  let creates = 0;
  const calendarEvents = new Map();
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
        async getComment(commentId) {
          if (getError) throw getError;
          return legacyComment ? { ...legacyComment } : {
            id: commentId,
            task_id: "task-1",
            content: "todoist-calendar-sync\ncalendarEventId=event-1",
          };
        },
        async deleteComment(commentId) {
          deletes.push(commentId);
          if (deleteError) throw deleteError;
        },
        async getTask(taskId) {
          return { id: taskId, content: "Task", project_id: profiles.home.todoistProjectId,
            updated_at: "2026-09-08T10:05:00.000Z", is_completed: completedTask };
        },
      },
      calendar: {
        async getEvent(eventId) {
          return structuredClone(calendarEvents.get(eventId) || {
            id: eventId, etag: "etag-1", status: "confirmed", htmlLink: `https://calendar.example/${eventId}`,
          });
        },
        async ensureTaskCorrelation(eventId, taskId, _expectedTaskId, mapping) {
          const current = await this.getEvent(eventId);
          const shared = current.extendedProperties?.shared || {};
          current.extendedProperties = { ...current.extendedProperties, shared: {
            ...shared, taskId, syncTaskId: taskId, syncSchemaVersion: "2", syncProfile: "home",
            syncCalendarId: profiles.home.calendarId, syncEventId: eventId,
            ...(mapping.seriesId ? { syncSeriesId: mapping.seriesId } : {}),
            ...(mapping.masterEventId ? { syncMasterEventId: mapping.masterEventId } : {}),
            ...(mapping.activeInstanceId ? { syncActiveInstanceId: mapping.activeInstanceId } : {}),
            ...(mapping.originalStart ? { syncOriginalStart: mapping.originalStart } : {}),
            ...(mapping.activeEffectiveStart ? { syncActiveEffectiveStart: mapping.activeEffectiveStart } : {}),
            ...(mapping.calendarProgressVersion === 1 ? { syncProgressVersion: "1" } : {}),
            ...(mapping.completedThroughOriginalStart ? { syncCompletedThrough: mapping.completedThroughOriginalStart } : {}),
          } };
          calendarEvents.set(eventId, current);
          return structuredClone(current);
        },
      },
    },
    get creates() { return creates; },
    deletes,
    comments,
  };
}

test("automatic migration backfills all profiles before cleanup and retries newly created mappings", async () => {
  const calls = [];
  const result = await runAutomaticProjectCommentMigration(async (profile, apply, cleanupLegacy, retireLegacyCorrelation = false) => {
    calls.push({ profile, apply, cleanupLegacy, retireLegacyCorrelation });
    return {
      mode: "apply", projectCommentsCreated: profile === "home" && cleanupLegacy && calls.filter(call => call.profile === profile && call.cleanupLegacy).length === 1 ? 1 : 0,
      failures: 0, malformedProjectComments: 0, duplicateProjectComments: 0,
      // Unowned or mismatched task comments are preserved deliberately; a
      // safe refusal to delete them does not invalidate the mapping cutover.
      legacyTaskCommentsCleanupRejected: profile === "home" && cleanupLegacy ? 5 : 0,
    };
  });

  assert.deepEqual(calls.map(({ profile, cleanupLegacy }) => [profile, cleanupLegacy]), [
    ["antonio", false], ["home", false], ["work", false],
    ["antonio", true], ["home", true], ["work", true], ["home", true],
    ["antonio", true], ["home", true], ["work", true],
  ]);
  assert.deepEqual(calls.slice(-3).map(call => call.retireLegacyCorrelation), [true, true, true]);
  assert.equal(result.status, "completed");
  assert.ok(result.phases.cleanupRetry.home);
  assert.equal(result.phases.cleanupRetry.antonio, undefined);
});

test("automatic migration fails its report when a profile has ambiguous mappings", async () => {
  const result = await runAutomaticProjectCommentMigration(async profile => ({
    mode: "apply", projectCommentsCreated: 0, failures: 0, malformedProjectComments: 0,
    duplicateProjectComments: profile === "work" ? 1 : 0, legacyTaskCommentsCleanupRejected: 0,
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.phases.backfill.work.duplicateProjectComments, 1);
});

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
  assert.equal(state.saved.length, 0, "migration must not write a DynamoDB correlation row");
  const migratedComment = fake.comments[0];
  assert.equal(migratedComment.id, "project-comment-1");
  const migrated = parseMappingComment(migratedComment);
  assert.ok(migrated && !("error" in migrated));
  assert.equal(migrated.payload.taskId, "task-1");
  assert.equal(migrated.payload.eventId, "event-1");
  assert.equal(migrated.payload.mappingRevision, 1);
  assert.equal(Object.hasOwn(migrated.payload, "recurrenceOwner"), false);
  const calendarCorrelation = await fake.clients.calendar.getEvent("event-1");
  assert.equal(calendarCorrelation.extendedProperties.shared.taskId, "task-1");
  assert.equal(calendarCorrelation.extendedProperties.shared.syncSchemaVersion, "2");
  assert.equal(calendarCorrelation.extendedProperties.shared.syncProfile, "home");
  assert.equal(calendarCorrelation.extendedProperties.shared.syncCalendarId, profiles.home.calendarId);

  const secondState = new FakeState();
  const second = await migrateProjectComments("home", [mapping({ projectCommentId: migratedComment.id, mappingRevision: 1 })], secondState, fake.clients, true);
  assert.equal(second.existingProjectCommentsReused, 1);
  assert.equal(second.projectCommentsCreated, 0);
  assert.equal(fake.creates, 1, "re-running migration must not create a duplicate project comment");
  assert.equal(legacyReads, 1, "project hit must prevent fallback task-comment lookup on the second run");
  assert.equal(secondState.saved.length, 0, "already-normalized mapping should not be rewritten");
});

test("correlation retirement follows a verified provider-comment backfill", async () => {
  const state = new FakeState();
  const retired = [];
  state.retireMigratedMappingCorrelation = async value => { retired.push(value); return true; };
  const fake = fakeClients();

  const summary = await migrateProjectComments("home", [mapping()], state, fake.clients, true, true, true);

  assert.equal(summary.projectCommentsCreated, 1);
  assert.equal(summary.legacyCorrelationRowsRetired, 1);
  assert.equal(summary.legacyCorrelationRetirementRejected, 0);
  assert.equal(retired.length, 1);
  const saved = parseMappingComment(fake.comments[0]);
  assert.ok(saved && !("error" in saved));
  assert.equal(saved.payload.taskId, mapping().taskId);
  assert.equal(saved.payload.eventId, mapping().eventId);
});

test("completed mapping retirement first records the seven-day history identity", async () => {
  const state = new FakeState();
  const retired = [];
  state.retireMigratedMappingCorrelation = async value => { retired.push(value); return true; };
  const fake = fakeClients({ completedTask: true });

  const summary = await migrateProjectComments("home", [mapping()], state, fake.clients, true, true, true);

  assert.equal(summary.legacyCorrelationRowsRetired, 1);
  assert.equal(state.completed.length, 1);
  assert.deepEqual(state.completed[0], {
    profile: "home", taskId: "task-1", eventId: "event-1", completedAt: "2026-09-08T10:05:00.000Z",
  });
  assert.equal(retired.length, 1);
});

test("apply does not misclassify an ambiguous commentId that already points at the project mapping", async () => {
  const source = mapping({ commentId: "project-comment-existing" });
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment({ ...source, commentId: undefined, mappingRevision: 2 }, profiles.home.todoistProjectId, undefined, 2),
  };
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment] });

  const summary = await migrateProjectComments("home", [source], state, fake.clients, true);

  assert.equal(summary.legacyTaskCommentsFound, 0);
  assert.equal(fake.deletes.length, 0);
  assert.equal(state.saved.length, 0, "normalization is written to the provider comment only");
  const normalized = parseMappingComment(fake.comments[0]);
  assert.ok(normalized && !("error" in normalized));
  assert.equal(normalized.payload.mappingRevision, 3);
});

test("legacy cleanup is report-only unless apply is explicit", async () => {
  const source = mapping({
    projectCommentId: "project-comment-existing",
    taskCommentId: "legacy-task-comment",
    mappingRevision: 2,
  });
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(source, profiles.home.todoistProjectId, undefined, 2),
  };
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment] });

  const summary = await migrateProjectComments("home", [source], state, fake.clients, false, true);

  assert.equal(summary.legacyTaskCommentsFound, 1);
  assert.equal(summary.legacyTaskCommentsCleanupEligible, 1);
  assert.equal(summary.legacyTaskCommentsDeleted, 0);
  assert.deepEqual(fake.deletes, []);
  assert.equal(state.saved.length, 0);
});

test("legacy cleanup deletes only after a valid project mapping is verified and removes the fallback id", async () => {
  const source = mapping({
    projectCommentId: "project-comment-existing",
    taskCommentId: "legacy-task-comment",
    mappingRevision: 2,
  });
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(source, profiles.home.todoistProjectId, undefined, 2),
  };
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment] });

  const summary = await migrateProjectComments("home", [source], state, fake.clients, true, true);

  assert.equal(summary.legacyTaskCommentsCleanupEligible, 1);
  assert.equal(summary.legacyTaskCommentsDeleted, 1);
  assert.deepEqual(fake.deletes, ["legacy-task-comment"]);
  assert.equal(state.saved.length, 0, "legacy cleanup must not rewrite DynamoDB correlation rows");
  const normalized = parseMappingComment(fake.comments[0]);
  assert.ok(normalized && !("error" in normalized));
  assert.equal(normalized.payload.mappingRevision, 3);
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
  assert.deepEqual(state.audits, [], "read-only report must not write audit items to DynamoDB");
});

test("legacy projection tombstone does not block exact live provider correlation repair", async () => {
  const state = new FakeState({ sourceUpdatedAt: "2026-09-08T09:00:00.000Z" });
  const fake = fakeClients();

  const summary = await migrateProjectComments("home", [mapping()], state, fake.clients, true);

  assert.equal(summary.projectCommentsCreated, 1);
  assert.equal(fake.creates, 1);
  assert.equal(state.saved.length, 0, "provider-native correlation repair must not recreate DDB mapping rows");
});


test("legacy cleanup treats an already-missing task comment as an idempotent delete", async () => {
  const source = mapping({
    projectCommentId: "project-comment-existing",
    taskCommentId: "legacy-task-comment",
    mappingRevision: 2,
  });
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(source, profiles.home.todoistProjectId, undefined, 2),
  };
  const missing = new Error("already deleted");
  missing.status = 404;
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment], getError: missing });

  const summary = await migrateProjectComments("home", [source], state, fake.clients, true, true);

  assert.equal(summary.failures, 0);
  assert.equal(summary.legacyTaskCommentsDeleted, 0);
  assert.equal(summary.legacyTaskCommentsAlreadyMissing, 1);
  assert.deepEqual(fake.deletes, []);
  assert.equal(state.saved.length, 0);
  const normalized = parseMappingComment(fake.comments[0]);
  assert.ok(normalized && !("error" in normalized));
  assert.equal(normalized.payload.mappingRevision, 3);
});


test("cleanup rejects a stored ID pointing to a user-authored comment", async () => {
  const source = mapping({ projectCommentId: "project-comment-existing", taskCommentId: "human-comment", mappingRevision: 2 });
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(source, profiles.home.todoistProjectId, undefined, 2),
  };
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment], legacyComment: { id: "human-comment", task_id: "task-1", content: "Important note written by a person" } });
  const summary = await migrateProjectComments("home", [source], state, fake.clients, true, true);
  assert.equal(summary.legacyTaskCommentsCleanupRejected, 1);
  assert.equal(summary.legacyTaskCommentsDeleted, 0);
  assert.deepEqual(fake.deletes, []);
  assert.equal(state.saved.length, 0);
});

test("cleanup rejects a legacy comment belonging to another task or event", async () => {
  const source = mapping({ projectCommentId: "project-comment-existing", taskCommentId: "wrong-comment", mappingRevision: 2 });
  const projectComment = {
    id: "project-comment-existing",
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(source, profiles.home.todoistProjectId, undefined, 2),
  };
  for (const legacyComment of [
    { id: "wrong-comment", task_id: "someone-else", content: "todoist-calendar-sync\ncalendarEventId=event-1" },
    { id: "wrong-comment", task_id: "task-1", content: "todoist-calendar-sync\\ncalendarEventId=another-event" },
  ]) {
    const state = new FakeState();
    const fake = fakeClients({ projectComments: [projectComment], legacyComment });
    const summary = await migrateProjectComments("home", [source], state, fake.clients, true, true);
    assert.equal(summary.legacyTaskCommentsCleanupRejected, 1);
    assert.equal(summary.legacyTaskCommentsDeleted, 0);
    assert.deepEqual(fake.deletes, []);
    assert.equal(state.saved.length, 0);
  }
});


test("backfill and cleanup must skip completed tasks whose Calendar history survives", async () => {
  const source = mapping({ commentId: "old-task-comment" });
  const state = new FakeState();
  const fake = fakeClients({ completedTask: true });
  const backfill = await migrateProjectComments("home", [source], state, fake.clients, true);
  assert.equal(backfill.completedTasks, 1);
  assert.equal(backfill.projectCommentsCreated, 0);
  assert.equal(fake.creates, 0);
  assert.deepEqual(state.saved, []);

  const indexed = mapping({ projectCommentId: "project-comment-existing", taskCommentId: "old-task-comment" });
  const projectComment = {
    id: indexed.projectCommentId,
    project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(indexed, profiles.home.todoistProjectId),
  };
  const cleanupClients = fakeClients({ projectComments: [projectComment], completedTask: true });
  const cleanup = await migrateProjectComments("home", [indexed], new FakeState(), cleanupClients.clients, true, true);
  assert.equal(cleanup.completedTasks, 1);
  assert.equal(cleanup.legacyTaskCommentsCleanupEligible, 0);
  assert.deepEqual(cleanupClients.deletes, []);
});


test("cleanup report rejects a mismatched ID without writing any audit record", async () => {
  const source = mapping({ projectCommentId: "project-comment-existing", taskCommentId: "human-comment" });
  const projectComment = { id: source.projectCommentId, project_id: profiles.home.todoistProjectId,
    content: serializeMappingComment(source, profiles.home.todoistProjectId) };
  const state = new FakeState();
  const fake = fakeClients({ projectComments: [projectComment], legacyComment: {
    id: "human-comment", task_id: "task-1", content: "A human note" } });
  const summary = await migrateProjectComments("home", [source], state, fake.clients, false, true);
  assert.equal(summary.legacyTaskCommentsCleanupRejected, 1);
  assert.deepEqual(state.audits, []);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(fake.deletes, []);
});

test("stale legacy HMAC configuration does not block provider-comment migration",async t=>{
  const previous=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  const priorProtocol=process.env.ERASURE_PROTOCOL_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  process.env.ERASURE_PROTOCOL_VERSION="1";
  t.after(()=>{
    if(previous===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous;
    if(priorProtocol===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION=priorProtocol;
  });
  const sends=[];
  t.mock.method(documentClient,"send",async command=>{
    sends.push(command.constructor.name);
    if(["GetCommand","TransactWriteCommand","DeleteCommand"].includes(command.constructor.name))return {};
    throw Error("Unexpected DynamoDB operation "+command.constructor.name);
  });
  const state=new FakeState(),fake=fakeClients();
  const summary=await migrateProjectComments("home",[mapping()],state,fake.clients,true);
  assert.equal(summary.failures,0);
  assert.equal(fake.creates,1);
  assert.ok(sends.includes("TransactWriteCommand"),"writer lease must be acquired");
  assert.ok(sends.includes("DeleteCommand"),"writer lease must be released");
  assert.equal(sends.includes("PutCommand"),false,"provider correlation is written through project comments");
  assert.equal(state.audits.some(entry=>String(entry.detail?.error||"").includes("Legacy HMAC replay admission was retired")),false);
});

test("project-comment migration refuses mappings from another profile", async () => {
  const state = new FakeState();
  const fake = fakeClients();
  const summary = await migrateProjectComments("home", [mapping({ profile: "work" })], state, fake.clients, true);
  assert.equal(summary.failures, 1);
  assert.equal(fake.creates, 0);
  assert.deepEqual(fake.deletes, []);
  assert.deepEqual(state.saved, []);
});
