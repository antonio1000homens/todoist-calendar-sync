# Historical cleanup beside an exceptional erasure fence

## Scope and fallback

The profile fence remains active for its owning erasure throughout a historical
cleanup. A cleanup is admitted only when the fence owner is a current,
review_required erasure with an intact confirmed manifest, the protocol epoch
is unchanged, no incompatible profile lease remains, and a complete identity
and DynamoDB resource inventory proves there is no overlap. Any incomplete
manifest, partial scan, active writer, changed fence/epoch, shared identity,
shared state key, or shared Todoist comment returns a blocker before cleanup
checkpoints or provider writes begin. The existing 409 remains the fallback.

The case scope binds profile and case ID, exact Todoist and Calendar identities,
all base-table keys found by a strongly consistent paginated identity scan,
exact app-owned Todoist comment IDs, write classes, and a fingerprint of the
erasure's immutable confirmed target/inventory/action plan. The scan stops and
fails closed after 100 pages or 100,000 rows; scopes with more than 500 matching
keys also fail closed because the transaction cannot safely enumerate them. IDs
and composite keys are matched conservatively; false positives block admission.

## Compatibility

| Existing owner | Historical cleanup | Erasure or recovery |
| --- | --- | --- |
| Historical cleanup scope | Compatible only if provider identities, planned DynamoDB keys, and app-owned comment IDs are disjoint | Incompatible |
| Erasure worker/recovery write permit | Incompatible | Exclusive for one operation |
| Existing profile admission/writer lease | Incompatible while held | Must drain before the erasure fence is installed |
| Read-only inspection | Compatible | Compatible |

The registry is `ERASURE#<profile>/SCOPED_ADMISSION`. A conditional versioned
write serializes grant insertion, renewal, expiry reclamation, and exclusive
erasure/recovery ownership. Multiple disjoint cleanup grants may coexist.
Each grant has a twenty-minute lease and immutable scope/fence fingerprints.
Before each durable cleanup checkpoint or provider mutation, cleanup renews
its grant and re-reads the fence owner, epoch, erasure operation, cross-profile
identity rows, mappings, recurrence links, provider identities, and repair controls. Its final
DynamoDB transaction also checks the exact live grant version and expiry.
Provider mutations retain their existing exact identity, comment provenance,
Calendar ETag, readback, and idempotent checkpoint checks.

An erasure worker or recovery permit cannot become active while a scoped grant
is live. The inverse is also true: cleanup cannot join while an exclusive
permit is live. Existing fenced erasure lifecycle steps use the exclusive
permit. Recovery apply, automatic post-write completion, recovery workers, and
final fence release use the same gate. The gate row is deleted atomically with
the fence on successful terminal completion. The erasure manifest, lifecycle,
mapping state, provider deletion checkpoint, project tombstone, and replay
barrier are never changed by historical cleanup.

## Writer and lease participants

Ordinary writers continue using the existing profile admission or writer
leases and therefore remain blocked by an active erasure fence:

- SQS admission and the worker in src/queue.ts and src/worker.ts;
- project synchronization and reconciliation in src/project-sync.ts and
  src/reconcile.ts;
- review, repair, reconciliation, retirement, and undo routes in
  src/review-api.ts;
- completed-history cleanup and project-comment migration;
- recurrence, orphan, and native-move writers that acquire the profile writer
  lease or check the erasure epoch before their first mutation.

The exceptional erasure path is the only participant allowed to run under its
own fence. ErasureOperationStore.advanceFencedLifecycle,
ErasureRecoveryService.apply/process, automatic post-write completion, and
the terminal release transactions serialize against cleanup grants through
`SCOPED_ADMISSION`. `inspectErasureFence` and recovery control reads expose live
scoped grants as leases, so existing drain and finalization checks fail closed
if a grant is present.

No code path skips the profile fence or ordinary admission check. A
review_required state is required before scoped cleanup can be considered;
recent uncertain erasure write attempts and active recovery records block
admission. The production case remains reserved for operator-led manual
acceptance. This design does not assert that deployed historical Lambda
versions or external invokers satisfy #347's independent retirement and IAM
boundary.
