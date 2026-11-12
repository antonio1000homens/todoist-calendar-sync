# Nuclear erasure: zero-retention change contract (#349, #347)

This is a design-only change, not an executable erasure or authorization to deploy.

## Required outcome
- Delete exactly selected Todoist and Calendar objects, attributable DynamoDB records, project mapping comments/notes, and app-owned shared Calendar links on retained events.
- No 18-day Todoist project-comment tombstone, permanent replay marker, expiry cleanup, or reconstruction/recovery of deleted relationships.
- No separate user-facing post-deletion verification or confirmation step. Report actual failures; do not claim success after a failed provider action.
- Release temporary operation-owned fences only via guarded completion. Never force-enable mappings or remove an unrelated owner's fence.

## Current blockers before implementation/deployment
- `src/erasure-deletion.ts` requires active tombstones during receipt scrub and successful completion.
- `src/erasure-replay-providers.ts` uses those tombstones to reject delayed writes.
- `src/erasure-replay-barrier.ts` documents the retired HMAC alternative; it is not an available replacement.
- Historical qualified Lambda versions, SQS redrive, webhook/Function URL and direct invocation must not recreate deleted identity once no identifier remains.

Removing tombstones alone would permit stale-message resurrection. Implement an enforceable marker-free admission boundary for every actually invokable writer path first, then remove marker creation/retention/cleanup and update deletion and fault tests. Keep the erasure execution gate and current fences unchanged until the independent #347 security release conditions are met.

This document records the user-requested contract without modifying production or weakening existing controls.
