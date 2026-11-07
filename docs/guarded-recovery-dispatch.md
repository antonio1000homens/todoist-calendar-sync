# Guarded recovery dispatch: don't silently swallow source updates (#372)

**Root issue:** A valid Todoist upsert with `activeRepair` is stopped by the upstream `OrphanRecoveringSynchronizer` and `ProjectAwareSynchronizer` prefilters before a downstream guarded repair recovery can verify whether the held operation is safe to supersede. The worker then acknowledges the dropped message as completed/no-op. This is not an automatic resolution of the conflict.

The shared helper `hasGuardedRecoveryDispatchCandidate` establishes **routing eligibility only**:

- Incoming operation must be `upsert`, not completion, deletion, due removal or a Calendar delta.
- The live mapping must still bind the *exact task ID* to the same profile as the source Todoist project and delivery.
- The exact task must still have an `activeRepair` owner in its profile-scoped `SYNC_CONTROL#` record.
- Cross-profile moves, ambiguous/unmapped updates, excluded controls without a repair owner and any other blocking condition **retain normal blocking behavior**.

The **inner** `Synchronizer.processTodoist` then independently fetches the current task, checks the project, source version and any available guarded recovery protocol (currently the no-write, cancelled standalone -> annual reset from #369). The route itself never releases a lock, deletes a DynamoDB item or writes a Calendar or Todoist provider event. If the inner recovery refuses, the original `syncBlocked` remains effective and the write cannot proceed.

Normal blocked updates now produce `todoist_preflight_sync_control_blocked` rather than returning silently; routed attempts produce `todoist_preflight_guarded_recovery_routed` and `todoist_project_guarded_recovery_routed` followed by the actual downstream outcome. All are redacted by normal telemetry controls.

**Regression coverage:** exact held lock, missing lock, wrong source profile/project, completed/deleted lifecycle, two-level delegation, denied recovery still blocking and no provider writes, plus lock read outage surfacing an error rather than acknowledging. This is a generic dispatch mechanism for future *explicitly verified* repair protocols, not a blanket skip of conflict protection.

## Operational E2E

Use the existing approved source task in #369. Its annual recurrence is already set with due date in 2027, but the first two updates were swallowed by the old prefilter. Once the new production revision is active, trigger one fresh source task upsert or execute an authorized reconcile and observe:

1. `REPAIR#` no-write/failed operation marked abandoned; exactly its four `SYNC_CONTROL#` claims released.
2. Obsolete mapping triplet retired; new fresh Calendar `RRULE:FREQ=YEARLY` master confirmed with its August 2027 occurrence.
3. New exact task↔Calendar mapping and Todoist-owned recurrence link present; no additional provider task or Calendar duplicate, no full audit purge.
4. Any remaining blocked state logged with a precise, actionable refusal reason; **do not forcibly delete DynamoDB rows**.

Close #369 after provider and DynamoDB validation, and #372 when no regression remains.
