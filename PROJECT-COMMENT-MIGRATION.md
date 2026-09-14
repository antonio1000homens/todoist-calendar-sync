# Todoist project-comment mapping migration

Issue #64 moves the Todoist-side Calendar mapping breadcrumb from comments on individual tasks to versioned comments on the containing Todoist project.

DynamoDB remains authoritative. Project comments are a recoverable provider-side index, not a replacement for the state table.

## Runtime behavior after deployment

- Mapping discovery checks `gcp-app2-sync:mapping:v1` project comments first.
- Legacy task comments are read only when the project index has no matching mapping.
- New/updated mapping comments are written only to the Todoist project.
- Legacy task comments are not updated or deleted by the migration.
- Project comments are fetched with cursor pagination and cached for the lifetime of a Todoist client so reconciliation does not issue one comment-list request per task.

## Phase 1: report

Run the migration without `--apply`. This performs no project-comment or DynamoDB mapping writes.

```bash
cd gcp-app2-sync
npm ci
npm run migrate:project-comments -- home
npm run migrate:project-comments -- antonio
npm run migrate:project-comments -- work
```

Or report all profiles:

```bash
npm run migrate:project-comments -- all
```

Review at least these counters before applying:

- `projectCommentsMissing`: mappings that need a v1 project comment.
- `legacyTaskCommentsFound`: mappings currently recoverable through the legacy fallback.
- `malformedProjectComments`: v1-marked comments that could not be parsed safely.
- `duplicateProjectComments`: ambiguous exact task/event project mappings; these are not auto-migrated unless DynamoDB already points at one canonical `projectCommentId`.
- `missingTasks`, `missingCalendarEvents`, `tombstonedMappings`, and `projectMismatches`: stale mappings that are deliberately not backfilled.
- `failures`: provider/state errors that require investigation.

## Phase 2: apply

Apply one profile at a time after reviewing its report:

```bash
npm run migrate:project-comments -- home --apply
npm run migrate:project-comments -- antonio --apply
npm run migrate:project-comments -- work --apply
```

Apply mode is idempotent:

1. Existing project mappings are reused rather than duplicated.
2. DynamoDB mappings are normalized to `projectCommentId` / `mappingRevision`.
3. A known legacy task-comment ID is retained in `taskCommentId` as migration fallback.
4. Missing project mappings are created only after the DynamoDB mapping, Todoist task/project ownership, Calendar event, and tombstone state validate successfully.
5. No task comment is created, edited, or deleted.

## Phase 3: verify

Run report mode again. The expected steady state is:

- `projectCommentsMissing = 0` for valid live mappings;
- no unexplained malformed or duplicate project mappings;
- remaining legacy task comments are fallback-only and do not receive new writes.

Do not bulk-delete legacy task comments as part of this rollout. Keeping them temporarily makes rollback safe and preserves recovery evidence while the new project index beds in.

## Rollback

Rolling back application code does not require deleting project comments. DynamoDB is still authoritative, and the migration does not remove legacy task comments. If a rollback is required, leave both comment forms in place until the old runtime has been retired again.
