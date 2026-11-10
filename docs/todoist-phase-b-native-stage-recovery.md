# Phase B interrupted native cross-calendar move: exact-stage recovery (#389)

PR #451 wired the guarded provider cutover. Its two-profile DynamoDB stage and four identity-specific sync controls remain intentionally active if execution fails after the initial claim. Ordinary webhooks **cannot** resume, discard, roll back, or bypass that stage.

## Recovery contract

`inspectInterruptedPhaseBNativeMove()` is **read-only**, including when the ordinary Phase B creation flag is OFF. The caller must identify the exact task ID, source and destination profiles, and the immutable `operationId` from the persisted `PHASE_B_NATIVE_MOVE#<taskId>` stage. A mere recurring-task identifier or project change is never sufficient.

The inspector independently confirms:
- The immutable stage and **all four** operation-owned sync controls are present and none excluded; source owner, mapping and recurrence-link revisions remain unchanged; no erasure/tombstone conflict.
- Todoist GET still proves the managed destination project and exact current due; calendar and Todoist IANA timezones agree.
- Source master is **history-only**, with the stage's exact inclusive UNTIL cap, original DTSTART, task lineage, a changed ETag and no remaining task-owner alias. The **complete** historical instance inventory is exact and no future source instances or explicit exceptions remain.
- Destination is the exact deterministic staged master with task ownership/lineage, matching RRULE, anchor and task metadata; the next three independently expanded occurrences match the source recurrence's continuation, and there are no explicit exceptions.
- The original project mapping comment is absent, the destination project has exactly one verified corresponding comment, and there are no malformed or competing task breadcrumbs.
- Stage/controls, both master ETags and live Todoist task still match after inspection.

The result is `ready_to_commit` **only after provider writes and project-comment handoff are already complete**. All other outcomes are `quarantined` with a reason, and **no** state or provider mutations.

`completeVerifiedPhaseBNativeMoveStage()` is deliberately **not wired** to Lambda, webhook/reconciliation, review UI, or scheduled retries. It requires a caller-supplied exact `operationId`, explicit per-process `TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED=true`, and independently acquired writer leases for **both** profiles under erasure protocol v1. It inspects twice immediately before the conditional DynamoDB transaction; the transaction exclusively moves the owner/mapping/recurrence indexes and releases all four controls atomically. It **never** writes Calendar or Todoist provider data.

A failed conditional commit or any incomplete/ambiguous provider state leaves the stage and controls held for independent operator review. No source-master rewind, destination delete, comment retry, partial lock release, or historical rolling-series migration is permitted.

## Operational limitations

- This is a safe **final-handoff-only** recovery, not a generic staged provider replay. A stage interrupted during destination creation, source cap, instance verification or comment transfer still needs a separate explicitly reviewed provider-write recovery plan; absence of response is not evidence of failure.
- Do not enable the ordinary `PhaseBNativeEnabled` production switch or the recovery approval variable globally; retain the existing source SQS erasure fence under #349/#433.
- Do not run on live data without a reviewed exact identity and independent provider captures. This PR only delivers the guarded implementation and isolated fault-injection tests; no disposable 2027 managed-provider E2E is claimed.
- Production activation requires resolving #349's pre-write recovery, live fixture evidence and an independently reviewed rollout/rollback plan.
