# Issue #307 fault-injection evidence

This matrix maps the issue's requested failures to current automated tests. It
records source-level test coverage; the separate normal-sync smoke test below
is not post-write recovery staging, production release evidence, or
authorization to run deletion/recovery.

| Requested fault | Current automated evidence | Status and limit |
| --- | --- | --- |
| SQS replay and stale webhook | `test/erasure-replay-ingress.test.mjs`; `test/erasure-worker.test.mjs`; `test/erasure-protocol.test.mjs` | Covered at source level for delayed/duplicate delivery and suppression before queue side effects. Live queue/DLQ replay remains untested. |
| Todoist 404/429/5xx | `test/erasure-cross-profile-evidence.test.mjs`; `test/erasure-preview.test.mjs` | Covered as ambiguous or fail-closed reads. A provider 404 is not treated as proof of absence. |
| Calendar 410 and ETag drift | `test/erasure-cross-profile-evidence.test.mjs`; `test/erasure-deletion.test.mjs` | Covered for ambiguous 410 responses and changed event snapshots before deletion. |
| Missing or repeated scan page | `test/erasure-cross-profile-evidence.test.mjs`; `test/erasure-protocol.test.mjs`; `test/erasure-lambda-inventory.test.mjs` | Covered for pagination loops, incomplete reads and denied Lambda policy reads. |
| Token replay, expiry or stale evidence | `test/erasure-executor.test.mjs`; `test/erasure-recovery.test.mjs` | Covered for single-use confirmation, expiry and action-time state drift. |
| Lost commit acknowledgement | `test/erasure-protocol.test.mjs` | Mapping-update acknowledgement loss is covered and retried with readback. **The future post-write marker/fence transaction has no executor, so a lost DynamoDB commit acknowledgement for that transaction is not injectable yet.** |
| Marker race | `test/erasure-replay-ingress.test.mjs` | Covered for a marker installed between webhook admission and leased enqueue. |
| Stale/missing leases and fence changes | `test/erasure-protocol.test.mjs`; `test/erasure-executor.test.mjs`; `test/erasure-recovery.test.mjs` | Covered for concurrent fence, active lease, ownership and drain changes. |
| Cross-profile move | `test/erasure-cross-profile-evidence.test.mjs`; `test/erasure-replay-alias-observation.test.mjs` | Read-only identity following and profile-scoped aliases are covered. A live moved Work-profile item has not been staged. |
| Replay-key rotation | `test/erasure-replay-barrier.test.mjs` | Current and historical verification keys are covered in unit tests. Production key retention approval remains outstanding. |
| Qualified Lambda versions | `test/erasure-lambda-inventory.test.mjs`; read-only Windsor IAM simulation report | Inventory and IAM policy simulation cover the current standard qualifiers. Historical bundle admission has not been proven by source tests; live identity paths still need separate review and approved retirement/denial. |
| Transitional mapping states | `test/erasure-recovery.test.mjs`; `test/erasure-executor.test.mjs` | Reconciliation of original enabled/disabled mappings before fence release is covered at source level. |

The missing post-write executor is intentional while the earlier issue gates
remain open. Do not treat this matrix as acceptance of that executor. Keep
`ERASURE_REPLAY_BARRIER_VERSION` off and preserve all active fences until the
independent writer/IAM review, security approvals and disposable Work-profile
staging evidence are complete.

## Work-profile normal-sync smoke test (4 Nov 2026)

Using the connected Todoist and Google Calendar apps, a clearly labeled
disposable event was created in the Work calendar. Exactly one matching task
appeared in the Work Todoist project. Changing that task's title updated the
same Calendar event. Cancelling the event then returned it as cancelled, and a
fresh Todoist search found no active task with the fixture prefix. The fixture
did not include other guests.

This confirms the ordinary Work-profile create, update and delete sync path via
the providers. It does not exercise post-write recovery, replay-barrier
admission, marker installation, fence release, SQS mapping restoration, a
strong DynamoDB absence proof, or a full fresh reconciliation. No unrelated
provider inventory or DLQ state was collected, so those acceptance checks
remain open. The provider IDs and title are intentionally omitted from this
public report.

## Connector-created staging fixture and bounded-capture failure (4 Nov 2026)

A fresh private event was created through the Google Calendar connector in the
Work calendar. The normal sync asynchronously created exactly one matching
task in the Work Todoist project. A direct event read showed this fixture was a
single, non-recurring event. The paired task and event were clearly labeled as
disposable #307 fixtures; the redundant task created before the asynchronous
sync result was observed was removed through Todoist.

The read-only all-profile preview was then run against the exact pair. It
failed closed while expanding a discovered Calendar alias with
`CALENDAR_RECURRENCE_ALIAS_LIMIT_OTHER_MASTER`: the oversized master was not
the selected event ID. The report deliberately does not disclose the master
ID or establish its relationship to the selected task beyond its presence in
the discovered identity closure. The fixture itself is non-recurring, but the
closure remains incomplete. No provider deletion, executor, marker, fence
release, queue action or AWS mutation occurred. The fixture remains staged for
follow-up; this attempt provides no post-write recovery evidence.

## Connector-only cross-profile fixture probe (4 Nov 2026)

The configured calendar and Todoist project identifiers were read from the
deployed routing configuration and matched the resources visible to the
connected provider account. A new disposable event on the configured Work
calendar produced one task in the Work project and none in the `home` or
`antonio` projects. Calendar search and direct read returned the same event ID
through both the Work and `antonio` calendar resources, but not through `home`.
The Antonio-calendar read identified the Work calendar as organizer and the
connected account owner as attendee. This is an observed cross-calendar alias
case; it does not prove that each deployed profile credential has the same
visibility as the connected account.

Strongly consistent reads of the exact task, event and task-owner mapping keys
found only the Work mapping. After deleting the disposable Calendar event,
fresh searches returned no matching event across the three calendars or task
across the three projects, and strongly consistent reads found none of those
exact mapping keys. The fixture was removed. These bounded reads do not replace
the complete related-row scan, comment/recurrence provenance, or fresh full
reconciliation required before recovery. The probe did not stage post-write
recovery, markers, mapping restoration, fences, or SQS replay.

### Connector staging replay (4 Nov 2026)

A further clearly labeled private event was created with the Google Calendar
connector in the `work1000homens` calendar. The first immediate Todoist search
returned no match; a matching task then appeared asynchronously in the
`work1000homens` project. A separate manual Todoist create happened before that
delayed result was observed and produced a duplicate, so both tasks and the
event were deleted through their connectors. Follow-up Todoist searches and a
bounded Work-calendar search returned no fixture. This confirms the ordinary
Work event-to-task creation path is asynchronous and the connectors can clean
up the fixture. It is not post-write erasure, a full-reconciliation result, or
evidence that an erased item cannot be recreated.

### Fresh cross-profile observation and cancellation check (4 Nov 2026)

A new private Work-calendar event asynchronously produced one task in the Work
Todoist project. Before deletion, the read-only Windsor capture queried all
three configured profiles and strongly scanned every DynamoDB page (4,825
rows). Work and Antonio credentials both found the exact task, event and one
related project comment; Home's complete observed inventories had no matching
task, event or comment. No recurrence alias or tagged-event match was found.
The report's bounded identity walk completed, but accessible-calendar coverage
was not proven.

After deleting the event with the Calendar connector, a fresh capture again
read every DynamoDB page (4,828 rows). Todoist direct reads and complete task
inventories found no task in any profile, and project/task-comment inventories
found no related comment. However, the connector's direct Work-calendar read
returned the event as `cancelled`, and the deployed Work and Antonio profiles'
full event inventories still matched it. Therefore
`knownIdentitiesAbsentFromCurrentProviders=false` and
`eligibleForPostWriteRelease=false`; 404s in Home do not override the positive
cancelled-event observations. The post-delete preview retained 179 blockers,
including 169 unattributable delivery records (27 Calendar, 140 reconcile, 1
manual, 1 repair). Four of those records were past TTL expiry but still
visible, consistent with asynchronous DynamoDB TTL deletion. No recovery
executor, marker install, fence release, or SQS replay was exercised.

### Two-occurrence recurrence alias probe (4 Nov 2026)

A private Work-calendar event with `RRULE:FREQ=DAILY;COUNT=2` asynchronously
produced one Work Todoist task. The live cross-profile observer found the
Calendar master and both occurrences through both Work and Antonio credentials
(three event IDs per profile); Home had no matching items. The strong state
scan included one recurrence row. The Todoist task itself reported
`is_recurring=false`, so this probe proves discovery of the Calendar recurrence
aliases but not a recurring Todoist mirror or complete release manifest.
Accessible-calendar coverage remained unproven.

After deleting the Calendar master, the task disappeared from all three
Todoist profiles. The Calendar connector returned the master as `cancelled`,
and the deployed Work and Antonio inventories still matched the master and two
occurrences. A fresh strong scan received all pages (4,839 rows); the preview
kept `knownIdentitiesAbsentFromCurrentProviders=false`, with 182 blockers,
including 169 unattributable delivery records. No post-write transaction or
fence release ran. The fixture was deleted through the provider connector; its
cancelled Calendar records remain observable and must not be treated as proof
of absence.

The observer now reports redacted cancelled-event counters separately from
404/410 reads. A fresh post-delete run at 13:31 UTC confirmed three cancelled
direct reads and three cancelled inventory matches in each of Work and
Antonio, comprising the master and two instances. Home had no matches. The
strong scan received all pages (4,833 rows, 9 related rows); the preview still
had 178 blockers and 165 unattributable delivery records (25 Calendar, 138
reconcile, 1 manual, 1 repair). Four receipt rows previously observed past TTL
expiry were no longer counted as expired, consistent with asynchronous TTL
cleanup. `knownIdentitiesAbsentFromCurrentProviders` and
`eligibleForPostWriteRelease` remained false.

## Deployed-credential cross-profile capture

`scripts/audit-erasure-cross-profile-live.mjs` runs the repository's full
read-only erasure preview against one exact disposable (or already-erased)
Work task/event identity. It verifies `AWS_PROFILE=windsor` resolves to account
`243857182133`, reads the selected Lambda's routing configuration, then reads
DynamoDB state and all-profile Todoist/Calendar inventories using the deployed
profile routing and Windsor-backed SSM parameters. Provider clients are
projected to an explicit read-method allowlist before they reach the preview.

Example invocation (replace both IDs with the exact fixture IDs from its
creation record):

```sh
npm run build --silent
node scripts/audit-erasure-cross-profile-live.mjs \
  --profile=windsor \
  --expected-account=243857182133 \
  --region=eu-west-2 \
  --function=todoist-calendar-sync-worker-production \
  --qualifier='$LATEST' \
  --task-id='<disposable-task-id>' \
  --event-id='<disposable-event-id>'
```

The report is redacted and always exits with status 2 because this capture is
not release-authoritative and cannot issue an erasure confirmation. A complete
read only proves the observed provider/state evidence for those exact IDs; it
does not authorize enabling the replay barrier or executable recovery. No AWS
or provider mutation is performed.

### Windsor read-only capture (4 Nov 2026)

The capture used the disposable Work task/event created through the connected
Todoist and Google Calendar tools. The script verified Windsor account
`243857182133`; the strongly consistent scan received all pages (4,749 rows
before connector cleanup, 4,748 after) and queried all three deployed profiles.
While the fixture was active, the same Todoist task was found through Work and
Antonio profile credentials, with one related project comment in each; Home
had no task match. The selected Calendar event was found only through Work.
This confirms a cross-profile Todoist identity alias in deployed credentials.

After connector deletion, title searches returned no task in the three
configured Todoist projects or event in the three configured calendars. Exact
provider reads then returned Todoist 404s in all profiles, but the Work Calendar
read returned the exact event as `cancelled`; the all-events inventory still
matched it. The eight identity-related state rows remained in the post-cleanup
scan. Accordingly the report kept `knownIdentitiesAbsentFromCurrentProviders`
false and `eligibleForPostWriteRelease` false. Calendar 404/410 ambiguity,
cancelled-event handling, unlisted-calendar provenance, transaction-snapshot
gaps, independent writer/IAM review, action-time ETag checks, and full fresh
reconciliation remain unresolved. Neither `ERASURE_REPLAY_BARRIER_VERSION`
nor executable recovery was enabled, and the AWS reads made no mutations.

The redacted item-preview summary classified 178 `DELIVERY` receipts for the
Work profile: 174 were `unattributable` because they lack exact task/event
references, and four contained a selected identity. These identity-free legacy
receipts must remain blockers until their queue/replay provenance is resolved;
the audit does not delete or infer ownership for them. The live preview has
178 blockers overall, so the current Work profile cannot pass the item-level
cleanup gate even after provider deletion.

### Point-in-time queue attributes

A read-only `GetQueueAttributes` call against the source and DLQ URLs configured
on the production worker found both queues are FIFO. The source queue reported
zero approximate available, in-flight and delayed messages, with four-day
retention and a redrive policy. The DLQ reported zero approximate messages,
with fourteen-day retention and no further redrive policy. The worker mapping
remained enabled; these approximate point-in-time values do not
prove either queue is drained. AWS documents that FIFO message age resets when
a message moves to a DLQ, so queue retention and the fourteen-day delivery
receipt TTL are not by themselves replay-absence evidence ([DLQ retention
semantics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/setting-up-dead-letter-queue-retention.html),
[queue count consistency](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueAttributes.html)).
No message bodies were read and no queue attributes were changed.

The integrated redacted receipt audit observed 740 completed Work delivery
receipts. Of these, 174 had no identity-reference arrays: 30 Calendar, 142
reconciliation, one manual and one repair receipt. The full scan completed at
`2026-11-04T12:58:12Z`. At that time, five
were past `expiresAt` (three Calendar and two reconciliation) but still present
in the strong scan; the remaining 169 were all due to expire within seven
days, with 29 due within one day. The preview therefore still counts all 174
as unattributable. DynamoDB TTL expiration does not itself remove an item from
reads immediately; deletion is asynchronous and expired items remain visible
until the background deletion occurs ([TTL behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)).
Re-run the exact audit after TTL deletion, and continue to require queue/DLQ
replay evidence before allowing recovery.
