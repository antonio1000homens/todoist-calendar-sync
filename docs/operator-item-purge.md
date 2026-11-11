# Deliberate per-item purge (issue #113)

This is a separate, deliberately destructive erasure path. It does not change
normal Todoist completion, Calendar deletion, reconciliation, or retention
behavior. Success leaves no purge journal, fence, receipt, audit, or mapping
record that identifies the selected item in DynamoDB. A profile-only erasure
epoch remains so delayed queue messages from before the purge stay invalid
after the temporary fence is removed.

## Preview and scope

The command scans the full state table and both providers. It follows exact
task/event references through mappings, baselines, recurrence, canonical
aliases, conflict and review records, repair history, delivery receipts, and
audit rows. Titles and dates never establish ownership. Shared, recurring,
malformed, unrecognized, and unattributable records block deletion.

Occurrence-aware inspection is read-only:

```bash
node scripts/purge-item.mjs --inventory-only --profile=work \
  --task-id=EXACT_RETAINED_TASK_ID --event-id=EXACT_SELECTED_EVENT_ID \
  --preserve-task --protect-event-ids=EXACT_MASTER_ID,EXACT_ACTIVE_SIBLING_ID
```

For a purge preview, supply the deployed ingress and worker Lambda names so the
tool can verify the admission protocol version and inspect the worker's actual
SQS event-source mappings:

```bash
node scripts/purge-item.mjs --profile=home --task-id=EXACT_TASK_ID \
  --event-id=EXACT_EVENT_ID --delete-calendar \
  --worker-function=todoist-calendar-sync-worker-production \
  --ingress-function=todoist-calendar-sync-ingress-production
```

The output shows exact DynamoDB keys and attribution, provider objects,
blockers, worker mapping state, a resumable operation ID, and an action-time
confirmation token. Calendar deletion requires the separate
`--delete-calendar` selection and exact confirmation. If a Calendar object or
another projection remains live, purge refuses to proceed.

## Apply protocol

Apply requires both functions to report `ERASURE_PROTOCOL_VERSION=1`. Queue
admissions take a transactional profile lease and are stamped with the current
profile erasure epoch. Each worker delivery holds a
writer lease through all provider and DynamoDB work, including its final
checkpoint. Lease acquisition and creation of the profile fence are
transactionally serialized.

The executor disables the worker's SQS event-source mappings, waits for
protocol-aware writers to finish, installs the profile fence, waits out the
maximum configured Lambda timeout for any invocation already in flight, and
confirms that no admission or writer lease remains. Fence creation atomically
advances the persistent profile epoch. The fence rejects new queue sends and
worker writes. After the fence is removed, workers drop any delayed or replayed
message with an older epoch (legacy messages without an epoch are epoch zero).
Pending SQS and DLQ messages are retained; their contents are not treated as
proof of safety.

The executor writes a temporary journal containing the selected IDs, exact
inventoried row keys/digests, provider snapshot digests, and source mapping
state. It then re-reads providers and DynamoDB under the fence, removes the
selected provider objects, removes matching Todoist mapping comments, and
conditionally deletes each inventoried state row. Two postflight reads must
prove provider absence and no attributable rows remain. Worker mappings that
were enabled before apply are restored and verified while the fence and journal
remain. Only then are the profile fence and journal atomically removed. If
restoration or the final commit fails, the journal still contains the original
mapping IDs for safe resumption.

Completed delivery receipts now carry exact task/event/series references
observed from the delivery and its audit details. The purge deletes receipts
that reference the selected object. Legacy receipts without identity references
remain blockers until their normal retention expires. Todoist upsert deliveries
re-read the exact task before projection; a 404 is suppressed. Unmapped
completion/deletion deliveries are also suppressed when Todoist confirms a 404
and no retained completion history exists. These recognized erased-item
replays produce identity-free audit telemetry and skip completion receipts, so
they cannot recreate target-identifying DynamoDB rows. Calendar replay reads
current Calendar state through the provider sync token, so a deleted object is
absent from the fetched delta.

Run apply only with a fresh preview and the explicit confirmation values:

```bash
node scripts/purge-item.mjs --profile=home --task-id=EXACT_TASK_ID \
  --event-id=EXACT_EVENT_ID --delete-calendar --apply \
  --worker-function=todoist-calendar-sync-worker-production \
  --ingress-function=todoist-calendar-sync-ingress-production \
  --operation-id=PREVIEW_OPERATION_ID \
  --confirm=PERMANENTLY_ERASE_PREVIEW_TOKEN \
  --confirm-task=EXACT_TASK_ID --confirm-calendar=EXACT_EVENT_ID
```

If apply fails after the fence is installed, it retains the temporary journal
and fence. Mapping restoration may be partial, but worker writes remain fenced.
Run a fresh preview
using the same selected IDs; the operation ID remains stable and the new token
reflects the remaining records and provider state. Resume with that token and
`--operation-id`. Do not clear the journal or fence by hand.

## Review API preview and durable operation

The authenticated review API prepares exact-item previews at
`POST /review/api/erasure-previews`, then persists them at
`POST /review/api/erasure-operations` using only the returned operation ID and
single-use confirmation. Preview performs a complete, paced, strongly
consistent table scan and exact provider reads; an incomplete scan, changed
provider snapshot, active fence/lease, existing journal, recurrence, or
ambiguous/shared row prevents confirmation or creation. The confirmation is
bound to the canonical inventory and a digest of the provider snapshot, and
creation repeats the reads before atomically storing the immutable operation
and consuming the confirmation.

The async erasure executor is implemented, including conditional provider deletion,
exact DynamoDB row deletion, provider readback, and postflight verification. The
CloudFormation parameter `ErasureExecutionEnabled` defaults to `"false"`; this is
the template default, not a statement about the live stack. A read-only production
audit on 8 November 2026 found `ERASURE_EXECUTION_ENABLED="true"` on the live
Review API and erasure worker, with `ERASURE_PROTOCOL_VERSION=1`. The worker's
queue mapping was enabled. The live executor must therefore be treated as
enabled until a separate approved deployment changes and verifies that state.
Execution requires the value to be exactly `"true"` on both functions and
`ERASURE_PROTOCOL_VERSION=1`. The API start and the worker check their own
deployment switch before doing any work.

To enable the reviewed execution path:
1. Complete a deployment review of the preview, deletion, readback, profile
   admission fence, SQS mappings, provider permissions, backup disclosure,
   logs/alarms, and the break-glass `review_required` procedure.
2. Deploy the same reviewed code revision and `ErasureExecutionEnabled="true"`
   to both functions. Confirm both deployed versions expose protocol v1 and the
   same execution flag. Restrict direct invocation of old Lambda versions.
3. Use a **new** authenticated, exact inventory preview, confirm the requested
   Todoist deletion and any separately selected exact Calendar deletion, then
   create the immutable operation and request `POST
   /review/api/erasure-operations/{operationId}/start`. The create response
   reports `providerDeletionReady` and `queueReady`; both must be true.
   Status can be polled at `GET /review/api/erasure-operations/{operationId}`.
   Start accepts no selection or confirmation fields.
4. Validate the full fenced execution and postflight on an expendable,
   non-recurring test item before accepting a production item.

Readiness is bound **at confirmation issuance**. Previews issued while
disabled and old `providerDeletionReady=false` operations remain
non-executable even if deployment configuration subsequently changes. Generate
a new preview and confirmation after enabling; never edit DynamoDB readiness
flags by hand. Recurrence-linked, ambiguous/shared, unattributable, or
potentially replayable items continue to fail closed.

Revoking the deployment flag stops new starts and worker steps. An already
fenced operation then becomes `review_required`, retaining its protections;
**do not flip the switch off mid-purge without a documented break-glass recovery
plan**. A successful production rollout must include the review-page
confirmation/progress experience and a tested operator recovery process.
This flag alone is not full issue #113 acceptance.

## Bounded Todoist project-comment tombstone for issue #349

The exact existing Todoist project mapping comment is rewritten as a tombstone
and retained after successful deletion for the bounded 18-day expiry. Current
workers consult it under the profile writer lease before processing matching
webhooks, Calendar deltas, or orphan rechecks. The tombstone cleanup job removes
it after expiry. Completed DynamoDB delivery receipts remain for their normal
14-day TTL, but the selected task/event IDs are scrubbed only after the exact
active project tombstone is read back under the erasure fence. Thus DynamoDB
retains delivery idempotency without retaining the erased identity.

The retention window covers ordinary SQS retry/redrive lifetimes, not arbitrary
manual invocation after expiry. Historical Lambda versions that do not read
the comment still require the separate #347 invocation boundary; the marker
alone does not make an unguarded version safe.

The implementation is merged and deployed. A fresh read-only audit on 9 Nov
2026 verified the project-tombstone marker in the deployed ingress, sync worker,
Review API, and erasure-worker packages. Source-level admission checks cover
Todoist webhooks, Calendar deltas, snapshot reconciliation, orphan recovery,
stored manual decisions, and queued repair previews. The production Review API
and erasure worker currently have execution disabled (`ERASURE_EXECUTION_ENABLED=false`);
the erasure worker's SQS event-source mapping is enabled, so the application
gate remains essential.

The version boundary needs ongoing review. Exact invocation Denies cover the
older ingress versions 2–88 and Review API versions 2–134. The later-published
ingress versions 89–92 and Review API versions 135–139 do not carry those
version-specific Denies; they contain the current tombstone-related code, and
the Review API versions are configured with execution disabled. Marker strings
and configuration readback do not prove that every check dominates every write
or that every caller and rollback path is covered. Issue #484 now implements a
bounded, operation-scoped post-write finalizer, but it honours the existing
`ERASURE_EXECUTION_ENABLED` gate and `ERASURE_PROTOCOL_VERSION=1`. Keep the
production gate disabled until the #347 invocation/writer/IAM boundary and
independent security/rollback review, plus #349 disposable Work-profile
acceptance, are complete. The finalizer does not require a global Calendar
absence proof for exact recorded targets and does not require a separate
per-operation typed signoff. It does not prove absence of unknown Calendar
copies, backups, or external integrations. Normal sync, recurrence, and
seven-day completed-task retention remain separate behavior.

The API scan stops after its bounded 80-second preview window and returns no
confirmation if it cannot finish. It uses the configured DynamoDB scan page
limit and RCU pacing; retry the preview or use the guarded operator CLI when
the state table cannot be inventoried in that window. A DynamoDB consistent
scan is consistent per item, not a table-wide snapshot, so operation creation
and the eventual action-time worker gate must both compare the exact inventory.

## Async worker gate drift

The async review endpoint can report `status: "review_required"` with
`operatorRecoveryRequired: true` if the final read-only deletion gate detects a
changed preview, mapping inventory/state, fence owner, active lease, or lifecycle
receipt. Under an enabled deployment this worker can perform destructive steps, but
it performs no further deletion after detecting drift.
it makes no further changes to the fence or mappings. It acknowledges the queue
message only after recording the terminal status and refuses to resume the same
operation. The mismatch means the worker has not proved that all protections
remain intact; do not assume the profile is safely fenced. Preserve any
protections that remain, inspect the fence and mapping state, and escalate if
either differs. A fresh preview is unsafe until controlled recovery restores
service admission.

Issue #239 introduces a narrowly guarded recovery path for a proven pre-write
failure with an intact matching fence and an unchanged exact inventory.
For all other states, preserve protections and escalate; do not requeue the
original erasure, edit fence / epoch rows, or enable event-source mappings by
hand. Escalate immediately if the fence or a mapping is missing, changed,
or cannot be verified. Any extended recovery implementation must also
satisfy the following controls under operator change control:

1. Read the durable operation and its original `mappingIds`,
   `enabledMappingIds`, preview fingerprint, and lifecycle receipts. Read back
   each recorded Lambda event-source mapping by UUID and obtain a complete,
   consistent provider and DynamoDB inventory for the exact selected IDs.
2. Confirm the profile fence is still owned by this operation and inspect all
   pages of lease rows. If ownership is different, a lease remains, an expected
   mapping is missing, or any inventory is ambiguous, stop, preserve whatever
   protections remain, and escalate without attempting to restore admission.
3. Restore only mappings listed in `enabledMappingIds`; preserve mappings that
   were originally disabled. Read every mapping back and verify its exact
   original state while the fence is verified as installed and owned by this
   operation. If that fence check fails, stop and escalate.
4. Recheck fence ownership and the full lease set after mapping readback. Remove
   only this operation's temporary fence through a reviewed, conditionally
   guarded protocol action when the lease set is empty. Retain the monotonic
   profile epoch and the `review_required` operation record.
5. Only after service admission has been restored, create a new preview from
   current provider and DynamoDB state and require a new single-use confirmation.
   Never reuse this operation's consumed confirmation or its inventory.

The constrained #239 path implements these checks for a verified pre-write
recovery only. It deliberately refuses partially or fully deleted cases until
their replay-safe disposition is independently implemented and reviewed.
These requirements are not permission to perform ad-hoc DynamoDB or Lambda edits.

## Explicit break-glass recovery (issue #239)

This is a separate, operator-confirmed admission restoration. It **never**
resumes an earlier deletion, reuses the erasure confirmation, modifies the
target provider items, or creates replacements.

The authenticated review page can load an existing erasure operation ID and
show **Inspect independent recovery evidence** when the original operation is
`review_required`. The read-only inspection scans every page of profile
fence/epoch/lease/journal controls, reads back the original worker SQS mappings,
and refreshes the exact provider/comments/DynamoDB inventory. An incomplete
scan, missing operation/fence/epoch, changed ownership, active lease, abnormal
mapping, or ambiguous provider state **blocks recovery without writes**.

**Automatic recovery eligibility is intentionally narrow:** only an erasure
halted *before the first deletion step* (`wait_worker_timeout`,
`drain_after_timeout`, or `ready_for_delete`) with an installed operation-owned
fence and a provably unchanged provider/DynamoDB inventory may be restored.
A partial erasure, a deletion that completed, a missing fence, or an
already-recovered operation stays blocked. Even when all provider objects are
absent, late webhook/SQS replay has not been proved impossible; an apparently
completed purge therefore requires separate controlled replay-proof
reconciliation before restoring admission. No `force unlock` exists.

After inspecting all mapping UUIDs and blockers, select **Request single-use
recovery confirmation**. A new, five-minute confirmation is bound to the
current operator's identity, full inspection fingerprint, profile, operation,
fence owner, epoch, mapping states, and immutable original evidence. Type
`RESTORE SYNC`, repeat the exact operation ID and profile, then confirm.
The server independently rereads all evidence before atomically consuming the
confirmation and claiming the recovery. A stale token is never applied.

The recovery worker takes a **distinct SQS payload** that cannot be parsed
as an ordinary deletion request. It enables only the originally enabled
worker event-source mappings, one at a time, and readbacks their exact states.
Originally disabled mappings remain disabled. It waits for eventual AWS
`Enabling` states without removing the fence. Once all original mapping
states, unchanged provider inventory, fence ownership, monotonic epoch and
empty lease set are verified again, a DynamoDB transaction conditionally
removes *only this operation's* temporary fence and matching journal. The
monotonic epoch and original `review_required` operation record are retained,
with separate durable `recovery.status=completed` audit evidence.

If an accepted recovery stops because an SQS send failed or the worker hit a
transient exception, use **Retry existing recovery dispatch** on the
authenticated page; do not issue another confirmation or replay a purge.
`recovery.status=blocked` or a drift/ownership error requires manual review.
Never edit DynamoDB fence/epoch rows, modify mappings outside this protocol,
or interpret a 404 as evidence of successful erasure. Once the service is
restored, run a *fresh*, authenticated profile reconciliation to detect source
changes suppressed by the fence; the normal worker deliberately drops old
SQS payloads carrying a pre-fence erasure epoch. Do not replay old DLQ
deliveries to compensate. Verify fresh work is admitted and processed.

Recovery is not erasure of backups. The 35-day DynamoDB PITR disclosure
continues to apply. Production acceptance requires a disposable Work-profile
fence/recovery fault-injection rehearsal and independent IAM/invocation review
before closing issue #239.

## Guarded pre-write recovery watchdog (issue #433, staged)

A source-worker SQS trigger is shared by `antonio`, `home`, and `work`. An
exceptional erasure can temporarily disable that trigger. The 9 November 2026
Work-profile acceptance attempt failed while reading an SSM credential after
its mapping had been disabled. The operation was durably `review_required`
at `ready_for_delete`, and the protected Work fence remained installed.

The erasure-worker package now includes a **bounded, separate** EventBridge
watchdog Lambda with its own 300-second timeout, concurrency limit and a
role that can inspect event-source mappings but **cannot update them**. The
separate function prevents slow provider-inspection work from starving the
active erasure SQS worker. Its SAM schedule is **disabled by default** pending
disposable Work-profile fault-injection acceptance. When enabled it runs every
five minutes, independently of the disabled ordinary source queue, reading only
the three fixed `ERASURE#profile/FENCE` rows (strongly consistent
`BatchGetItem`; **no table scan**). It checks only fence-owner erasure
operations. For a `review_required` operation with no active recovery,
it calls the same independent pre-write `inspect`, single-use confirmation
and conditional `apply` path used by the authenticated operator, with an
explicit system-watchdog actor. The action is **recovery only**, never a
new deletion or resumption of a previous destructive step.

The automatic path **must refuse** absent/changed mapping UUIDs, an unmatched
fence owner/epoch, active leases or missing pages, an altered original provider
inventory, an uncertain provider read, any `deletionStarted` receipt or
`deletionProgress`, post-write phases, and any existing blocked recovery.
No provider delete is invoked. The existing recovery worker restores only
originally enabled mappings and uses a conditional DynamoDB transaction to
release the exact operation-owned fence after verifying all sources again.
If enqueueing the recovery message fails after a durable recovery claim,
the next watchdog pass re-dispatches the existing recovery identity; it does
not issue a second confirmation. Operator/manual recovery continues to work.

**Activation gate:** run the source/CI tests and disposable Work-profile
fault matrix, independently inspect IAM, worker-version/rollback and exact
provider-fingerprint checks, then explicitly enable the
`ErasureRecoveryWatchdog` SAM Schedule in a reviewed deployment. Run a
controlled fault injection (including missing SSM permission) and verify
normal `home`, `antonio`, and `work` traffic resumes with the correct
mapping state, no provider mutation and preserved audit evidence. Keep the
schedule disabled until acceptance; the current live erasure still requires
the existing authenticated #239 recovery path.

**Failure handling:** watchdog logs only the operation ID, profile and
blocker counts/types. For inconclusive or post-write recovery the fence is
retained; investigate the new prompt Windsor Prometheus
`TodoistErasureReviewRequired` alert and use operator-confirmed recovery.
Never treat the automated watchdog as a force-unlock facility. To roll back,
disable the schedule; do not change the existing erasure fence or source
mapping by hand.

## Limits

The fence covers repository ingress and worker paths after the protocol
version is deployed. It does not prove that a separately published Lambda
version or an external principal with direct `lambda:InvokeFunction`
permission cannot invoke older code during the maintenance window. Restrict
that invocation path before production use. A provider may also finish a
request after the local Lambda has timed out; the postflight read detects
visible late writes, but cannot prove that a remote provider has no delayed
internal work.

DynamoDB point-in-time recovery and external backups may retain erased values.
This procedure only proves current table/provider state and does not delete
backups. Historical repair and forensic evidence for the item is intentionally
lost.


## Post-write evidence and automatic completion (issues #349 / #484)

The authenticated review portal exposes
`GET /review/api/erasure-postwrite-recoveries/{operationId}` for a redacted,
read-only inspection of an already-recorded `review_required` operation. The
inspection is limited to the exact original Todoist task, Calendar event,
configured calendar and recorded alias inventory; it does not require a global
Calendar provenance register and does not claim that unknown copies are absent.

A `fully_deleted_candidate` now means the exact original selection and
deletion-start receipt are present, deletion checkpoints are complete with no
uncertain write-ahead attempt, both recorded provider targets are absent, the
configured Calendar link is not found, attributable DynamoDB rows are absent,
and the exact active 18-day project-comment tombstone is read back. The owned
fence, epoch, drained leases and original mapping inventory must also be
consistent. Missing or conflicting evidence is `partial_or_ambiguous` and
remains fenced.

The existing scheduled EventBridge erasure watchdog performs the completion;
there is no new queue or feature flag. It runs only when the existing
`ERASURE_EXECUTION_ENABLED=true` and `ERASURE_PROTOCOL_VERSION=1` controls
are active, and the original operation has `providerDeletionReady=true`.
This preserves the #347 release boundary; the code does not enable those
controls or authorize production erasure.

For an eligible exact operation the watchdog:

1. Re-inspects the immutable operation, exact provider readback, tombstone,
   attributable state inventory, fence, epoch, leases and worker mappings.
2. Restores **only** the UUIDs recorded in the original
   `lifecycle.enabledMappingIds`; mappings originally disabled remain disabled.
3. Rechecks the live mapping inventory and the same operation/fence/epoch
   immediately before release.
4. Uses one conditional DynamoDB transaction to remove the original
   confirmation, any operation-bound pre-write or legacy post-write review
   tokens, operation-owned fence and journal, while replacing the
   identity-bearing operation with an identity-free terminal receipt. The
   epoch and operation/checkpoint conditions are checked in the same
   transaction.
5. Leaves the original project-comment tombstone untouched for its normal
   18-day expiry cleanup. It never repeats a Todoist or Calendar delete.

The terminal receipt retains only operation/profile/status, completion time,
epoch and mapping counts; it contains no deleted task/event IDs, titles,
comments, hashes, preview fingerprints or inventory. The review API reports
`classification=completed`, and repeated inspection/watchdog runs are
terminal no-ops. The UI no longer requests a per-operation review token or
typed acknowledgement.

If any evidence is stale, partial, ambiguous or conflicting, the watchdog
leaves the fence active and reports a specific blocker. If mapping restoration
has begun but the final transaction conflicts, the fence remains active and
the next pass retries idempotently after fresh inspection. Never manually
remove the fence or edit worker mappings.

The former fenced-review token and acknowledgement endpoints are retired
(HTTP 404); no per-operation review token is required. The pre-write
`RESTORE SYNC` confirmation is never reused and cannot act on a post-write
operation.

## Production status after PRs #403–#405 (8 Nov 2026)

The bounded Todoist project-comment marker changes are deployed to current
master (deployment run 42536045650). The `todoist-calendar-sync` stack is
`UPDATE_COMPLETE` with `ErasureExecutionEnabled=false`; the live Review API
setting is false and its replay-barrier setting is absent. The unqualified
worker has no execution flag. The erasure worker mapping remains enabled.

A fresh seven-function audit found 223 published versions and two aliases.
Seventy-one Review API configurations still carry execution enabled, including
historical qualified versions that remain invocation candidates. The current
`live` alias target is version 136 with execution false, but the audit has not
proven a deny for old qualified versions or every external caller. Therefore
this deployment does not satisfy #347's writer/IAM boundary or #349's
disposable Work-profile fault-injection acceptance. Keep the production gate
false. Do not release fences or enable the replay barrier until both criteria
are independently verified.
