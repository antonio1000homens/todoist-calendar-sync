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
exact DynamoDB row deletion, provider readback, and postflight verification. It
remains **off by default**. The CloudFormation parameter
`ErasureExecutionEnabled` defaults to `"false"`; it is deployed as
`ERASURE_EXECUTION_ENABLED` on **both** the authenticated review API and
the erasure worker. Execution requires that value to be exactly `"true"`
on both functions and `ERASURE_PROTOCOL_VERSION=1`. The API start and
the worker check their own deployment switch before doing any work.

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

There is no automated operator recovery endpoint or command in this release. The
safe response is to preserve any remaining protections and escalate for a
separately reviewed recovery action; do not requeue the operation, delete or
edit fence / epoch rows, or enable event-source mappings by hand. Escalate
immediately if the fence or a mapping is missing, changed, or cannot be
verified. A recovery implementation must, at minimum, do all of the following
under operator change control:

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

The deployed code does not provide that recovery implementation, so these
checks are requirements for the separate break-glass change, not permission to
perform ad-hoc DynamoDB or Lambda edits.

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
