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

## Staged provider and mapping admission (not enabled)

This draft now includes an additional integration tranche:

- `src/erasure-replay-providers.ts` wraps Calendar and Todoist mutations
  for the default, budgeted and injected client factories. Synchronizer,
  project-move and snapshot-reconciliation clients now use these factories.
  Mutations without a verifiable task/event identity **fail closed** when the
  barrier is enabled, rather than inventing an identity from a title, date,
  request token or project ID. This deliberately blocks some legitimate
  unmapped Calendar-to-Todoist creation and comment deletion paths until their
  parent event/task identity is propagated explicitly.
- `src/handler.ts` rejects delayed, newly signed Todoist webhooks carrying
  erased task IDs **before** durable SQS admission; `src/worker.ts` also
  checks newly delivered or retried Todoist messages under the writer lease
  before any identity-bearing audit, receipt or provider writes.
- `src/repository.ts` checks ordinary mappings, recurrence links, flatten
  repairs, recurrence advance/transfer/consolidation, index restoration,
  future series split, completed projections and durable consolidation guards
  before creating/recreating state.
- Tests exercise the real repository writers, wrapped provider methods and
  signed webhook ingress under injected DynamoDB marker/failure conditions.
  The existing profile fence/epoch and writer lease remain independent.

**Rollout gate:** `ERASURE_REPLAY_BARRIER_VERSION` is **unset/off** in this
draft. `0` or absent preserves current production behaviour; `1` requires
valid HMAC configuration and fail-closes missing/unavailable marker reads.
Unexpected values fail closed. This flag is *not* an operational bypass:
after the first durable post-write marker exists it must never be disabled
and every live/qualified writer must run the enabled implementation. Do not
turn on the gate yet: the remaining identity propagation, old Lambda-version
retirement and fully verified post-write recovery are unfinished.

**Known remaining gaps:** direct provider clients outside the guarded
factories, unknown-ID creation and comment deletions, recurrence aliases not
contained in the currently available mapping, some noncanonical DynamoDB
writers (including repair/review history), coordinated source/destination
leases for cross-profile moves, complete Calendar delta ingestion, and old
qualified Lambda versions. A strongly consistent lookup is not a substitute
for an atomic provider/API mutation plus marker condition under concurrent
cross-profile erasure; deployment must prove the serialized lease protocol
covers these races. There has been **no** production rollout or fault injection.

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
| `src/providers.ts`, `src/mutation-budget.ts`, `src/completed-project-comment-cleanup.ts` | `createTaskOnce`, `createRepairEventOnce`, `createFutureMasterOnce`, `upsertTask`, `upsertEvent`, metadata edits, operator-only project-comment cleanup | enforce in production client factories AND test alternate/mock factories; bare comment deletion must fail closed when owner identity is unavailable |
| `src/erasure-deletion.ts`, `src/erasure-recovery.ts`, `src/erasure-worker.ts` | deletion steps, independent readback, mapping restore and final fence release | independent strongly consistent postflight and atomic release |
| `src/erasure-preview.ts`, `src/erasure-recovery-adapters.ts` | full DynamoDB inventory plus direct provider/comments reads | verify every scan page; fail closed on unknown aliases and recurrence |

This is a **remaining safety checklist**, not a claim of comprehensive coverage.
Several normal provider/mapping entrypoints now check the staged barrier, but
not every route in this table has complete identity propagation. The shared
primitive must not be activated or relied on for post-write recovery until
*all* routes, versions, project moves, and aliases are verified.

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


## Follow-on: source-bound Calendar → Todoist creation (staged, issue #243)

- A Todoist `upsertTask` without `existingId`, or `createTaskOnce`, may create
  a *new* task ID. Checking `task.id` or the idempotency request key cannot
  protect against recreation of an erased task; those fields are not the
  identity selected by a `POST /tasks` operation.
- The mutation boundary now accepts an optional, trusted third argument of
  Calendar source IDs. All regular synchronizer, Calendar snapshot import,
  manual conflict repair and review-engine task creators supply the source
  event and known recurrence master aliases using
  `calendarReplaySourceIds(event, ...aliases)`.
- With replay admission enabled, task creation *fails closed* without a
  non-empty, unique, bounded Calendar source/alias inventory. Every supplied
  source ID is checked under the profile's HMAC-derived immutable replay
  markers before the provider call. Known existing-task updates still check
  the Todoist task ID; when source aliases are supplied, both are checked.
- A source ID is provenance, not proof of provider deletion or an authorisation
  to create a replacement task. Callers must obtain it from the original
  provider-read Calendar event; this change does not infer a source from user
  text or a stale Todoist task ID. The provider never receives the third argument.
- The delegated review idempotency wrapper preserves source IDs when converting
  `upsertTask` into `createTaskOnce`. An AST-based test audits production
  creator callsites for omissions and provider tests cover deleted aliases,
  invalid/duplicate sources and safe existing-task updates.

**Rollout remains prohibited.** `ERASURE_REPLAY_BARRIER_VERSION` stays off.
This increment does not finish the source-inventory security review, unknown
comment ownership, Calendar creation provenance, old qualified Lambda versions,
atomic post-write postflight/confirmation, or Work-profile disposable staging.
It does not unlock post-write recovery or justify closing #243, #239 or #113.

## Staged post-write finalisation contract after merged #304 (no executor)

The prospective `atomicReplayRelease()` command builder has been updated to
match the **actual durable fields** written by the now-merged post-write
acknowledgement:

- `ERASURE_OPERATION#{id}/STATE` must remain `review_required`, with
  `postwriteReview.status=reviewed_fenced`,
  `postwriteReview.mode=post_write`, the matching consumed confirmation,
  expected epoch, original preview fingerprint, reviewed timestamp (equal
  to `updatedAt`) and inspected/postflight evidence fingerprints.
  Original selected Todoist **and** Calendar deletion, both original
  provider action-plan entries and absence of a pre-write recovery are
  required in the same conditional delete.
- The distinct `ERASURE_POSTWRITE_CONFIRMATION#{id}/STATE` must be
  `consumed`, match the **same** operation, profile, token, epoch and
  fingerprints, and have no remaining expiry field. An issued, expired,
  previous pre-write or old deletion token cannot satisfy it.
- A future independently verified alias manifest must specify
  `home`, `antonio` and `work` (even when some are empty), plus the
  exact source-profile Calendar aliases. A Todoist task marker is placed
  in all three profiles; each Calendar event/recurrence alias is marked
  only in its independently verified profile. Any incomplete, malformed,
  duplicate, mismatched or oversized manifest is rejected. **Merely
  supplying an array does not constitute proof that a profile was scanned.**
- In **one** DynamoDB transaction, insert only pseudonymous HMAC marker
  keys, conditionally delete the identity-bearing original operation and
  consumed confirmation, verify the monotonic epoch and atomically remove
  only the matching active fence and its journal (or verify journal absence).
  Never split this transaction; the 100-action limit is fail-closed.
  The builder **does not send** the transaction to DynamoDB.

This increment contains **no production caller** for the builder; an
executable test asserts that no source worker/API/controller imports or
invokes the release function. The intended privileged post-write executor
is still missing. Specifically, independent action-time provider readback,
all-profile alias discovery and absence, old qualified Lambda version
retirement, complete writer-admission proof, explicit mapping state
restoration sequencing, single-use release authorization and
cross-profile failure injection are unimplemented. A successful
`REVIEW AND KEEP FENCED` acknowledgement is **not** release
authorization.

The original #243 issue was closed when PR #304 merged, but that is not
technical acceptance of these missing safety requirements. Continue
tracking them separately before enabling `ERASURE_REPLAY_BARRIER_VERSION`,
deploying any executable release, or removing the original fence.

## Cross-profile Calendar task-link observation after historical Lambda audit (#307)

The read-only Calendar provider now offers
`listLinkedEventsByTodoistTaskId(taskId)`, which returns *all* events matching
the provider's shared task-ID index (including cancelled records and explicit
recurrence overrides). The existing `findByTodoistTaskId` retains its
unique-winner/ambiguous refusal behaviour. The complete query tracks all
pages, rejects repeated page tokens, conflicting duplicate event snapshots,
invalid pages and missing event IDs. It does not mutate Calendar data.

`observeCrossProfileCalendarAliases` accepts independently configured
per-profile readers and requires fresh successful reads for home, antonio and
work. For indexed recurring links it reads exact masters and every instance
page, including cancellations and exceptions, with a 32-ID bound.

The post-write inspection now also calls
`observeCrossProfileErasureEvidence`. It consumes the already completed
strongly consistent, fully paginated DynamoDB scan and independently reads all
three profiles' comments from every active project, archived personal project
and archived workspace project, active Todoist task inventory, full unfiltered
Calendar event inventory, tagged event lookup, exact candidate events and
recurring instances. Project and comment pages are bounded and strictly
validated; an inaccessible workspace archive refuses the inventory. The report
binds a fingerprint of the full project ID/workspace inventory without returning
those IDs. It follows identity fields from mapping,
completed and audit rows plus parsed comments; it does not match titles or
dates. DynamoDB, Calendar, task and comment pagination reject repeated cursors,
invalid identities and conflicting duplicate snapshots. The inspection binds
the read-only evidence fingerprint into its fresh inspection fingerprint.
Todoist's [Get Comments endpoint](https://developer.todoist.com/api/v1/)
requires exactly one project or task ID, so completeness depends on first
enumerating active and archived projects for each profile.

The report returns counts and SHA-256 fingerprints only, with no task/event
IDs, titles, descriptions or comment bodies. A `knownIdentitiesAbsentFromCurrentProviders`
result requires all three profiles' complete provider inventories, no related
provider comments, and a closed identity walk; a 404/410 response alone never
sets it. An oversized or
nonconvergent identity walk remains incomplete. The result always sets
`eligibleForPostWriteRelease:false`, has explicit blockers, and deliberately
has no `calendarAliases` field accepted by the offline transaction
constructor.

These reads still do not prove historical aliases that have no provider tag,
state row or comment provenance, nor do they establish a transactionally
consistent provider/DynamoDB snapshot. Direct ETags and ownership must be
rechecked at action time. Old Lambda versions, IAM invoke paths, writer
fence/lease invariants, privacy approval and Work-profile staging remain
independent gates.

**No deployed worker/API imports this observation as authorisation.** A
future privileged verifier must reconcile these observations with fully
paginated strong DynamoDB state, every accessible project comment and task
comments for discovered task identities, direct Todoist and Calendar
item/master/instance reads in every profile, old versions and new independent
operator confirmation before calling
`atomicReplayRelease()`. Any missing provenance keeps the fence in place.

Calendar inventory currently reads each profile's configured sync calendar,
not every calendar the profile can access. Aliases in other calendars remain
unqueried. Todoist v1 also does not offer a global task-comment listing
endpoint: task comments require a known task ID. Therefore comments on
unrelated or otherwise unknown tasks are not enumerated by this observer.
These limitations prevent the observation from establishing complete
cross-profile absence.

This is a staged read-only primitive, not an accepted #307 safety gate.
`ERASURE_REPLAY_BARRIER_VERSION` remains OFF. Do not restore worker
mappings, replay old queues or delete any historical Lambda version based
on these results.
