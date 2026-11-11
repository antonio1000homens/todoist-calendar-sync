# #349 / #484 — Known-identity post-write completion

## Purpose

A persisted `review_required` erasure can be assessed against its **exact original**
Todoist task and Calendar event even when a universal signed Calendar provenance
register is unavailable. This is a bounded operational claim, not proof that
unknown, historical, shared or independently-created Calendar copies are absent.

Issue #484 adds an operation-scoped completion path. When the exact deletion
checkpoints and post-write evidence are satisfied, the existing erasure watchdog
restores the original worker mapping states and atomically retires the operation.
It does not resume deletion, create a new queue, or require a separate
per-operation typed review/signoff.

## Completion evidence

The finalizer accepts only the original operation and its owning profile. It
requires all of the following:

- The operation remains `review_required`, has `providerDeletionReady=true`,
  and records a valid `deletionStarted` receipt.
- The original action plan selected both Todoist and Calendar deletion and
  retains the exact task, event, configured calendar and complete bounded alias
  inventory.
- The deletion progress is at the terminal `verify` checkpoint (or the
  compatible completed `state` checkpoint), all comment/state indexes are
  complete, and no write-ahead attempt remains.
- Strong exact provider readback proves the recorded Todoist task and Calendar
  event absent and the configured Calendar task-link lookup not found.
- The exact original project-comment inventory matches an active, read-back
  18-day tombstone. The tombstone is retained for its normal expiry cleanup.
- The fresh attributable DynamoDB inventory is empty, the snapshot has no
  safety blockers, the operation-owned fence and epoch are valid, and no
  admission/writer leases remain.
- The live worker mapping inventory exactly matches the original recorded
  UUIDs. Originally-disabled mappings remain disabled; only originally-enabled
  mappings may be restored.
- The existing `ERASURE_EXECUTION_ENABLED` gate is true and
  `ERASURE_PROTOCOL_VERSION=1`. These are existing release controls, not new
  flags. They preserve the #347 writer/IAM release boundary; this change does
  not enable the production gate.

A global Calendar absence scan is not required for these **known recorded
targets**. The result never claims `allAccessibleCalendarCoverageProven`.

## Automatic completion

The existing scheduled EventBridge erasure watchdog already enumerates the
three known profile fences. For each `review_required` operation:

1. It tries the post-write finalizer before considering pre-write recovery.
   Partial or ambiguous post-write operations are not passed to pre-write
   recovery.
2. It re-reads the exact operation evidence and checks the fence/epoch/lease
   owner immediately before restoring mappings.
3. It re-enables only the UUIDs in the original `enabledMappingIds` list.
   It then verifies the complete mapping inventory and exact original enabled /
   disabled state.
4. One conditional DynamoDB transaction checks the unchanged operation,
   deletion receipt/checkpoints, original confirmation, operation-owned fence,
   epoch and journal ownership. It removes the original confirmation, any
   operation-bound pre-write or legacy post-write review tokens, the
   operation-owned fence and journal, and replaces the identity-bearing
   operation with an identity-free terminal receipt.
5. The Todoist project-comment tombstone is deliberately left untouched for
   its normal 18-day expiry cleanup.

The terminal operation record retains only the operation ID, owning profile,
terminal status, completion time, epoch, mapping counts and non-identifying
completion flags/timestamps. It contains no Todoist task ID, Calendar event ID,
title, comment body, target digest, preview fingerprint, inventory or
confirmation. The original confirmation and any operation-bound review-token
rows are deleted. No deleted task/event identity remains in DynamoDB after
success.

The receipt records that provider deletes were **not** replayed and that the
tombstone was left untouched for its normal expiry. A repeated watchdog pass
or post-write inspection is a terminal no-op and reports
`classification=completed`; it cannot reopen the operation or release a
later operation's fence.

## Failure handling and release boundary

Any missing, stale, partial, ambiguous or conflicting evidence leaves the
operation fenced. The watchdog reports a blocker and does not guess, retry a
provider delete, or start a new queue. If mapping restoration succeeds but the
final conditional transaction conflicts, the fence remains active; a later
watchdog pass re-inspects and retries idempotently.

The existing production erasure gate must remain disabled until #347's
historical writer/invocation/IAM boundary and the remaining #349 disposable
Work-profile acceptance and security review are independently satisfied.
This implementation does not authorize enabling that gate, enabling
`ERASURE_REPLAY_BARRIER_VERSION`, running a live destructive test, or
manually editing mappings/fences.

The former fenced-review token and acknowledgement routes have been retired
(HTTP 404); they are no longer a required step or an alternative completion
path. The review UI exposes the automatic completion state and precise
blockers. The existing watchdog performs the guarded completion when the
existing release gate and all operation-scoped evidence are satisfied.
