# todoist-calendar-sync DynamoDB provisioned-capacity plan

## Decision

Move `todoist-calendar-sync-state-production` from `PAY_PER_REQUEST` to **fixed provisioned capacity**.

Initial target:

- read capacity: **25 RCU**
- write capacity: **25 WCU**
- DynamoDB Application Auto Scaling: **disabled / not configured**

The system should absorb bursts by **delaying work**, not by increasing DynamoDB capacity.

The primary control model is:

```text
provider/webhook burst
        |
        v
      SQS FIFO
        |
        v
Lambda worker (reserved concurrency = 1, batch size = 1)
        |
        v
bounded DynamoDB work
        |
        v
fixed 25 RCU / 25 WCU table
```

For reconciliation, one Lambda invocation must also be prevented from consuming the whole table capacity in a short interval. Full-table/background work therefore needs explicit page limits, consumed-capacity measurement, pacing, and bounded reconciliation continuations.

## Implementation status

The implementation on `plan/gcp-sync-provisioned-capacity` now contains all three planned safety/cutover slices:

- [x] shared DynamoDB client with deliberate standard retry behaviour;
- [x] all todoist-calendar-sync full-table scans use bounded pages and `ReturnConsumedCapacity` pacing;
- [x] default scan page limit is 25 evaluated items;
- [x] default background scan budget is 10 RCU/s;
- [x] item-size warning telemetry at >=16 KiB and critical telemetry at >=64 KiB;
- [x] snapshot reconciliation is bounded to 20 candidates per invocation by default;
- [x] reconciliation continuation messages remain in the same profile FIFO lane and generation;
- [x] continuation enqueue failure leaves the durable reconciliation generation recoverable;
- [x] recurrence reconciliation is not repeated for every continuation chunk;
- [x] CloudFormation switches the table to `PROVISIONED` with explicit 25/25 defaults;
- [x] no Application Auto Scaling resources are configured;
- [x] dedicated read/write throttle alarms are configured;
- [x] two-minute >=80% read/write utilisation alarms are configured;
- [x] sustained SQS queue-depth alarm is configured in addition to the existing queue-age alarm;
- [ ] merge/deploy to production;
- [ ] verify production table mode/capacity and alarms;
- [ ] exercise Home/Antonio/Work post-deploy smoke and controlled backlog/reconciliation behaviour.

Nothing in this branch changes production until the PR is merged and the deployment workflow runs.

## Why fixed provisioned mode is now reasonable

The previous retry/amplification incident made on-demand capacity safer while workload behaviour was uncertain. The system is now materially more bounded:

- `WorkerFunction.ReservedConcurrentExecutions: 1`;
- SQS event source `BatchSize: 1`;
- FIFO message ordering;
- `ReconcilerFunction.ReservedConcurrentExecutions: 1`;
- ingress writes to SQS rather than directly to DynamoDB;
- failed worker deliveries are quarantined instead of repeatedly replayed;
- reconciliation requests are deduplicated/generation-based;
- mutation circuits and mutation budgets constrain runaway provider activity;
- the state table has no GSIs requiring independent capacity planning.

These controls make normal webhook traffic predictable enough for fixed 25/25 capacity, subject to verification from recent CloudWatch consumption.

## Why Lambda concurrency is necessary but not sufficient

Lambda concurrency controls **how many invocations run at once**. It does not rate-limit the DynamoDB calls made by a single invocation.

The worker is already at the minimum useful concurrency:

```text
Reserved concurrency = 1
SQS batch size       = 1
```

This means a webhook burst naturally becomes queue depth:

```text
50 incoming changes
      |
      v
SQS: 50, 49, 48, ...
      |
      v
one worker invocation at a time
```

That is the desired behaviour.

However, one reconciliation invocation can still do this:

```text
Scan page
Get
Get
TransactWrite
Put baseline
Put audit
...
```

Concurrency = 1 does not slow those calls down. Therefore the design uses two levels of backpressure:

1. **invocation-level**: SQS FIFO + Lambda reserved concurrency 1;
2. **inside an invocation**: bounded/paced DynamoDB reads and bounded reconciliation chunks.

## Important capacity characteristics of the current data model

### Mapping writes are transactional

`StateRepository.putMapping()` writes three table items in one `TransactWriteItems` request:

- `EVENT#<profile>#<eventId>`
- `TASK#<profile>#<taskId>`
- `TASKOWNER#<taskId>`

Transactional writes are more expensive than ordinary single-item writes. The worker's concurrency of one prevents parallel mapping updates, while bounded reconciliation prevents one invocation from processing an arbitrarily large number of candidates.

### Some reads are strongly consistent

Delivery-completion, reconciliation-state and mapping-owner safety reads use `ConsistentRead: true`. These should retain capacity headroom ahead of lower-priority background scans.

### The largest read burst risk is `Scan`

The table has full-table scans for:

- reconciliation mappings;
- recurrence links;
- pending manual decisions;
- intervention policies.

A DynamoDB `FilterExpression` is applied after items are read, so filtering does not remove the capacity cost of evaluated items.

All of these paths therefore use the shared paced scan helper.

## Burst mitigation strategy

### Layer 1 — retain queue backpressure

Keep:

```yaml
WorkerFunction:
  ReservedConcurrentExecutions: 1

SyncQueue event source:
  BatchSize: 1
```

Do not increase worker concurrency as part of this migration.

Webhook bursts accumulate in SQS instead of creating parallel DynamoDB write pressure.

The existing oldest-message alarm and the added sustained queue-depth alarm make this backpressure visible.

### Layer 2 — capacity-aware scan pagination

All full-table scans use a shared helper with initial defaults:

```text
page evaluated-item limit: 25
background scan budget:     10 RCU/s
```

Each page requests:

```text
ReturnConsumedCapacity = TOTAL
```

The helper:

- limits evaluated items per request;
- measures actual consumed capacity;
- preserves `LastEvaluatedKey` pagination;
- delays before the next page when actual consumption is above the background budget;
- adds small jitter when a delay is required;
- emits structured page and completion telemetry;
- never adds an unnecessary delay after the final page.

This deliberately leaves capacity headroom for webhook state reads/writes and strongly consistent safety checks.

### Layer 3 — bounded reconciliation continuations

Snapshot reconciliation processes at most 20 mapped/unmapped Todoist candidates per invocation by default.

Candidate lists are sorted by Todoist task ID and continuation state records:

```text
sequence
phase = mapped | unmapped
afterTaskId
```

When more candidates remain:

```text
current reconciliation chunk
        |
        v
process <=20 candidates
        |
        v
enqueue next continuation
same generation + same sync:<profile> FIFO group
        |
        v
mark current delivery complete
```

If the continuation cannot be queued, the current delivery is not marked complete and the existing durable pending-generation recovery path remains available to a later webhook/scheduled reconciliation request.

This changes a large reconciliation from a single burst into queue-mediated sequential work.

### Layer 4 — provider mutation budget remains independent

The existing reconciliation provider mutation budget remains in force. Candidate chunking limits how much reconciliation state is assessed per invocation; the mutation budget independently limits Calendar/Todoist provider writes.

The stricter control wins when either limit is reached.

### Layer 5 — item-size observability

The shared DynamoDB document client observes Put and transactional-Put payload sizes without logging item contents.

Current thresholds:

```text
>= 16 KiB  warning
>= 64 KiB  critical log
```

This is intentionally observational rather than a hard rejection. Large canonical state remains valid, but it becomes visible as a possible capacity outlier.

### Layer 6 — fixed DynamoDB capacity

CloudFormation configures:

```yaml
BillingMode: PROVISIONED
ProvisionedThroughput:
  ReadCapacityUnits: 25
  WriteCapacityUnits: 25
```

The values are CloudFormation parameters with defaults of 25 so a future explicit stack change can raise/lower capacity without introducing runtime auto scaling.

There are **no** `AWS::ApplicationAutoScaling::*` resources.

### Layer 7 — alarms

Configured capacity/backpressure signals:

- DynamoDB `ReadThrottleEvents > 0`;
- DynamoDB `WriteThrottleEvents > 0`;
- read utilisation >=80% for two consecutive one-minute periods;
- write utilisation >=80% for two consecutive one-minute periods;
- SQS oldest-message age >5 minutes;
- SQS visible queue depth >100 for two consecutive five-minute periods;
- existing worker-error and DLQ alarms.

These alarms inform an operator; they do not scale the table.

## CloudFormation implementation

Capacity/pacing parameters:

```text
StateTableReadCapacity              default 25
StateTableWriteCapacity             default 25
DynamoDbScanRcuBudgetPerSecond      default 10
DynamoDbScanPageItemLimit           default 25
ReconciliationCandidateLimit        default 20
```

The template remains the only source of truth for table capacity. Avoid console-only changes except emergency mitigation followed immediately by an equivalent IaC update.

## Deployment / validation plan

Before merge/deploy:

- all unit/build/SAM validation must pass;
- inspect current source queue and DLQ state;
- ensure no known reconciliation incident is active;
- inspect recent DynamoDB consumed capacity if available.

After deployment:

1. confirm the existing table was updated in place and remains deletion-protected/PITR-enabled;
2. confirm billing mode is `PROVISIONED`;
3. confirm provisioned read/write are 25/25;
4. confirm no Application Auto Scaling target exists for this table;
5. confirm read/write throttle and utilisation alarms exist;
6. run the Home/Antonio/Work post-deploy smoke;
7. exercise a normal Todoist and Calendar change;
8. observe a scheduled/manual reconciliation and verify chunk/scan telemetry;
9. confirm queue age/depth remains healthy and no DynamoDB throttles occur.

The cutover must not be merged if the source queue/DLQ indicates an active incident or if CI/SAM validation is not green. Because the CloudFormation change updates the existing retained table in place, review the generated change set/deployment output for replacement before accepting any deploy; table replacement is not an acceptable cutover path.

## Controlled burst validation

Do not generate a provider mutation storm purely to test DynamoDB.

Prefer:

- a read-oriented repository/test-table workload for scan pacing;
- a reconciliation with enough no-op candidates to demonstrate continuation chunking;
- normal webhook events allowed to queue naturally.

Success means excess work becomes **queue depth / continuation messages**, not DynamoDB scaling or uncontrolled request bursts.

## Rollback

If fixed 25/25 produces unexpected throttling:

1. determine whether the cause is an unbounded path, unexpectedly large item, abnormal one-off burst, or genuinely higher steady-state demand;
2. for genuinely higher steady state, explicitly raise `StateTableReadCapacity` and/or `StateTableWriteCapacity` in CloudFormation;
3. if behaviour is not understood or requires immediate safety, revert the template to `PAY_PER_REQUEST` and redeploy;
4. retain scan pacing, continuation chunking and observability—they are useful in either billing mode.

Do not repeatedly toggle billing modes during testing.

## Interaction with issue #64 (project-comment mapping index)

The project-comment mapping work may reduce Todoist API reads but does not materially remove DynamoDB reconciliation state. It may add small mapping metadata fields.

The capacity safeguards are independent and also protect the mapping migration/backfill from producing large unbounded reconciliation runs.

## Acceptance criteria

- [x] DynamoDB capacity is defined as fixed provisioned 25/25 defaults in IaC.
- [x] No DynamoDB Application Auto Scaling resources are configured.
- [x] Worker reserved concurrency remains 1 and SQS batch size remains 1.
- [x] All known full-table state scans use bounded, capacity-aware pacing.
- [x] Large snapshot reconciliations are split into resumable FIFO continuation chunks.
- [x] Continuations retain reconciliation generation and profile ordering.
- [x] Continuation enqueue failure remains recoverable through durable pending state.
- [x] Item-size anomalies are observable without logging state contents.
- [x] Read/write throttle and sustained utilisation alarms are defined.
- [x] Queue age and sustained queue depth expose backpressure.
- [ ] Production deployment confirms 25/25 and no throttles under normal use.
- [ ] Home/Antonio/Work smoke passes after cutover.
