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
re-read the exact task before projection; a 404 is recorded as a no-op, so a
queued or retried webhook cannot recreate a task that has been erased. Calendar
replay reads current Calendar state through the provider sync token, so a
deleted object is absent from the fetched delta.

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
