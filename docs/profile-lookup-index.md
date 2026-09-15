# Profile lookup index rollout

The worker must not scan the state table to list profile mappings or recurrence links. `ProfileLookupIndex` uses:

```text
lookupPk = PROFILE#<profile>
lookupSk = MAPPING#TASK#<taskId>       # reconciliation mappings
lookupSk = RECURRENCE#<seriesId>       # recurrence links
```

Mapping and recurrence writes populate these attributes in the same transaction/write as the canonical item. The production table keeps its existing primary key, `DeletionPolicy: Retain`, and `UpdateReplacePolicy: Retain`; adding the GSI does not replace the table.

## Rollout

1. Deploy the additive GSI and leave the readiness marker absent.
2. Run `npm run build` followed by `AWS_PROFILE=default AWS_REGION=eu-west-2 STATE_TABLE_NAME=<table> node scripts/backfill-profile-lookup-index.mjs`.
3. The backfill updates only missing `lookupPk`/`lookupSk` attributes, in 25-item scan pages, and verifies query parity before writing `SYSTEM#PROFILE_LOOKUP_INDEX / READY`.
4. Until the marker is written, worker lookups use the labelled `scan_fallback` path. Once it is written, normal mapping and recurrence reads use `Query` only.
5. Compare query results, lookup pages/duration, worker duration, queue age, Lambda throttles and DynamoDB throttle metrics over equivalent scheduled cycles.

The backfill is idempotent and its conditional updates cannot overwrite newer lookup attributes. If verification fails, the ready marker is not written and the existing scan fallback remains active.

## Legacy routine audit mitigation

The index removes the long-term dependency on table size. A separate cleanup is therefore optional to the index rollout and must not be hidden inside deployment. `scripts/cleanup-routine-audit.mjs` is preview-only by default:

```text
node scripts/cleanup-routine-audit.mjs
node scripts/cleanup-routine-audit.mjs --apply
```

It scans only `AUDIT#` items, classifies actions with the current audit policy, deletes only routine actions in batches of 25, retries unprocessed deletes with exponential backoff, and never selects significant/unknown actions. Capture the preview and before/after table/worker measurements before using `--apply`. No production cleanup is performed automatically by this code change.

Administrative/intervention-policy and project-comment migration scans remain outside the worker hot path and are intentionally retained as labelled admin/migration operations until separately redesigned.
