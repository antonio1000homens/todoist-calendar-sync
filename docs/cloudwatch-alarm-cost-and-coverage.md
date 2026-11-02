# CloudWatch alarm cost and coverage

This document describes the production CloudFormation alarm inventory for
`todoist-calendar-sync`. Changes are made through `template.yaml` and the
deployment pipeline, **not by directly deleting stack-owned alarms in the AWS
console**. This change removes four SQS alarms. The four custom-metric alarms
were removed in the preceding change, and the four DynamoDB utilization alarms
were removed in [#257](https://github.com/antonio1000homens/todoist-calendar-sync/issues/257).

**After deployment:** 7 retained CloudWatch alarms (11 before this PR).
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
| `dlq-not-empty` | AWS/SQS visible sync DLQ messages | **Remove**; Grafana depth panel remains, with no page |
| `erasure-dlq-not-empty` | AWS/SQS visible erasure DLQ messages | **Remove**; Grafana panel added in Windsor PR #1993, with no page |
| `erasure-worker-errors` | AWS/Lambda:Errors for erasure executor | **Keep** |
| `source-oldest-message` | AWS/SQS oldest source FIFO message older than five minutes | **Remove**; delayed Prometheus alert accepted as technical debt |
| `source-depth` | AWS/SQS source FIFO backlog >100 for two five-minute periods | **Remove**; delayed Prometheus alert accepted as technical debt |
| `dynamodb-read-throttles` | AWS/DynamoDB read throttling of main table | **Keep** |
| `dynamodb-write-throttles` | AWS/DynamoDB write throttling of main table | **Keep** |
| `profile-lookup-read-throttles` | AWS/DynamoDB read throttling of `ProfileLookupIndex` | **Keep** |
| `profile-lookup-write-throttles` | AWS/DynamoDB write throttling of `ProfileLookupIndex` | **Keep** |
| `dynamodb-read-utilization` | Table read utilisation above 80%; two-metric math alarm | Previously removed (#257) |
| `dynamodb-write-utilization` | Table write utilisation above 80%; two-metric math alarm | Previously removed (#257) |
| `profile-lookup-read-utilization` | GSI read utilisation above 80%; two-metric math alarm | Previously removed (#257) |
| `profile-lookup-write-utilization` | GSI write utilisation above 80%; two-metric math alarm | Previously removed (#257) |

The retained 7 alarms all use `AlarmActions: [!Ref AlertTopic]`.
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

- The **7 retained single-metric CloudWatch alarms** are one alarm-metric unit
  each. The first ten eligible standard alarm-metric units are free **across the
  entire AWS account**, not a dedicated ten per service or per region.
- AWS's verified EU (London) standard-alarm price is **$0.10 per
  alarm-metric-month**. The four SQS alarms removed here can avoid **up to
  $0.40 gross for a full billing month** if those units are billable. Actual
  incremental savings may be $0 due to shared Free Tier allocation, proration,
  and other account alarms. This does not establish that all 7 retained alarm
  units are eligible for the free allowance.
- October 2026 `EUW2-CW:AlarmMonitorUsage` was about **$0.988** for
  19.88 usage units. Dividing total cost by usage and interpreting that
  ratio as the **marginal price** would be wrong because of Free Tier
  credits/allowances. Review full-month post-deployment cost and usage type.
- PR #257 removed four utilization alarms, each containing two underlying
  standard-resolution metrics in metric math. That change removed **eight
  alarm-metric units**, a maximum **$0.80 gross per full month** under the same
  assumptions. The earlier $0.40 estimate did not account for both metrics in
  each math alarm.
- This PR removes four single-metric SQS alarms, a maximum **$0.40 gross per
  full month** if all four units would otherwise be billed. Actual net savings
  may be $0 because the standard alarm Free Tier is shared account-wide and
  billing is prorated.
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

After retiring the four custom-metric alarms, **automatic AWS-side detection is lost for**
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

The sync and erasure DLQ metrics remain visible in Windsor Grafana. The source
queue depth and age alerts use CloudWatch data delayed by 10 minutes plus up to
five minutes of scrape wait. The operator accepts that latency and visual-only
DLQ monitoring; alert delivery and independent dead-man verification remain
technical debt tracked in Windsor-app #1992.

## Deployment, verification and rollback

1. Review the CloudFormation change set. It must **delete exactly**
   `DlqAlarm`, `ErasureDlqAlarm`, `SourceQueueAgeAlarm`, and
   `SourceQueueDepthAlarm`;
   retain all four `AWS::Logs::MetricFilter` resources and all 7 other
   `AWS::CloudWatch::Alarm` resources. Do not modify the SNS topic, queue
   definitions, DynamoDB capacity, Lambda code or IAM access.
2. Deploy the approved change from the normal GitHub Actions/SAM pipeline.
   Do not delete alarms manually: that creates CloudFormation drift and
   alarms can be re-created on future stack deployments.
3. Read back `DescribeStacks`, `DescribeStackResources` and
   `DescribeAlarms`. Verify **7** Todoist production alarms and all
   four unchanged log metric filters. Confirm no unintended resource changes,
   including the watches, erasure workers and DLQs.
4. Confirm fresh sync and erasure DLQ series in Grafana and verify the delayed
   source queue alerts remain loaded. Check worker/watch/erasure Lambda errors;
   preserve evidence of notification delivery limitations instead of claiming
   health from a green alarm alone.
5. Roll back by restoring the four SQS alarm definitions in CloudFormation
   and redeploying the prior reviewed template. Confirm alarm actions after
   restoration.
6. Compare CloudWatch usage by `AlarmMonitorUsage` and
   `MetricMonitorUsage` over a complete future billing month, excluding
   misleading tax and partial-month estimates.

Changes to actual metrics, metric filters or monitoring coverage require
separate review. The four named filters are retained in this change.
