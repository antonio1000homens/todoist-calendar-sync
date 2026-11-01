# CloudWatch alarm cost and coverage

This inventory covers the production alarms declared by `template.yaml`. The
current CloudFormation template declares 19 alarms. Four two-metric DynamoDB
utilization alarms are removed by this change. The 15 remaining alarms retain
the actionable failure, erasure, watch, throttle, and queue signals. No alarm
resource is disabled or removed from the deployed stack until this template is
deployed.

## Alarm inventory

All retained alarms publish to `todoist-calendar-sync-alerts-production` via
`AlertTopic`. That is the configured action route, not proof that someone is
being paged. A live read on 2026-11-01 found **zero SNS subscriptions** on that
topic. The template creates an email subscription only when
`BillingAlarmEmail` is set, and that subscription must be confirmed. Critical
alert delivery is therefore not currently verified and needs to be fixed and
tested as part of the deployment acceptance gate.

| Alarm (physical suffix) | Signal / severity | Action route | Importance and overlap | Cost classification | Decision |
| --- | --- | --- | --- | --- | --- |
| `worker-errors` | Worker Lambda error / critical | AlertTopic | Direct worker failure detection; DLQ covers messages that exhaust delivery, not every invocation error. | 1 standard alarm metric | Keep |
| `dlq-not-empty` | Sync DLQ has visible message / critical | AlertTopic | Detects quarantined sync deliveries; no equivalent queue-age or Lambda alarm guarantees this signal. | 1 standard alarm metric | Keep |
| `erasure-dlq-not-empty` | Erasure DLQ has visible message / critical | AlertTopic | Detects failed guarded erasure operations; distinct from normal sync failures. | 1 standard alarm metric | Keep |
| `erasure-worker-errors` | Erasure worker Lambda error / critical | AlertTopic | Detects executor invocation failures before relying on DLQ state. | 1 standard alarm metric | Keep |
| `erasure-review-required` | Erasure entered review-required / critical safety | AlertTopic | Requires operator review; not interchangeable with a Lambda error or DLQ. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `erasure-recovery-blocked` | Erasure recovery stopped on drift / critical safety | AlertTopic | Preserves visibility of a safety fence; no equivalent signal. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `watch-renewal-failures` | Calendar watch replacement failed / high | AlertTopic | Direct renewal failure signal; a later missing-watch check is not timely equivalent coverage. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `watch-missing` | Watch check found absent persisted watch / high | AlertTopic | Detects a missing watch even if no renewal failure was emitted. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `watch-errors` | Watch Lambda invocation error / high | AlertTopic | Covers failures outside the structured renewal-failure event path. | 1 standard alarm metric | Keep |
| `source-oldest-message` | Oldest sync message over five minutes / high | AlertTopic | Detects slow processing; queue depth alone does not measure message age. | 1 standard alarm metric | Keep |
| `source-depth` | More than 100 visible sync messages for two periods / high | AlertTopic | Detects sustained FIFO backpressure before messages become old. Complements age alarm. | 1 standard alarm metric | Keep |
| `dynamodb-read-throttles` | State-table read throttling / high | AlertTopic | Actual capacity failure signal for table reads. | 1 standard alarm metric | Keep |
| `dynamodb-write-throttles` | State-table write throttling / high | AlertTopic | Actual capacity failure signal for table writes. | 1 standard alarm metric | Keep |
| `profile-lookup-read-throttles` | ProfileLookupIndex read throttling / high | AlertTopic | GSI capacity is independent of table capacity; table throttle alarm does not cover it. | 1 standard alarm metric | Keep |
| `profile-lookup-write-throttles` | ProfileLookupIndex write throttling / high | AlertTopic | GSI capacity is independent of table capacity; table throttle alarm does not cover it. | 1 standard alarm metric | Keep |
| `dynamodb-read-utilization` | Table read capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |
| `dynamodb-write-utilization` | Table write capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |
| `profile-lookup-read-utilization` | GSI read capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual GSI throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |
| `profile-lookup-write-utilization` | GSI write capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual GSI throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |

The four utilization alarms each list two underlying metrics in a metric-math
expression. [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
says metric alarms are charged per metric in the expression, so their removal
deletes eight alarm-metric units, not merely four units. Metric-math
consolidation would not reduce that count. Composite alarms are also not a
cheaper substitute at this size.

## Cost estimate

The Windsor account's October 2026 Cost Explorer readback in `eu-west-2` showed
`EUW2-CW:AlarmMonitorUsage` at **$0.98808217** and **19.8808217544 usage
quantity**. The observed effective rate is about **$0.0497 per usage unit**.
Removing the eight utilization-alarm metric units therefore projects about
**$0.40 per full month** in savings at that observed rate. This is an estimate:
alarm charges are prorated by active hours, current Free Tier eligibility and
other account alarms affect the bill, and the actual next full billing cycle
must be compared. AWS's pricing page confirms that metric-math alarm costs
scale with the number of listed metrics and that rates shown there are US East
prices; the estimate above uses the live EUW2 billing readback instead.

The alarm count falls from 19 to 15. Retaining 15 alarms is intentional: going
below the 10 standard alarm-metric Free Tier allowance is not a safety target,
and removing any of the remaining alerts would reduce distinct failure or
backpressure coverage. The exact billable total is not inferred from alarm
count alone.

## Failure coverage after the change

| Failure condition | Detection retained | Route | Coverage status |
| --- | --- | --- | --- |
| Sync worker fails | `worker-errors` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Sync delivery is quarantined | `dlq-not-empty` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Erasure operation exhausts retries | `erasure-dlq-not-empty` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Erasure executor fails | `erasure-worker-errors` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Erasure requires human review | `erasure-review-required` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Erasure recovery is blocked by drift | `erasure-recovery-blocked` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Calendar watch renewal fails | `watch-renewal-failures` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Calendar watch state is missing | `watch-missing` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Watch Lambda invocation fails | `watch-errors` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Sync FIFO queue is aging | `source-oldest-message` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Sync FIFO queue has sustained backlog | `source-depth` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| State table read/write throttles | `dynamodb-read-throttles`, `dynamodb-write-throttles` | AlertTopic | Both alarms retained; delivery needs SNS subscriber verification |
| ProfileLookupIndex read/write throttles | `profile-lookup-read-throttles`, `profile-lookup-write-throttles` | AlertTopic | Both alarms retained; delivery needs SNS subscriber verification |
| Capacity nears its provisioned limit before throttling | Daily operator check of consumed/provisioned metrics | Operator runbook | No automatic page; documented as an early-warning tradeoff |

## Lower-cost capacity observation

Use the existing AWS/DynamoDB consumed and provisioned capacity metrics during
the daily operational review. These are standard service metrics. No new custom
metric, alarm, dashboard, or throughput change is introduced. In the CloudWatch
console, inspect `ConsumedReadCapacityUnits` and `ConsumedWriteCapacityUnits`
for the table and `ProfileLookupIndex`, then compare the peaks with the live
provisioned values. For a CLI read of the table's last 24 hours:

```sh
metric_end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
metric_start=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)

AWS_PROFILE=windsor aws dynamodb describe-table --region eu-west-2 \
  --table-name todoist-calendar-sync-state-production \
  --query 'Table.{TableCapacity:ProvisionedThroughput,IndexCapacity:GlobalSecondaryIndexes[?IndexName==`ProfileLookupIndex`].ProvisionedThroughput}'

AWS_PROFILE=windsor aws cloudwatch get-metric-statistics --region eu-west-2 \
  --namespace AWS/DynamoDB --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=todoist-calendar-sync-state-production \
  --statistics Sum --period 300 --start-time "$metric_start" --end-time "$metric_end"

AWS_PROFILE=windsor aws cloudwatch get-metric-statistics --region eu-west-2 \
  --namespace AWS/DynamoDB --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=todoist-calendar-sync-state-production \
  --statistics Sum --period 300 --start-time "$metric_start" --end-time "$metric_end"

AWS_PROFILE=windsor aws cloudwatch describe-alarms --region eu-west-2 \
  --alarm-name-prefix todoist-calendar-sync
```

For index metrics, repeat the two `get-metric-statistics` commands with the
`GlobalSecondaryIndexName,Value=ProfileLookupIndex` dimension added. Compare
five-minute consumed read units to provisioned RCU x 300 and consumed write
units to provisioned WCU x 300. Escalate sustained near-capacity use before
changing provisioned throughput. Actual throttle alarms and source queue age
and depth remain the automatic alerts.

## Deployment and rollback plan

Do not disable alarms directly in the console. Merge and deploy the template
change through the normal stack pipeline, then:

1. Review the CloudFormation change set: it must remove exactly the four
   `*-utilization-production` alarm resources and retain the other 15 alarms,
   SNS topic, metric filters, queue definitions, and throughput settings.
2. Set `BillingAlarmEmail` to the approved operations address through the
   protected deployment configuration, confirm the SNS email subscription,
   and verify `list-subscriptions-by-topic` returns that confirmed endpoint.
   The current production topic has no subscriptions, so this is a required
   alert-delivery fix before declaring production coverage verified.
3. Verify all 15 remaining alarms target the SNS topic and are in expected
   state. Check the eight critical/non-warning classes in the failure matrix.
4. In the same account and region, create a temporary alarm on an isolated
   `TodoistCalendarSync/AlarmTest` metric that targets the production SNS topic.
   Publish one synthetic breaching datapoint, verify the confirmed recipient
   receives it, then delete the temporary alarm. Do not inject failures into
   the worker, queues, or erasure flow to test paging.
5. Record alarm inventory, action routes, SNS delivery, and rollback details.
   Roll back the stack template if a retained resource or action route is
   missing; restore the four utilization alarms only if the capacity review
   demonstrates that operator checks plus throttle alerts are inadequate.
6. After a full billing cycle, compare `EUW2-CW:AlarmMonitorUsage` cost and
   quantity with the October baseline above and refresh this estimate.

Source validation and a synthetic SNS route test do not prove that every
critical failure event can be safely generated in production. Keep the
per-signal template regression checks and review actual event coverage during
normal operations.
