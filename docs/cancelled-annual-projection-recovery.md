# Automatic recovery from a cancelled standalone Calendar mapping (#369)

This is a **provider-preserving, guarded** self-heal for the narrow case in which an existing active Todoist task is changed to **every year**, while its standalone Calendar mapping has already been cancelled and a dismissed, failed **validation-only** review repair still owns exact `activeRepair` controls. It is not a general way to bypass Review cases or purge historical records.

## Why it is conditional

Normal processing deliberately blocks a stale Calendar deletion from implicitly recreating an event; reconciliation also blocks tasks with active repair controls. Without a recovery path, a valid Todoist yearly edit cannot produce a new Calendar recurrence. Deleting `AUDIT#` rows does not release the locks, mapping, baselines or provider-side deleted event aliases.

A current task update qualifies only when all checks succeed:

- Todoist currently returns the **same** active, incomplete task, in the selected profile, with a date-only supported annual recurrence (`RRULE:FREQ=YEARLY`) and a source revision newer than the stored mapping and old repair.
- Exactly one old standalone 3-view mapping is owned by this task; no other profile mapping, recurring link, completed-event history, explicit deletion guard, erasure replay marker or projection tombstone is present.
- The old review case is dismissed and still references the exact failed repair. The repair is genuinely unapplied: only the completed `validated` checkpoint, no provider-side write evidence, no creation, no replay ambiguity, all preview refs fully accounted for.
- All original repair-owned control keys still carry that same `activeRepair`, without conflicting exclusion. The currently mapped event, every repair-preview Calendar ref, and all typed linked Calendar aliases are confirmed cancelled by independent current provider reads. A surviving active event or future override blocks the reset.
- The source Todoist task is reread after Calendar checks and must match the original observed task revision, due anchor, project and annual cadence.
- An in-flight profile erasure, unexpected shared mapping, version change, or concurrent writer aborts the transaction without partial deletion.

## Atomic reset

Under the caller-owned `CALENDAR_WRITE#taskId` lease, a single DynamoDB transaction:

1. Checks the live writer token, review case status/version, failed repair checkpoint/attempt/version and all exact control versions.
2. Marks that **same repair record** abandoned and non-resumable for old FIFO delivery replay, without deleting the historic operation.
3. Releases only its owned `activeRepair` references while leaving pending refresh tokens intact.
4. Removes precisely the obsolete `TASK#`, `TASKOWNER#`, `EVENT#` mapping views and the exact old task baseline, subject to saved revision/ownership conditions.
5. Writes one durable `ANNUAL_RECOVERY#profile#taskId` **pending** receipt with the old event identity, task source revision and approved due date. This prevents a crash between reset and new Calendar creation from allowing unrelated cancelled provider aliases to suppress recovery.

There is **no** Todoist task deletion, Calendar provider deletion, generic DynamoDB audit purge, mutation of completion receipts, removal of version guards or recurring history clearing.

The standard Todoist projection then creates an RRULE yearly Calendar series. If the Calendar POST succeeded but the mapping write acknowledgement was lost, a later replay reuses **one** independently verified, canonical confirmed annual task-owned series rather than creating a duplicate. The recovery receipt is deleted only after new mapping views and recurrence link have been durably written and verified through conditional checks. A source change or ambiguous provider alias leaves the receipt and raises an audit, not a second series.

Cancellation deltas and reconciliation protect an active newer annual Todoist task from being deleted through its former cancelled mapping. Late replay of the abandoned repair returns terminal without applying provider writes.

## Expected operator experience

1. Deploy this change to the ingress, worker and reconciliation components on the **same version**; check the pipeline/deployment before relying on it.
2. In Todoist, change the original task to **every year** while keeping its all-day date.
3. A normal Todoist webhook automatically attempts the guarded recovery. It creates a fresh confirmed annual Calendar master and canonical active occurrence.
4. If eligible, the old repair locks are removed transactionally and the old record is retained as abandoned evidence. The old Calendar objects remain cancelled. Historical `AUDIT#` and `AUDIT_REF#` rows keep their existing seven-day TTL (intentional evidence), and no destructive cleanup runs.
5. If an eligibility check fails, no old mapping/lock is removed. Investigate audit `todoist_cancelled_annual_projection_source_changed`, `todoist_cancelled_annual_projection_alias_conflict` or the existing `todoist_task_sync_control_blocked` and the recovery case; do not edit the DynamoDB records by hand.

## Validation

New regression tests cover valid yearly source, non-recurring/stale/completed edits, queued/writing/abandoned operation blockers, per-profile mapping ownership, completed history, provider active alias, source version races, partial/missing indexes and transaction conflicts. The normal #278/#114/#113/#349 suites continue to run. No live provider data is created during tests.

This feature **does not** erase every old reference identifying the existing Todoist task: an immediate full erasure would break deterministic worker idempotency and forensic retention. The reset makes the same original task eligible for a *new Calendar projection*, which is the desired functional outcome.
