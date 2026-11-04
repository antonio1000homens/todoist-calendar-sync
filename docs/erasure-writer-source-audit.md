# Erasure writer source audit

Snapshot reviewed 4 November 2026 against `master` at `d8fe64c` while
progressing #307. This is a source-level inventory of the current TypeScript
checkout; it is not evidence about deployed package contents, external callers,
or effective AWS permissions.

## Provider mutation surface

`src/erasure-replay-providers.ts` declares the identity-bearing Calendar and
Todoist methods intercepted by its replay guard. The current provider classes
in `src/providers.ts` expose these Calendar writes:

- `createFutureMasterOnce`
- `upsertEvent`
- `patchEventMetadataIfUnchanged`
- `createRepairEventOnce`
- `upsertEventIfUnchanged`
- `updateSharedEventPropertiesIfUnchanged`
- `deleteEvent`
- `deleteEventIfUnchanged`

The guarded Todoist writes are:

- `upsertTask`, `updateTaskMetadata`, `createTaskOnce`, `moveTask`,
  `updateRecurringOccurrence`, and `deleteTask`
- `createProjectComment`, `updateComment`, `upsertProjectComment`,
  `upsertComment`, and `deleteComment`

The production factory in `src/mutation-budget.ts` wraps both clients. The
`calendarForProfile()` factory wraps Calendar clients. The operator-only
completed-comment cleanup separately wraps its Todoist client. The only direct
`new GoogleCalendar()` call found outside those wrapped paths is in
`src/watch.ts`; it uses only `watch()` and `stopWatch()` to manage push
subscriptions, not identity-bearing event writes.

The provider guard checks the replay barrier only when
`ERASURE_REPLAY_BARRIER_VERSION=1`. When the flag is off, the wrapper does not
provide replay protection. Turning the flag on remains unsafe until the
deployed-version, identity propagation, lease, alias, and IAM gates in #307 are
closed. Todoist `deleteComment()` currently fails closed when the barrier is
on because a bare comment ID cannot prove its owning erased identity.

## DynamoDB mutation surfaces

The existing source-wiring tests explicitly check selected identity-bearing
mutators in `src/repository.ts`, reconciliation baselines in
`src/reconciliation.ts`, and canonical identity writes in
`src/canonical-identity.ts` for replay admission before their first write.
Additional mapping and recurrence routes are covered by
`test/erasure-replay-state-write-audit.test.mjs`. This is a bounded list of
known identity-bearing boundaries, not a proof that every DynamoDB write in the
application is identity-bearing or guarded. Operational, lease, review,
erasure, and audit records need classification by their data and callers.

## Acceptance still open

This source inventory does not close the deployed writer/Lambda admission
criterion. In particular it does not establish that:

- all deployed and historical Lambda package digests match this source;
- every alias, qualified version, account, region, or external caller uses the
  guarded paths;
- the barrier is enabled and correctly configured on every writer (the latest
  Windsor audit found it off on all inventoried versions);
- all identity-bearing state writes are included and receive the necessary
  writer leases and complete source/destination aliases;
- Lambda identity, resource-policy, Function URL, trust, and caller paths deny
  an unguarded or historical executable; or
- an approved rollback/retirement plan has been executed and independently
  verified.

Do not use this source review to enable the barrier, release a fence, restore
worker mappings, retire a Lambda version, or authorize replay. Keep the
deployed criterion unchecked until its live evidence and approvals are
complete.
