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
   The production workflow reads the externally configurable
   `vars.COMPLETED_HISTORY_CLEANUP_APPLY` (default `false`) and verifies
   the deployed Lambda and rule. Manual dry-run remains available via
   `npm run state:cleanup-completed`. Once #277 is deployed, a terminal
   standalone completion holds its mapping for seven full days; the worker
   then retires the unchanged mapping triplet together with the
   `COMPLETED_TASK#` lookup. `COMPLETED_EVENT#` guards remain permanent.

**The earlier read-optimisation changes (#259/#260) do not purge records.**
When this cleanup feature is explicitly enabled, it **does** retire eligible
seven-day-old task indexes and matching standalone mapping rows in guarded
transactions. Active review cases/repairs and all completed Calendar history
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

1. **Merge and deploy #277 first**, with the production environment variable
   `COMPLETED_HISTORY_CLEANUP_APPLY` unset or `false`. Verify that completion
   retains its `EVENT#`/`TASK#`/`TASKOWNER#` mapping until the guarded
   seven-day retirement, and that uncompletion does not mutate Calendar.
2. Review #255–#258 for concurrent edits to `template.yaml` (capacity, SQS,
   alarms and Budgets). Inspect the CloudFormation change set before deploy:
   there must be no table/GSI replacement, TTL change, unapproved data purge
   or surprise enabling of cleanup.
3. Merge the schedule-control PR (#275) with the toggle still `false`.
   Confirm `CompletedHistoryCleanupApply=false`, Lambda apply=false,
   and the deployed EventBridge rule **DISABLED**. Manual dry-run continues
   to be available.
4. Only after #277 is in the *exact deployed revision* and its CI/retirement
   behaviour is verified, set the **production environment variable**
   `COMPLETED_HISTORY_CLEANUP_APPLY=true` in GitHub and trigger a new
   deployment (manual `workflow_dispatch` is supported). The workflow
   performs an additional prerequisite-source gate and verifies that stack
   parameter, Lambda apply flag and EventBridge rule all reflect `true`.
5. Observe the first scheduled maintenance report, terminal/ambiguous/active
   skip counts, completion guards, mapping transitions, DynamoDB throttles,
   and all three profiles. Historical Calendar events must remain unchanged.
6. **Rollback without changing application code:** set the production
   environment variable to `false`, trigger the deployment again and
   verify that the rule is `DISABLED` and Lambda apply=false. Previously
   retired indexes are not automatically resurrected. Never delete
   historical Calendar events or completion guards as a rollback.

Reduced reads/writes improve capacity headroom; with DynamoDB
**provisioned billing**, charges fall only if provisioned RCU/WCU is
subsequently reduced (#255). This patch alone is not a guaranteed bill saving.

## Production activation control (November 2026)

`.github/workflows/deploy.yml` reads the production environment variable
`vars.COMPLETED_HISTORY_CLEANUP_APPLY`, defaulting to **`false`**.
`deploy.sh` passes it to CloudFormation's `CompletedHistoryCleanupApply`
parameter. This is deliberately not hard-coded to `true`: merging #275
before #277 or a routine automatic deployment cannot activate destructive
cleanup unexpectedly.

The EventBridge schedule is an explicit `AWS::Events::Rule` with
`State: !If [RunCompletedHistoryCleanup, ENABLED, DISABLED]`; the old SAM
`Schedule.Enabled` expression was flattened to enabled in the processed
CloudFormation template. The explicit rule and Lambda permission reuse the
previous generated logical IDs, avoiding a duplicate schedule.

**#277 retained-mapping lifecycle:** completing a standalone Todoist task
preserves its exact active mapping for seven days, without changing Calendar.
Explicit uncompletion during that grace can cancel pending retirement after
authoritative provider/transaction checks, also without touching Calendar.
After seven full days of continuous terminal completion, the worker retires
the exact unchanged mapping triplet and the task-facing completion lookup,
while permanently retaining the event-side completion guard and Calendar
history. A newly created task has a new ID and must create a *new* Calendar
event, never reuse a historical event by title/date. Recurring tasks retain
their separately guarded terminality policy.

For activation, first deploy and verify #277, then set the external production
variable to `true` and re-deploy. The workflow refuses to activate when
the required source-level retained-mapping implementation and regression
tests are missing. Verify stack parameter, Lambda variable and EventBridge
rule state after deployment; set the variable back to `false` and redeploy
for immediate scheduled-retirement rollback.
