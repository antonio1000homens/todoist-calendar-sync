# Deliberate per-item purge (issue #113)

**This is an exceptional operator erasure, NOT normal Todoist completion/deletion,
review repair, or scheduled state-retention cleanup.** It is intentionally a
separate CLI rather than a regular review decision. It never writes a retained
per-item purge receipt or audit entry. It does not make provider mutations
unless the operator repeats the exact identifiers and a fresh inventory token.

## Safety boundaries

### Occurrence-aware read-only inventory

For a recurring series, a retained active/completed task, or a cancelled
occurrence beside a live sibling, use the **read-only** inventory mode. It
does not offer or perform apply. Supply the task as the protected anchor and
list exact retained Calendar master/sibling IDs when they are known:

```bash
node scripts/purge-item.mjs --inventory-only --profile=work \
  --task-id=EXACT_RETAINED_TASK_ID --event-id=EXACT_SELECTED_EVENT_ID \
  --preserve-task --protect-event-ids=EXACT_MASTER_ID,EXACT_ACTIVE_SIBLING_ID
```

Every matching or transitively linked state row is classified as
`selected-only`, `shared with protected state`, `ambiguous`, or
`unattributable`. The output includes counts, exact keys, attribution reasons,
and blockers. Exact retained IDs prevent task-level baselines/canonical rows,
active or completed mappings, recurrence ownership, and sibling occurrences
from being treated as selected-only history. Transitive review and manual
decision records are followed through their explicit record links. Unknown
identity fields and malformed/unknown state families fail closed.

All `DELIVERY` receipt rows are included in inventory. A receipt with no exact
selected identity is `unattributable`; one that does carry an exact identity
is still `ambiguous`, because identity alone does not establish that a
delivery is completed, drained, or impossible to replay. Either classification
blocks destructive apply. This preview cannot establish replay quiescence; an
operator checkbox cannot prove that an external delayed webhook or retry will
not recreate erased state. A later executor needs a verifiable replay barrier.
Table-wide PITR backups may also retain deleted data during their recovery
window.

`--inventory-only` is deliberately preview-only. `--preserve-task` and
`--protect-event-ids` cannot be combined with `--apply`; the existing pair
purge executor still only supports deleting its exact selected task and
optional event after all of its own safety gates pass.

1. Arrange a maintenance window and **pause the sync ingress, all worker
   consumers, reconciler and any producers of old webhook/delta deliveries**.
   Inspect/drain the affected profile's FIFO queue and dead-letter queue, plus
   any retry sources. Do **not** run reconciliation while erasure is in progress.
   `--ack-deliveries-quiesced` is a required operator attestation, not an
   automated AWS check. The script cannot guarantee the absence of retained,
   untagged delivery receipts or replayable external webhook messages.
2. Export the exact Todoist task ID and (where relevant) exact Calendar event
   ID **out of band**; never select by title/date or infer a Calendar deletion.
   Event deletion is separate, by explicit `--delete-calendar` **and**
   `--confirm-calendar=...`. If a Calendar event still exists but is not
   selected for deletion, the operation refuses, because otherwise sync may
   silently recreate the Todoist item.
3. Provision AWS credentials with read/write access only to the state table
   and read/write provider credentials for the selected profile. Set
   `STATE_TABLE_NAME` explicitly, together with the application's
   `SYNC_PROFILE_CONFIG_JSON` and SSM configuration, and run `npm ci`.
4. Preview (no writes):

   ```bash
   npm run build
   node scripts/purge-item.mjs --profile=home --task-id=EXACT_TASK_ID \
     --event-id=EXACT_EVENT_ID --delete-calendar
   ```

   The output enumerates exact DynamoDB `pk`/`sk`, record type, attribution
   explanation, provider objects, blockers, and a snapshot-specific token.
   Save this **offline** if a partial operation later needs investigation; do
   not publish production IDs, titles, or inventories in public GitHub issues.
5. Only if there are **no blockers**, after reviewing the preview and
   quiescing deliveries, issue a *fresh* apply action:

   ```bash
   node scripts/purge-item.mjs --profile=home --task-id=EXACT_TASK_ID \
     --event-id=EXACT_EVENT_ID --delete-calendar --apply \
     --confirm=PERMANENTLY_ERASE_PREVIEW_TOKEN \
     --confirm-task=EXACT_TASK_ID --confirm-calendar=EXACT_EVENT_ID \
     --ack-deliveries-quiesced
   ```

   If the target Calendar item is already absent, `--event-id` can be
   supplied **without** `--delete-calendar`: it is still inventoried and its
   attributable Dynamo records can be removed, but no Calendar delete is sent.
   When only a task ID is supplied, any state or live Calendar projection that
   connects to a different Calendar event blocks purge.

The tool re-reads both providers and re-scans the table immediately before
mutations. It deletes verified matching Todoist mapping comments first, then
Todoist (if still live), then the exact separately approved Calendar event
(if live), and finally the inventory's DynamoDB rows. Every row is checked
with a consistent Get and a full-attribute conditional Delete. Already-absent
records are skipped. There is a second double-check of provider and state
absence after deletion. Normal lifecycle rules are unchanged; unmapped Todoist
upserts now require an active-task existence check before projection.

## Refusals and manual handling

- Recurring tasks, Calendar masters/instances, recurrence links, or completed
  history spanning other event IDs must be analysed separately. The script
  deliberately refuses shared-history or uncertain series operations.
- Records linking another task/event/profile, records in shared profile-wide
  reconciliation state, unknown record families, malformed state keys,
  ambiguous Calendar task links, and malformed matching Todoist comments cause
  refusal. It never deletes a shared record just because one selected ID
  appears in it.
- DynamoDB `DELIVERY` entries often store only a random receipt ID without
  the original task/event. Non-attributable receipts, redacted older audit
  details, external queues, and backups cannot be **proven** erased from a
  full-table item inventory. This is a platform provenance limitation and a
  reason to **withhold production erasure** until operators have independently
  audited those sources. The CLI is not a data-protection compliance guarantee.
- Before an unmapped Todoist upsert enters orphan recovery or project-transition
  handling, the worker re-reads the task by exact provider ID and uses that
  fresh snapshot for later decisions. A 404 is a no-op; other lookup failures
  stop processing. This closes the stale-payload path through the worker, but
  does not establish queue/receipt quiescence or cover direct/manual code paths
  that bypass the worker entry point; the inventory and execution blockers
  remain in force.
- No per-item suppression tombstone is retained after success, so recovery
  must rely on all source objects being absent and replay sources being
  quiesced/drained. If an unrelated live Calendar item must remain, do not
  bypass this refusal; a complete replay-prevention design is still needed.

## Partial failure / resume

A failure after provider mutation does **not** roll back deleted providers.
The CLI reports the verified deletions and an explicit partial status. Keep
ingress and workers stopped. Re-run the *preview* with the same exact IDs,
review the changed inventory/provider state and, if safe, repeat the action
with the **new** confirmation token. No retained Dynamo purge-operation row
is used; the remaining provider and state records are the recovery checkpoint.
Do not resume regular reconciliation until the postflight is clean.

**Irreversibility:** This operation destroys item-level mappings,
audit/repair evidence and histories; historical debugging and repair will no
longer be available for that item. Existing PITR/backup snapshots and other
systems' retained records are not overwritten or destroyed by this command.

### Implementation coverage / outstanding integration work

This PR provides a conservative, executable operator CLI, preview inventory,
conditional deletion, provider re-reads and regression tests. It deliberately
does **not** expose a new review-page button or a background auto-retry
mechanism, because the current event-delivery receipts and historical records
are not fully attributable by item. The sync path drops a delayed unmapped
Todoist upsert when its exact task has disappeared, but that control does not
cover all delivery sources or prove replay quiescence. Production execution
must remain gated until these design gaps have been addressed.
