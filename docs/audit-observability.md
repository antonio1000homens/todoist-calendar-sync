# Audit and operational observability policy

`StateRepository.audit()` is the single boundary for the application's audit
events. Every current caller is reviewed by the policy below. The caller still
gets the same asynchronous method, but the boundary now emits one safe,
single-line JSON CloudWatch record for every action and writes a DynamoDB
`AUDIT#` item only for significant events.

## Retention

New retained audit items expire after **7 days**. This change does not rewrite
existing items; their existing `expiresAt` values are left untouched and they
expire naturally. Delivery, version, baseline, reconciliation, recurrence and
projection-state TTLs are separate and unchanged.

## Classification

Routine telemetry is logs-only. The reviewed routine groups are:

| Action shape | Destination | Examples |
| --- | --- | --- |
| normal progress and successful summaries | CloudWatch only | `*_queued`, `*_requested`, `*_completed`, `*_processed`, `*_created`, `*_updated`, `*_reconciled`, `*_baselined`, `*_converged`, `*_noop*` |
| safety, conflict, ambiguity or failed/deferred work | CloudWatch + DynamoDB | `*_conflict*`, `*_ambiguous*`, `*_blocked*`, `*_suppressed*`, `*_stale*`, `*_failed*`, `*_deferred*`, `*_circuit_open`, `*_mutation_budget_exhausted` |
| mapping recovery, orphan handling and deletion outcomes | CloudWatch + DynamoDB | snapshot import/rebind, `*_orphan*`, `*_missing*`, `*_unbound*`, `*_tombstone*`, `*_deleted*`, `*_removed*`, `*_due_removed*` |
| manual intervention | CloudWatch + DynamoDB | `manual_decision_requested`, `manual_detector_*`, `manual_action_deferred_safety` |

The implementation is conservative: an action that does not match a reviewed
routine shape defaults to significant and is retained until explicitly
classified. This covers all current call sites in `calendar-reconciliation.ts`,
`reconciliation.ts`, `sync.ts`, `project-sync.ts`, `worker.ts`,
`manual-intervention.ts`, and `project-comment-migration.ts` without relying
on DynamoDB audit history as application state.

## Payload safety

`sanitizeTelemetryDetail()` retains correlation IDs, state categories, field
names, bounded counters and booleans. It drops arbitrary nested objects,
provider payloads, errors, URLs, task content, descriptions and secret-bearing
fields before the data reaches either CloudWatch or DynamoDB.

The CloudFormation template manages explicit **14-day** retention for the
ingress, worker and reconciler Lambda log groups. CloudWatch therefore keeps
routine operational history longer than the seven-day forensic DynamoDB slice.
