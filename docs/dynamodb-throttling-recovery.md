# Transient DynamoDB throttling recovery — #256

## Why this change

The AWS SDK already performs up to five standard-retry attempts per
DynamoDB operation. Historically, when those attempts failed, the worker
returned an SQS batch failure and the original production FIFO queue
had `maxReceiveCount: 1`. That sent even a momentary DynamoDB
throttle to the DLQ, where messages expired after one day.

The new policy retries **only verified, pre-provider-mutation transient
DynamoDB failures** with the *original* SQS record in the *original*
`sync:<profile>` FIFO group; it neither appends a new delivery to the
tail of the group nor rewrites the delivery ID or erasure epoch.

## State machine

1. Ingress enqueues an original Todoist or Calendar delivery into
   `sync:<profile>` FIFO. Batch size and worker reserved concurrency
   remain 1. The worker checks the existing `DELIVERY#` receipt,
   erasure epoch and writer lease before provider access.
2. All DynamoDB calls use SDK `maxAttempts: 5` + standard backoff.
   A successful transaction is atomic and processing continues.
3. If **exhausted DynamoDB throttling/service exceptions** escape
   processing and **no provider mutation was observed**, only the
   incremental `calendar`/`todoist` worker uses native source-queue
   retry. `ChangeMessageVisibility` shortens the delay to
   30, 60, 120, 240 seconds, respectively (receives 1–4).
   If the visibility API fails, the original 900-second visibility
   remains in force, and the worker still reports failure to SQS.
4. At receive 5, the worker returns a failed item; SQS's native redrive
   moves the original message to the 14-day DLQ. The operator is notified.
5. **Nonretryable, unknown, condition/epoch/fence, manual, repair,
   reconciliation, orphan or possibly partially applied operations** are
   quarantined immediately using a confirmed FIFO `SendMessage` to the
   main sync DLQ. Only after that send succeeds does the worker acknowledge
   the source. If the send fails, the original source record is returned
   as failed for bounded native retry/redrive.
6. The worker supplies `createObservedProviderClientFactory` to the
   entire incremental orphan/project/synchronizer path. Its proxy tracks
   every mutating provider method *before the provider method is entered*,
   including a create/update/delete which is followed by
   `putMapping`, `putRecurrenceLink` or `recordMutation`.
   A throttle from any subsequent DynamoDB state operation therefore
   cannot trigger automatic replay of an already-applied provider
   mutation. A write *attempt* that fails before reaching the provider
   is conservatively quarantined, not automatically replayed.
7. No path marks the delivery `DELIVERY#` receipt completed while an
   operation is retrying or quarantined. The recovery operator must
   re-read current provider state before replaying, especially for
   Calendar master/instance changes and Todoist recurring advancement.

**Limits:** the provider-boundary observer is deliberately more
conservative than `recordMutation`: an attempted write is enough to
quarantine after any later DynamoDB throttle, even when the write had
no side effect. This covers post-provider `putMapping` and recurrence
writes, not only accounting. Direct low-level provider mutations that
bypass the observed client factory must not be added to incremental
sync paths. The safest correctness guarantee remains deterministic
provider IDs, conditional state writes, provider readback and durable
repair barriers. Treat uncertain provider side effects as review cases
rather than broadening the auto-retry allowlist.

## Classification

Retryable when the exception (possibly as a bounded `.cause` chain)
is explicitly a DynamoDB:
`ProvisionedThroughputExceededException`,
`ThrottlingException`, `ThrottlingError`,
`RequestLimitExceeded`, `InternalServerError`,
`ServiceUnavailable`, `TransactionInProgressException`,
`ReplicatedWriteConflictException`. A
`TransactionCanceledException` is retryable **only when**
`CancellationReasons` is present, includes a throughput/throttling
reason, and **every** entry has the explicit code `None` or a
recognized throughput/throttling reason. An absent, blank or unknown
`Code` is always quarantined.

Conditional check failures, ambiguous transaction cancellations,
Google/Todoist provider HTTP errors, erasure epochs and fences,
unrecognized operations and conflict resolutions must **not** be
blindly replayed.

## DLQ operations

- Main sync queue: FIFO, **max receive 5**; 4-day source retention,
  900-second default visibility.
- Main sync DLQ: FIFO, **14-day retention**, inspect promptly.
- Erasure operation queue + erasure DLQ: **unchanged**, separate safety
  protocol and retention.
- Permanent failures are sent to DLQ using the **original delivery
  body** and `sync:<profile>` FIFO group with a stable SQS deduplication
  hash keyed by original source message identity.
- Explicit SQS handoff and native SQS redrive can produce duplicate DLQ
  copies if a send succeeds but source acknowledgement fails or the
  process loses the response. Treat DLQ as **at least once**, confirm
  current provider state, and use the existing review/repair workflow.

**Never blindly redrive the entire DLQ**: a reconciliation or provider
mutation may have partially completed and erasure fences/epochs may
have since changed. In the review page, first inspect the original
delivery ID, source message, profile, current mapping, receipt,
Calendar incremental cursor, Todoist task, recurrence ownership,
completed-history markers and any erasure journal. Never clear
unresolved DLQ records just to silence the alert. Record the repair
outcome, then replay only a verified safe individual message.

### Operator checks

Search worker CloudWatch logs for:
- `delivery_transient_dynamodb_retry_scheduled`
- `transient_dynamodb_retry_visibility_fallback`
- `delivery_failed_for_dlq` with
  `dlqPolicy.action: native_sqs_redrive` or
  `durable_handoff_acknowledge_source`
- `delivery_dlq_handoff_failed_source_retained`

Monitor `AWS/DynamoDB` `ReadThrottleEvents`,
`WriteThrottleEvents`, `ThrottledRequests` for the table
**and** `ProfileLookupIndex`, plus
`AWS/SQS` source `ApproximateAgeOfOldestMessage`,
`ApproximateNumberOfMessagesVisible/NotVisible`
and DLQ `ApproximateNumberOfMessagesVisible`. Do not treat a
zero/absent CloudWatch datapoint as proof of no throttling.

### Release gate / rollback

1. Merge and validate #256 **before** lowering main-table RCU/WCU
   through #255. Inspect the CloudFormation change set: SyncQueue
   redrive policy, SyncDlq retention and Worker IAM/env only;
   **no** table/GSI replacement, capacity or erasure policy edits.
2. Verify `npm test` and `sam validate --lint` in CI.
3. Test forced DynamoDB throttling before commit, exhausted retries,
   direct DLQ handoff failure, provider-write-then-state-throttle,
   duplicate SQS delivery, erasure fence drift and
   home/antonio/work FIFO group separation. Exercise
   Calendar recurring master/instance and Todoist native recurrence
   using the existing end-to-end smoke tests; do not mutate real
   provider data without separate operator approval.
4. Verify DLQ alarm routing and source queue age. Keep #257 alarm
   coverage while lowering capacity. Never remove alerts to
   achieve an arbitrary alarm count.
5. Rollback by redeploying the prior worker and IaC in a reviewed
   change set; **do not** reset queue/deduplication state or delete
   messages to rollback.

The intention is improved durability, not reduced provisioned
DynamoDB billing directly. Safe capacity right-sizing remains #255.
