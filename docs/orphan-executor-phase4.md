# Issue #287 — guarded orphan executor, phase 4

This phase introduces a **non-routed** execution core in
`src/orphan-deletion-executor.ts`, exercised by
`test/orphan-deletion-executor.test.mjs`.

**Not production-ready:** The core has no API route, production proof reader,
worker queue handler or deployment flag. No provider DELETE can be initiated
from the review UI. The existing global erasure path remains separately
disabled/default-deny. Keep issue #287 open.

## What the implementation actually enforces

The only deletion target is a durable tuple: case ID, exact profile, side,
provider ID, provider digest, Calendar ETag when applicable, operator
identity and immutable case version. The journal uses conditional DynamoDB
phase/version updates, and an operation cannot change target midway.

The required trusted proof reports direct, fresh provider evidence and
independent clear/absent checks for the exact target, recorded counterparts,
full provider enumeration, reverse links, cross-profile mapping indexes,
canonical records, recurrence ownership, retained completed history, mapping
comments, controls and competing repair/erasure operations. It is **not**
accepted from the browser. Any missing or failed check blocks execution.

The bounded state machine advances **one durable phase per worker message**:

1. `confirmed` -> `fenced`: check short-lived confirmation and current
   proof, drain workers and verify exclusive profile fence.
2. `fenced` -> `delete_started`: check proof and target version again,
   install a durable replay barrier, persist deletion intent **before** any
   provider write.
3. `delete_started` -> `provider_absent`: execute **one side only**
   (Todoist or Calendar with ETag), then read the exact provider object back.
   A retry after an ambiguous successful DELETE does not issue another
   DELETE when direct readback proves the object absent.
4. `provider_absent` -> `state_cleaned`: execute only exact conditional
   attributable cleanup, then prove no target, dangling mapping or
   unexpected counterpart remains.
5. `state_cleaned` -> `workers_resume_started`: persist resume intent
   before releasing the exclusive worker fence. The replay barrier remains.
6. `workers_resume_started` -> `observing`: resume workers idempotently
   while keeping the replay barrier.
7. `observing` -> `succeeded`: require two separate completed full
   reconciliations and both Todoist/Calendar replay checks; verify
   postflight again and only then conditionally retire the selected case
   as `orphan_removed`.

An ambiguous partial failure leaves a recovery journal and the remaining
fence/barrier in place, not an invented success. Code paths for a
`needs_review` terminal state preserve operator evidence.

## Preliminary authoritative read-only inventory

This branch also adds `src/orphan-proof-reader.ts` and
`test/orphan-proof-reader.test.mjs`. It fetches the selected alert's direct
provider identities, fully enumerates Todoist project tasks and Google Calendar
events for all three profiles, inventories project/task comments, and performs a
bounded, strongly consistent multi-page DynamoDB read. It then evaluates the
complete set of required proof conditions. Partial paging, failed APIs,
timeouts and scan budget overruns throw rather than suggesting absence.

The reader is **not yet wired** into the execution worker and its strong scan
is not a transactional snapshot across pages. Therefore the worker must repeat
the proof **after** its global drain/profile fence has been verified. Stale
mapping or historical records currently block execution; they need a
separately reviewed conditional cleanup plan, never a generic purge.

## Required integration before enabling deletion

- Wire and harden the preliminary read-only proof reader as the trusted worker
  proof callback; validate performance, complete canonical/reverse references,
  and read again under the durable fence. Never treat 404 alone as absence.
- Wire immutable case-bound preview, expiry and typed confirmation to the
  journal. Only a verified, signed-in review operator can issue it. The
  current manual two-ID erasure endpoint must remain disabled.
- Build trusted erasure-worker adapters that disable/drain worker event-source
  mappings, verify the profile fence, perform exact Todoist/Calendar DELETE,
  and checkpoint provider readback and conditional DynamoDB cleanup.
- Persist replay suppression that sync, webhook handlers and reconciliation
  actually consult before accepting stale/replayed events; test across worker
  restarts, retries and queue redelivery.
- Implement reconciliation acceptance with two completed generation IDs and
  replay evidence, then conditional `orphan_removed` case retirement with
  all attributable audit pointers and unrelated history protected.
- Run destructive E2E tests with disposable Todoist/Calendar objects, and
  test partial state-cleanup failures and recovery under live fences.
- Only after acceptance may deployment set
  `ORPHAN_DELETION_EXECUTION_ENABLED=true`. The executor additionally
  requires `ERASURE_PROTOCOL_VERSION=1`. Both checks are evaluated at
  **execution time** so an old queued approval cannot bypass a revoked gate.

This is an incremental implementation and must not be merged or described as
a fully delivered deletion feature.
