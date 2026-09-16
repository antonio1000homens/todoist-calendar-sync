# Profile lookup index rollout

The worker must not scan the state table to list profile mappings or recurrence links. `ProfileLookupIndex` uses:

```text
lookupPk = PROFILE#<profile>
lookupSk = MAPPING#TASK#<taskId>       # reconciliation mappings
lookupSk = RECURRENCE#<seriesId>       # recurrence links
```

Mapping and recurrence writes populate these attributes in the same transaction/write as the canonical item. The production table keeps its existing primary key, `DeletionPolicy: Retain`, and `UpdateReplacePolicy: Retain`; the GSI is additive and does not replace the table.

## Rollout

1. Deploy the indexed write path and GSI capacity/monitoring changes, confirm the existing `ProfileLookupIndex` is `ACTIVE`, and leave the readiness marker absent.
2. Wait at least five minutes (the WorkerFunction timeout) so invocations running the pre-index-attribute write path have drained. New invocations already populate `lookupPk`/`lookupSk` on every eligible write.
3. Run `npm run build` followed by `AWS_PROFILE=default AWS_REGION=eu-west-2 STATE_TABLE_NAME=<table> node scripts/backfill-profile-lookup-index.mjs --confirm-writers-drained`.
4. The migration requires an explicit `STATE_TABLE_NAME`; it never defaults to production. It uses 25-item scan/query pages, paces scan pages, retries throttling with bounded exponential backoff, refuses to overwrite partial/conflicting lookup attributes, and requires the source item to still exist before adding index fields.
5. The migration performs catch-up passes until a stable pass makes no updates and has no conditional races. It then verifies the exact set of expected lookup identities against the GSI before writing `SYSTEM#PROFILE_LOOKUP_INDEX / READY`.
6. Until the marker is written, worker lookups use the labelled `scan_fallback` path. Once it is written, normal mapping and recurrence reads use `Query` only. Profile-index query pages are bounded and paced centrally by the shared DynamoDB client.
7. Compare query results, lookup pages/duration, worker duration, queue age, Lambda throttles and DynamoDB/GSI throttle metrics over equivalent scheduled cycles.

The backfill is idempotent. Its conditional updates cannot recreate a row deleted after a scan page was read, and they cannot overwrite newer lookup attributes. If the script cannot reach a stable pass or exact GSI parity, the ready marker is not written and the existing scan fallback remains active.

## GSI capacity and alarms

`ProfileLookupIndex` is independently provisioned. The default is 10 RCU / 10 WCU rather than 5 / 5 because a mapping write projects three mapping rows into the index. The values remain explicit CloudFormation parameters so they can be tuned from measured production traffic.

The shared DynamoDB client bounds `ProfileLookupIndex` query pages to the configured 25-item page limit and paces multi-page reads to 5 RCU/second by default. Standard AWS SDK retries remain enabled. CloudWatch alarms monitor GSI-specific read/write throttles and read/write utilization using both the `TableName` and `GlobalSecondaryIndexName` dimensions; table-only alarms do not cover index throttles.

## Legacy routine audit mitigation

The index removes the long-term dependency on table size. A separate cleanup is therefore optional to the index rollout and must not be hidden inside deployment. `scripts/cleanup-routine-audit.mjs` is preview-only by default and requires an explicit `STATE_TABLE_NAME` in both preview and apply modes:

```text
STATE_TABLE_NAME=<table> node scripts/cleanup-routine-audit.mjs
STATE_TABLE_NAME=<table> node scripts/cleanup-routine-audit.mjs --apply
```

This is intentionally a full-table administrative scan: DynamoDB evaluates every table item and the `AUDIT#` filter only controls which rows are returned as candidates. The script classifies returned audit actions with the current audit policy, deletes only routine actions in batches of 5, retries unprocessed/throttled deletes with exponential backoff, and never selects significant/unknown actions. Capture the preview and before/after table/worker measurements before using `--apply`. No production cleanup is performed automatically by this code change.

Administrative/intervention-policy and project-comment migration scans remain outside the worker hot path and are intentionally retained as labelled admin/migration operations until separately redesigned.
