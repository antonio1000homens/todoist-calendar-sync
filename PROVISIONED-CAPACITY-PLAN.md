# DynamoDB fixed provisioned capacity — shared Free Tier plan (#255)

## Current recommendation (1 November 2026)

Keep `todoist-calendar-sync-state-production` and the existing
`ProfileLookupIndex` in **PROVISIONED** mode, with **no Application Auto Scaling**.
Provision **20 read / 20 write units on the main table and 5 read / 5 write
units on the GSI**:

| Resource | Before (live) | After (proposed) |
| --- | --- | --- |
| Main table | 25 RCU / 25 WCU | **20 RCU / 20 WCU** |
| `ProfileLookupIndex` | 5 RCU / 5 WCU | **5 RCU / 5 WCU** |
| **Total** | **30 RCU / 30 WCU** | **25 RCU / 25 WCU** |

DynamoDB's provisioned-capacity Free Tier allowance is **shared across
provisioned tables and their GSIs**, not a per-table 25/25 budget.
Other tables/GSIs and billing eligibility within the account and region
must also be considered. A 1 November read-only inspection in
`eu-west-2` found three other DynamoDB tables in `PAY_PER_REQUEST`
mode and no additional provisioned table there. This makes 25/25
a reasonable local target, but it is **not** a guarantee of a zero
AWS bill (alarms, storage, other regions, and other AWS services still cost).

This decision supersedes the original September 2026 **table-only**
25/25 plan and its pre-GSI throughput assumptions.

## Evidence and current production deployment

Read-only AWS observations, 1 November 2026:

- CloudFormation stack `todoist-calendar-sync`: `UPDATE_COMPLETE`;
  persisted parameters `StateTableReadCapacity=25`,
  `StateTableWriteCapacity=25`, `ProfileLookupIndexReadCapacity=5`,
  `ProfileLookupIndexWriteCapacity=5`.
- `template.yaml` had main defaults **25/25** but GSI defaults
  **10/10**. The prior `deploy.sh` omitted all four capacity parameter
  overrides, allowing drift between defaults and persisted stack values.
  The original operator/deployment that set 5/5 is not established from
  the available update history; do not assume it was automatic.
- Main table and GSI were `ACTIVE`; table deletion protection was
  **enabled** and point-in-time recovery was **enabled** with a 35-day
  recovery period, verified using `DescribeContinuousBackups`.
- Last 7-day 5-minute-window maxima (all 2016 windows):
  table reads **5.63 RCU/s**, writes **3.46 WCU/s**;
  GSI reads **0.083 RCU/s**, writes **0.21 WCU/s**.
- Separate 7-day 1-minute observations showed table peak
  **8.28 consumed RCU/s**, **3.60 consumed WCU/s**, and GSI
  **0.108 read / 0.80 write units per second** *averaged across
  observed minutes*. CloudWatch pagination left a small part of
  that seven-day 1-minute sample incomplete; do not interpret those
  maxima as exhaustive or as sub-second burst rates.
- No throttling datapoints were returned for
  `ReadThrottleEvents`, `WriteThrottleEvents` or
  `ThrottledRequests` in the observed windows. **Missing metrics
  are not evidence of zero throttle incidents.** Validate both main
  table and GSI at one-minute resolution, and check worker retries,
  queue age, and DLQ after rollout.

The index remains provisioned at 5/5 because normal profile queries
are paginated/paced and observed GSI usage is low. One mapping
transaction projects multiple rows into the GSI, so conditional
and transactional bursts still require headroom and monitoring.

## System backpressure retained

```text
webhook --> SQS FIFO group sync:<profile> --> Lambda worker (concurrency 1)
                        |                    |
                        |                    +--> DynamoDB state table (20/20)
                        |                         +--> ProfileLookupIndex (5/5)
                        |
                        +--> retry-safe original FIFO message / 14-day DLQ
```

- Worker `ReservedConcurrentExecutions: 1`, batch size 1.
- Shared DynamoDB SDK `maxAttempts: 5`, standard retries.
- #256 merged: only eligible pre-provider-mutation transient DynamoDB
  failures use bounded native FIFO retry; ambiguous or potentially
  partially applied operations are quarantined. **Verify #256 is
  actually deployed, not merely merged, before reducing capacity.**
- Full-table admin/cleanup scan pages bounded to 25 evaluated items,
  default 10 RCU/s pacing; normal `ProfileLookupIndex` queries
  paced to 5 RCU/s with bounded pages. Reconciliation also limits
  candidate chunks and provider mutations.
- #259 disables scheduled completed-history dry-run-only scans when
  cleanup apply is false.
- Guarded transactional reads/writes, provider receipt/identity
  checks, erasure fencing, Calendar cursor and recap/continuation
  state must not be weakened by this capacity change.

## IaC controls and guardrails

`template.yaml` has these **explicit defaults**:

```text
StateTableReadCapacity          20
StateTableWriteCapacity         20
ProfileLookupIndexReadCapacity   5
ProfileLookupIndexWriteCapacity  5
```

`deploy.sh` explicitly passes **all four** as SAM parameter
overrides. Operators may override via:

```text
STATE_TABLE_READ_CAPACITY
STATE_TABLE_WRITE_CAPACITY
PROFILE_LOOKUP_INDEX_READ_CAPACITY
PROFILE_LOOKUP_INDEX_WRITE_CAPACITY
```

`npm run check:capacity` validates the combined defaults and
current override values across **every PROVISIONED DynamoDB table
and every declared GSI** in the SAM template. Invalid, unsupported,
unexpectedly unprovisioned indexes and any inadvertent
over-25/25 configuration fail CI/deploy. The CI test exercises
an added table, added GSI, excessive defaults, invalid overrides
and the explicit paid-capacity path.

If an incident justifies **paid** capacity, a separate operator
can set `DYNAMODB_ALLOW_PAID_CAPACITY=I_ACKNOWLEDGE_PAID_CAPACITY`
for that deployment. This only bypasses the *override*
limit; template defaults must remain safe. This variable is
**not automatically set** in GitHub Actions and the operator
must explicitly document the temporary overage and reversion.

### Automatic production deployment safety gate

A successful `master` CI automatically launches the production
deploy workflow. Merely merging this PR **must not lower RCU/WCU
without separate approval**.

Before deploying, `deploy.sh` reads the **four actual
CloudFormation stack parameters**; any requested reduction
without `DYNAMODB_CAPACITY_REDUCTION_APPROVED=true` exits before
`sam deploy`. The production GitHub environment variable
`DYNAMODB_CAPACITY_REDUCTION_APPROVED` is intentionally **unset
by default**. This means an unapproved merged PR cannot silently
decrease table/index capacity. A failed gate blocks the deploy;
the application is not partially updated by that deployment.

**Operator rollout sequence:**

1. Confirm #256 was successfully deployed and observe working
   FIFO retries/quarantine, current source age/depth, DLQ contents,
   and no active profile/erasure/reconciliation incident.
2. Review the #255 CI and SAM validation. Inspect the generated
   CloudFormation **change set** (a live change set is not created
   by this code PR); confirm the existing table/index are
   **Modify, replacement=False**, never `Add`, `Remove`
   or `Replace`. DeletionProtectionEnabled, PITR, primary keys,
   index key schema and `DeletionPolicy/UpdateReplacePolicy`
   must remain unchanged.
3. Set `DYNAMODB_CAPACITY_REDUCTION_APPROVED=true` in the
   GitHub **production environment** and execute an authorised
   controlled deployment. After this deployment, clear that
   variable so future unexpected reductions fail closed.
4. Confirm live table 20/20 and GSI 5/5,
   `ACTIVE`, deletion protection enabled, PITR enabled and
   no unexpectedly replaced/retained duplicate table.
5. Validate `home`, `antonio`, `work`: standalone and
   recurring Todoist/Calendar updates, duplicate delivery
   suppression, one-item reconcile, and a successful queued
   continuation with no new unintended provider mutations.
6. Compare a **7–14 day** normalised post-rollout window
   with the read-only baseline: main and GSI
   `ConsumedReadCapacityUnits`, `ConsumedWriteCapacityUnits`,
   `ReadThrottleEvents`, `WriteThrottleEvents`,
   `ThrottledRequests`, worker retries/errors, SQS
   `ApproximateAgeOfOldestMessage`, queue depth, DLQ count
   and Calendar cursor/reconciliation progress. Do not infer
   availability from averages alone.

### Read-only verification commands

```bash
aws cloudformation describe-stacks --region eu-west-2 \
  --stack-name todoist-calendar-sync \
  --query "Stacks[0].Parameters[?contains(ParameterKey,'Capacity')].[ParameterKey,ParameterValue]"
aws dynamodb describe-table --region eu-west-2 \
  --table-name todoist-calendar-sync-state-production \
  --query "Table.{Status:TableStatus,Table:ProvisionedThroughput,Index:GlobalSecondaryIndexes[*].{Name:IndexName,Status:IndexStatus,Throughput:ProvisionedThroughput},DeletionProtection:DeletionProtectionEnabled}"
aws dynamodb describe-continuous-backups --region eu-west-2 \
  --table-name todoist-calendar-sync-state-production \
  --query "ContinuousBackupsDescription.PointInTimeRecoveryDescription"
npm run check:capacity
npm test
sam validate --template template.yaml --lint
```

## Rollback / incident budget exception

If queue age rises, retries exhaust, throttles occur, or a
transactional/read-consistency path regresses, **stop the
reduction** and inspect whether the cause is a GSI hotspot,
a brief burst, a repeated webhook, a reconciliation scan,
or genuine steady-state demand. Do not redrive the entire
DLQ or remove alarms to hide the symptom.

A deliberate temporary rollback to main table **25/25** with
index **5/5** totals **30/30**, i.e. paid throughput.
It requires an explicit `DYNAMODB_ALLOW_PAID_CAPACITY`
acknowledgment above. Only use the minimum required increase;
restore the 20/20+5/5 configuration after the problem is
diagnosed. Remain PROVISIONED by default; switching to
`PAY_PER_REQUEST` is a separate, reviewed incident
decision. Do not repeatedly toggle billing mode during testing.

Related: [#254](https://github.com/antonio1000homens/todoist-calendar-sync/issues/254),
[#255](https://github.com/antonio1000homens/todoist-calendar-sync/issues/255),
[#256](https://github.com/antonio1000homens/todoist-calendar-sync/issues/256),
[profile index guide](docs/profile-lookup-index.md),
[alarm-cost and safety coverage](docs/cloudwatch-alarm-cost-and-coverage.md).
