# #349 bounded project-comment tombstone; no DynamoDB deleted-task identity

## Current policy

An exceptional erasure rewrites the exact existing Todoist project mapping comment as a guarded deletion marker. The marker remains after provider and DynamoDB cleanup so current workers can suppress queued or retried stale deliveries after the operation fence is released. The existing 18-day expiry bounds its lifetime; the tombstone cleanup job removes expired markers. No deleted-task identity is retained in DynamoDB after successful cleanup.

The existing 18-day expiry also covers the post-success queue and retry window. It does not cover arbitrary manual redrive or direct invocation after expiry. An untrusted or moved comment remains a review failure; do not create a replacement.

Do not write a permanent HMAC replay marker or deleted task/event identity to DynamoDB after successful completion. The final completion transaction removes the operation, confirmation, and owned fence after fresh provider/state checks and exact active project-comment tombstone readback. The existing Todoist project comment carries the task/event identity until expiry.

## Bounded known-identity recovery

The guarantee covers only identities recorded in the confirmed operation: its Todoist task, selected Calendar event, and explicitly recorded recurrence/profile aliases. It does not prove that unknown Calendar copies, external integrations, exports, or backups are absent. The outcome is `known_identity_deleted`, not global erasure. The signed Calendar ACL observer in [`erasure-calendar-provenance.md`](./erasure-calendar-provenance.md) is optional and is not a #349 release prerequisite.

### Deletion flow

1. Build and confirm a fresh operation for exact provider identities. Missing, changed, ambiguous, or unrecorded targets block the operation.
2. Stop new queue admissions and writers using the existing profile lease/fence protocol. Disable the worker mappings recorded by the operation, drain in-flight writers, install the fence, and wait out the configured worker timeout.
3. Rewrite the exact inventoried Todoist project mapping comment as a tombstone. Read it back and verify its comment ID, project, task ID, aliases, and expiry before continuing.
4. Delete only the provider objects selected by the confirmed operation. Direct reads and deletion receipts must match the original target. A changed or unavailable provider response leaves the operation fenced for review.
5. Verify provider deletion, removal of attributable DynamoDB state, and each exact active project-comment tombstone while the fence is still held. Only then restore and verify the SQS worker mappings that were enabled before the operation.
6. Atomically remove the completed operation, confirmation, and operation-owned fence. Each delete-stage action first writes a conditional attempt claim for its exact checkpoint. Successful progress clears that claim atomically with the advanced checkpoint; if the checkpoint acknowledgement is lost, redelivery sees the claim and will not repeat the provider action. After the configured worker timeout, an unresolved claim is moved to `review_required`, still fenced, for operator inspection. A lost final transaction acknowledgement is resolved by exact readback.

Exact `DELIVERY#…/COMPLETED` receipts for this task/event are included in the
confirmed inventory only when their profile, kind, and full identity-reference
schema are valid. Under the profile fence, the worker re-reads every active
project tombstone immediately before removing the selected task and event IDs
from each receipt. It preserves the hashed completion key and references to
other tasks, events, and series, so a redelivered completed message remains
deduplicated while DynamoDB no longer records the erased identity. Pending
receipts, legacy receipts without exact identity, malformed receipts, and
receipts that identify the selected item as a recurrence series remain
blockers. The generic operator purge path keeps its default rule that all
delivery receipts block. Scrubbed receipts continue under the normal 14-day
TTL; this does not change the separate seven-day completed-task lifecycle.

A missing or changed tombstone, incomplete postflight, lease/epoch drift, failed mapping restore, or uncertain commit remains actionable and fenced. The worker does not automatically resume an ambiguous destructive step. Operators use the authenticated review flow and a new scoped approval for any retry or repair.

### Replay admission

Under the existing writer lease, the Todoist sync path reads fresh project
comments for every recognized webhook lifecycle, including completion and
uncompletion, before task reads, provider mutations, or identity-bearing state
writes. The Calendar delta path also reads a fresh project-comment inventory
before event-specific processing. The SQS worker checks Todoist deletion
webhooks before manual-review interception, where they could otherwise create
review state. An active marker suppresses a matching ID with an identity-free
audit and without an identity-bearing delivery receipt.

The source checks and lease protocol prevent an admitted writer from racing marker installation only when every live caller uses the current guarded code and lease. Source code alone does not prove that published historical Lambda versions, IAM invokers, direct URLs, or rollback paths use these checks. Those boundaries remain tracked in [#347](https://github.com/antonio1000homens/todoist-calendar-sync/issues/347).

## BAU behavior and lifecycle

The tombstone applies only to its exact recorded identity while active. In normal sync without a matching marker, existing Todoist/Calendar deletion, update, and recurrence behavior continues. The separate seven-day completed-task mapping retention and historical Calendar event rules are unchanged. Ordinary completion does not create an erasure marker.

After the 18-day tombstone expires, arbitrary manual redrive or direct invocation may no longer be identifiable as stale. This retention window does not replace #347's requirement to deny unsafe historical invocation paths. The design does not claim permanent replay prevention.

## Marker cleanup

Report expired markers for one configured profile:

```bash
npm run cleanup:erasure-tombstones -- --profile=work
```

Apply only after reviewing the report and confirming the exact scope:

```bash
npm run cleanup:erasure-tombstones -- --profile=work --apply \
  --confirm=DELETE_EXPIRED_ERASURE_TOMBSTONES
```

The apply path re-reads each candidate and deletes only the unchanged, expired comment in the configured project. It does not scan or delete DynamoDB rows, task comments, active markers, or unrelated project comments.

### Repeatable current-runtime retirement audit

Repeat the **current-runtime**, read-only check during rollback or release review:

```bash
npm run audit:legacy-hmac-retirement -- \
  --profile=<AWS_PROFILE> \
  --expected-account=<ACCOUNT_ID> \
  --region=eu-west-2 \
  --stack=todoist-calendar-sync
```

The command validates the exact AWS account, discovers the stack's DynamoDB
table and Lambda functions, queries the three HMAC partitions, and reads
`$LATEST`, active aliases and any weighted alias targets. It returns only
boolean HMAC configuration presence, no environment values or marker identity.
Any marker, configured legacy setting or incomplete read blocks readiness.

## Retired HMAC admission and compatibility safety

The obsolete permanent DynamoDB/HMAC marker writers and post-write release code were removed in #437. The historical **admission reader** has now also been retired from current source; the remaining `ERASURE_REPLAY_BARRIER_VERSION` environment switch is a **fail-closed compatibility tripwire**. Unset, empty or `0` allows the current path, while `1` or any unknown nonzero value refuses admission. Do **not** turn on the obsolete switch.

Read-only production verification on **10 November 2026** (`eu-west-2`) found:
- Strongly consistent DynamoDB queries for `ERASURE_REPLAY#antonio`, `ERASURE_REPLAY#home` and `ERASURE_REPLAY#work`: **zero rows**, no pagination;
- A strongly consistent full-table scan (2,791 evaluated items) with all three historical prefixes `ERASURE_REPLAY#`, `ORPHAN_REPLAY_GUARD#` and `ERASURE_POSTWRITE_RESTORE#`: **zero matches**;
- All seven current stack Lambda configurations and the Review API `live` alias had `ERASURE_REPLAY_BARRIER_VERSION` unset and neither old HMAC keyring variable configured. The Review API and erasure worker retained `ERASURE_EXECUTION_ENABLED=false`.

These observations support removing the dormant HMAC lookup, **not** a claim about every historical Lambda version, AWS principal or future rollback. Current production invokes only the bounded Todoist project-comment tombstone and independently retained profile writer/retirement-admission protections. Do not delete live DynamoDB records or weaken the separate #347 historical-invocation review based solely on this inspection. Historical Lambda package/alias, IAM and rollback acceptance and the #349 disposable-erasure E2E remain separate requirements.


The bounded project-comment implementation from #403–#405 is deployed to current production master. Deployment run 42536045650 succeeded. The `todoist-calendar-sync` stack is `UPDATE_COMPLETE` with `ErasureExecutionEnabled=false`; the live Review API execution setting is false, and the replay-barrier setting remains absent. The erasure worker mapping is enabled.

This does not close #347: the 10 November 2026 read-only live check found eight stack Lambda functions, 240 numeric published versions and two aliases. All 250 numeric-version/unqualified/alias resources returned their expected direct-invocation Deny; this does not prove every effective IAM caller, authenticated Function URL, service invocation or rollback/redeployment path is safe. Historical package-marker strings are not proof of check ordering. #349's disposable Work-profile fault-injection acceptance also remains outstanding. Keep exceptional erasure disabled, uncertain operations fenced, and do not force-enable source mappings, release fences or replay messages until independently reviewed acceptance passes.
