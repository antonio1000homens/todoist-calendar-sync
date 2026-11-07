# Issue #290 — Phase C Calendar → Todoist proof gates

This is an **independently reviewable, read-only** Phase C increment. The
production Calendar-owned translator still uses its existing proven
weekly/monthly/yearly subset, finite-weekly logic and rolling fallback.
Nothing in this PR changes a live mapping, automatic migration,
`recurrenceOwner`, a Calendar master, a Todoist task, or completion progress.

## Candidate matrix (Calendar → Todoist)

| Calendar source | Candidate Todoist due string | Decision without provider evidence |
| --- | --- | --- |
| `RRULE:FREQ=WEEKLY;BYDAY=MO,FR` | `every mon, fri` | `rolling_required` |
| `RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27` | `every 2, 15, 27` | `rolling_required` |
| `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR` | `every other fri` | `rolling_required` |
| `RRULE:FREQ=MONTHLY;INTERVAL=2` | `every 2 months` | `rolling_required` |

For timed Calendar series, the candidate includes the Calendar-local clock
(e.g. `at 9:00am`); the verifier also accepts a normalized 24-hour clock,
but never assumes the runner's timezone. Native classification still requires
an independently established DTSTART and the same IANA timezone on both
providers. The original DTSTART must itself be an occurrence of the
schedule, and alternating weeks are phase-locked to that date.

The candidate and verifier are in `src/calendar-todoist-phase-c.ts`.
`calendarPhaseCCandidate()` **never returns `native_exact`**.
`verifyCalendarPhaseCReadback()` can report `native_exact` only as a
read-only observation when all its supplied evidence meets its gates:

1. An explicit Calendar-owned mapping links exactly the Calendar master, the
   Todoist task ID and the intended project; title/date matching is forbidden.
2. A fresh, confirmed Calendar master has an ETag, an unchanged canonical
   RRULE/DTSTART, and is not a Todoist-owned projection.
3. A *complete* independent exception inventory is empty; the minimum three
   successive instance readbacks are unmodified, correctly linked, and
   preserve originalStartTime, local clock and timezone.
4. Todoist readback confirms one recurring task, a supported normalized due
   string, and successive before/after completion dues in the same anchored
   recurrence. No second completion or duplicate task is inferred.
5. Timed rules have independently verified timezone alignment.

These checks are pure functions. The caller must additionally prove that
the before/after snapshots bracketed a **real provider completion**, that
the original anchor is authoritative, and that both inventories are fresh.
A positive synthetic test is **not** evidence of actual Todoist provider
behaviour. It does **not** authorize a production write.

## Unsupported and high-risk conditions

Finite `COUNT`/`UNTIL`, completion-relative `every!`, Calendar
`EXDATE`/`RDATE`, cancellations, moved or modified instances, compound
RRULEs, unknown/duplicate components and missing timezones remain excluded.
A multi-day rule whose DTSTART is outside its BYDAY/BYMONTHDAY cadence is
also rejected. Month-day 29/30/31 skips nonexistent dates; any Todoist
end-of-month rescheduling must be independently observed and rejected if
it differs. Any mismatch retains the existing rolling/manual-review path.

## Tests and next gates

`test/calendar-todoist-phase-c.test.mjs` covers the four families and
negative cases: cross-task/project/owner mismatches, altered master,
exception inventory, gaps in Calendar instance sequence, wrong completion
advancement, London BST drift, 12/24-hour normalization and month-end
skips. These are **synthetic unit fixtures**, not live provider acceptance.

Before a future opt-in Phase C writer may be enabled:

- Exercise real sandbox Todoist completion and Google Calendar instance
  readbacks (including overdue completion, DST and month-end).
- Verify provider-normalized phrases and exact next-due semantics; adjust
  the candidate whitelist only for demonstrated equivalences.
- Add guarded, idempotent write/readback, rollback/quarantine and replay
  tests, respecting historical series and existing Calendar-owned progress.
- Obtain explicit rollout approval; do not silently migrate production
  rolling mirrors.

Provider reference:
[Todoist recurring dates](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV) ·
[Google Calendar recurrence](https://developers.google.com/workspace/calendar/api/concepts/events-calendars) ·
[RFC 5545](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10).
