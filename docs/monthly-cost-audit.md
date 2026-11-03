# Monthly cost attribution and safe post-release validation (#258)

## Scope / baseline (verified 1 November 2026)

This is a **read-only account-level audit**, not a billable per-project cost
allocation system. All monetary amounts below are USD, approximate Cost
Explorer **unblended** amounts, and are not evidence of a final settled
invoice. A service line is not automatically attributable to this
repository.

| October 2026 cost | Account-wide amount | Attribution |
| --- | ---: | --- |
| DynamoDB | ~$3.43 | Likely mostly this app's provisioned main table and GSI; verify linked usage |
| CloudWatch | ~$0.99 | Alarm cost includes application monitoring; separate #257 |
| S3 | ~$0.63 | **Account-wide; bucket unknown** |
| Cost Explorer | ~$0.07 | Account-wide, potentially billable GetCostAndUsage queries |
| KMS | ~$0.03 | Account-wide |
| Other / tax | Varies | Do not allocate by service name alone |

A single, explicitly requested read-only Cost Explorer lookup grouped by
S3 usage type and operation for **2026-10-01 through 2026-11-01**
confirmed the main S3 spending was **requests, not storage**:

| S3 usage/operation (EUW2) | October USD |
| --- | ---: |
| `EUW2-Requests-Tier1 / PutObject` | **$0.478537** |
| `EUW2-TimedStorage-ByteHrs / StandardStorage` | $0.063435 |
| `EUW2-Requests-Tier2 / HeadObject` | $0.044185 |
| `EUW2-Requests-Tier2 / GetObject` | $0.035485 |
| Other request types / regions | Small remainder |

These operations are shared across the account's S3 buckets. Bucket names
such as `aws2022-lambda-code` and other build/deploy buckets are **possible**
callers but are **not proven contributors** to the request charge.
Storage-size metrics alone cannot attribute `PutObject` charges. Do not
make a code change in this repository based only on account-wide S3 totals.

### What can and cannot establish S3 ownership

- Cost Explorer grouped by **USAGE_TYPE** and **OPERATION** identifies
  request/storage type, not bucket identity.
- Existing bucket-level request metrics (if already enabled), existing
  server access logs, existing CloudTrail S3 data events, or an existing
  resource-level CUR/Data Exports dataset can support an attribution.
  **Do not enable new per-bucket paid request metrics, data events, CUR,
  or Athena infrastructure solely for this <$1/month charge** without
  a cost/benefit decision.
- Collect timestamps and available request counts for suspected
  deployment buckets and compare with actual GitHub SAM deployments.
  A correlation is evidence to investigate, not proof.
- If no existing data can conclusively attribute the charge, record
  `account-wide S3 / owner unknown`, not `todoist-calendar-sync`.
  Put confirmed non-sync cost changes in the relevant owner repository.

## AWS monthly dollar budget is not deployed

The deployed CloudFormation stack has:

```text
BillingAlarmEmail        = (empty)
MonthlyBillingLimitUsd   = 5
MonthlyCostBudget        = not in stack resources
AlertEmailSubscription   = not in stack resources
```

The template already has the appropriate conditional resource:

- `MonthlyCostBudget` (`AWS::Budgets::Budget`);
- `BudgetType: COST`, `TimeUnit: MONTHLY`;
- `BudgetLimit: $5` by default, if deployed with that parameter;
- an actual-cost **GREATER_THAN 80%** email notification
  (trigger is therefore **>$4** for a $5 limit);
- `HasBillingAlarmEmail` is false when `BillingAlarmEmail` is blank.

Account-wide read-only `DescribeBudgets` found **no matching**
`todoist-calendar-sync-monthly-cost-production` budget. The only
account budget seen was `EBS storage size` (units `GB-Month`),
which is not a $5 cost alert. This is an **absent budget**, not a
notification subscription delivery failure.

**Operator enablement (explicit approval required):**
1. Choose a real email recipient (do not commit it or a secret to the
   repository). Review account-level budget scope: this is a $5
   *account* monthly limit, not per-application tagging.
2. Supply `BillingAlarmEmail` through the existing protected GitHub
   production environment variable
   `TODOIST_CALENDAR_SYNC_BILLING_ALARM_EMAIL`, which the current
   deploy workflow passes to `deploy.sh`. Confirm
   `MonthlyBillingLimitUsd=5` is still desired.
3. Preview the CloudFormation change set. Confirm the **existing**
   conditional `MonthlyCostBudget` and
   `AlertEmailSubscription` are created; do not add a duplicate
   budget or accidentally change DynamoDB throughput.
4. Deploy only with operator approval. Verify the `MonthlyCostBudget`
   resource, the AWS Budgets notification (ACTUAL, GREATER_THAN,
   PERCENTAGE, 80), subscriber address (do not print publicly),
   SNS email subscription confirmation, and actual receipt when
   budget threshold conditions are met.
5. A configured subscription is **not proof that an email arrived**.
   Confirm inbox delivery and routing; AWS billing data can lag.
6. If disabled later, review whether CloudFormation will delete the
   conditional budget and SNS subscription and obtain operator approval
   first.

The budget's account-wide amount may include costs from unrelated
projects. We intentionally do not instantiate another Budget resource.

## Repeatable read-only audit

```bash
# No Cost Explorer query by default (and no writes, scans or deployments).
npm run cost:audit -- --month 2026-10

# TWO explicitly opt-in, potentially billable Cost Explorer API requests:
# service-level account costs + S3 usage type / operation breakdown.
npm run cost:audit -- --month 2026-10 --include-cost-explorer
```

The script invokes only read-only AWS CLI operations. It prints a
structured JSON report without budget email values and reports
`paidCostExplorerQueries`. Do not run the Cost Explorer option in
CI, a scheduled job, Lambda, or on each worker delivery. Once a month
following the billing window, and only if manual attribution is needed,
is a reasonable default. Inspect AWS Cost Explorer prices and permissions
before enabling automated periodic queries.

The no-Cost-Explorer report includes the actual deployed budget
condition/resource, account Budget lookup, amount/notification status,
main table/GSI capacity, deletion protection/PITR, and source/DLQ
retention, redrive and approximate visible/in-flight counts.
Check **1-minute queue oldest-message age from CloudWatch** rather than
SQS `GetQueueAttributes`, which does not expose that metric.

### AWS Free Tier eligibility and timing

- The **25 RCU / 25 WCU** DynamoDB provisioned throughput allowance
  is shared among provisioned tables and GSIs. A 20/20 main +
  5/5 index is a capacity target, not a proof that the rest of
  AWS billing will be $0.
- The other three DynamoDB tables observed in `eu-west-2` on
  1 November were **PAY_PER_REQUEST**, not provisioned throughput
  consumers in that region. Account-level or other-region resources
  still need independent review.
- Free Tier entitlement varies with account creation date, plan and
  changes to Free Tier programs. Do not assume introductory benefits
  are still available on a legacy AWS account. An account-plan API
  returning `No data` is not affirmative proof of eligibility or
  ineligibility; check the actual AWS Free Tier console/usage instead.
- A mid-month capacity change only affects the **remaining**
  provisioned capacity hours. Do not extrapolate an instant reduction
  to a full-month saving. Cost Explorer may show delayed/adjusted
  month-to-date figures; taxes can be separate from service-level
  `UnblendedCost`. Distinguish estimated spend, final billing period
  and settled invoice.

## Post-deployment gates for #255, #256, #257 and #259

| Gate | Verification / rollback trigger |
| --- | --- |
| Worker retry and DLQ (#256) | Ensure merged code was **deployed**: transient DynamoDB errors retry the original FIFO record without a second provider mutation; failed/ambiguous deliveries quarantine, retained 14 days. Unexpected DLQ growth or unsafe replay => halt capacity reduction |
| DynamoDB table/GSI (#255) | Confirm live main **20/20** and GSI **5/5** after separately approved capacity reduction, `ACTIVE`, PITR `ENABLED`, deletion protection `true`. No table/index replacement. Increased throttles or sustained queue age => revert to reviewed capacity |
| Load, scans and recovery (#259) | Record main/GSI one-minute consumed units, `ReadThrottleEvents`, `WriteThrottleEvents`, `ThrottledRequests`. Validate no unnecessary completed-history dry-run scans or historical audit writes. Missing throttle datapoints do **not** prove zero |
| Critical alarms (#257) | Verify retained worker, watch Lambda and main+GSI throttle alarms. Erasure safety-state alarms, source FIFO age/depth alarms and both DLQ alarms are retired by operator decision; Windsor Grafana shows queue/DLQ metrics, while slow source-alert latency and external dead-man/SNS delivery remain technical debt in Windsor-app #1992 |
| App correctness | Normal and recurring Calendar↔Todoist change per `home`, `antonio`, `work`; duplicate-delivery guard, one-item reconcile, continuation progress, completed-history guards and active repair cases |
| Billing & budget | Verify *existing* $5 budget/email only after explicit operator configuration; compare same service/usage-type categories after a **complete** subsequent billing month |

### Monitoring and rollback

Compare like-for-like **7–14-day** workload windows after capacity
deployment for throttles, queue age and failures, then compare
the next **complete month** of unblended Cost Explorer spend with
October 2026. At the time of this report November was not complete,
so a defensible before/after dollar saving **cannot yet be calculated**.

If throttling rises or FIFO backlog cannot clear, first check the
merged #256 retry behavior, then determine whether it is a hot
partition/index, reconciliation scan, external API issue or genuine
throughput shortage. Restore capacity via reviewed CloudFormation
parameters with the explicit paid-capacity opt-in if 30/30 is
required temporarily; never delete items, replay an entire DLQ,
disable critical alarms, or change erasure/recurrence semantics
just to reduce costs.

References: [cost tracking #254](https://github.com/antonio1000homens/todoist-calendar-sync/issues/254),
[capacity #255](https://github.com/antonio1000homens/todoist-calendar-sync/issues/255),
[retry #256](https://github.com/antonio1000homens/todoist-calendar-sync/issues/256),
[alarms #257](https://github.com/antonio1000homens/todoist-calendar-sync/issues/257),
[state history #259](https://github.com/antonio1000homens/todoist-calendar-sync/issues/259).
