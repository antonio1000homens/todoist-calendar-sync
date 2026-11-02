# CloudWatch alarm cost and coverage

This inventory covers the production alarms declared by `template.yaml`. PR
#261 removed four two-metric DynamoDB utilization alarms; this follow-up removes
four SQS alarms for source-queue depth/age and sync/erasure DLQs. The stack will
retain 11 CloudWatch alarms for worker errors, erasure safety state, Calendar
watch health and table/GSI throttles. Windsor Prometheus/Grafana continues to
collect queue metrics and now includes both DLQs. The source queue alerts use a
10-minute CloudWatch data delay plus up to five minutes of scrape wait; the
operator explicitly accepts this latency and the remaining delivery/dead-man
verification work as technical debt tracked under Windsor-app #1992.

Removing alarms does not stop CloudWatch metric publication or the exporter’s
`GetMetricStatistics` polling; it reduces alarm usage only. The D1 dead-man
monitor and CloudWatch SNS subscription remain unverified. Do not read this
change as proof that critical SNS delivery is working.

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
| `dlq-not-empty` | Sync DLQ has visible message / critical | AlertTopic | The sync DLQ depth is shown in the Windsor Grafana dashboard; no CloudWatch alert remains. | 1 standard alarm metric | Remove; Grafana panel retained |
| `erasure-dlq-not-empty` | Erasure DLQ has visible message / critical | AlertTopic | The erasure DLQ depth is added to the Windsor exporter and Grafana panel by PR #1993; no CloudWatch alert remains. | 1 standard alarm metric | Remove; Grafana panel added |
| `erasure-worker-errors` | Erasure worker Lambda error / critical | AlertTopic | Detects executor invocation failures before relying on DLQ state. | 1 standard alarm metric | Keep |
| `erasure-review-required` | Erasure entered review-required / critical safety | AlertTopic | Requires operator review; not interchangeable with a Lambda error or DLQ. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `erasure-recovery-blocked` | Erasure recovery stopped on drift / critical safety | AlertTopic | Preserves visibility of a safety fence; no equivalent signal. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `watch-renewal-failures` | Calendar watch replacement failed / high | AlertTopic | Direct renewal failure signal; a later missing-watch check is not timely equivalent coverage. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `watch-missing` | Watch check found absent persisted watch / high | AlertTopic | Detects a missing watch even if no renewal failure was emitted. | 1 alarm metric on a log-filter custom metric; custom metric charges are separate | Keep |
| `watch-errors` | Watch Lambda invocation error / high | AlertTopic | Covers failures outside the structured renewal-failure event path. | 1 standard alarm metric | Keep |
| `source-oldest-message` | Oldest sync message over five minutes / high | AlertTopic | Prometheus has the equivalent threshold, but its CloudWatch data is delayed by 10 minutes plus up to five minutes of scrape wait. | 1 standard alarm metric | Remove; latency accepted as tech debt |
| `source-depth` | More than 100 visible sync messages for two periods / high | AlertTopic | Prometheus has a companion alert for sustained source depth with exporter-health gating; it is delayed. | 1 standard alarm metric | Remove; latency accepted as tech debt |
| `dynamodb-read-throttles` | State-table read throttling / high | AlertTopic | Actual capacity failure signal for table reads. | 1 standard alarm metric | Keep |
| `dynamodb-write-throttles` | State-table write throttling / high | AlertTopic | Actual capacity failure signal for table writes. | 1 standard alarm metric | Keep |
| `profile-lookup-read-throttles` | ProfileLookupIndex read throttling / high | AlertTopic | GSI capacity is independent of table capacity; table throttle alarm does not cover it. | 1 standard alarm metric | Keep |
| `profile-lookup-write-throttles` | ProfileLookupIndex write throttling / high | AlertTopic | GSI capacity is independent of table capacity; table throttle alarm does not cover it. | 1 standard alarm metric | Keep |
| `dynamodb-read-utilization` | Table read capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |
| `dynamodb-write-utilization` | Table write capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |
| `profile-lookup-read-utilization` | GSI read capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual GSI throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |
| `profile-lookup-write-utilization` | GSI write capacity above 80% for two minutes / warning | AlertTopic | Early warning only; actual GSI throttles and sustained queue age/depth remain paged. Review consumed and provisioned capacity in the operator check. | 2 standard-resolution metrics in a math alarm | Remove |

The four utilization alarms removed by #261 each listed two underlying metrics in a metric-math
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

The inventory falls from 15 to 11 CloudWatch alarms. Four removed SQS alarms
represent up to four standard alarm-metric units (nominally up to about $0.40
per full month at $0.10 per unit before shared Free Tier and proration). The
October Cost Explorer baseline predates these removals and does not prove
realized savings. Metric collection continues, so GetMetricStatistics request
usage is unchanged except for the additional erasure-DLQ Grafana series.

## Failure coverage after the change

| Failure condition | Detection retained | Route | Coverage status |
| --- | --- | --- | --- |
| Sync worker fails | `worker-errors` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Sync delivery is quarantined | Grafana `Dead-letter queues` panel, sync DLQ series | Windsor Prometheus/Grafana | Visual depth monitoring only; no page; operator accepts this tradeoff |
| Erasure operation exhausts retries | Grafana `Dead-letter queues` panel, erasure DLQ series | Windsor Prometheus/Grafana | Visual depth monitoring only; no page; exporter series added in PR #1993 |
| Erasure executor fails | `erasure-worker-errors` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Erasure requires human review | `erasure-review-required` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Erasure recovery is blocked by drift | `erasure-recovery-blocked` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Calendar watch renewal fails | `watch-renewal-failures` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Calendar watch state is missing | `watch-missing` | AlertTopic | Alarm and metric filter retained; delivery needs SNS subscriber verification |
| Watch Lambda invocation fails | `watch-errors` | AlertTopic | Alarm retained; delivery needs SNS subscriber verification |
| Sync FIFO queue is aging | `TodoistSourceQueueOldestMessageAgeHigh` | Windsor Prometheus/Alertmanager | Delayed by the 10-minute exporter delay plus up to five-minute scrape wait; faster AWS alarm removed by operator decision |
| Sync FIFO queue has sustained backlog | `TodoistSourceQueueDepthHigh` | Windsor Prometheus/Alertmanager | Delayed by the 10-minute exporter delay plus up to five-minute scrape wait; faster AWS alarm removed by operator decision |
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
changing provisioned throughput. Actual throttle alarms remain automatic. The
source queue depth/age Prometheus alerts remain automatic but are materially
delayed by CloudWatch collection.

## Deployment and rollback plan

Do not disable alarms directly in the console. Merge and deploy the template
change through the normal stack pipeline, then:

1. Review the CloudFormation change set: it must delete exactly `DlqAlarm`,
   `ErasureDlqAlarm`, `SourceQueueAgeAlarm`, and `SourceQueueDepthAlarm`; retain
   the other 11 alarms, SNS topic, metric filters, queues and throughput values.
2. Confirm the AWS stack has 11 metric alarms after update. Do not send a
   synthetic SNS message: the topic currently has no subscriptions and no
   approved recipient is configured.
3. Confirm Windsor Grafana shows fresh sync and erasure DLQ series and that the
   source-depth/age Prometheus alerts remain loaded. Missing/failed collection
   must appear as unknown, not zero.
4. Record that source queue detection is now delayed by the exporter and that
   CloudWatch SNS recipient verification plus independent dead-man delivery
   remain technical debt in Windsor-app #1992. No production queue failure is
   needed to verify these metrics.
5. Roll back by restoring the four alarm resources and redeploying the stack if
   the Grafana DLQ series is unavailable or delayed queue alerting proves
   unacceptable. Compare `EUW2-CW:AlarmMonitorUsage` after a full billing cycle.

Source validation and a synthetic SNS route test do not prove that every
critical failure event can be safely generated in production. Keep the
per-signal template regression checks and review actual event coverage during
normal operations.
