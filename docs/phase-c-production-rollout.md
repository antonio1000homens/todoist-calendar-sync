## #290 Phase C production rollout (operator-approved)

The Phase C Calendar→Todoist **native write path is now explicitly opt-in**
through CloudFormation parameter `PhaseCNativeEnabled` (environment variable
`TODOIST_CALENDAR_SYNC_PHASE_C_NATIVE_ENABLED` on Lambda). By user request,
the production deploy configuration passes `PHASE_C_NATIVE_ENABLED=true` by
default. A production environment variable with value `false` overrides
the default and the next deployment restores the previous rolling fallback
without changing any tasks or Calendar masters.

Only *new* Calendar-owned series in the four provider-tested families
(multiple weekdays, multiple month days, anchored alternating Friday and
simple 2-12 month intervals) can create a native Todoist recurrence.
An existing Calendar-owned link with `calendarNativeRecurring` unset remains
on the old rolling path; no bulk migration, re-ownership, master rewrite
or history deletion is introduced.

The write path reuses the existing strict timezone check, bounded Google
instance fetch, complete explicit exception inventory and durable mapping
identity fences. A new provider write must pass the normalized Todoist due
text and local occurrence readback. On mismatch, the preexisting code
rolls back the created Todoist task or restores its pre-migration one-off;
false native mapping commit is rejected. Unsupported semantics, missing
exceptions or a doubtful provider clock remain rolling/guarded review.

### Verification performed with Todoist / Google Calendar (7 November 2026)

A dedicated Todoist project `Sync recurrence verification #290` outside the
sync profiles recorded two real completion advances, preserving *the same task
ID* in each case:

- Mon/Fri 8→11→15 Jan 2027 (9am)
- Monthly days 2→15→27 Jan 2027
- Every other Friday 8→22 Jan→5 Feb 2027
- Every two months 10 Jan→10 Mar→10 May 2027

Google Calendar independently persisted `RRULE:FREQ=WEEKLY;BYDAY=MO,FR`
with instances Friday 8, Monday 11 and Friday 15 January 2027. These
fixtures prove the first two provider advances; they do not prove all
overdue, month-end and DST edge cases. Existing Phase C rejection and
synthetic DST/month-end coverage remains in place.

The flag can be rolled back with production GitHub variable
`PHASE_C_NATIVE_ENABLED=false` followed by workflow-dispatch of
`Deploy production`, **after verifying the deployed Lambda flag**. Existing
native mappings must be reviewed before rollback; switching off new
creation is not permission to flatten an already-native recurrence.

### Observed provider divergence — excluded from native rollout

A separate Todoist test `every 29, 30, 31` started 29 January 2027
and advanced **29→30→31 January→28 February** on three real completions.
RFC 5545 `BYMONTHDAY=29,30,31` skips February 2027. Consequently native
production admission refuses any monthly multiple-day list containing
29/30/31 and any fixed monthly interval anchored on day >28. This is not
an API failure: it is a genuine semantic mismatch that must remain on
the rolling/manual-review path pending a separate strategy. The original
read-only classifier may still describe such a candidate; it is not an
authorization to create a native representation.
