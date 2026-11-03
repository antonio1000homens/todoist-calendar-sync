# Recurrence compatibility contract (#290, PR A)

This is a **read-only semantic classifier**. It does not change the live Todoist
or Calendar translators, recurrence owner, mapping identity, webhook handling,
completion progression, exception handling, or deployment policy. A syntactically
parseable rule is **not** proof that two provider APIs behave identically.

## Classification

- `native_exact`: canonical rule, independently verified original DTSTART
  phase, Calendar master and instance readback, Todoist normalized due string,
  at least one completion progression, and complete explicit Calendar exception
  inventory are all evidenced. Timed rules additionally require independently
  proven `timeZoneVerified` from provider readback: specifying an IANA name
  alone never authorizes promotion. The caller must furnish all five standard
  evidence fields plus the sixth timezone field for timed recurrence; the
  classifier cannot obtain provider evidence from a string alone.
- `rolling_required`: recognizable recurrence, but some provider evidence is
  absent or a known exclusion (completion-relative `every!`, finite endpoints,
  Calendar overrides) requires the existing owner-aware rolling/repair path.
- `unsupported`: malformed or ambiguous input, duplicate/unknown components,
  invalid civil time, unsupported sub-minute precision or timed UTC `UNTIL`
  (which requires an instant-aware expander), or an unsupported Todoist phrase.

An `RRULE` with reordered fields, omitted `INTERVAL=1`, or reordered weekday
and month-day sets has one canonical form. The canonical form is descriptive,
**not** a provider approval. Comparison checks bounded date sequences, local
wall-time, IANA timezone and termination fields, never raw rule strings.

## Candidate matrix (no production enablement in PR A)

| Source | Example | Canonical pattern | Decision before external readback |
|---|---|---|---|
| Todoist | `every 2, 15, 27` | `FREQ=MONTHLY;BYMONTHDAY=2,15,27` | rolling_required |
| Calendar | `FREQ=MONTHLY;BYMONTHDAY=2,15,27` | same | rolling_required |
| Todoist | `every mon, fri` | `FREQ=WEEKLY;BYDAY=MO,FR` | rolling_required |
| Calendar | `FREQ=WEEKLY;BYDAY=MO,FR` | same | rolling_required |
| Todoist | `every other Friday` | `FREQ=WEEKLY;INTERVAL=2;BYDAY=FR` | rolling_required; first Friday phase must be proven |
| Calendar | `FREQ=WEEKLY;INTERVAL=2;BYDAY=FR` | same | rolling_required; Todoist progression must be proven |
| Todoist | `every quarter` / `quarterly` | `FREQ=MONTHLY;INTERVAL=3` | rolling_required; missing months and overdue progression require proof |
| Calendar | `FREQ=MONTHLY;INTERVAL=2` | same | rolling_required; new Todoist text/readback required |
| Either | `COUNT`, `UNTIL`, `starting`/`ending` | finite | rolling_required; no silent indefinite conversion |
| Todoist | `every! 2 days` | completion-relative | rolling_required; no fixed Calendar RRULE equivalent |
| Calendar | `RDATE`, `EXDATE`, moved or cancelled instances | exception | rolling_required; do not discard exceptions |
| Either | `every last workday`, mixed/compound ordinals | advanced | unsupported / rolling_required; needs independent proof |

The semantic expander models civil Gregorian dates and fixed local clock times.
Monthly 29/30/31 and February 29 **skip nonexistent dates**. Weekly two-week
phase derives from independently verified DTSTART, not the current clock.
The occurrence horizon scales with the requested number of dates and interval,
with a fixed 160-year safety cap; an incomplete window never proves equality.
Date-only `UNTIL` remains finite/rolling, while timed UTC `UNTIL` is
explicitly rejected rather than treated as a date-only cutoff. A
bounded comparison is only one part of verification; it does not prove unknown
future provider normalization or exceptions. For timed occurrences, readback
must verify identical local wall time and timezone across BST/DST.

## Follow-up implementation gates

1. PR B: add Todoist→Calendar candidates using this classifier; only enable a
   family with actual Todoist sequence + completion readback, persisted Calendar
   master + instances, duplicate/replay protection and failure fallback.
2. PR C: add Calendar→Todoist candidates with Todoist due string normalization,
   timezone equality, current and post-completion due checks, complete exception
   inventory and idempotent reconciliation.
3. PR D: separately validate finite and advanced cases; do not drop end bounds.
4. PR E: opt-in migration *preview only* until identity, rollback and recovery
   have independent acceptance. No automatic migration of existing mappings.

Existing `recurrenceOwner`, `RecurrenceLink.owner`,
`calendarProgressVersion`, `completedThroughOriginalStart`, original
recurrence masters, cancellation semantics, and profile boundaries stay intact.

Provider documentation:
- [Todoist recurring dates](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV)
- [Google Calendar events and recurrence](https://developers.google.com/workspace/calendar/api/concepts/events-calendars)
- [RFC 5545 recurrence rules](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10)
