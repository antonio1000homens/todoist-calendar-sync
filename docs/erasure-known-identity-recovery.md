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

The existing Todoist project mapping comment is a **temporary in-flight guard only**: while the deletion operation remains fenced, it holds the known task ID and Calendar aliases for retry/review admission. Once exact provider and DynamoDB deletion has been verified, the executor must delete the original comment, confirm it is absent, and only then restore the mapping and release the fence. No deleted-task identity or permanent HMAC marker remains in DynamoDB or an app-owned project comment after success. The 18-day expiration applies only to leftover markers for unfinished/legacy operations. This accepts that arbitrarily late webhooks and manual SQS redrive after completed deletion may not be recognizable as stale. Post-write recovery still requires the #347 qualified-writer boundary and disposable Work-profile tests; keep incomplete operations fenced.

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
