# Todoist project-comment mapping migration

Issue #64 moves the Todoist-side Calendar mapping breadcrumb from comments on individual tasks to versioned comments on the containing Todoist project.

DynamoDB remains authoritative. Project comments are a recoverable provider-side index, not a replacement for the state table.

## Runtime behavior after deployment

- Mapping discovery checks `gcp-app2-sync:mapping:v1` project comments first.
- Legacy task comments are read only when the project index has no matching mapping.
- New/updated mapping comments are written only to the Todoist project and their IDs are persisted as `projectCommentId`.
- Runtime code no longer persists newly written project-comment IDs in the deprecated `commentId` field.
- Legacy task comments are read-only migration fallback evidence; they are not updated. Permanent mapping removal may delete a known legacy breadcrumb together with the project mapping comment.
- Project comments are fetched with cursor pagination and cached for the lifetime of a Todoist client so reconciliation does not issue one comment-list request per task.

## Phase 1: report

Run the migration without `--apply`. This performs no project-comment or DynamoDB mapping writes.

```bash
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
- `legacyTaskCommentsCleanupRejected`: comment IDs whose fetched task, marker or event identity did not match; these are never deleted.
- `legacyTaskCommentsAlreadyMissing`: stale IDs removed from mapping metadata when the Todoist comment is already gone.
- `malformedProjectComments`: v1-marked comments that could not be parsed safely.
- `duplicateProjectComments`: ambiguous exact task/event project mappings; these are not auto-migrated unless DynamoDB already points at one canonical `projectCommentId`.
- `missingTasks`, `completedTasks`, `deletedTasks`, `missingCalendarEvents`, `tombstonedMappings`, and `projectMismatches`: mappings not safe to backfill. Completed Todoist tasks may retain Calendar history but must not be re-indexed as live mappings.
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

Do not bulk-delete legacy task comments as part of the initial rollout. Keeping them temporarily makes rollback safe and preserves recovery evidence while the new project index beds in.

## Phase 4: clean up legacy task comments

After Phase 3 reports a healthy project index, preview legacy task-comment cleanup explicitly:

```bash
npm run migrate:project-comments -- home --cleanup-legacy
npm run migrate:project-comments -- antonio --cleanup-legacy
npm run migrate:project-comments -- work --cleanup-legacy
```

Review `legacyTaskCommentsCleanupEligible`, `legacyTaskCommentsDeleted`, and all validation/failure counters. Cleanup eligibility requires an exact project mapping plus a live task in the expected project, a live Calendar event, and no projection tombstone. **Before deleting**, the runner also fetches the actual Todoist comment by ID and checks its task ID, application marker, and exact Calendar event ID. A mismatched/user-authored comment is never removed. Ordinary synchronizer mapping-deletion paths use this same identity check.

Then apply one profile at a time:

```bash
npm run migrate:project-comments -- home --cleanup-legacy --apply
npm run migrate:project-comments -- antonio --cleanup-legacy --apply
npm run migrate:project-comments -- work --cleanup-legacy --apply
```

Cleanup is deliberately two-phase. If a mapping is still missing its project comment, the migration may create that project comment in apply mode, but it will not delete the task comment in the same pass. Re-run the cleanup report after the project mapping exists before applying deletion.

## Rollback

Rolling back application code does not require deleting project comments. DynamoDB is still authoritative, and the migration does not remove legacy task comments. If a rollback is required, leave both comment forms in place until the old runtime has been retired again.

## Production GitHub Actions entry point

The [Project comment mapping migration workflow](.github/workflows/project-comment-migration.yml) runs with the production environment and GitHub OIDC role. It defaults to read-only `profile=all`, `operation=report`. Prefer this controlled runner to an ad hoc shell, because it resolves the deployed DynamoDB table and SSM credentials from the existing stack.

- Backfill writes require choosing a **single** profile, `operation=backfill-apply` and typing `BACKFILL` in the confirmation field.
- Preview safe deletion with `operation=cleanup-report` first. Production cleanup requires one profile, `operation=cleanup-apply` and exact confirmation `DELETE_VERIFIED_LEGACY_COMMENTS`.
- After each write, run report mode again and investigate duplicates, provider mismatches, tombstones, failures and rejected comment IDs. Reports contain summary counts only.
- Do not treat missing Todoist tasks as successful migration: completed, moved, or deleted mappings require a separate ownership/tombstone assessment, not a blind comment creation.
