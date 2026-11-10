# Phase B follow-up: Todoist-owned native recurrence admission

Issue #290 was closed on 7 November 2026 but still contains a broader Phase B Todoist→Calendar native-write requirement. This follow-up does **not** reopen the issue. It adds a guarded writer for newly created tasks; the production switch is default OFF.

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

The deployment control is `PhaseBNativeEnabled` / `PHASE_B_NATIVE_ENABLED`, default `false`. In tests the equivalent runtime variable is `TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED`. Keep it off until the managed-profile disposable E2E has verified all three recurrence families, completion progression, repeat delivery, rollback and recurrence preservation. Cross-profile moves currently fail closed with a review audit while retaining the source master; deterministic destination-master copy/readback is still required before the feature is production-ready. Do not migrate an existing rolling mapping or modify historical Calendar series.

## Rollout state

Code-level validation: the focused policy/writer/provider-surface tests and full suite pass. This PR does **not** turn on Todoist→Calendar native Phase B in production. Managed-profile disposable provider acceptance has not been run, and cross-profile native-master copying remains unimplemented; the switch stays OFF. Existing Phase C Calendar→Todoist native support and flag are unchanged.
