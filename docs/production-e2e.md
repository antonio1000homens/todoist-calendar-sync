# Production E2E journey

The repository includes a manually triggered GitHub Actions workflow named **Production E2E**. It exercises the deployed production synchronization path against real Google Calendar and Todoist provider APIs.

The workflow is intentionally not part of pull-request CI. It uses the protected `production` environment, GitHub OIDC, production SSM credentials, and disposable provider objects.

## Journey

For each selected profile (`home`, `antonio`, `work`, or all three sequentially), the workflow performs:

```text
Google Calendar
  create disposable timed event
      ↓ Google watch
Cloudflare Calendar Worker
      ↓
AWS ingress Lambda
      ↓
SQS FIFO
      ↓
Worker Lambda
      ↓
Todoist
  verify exactly one mirrored task
      ↓
DynamoDB
  verify eventId ↔ taskId durable mapping
      ↓
Todoist
  change title and due time on the same task
      ↓ Todoist webhook
AWS ingress → SQS → Worker
      ↓
Google Calendar
  verify the same event ID was updated
      ↓
DynamoDB
  verify the mapping still points to the same pair
      ↓
Google Calendar
  delete the disposable event
      ↓ Google watch
AWS ingress → SQS → Worker
      ↓
Todoist
  verify the mirrored task is deleted
      ↓
DynamoDB
  verify the mapping is removed
```

The runner also captures the DLQ depth before and after the journey. The run fails if the DLQ depth increases.

## One-time IAM bootstrap

The existing GitHub deployment role already has the SSM, CloudFormation and SQS read permissions needed by the test, but the E2E runner also verifies the actual DynamoDB mapping with `dynamodb:GetItem`.

After merging the E2E implementation, rerun the normal deployment-role bootstrap once with the same privileged AWS identity and environment used when the role was originally created:

```bash
AWS_REGION=eu-west-2 \
CODE_BUCKET=<artifact-bucket> \
SAM_CLI_MANAGED_SOURCE_BUCKET_NAME=<sam-managed-bucket> \
bash infrastructure/bootstrap-deployment-role.sh
```

The bootstrap now deploys a second small IAM policy stack named `todoist-calendar-sync-github-actions-e2e-access`. It adds only read-only `dynamodb:GetItem` access to the canonical and legacy sync state-table name prefixes. It does not grant mutation access to production state.

## Triggering the test

From GitHub:

1. Open **Actions**.
2. Select **Production E2E**.
3. Choose **Run workflow**.
4. Select a profile. `antonio` is the default; `all` runs `home`, `antonio`, and `work` sequentially.
5. Leave the timeout at 180 seconds unless provider delivery is unusually slow.
6. Leave cleanup enabled for normal runs.

The protected `production` environment remains the safety boundary, so any configured environment approval rules still apply.

## Result and evidence

The workflow writes a job summary and uploads `e2e-result.json` for 14 days. The result records only non-secret diagnostics such as profile, Calendar event ID, Todoist task ID, cleanup state and DLQ depth.

Success proves the following deployed behavior in one journey:

- real Calendar watch delivery through Cloudflare and AWS;
- Calendar → Todoist creation;
- durable DynamoDB mapping creation;
- real Todoist webhook delivery;
- Todoist → Calendar update of the same event rather than duplicate creation;
- stable event/task identity across the round trip;
- Calendar → Todoist deletion propagation;
- durable mapping cleanup;
- no increase in DLQ depth during the test.

## Failure cleanup

With cleanup enabled, the runner attempts direct provider cleanup if any assertion fails. Cleanup errors are reported separately and do not hide the original E2E failure.

If a run is interrupted outside the runner (for example, a cancelled GitHub Actions job), search both providers for titles beginning with `[E2E gh-` and remove the disposable items. Normal reconciliation should then repair any remaining mapping state.

## Local/operator execution

The same harness can be run from an authenticated operator shell after setting the production routing and resolved resource environment variables:

```bash
npm ci
npm run build
node scripts/production-e2e.mjs --profile antonio --timeout-seconds 180 --cleanup true
```

Required runtime environment:

- `AWS_REGION` and AWS credentials able to read the required SSM parameters;
- `SYNC_PROFILE_CONFIG_JSON`;
- `STATE_TABLE_NAME`;
- `SYNC_DLQ_URL`;
- optionally `GOOGLE_CREDENTIALS_PARAMETER_PREFIX` and `TODOIST_TOKEN_PARAMETER_PREFIX` when not using the canonical SSM prefixes.
