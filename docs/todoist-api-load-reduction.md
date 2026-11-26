# Todoist API load reduction

Normal sync and reconciliation runs now share an operation-scoped Todoist
inventory. A complete, recent `/sync` snapshot supplies tasks, task comments,
project comments, projects, and user timezone to all clients using the same
credential in that operation. Snapshot validation is bounded by response size,
resource counts, age, and exact project references. Unsupported, stale, or
incomplete snapshots fall back to paginated REST inventories; rate limits and
unavailable providers fail closed. Successful writes update or invalidate the
operation cache so later lookups see the write-through result.

Todoist request pacing covers REST and Sync endpoints. A 429 establishes a
credential-scoped cooldown in the existing state table. Workers check it before
provider processing and defer the original FIFO message until the cooldown
expires. Long hints are split into visibility periods because SQS limits each
visibility timeout to 12 hours; the durable check re-defers the message when a
cooldown exceeds one period. Cooldown retries do not consume the ordinary
application retry ceiling. Other profiles retain independent FIFO groups.

Provider request logs report endpoint class, read/write, status, retry number,
rate-limit state, whether a request was sent, and a truncated hash of the
credential identity. They contain no provider task or comment content.

## Batching decision

No write batching was added. The current request reduction comes from sharing
read inventories and avoiding repeated reads, while preserving each existing
write boundary and its failure semantics. We do not yet have production
before/after request counts to show that batching would reduce total requests
enough to justify changing write ordering, partial-failure handling, and retry
behavior. The structured request events provide the measurements needed to
revisit batching after rollout and observation.

Scheduled reconciliation remains disabled until acceptance checks are complete.
This change does not run a mass cleanup or migration.
