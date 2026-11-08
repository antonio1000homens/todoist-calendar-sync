# #243 post-write erased-identity replay barrier: draft implementation and rollout gate

**State:** foundational code only. Do **not** enable post-write recovery, release a
post-write fence, or close #243/#239/#113 from this branch. The current
`ErasureRecoveryService` must continue rejecting fully deleted and partial
provider outcomes. In particular, a 404 or completed deletion step is not proof
that a delayed ingress event cannot recreate the identity.

## Bounded known-identity recovery (#349)

The #349 release decision is limited to identities recorded by the confirmed
operation: the Todoist task, selected Calendar event, and explicitly recorded
master/instance aliases or known profile moves. Fresh direct reads and durable
HMAC markers apply to those identities. The outcome is
`known_identity_deleted`, not global erasure. Unrecorded Calendar copies,
external integrations, exports and backups are outside that claim.

The separately signed Calendar ACL registry in
[`erasure-calendar-provenance.md`](./erasure-calendar-provenance.md) is an
optional stronger observer. Its absence or incomplete coverage is not a #349
release prerequisite. If the operation's own exact alias inventory is
ambiguous, incomplete or conflicting, keep its fence and require review.

This bounded policy does not relax replay protection: every known Todoist and
Calendar identity must have a durable HMAC marker before admission resumes,
and every writer that can recreate a known identity must enforce marker and
lease checks. #347 invocation coverage and disposable Work-profile acceptance
remain independent release gates.

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
  explicitly recorded profile/event pairs: selected source events plus known
  recurrence aliases or profile moves. Each event marker is scoped by profile,
  configured Calendar ID and event ID. No empty per-profile inventory or proof
  of unrelated-calendar absence is required; an unknown relevant alias keeps
  the operation fenced.
- New deletion confirmations persist a bounded `{profile, calendarId, eventId}`
  manifest from the selected event and exact event references in attributable
  state rows before mutation. A missing profile scope or more than 32 aliases
  blocks confirmation. This captures identities already recorded by the
  operation; it does not search unrelated calendars or establish global absence.
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
- Identity-bearing `StateRepository` and reconciliation-baseline mutations
  check replay markers before state writes. The versioned barrier now refuses
  to report enabled unless `ERASURE_PROTOCOL_VERSION=1` is also set; webhook
  ingress, the SQS admission boundary and the worker enforce this paired
  configuration so a marker read is never treated as a substitute for a
  durable profile lease.
- The project-comment migration apply path now holds the profile writer lease
  and checks the mapping's task, event, master and active-instance markers
  before changing Todoist comments or DynamoDB mappings, including when called
  with injected clients. A marker hit prevents provider mutation; the report
  mode remains read-only.

**Rollout gate:** `ERASURE_REPLAY_BARRIER_VERSION` is **unset/off** in this
draft. `0` or absent preserves current production behaviour; `1` requires
`ERASURE_PROTOCOL_VERSION=1`, valid HMAC configuration and fail-closes
missing/unavailable marker reads. Ingress and queue admission reject any
barrier/lease configuration mismatch before enqueue; the worker also rejects
it before processing a delivery. Unexpected values fail closed. This flag is
not an operational bypass:
after the first durable post-write marker exists it must never be disabled
and every live/qualified writer must run the enabled implementation. Do not
turn on the gate yet: the remaining identity propagation, old Lambda-version
retirement and fully verified post-write recovery are unfinished.

The current source-level provider mutation inventory and its limits are
recorded in [`erasure-writer-source-audit.md`](./erasure-writer-source-audit.md).
Remaining source and deployment gaps include unknown-ID creation and comment
deletions, recurrence aliases not contained in the currently available
mapping, unclassified identity-bearing DynamoDB routes, coordinated
source/destination leases for cross-profile moves, complete Calendar delta
ingestion, and old qualified Lambda versions. A strongly consistent lookup is
not a substitute for an atomic provider/API mutation plus marker condition
under concurrent cross-profile erasure; deployment must prove the serialized
lease protocol covers these races. There has been **no** production rollout or
fault injection.

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
| `src/reconciliation.ts`, `src/canonical-identity.ts`, `src/completed-history-cleanup.ts` | `upsertTask`, `upsertEvent`, comment/mapping/baseline/canonical identity save or cleanup, terminal history retirement | check both snapshot and action-time identities; DDB baseline/canonical/history rows check task/event replay markers at their write boundary; terminal history retirement holds a profile writer lease through its transaction |
| `src/calendar-reconciliation.ts` | standalone and recurring Todoist creation/rebind, mapping creation | check event, series and linked task aliases |
| `src/project-sync.ts` | source/destination projections, cross-profile moves, recurrence migration | check source AND destination before any provider or DynamoDB write |
| `src/orphan-recovery.ts` | orphan reattachment and state re-mapping | mapped owner profile now gets a writer lease when it differs from delivery profile; injected provider factories are wrapped in replay guards; full source/destination alias provenance and deployed-credential coverage remain open |
| `src/repair-provider-guard.ts`, `src/review-engine.ts`, `src/review-store.ts`, `src/manual-intervention.ts` | approved repair creation and replay/DLQ resumes | preview submission, checkpoint persistence, finalization and queued/resumed execution now check all reviewed snapshot, mapping and planned identities; fresh provider state is still re-collected before repair writes; manual ingress and all qualified worker versions remain in the independent audit |
| `src/repository.ts` | `putMapping`, `putNewRecurrenceMappingIfUnowned`, `putRecurrenceLink`, mapping comment indexes | guard all mapping and recurrence write routes |
| `src/project-comment-migration.ts` | project mapping comment backfill/normalization and legacy task-comment cleanup | apply mode now holds a profile writer lease and checks every known mapping alias before mutation |
| `src/providers.ts`, `src/mutation-budget.ts`, `src/completed-project-comment-cleanup.ts` | `createTaskOnce`, `createRepairEventOnce`, `createFutureMasterOnce`, `upsertTask`, `upsertEvent`, metadata edits, operator-only project-comment cleanup | enforce in production client factories AND test alternate/mock factories; bare comment deletion must fail closed when owner identity is unavailable |
| `src/erasure-deletion.ts`, `src/erasure-recovery.ts`, `src/erasure-worker.ts` | deletion steps, independent readback, mapping restore and final fence release | independent strongly consistent postflight and atomic release |
| `src/erasure-preview.ts`, `src/erasure-recovery-adapters.ts` | full DynamoDB inventory plus direct provider/comments reads | verify every scan page; fail closed on unknown aliases and recurrence |

This is a **remaining safety checklist**, not a claim of comprehensive coverage.
The review-store checks are staged hooks and remain OFF unless the replay
barrier is explicitly enabled; they do not replace provider-boundary checks or
the writer lease. Several normal provider/mapping entrypoints now check the
staged barrier, but not every route in this table has complete identity
propagation. The shared primitive must not be activated or relied on for
post-write recovery until *all* routes, versions, project moves, and aliases
are verified.

## Remaining recovery implementation

1. Freshly re-read every persisted known Calendar alias on its recorded
   profile and Calendar ID, including recurrence aliases and recorded profile
   moves. Do not enumerate unrelated calendars. If a relevant alias is unknown
   or conflicting, retain the original fence.
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
Calendar event inventory, a full Todoist Sync `all` snapshot for task and
active-project comments, tagged-event inventory matches (with exact tag-query
fallback only when an all-calendar inventory is incomplete), exact candidate
events and recurring instances. Active project comments use the snapshot only when that
project is present in its full project inventory; archived projects and any
active project omitted from the snapshot retain per-project REST reads.
The task-comment snapshot must report `full_sync:true`, a sync token and a
parseable `full_sync_date_utc`; snapshots older than five minutes do not prove
current absence. Comments for known task IDs are also read directly and
compared with the snapshot. Project and comment pages are bounded and strictly
validated; an inaccessible workspace archive refuses the inventory. The report
binds a fingerprint of the full project ID/workspace inventory without returning
those IDs. It follows identity fields from mapping,
completed and audit rows plus parsed comments; it does not match titles or
dates. DynamoDB, Calendar, task and comment pagination reject repeated cursors,
invalid identities and conflicting duplicate snapshots. The inspection binds
the read-only evidence fingerprint into its fresh inspection fingerprint.
Todoist's [Get Comments endpoint](https://developer.todoist.com/api/v1/)
requires exactly one project or task ID. A [Sync API full read](https://developer.todoist.com/api/v1/)
with `resource_types=["all"]` returns both `notes` (task comments) and
`project_notes` (project comments). This audit uses the batched snapshot to
discover comments on tasks and active projects whose IDs were not known before
the read.

The report returns counts and SHA-256 fingerprints only, with no task/event
IDs, titles, descriptions or comment bodies. A `knownIdentitiesAbsentFromCurrentProviders`
result requires all three profiles' complete provider inventories, no related
provider comments, and a closed identity walk; a 404/410 response alone never
sets it. An oversized or
nonconvergent identity walk remains incomplete. The result always sets
`eligibleForPostWriteRelease:false`, has explicit blockers, and deliberately
has no `knownCalendarAliases` field accepted by the offline transaction
constructor.

These reads still do not prove historical aliases that have no provider tag,
state row or comment provenance, nor do they establish a transactionally
consistent provider/DynamoDB snapshot. Direct ETags and ownership must be
rechecked at action time. Old Lambda versions, IAM invoke paths, writer
fence/lease invariants, privacy approval and Work-profile staging remain
independent gates.

**No deployed worker/API imports this observation as authorisation.** This
optional broader observer may inform a separate global-coverage investigation.
The #349 release proof uses the exact known identities recorded by the original
operation and fresh direct readbacks for those identities. It does not require
enumerating every accessible Calendar or inferring identities from titles,
dates or unrelated rows. Ambiguity in the operation's own identity set keeps
its fence in place.

Calendar inventory paginates each profile's CalendarList, including hidden
entries, and independently queries source/destination IDs from a separately
signed operator-reviewed direct-ID ACL registry when supplied. Event details,
recurrence cancellations and direct ETags are verified for the registered
scope; free/busy-only, private-event-restricted, stale, unknown, conflicting
or inaccessible calendars prevent complete coverage. See
[Calendar provenance #333](erasure-calendar-provenance.md) for the private
registry, offline signing workflow and redacted completeness evidence.
Without a trusted signed registry, CalendarList-only coverage remains
incomplete. Untagged events remain identity-ambiguous without an exact ID
link from state, comments or the inventory. Todoist's full Sync notes
snapshot and project/DynamoDB reads are separately captured, not atomic.
Do not interpret a complete coverage field as authorization for release, or
its incompleteness as proof that a known-identity release is unsafe.

This is a staged read-only primitive, not an accepted #307 safety gate.
`ERASURE_REPLAY_BARRIER_VERSION` remains OFF. Do not restore worker
mappings, replay old queues or delete any historical Lambda version based
on these results.

## Staged post-write mapping restoration retry record

The offline `atomicReplayRelease()` contract now requires the action-time
inventory of every worker SQS mapping and the subset that was originally
enabled. Its single DynamoDB transaction installs the replay markers, writes a
separate `ERASURE_POSTWRITE_RESTORE#<operation>` record in `pending` state,
and conditionally removes the reviewed operation, token, fence and journal.
Those actions commit together; no mapping update is issued by the builder.

After that transaction commits, a future privileged executor may restore only
the IDs in `enabledMappingIds`. The record retains the complete mapping
inventory and a manifest fingerprint, so an interrupted or failed restore has
a durable retry point. `completePostWriteMappingRestore()` constructs a
conditional completion update only when fresh observed mapping states exactly
match the original enabled/disabled states and the pending record has the same
manifest. Originally disabled mappings must remain disabled. Transitional,
missing, extra or mismatched mappings cannot complete the record.

`restorePostWriteWorkerMappings()` now implements the standalone runtime retry
step. It requires both protocol flags enabled, strongly reads the pending item,
checks its profile epoch, acquires a profile writer lease, re-reads the item,
and compares the complete current SQS mapping inventory and ownership with the
recorded manifest. It enables only originally enabled mappings, leaves
originally disabled mappings untouched, and verifies the complete inventory
and every final state before constructing the conditional completion update.
Failures leave the durable item pending; retries are idempotent. The helper is
not imported by an executor, API route or queue, and it was not invoked during
implementation. No deployment or mapping change is authorized; the replay
barrier remains OFF.
