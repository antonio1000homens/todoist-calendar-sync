# Production E2E acceptance

The manually triggered **Production E2E** workflow exercises the deployed sync worker through real Google Calendar and Todoist APIs. It is scoped to the `antonio` profile, checks that the configured Todoist project is `antonio1000homens`, verifies the configured Calendar is listed with write access, and always cleans up captured fixture IDs. Home and work are never selected for disposable acceptance fixtures.

The workflow uses the protected production environment, GitHub OIDC, production SSM credentials, and the production sync DLQ. No database correlation lookup is used as acceptance evidence.

## Current automated journey

The runner creates uniquely named fixtures at bounded future times and polls the live providers for each worker result:

1. Create a one-off Calendar event; verify the Todoist task and provider-native correlation.
2. Edit that Todoist task's title and due time; verify the same Calendar event changes.
3. Delete the Calendar event; verify Todoist and provider correlation cleanup.
4. Create a one-off Todoist task; verify its Calendar projection and correlation, then delete it and verify cleanup.
5. Create a recurring Todoist task; verify a native Calendar master and project-comment correlation, then delete the task and verify series cleanup.
6. Create a daily recurring Calendar series; verify its native Todoist task, provider metadata and project comment. Move and rename a future Calendar occurrence, cancel the next occurrence, and verify the current Todoist task stays unchanged. Complete two occurrences and verify the same task ID applies the moved occurrence, skips the cancellation and returns to cadence while preserving recurrence. Delete the series and verify both projections and correlation are removed.
7. Compare production DLQ depth before and after the run; fail if it increases.

Raw Calendar `extendedProperties.shared` and paginated Todoist project comments are read back directly. Result artifacts contain profile, outcome, cleanup status and sanitized error categories; fixture IDs and personal content are omitted.

## Run and results

The workflow is intentionally separate from pull-request CI because it writes disposable objects to production. Its inputs select only `antonio` and a bounded timeout; cleanup cannot be disabled. The job summary and uploaded `e2e-result.json` provide machine-generated evidence.

The same harness can run from an authenticated environment after building the provider client:

```bash
npm ci
npm run build
node scripts/production-e2e.mjs --profile antonio --timeout-seconds 180 --cleanup true
```

Required environment includes AWS credentials and region, `SYNC_PROFILE_CONFIG_JSON`, `SYNC_DLQ_URL`, and the configured Google and Todoist SSM parameter prefixes when they differ from the defaults.

## Failure cleanup

The runner attempts targeted cleanup on any failure using only fixture IDs captured during that run. If the workflow is interrupted outside the runner, inspect only the unique `[E2E gh-…]` fixtures in the configured antonio Calendar and Todoist project and remove those exact objects. Do not use the runner against home or work.

This journey is one part of issue #510's acceptance. The live exception matrix, repeated full reconciliation, production conflict cleanup, and final state-store removal still need to pass before the issue is complete.
