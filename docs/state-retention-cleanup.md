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
| COMPLETED_TASK / COMPLETED_EVENT | 36 | **Never delete**; completed-task calendar history |
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
- Never touches EVENT, TASK, TASKOWNER, COMPLETED_*, CANONICAL, BASELINE, RECURRENCE, DELIVERY, or any other non-AUDIT family; it does not call Google Calendar or Todoist and does not change their data.

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
