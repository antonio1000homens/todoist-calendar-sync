# Production DynamoDB state cleanup runbook

## Scope and findings (read-only audit, 12 October 2026)

Table: todoist-calendar-sync-state-production in eu-west-2.

The production scan returned 7,472 rows while DescribeTable.ItemCount reported 7,413 (the latter is a periodically refreshed estimate).

| Family | Rows | Default decision |
| --- | ---: | --- |
| DELIVERY | 3,643 | Preserve; 14-day TTL/deduplication state |
| AUDIT | 2,999 | Retention report; only historical 30/90-day TTL rows older than current 7-day policy are candidates |
| VERSION | 196 | Preserve; out-of-order task-version protection |
| BASELINE | 163 | Preserve; reconciliation |
| CANONICAL | 131 | Preserve; canonical comparison |
| EVENT / TASK / TASKOWNER | 256 | Preserve; three materialized views of live mappings; investigate inconsistency |
| COMPLETED_TASK / COMPLETED_EVENT | 36 | Preserve completed Calendar history. See #114: only proven-terminal COMPLETED_TASK references can be retired after seven days; COMPLETED_EVENT markers are permanent. |
| Other state | 48 | Preserve; watches, recurrence, circuit breaker, sync tokens, policy, migration marker |

The 211 initial AUDIT candidates consisted of 138 old 90-day TTL records and 73 old 30-day TTL records, both older than the application's current seven-day retention. They are **significant diagnostic records** (not "routine" log spam). **Deleting historical diagnostics is a separate approval decision** after reviewing the report and creating a verified backup.

The audit stream included 2,657 todoist_snapshot_reconcile_unmapped_conflict entries from only 17 distinct task/event pairs. Investigate why reconciliation repeatedly encounters noncanonical Calendar events; audit cleanup alone does **not** repair this root cause. Do not indiscriminately suppress safety conflicts.

Three mapping identities appeared incomplete in the initial scan (four suspect rows, Home profile). Their reference keys must be compared to *both providers* and the completed-projection/tombstone state. This script performs a fresh, strongly consistent read of all three expected mapping copies for each anomaly, but **never deletes or rewrites mappings**. Provider validation and a separate reviewed repair are mandatory.

## What the tool does

npm run state:inspect builds the project and scans the exact table specified by STATE_TABLE_NAME, in bounded 25-item pages paced to ~5 DynamoDB read capacity units per second. Report mode is **always the default** and performs no writes.

Report includes family totals, 30-/90-day historical AUDIT TTL candidates older than seven days, counts by action, hashed repeated conflict pairs, and fresh mapping-index anomaly checks. No raw task IDs or Calendar event IDs are printed by the report.

Historical AUDIT deletion is optional and separate from the report. It:

- Requires explicit --apply-audits, a literal confirmation, and a valid on-demand backup ARN created in the last 24 hours.
- Verifies the supplied backup belongs to this table and is AVAILABLE, requires point-in-time recovery ENABLED, and verifies the expiresAt TTL configuration.
- Defaults to a strict upper limit of **250** candidate deletions; a larger run must opt in with --max-deletes=N (maximum 1000).
- Selects **only** AUDIT rows with a valid profile/action and timestamps, original **30-/90-day** TTL, still awaiting original TTL expiry, and at least **seven full days** since creation.
- Strongly rereads every candidate and conditionally deletes only when createdAt, expiresAt, and action still match. Races skip the row, not overwrite or delete changed state.
- This *audit deletion* script never touches EVENT, TASK, TASKOWNER, COMPLETED_*, CANONICAL, BASELINE, RECURRENCE, DELIVERY, or any other non-AUDIT family; it does not call Google Calendar or Todoist and does not change their data. The separate #114 completed-history retirement operation has a distinct safety policy.

## Read-only report

Run in an authorized environment with production read-only AWS permissions:

~~~bash
npm ci
npm test
export AWS_REGION=eu-west-2
export STATE_TABLE_NAME=todoist-calendar-sync-state-production
npm run state:inspect
~~~

Review historical audit classification, per-action counts, repeated conflict pairs, and mapping anomaly fingerprints. Do **not** infer deletability from the absence of a matching projection index alone.

## Optional production audit deletion (separate, explicit approval)

Create a fresh on-demand backup within the preceding 24 hours and ensure it is AVAILABLE. Confirm DynamoDB point-in-time recovery is enabled.

~~~bash
export BACKUP_ARN="$(aws dynamodb create-backup \
  --region eu-west-2 \
  --table-name "$STATE_TABLE_NAME" \
  --backup-name "before-todoist-sync-audit-cleanup-$(date -u +%Y%m%d%H%M%S)" \
  --query 'BackupDetails.BackupArn' --output text)"

aws dynamodb describe-backup --region eu-west-2 --backup-arn "$BACKUP_ARN" \
  --query 'BackupDescription.BackupDetails.BackupStatus' --output text
~~~

Require AVAILABLE before proceeding. Once the reviewed dry-run counts are acceptable, invoke:

~~~bash
npm run state:inspect -- \
  --apply-audits \
  --confirm=DELETE_EXPIRED_LEGACY_AUDITS \
  --backup-arn="$BACKUP_ARN"
~~~

A report is printed **before** deletion; the final result contains deleted and changed (items skipped after a fresh reread or conditional race). If there are more than 250 candidates, the command refuses to run; rerun the report and explicitly choose a bounded --max-deletes only after reviewing the updated data.

Run npm run state:inspect again, verify table and GSI activity, watch worker/DynamoDB throttling, and verify that all three profiles reconcile normally. The table remains protected from deletion and provider history is untouched.

## Follow-up mapping repair (not part of this PR)

1. For each reported incomplete/overwritten mapping fingerprint, inspect the exact DynamoDB key triplet with strong reads.
2. Compare Todoist task (including completion/project status), Calendar event (including cancellation), canonical metadata, completed history, and recurrence/tombstones.
3. If a link was superseded, repair/remove it using an explicit condition on the expected task/event/version, only after recovery evidence is retained.
4. Re-run reconciliation and confirm no duplicate events/tasks, no loss of completed-task Calendar history, and stable three-key/GSI parity.
5. Investigate 17 repeatedly conflicting task/event pairs. A reduction in audit rows without fixing the conflicts would conceal the symptom rather than resolve it.

Do **not** automatically delete SYSTEM#PROFILE_LOOKUP_INDEX or unindexed RECURRENCE rows: the former is retained migration evidence; a legacy recurrence row can still be written by recordRecurrence and may be needed for compatibility.


## Terminal completed-task history (issue #114; new independent maintenance operation)

Completion already drops the active EVENT/TASK/TASKOWNER mapping. An immutable
`COMPLETED_EVENT#profile#eventId` marker remains **indefinitely** to block Calendar
webhook, snapshot and orphan recovery from creating a duplicate Todoist task.
Its initial `completedAt` is immutable: a replay must never reset the grace
period or recreate a retired `COMPLETED_TASK` row.

The new scheduled `CompletedHistoryCleanupFunction` inspects at most ten pages
of 25 evaluated items every day, paced at five read units/second and using a
durable cursor in apply mode. Its stack parameter
`CompletedHistoryCleanupApply` defaults to **false** (dry-run only). It scans
only candidate `COMPLETED_TASK` rows, groups the task's strongly consistent
completion references, and retires all eligible task-side completion lookup
rows in **one guarded transaction**, retaining `COMPLETED_EVENT`. It can also
remove a strictly older baseline with a timestamp condition. It checks all
three profiles' task mapping indexes, the global TASKOWNER, event mapping
indexes, and recurrence ownership before writing. A missing/changed guard,
unverified recurrence, more than 12 history rows, or an active owner is a
*safety skip*, never permission to delete. A verified exhausted recurrence
uses an immutable `COMPLETED_SERIES#profile#seriesId` certificate (no Todoist
task reference) to retire older occurrences in safe transactional batches of
at most 12 event references; without the certificate a truncated multi-row
history query is always skipped. Version, canonical, tombstone,
audit, delivery and other state are untouched.

Eligibility starts at **seven full 24-hour periods** since the latest
persisted completion. A missing Todoist task, old due date, cancelled instance,
or lack of an available next occurrence does **not** establish terminality.
Calendar-owned finite COUNT/UNTIL series can be marked terminal only after
confirming the current master and absence of a successor and atomically
retiring its unchanged recurrence link. Todoist-owned rolling series require
a freshly returned completed provider task with no recurring due. Finality
is recorded as a permanent series certificate, which allows cleanup of older
occurrences only after the latest terminal completion's seven-day grace.
All other recurring histories deliberately remain in `skipped_ambiguous`
for human review. The **scheduled worker never modifies live providers**.
Project mapping comments require a separate provider-aware, human-reviewed
operation; they are never removed merely because a task lookup row vanished.

### Operator-only project-comment retirement

The optional `state:cleanup-completed-comment` CLI examines **one explicit
Todoist project comment** with a strict profile/task/event/comment identity.
It is dry-run by default and requires Todoist read access, read-only DynamoDB
inspection and an event-side immutable `COMPLETED_EVENT` guard. It requires
seven full days from the preserved completion timestamp, a Todoist 404,
absence of mapping and recurrence ownership **across all three profiles**,
and, for recurring histories, a matching terminal-series certificate.
In addition to keyed lookups, each preflight fully paginates a **strongly
consistent, full-table DynamoDB scan** of canonical recurrence links to
catch any link rebinding under a previously unknown series ID. This can
consume significant read capacity on large tables. Check table capacity
and execute during a quiescent maintenance window. A failed or incomplete
scan aborts without deleting anything; a GSI-only query is not a safe
substitute because GSI reads are eventually consistent.
Provider API failures, ambiguous ownership, legacy task comments, foreign
projects, and missing identifiers **skip or fail**, never delete.
It rechecks the provider comment, completion guard and current mappings
immediately before a confirmed delete. Because Todoist's comment delete API
has no conditional ETag and is outside DynamoDB transactions, concurrent
provider edits in the final milliseconds cannot be excluded absolutely.
Run only during a quiescent maintenance window and verify the recorded
comment ID has not been reassigned. No automation is enabled for this CLI.

Dry-run example (repeat for a specifically verified remaining comment):

```bash
npm run state:cleanup-completed-comment -- \
  --profile=home --task-id="<completed Todoist ID>" \
  --event-id="<historical Calendar event ID>" \
  --comment-id="<Todoist project mapping comment ID>"
```

After independent operator approval, run the **same exact identity** with
`--apply --confirm-comment-id="<Todoist project mapping comment ID>"`.
This deletes only that one verified project comment. It never deletes
a Todoist task, a Calendar event, any DynamoDB record, or any event-side
completion guard. CLI returns a nonzero exit code on safety skips.
A missing/ambiguous comment requires investigation rather than removal.
Provider-side cleanup is intentionally **not** included in the scheduled
Lambda permissions or the automatic seven-day maintenance apply workflow.

The CLI closes the project-comment gap for specifically identified, verified
records, but does not enumerate all comments automatically. Broader
bulk automation and exact provider-write race coordination require a
separately reviewed design; until then do not claim that *all* legacy
project comments have been retired.

### Verification and staged activation

1. Deploy with `CompletedHistoryCleanupApply=false` and examine the daily
   CloudWatch `terminal_completed_history_cleanup_report` counts. No
   completed rows are written by this default schedule.
2. Use an authorized read-only session to run `npm ci` then
   `npm run state:cleanup-completed -- --max-pages=40`. The output is a
   dry-run report with `eligible`, `retired`, `skipped_active`,
   `skipped_ambiguous`, `too_recent`, `failed`, and an encoded
   `nextCursor`. Continue with `--cursor=<nextCursor>` to audit other
   bounded pages. Do not interpret a page report as a whole-table count.
3. Inspect sample task/event marker pairs, recurrence links, all three mapping
   copies, and any Todoist project comment references. Check Calendar events
   are still visible and replaying those events does not recreate tasks.
4. After separate change approval, create an on-demand DynamoDB backup for the
   exact state table and verify backup AVAILABLE and PITR enabled. For a
   small operator-controlled apply run, execute:

   ```bash
   npm run state:cleanup-completed -- \
     --apply --max-pages=2 \
     --confirm=RETIRE_TERMINAL_COMPLETED_TASK_REFERENCES \
     --backup-arn="$BACKUP_ARN"
   ```

   The CLI validates the backup belongs to this table, is AVAILABLE and was
   created in the last 24 hours. Scheduled apply additionally requires an
   explicitly reviewed stack configuration change setting the parameter to
   `true` and has no provider write permissions.
5. Compare the before/after `COMPLETED_TASK` rows, permanent
   `COMPLETED_EVENT` markers and mapping triplets; replay an old Calendar
   delta, Todoist deletion and snapshot; watch for throttling and failed
   conditions. Do not run any production backfill or apply as part of the PR.

Late Todoist `item:deleted` after seven days is suppressed independently of
this schedule, even when COMPLETED_TASK is still present. Once the task lookup
has been removed, the event-side guard continues to block destructive delete
and stale update recovery. Explicit deletion of an active mapped task remains
on the existing path; younger one-off completion deletion retains its prior
semantics.
