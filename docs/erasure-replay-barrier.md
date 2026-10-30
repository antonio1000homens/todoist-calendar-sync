# #243 post-write erased-identity replay barrier: draft implementation and rollout gate

**State:** foundational code only. Do **not** enable post-write recovery, release a
post-write fence, or close #243/#239/#113 from this branch. The current
`ErasureRecoveryService` must continue rejecting fully deleted and partial
provider outcomes. In particular, a 404 or completed deletion step is not proof
that a delayed ingress event cannot recreate the identity.

## Implemented in this draft

- `src/erasure-replay-barrier.ts` defines deterministic HMAC-SHA256 marker keys
  and strongly consistent, fail-closed individual admission reads.
- A prospective **single DynamoDB transaction** would install markers,
  conditionally consume and remove a distinct post-write authorization, delete
  the original identity-bearing operation record after final verification,
  and remove the owner-matched FENCE/JOURNAL under the expected epoch. This is **only a transaction constructor**, not a callable recovery
  endpoint: unimplemented operator-approval and postflight attributes make it
  deliberately unusable by the existing pre-write flow.
- Markers store only `pk`, `sk`, `markerVersion`. They store **no plaintext**
  task ID, event ID, summary, timestamp, comment, journal, or operation ID.
  A deleted Todoist ID is marked in **all three configured profiles** to block
  re-admission after cross-profile moves. Calendar event markers are scoped to
  the source profile to protect unrelated calendars.
- Test cases check historical-key reads, consistent-read requirements,
  unavailable DB/keys, malformed aliases, profile scoping, and atomic
  transaction shape. They do **not** simulate the entire production replay path.

## Marker and key lifecycle

Dedicated environment variables (NOT configured by this draft):

- `ERASURE_REPLAY_HMAC_KEYS`: JSON object mapping distinct non-secret key IDs
  to base64-encoded random 32+ byte HMAC keys; source from a dedicated
  Secrets Manager/KMS-protected secret and restrict read access to authorized
  writer/recovery Lambdas. Do not write these to code, CI, logs, or CloudFormation
  plaintext parameters.
- `ERASURE_REPLAY_HMAC_CURRENT_KEY`: ID used to sign **new** tombstones.
  Admission must read candidate markers for **every historical key ID**.

For privacy and durable replay safety, HMAC marker rows have **no TTL**.
These are pseudonymous permanent exclusion records, not anonymous values:
a holder of the keyed secret and a candidate provider ID can test membership.
Prohibit unrestricted `Scan`/export and disclose this retention explicitly.
Never discard a historical verification key while its markers remain; since
erased IDs are not kept, its historical digests cannot be re-keyed from the
marker store alone. A new signing key may be introduced for *new* erasures,
but old verification keys must remain accessible. If permanent keyed markers
are not acceptable under the data-erasure policy, do not ship this design;
obtain security/privacy approval for a different bounded-retention strategy
before allowing any fence release.

## Critical remaining admission/writer inventory

The real shared admission barrier must be installed, and **tested**, at
the following entrypoints **before** post-write recovery is allowed:

| Boundary | Examples of recreation paths | Still required |
| --- | --- | --- |
| `src/worker.ts`, `src/handler.ts`, `src/queue.ts` | delivery admission, retries, old epochs, orphan and manual payloads | reject old epochs and new-epoch delayed admission; test old qualified Lambda versions |
| `src/sync.ts` | `todoist.upsertTask`, `calendar.upsertEvent`, `upsertComment`, recurrence rebind | check full task/event/master/instance identity under writer lease |
| `src/reconciliation.ts` | `upsertTask`, `upsertEvent`, comment/mapping save | check both snapshot and action-time identities |
| `src/calendar-reconciliation.ts` | standalone and recurring Todoist creation/rebind, mapping creation | check event, series and linked task aliases |
| `src/project-sync.ts` | source/destination projections, cross-profile moves, recurrence migration | check source AND destination before any provider or DynamoDB write |
| `src/orphan-recovery.ts` | orphan reattachment and state re-mapping | check both sides before repair and putMapping |
| `src/repair-provider-guard.ts`, `src/review-engine.ts`, `src/manual-intervention.ts` | approved repair creation and replay/DLQ resumes | check against newly fresh provider state; never trust an old preview |
| `src/repository.ts` | `putMapping`, `putNewRecurrenceMappingIfUnowned`, `putRecurrenceLink`, mapping comment indexes | guard all mapping and recurrence write routes |
| `src/providers.ts`, `src/mutation-budget.ts` | `createTaskOnce`, `createRepairEventOnce`, `createFutureMasterOnce`, `upsertTask`, `upsertEvent`, metadata edits | enforce in production client factories AND test alternate/mock factories |
| `src/erasure-deletion.ts`, `src/erasure-recovery.ts`, `src/erasure-worker.ts` | deletion steps, independent readback, mapping restore and final fence release | independent strongly consistent postflight and atomic release |
| `src/erasure-preview.ts`, `src/erasure-recovery-adapters.ts` | full DynamoDB inventory plus direct provider/comments reads | verify every scan page; fail closed on unknown aliases and recurrence |

This is a **safety checklist**, not a claim that those paths already invoke
`assertReplayAdmission`. The shared primitive must not be activated or relied
on for post-write recovery until *all* of them are covered, including direct
`new Todoist`/`new GoogleCalendar` sites and historical Lambda versions.

## Remaining recovery implementation

1. Build alias inventory from an independently verified fresh snapshot, including
   recurring series/instances and cross-profile links. If any alias is unknown,
   retain the original fence.
2. Add a **new**, typed, single-use post-write operator review state and
   confirmation that is distinct from the original delete consent and the
   pre-write `RESTORE SYNC` flow. Validate original immutable selection and
   action-time digests/ETags.
3. For fully deleted, verify direct provider absence, every relevant project
   and legacy comment, consistent full DynamoDB scan, current mapping IDs/states,
   epoch, leases, and operation receipts; use the one atomic transaction.
4. For partially deleted, **do not recreate missing provider objects**.
   Either keep fenced for escalation or perform only the remaining deletion
   after a separately reviewed, newly confirmed action-time delete plan. Never
   blindly resume a prior deletion step.
5. Prove idempotent recovery after lost acknowledgements and all 404/429/5xx,
   Google 410/ETag, stale queue/lease/token, read pagination, repeated/moved
   webhook, DLQ, and old Lambda alias/version failure cases.
6. Complete IAM/security/privacy review, test with disposable **Work** profile
   data, and record redacted evidence on #243, #239 and #113 before closure.

**Never:** manually delete a fence or epoch, clear/skip the DLQ, promote an old
message to a new epoch, or restore synchronisation after ambiguous deletion.
