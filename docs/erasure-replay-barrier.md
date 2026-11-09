# #349 bounded project-comment deletion markers

## Current policy

A successful exceptional erasure leaves its short-lived replay marker in the exact existing Todoist project mapping comment. The marker contains the confirmed Todoist task ID, explicitly recorded Calendar event IDs, profile, project, and expiry. It is written and read back before the selected provider deletion steps continue. The Calendar event can therefore be removed while the Todoist project comment remains available to suppress stale messages.

The marker expires 18 days after the verified rewrite. This covers the live four-day FIFO sync queue plus the fourteen-day FIFO DLQ; SQS resets message age when a FIFO message moves to its DLQ. Operator redrive resets retention again, so a manual replay after marker expiry cannot be distinguished by retained identity. Expired markers are removed only by the operator-run report/apply workflow; there is no scheduled cleanup. The Todoist comment ID must remain the same. If that exact comment is missing, moved, or cannot be updated and read back, the erasure stays fenced for review rather than creating a replacement comment.

Do not write a permanent HMAC replay marker or deleted task/event identity to DynamoDB after successful completion. The final completion transaction removes the operation, confirmation, and owned fence after fresh provider/state checks. The project comment is the bounded identity store during the replay window.

## Bounded known-identity recovery

The guarantee covers only identities recorded in the confirmed operation: its Todoist task, selected Calendar event, and explicitly recorded recurrence/profile aliases. It does not prove that unknown Calendar copies, external integrations, exports, or backups are absent. The outcome is `known_identity_deleted`, not global erasure. The signed Calendar ACL observer in [`erasure-calendar-provenance.md`](./erasure-calendar-provenance.md) is optional and is not a #349 release prerequisite.

### Deletion flow

1. Build and confirm a fresh operation for exact provider identities. Missing, changed, ambiguous, or unrecorded targets block the operation.
2. Stop new queue admissions and writers using the existing profile lease/fence protocol. Disable the worker mappings recorded by the operation, drain in-flight writers, install the fence, and wait out the configured worker timeout.
3. Rewrite the exact inventoried Todoist project mapping comment as a tombstone. Read it back and verify its comment ID, project, task ID, aliases, and expiry before continuing.
4. Delete only the provider objects selected by the confirmed operation. Direct reads and deletion receipts must match the original target. A changed or unavailable provider response leaves the operation fenced for review.
5. Verify provider deletion, the active tombstone, and removal of attributable DynamoDB state. Restore and verify only the SQS worker mappings that were enabled before the operation.
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

After the 18-day marker expires and is explicitly removed, the retained comment can no longer identify an arbitrarily late or manually replayed message. The 18-day window covers one ordinary SQS/DLQ cycle; operator redrive or manual replay after expiry remains a known limit. The design does not claim permanent replay prevention.

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

## Legacy HMAC code and release status

The repository still contains the earlier DynamoDB/HMAC replay-barrier code for compatibility and historical review. It is not the selected #349 completed-erasure storage model, and no new #349 completion writes those HMAC marker rows. Keep the existing `ERASURE_REPLAY_BARRIER_VERSION` configuration off; do not enable the legacy mechanism as a substitute for the Todoist project comment. Review any pre-existing legacy rows separately before changing their lifecycle.

The bounded project-comment implementation from #403–#405 is deployed to current production master. Deployment run 42536045650 succeeded. The `todoist-calendar-sync` stack is `UPDATE_COMPLETE` with `ErasureExecutionEnabled=false`; the live Review API execution setting is false, and the replay-barrier setting remains absent. The erasure worker mapping is enabled.

This does not close #347: the read-only audit found 71 Review API configurations with execution enabled, including historical qualified versions that remain invocation candidates. The current alias target is false, but the account-local IAM/invoker audit does not establish an enforceable deny for old versions or all external callers. Package-marker strings are not proof of safe check ordering. #349's disposable Work-profile fault-injection acceptance also remains outstanding. Keep execution disabled, keep uncertain operations fenced, and do not enable the replay barrier, restore mappings, release fences, or replay messages until both acceptance tracks and independent review are complete.
