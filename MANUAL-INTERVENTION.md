# todoist-calendar-sync manual intervention

Issue #49 adds a human-in-the-loop control plane for sync decisions that are unsafe to guess automatically.

## Safety model

- Slack is only an authenticated control surface.
- `aws2022-slack-handler` verifies Slack signatures and enqueues a typed `kind: manual` delivery.
- Manual deliveries use `sync:<profile>`, the same FIFO message group as webhooks and reconciliation.
- Provider changes are executed only by the normal todoist-calendar-sync worker.
- The worker re-reads mapping/provider state before applying a decision. A stale decision is closed without mutation.
- Destructive Slack buttons require confirmation.
- A remembered default is not the same thing as unattended execution.
- Only catalog actions explicitly marked `autoAllowed` can be configured in `auto` mode.
- Highly destructive actions such as deleting a whole recurrence or deleting this-and-future may be remembered as defaults but cannot be auto-applied.
- Bulk "this and future" recurrence deletion is capped at ten Calendar instance mutations. Larger scopes are refused and require the series-level delete option or a narrower recurrence.
- Normal `maxReceiveCount: 1`, worker concurrency `1`, circuit breaker and reconciliation coalescing remain unchanged.

## Durable decisions

Pending decisions are stored in the existing state table under:

```text
MANUAL#<decisionId> / STATE
```

They include profile, decision type, provider/mapping identifiers, a state fingerprint, permitted actions, effective policy metadata, Slack message location, resolution metadata and TTL.

Decision IDs are deterministic for the state that produced them. Repeated reconciliation/audit events therefore reuse a pending decision instead of posting duplicate prompts.

## Intervention policy registry

Detector response policy is stored independently of decision state in the same DynamoDB table. Policies are persistent and have no TTL.

```text
POLICY#GLOBAL#<decisionType> / STATE
POLICY#PROFILE#<profile>#<decisionType> / STATE
POLICY#SERIES#<profile>#<seriesId>#<decisionType> / STATE
```

Policy lookup precedence is:

```text
series -> profile -> global -> catalog default
```

This means a particular recurring series can override its profile, while a profile can override a global preference.

### Response modes

Each live detector can use one of four modes:

| Mode | Behaviour |
|---|---|
| `off` | Detector is disconnected. Existing/legacy synchronizer behaviour continues. Use deliberately because a pre-mutation detector no longer protects that event. |
| `observe` | Detector runs and records the condition but does not post Slack or mutate provider state. For pre-mutation ambiguity this safely blocks the legacy mutation. |
| `prompt` | Create/reuse a durable decision and ask in Slack. A saved `defaultAction` is shown as **Apply saved default**, but the user still approves it. |
| `auto` | Create/reuse a durable decision and enqueue the saved action back through `sync:<profile>`. Only `autoAllowed` catalog actions may use this mode. |

`auto` never invokes an executor directly from Slack or from a detector. It enqueues a normal manual delivery so the decision executes after current profile work and goes through the same stale-state validation as a button click.

### Executor model

Executors remain deployed and are not individually connected/disconnected. They are callable only through a valid pending decision whose permitted action list includes the requested action.

This avoids creating Slack decisions which later cannot be resolved because an executor was disabled. Policy controls whether the detector is active and how its decision is handled; the executor remains protected behind decision validation.

### Saved default versus auto-apply

After resolving a prompted decision, Slack offers policy buttons such as:

- **Default for profile**;
- **Default for series** when a series ID exists;
- **Auto-apply for profile** when the selected action is marked auto-safe;
- **Auto for series** when applicable;
- **Always ask**.

A saved default stores `mode=prompt` plus `defaultAction`. The next matching card highlights the preference and offers **Apply saved default**. Destructive defaults still use the normal second confirmation.

An auto preference stores `mode=auto` plus `defaultAction`. The matching detector creates a durable decision and queues that action through the normal FIFO lane. The worker reports the automatic resolution to Slack after it completes.

Current auto-safe examples include restoring a deleted Todoist mirror, skipping a single Calendar-owned occurrence, keeping a Todoist-owned Calendar series while unlinking it, and requesting another reconciliation. Whole-series deletion and this-and-future deletion are intentionally not auto-safe.

## Actively connected decision detectors

### Pre-mutation Todoist deletion

An explicit Todoist deletion is intercepted before the synchronizer mutates Calendar when a mapping still exists.

This covers:

- Calendar-owned recurring mirrors;
- Todoist-owned recurring projections;
- standalone mapped tasks.

Internal mirror replacement does not prompt because those flows remove mapping ownership before deleting the old Todoist task.

### Conflict audits

The worker observes the normal durable audit stream and creates manual decisions for conflict/no-mutation outcomes including:

- `calendar_snapshot_unmapped_ambiguous`;
- `calendar_snapshot_recurring_ambiguous`;
- `todoist_snapshot_reconcile_conflict_both_sides_changed`;
- reconciliation mutation-budget exhaustion;
- circuit-open/deferred reconciliation.

Provider authentication failures and deliveries about to be quarantined can also generate operational decisions.

The typed catalog in `src/manual-intervention.ts` includes the wider use-case map from issue #49 so new detectors can be connected without adding Slack-specific conditionals. Each action can separately declare whether it is eligible for unattended auto policy.

## Calendar-owned recurrence deletion choices

When the current Todoist mirror is explicitly deleted, Slack offers:

- **Skip this occurrence** — deletes the mapped Calendar instance, advances to the next active instance and creates the next Todoist mirror.
- **Delete this and future** — removes mapping ownership first, then cancels active/future instances, bounded to ten mutations.
- **Delete whole Calendar series** — removes mapping/recurrence ownership before deleting the Calendar master.
- **Restore Todoist task** — recreates the Todoist mirror from the current Calendar occurrence and rewrites mapping ownership.

Every action requests the normal durable reconciliation path after resolution.

## Ambiguous snapshot matches

For an unmapped Calendar event/recurrence with multiple canonical Todoist matches, the Slack card is enriched with current candidates. The user can:

- bind a specific still-unowned canonical task; or
- create a new Todoist task.

The worker rechecks that the Calendar event is still unmapped, the selected task is still canonical and it has not acquired another owner before binding it.

Dynamic candidate actions such as `bind_task:<id>` cannot be saved as persistent policy defaults because provider IDs are decision-specific. Only stable catalog actions may be stored in policy.

## Both-sides-changed conflicts

For `todoist_snapshot_reconcile_conflict_both_sides_changed`, Slack supports:

- **Use Calendar version** — update the mapped Todoist task from Calendar;
- **Use Todoist version** — update the mapped Calendar event from Todoist.

The mapping must still point to the same provider IDs when the decision executes. These conflict-winner actions are not auto-safe by default.

## Operator commands

Configure the Slack app slash command `/sync` against the existing `aws2022-slack-handler` Function URL.

```text
/sync status <home|antonio|work>
/sync reconcile <home|antonio|work>
/sync conflicts [home|antonio|work]
/sync inspect task <taskId> <profile>
/sync inspect event <eventId> <profile>
/sync inspect decision <decisionId>
/sync resume <profile|decisionId>
/sync policies <home|antonio|work>
/sync policy <profile|global> <decisionType> <off|observe|prompt|auto> [action]
/sync policy series <profile> <seriesId> <decisionType> <off|observe|prompt|auto> [action]
/sync policy reset <profile|global> <decisionType>
/sync policy reset series <profile> <seriesId> <decisionType>
```

Examples:

```text
# Remember restore as the suggested response, but keep asking
/sync policy antonio calendar_owned_recurrence_task_deleted prompt restore_todoist_task

# Auto-restore only for this profile
/sync policy antonio calendar_owned_recurrence_task_deleted auto restore_todoist_task

# Auto-skip a specific recurring series
/sync policy series antonio series-123 calendar_owned_recurrence_task_deleted auto skip_occurrence

# Keep detecting but never mutate or prompt
/sync policy antonio calendar_owned_recurrence_task_deleted observe

# Remove the profile override and inherit global/catalog policy
/sync policy reset antonio calendar_owned_recurrence_task_deleted
```

Global policy changes are serialized through the `antonio` control lane, while all profile/series policies use their own `sync:<profile>` lane. The worker still has reserved concurrency `1`, so policy writes and provider decisions cannot execute concurrently.

`/sync reconcile <profile>` calls the same `requestReconciliation(profile, "manual")` logic used by the scheduled/reactive system. It does not invoke Lambdas directly or grant the deployment role DynamoDB data-plane access.

## Configuration

`todoist-calendar-sync/template.yaml` enables the control plane by default with:

```text
TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED=true
TODOIST_CALENDAR_SYNC_SLACK_CHANNEL=#aws-slack-alerts
SLACK_BOT_TOKEN_PARAMETER=/lambdas/shared/slack-bot-token
```

The worker has read-only SSM access to that bot-token parameter. The token itself is never stored in Lambda environment variables or SQS/DynamoDB payloads.

The Slack handler discovers the existing todoist-calendar-sync `QueueUrl` and `QueueArn` during deployment and receives only `sqs:SendMessage` permission for that queue.
