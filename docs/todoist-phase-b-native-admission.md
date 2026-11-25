# Phase B follow-up: Todoist-owned native recurrence admission

Issue #290 was closed on 7 November 2026 but still contains a broader Phase B Todoist→Calendar native-write requirement. Issue #510 now tracks the bidirectional sync redesign. Verified native recurrence admission and cross-profile native-master moves use provider readback and staged state validation; neither path uses a deployment feature flag.

## Provider observations (8 November 2026)

Tested in a dedicated Todoist project outside the three sync profiles, with unchanged task IDs through two completions:

| Todoist phrase | First due | After first completion | After second completion | Candidate |
| --- | --- | --- | --- | --- |
| every 2, 15, 27 | 2027-01-02 | 2027-01-15 | 2027-01-27 | RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27 |
| every other Friday | 2027-01-08 | 2027-01-22 | 2027-02-05 | RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR |
| every quarter (normalized to every 3 months) | 2027-01-10 | 2027-04-10 | 2027-07-10 | RRULE:FREQ=MONTHLY;INTERVAL=3 |
| every quarter starting 31 January | 2027-01-31 | **2027-04-30** | **2027-07-30** | **NOT exact: refuse native** |

Previous 7 November tests also demonstrated that Todoist `every 29,30,31` changes the missing February recurrence to 28 February, whereas RFC5545 BYMONTHDAY skips it. Both are excluded from native admission for day >28.

## New pure policy boundary

`admitNewTodoistPhaseBNative()` requires:
- authenticated **item:added** with a source revision in the two-minute creation window, fresh same-ID/same-project/same-due Todoist GET, no completion or due changes;
- exact managed profile project ID, no existing DynamoDB mapping, no existing Google provider alias, no pending split/repair;
- independently matching Calendar/Todoist IANA timezone;
- all-day recurrence with original first due in the future, exact Phase B family and anchored RFC5545 semantic equivalence;
- no Todoist history inferred from a previously advanced task.

`verifyInitialPhaseBCalendarWrite()` is the second, independent post-write gate. It requires a persisted confirmed master/etag with matching owner, task ID, original anchor and rule; a **complete, empty explicit exception inventory**; at least three consecutive Google `originalStartTime` provider instances with no moved/cancelled override, and matching independently verified timezone.

Both return explicit negative reasons and **perform no provider writes or mapping changes**. The `item:added` writer calls them under the existing task write fence and mutation budget, creates a deterministic Calendar master ID, independently GETs the saved master, expands provider instances and inventories explicit exceptions, then commits the Todoist-owned mapping only after verification. An invalid newly created master is deleted and audited; if rollback fails, the exact identity is quarantined and later deliveries stop before replacement. Existing tagged Phase B masters remain native when Todoist advances due; the sync updates the active occurrence mapping and only patches master summary/description with an ETag. Disabling new creation does not flatten an already committed native master.

Cross-profile moves with missing or conflicting exact identity fail closed while retaining the source master. Valid moves use deterministic destination-master copy/readback and an atomic state handoff. Do not migrate an existing rolling mapping or modify historical Calendar series without that verified move path.

## Rollout state

Code-level validation: unit tests cover the guarded admission policy, provider readback, repeat delivery, progression, and rollback. Native admission is unflagged in this worktree. This change has not been deployed; automated live-provider acceptance remains outstanding. Existing Phase C Calendar→Todoist support remains on its separate path.
