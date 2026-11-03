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

ERASURE_REPLAY_BARRIER_VERSION remains OFF. Do not run the offline atomic release
builder against production, restore suspended consumers, replay a DLQ, alter
fences or perform any destructive production test based on this report.

## Historical version retirement planner after merged #311

The new offline planner consumes a previously captured read-only Lambda
inventory, and deliberately refuses to make any safety or deletion decision.

Example capture (the audit command intentionally exits 2):

    node scripts/audit-erasure-lambda-invokers.mjs --prefix=todoist-calendar-sync --stage=production --region=eu-west-2 > lambda-inventory.json

Then create a review report (also deliberately exits 2):

    node scripts/plan-erasure-lambda-versions.mjs --inventory=lambda-inventory.json > historical-version-review.json

No AWS client, network call, IAM operation or Lambda deletion is imported in
the offline planner. A historical version is retained if it is referenced by
an alias, weighted alias, direct event-source mapping or resource policy.
Other versions receive a review-only designation with safeToDelete=false.
Resource-policy absence is not evidence of non-invokability: same-account
identity-based IAM and cross-account principals still require audit.

### Live read-only findings (3 Nov 2026, Windsor account)

The connected AWS identity was verified as account `243857182133`. An
all-enabled-region scan covered 17 regions and found the seven
`todoist-calendar-sync-*` functions only in `eu-west-2`:

- Ingress: 70 numbered versions (2–71); `live` points to 71.
- Review API: 93 numbered versions (2–94); `live` points to 94.
- Watch, worker, reconciler, erasure-worker and completed-cleanup each have
  `$LATEST` only. No weighted aliases were present.
- Two enabled SQS event-source mappings target the unqualified worker and
  erasure-worker. Resource policies also show EventBridge rules for watch,
  reconciliation and completed-cleanup.
- `GetPolicy` succeeded for every numbered ingress/review-api version; none
  had a version resource policy. The `live` ingress/review-api aliases have
  Function URLs with `AuthType=NONE` and wildcard resource permissions
  conditioned on `InvokedViaFunctionUrl`. Unqualified functions have no
  Function URL configuration, although their resource policies retain
  URL-conditioned statements. The current source review API checks a
  Cloudflare Access assertion before route dispatch; version 94 still needs
  to be matched to audited source before claiming this for the deployment.
- Read-only identity-policy scans covered all 49 IAM roles and 6 IAM users;
  `ListGroups` returned none. Broad same-account invocation grants include
  `AdministratorAccess` on the SSO admin role and `WindsorVsstudioAccess`,
  `AWSLambda_FullAccess` on `S3-access-github-actions`, and `AWSLambda_FullAccess`
  plus a `function:*` invoke grant on user `vsstudio`. The former role trusts
  GitHub Actions subjects matching `repo:antonio1000homens/lambdas:*`.
  These identity grants can reach historical qualified versions even when
  those versions have no resource policy.
- `GitHubActionsTodoistCalendarSyncDeployRole` is scoped by OIDC to the
  repository's production environment. Its policies allow code/config updates,
  version publication, alias and permission changes, and mapping changes, but
  the inspected statements do not grant `lambda:InvokeFunction`.
- `GetFunctionConfiguration` was read for every published ingress/review-api
  version and for all seven `$LATEST` versions. Both replay-barrier and
  post-write-review variables were absent on all 163 published versions and
  all seven `$LATEST` versions. There were 65 distinct ingress code digests
  and 92 distinct review-api digests. Review API had the separate
  `ERASURE_EXECUTION_ENABLED=true` setting on 31 historical versions and
  `$LATEST`; 2 historical versions set it to `false` and 60 omitted it.
  Erasure-worker `$LATEST` also had that separate execution flag set to
  `true`. These config values do not prove which code each digest contains.

This does not complete the independent audit. IAM permission boundaries,
Organizations SCPs and SSO permission-set provenance were not enumerated;
CloudTrail Lambda data-event coverage and qualified invocation metrics were
not checked. Nor were all historical bundles compared with replay-admission
source, CloudFormation/CodeDeploy rollback references exhaustively verified,
or nonstandard legacy names/accounts proved absent. A complete historical
writer audit must establish these before any retirement or denial change.
The local Windsor SSO CLI token was expired during this review, so these reads
used the connected Windsor AWS account instead. No AWS resource or IAM policy
was changed.

Obtain independent operator/security approval and a rollback plan before any
IAM update or version retirement. Published version deletion is irreversible
and can break deployment rollback.

This report does not authorize production mutation, nor complete the first
issue #307 acceptance box. Keep ERASURE_REPLAY_BARRIER_VERSION OFF,
post-write recovery blocked and all active fences preserved.
