# #378 — Cancelled-mapping recovery policy and evidence contract

This policy is **not** a blanket conflict cleanup or a force-unlock. The existing
#372 dispatch only permits an exact same-profile Todoist upsert to reach the
guarded synchronizer. No provider or DynamoDB write is authorized by dispatch.

## Conflict classification

| Provider intent / state | Recovery disposition |
| --- | --- |
| Cancelled **standalone** Calendar event + explicitly newer one-off Todoist due or metadata edit | Candidate: standalone, with direct cancelled Calendar revision proof |
| Cancelled standalone + explicitly newer supported Todoist weekly recurrence | Candidate: native Google weekly RRULE |
| Cancelled standalone + explicitly newer supported Todoist monthly recurrence | Candidate: native Google monthly RRULE |
| Cancelled standalone + explicitly newer supported Todoist yearly recurrence | Candidate: native Google yearly RRULE |
| Calendar deletion after the Todoist update, or unchanged/stale Todoist webhook replay | **Denied**: `CANCELLED_PROVIDER_NEWER` / `SOURCE_UNCHANGED` / `STALE_SOURCE_VERSION` |
| Original mapped task missing, deleted or completed (within or beyond seven days) | **Denied**: no active Todoist source; protect historical completion evidence |
| Existing recurrence master, instance, cancellation exception or Calendar-owned series | **Denied**: never silently change recurrence owner, series history or exception |
| Cross-profile move or another profile's task-linked Calendar alias (including cancelled) | **Denied**: ambiguous ownership; manual review |
| Multiple live aliases with same exact shared task ID | **Denied**: no title/date matching or arbitrary selection |
| Failed-after-write, running, queued, non-resumable, or unknown repair checkpoint | **Denied**: resumable/blocked; no inferred no-write |
| Pending erasure/retirement, tombstone, completion receipt, active exclusion or other case | **Denied**: existing fences remain authoritative |
| Operational DLQ after a provider write or of unknown origin | **Denied**; only #376's exact proven non-mutating validation DLQ is conditionally bypassable |

## Preconditions and conditional reset

The synchronizer requires one dismissed failed repair that owns the exact case
and affected task/Calendar refs; `operationHasWriteEvidence` must be false,
with only the completed validation checkpoint. It then verifies:

1. Current source task has a changed, supported projection and a valid
   `updated_at` strictly later than mapping, repair and the `updated` timestamp
   of **every** directly fetched cancelled Calendar identity. Unknown provider
   deletion version is a blocker.
2. Same-profile project, active (uncompleted) Todoist task, and no Calendar
   master, recurrence link, completed history, retirement or replay/erasure fence.
3. All three strongly consistent mapping views, exact review case, controls,
   baseline and exclusion/receipt guards.
4. Every shared-ID linked Calendar alias, including cancelled items, and
   task-linked aliases in other supported profiles for new policies. A cancelled
   old series with a confirmed future exception is not eligible.
5. A fresh direct Todoist read matching the source fingerprint before the
   transaction; a second read occurs just before provider creation.

A single lease-fenced DynamoDB transaction atomically retires only the old
mapping views and baseline, marks **that** failed repair abandoned, releases
exact owned controls (preserving queued refreshes) and stores an
`ANNUAL_RECOVERY#profile#taskId` pending receipt. The historical key name is
retained for rollout/legacy compatibility. New receipts carry policy,
source version, a SHA-256 fingerprint of projection-sensitive Todoist
fields and a deterministic Google Calendar event ID. This ID is derived from the
profile, task, original cancelled event and source version, not from the title.
Old annual receipts remain readable.

## Provider write and retry

After the reset, only cancelled provider aliases are ignored. A retry must
find **zero** or **one** confirmed canonical same-task counterpart. New
receipts require that the counterpart carry the receipt's exact deterministic
Google ID and recovery fingerprint; a direct ID GET handles lag in shared-ID
search. If the provider POST succeeds but its response is lost, retrying the
same client-assigned ID produces a 409, which can only adopt the verified
same-ID, same-fingerprint, confirmed canonical object. It never chooses a
same-title object or sends another distinct POST. Old annual receipts retain
their original compatibility path. Recurring policies require a
matching native RRULE and a valid active instance; standalone must have no
recurrence/instance. Mapping/index acknowledgement is conditional, and the
pending receipt is cleared only after the three mapping views and appropriate
recurrence-link existence (or absence) agree.

No actual Todoist task, cancelled Calendar object, old provider history,
completed projection receipt, durable repair record, permanent erasure fence,
or broad audit/idempotency evidence is deleted to make the projection work.
Only the exact #376 no-write DLQ cases may be dismissed by review CAS after
verified mapping acknowledgement. Unrelated or ambiguous alerts remain open.

## Operational diagnosis

`RecoveryEligibility.reason` is a stable machine-readable preflight code.
Examples: `SOURCE_UNCHANGED`, `CANCELLED_PROVIDER_NEWER`,
`REPAIR_WRITE_EVIDENCE`, `AMBIGUOUS_REPAIR_SNAPSHOT`,
`MAPPING_INDEX_MISMATCH` and `TRANSACTION_RACED`. A denied case must not
be represented as a successful repair; the original review/repair evidence
continues to identify the affected objects.

## Production acceptance (not yet complete)

Do **not** close #378 on unit tests alone. After green CI and synchronized
deployment, use **disposable** task and Calendar objects in each supported
profile, not existing users' records. For representative one-off (all-day and
timed), weekly, monthly and yearly policies:

- Create the task/event pair and verify exact Todoist/Calendar IDs plus all
  three DynamoDB indexes.
- Cancel mapped Calendar projection, dismiss an intentionally validation-only
  repair, and edit the existing Todoist source to a strictly newer revision.
- Verify new canonical confirmed Calendar event/master/active instance, pending
  receipt removal, old tombstone retention and correct mapping indexes.
- Simulate Calendar POST success with lost mapping ACK, stale SQS redelivery
  and concurrent reconciliation. Confirm exactly one new event and zero drift.
- Re-run failed-after-write, cross-profile, ambiguous same-title/shared-ID,
  active erasure, old exception and completed-history (>7-day) negatives.
- Confirm no foreign review cases or DLQs were auto-dismissed and no task was
  deleted in a denied recovery.

Any failed or untested acceptance item keeps the ticket open.
