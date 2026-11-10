# #349 — Known-identity post-write assessment (bounded assurance)

## Purpose

An erasure with a persisted `review_required` operation can now report a **read-only** scoped assessment for its **exact original** Todoist task and Google Calendar event, even when a universal signed Calendar provenance register is absent. This is a deliberately weaker operational claim than `allAccessibleCalendarCoverageProven`.

The existing global-absence report is unchanged, including its fail-closed treatment of unknown historical, shared and direct-ID-only Calendars. The new `knownIdentity.status` field on the authenticated post-write recovery GET response is an *additional* diagnostic; it never converts global absence into success or grants write/release permission.

## Inputs and outcome

The existing provider snapshot issues fresh exact task/event GETs, checks the configured Calendar's task-linked event lookup, and performs its existing read-only DynamoDB inventory. The scoped decision requires:

- An immutable original **both-side** deletion selection, exact action-plan identities, and matching durable deletion-start receipt.
- Explicit direct not-found response for both **recorded** provider targets (a bare empty response is not accepted). Calendar's existing exact cancelled-event handling applies only when the ID matches.
- No linked projection found in the **configured profile Calendar**, no positive cross-profile identity observation, and no original snapshot/provider safety blocker.
- Original operation-owned active profile fence, valid epoch, no active lease, and absence of attributable state rows.

All of these conditions yield `knownIdentity.status=known_identity_deleted`, with explicit scope `recorded_original_targets_in_configured_profile`. Any missing/ambiguous evidence yields `partial_or_ambiguous`; a lifecycle that never reached deletion yields `not_post_write`.

The read-only outcome intentionally **does not** imply the absence of unknown Calendar aliases, historical backups, unrecorded shared calendars, or independently created copies. It is not an authorization to overwrite state, install tombstones, restore mappings, replay DLQ, or release the fence.

## Execution and review remain separate

The GET endpoint continues to expose `releaseAllowed:false` and `onlyAvailableAction:keep_fenced`. Existing typed-review/deletion confirmation paths are unchanged. No new feature flag was added for this read-only reporting.

The existing Todoist project mapping comment is rewritten as a **bounded replay tombstone** and retained after successful provider and DynamoDB deletion. Current workers consult that exact project marker under the profile writer lease before processing matching webhooks, Calendar deltas, or orphan rechecks. The marker expires after 18 days and is removed by the tombstone cleanup job. Completed DynamoDB delivery receipts retain their normal 14-day idempotency keys, but the selected task and event IDs are scrubbed only after the project tombstone is read back under the erasure fence. No deleted-task identity remains in DynamoDB after success. The marker does not protect against historical versions that ignore it or arbitrary invocation after expiry; #347's qualified-writer boundary remains required. Keep incomplete operations fenced.

The existing seven-day terminal completed-task mapping cleanup and ordinary no-confirmation sync deletion are unaffected.

## Ambiguous provider deletion errors

A provider failure during the `delete` or `verify_deletion` lifecycle phase moves the durable operation directly to `review_required` while preserving its original phase, checkpoint and profile fence. Even an apparent 429/5xx or timeout can be a lost acknowledgement of a completed remote write; automatically resending that same destructive step is unsafe. Before each delete-stage action, the worker conditionally stores a unique write-ahead attempt claim tied to the exact progress checkpoint. A successful action advances the checkpoint and clears that claim in the same lifecycle write. If the checkpoint write or its acknowledgement is lost, later SQS deliveries see the claim and never repeat the provider action; after the configured worker timeout they move the operation to `review_required`. The original fence and claim remain for operator inspection. This closes the ambiguous DynamoDB checkpoint-acknowledgement replay window in the current source path. It does not prove historical Lambda versions or direct invokers use the path; #347 remains a release blocker. Unrelated pre-deletion and non-destructive mapping-state polling keep the existing retry logic. The erasure operation queue's existing 14-day DLQ still captures delivery/transport failures, without introducing a second queue.


## Production gate status after PRs #403–#405 (8 Nov 2026)

The project-comment marker implementation is deployed to current master. The
production stack and live Review API have `ERASURE_EXECUTION_ENABLED=false`;
the replay barrier remains absent. A fresh version audit still found 71 Review
API configurations with execution enabled, including historical qualified
versions that are invocation candidates. Current alias configuration does not
disable those old versions. #347's enforceable writer/IAM boundary and #349's
disposable Work-profile fault-injection acceptance are not complete. The gate
therefore remains disabled and no fence-release or recovery action is
authorized by this rollout.

### Calendar-only pre-write drift cancellation (operator-only)

This mode is **not** ordinary `RESTORE SYNC` and cannot be invoked by the
unattended pre-write watchdog. It exists for a provider revision that changed
the exact Google Calendar event **after** the original deletion confirmation,
when the original Todoist task, mappings, comments, known aliases and all
attributable DynamoDB rows are still intact. Do not use it if a provider delete
was attempted, the original identity or revision cannot be verified, an
unowned fence/lease exists, or the cross-profile scan is incomplete.

1. Load the existing operation and run **Inspect guarded recovery**. Review
   the content-free evidence checks and independently inspect the current
   exact Google Calendar event in its actual configured Calendar. An altered
   event is **not** a reason to resume deletion.
2. Only when `calendarDriftReview.candidateForSeparateApproval=true`,
   request **Calendar drift cancellation confirmation**. The backend makes a
   fresh provider/state/fence inspection and issues a **distinct five-minute,
   one-use** token bound to the original operation, profile, epoch and current
   task/Calendar revision, aliases, comments and state inventory.
3. After review, type **CANCEL ERASURE AND RESTORE SYNC**, the exact operation
   ID and profile. The handler re-inspects and transactionally consumes that
   token while recording a special `calendar_drift_cancel` recovery state
   under the existing operation-owned fence and unchanged profile epoch.
   It queues **recovery only**, not the old erasure/deletion.
4. The recovery worker independently re-reads the provider and strongly
   consistent cross-profile/state inventory **at every step**. If the approved
   provider revision or any invariant changes, it marks the recovery blocked
   and **retains the fence**. Only the originally enabled SQS mapping is
   restored. The disabled-by-design mappings remain disabled.
5. Once the original worker mapping is fully restored, a final owned-fence,
   epoch and no-lease CAS marks recovery completed and removes that operation's
   fence and confirmation token. Verify the original SQS source mapping,
   queue drain, and fresh synchronization in all three profiles before
   declaring operational recovery.

The mode never deletes or changes Todoist/Google Calendar provider records,
does not create a tombstone or remove an original DynamoDB mapping, and does
not implicitly re-enable `ERASURE_EXECUTION_ENABLED`. It is a **cancel** of
an unstarted deletion, not a way to finish a partially completed erasure.
The separate E2E destructive-erasure acceptance for #349 must still be run
using disposable provider objects after operational sync is recovered.

Before first production use, require independent code/security review,
staged test of stale-queue, altered Calendar revision, lost provider reads,
mapping/epoch races, failed SQS dispatch and rollback. Never remove the fence
or manually enable an SQS mapping as a shortcut.
