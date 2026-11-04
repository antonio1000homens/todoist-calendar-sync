# Issue 307 — read-only Lambda invoker inventory

This is a source+deployment audit aid, NOT erasure recovery authorisation. It reads
all published Lambda versions, aliases and weighted targets, event-source
mappings in the selected region, resource invocation policies and Function URLs.
It does not call any AWS mutation or invoke providers.

## Run

node scripts/audit-erasure-lambda-invokers.mjs --prefix=todoist-calendar-sync --stage=production --region=eu-west-2 > lambda-inventory.json

The region here is only an example. Run for the actual region, each account,
stage and legacy prefix where these functions might have been deployed. Use an
audit-only AWS role with these read actions: lambda:ListFunctions,
lambda:ListVersionsByFunction, lambda:ListAliases,
lambda:ListEventSourceMappings, lambda:GetPolicy and
lambda:GetFunctionUrlConfig. No Lambda write role is needed.

The repository SAM template supplies the expected function names. The script
fails on incomplete pages or denied policy/URL reads. Missing expected functions
are explicitly reported. The process intentionally exits with status 2 even
after producing a full JSON inventory: read-only inventory is NEVER safety
approval. The output intentionally omits account ARNs, invocation policies,
queues and secret environment variables.

## Still mandatory before release

- Audit the actual deployed code for EVERY returned version and alias, including
  historic published versions that can be invoked directly.
- Audit identity-based IAM permissions, cross-account and direct invokers,
  schedules/EventBridge, Function URLs, legacy physical Lambda names and
  deployments in every region. Resource-based policy reads cannot prove these.
- Verify all provider, DynamoDB and ingress mutation paths, recurrence, webhook,
  DLQ, mapping and source/destination lease protocols against #307's checklist.
- Record reviewed redacted evidence and security signoff before marking the
  first acceptance box complete. An inventory alone is insufficient.
- Independently verify provider/Calendar identity aliases and strong provider
  absence before any future privileged recovery executor can be considered.

### Provider source surface check

`test/erasure-provider-surface-audit.test.mjs` inventories every concrete
`GoogleCalendar` and `Todoist` method and every production provider constructor
site. Each method must be classified as an identity write, provider control
operation, read, or internal helper. The identity-write list is shared by the
replay admission proxy and reconciliation mutation-budget proxy. The exported
`calendarForProfile()` factory now passes through that guard, with a runtime
test proving an erased event is denied before HTTP. Calendar watch renewal/stop
are separately classified as subscription-control operations; they do not
create, update, or delete task/event identities. This is source-level
regression evidence only: it does not prove every DynamoDB mutation is
lease-protected or any deployed historical Lambda digest contains these
guards.

`test/erasure-replay-state-write-audit.test.mjs` also inventories the identified
identity-bearing mapping/history mutation methods in `StateRepository` and
requires replay admission before their first DynamoDB write. Runtime regressions
cover a blocked mapping deletion, recurrence-link deletion, canonical identity
put/delete, and writer-lease creation. The redacted Lambda configuration audit
reports the exact paired pre-write readiness predicate
(`ERASURE_EXECUTION_ENABLED=true` and `ERASURE_PROTOCOL_VERSION=1`) without
returning either environment value. This source check does not cover every
DynamoDB control-state write, prove action-time lease ownership, or validate
historical deployed bundles.

ERASURE_REPLAY_BARRIER_VERSION remains OFF. Do not run the offline atomic release
builder against production, restore suspended consumers, replay a DLQ, alter
fences or perform any destructive production test based on this report.

## Historical version retirement planner after merged #311

The new offline planner consumes a previously captured read-only Lambda
inventory, and deliberately refuses to make any safety or deletion decision.

Example capture (the audit command intentionally exits 2):

    node scripts/audit-erasure-lambda-invokers.mjs --prefix=todoist-calendar-sync --stage=production --region=<region> --profile=<profile> --expected-account=<12-digit-account> > lambda-inventory.json

Then create a review report (also deliberately exits 2):

    node scripts/plan-erasure-lambda-versions.mjs --inventory=lambda-inventory.json > historical-version-review.json

Capture CodeDeploy rollback endpoints separately, using the actual application
and every relevant deployment group (the command also deliberately exits 2):

    node scripts/audit-erasure-lambda-codedeploy.mjs --profile=<profile> --expected-account=<12-digit-account> --region=<region> --application=<application> --deployment-group=<group> > codedeploy-version-references.json

Include that private report in the offline plan:

    node scripts/plan-erasure-lambda-versions.mjs --inventory=lambda-inventory.json --codedeploy=codedeploy-version-references.json > historical-version-review.json

No AWS client, network call, IAM operation or Lambda deletion is imported in
the offline planner. A historical version is retained if it is referenced by
an alias, weighted alias, direct event-source mapping, resource policy or
CodeDeploy current/target rollback endpoint when that evidence is supplied.
Other versions receive a review-only designation with safeToDelete=false.
Without a CodeDeploy report, rollback references remain unverified. The
collector fails closed on incomplete target pages and unknown target types;
keep its exact output private.
Resource-policy absence is not evidence of non-invokability: same-account
identity-based IAM and cross-account principals still require audit.

### Live audit status

Read-only inspection has confirmed that production has historical published
Lambda versions and identity-based invocation paths that need a complete
independent review. The exact account inventory, principals, alias targets,
version counts and configuration values are intentionally kept out of this
public report. No AWS resource or IAM policy was changed during inspection.

The audit is incomplete: it has not established all permission boundaries,
organization policies and role trust/session paths; CloudTrail data-event
coverage and qualified invocation metrics; all historical writer paths;
deployment rollback references; or absence of nonstandard legacy names and
accounts. Do not change IAM or retire versions based on this partial inventory.
Those changes require a separately reviewed exact plan and rollback decision.

### Reproducible published-code and configuration audits

The read-only commands below enumerate the named deployed functions and write
reports to local files. Review and sanitize those reports before sharing them;
function versions, code digests, alias targets and deployment flags can expose
operational details. No generated live-inventory report is committed here.

Run the code package audit:

    AWS_PROFILE=windsor node scripts/audit-erasure-lambda-code.mjs --region=eu-west-2 --function=todoist-calendar-sync-ingress-production --function=todoist-calendar-sync-review-api-production > deployed-code-audit.json

Run the redacted configuration audit:

    AWS_PROFILE=windsor node scripts/audit-erasure-lambda-config.mjs --region=eu-west-2 --function=todoist-calendar-sync-ingress-production --function=todoist-calendar-sync-review-api-production --function=todoist-calendar-sync-watch-production --function=todoist-calendar-sync-worker-production --function=todoist-calendar-sync-reconciler-production --function=todoist-calendar-sync-erasure-worker-production --function=todoist-calendar-sync-completed-cleanup-production > deployed-config-audit.json

Both commands deliberately exit with status 2 because inventory is not release
approval. The code scanner omits presigned URLs; the configuration scanner
omits environment values and fails on incomplete pages, alias drift or
configuration drift. These commands do not clear the all-account/region,
legacy-name, identity-IAM, CodeDeploy rollback or independent approval
blockers above.

For a local candidate scan of attached identity policies, first save a fresh
Lambda invoker inventory to a private local file, then run:

    node scripts/audit-erasure-lambda-identity-invokers.mjs --profile=<profile> --expected-account=<12-digit-account> --inventory=<private-lambda-inventory.json> > <private-identity-candidates.json>

This collects IAM users, roles, groups and attached policy documents, then
reports statements that could match the inventoried function qualifiers. The
report deliberately omits policy document bodies and environment values. Keep
the output private: principal and policy names, grants and function inventory
are operational details. The scan does not evaluate combined effective
permissions, trust/session policies, permission boundaries, explicit denies,
Organizations policies, cross-account principals or resource policies. It
always returns `BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF` and cannot authorize
an IAM change or enable replay/recovery.

To simulate candidate identity grants against the inventoried Lambda resource
ARNs, with only the region request context supplied, run:

    node scripts/simulate-erasure-lambda-invokers.mjs --profile=<profile> --expected-account=<12-digit-account> --inventory=<private-lambda-inventory.json> --candidates=<private-identity-candidates.json> > <private-policy-simulation.json>

The IAM simulator does not prove role assumption or STS session policies, and
role simulations do not include Lambda resource policies. Other context values,
resource controls and unscanned regions/accounts remain separate gates. The
report is a simulation, not a live invocation or approval; keep it private.

To query invocation metrics for each inventoried published version, alias,
alias-executed version and unqualified function over the CloudWatch retention
window, run:

    node scripts/audit-erasure-lambda-invocation-metrics.mjs --profile=<profile> --expected-account=<12-digit-account> --inventory=<private-lambda-inventory.json> > <private-invocation-metrics.json>

The query uses daily sums to keep the full window within bounded API pages.
`ListMetrics` alone is insufficient for older qualifiers because it omits
series without recent data. The report labels missing metric datapoints as
inconclusive, omits no exact live data from this repository, and always remains
blocked from release or IAM decisions. Keep its output private with the other
account and qualifier inventories. No generated live metric results are
committed here.

Obtain independent operator/security approval and a rollback plan before any
IAM update or version retirement. Published version deletion is irreversible
and can break deployment rollback.

This report does not authorize production mutation, nor complete the first
issue #307 acceptance box. Keep ERASURE_REPLAY_BARRIER_VERSION OFF,
post-write recovery blocked and all active fences preserved.
