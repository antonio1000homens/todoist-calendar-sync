# Phase B sandbox capture: evidence before native conversion (#290)

This operator-only tool collects **actual provider observations** for the Phase B
Todoist → Google Calendar recurrence families. It does not create, complete,
update or delete *any* Todoist task or Google Calendar event. It does not run
inside the synchronizer or in the production deployment.

## Isolation prerequisites

Use a **dedicated Todoist test project** and **dedicated Google test calendar**,
both different from all three configured sync profiles (`home`, `antonio`,
`work`). These two sandbox assets must not be monitored by the production
synchronizer. The command refuses to start without the exact managed profile
IDs in `SYNC_PROFILE_CONFIG_JSON`, and rejects matching Calendar or project
IDs. The extra acknowledgement value only reduces accidental use; it does not
prove isolation from unlisted accounts or unknown automations.

Set these environment variables locally, from a secure secret manager; never
commit or include credentials in the capture manifest:

- `PHASE_B_SANDBOX_TODOIST_TOKEN`: sandbox Todoist token
- `PHASE_B_SANDBOX_GOOGLE_CREDENTIALS_JSON`: sandbox Google Calendar OAuth or service account credentials JSON
- `PHASE_B_SANDBOX_CALENDAR_ID`: sandbox calendar ID
- `PHASE_B_SANDBOX_PROJECT_ID`: sandbox Todoist project ID
- `SYNC_PROFILE_CONFIG_JSON`: existing three profile ID mappings (needed for overlap checks)
- `PHASE_B_SANDBOX_CONFIRM=isolated-test-assets`: explicit operator acknowledgement

Before capture, prepare a *real*, independently created Todoist recurring task
in the sandbox project and a matching recurring Google Calendar master in the
sandbox calendar. This is a **separate manual test setup**, not performed by
this command. The Google master must be confirmed, have an ETag, a matching
RRULE/DTSTART and the following shared extended properties:

- `taskId`: exact test task ID
- `syncRecurrenceOwner`: `todoist`
- `todoistRecurrence`: the Todoist due string before completion, lowercase
- `todoistAnchorStart`: the original Calendar DTSTART (exact same text used in `--anchor-start`)

Do not reuse a real mapped task, master or project. Verify the original DTSTART
against the **actual fixture creation log**; today's due date does not prove
the original anchor. A manually entered `--anchor-note` records the claimed
provenance, but does not independently authenticate it.

## Three-step operator flow

1. Capture **before** the first test completion:

   ```bash
   npm run recur:phase-b:sandbox -- before \
     --file /secure/local/phase-b-evidence.json \
     --task-id TEST_TASK_ID \
     --master-id TEST_CALENDAR_MASTER_ID \
     --anchor-start 2027-01-02 \
     --anchor-note "Verified from isolated fixture creation record"
   ```

   For a timed recurrence add `--time-zone Europe/London` and supply the
   original RFC3339 timestamp as the anchor. The tool refuses to overwrite
   an existing manifest. The manifest stores only IDs, minimal due data,
   capture time and the anchor note—never API tokens or task descriptions.

2. In the **Todoist sandbox UI**, manually complete that test task **once**.
   Then capture **after** Todoist has advanced the same recurring task:

   ```bash
   npm run recur:phase-b:sandbox -- after \
     --file /secure/local/phase-b-evidence.json
   ```

   This is read-only; it will not complete the task. An unchanged due, a
   moved/deleted task, a changed project or repeated after-capture is rejected.
   It stores an additional minimal provider snapshot. Manually confirm the
   action was a completion, not an unrelated due-date edit; two HTTP GETs
   alone cannot establish that provenance.

3. Validate with independent Todoist GET, Calendar master and task link GET,
   explicit exception inventory, bounded instance GET, and Calendar timezone
   readback where applicable:

   ```bash
   npm run recur:phase-b:sandbox -- verify \
     --file /secure/local/phase-b-evidence.json
   ```

   A result of `native_exact` is **diagnostic only** and always includes
   `productionWriteAuthorized: false`. Real month-end, overdue completion,
   alternate-week phase, GMT/BST, task normalization and retries must all be
   exercised with separate isolated fixtures. Results of `rolling_required`
   or provider errors must not be promoted. The test event is left untouched
   for separate explicit operator cleanup, never deleted automatically.

## Safety, replay and recovery limits

- This CLI is **not called** from scheduled jobs, webhooks, reconciliation,
  migration or deployment.
- Reads do not change Google recurrence ownership or Todoist tasks.
- `before` writes a new local JSON manifest with restrictive permissions;
  `after` updates it atomically; neither writes to DynamoDB.
- Re-running `after` cannot replace previous evidence. Re-running `verify`
  performs read-only checks and declines if Todoist progressed again.
- Provider failures, exceptions, truncated Calendar instances, incomplete
  profile identity or timezone disagreement fail closed.
- Sandbox isolation from unrelated automations remains an operator duty:
  compare IDs and disable external webhooks/agents on test assets.
- **No production native write integration, no automatic recurrence
  promotion and no historical series migration** are in this PR.

Completing Phase B still requires capturing verified provider observations,
agreeing which recurrence families are truly equivalent (including
overdue/month-end rules), then a separately reviewed gated native-write
workflow with duplicate/replay protection and reliable rollback/quarantine.
