# Disposable production erasure E2E

`scripts/production-erasure-e2e.mjs` exercises one disposable Work-profile
Calendar event and its Todoist projection against the deployed erasure worker.
It requires the exact CLI confirmation
`--confirm=RUN_DISPOSABLE_WORK_ERASURE_E2E`, an enabled live execution gate on
both the review API and erasure worker, protocol version 1, explicit table,
queue and function names, empty active sync/erasure queues, and no Work fence or
lease. Existing DLQ messages may remain; their counts are captured and must
not grow.

The harness uses the production preview builder and durable operation store,
then enqueues the confirmed operation directly to the real erasure queue. It
does not call the retired unscoped review HTTP routes. It verifies the real
erasure worker's provider deletions, project-comment tombstone, strong full
DynamoDB identity scan, queue/DLQ counts, fence release and worker mapping
restoration. The result file and console output contain counts and pass/fail
state, not provider identities.

Run only after setting `AWS_PROFILE`, `AWS_REGION`, the deployed
`SYNC_PROFILE_CONFIG_JSON`, `STATE_TABLE_NAME`, `QUEUE_URL`, `SYNC_DLQ_URL`,
`ERASURE_OPERATION_QUEUE_URL`, `ERASURE_OPERATION_DLQ_URL`,
`ERASURE_TARGET_WORKER_FUNCTION_NAME`, `ERASURE_REVIEW_FUNCTION_NAME`, and
`ERASURE_WORKER_FUNCTION_NAME` from the production stack. Keep the profile JSON
and provider tokens out of logs. Then run:

```sh
npm run build
node scripts/production-erasure-e2e.mjs --confirm=RUN_DISPOSABLE_WORK_ERASURE_E2E
```

Before creating a fixture, the harness verifies both deployed function
configurations directly. A failure before durable operation creation triggers
cleanup of only the exact tagged fixture. Once an operation exists, the
harness never deletes the fixture manually; preserve any operation fence and
follow the break-glass recovery procedure. A pass demonstrates the exercised
current worker path only. It does not establish that historical Lambda versions,
direct invokers, Function URLs, cross-account principals or rollback paths are
safe; those remain in [#347](https://github.com/antonio1000homens/todoist-calendar-sync/issues/347).
