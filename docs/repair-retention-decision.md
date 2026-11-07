# Repair operation retention decision (#367)

**Policy decision — 7 November 2026:** preserve the existing repair-operation lifecycle. Submitted `REPAIR#` records intentionally **have no generic TTL**; they are retained until a separately reviewed, replay-safe idempotency/notification and history-compaction migration is implemented. Do **not** introduce a 30/90-day or status-only TTL, blanket deletion, or automatic provider-side cleanup. This decision closes the normal verified-deletion residual-state question without claiming that every historical record is immediately erased.

## Why a terminal status does not mean an orphan

The current implementation reads the exact `REPAIR#<operationId>/STATE` record for multiple correctness paths:

| Consumer or writer | Evidence / reason to retain |
| --- | --- |
| `ReviewStore.submit()` | Uses a deterministic hash of actor, preview ID and idempotency key; an existing operation prevents a repeated request from starting a new repair. Old, submitted `REPAIR_PREVIEW#` rows may expire independently. |
| `ReviewEngine.execute()` and SQS worker | Re-reads the operation by ID for late deliveries, persisted checkpoint steps, successful idempotent acknowledgement, abandoned/non-resumable handling and retry suppression. |
| `ReviewStore.finalizeOperation()` | Commits success and case status together. A lost transaction acknowledgement is recovered by rereading the succeeded operation. |
| `ReviewStore.pendingNotifications()`, `deliverRepairOutcome()`, `completeNotification()` | Pending Slack notifications and their outcomes require the operation and its embedded preview/case reference. |
| `ReviewStore.dismissCase()`, `submit()`, `SyncControls`, `ReviewEngine.preview()` | Existing case `operationId`, `activeRepair` locks and prior failed/abandoned history guard ownership and prevent unsafe replacement. |
| Review API | Reads operations for operator progress, authenticated resume and post-failure reconciliation. |
| Historical review/integrity | A failed/abandoned operation can contain original preview evidence, claimed refs, checkpoint steps, and planned or partial provider writes. These details must not vanish simply because the review case is dismissed. |

An expired `REPAIR_PREVIEW#` row **is not** proof that the embedded preview or its submitted operation is reclaimable. The provider `404` is also not proof that no late work can resume or replay.

## Production read-only evidence — 7 November 2026

Strongly consistent full-table inventory of `todoist-calendar-sync-state-production` in `eu-west-2`: **3,425 items across 35 scan pages**. Direct readback also verified DynamoDB TTL is **ENABLED** on `expiresAt`.

- Across the entire state table: **8** `REPAIR#` operations, **0** live `REPAIR_PREVIEW#` rows. All eight operations have no TTL; **five failed**, **three succeeded**, all last updated 8–30 days ago.
- **Six** operations have recorded steps, write progression or other evidence that cannot be disregarded. **Two** retain `notificationPending=true`.
- **Three** are the exact operation currently referenced by their review case. **One** has four active `SYNC_CONTROL#` references; its Home repair status is failed and its case is dismissed. The distinct production repair-recovery investigation is tracked in [#369](https://github.com/antonio1000homens/todoist-calendar-sync/issues/369); do not remove those controls manually.
- **One** operation's original case is absent; the operation itself is still required for idempotency/lost-acknowledgement and may be referenced by work not visible in a DynamoDB scan.
- All eight original `REPAIR_PREVIEW#` records are missing or have already expired. That is expected because the submitted `REPAIR#` operations embed their previews.
- The two deleted #278 Home fixtures have **no matching repair/preview records** using their known exact identities. Nine related legacy significant audit records lacked exact reverse pointers but had **unexpired** `expiresAt` values at inspection. No immediate audit deletion is indicated. Protected `COMPLETED_*` history is untouched.
- The table-level scan is not an atomic snapshot if concurrent writers change rows. It does not prove SQS/DLQ emptiness, absence of late webhooks or complete cross-profile aliases.

**Conclusion:** there is no known verified-deletion orphan repair row whose physical removal can be justified; the only pre-index residuals are intended forensic audits within the seven-day TTL. Existing normal-case and index retirement is already implemented in #278. The missing terminal repair TTL is a deliberate replay/recovery safeguard, not evidence of a cleanup writer defect.

## Reusable read-only dependency report

Run in an authorised read-only environment using `dynamodb:Scan` permission on the exact table:

```bash
npm ci
export AWS_REGION=eu-west-2
export STATE_TABLE_NAME=todoist-calendar-sync-state-production
npm run state:inspect-repair-retention -- --profile=all --max-pages=60
```

The report uses strongly consistent paginated table reads, at most **100 evaluated rows per page**, per-page pacing with retries and a maximum **100 pages** (60 default). Pass `--profile=home`, `antonio`, or `work` to filter operations while checking references throughout the full state table.

It prints only aggregate counts: operation status, age bands, missing original previews/cases, pending notifications, recorded write evidence, case references, active repair controls and other durable references. It prints **no operation IDs, task/event IDs, case IDs, titles, step bodies, preview payloads or DynamoDB cursor**. The tool only emits an assessed dependency result if the scan fully completes. A partial scan emits `scanComplete=false` and exits with code 2; increase the capped page budget and rerun, preferably during low load. It **never writes** and has no `--apply` mode. No evidence from this command by itself authorises provider or state deletion.

For #278-specific audit evidence, use `state:inspect-verified-deletion-residue` per the companion [inventory runbook](./verified-deletion-residue-inventory.md).

## Retention and reclamation rules

1. **Ordinary significant `AUDIT#` rows:** retain their seven-day forensic window from #13. DynamoDB TTL on `expiresAt` is enabled but asynchronous. An unexpired or TTL-pending row is not proof of failed case retirement. Do not remove unrelated audit history.
2. **`REPAIR_PREVIEW#` rows:** retain the existing fixed `expiresAt` policy for unsubmitted/submitted previews; the submitted operation retains its own immutable copy for idempotent execution. If a genuinely malformed or unexpiring preview is discovered, investigate before applying a TTL or deleting it.
3. **`REPAIR#` rows:** no automatic TTL under the current protocol, including `succeeded`, `failed`, and `abandoned`. Preserve original operation IDs, replay suppression, retry checkpoints, notification outbox and forensic evidence.
4. **`REVIEW_CASE#`, `MANUAL#`, `SYNC_CONTROL#`, `REJECTED_PAIR#`, `COMPLETED_*`, `DELIVERY#`, erasure fences and markers:** never infer deletion eligibility from case status or provider absence. Continue following their separately documented ownership and retention policies.
5. **Future bounded reclamation is conditional on a separate design:** introduce a durable, versioned *minimal terminal operation receipt* preserving the exact idempotency key/operation ID, late worker replay handling, notification acknowledgement and reviewed original-case replacement semantics. Before removing verbose operation content, prove no active `SYNC_CONTROL#`, case, pending notification, queue/DLQ, cross-profile or repair dependency; use conditional transactions and a backup/restoration plan. Existing marker/PITR privacy decisions in #338 and erasure recovery gates in #349 remain out of scope. Do not create a purge job based only on a simple retention age.

## Decision and closure rationale

Phase A inventory and Phase C dependency review are both complete. **No row eligible for automatic deletion was established**. No new provider items or destructive tests were created, no AWS retention configuration was changed, and no state was deleted. The correct action today is to preserve the existing audited lifecycle and track the active repair-control anomaly separately as a functional recovery issue.

This is a deliberately conservative retention decision, not a claim of universal permanent retention policy or proven absence of every historical alias. If the operation count/cost, privacy requirements or an independent new failure mode warrants compaction in future, that work must be explicitly scoped, reviewed and shown replay-safe before changing this policy.
