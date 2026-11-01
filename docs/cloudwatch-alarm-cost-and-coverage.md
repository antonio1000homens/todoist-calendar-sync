# CloudWatch alarm cost and coverage

This document describes the production CloudFormation alarm inventory for
`todoist-calendar-sync`. Changes are made through `template.yaml` and the
deployment pipeline, **not by directly deleting stack-owned alarms in the AWS
console**. The current change removes the **four custom-metric alarms explicitly
requested by the operator**, in addition to the four DynamoDB utilization alarms
previously removed in [#257](https://github.com/antonio1000homens/todoist-calendar-sync/issues/257).

**After deployment:** 11 retained CloudWatch alarms (15 before this PR).
All four log-derived `AWS::Logs::MetricFilter` resources remain deployed.
Do **not** describe this as eliminating their custom metrics, log delivery
charges or metric-publishing costs. **Custom metric charges can continue**
after the four alarms are deleted; check `MetricMonitorUsage` separately
from `AlarmMonitorUsage` in Cost Explorer.

## Alarm inventory and signal impact

| Alarm suffix | Source metric / significance | Decision |
| --- | --- | --- |
| `watch-renewal-failures` | Custom `TodoistCalendarSync/Watch:RenewalFailures`; direct watch replacement failure | **Remove** (operator decision). Metric filter and Lambda logs remain; **no direct CloudWatch alarm** |
| `watch-missing` | Custom `TodoistCalendarSync/Watch:MissingWatches`; absent Calendar watch state | **Remove** (operator decision). Metric filter and Lambda logs remain; **no direct CloudWatch alarm** |
| `erasure-recovery-blocked` | Custom `TodoistCalendarSync/Erasure:RecoveryBlocked`; safety fence cannot be recovered | **Remove** (operator decision). Metric filter and Lambda logs remain; **no direct CloudWatch alarm** |
| `erasure-review-required` | Custom `TodoistCalendarSync/Erasure:ReviewRequired`; erasure requires human review | **Remove** (operator decision). Metric filter and Lambda logs remain; **no direct CloudWatch alarm** |
| `watch-errors` | AWS/Lambda:Errors for watch Lambda; does not detect all logical watch failures | **Keep** |
| `worker-errors` | AWS/Lambda:Errors for sync worker | **Keep** |
| `dlq-not-empty` | AWS/SQS visible sync DLQ messages | **Keep** |
| `erasure-dlq-not-empty` | AWS/SQS visible erasure DLQ messages | **Keep** |
| `erasure-worker-errors` | AWS/Lambda:Errors for erasure executor | **Keep** |
| `source-oldest-message` | AWS/SQS oldest source FIFO message older than five minutes | **Keep** |
| `source-depth` | AWS/SQS source FIFO backlog >100 for two five-minute periods | **Keep** |
| `dynamodb-read-throttles` | AWS/DynamoDB read throttling of main table | **Keep** |
| `dynamodb-write-throttles` | AWS/DynamoDB write throttling of main table | **Keep** |
| `profile-lookup-read-throttles` | AWS/DynamoDB read throttling of `ProfileLookupIndex` | **Keep** |
| `profile-lookup-write-throttles` | AWS/DynamoDB write throttling of `ProfileLookupIndex` | **Keep** |
| `dynamodb-read-utilization` | Table read utilisation above 80%; two-metric math alarm | Previously removed (#257) |
| `dynamodb-write-utilization` | Table write utilisation above 80%; two-metric math alarm | Previously removed (#257) |
| `profile-lookup-read-utilization` | GSI read utilisation above 80%; two-metric math alarm | Previously removed (#257) |
| `profile-lookup-write-utilization` | GSI write utilisation above 80%; two-metric math alarm | Previously removed (#257) |

The retained 11 alarms all use `AlarmActions: [!Ref AlertTopic]`.
The current delivery route is `todoist-calendar-sync-alerts-production`.
A read-only check on 2026-11-01 found **zero SNS subscriptions** on that
topic. Having an alarm in the `OK` state or with an action configured does
**not** demonstrate actual notification delivery. The subscription and
end-to-end test remain tracked in
[Windsor monitoring #1992](https://github.com/antonio1000homens/windsor-app/issues/1992).

The four removed alarms were the **only direct CloudWatch alarm** route for
their four log-derived events. These events may still be discoverable in CloudWatch
Logs and their metric series, but there is **no verified operational replacement**
for all of them. A watch Lambda invocation-error alarm is not equivalent to
a `watch_missing` or `watch_renewal_failed` event. An erasure executor Lambda
error/DLQ alarm does **not** cover a review-required or blocked-recovery status
that was handled without a Lambda invocation failure. Do not mark the latter
conditions as automatically paged after this change.

## Cost estimate and important distinctions

- The **11 retained single-metric CloudWatch alarms** are one alarm-metric unit
  each. The first ten eligible standard alarm-metric units are free **across the
  entire AWS account**, not a dedicated ten per service or per region.
- AWS's verified EU (London) marginal standard-alarm price for the baseline was
  **$0.10 per alarm-metric-month**. Removing four alarms can avoid **up to
  $0.40 in gross charges for a full billing month** *if* those units are
  billable. Actual incremental saving may be $0 due to shared Free Tier
  allocation, billing proration, and other account alarms. It does **not**
  establish that the full account will have only 11 alarm units or that
  all 11 are eligible for the free allowance.
- October 2026 `EUW2-CW:AlarmMonitorUsage` was about **$0.988** for
  19.88 usage units. Dividing total cost by usage and interpreting that
  ratio as the **marginal price** would be wrong because of Free Tier
  credits/allowances. Review full-month post-deployment cost and usage type.
- The four utilization alarms removed earlier each contained two underlying
  metrics in metric math. That previous change removed **eight alarm-metric
  units**, a maximum **$0.80 gross per full month** under the same assumptions;
  the previously documented $0.40 estimate did not account for that pricing.
- Removing the alarm does **not** stop the four custom metrics being emitted
  by log metric filters. Custom metrics can have **separate charges** from the
  alarm. To stop those charges would require a separate, explicitly approved
  decision to remove the four filters and any consumers (including Windsor's
  existing `RenewalFailures` and `MissingWatches` exporter queries).
  Removing just the alarms is intentional here.
- The Windsor exporter already queries AWS CloudWatch via `GetMetricStatistics`.
  Avoid additional polling, metric discovery or switching to billable
  `GetMetricData` solely to save alarm costs. Account-wide request allowance,
  other service traffic and actual invoice data determine whether polling
  adds charges. See
  [Windsor #1992](https://github.com/antonio1000homens/windsor-app/issues/1992).

### Explicit coverage gap

After retiring these four alarms, **automatic AWS-side detection is lost for**
`watch_missing`, `watch_renewal_failed`, `erasure review_required` and
`erasure recovery blocked` **unless another independent notification source
exists**. This is a deliberate operator-directed reduction in alert coverage,
not evidence that those events are now monitored in Windsor. The known
Windsor state exporter can report missing/expiring watches, but incident
notification routing has not yet been verified. The erasure status metrics are
not included in the existing exporter inventory.

Before relying on Windsor as a substitute, implement and verify the required
rule groups, series freshness/labels, receiver delivery and resolution, and
independently routed dead-man/outage detection described in #1992.

**Capacity nears its provisioned limit before throttling:** use existing
DynamoDB consumed and provisioned series in Grafana for early warning;
the four actual table/GSI throttle alarms remain. Main table is currently
20 RCU / 20 WCU and `ProfileLookupIndex` 5/5 after approved
right-sizing; do not change these settings as part of this alarm PR.

## Deployment, verification and rollback

1. Review the CloudFormation change set. It must **delete exactly**
   `WatchRenewalFailureAlarm`, `WatchMissingAlarm`,
   `ErasureRecoveryBlockedAlarm`, and `ErasureReviewRequiredAlarm`;
   retain all four `AWS::Logs::MetricFilter` resources and all 11 other
   `AWS::CloudWatch::Alarm` resources. Do not modify the SNS topic, queue
   definitions, DynamoDB capacity, Lambda code or IAM access.
2. Deploy the approved change from the normal GitHub Actions/SAM pipeline.
   Do not delete alarms manually: that creates CloudFormation drift and
   alarms can be re-created on future stack deployments.
3. Read back `DescribeStacks`, `DescribeStackResources` and
   `DescribeAlarms`. Verify **11** Todoist production alarms and all
   four unchanged log metric filters. Confirm no unintended resource changes,
   including the watches, erasure workers and DLQs.
4. Check both source/erasure DLQs and the worker/watch/erasure Lambda errors;
   preserve evidence of notification delivery limitations instead of claiming
   health from a green alarm alone.
5. Roll back by restoring the four alarm definitions in CloudFormation
   (without deleting their unchanged metric filters) and redeploying the
   prior reviewed template. Confirm alarm actions after restoration.
6. Compare CloudWatch usage by `AlarmMonitorUsage` and
   `MetricMonitorUsage` over a complete future billing month, excluding
   misleading tax and partial-month estimates.

Changes to actual metrics, metric filters or monitoring coverage require
separate review. The four named filters are retained in this change.
