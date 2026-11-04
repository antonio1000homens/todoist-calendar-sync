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
