# Production rename: `gcp-app2-sync` to `todoist-calendar-sync`

This runbook completes the production identity change after the standalone repository deployment has been proven. It intentionally separates **configuration**, **CloudFormation ownership**, and **physical-resource replacement**. Do not combine them into one deployment.

## Safety properties

- Never run two workers that can mutate the same Calendar/Todoist state at the same time.
- Never delete the legacy DynamoDB table as part of a naming change.
- The canonical SSM hierarchy must be populated before any runtime switches to it.
- The source FIFO queue must be drained before ownership/physical-resource cutover.
- Every destructive step requires a fresh backup and an explicit operator action.
- `scripts/preflight-production-rename.sh` is read-only and must pass before cutover.

## Desired end state

```text
repository/service:       todoist-calendar-sync
CloudFormation stack:     todoist-calendar-sync
resource prefix:          todoist-calendar-sync
SSM project prefix:       /todoist-calendar-sync
SAM artifact prefix:      todoist-calendar-sync/sam
OIDC deploy role:         GitHubActionsTodoistCalendarSyncDeployRole
```

The shared Slack bot token remains at `/lambdas/shared/slack-bot-token` because it is shared infrastructure, not an application-owned secret.

## Phase 1 — bootstrap canonical secret hierarchy

Preview:

```bash
AWS_REGION=eu-west-2 bash scripts/migrate-ssm-prefix.sh --dry-run
```

Copy the nine project-specific `SecureString` parameters:

```bash
AWS_REGION=eu-west-2 bash scripts/migrate-ssm-prefix.sh
```

The script never deletes the legacy hierarchy and never prints plaintext values.

## Phase 2 — update the deployment role

Use a privileged/bootstrap AWS identity:

```bash
AWS_REGION=eu-west-2 bash infrastructure/bootstrap-deployment-role.sh
```

During the cutover the role deliberately permits both the canonical and legacy resource prefixes. It has read-only SSM access and must not receive `ssm:PutParameter`.

After the cutover is complete, remove the legacy resource/SSM permissions in a follow-up tightening change.

## Phase 3 — compatibility deployment to the existing stack

Before changing stack ownership or physical names, deploy the current application to the existing stack while retaining the old physical resource prefix.

Configure the protected GitHub `production` environment temporarily with:

```text
STACK_NAME=gcp-app2-sync
RESOURCE_NAME_PREFIX=gcp-app2-sync
SSM_PREFIX=/todoist-calendar-sync
TODOIST_CALENDAR_SYNC_SLACK_CHANNEL=<production Slack channel ID>
SYNC_PROFILE_CONFIG_JSON=<production profile routing JSON>
```

`SYNC_PROFILE_CONFIG_JSON` contains identifiers/routing configuration, not provider secrets. It must contain `home`, `antonio`, and `work` objects with `calendarId`, `channelId`, `todoistRoute`, and `todoistProjectId`.

Run the production deployment and verify both directions of synchronization. This proves the canonical source/runtime configuration independently of the AWS naming migration.

## Phase 4 — preflight and freeze

Run:

```bash
AWS_REGION=eu-west-2 bash scripts/preflight-production-rename.sh
```

The preflight requires:

- legacy stack in a stable `*_COMPLETE` state;
- DynamoDB table `ACTIVE`;
- DynamoDB deletion protection enabled;
- PITR enabled;
- all nine canonical SSM parameters present;
- source FIFO queue drained.

Before the actual cutover, stop new ingress at the external proxy/provider layer or otherwise prevent new deliveries, then wait for the source queue to drain and rerun the preflight.

Create an explicit DynamoDB on-demand backup and retain its ARN in the migration log:

```bash
aws dynamodb create-backup \
  --region eu-west-2 \
  --table-name <legacy-state-table> \
  --backup-name todoist-calendar-sync-pre-rename
```

Do not continue until the backup reports `AVAILABLE`.

## Phase 5 — transfer CloudFormation ownership

CloudFormation stack names cannot be renamed in place. Prefer **CloudFormation stack refactoring** to transfer existing resources to a new stack named `todoist-calendar-sync` while preserving their data and physical properties.

Stack refactoring is an ownership/organization operation only. Do not change resource properties, parameters, conditions, or physical names in the same refactor.

Use CloudFormation's refactor preview first:

```bash
aws cloudformation create-stack-refactor \
  --region eu-west-2 \
  --stack-definitions \
    StackName=gcp-app2-sync,TemplateBody@=file://<legacy-refactor-template.yaml> \
    StackName=todoist-calendar-sync,TemplateBody@=file://<target-refactor-template.yaml> \
  --enable-stack-creation
```

Then inspect the returned refactor ID:

```bash
aws cloudformation describe-stack-refactor --stack-refactor-id <id>
aws cloudformation list-stack-refactor-actions --stack-refactor-id <id>
```

Do **not** execute unless the action list contains only the intended resource moves/renames and no unexpected resources.

If CloudFormation reports unsupported resource types, stop. Use the documented resource-import path for supported stateful resources and recreate only stateless resources. Do not force a partial refactor that leaves unclear ownership.

When the preview has been independently reviewed:

```bash
aws cloudformation execute-stack-refactor --stack-refactor-id <id>
```

Verify the refactor completes before any later update.

## Phase 6 — physical resource names

After stack ownership is canonical, change physical names separately.

### Stateful DynamoDB table

The DynamoDB table is the durable source of mappings, sync tokens, reconciliation state and decision state. It cannot simply be renamed.

Preferred approach:

1. Keep ingress frozen and queue drained.
2. Create/verify a final source-table backup.
3. Restore the backup to a **new** table named `todoist-calendar-sync-state-production`.
4. Reapply/verify TTL, PITR, deletion protection, throughput, tags and any policies that are not restored automatically.
5. Bring the restored table under the canonical CloudFormation stack using a supported CloudFormation import operation.
6. Update the application to the canonical table only after item counts and representative state records have been verified.
7. Keep the legacy table retained until the complete production smoke test has passed and rollback is no longer required.

A DynamoDB restore always creates a new table; do not delete the source table first.

### Queues, functions, rules, alarms and log groups

These are stateless or transient but still require ordered cutover:

1. ensure old queue is drained;
2. create canonical resources while the old worker is disabled;
3. update ingress/proxy/provider callback targets to the canonical Lambda URL where needed;
4. enable exactly one worker/event-source path;
5. verify alarms, EventBridge reconciliation and the manual Slack path;
6. only then remove retained legacy stateless resources.

There must never be two active synchronizers mutating the same provider state.

## Phase 7 — switch protected GitHub deployment configuration

After the canonical stack/resources are live:

```text
STACK_NAME=todoist-calendar-sync
RESOURCE_NAME_PREFIX=todoist-calendar-sync
SSM_PREFIX=/todoist-calendar-sync
TODOIST_CALENDAR_SYNC_SLACK_CHANNEL=<production channel ID>
SYNC_PROFILE_CONFIG_JSON=<production profile routing JSON>
```

Run a normal deployment. It must update/no-op the canonical stack, not recreate the legacy stack.

## Phase 8 — production verification

Verify all of the following before removing legacy resources:

- Calendar webhook ingress;
- Todoist webhook ingress;
- all configured sync profiles;
- Calendar → Todoist mutation;
- Todoist → Calendar mutation;
- recurrence behavior;
- reconciliation;
- FIFO ordering;
- DLQ and alarms;
- manual Slack intervention;
- DynamoDB mappings/state retained;
- canonical SSM parameter reads;
- canonical CloudWatch logs/metrics.

## Phase 9 — retire legacy identity

Only after the canonical service has been stable and rollback is no longer required:

- remove the old CloudFormation stack/resources that are no longer owned/needed;
- remove `/lambdas/gcp-app2-sync/*` project parameters;
- remove legacy IAM resource-prefix permissions from the deploy role;
- remove `gcp-app2-sync` deployment ownership from the `lambdas` repository;
- remove legacy GitHub environment variable names;
- keep only deliberately documented historical mentions of `gcp-app2-sync`.

## Rollback

Before the legacy table/resources are removed, rollback means:

1. freeze ingress;
2. disable canonical worker/event source;
3. restore deployment configuration to the retained legacy stack/resource prefix;
4. ensure canonical writes have not diverged from the retained legacy state table; if they have, restore from the migration backup or reconcile state deliberately rather than guessing;
5. re-enable one legacy worker path;
6. smoke test before reopening ingress.

Never enable old and new workers simultaneously as a rollback shortcut.
