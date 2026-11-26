# Todoist project-comment mapping migration

This migration installs the provider-owned correlation used by the current synchronization engine: versioned Todoist project comments paired with Google Calendar `extendedProperties.shared`. Those provider objects identify the live pair; DynamoDB correlation and recurrence rows are legacy migration input and must be retired after the provider pair is verified. DynamoDB retains only the operational state still required during cutover and in-flight work.

## Runtime behavior after deployment

- Mapping discovery reads versioned project comments and Calendar shared properties. It does not use a DynamoDB mapping or recurrence row to recover a live pair.
- New/updated mapping comments are written only to the Todoist project and their IDs are persisted as `projectCommentId`.
- Runtime code no longer persists newly written project-comment IDs in the deprecated `commentId` field.
- Legacy task comments are migration-only evidence; normal synchronization does not use them as a fallback or update them. Cleanup may delete an exact verified legacy breadcrumb after the project mapping is live.
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
- `missingTasks`, `completedTasks`, `deletedTasks`, `missingCalendarEvents`, and `projectMismatches`: mappings not safe to backfill. Completed Todoist tasks may retain Calendar history but must not be re-indexed as live mappings. Legacy projection tombstones do not override fresh exact provider reads.
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
2. Each project mapping is checked against exact Todoist task/project and Calendar event IDs before legacy correlation state is retired.
3. A known legacy task-comment ID is used only to verify safe cleanup; no live fallback reference is needed afterward.
4. Missing project mappings are created only when exact provider IDs and live provider reads establish the intended pair.
5. No task comment is created or edited. A known, exact legacy mapping comment may be deleted only in the separate cleanup phase.

## Phase 3: verify

Run report mode again. The expected steady state is:

- `projectCommentsMissing = 0` for valid live provider pairs;
- no unexplained malformed or duplicate project mappings;
- legacy DynamoDB correlation rows are retired only after the provider pair verifies.

Do not delete legacy task comments during backfill. Verify all provider pairs first, then use the separate cleanup phase to remove only comments whose task ID, application marker, and exact event ID match.

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

Rolling back application code does not require deleting provider comments. Keep verified project comments in place. A rollback to code that depends on legacy DynamoDB correlation rows is not supported after those rows are retired; use the documented migration rollback window before running correlation retirement.

## Production GitHub Actions entry point

The [Project comment mapping migration workflow](.github/workflows/project-comment-migration.yml) runs with the production environment and GitHub OIDC role. It defaults to read-only `profile=all`, `operation=report`. Prefer this controlled runner to an ad hoc shell, because it resolves the deployed DynamoDB table and SSM credentials from the existing stack.

- Backfill writes require choosing a **single** profile, `operation=backfill-apply` and typing `BACKFILL` in the confirmation field.
- Preview safe deletion with `operation=cleanup-report` first. Production cleanup requires one profile, `operation=cleanup-apply` and exact confirmation `DELETE_VERIFIED_LEGACY_COMMENTS`.
- After each write, run report mode again and investigate duplicates, provider mismatches, tombstones, failures and rejected comment IDs. Reports contain summary counts only.
- Do not treat missing Todoist tasks as successful migration: completed, moved, or deleted mappings require a separate ownership/tombstone assessment, not a blind comment creation.

After the automatic post-deployment migration, the workflow runs
`scripts/legacy-erasure-cutover-audit.mjs`. It strongly scans the state table
for unfinished erasure operations, active profile leases/fences, journals and
replay markers, and polls both the operation queue and its DLQ. It waits for
three consecutive empty snapshots before removing only terminal operation
records and idle profile markers with conditional writes. It then strongly
rescans state and queues; live acceptance starts only after no legacy rows or
messages remain. An unresolved operation, DLQ message, active lease/fence,
journal, conditional-write race, or scan failure prevents acceptance. Queues
are never purged, and aggregate counts only are uploaded as evidence.

## Owner-authorized production migration commands

To execute a vetted migration phase without exposing arbitrary code execution, the production workflow also accepts exact **top-level issue comments** from the repository owner on the merged safety PR [#61](https://github.com/antonio1000homens/todoist-calendar-sync/pull/61). This trigger is not enabled for other users, issues, or pull requests. The protected production environment and the same mutation guardrails still apply.

Commands:

- `/mapping-migrate all report` — read-only report across all profiles
- `/mapping-migrate home backfill` — validate, then write project mappings for Home
- `/mapping-migrate antonio backfill` — validate, then write project mappings for Antonio
- `/mapping-migrate work backfill` — validate, then write project mappings for Work
- Replace `backfill` with `report`, `cleanup-report`, or `cleanup-apply` for an individual profile as appropriate.

Before issuing `cleanup-apply`, inspect the preceding cleanup report for mismatched identifiers, missing provider entities, tombstones and duplicates. Only verified application-owned task comments can be deleted.

These commands are accepted as a single full-line value; no shell fragment, extra arguments, or other issue comment content is executed. Mutation runs are processed by the same audited, per-profile migration implementation.
