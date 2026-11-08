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

To complete #349, a later implementation must atomically commit the already defined HMAC replay markers for all *known* IDs, enforce those markers on every live/qualified invokable writer (#347), preserve original mapping enablement and durable idempotent recovery states, and route failed/partial cases into the existing DLQ/review process. **Do not simply switch off an existing replay/lease safety gate to eliminate a feature flag.** No automatic post-write recovery should occur until those invariants are independently tested.

The existing seven-day terminal completed-task mapping cleanup and ordinary no-confirmation sync deletion are unaffected.

## Ambiguous provider deletion errors

A provider failure during the `delete` or `verify_deletion` lifecycle phase now moves the durable operation directly to `review_required` while preserving its original phase, checkpoint and profile fence. Even an apparent 429/5xx or timeout can be a lost acknowledgement of a completed remote write; automatically resending that same destructive step is unsafe. The operation is therefore inspectable through the existing review/recovery interface, rather than resumed by an SQS redelivery. The source delivery is acknowledged only after the conditional DynamoDB state update succeeds. **If that DynamoDB commit fails or its acknowledgement is lost, the previous deletion checkpoint may still be visible on a subsequent SQS delivery.** This change alone cannot prove that a repeated provider call is impossible in that failure window; exact provider idempotency or an earlier durable attempt claim remains a release blocker tracked in #349. Unrelated pre-deletion and non-destructive mapping-state polling keep the existing retry logic. The erasure operation queue's existing 14-day DLQ still captures delivery/transport failures, without introducing a second queue.
