# DynamoDB historical-state query and retention efficiency (#259)

## Intent and safety boundary

Reduce DynamoDB traffic caused by Calendar changes that are already known to
be irrelevant. **Do not infer that a task is completed from the event's age
alone**: Todoist may have overdue active tasks, and a past recurrence
occurrence can still belong to a live series. This optimisation preserves the
existing standalone-elapsed-event policy but moves its check before event-keyed
DynamoDB lookups. Missing or ambiguous event data always goes through the
normal ownership/completion/recurrence checks.

Google Calendar webhooks do not contain changed event IDs. The incremental
`events.list(syncToken=...)` request, persisted `SYNC#` cursor and the SQS
delivery receipt are still necessary even for an all-history delta. Do not
apply a `timeMin` filter to incremental Calendar token requests.

### Production record families and their uses

| Family | Producer / consumer | Current retention | Risk / decision |
| --- | --- | --- | --- |
| `EVENT#`, `TASK#`, `TASKOWNER#` | Mapping transactions; workers, repairs, recovery | Live only | **Keep**, including cross-profile ownership checks |
| `RECURRENCE#` / recurrence links | Calendar/Todoist series writers, progression, recovery | Series lifecycle | **Keep**, including expired-but-unverified series |
| `DELIVERY#` | Worker idempotency/replay | 14-day TTL | **Keep** |
| `BASELINE#` | Bidirectional reconciliation | 90-day TTL | **Keep** for active comparisons |
| `CANONICAL#` | Orphan identity matching | Default 90-day TTL | **Keep** pending identity-recovery analysis |
| `VERSION#` | Out-of-order Todoist webhook protection | Lifecycle-dependent | **Keep** |
| `COMPLETED_TASK#` | Task-side completion lookup and #114 guarded cleanup | Verified terminal + 7 days only | **Guarded retirement only**, not blanket TTL |
| `COMPLETED_EVENT#` | Calendar replay/orphan/duplicate suppression | Permanent | **Never blindly delete** |
| `COMPLETED_SERIES#` | Terminal recurrence certificate | Permanent | **Keep** |
| `AUDIT#` | Significant/unknown safety actions; active review seeder | 7-day TTL on new rows | **Keep** forensic window and conflict dedupe |
| `CONFLICT_STATE#`, `REVIEW_CONFLICT#` | Active incident lifecycle/review coalescing | Lifecycle-dependent | **Keep** unless no active references |
| `REVIEW_CASE#`, `MANUAL#`, `REPAIR#`, `REPAIR_PREVIEW#` | Human review, repair resume, notifications, idempotency | No universal closed-case TTL | **Leave unchanged** until recovery and notification dependencies are verified |
| `SYNC#`, `RECONCILE#`, cursors, watches, circuit/erasure state | Progression, availability and safety | Lifecycle-dependent | **Keep** |

`ProfileLookupIndex` already handles profile-scoped mapping, recurrence and
pending-decision reads. There must be **no full-table scan on the normal
mapping/recurrence reconciliation path**. Its eventually consistent results
are not a substitute for strongly consistent checks before history deletion.

### Low-risk changes in this PR

1. Confirmed, standalone Calendar events whose *actual end* has elapsed
   take the no-op path **before** `getMappingByEvent` and
   `getCompletedCalendarProjectionByEvent`. This applies to already-elapsed
   one-offs, not an arbitrary seven-day age threshold; existing behaviour
   already ignored these events after reading their mapping.
2. Orphan preflight/identity memory no longer reads DynamoDB for confirmed
   elapsed one-offs or explicitly archived `syncHistoryOnly=true` objects.
   The delegated synchroniser still processes the Calendar delta and advances
   its cursor. A recurring instance without its parent's explicit archive
   marker is **not** treated as a standalone event.
3. Snapshot recovery prefilters elapsed standalone candidates before its
   per-invocation candidate window. Cancelled events, recurrence masters and
   instances, and events with missing end/timezone data remain on the normal
   safety path.
4. These **two exact** audit actions are CloudWatch-only routine telemetry:
   `calendar_elapsed_standalone_event_ignored` and
   `calendar_archived_series_delta_ignored`. Other unknown or concerning
   `*_ignored` actions still produce significant `AUDIT#` records.
5. The completed-task maintenance schedule is controlled by an explicit
   EventBridge rule whose State reflects `CompletedHistoryCleanupApply`.
   The owner-approved production workflow sets this flag to `true` and verifies
   the deployed Lambda and rule. Ad-hoc/new-stack deployments default to
   `false`, and manual dry-run remains available via
   `npm run state:cleanup-completed`. Only task-facing `COMPLETED_TASK#`
   rows are eligible for guarded retirement after seven full days; the
   `COMPLETED_EVENT#` duplicate-prevention markers remain permanent.

**No production records are purged or reindexed by these changes.** In
particular, active review cases/repairs and all completed Calendar history
guards are retained.

### Why we are not adding TTLs or a cleanup index

Expired TTL records can remain physically present after their deadline. A
blind 30- or 90-day TTL on closed `REVIEW_CASE#`, terminal `REPAIR#` or
`REPAIR_PREVIEW#` records can break repair resume, the historical view,
notification delivery and idempotency where these cross-reference each other.
First inventory each state transition and durable consumer (especially failed,
abandoned, succeeded-but-not-notified and excluded operations). Until then
**retain all review and repair records**. An optional future ticket may
introduce terminal-only conditional cleanup after an operator-approved backup
and migration plan.

`scripts/seed-review-inbox.mjs` still reads active conflict `AUDIT#`
records to reconstruct the review inbox: those audits cannot be eliminated
until review cases are independently re-seedable.

The current completed-task maintenance scan is intentionally a bounded
full-table scan plus strongly consistent, per-identity verification. A future
indexed due-date worklist would add GSI write amplification and provisioned
RCU/WCU, so it must be costed against #255 and must never replace strong
terminality/ownership checks. This PR avoids a new index.

## Read-only baseline and acceptance measurements

Historical baseline from the 1 November 2026 read-only audit:
- Main production DynamoDB table: approximately **5,472** items, **1.52 MB**
  (`DescribeTable` estimates, not exact real-time counts).
- `ProfileLookupIndex`: approximately **407** items, **0.28 MB**.
- Main provisioned 25 RCU / 25 WCU, GSI 5 RCU / 5 WCU.
- October historical audit report: 2,999 `AUDIT#` items and repeated
  unmapped conflicts. This report precedes the current dedupe policy, so do
  not represent it as the present write rate.
- These are **not** measured per-operation consumed capacity savings.

Use existing CloudWatch metrics/logs to compare a fixed **7–14 day** window
before and after deployment, with the same number/type of incoming deltas:
- `dynamodb_query_complete`: operation, page count, evaluated/returned count
  and duration. The logger currently returns 0 consumed units when the
  caller does not request `ReturnConsumedCapacity`—**do not** interpret
  that value as no charge.
- `ConsumedReadCapacityUnits`, `ConsumedWriteCapacityUnits` for table and
  `ProfileLookupIndex`; 1-minute `ReadThrottleEvents` and
  `WriteThrottleEvents`; FIFO queue age and DLQ count.
- `calendar_elapsed_standalone_event_ignored` and
  `calendar_archived_series_delta_ignored` CloudWatch event counts. Their
  DynamoDB `AUDIT#` write count becomes **zero for new deliveries**.
- Scheduled `terminal_completed_history_cleanup_report` invocations and
  `DRY_RUN_STATE` writes become **zero** while apply=false. A manually
  invoked CLI or Lambda is an intentional exception.
- Snapshot `calendar_scanned` / continuation count, elapsed-event
  classification (offset datetime vs Calendar-local exclusive all-day end),
  recurrence progress and completed-history replay.
- Review history accessibility and active incident recovery; `home`,
  `antonio` and `work` smoke checks.

Read-only preflight:

```bash
aws cloudformation describe-stacks --region eu-west-2 --stack-name todoist-calendar-sync \
  --query "Stacks[0].Parameters[?ParameterKey=='CompletedHistoryCleanupApply']"
aws dynamodb describe-table --region eu-west-2 \
  --table-name todoist-calendar-sync-state-production \
  --query "Table.{Items:ItemCount,Bytes:TableSizeBytes,GSI:GlobalSecondaryIndexes[*].{Name:IndexName,Items:ItemCount,Bytes:IndexSizeBytes}}"
```

Read-only code verification:

```bash
npm ci
npm test
sam validate --template-file template.yaml --lint
```

## Staged deployment and rollback

1. Review #255–#258 for concurrent edits to `template.yaml`; do not overwrite
   capacity, SQS redrive, alarm or AWS Budget changes.
2. Confirm `CompletedHistoryCleanupApply=false` in the *deployment parameter*
   and the CloudFormation change set. No table/GSI replacement, TTL change,
   retention purge, or enabling of automatic cleanup.
3. Deploy, verify the EventBridge completed-cleanup schedule is disabled, and
   replay historical one-off, archived master, overdue one-off, future-moved
   one-off, cancelled event, recurring master/instance and completed-history
   test cases.
4. Check worker failure, SQS DLQ, sync-cursor progress, mutation safety and
   all three profiles. Monitor 1-minute throttle spikes, not just averages.
5. Roll back the application code and schedule config if any recurrence
   progression, mapping ownership, sync cursor or review/erasure safety
   regresses. **Do not** delete historical records to roll back.

Reduced reads/writes improve capacity headroom; with DynamoDB
**provisioned billing**, charges fall only if provisioned RCU/WCU is
subsequently reduced (#255). This patch alone is not a guaranteed bill saving.

## Production activation (November 2026)

Owner-approved deployment now explicitly supplies
`COMPLETED_HISTORY_CLEANUP_APPLY=true` in `.github/workflows/deploy.yml`,
which `deploy.sh` passes to `CompletedHistoryCleanupApply`. The deployed
EventBridge rule is defined as `AWS::Events::Rule` with an `ENABLED`/`DISABLED`
`Fn::If` on `State` because the former SAM `Schedule.Enabled` conditional
was flattened to `ENABLED` in the processed CloudFormation template.
Both the rule and invocation permission reuse their pre-existing generated
logical IDs, keeping the CloudFormation update in place.

Production's active schedule only retires task-side completion lookups after
guarded terminality verification. It **does not restore** completed mappings
when users uncomplete a Todoist task or move its date: the synchronizer still
ignores a linked event with a `COMPLETED_EVENT#` guard. Todoist project
comments and Calendar `shared.taskId` are valuable identity breadcrumbs
but do not themselves implement verified reactivation. A separate
conditionally atomic reactivation path is needed before claiming that
behaviour; do not remove permanent event-side guards to fake it.

Verify `CompletedHistoryCleanupApply=true` on the deployed stack, its
Lambda environment variable, and `events describe-rule` State=ENABLED.
For rollback, deploy `COMPLETED_HISTORY_CLEANUP_APPLY=false` and confirm
State=DISABLED. No historic Calendar event or permanent completion guard
deletion is authorised.
