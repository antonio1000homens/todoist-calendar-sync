# Issue 307 — read-only Lambda invoker inventory

This is a source+deployment audit aid, NOT erasure recovery authorisation. It reads
all published Lambda versions, aliases and weighted targets, event-source
mappings in the selected region, resource invocation policies and Function URLs.
It does not call any AWS mutation or invoke providers.
Resource-policy summaries include bounded wildcard-action/Function-URL booleans
and per-qualifier principal counts (same-account, external AWS, unknown AWS,
service, federated, wildcard, and unknown principal statements). They omit
policy text and principal values. Counts are classification aids, not an
effective-permissions calculation; conditions, `NotPrincipal`, IAM identity
policies, Organizations policies and service trust still require review.

## Run

node scripts/audit-erasure-lambda-invokers.mjs --prefix=todoist-calendar-sync --stage=production --region=eu-west-2 --profile=<profile> --expected-account=<12-digit-account> > lambda-inventory.json

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

The 4 Nov 2026 profile-bound package audit verified every returned ZIP digest.
The static marker scan found historical packages without replay-barrier marker
strings, while current alias targets contain them. Marker presence is only a
triage signal and does not prove that a guard dominates every mutation path;
historical direct invocation and IAM access therefore remain unapproved.
The matching private CodeDeploy capture includes rollback endpoints across
deployment history, so the offline planner retained every published version
and produced no version-retirement candidates. The report does not authorize
deleting deployments, Lambda versions or invocation permissions.

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

    node scripts/audit-erasure-lambda-code.mjs --profile=windsor --expected-account=243857182133 --region=eu-west-2 --function=todoist-calendar-sync-ingress-production --function=todoist-calendar-sync-review-api-production > deployed-code-audit.json

Run the redacted configuration audit:

    node scripts/audit-erasure-lambda-config.mjs --profile=windsor --expected-account=243857182133 --region=eu-west-2 --function=todoist-calendar-sync-ingress-production --function=todoist-calendar-sync-review-api-production --function=todoist-calendar-sync-watch-production --function=todoist-calendar-sync-worker-production --function=todoist-calendar-sync-reconciler-production --function=todoist-calendar-sync-erasure-worker-production --function=todoist-calendar-sync-completed-cleanup-production > deployed-config-audit.json

Both commands deliberately exit with status 2 because inventory is not release
approval. The code scanner verifies the selected profile's STS account before
reading Lambda packages, binds the SDK to that profile, and includes the
verified account in its report. The configuration scanner also verifies STS
against an explicit profile and expected account, then binds Lambda reads to
that profile. It omits environment values and fails on incomplete pages, alias
drift or configuration drift. These commands do not clear the all-account/region,
legacy-name, identity-IAM, CodeDeploy rollback or independent approval
blockers above.

### Windsor configuration snapshot (4 Nov 2026)

A fresh read-only run of the configuration audit verified account
`243857182133` in `eu-west-2` and inspected 173 configurations across the seven
named functions, including all published versions, aliases and `$LATEST`.
`ERASURE_REPLAY_BARRIER_VERSION`, `ERASURE_REPLAY_HMAC_KEYS` and
`ERASURE_REPLAY_HMAC_CURRENT_KEY` were absent from every inspected
configuration. The audit now reports HMAC variable presence only; it never
returns environment values. Thirty-five configurations had the existing
erasure-execution and protocol flags set, but this is not post-write recovery
readiness: the key ring and replay barrier are absent, and the report keeps
`executableRecoveryMayBeEnabled=false`. No AWS mutations were performed.

The same read-only Windsor session verified `AWS_PROFILE=windsor` as account
`243857182133` and paginated `organizations:ListAccounts` to completion. The
organization returned only that active account, which is its management
account. There is currently no member account to carry this workload under an
SCP guardrail. AWS Organizations SCPs do not affect the management account
([AWS documentation](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)).
This confirms that an SCP-based deployment boundary requires a separate
member-account provisioning and workload migration decision. No account or
workload was created or moved.

### Windsor qualified-code and invoker snapshot (4 Nov 2026, 14:12 UTC)

Fresh read-only invoker and package audits verified the same Windsor account
and region. The complete seven-function inventory had no missing expected
functions. Ingress had 71 published numeric versions and `live` pointed to
version 72; review-api had 95 and `live` pointed to version 96. The two SQS
event-source mappings remained Enabled and targeted the unqualified worker and
erasure-worker functions.

All unique deployed ingress and review-api packages passed the AWS
`CodeSha256` download check: 66 digests for ingress and 94 for review-api.
Static marker-string inspection found replay-barrier strings only in ingress
versions 70–72 and review-api versions 84–96. The `reviewed_fenced` string was
present in review-api versions 89–96. These strings do not establish that
checks dominate every write, but the other published versions do not even
contain the recognizable barrier strings. This is direct evidence that old
published versions cannot be accepted as barrier-protected from the current
source alone.

The latest 4 November read-only identity scan examined 58 users, roles and
groups and found five candidate policy grants across four principals. The
associated AWS policy simulation evaluated four candidate-principal scenarios;
each allowed all 183 inventoried function targets, including all 176 qualified
targets. This remains simulation evidence: trust/session policies, resource
policies, external credentials and a combined effective-permission decision
were not proven. The verified account is the organization management account,
so SCPs do not constrain these principals.

The same invocation inventory found `AuthType=NONE` Function URLs on ingress
and review-api, with wildcard URL/invoke statements on the unqualified and
`live` resource-policy summaries. AWS documents that `AuthType=NONE` means
Lambda itself does not authenticate URL requests; the resource policy permits
public invocation. The application checks are a separate layer:

- Ingress requires the shared proxy secret, and then validates the Calendar
  channel token or Todoist webhook signature. This protects the current
  ingress handler path when its deployed code and secret are correct, but does
  not restrict who can reach the public URL or invoke other published versions.
- Review API validates the Cloudflare Access JWT, audience, issuer and operator
  email, plus same-origin on applicable routes. A direct request to its public
  Lambda URL bypasses Cloudflare's network perimeter and relies on those
  handler checks. Deployed historical versions still require independent
  review for equivalent checks.

This URL exposure is intentional in the current template. Both Cloudflare
Worker routes call the Lambda URLs using ordinary HTTPS fetch; they do not sign
AWS requests. Changing Function URLs to `AWS_IAM` therefore requires a reviewed
architecture change (for example, a signing/authenticated intermediary) and
coordinated Cloudflare configuration. It is not a standalone IAM toggle.
Likewise, an IAM allowlist in the Windsor management account would not constrain
all possible callers, and an SCP does not apply to that account. A durable
historical-version boundary therefore needs a separately approved account
boundary and migration design, or an explicitly temporary reviewed set of
account-local denies with a maintained update procedure and proved principal
coverage. Neither plan has been authorized or applied.

No policy, URL, alias, version, queue, environment, fence or replay setting was
changed. The replay barrier and executable recovery remain prohibited.

AWS references: [Function URL authentication](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html),
[Lambda service authorization condition keys](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html),
[SCP effects and limitations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html).

For a local candidate scan of attached identity policies, first save a fresh
Lambda invoker inventory to a private local file, then run:

    node scripts/audit-erasure-lambda-identity-invokers.mjs --profile=<profile> --expected-account=<12-digit-account> --inventory=<private-lambda-inventory.json> > <private-identity-candidates.json>

This collects IAM users, roles, groups and attached policy documents, then
reports statements that could match the inventoried function qualifiers. For
candidate roles it also summarizes trust-policy principal types and selected
condition-key presence without returning trust-policy values. This is
structural evidence only: it does not prove a caller can assume a role. The
report deliberately omits policy document bodies and environment values. Keep
the output private: principal and policy names, grants and function inventory
are operational details. The scan does not evaluate combined effective
permissions, trust conditions, session policies, permission boundaries,
explicit denies, Organizations policies, cross-account resource policies or
principal access paths as one decision. It always returns
`BLOCKED_NOT_EFFECTIVE_PERMISSION_PROOF` and cannot authorize an IAM change or
enable replay/recovery.

To simulate candidate identity grants for `InvokeFunction`, deprecated
`InvokeAsync`, and configured AWS_IAM Function URLs, with the region and
Function URL context supplied where relevant, run:

    node scripts/simulate-erasure-lambda-invokers.mjs --profile=<profile> --expected-account=<12-digit-account> --inventory=<private-lambda-inventory.json> --candidates=<private-identity-candidates.json> > <private-policy-simulation.json>

The IAM simulator does not prove role assumption or STS session policies, and
role simulations do not include Lambda resource policies. Function URLs using
`AuthType=NONE` are reported separately for resource-policy review; they do not
require an identity-policy simulation. A missing Function URL inventory is not
evidence that no URL exists. Other context values, resource controls and
unscanned regions/accounts remain separate gates. The report is a simulation,
not a live invocation or approval; keep it private.

The identity-candidate audit also needs `organizations:DescribeOrganization`.
Its redacted `organizationContext` says whether the verified target account is
the organization management account and whether SCPs can apply there; it does
not return organization IDs or policy documents and does not prove a specific
effective deny. AWS Organizations SCPs do not affect management-account roles
([AWS documentation](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)).
An unavailable organization read remains `UNAVAILABLE` and cannot be treated as
evidence that a guardrail applies.

### Refreshed account-local inventory and candidate simulation (8 Nov 2026)

After refreshing the configured IAM Identity Center session, the account-local
read-only inventory was rerun against `243857182133` in `eu-west-2`. It found
all seven template-expected production functions, 220 published versions, two
aliases, two Function URLs and two enabled event-source mappings. The bounded
invocation target set contained 229 resources: seven unqualified function
targets, 220 published versions and two aliases. The separately verified
package audit downloaded and checked each distinct deployed code digest; no
inspected package contained the selected `todoist-calendar-sync:deleted:v1`
marker, `activeProjectDeletionTombstone` reader or identity-free tombstone
suppression marker.

The identity-policy scan found 58 users, roles and groups, five candidate
policy grants across four principals, and no missing managed-policy documents.
The role-trust summary had no wildcard or external AWS principal counted. The
account is the Organizations management account, so its enabled SCP policy type
does not apply. The candidate policy simulator evaluated eight cases: each of
the four principals was allowed `lambda:InvokeFunction` and legacy
`lambda:InvokeAsync` on all 229 inventoried targets, including all 222
qualified targets, with no simulated denies. This is not effective-permission
proof: role assumption, actual callers, session context, resource policies and
external paths remain unresolved.

Both configured Function URLs use `AuthType=NONE` and have wildcard
URL-invocation resource-policy statements. Anonymous ingress POST and Review API
GET requests returned 401 at their deployed application handlers in the prior
8 November check; that application response does not remove the public Lambda
policy or prove authenticated bypasses are absent. The live Review API and
erasure worker remain configured with `ERASURE_EXECUTION_ENABLED=true`, and
the worker queue mapping is enabled. Neither contains the project-comment
tombstone implementation. No AWS or provider state was changed by this
inventory or simulation. The result remains
`BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW`; it does not authorize an
IAM, Function URL, deployment, version-retirement, queue, fence or replay
change.

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

### All opted-in Windsor region Lambda names (4 Nov 2026)

A fresh read-only scan verified Windsor with STS, listed all 17 opted-in
regions, and let the AWS CLI paginate `ListFunctions` in each region. It found
21 functions across `eu-west-1` and `eu-west-2`. The seven deployed
`todoist-calendar-sync-*` functions were all in `eu-west-2`; no function name
matching `todoist` or `calendar-sync` appeared in the other 16 regions. The
two `eu-west-1` functions and twelve other `eu-west-2` functions have not been
code-audited for indirect identity writes, so this name-only scan does not
prove there are no nonstandard writers. The AWS Organizations inventory
returned only the Windsor management account, so this scan covers no
out-of-organization credentials or external accounts. No AWS mutation was
performed.

### Non-sync deployed Lambda package screening (4 Nov 2026)

After verifying the Windsor caller with STS, a read-only screen downloaded the
14 non-`todoist-calendar-sync-*` Lambda function packages currently returned in
`eu-west-1` and `eu-west-2`. Each downloaded ZIP's SHA-256 matched the
`GetFunction` `CodeSha256`. The screen also read and verified the digests of all
three attached non-sync layer archives. It searched package bytes for Todoist
API, Google Calendar API, and common task/event mutation markers; package
contents were not dumped, and environment values were not read. Manual
verification displayed only selected endpoint and HTTP-method source lines.

No such markers appeared in the unrelated function packages or layer archives.
The shared `led-publisher` / `led-control-api` Python package contains a
Todoist task-filter GET and Google Calendar event-list GET. Its only Todoist
POST is to the OAuth access-token endpoint for refresh; source inspection found
no Todoist task or Calendar event identity-write request. This package has no
Calendar event mutation call. Identical shared package matches explain why the
same static scan result appears for both functions.

This narrows the unreviewed non-sync code surface in the two regions observed,
but it is not proof that every route is safe: string scans do not establish
control flow, dynamically assembled requests, indirect calls, IAM
authorization, other principals/accounts, historical versions, or resources
outside those two regions. The earlier 17-region scan was name-only; this
package screen audited code only in the two regions where that scan found
functions, and does not classify non-Lambda writer routes or historical
versions. The complete writer-audit checklist therefore remains unchecked. No
AWS or provider mutation was performed.

### Configured Calendar inventory baseline (4 Nov 2026)

Using the verified Windsor account and the three deployed Google Calendar
credentials, read-only CalendarList calls returned one listed calendar for
each profile. The configured Work calendar was not listed by CalendarList, but
the explicit full event-list query against its configured calendar ID
succeeded. Full paginated event inventories completed for all three configured
calendars: 745 Home, 986 Antonio and 413 Work events. No restricted CalendarList
access roles were observed.

The inventory found cross-profile value overlaps in 26 Calendar event IDs, 4
Todoist task tags, 19 iCalUIDs and 6 recurrence-parent IDs. These counts show
that the configured provider identities are not disjoint. They do not identify
whether any overlap belongs to a selected erasure, nor establish the associated
Todoist, comment, recurrence, DynamoDB or delivery provenance. Keep full
identity closure and all-profile alias proof open; the counts are a
point-in-time baseline, not recovery evidence. Only counts and profile labels
were recorded; provider IDs, titles, comments and credentials were not
persisted. No AWS or provider mutation was performed.

### Qualified invocation metric snapshot (4 Nov 2026)

The read-only metric collector queried 341 daily `AWS/Lambda Invocations`
series for all seven inventoried functions, published versions, aliases and
alias-executed versions over the preceding 455 days
(`2025-08-06T16:12:33Z` through `2026-11-04T16:12:33Z`). All metric queries
completed. The 166 direct published-version series had no datapoints. This is
inconclusive for direct invocation: CloudWatch metric absence is not evidence
that a version was never invoked.

Alias-executed-version metrics had datapoints for 95 published version series;
94 were not a primary or weighted target of their alias at capture time. This
proves those versions received alias-routed invocations during the metric
window, not that they were directly invoked or that their code enforced the
replay barrier. The two alias totals summed to 10,176 invocations. These
metrics identify neither callers nor the full history beyond CloudWatch
retention, and do not replace code-digest, IAM, CloudTrail or rollback review.
They strengthen the reason to retain and audit historical versions; they do
not authorize retirement, denial, barrier activation or recovery execution.
No AWS or provider mutation was performed.

### State-table backup and TTL baseline (4 Nov 2026)

Read-only inspection of the configured Windsor state table in `eu-west-2`
confirmed DynamoDB point-in-time recovery is enabled with a 35-day recovery
period. The same read returned a latest restorable time of
`2026-11-04T16:45:01Z`; point-in-time recovery can therefore retain deleted
identity-bearing state after the live row is removed. TTL is enabled on
`expiresAt`; TTL expiration is asynchronous and does not shorten the separate
PITR window.

At capture time, `ListBackups` returned no on-demand backup summaries for the
table, `ListProtectedResources` found no AWS Backup protected-resource record,
`ListBackupPlans` returned no regional plans, and `ListExports` returned no
table export jobs. These are current regional observations, not evidence
about external copies or earlier exports. Security/privacy approval must
explicitly account for the 35-day PITR copy and any external retention before
permanent keyed replay markers are enabled. This read did not authorize that
retention or change any AWS configuration.

### Windsor IAM and Lambda refresh (4 Nov 2026, 17:24 UTC)

A fresh read-only session again verified `AWS_PROFILE=windsor` as account
`243857182133`. The eu-west-2 inventory found all seven expected production
functions. Ingress had 73 published numeric versions and review-api had 97;
the other five functions had only `$LATEST`. Ingress and review-api each had
one alias. The two SQS mappings remained enabled, and the two Function URLs
still had `AuthType=NONE`.

The current identity scan examined 55 users, roles and groups and found five
candidate identity-policy grants across four principals. No managed policy
documents were missing. The simulator evaluated eight cases against all 177
inventoried targets; every case allowed all targets, including 1,360
qualified-target evaluations. It reported no permission boundary. The target
account remains the Organizations management account, so SCPs do not apply.
This remains a candidate scan and policy simulation, not proof of role
assumption, STS session policy, combined effective access, resource-policy
access, external callers or actual invocation. The Function URLs require
separate resource-policy review.

A separate all-active-region Lambda name scan examined 17 opted-in regions.
Searching names containing `todoist`, `calendar` or `sync` found only the same
seven expected functions in `eu-west-2`; 17 opt-in-disabled regions were not
scanned. This is not a complete legacy-name, account or invocation audit.

No AWS or provider mutation was performed. The replay barrier and executable
recovery remain prohibited. Historical code, writer/identity closure,
security approval, queue/marker ordering, destructive partial-deletion
approval, fault injection and disposable Work-profile acceptance remain
separate open gates.

### Windsor published-package refresh (4 Nov 2026, 17:35 UTC)

A fresh profile-bound package audit verified every current published ingress
and review-api package against its AWS `CodeSha256`. Ingress had 72 published
versions represented by 67 unique verified packages; review-api had 96
published versions represented by 95 unique verified packages. Recognizable
replay-barrier marker strings appeared in four ingress packages and fourteen
review-api packages; the `reviewed_fenced` string appeared in nine review-api
packages. The increases from the earlier snapshot reflect newly published
packages, not evidence that old invocation paths are guarded.

Marker presence is only a triage signal and does not prove the checks dominate
every mutation path. The read-only scanner remains
`BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW`; it keeps
`replayBarrierMayBeEnabled=false` and
`executableRecoveryMayBeEnabled=false`. No code digest or package was added to
this public report, and no AWS mutation was performed.

### Windsor full Lambda name and role inventory (4 Nov 2026, 17:38 UTC)

A fresh read-only scan verified the Windsor account with STS and paginated
`ListFunctions` in all 17 opted-in regions. It found 21 functions total: two
in `eu-west-1` and nineteen in `eu-west-2`; the other 15 opted-in regions
returned none. Seventeen opt-in-disabled regions were not queryable. Matching
`todoist`, `calendar`, `sync` or `erasure` in function names, execution-role
names or descriptions identified seven functions, all seven expected
production functions in `eu-west-2`. The other fourteen functions had no such
name/role/description signal.

This closes the full opted-in-region Lambda-name/role inventory for the
Windsor account only. It does not prove there are no indirect writers among
generic functions, non-Lambda triggers, other accounts, disabled regions or
external credentials. The earlier 14-function package screen is limited to
the packages and regions it inspected; identity, trust/session, deployment
rollback and invocation review remain open. No AWS mutation was performed.

### Windsor all-region Lambda versions and aliases (4 Nov 2026, 17:41 UTC)

Read-only `ListVersionsByFunction` and `ListAliases` calls were completed for
all 21 currently inventoried functions in the 17 opted-in regions. The account
has 168 published numeric versions and two aliases, all in `eu-west-2` on the
ingress and review-api functions (72 and 96 versions respectively). No alias
had weighted secondary targets. The other 19 functions, including all 14
generic-name functions and the five other expected app functions, were
`$LATEST`-only with no aliases. `eu-west-1` had two functions and no published
versions or aliases; the other 15 opted-in regions had no Lambda functions.

This closes the current function/version/alias inventory for the enabled
Windsor regions. The package snapshot current at 17:41 had not yet inspected
the other five expected app functions; the 17:43 refresh below fills that
package-digest gap. Neither scan proves static marker checks protect every
mutation route, establishes which historical versions are invokable, covers
the 17 opt-in-disabled regions or other accounts, or audits non-Lambda
writers. Direct invocation denial, trust/session paths, rollback review and
separate approval remain outstanding. No AWS mutation was performed.

### Windsor all-function deployed-package digest refresh (4 Nov 2026, 17:43 UTC)

A fresh read-only code audit verified the selected Windsor account with STS
and downloaded packages for all seven expected application functions in
`eu-west-2`. It verified 67 distinct ingress package digests, 95 review-api
package digests and one `$LATEST` package digest for each of the other five
functions. These per-function digests cover all 168 published numeric
versions and all seven current `$LATEST` configurations. The other fourteen
Windsor Lambda functions have no published versions or aliases and had their
current package digests screened separately as described earlier.

Each of the seven current `$LATEST` packages contained the recognizable
replay-gate, marker-key and HMAC-keyring strings. Across historical ingress
and review-api packages, those strings appeared in only four of 67 and
fourteen of 95 unique packages respectively. Marker presence or absence is
not a control-flow proof, but the historical package digests without the
strings cannot be assumed to enforce the barrier. The scanner status remains
`BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW`, with both release flags
false. No raw digests were recorded here and no AWS mutation was performed.

### Windsor current identity-policy simulation refresh (4 Nov 2026, 19:58 UTC)

A fresh read-only run verified the Windsor caller with STS, inventoried all
seven expected production functions in `eu-west-2`, and found no missing
expected function. The IAM candidate collector paginated 57 users, roles and
groups, found no missing managed-policy documents, and identified five
candidate grants across four principals. This is a candidate scan, not a
complete effective-permission inventory.

The IAM policy simulator evaluated eight direct/legacy invocation cases
against all 181 inventoried targets. Each case allowed all 181 targets,
including 174 qualified targets, and reported zero denied targets. The
candidate report found no permission boundary on those grants. Separately,
both inventoried Function URLs still use `AuthType=NONE` and both resource
policy summaries contain wildcard public invocation statements. These results
confirm that current account-local identities and public URLs cannot be
treated as barriers against direct invocation of historical versions.

The account is still the Organizations management account, so an SCP cannot
guard this workload. The candidate scan and simulator do not combine trust,
session policies, permission boundaries, explicit denies, Lambda resource
policies, external callers or organization controls into one effective
authorization result. Public Function URL restriction also needs a reviewed
Cloudflare-to-Lambda authentication design because the deployed Cloudflare
Workers currently call those URLs without SigV4. No IAM, Function URL,
Lambda, alias, queue or application setting was changed. The first #307
writer/IAM acceptance remains unchecked; no denial or version-retirement
change is authorized by these read-only results.

### Windsor trust-path structural refresh (4 Nov 2026, 21:42 UTC)

A fresh read-only run verified the Windsor account with STS and inventoried all
seven expected production functions in `eu-west-2`, with no missing functions.
The inventory had 174 published versions, two aliases, two event-source
mappings and two Function URLs, both `AuthType=NONE` with wildcard URL and
invoke-via-URL policy summaries. The identity candidate audit covered 58 IAM
users, roles and groups, had no missing attached managed-policy documents, and
reported five candidate invocation grants across four principals.

The audit now includes a structural summary of role trust policies without
publishing principal values or policy documents. It observed 52 roles, all with
trust documents, and counted no wildcard or external AWS principals in their
allow statements. The three candidate invocation roles also had trust
documents, with no wildcard or external AWS principal counted. The organization
remains the management account; its SCP policy type is enabled but SCPs do not
apply to that account.

A fresh IAM policy simulation evaluated eight direct/legacy cases against 183
targets. All four candidate principals were allowed all 183 targets, including
all 176 qualified targets, with zero denied targets and no permission
boundary decision. This is still not an effective-permission result: the
simulator does not prove role assumption or STS session context, does not
include Lambda resource policies, and cannot rule out callers or routes outside
the inventory. The trust summary is structural evidence only. No AWS mutation
was performed; replay and executable recovery remain disabled.

### Windsor all-function package digest refresh (4 Nov 2026, 21:50 UTC)

A fresh read-only scan verified the seven expected production functions in
`eu-west-2`. The version inventory and package audit were taken back to back;
all seven function version counts and all version code digests matched between
the two reads. The audit downloaded 173 unique deployment packages and verified
each package against its AWS `CodeSha256`, covering 181 versions including
`$LATEST` and 174 published versions.

Across the 173 unique packages, recognizable strings appeared in 29 packages
for each of the replay gate, marker key prefix and HMAC keyring; ingress
unavailable/suppressed strings appeared in five packages each, and the fenced
review marker appeared in 15. Marker presence is triage only; it does not prove
that a guard dominates every provider or DynamoDB mutation. The scan did not
establish safety in the 17 opt-in-disabled regions, legacy accounts/names,
identity-based invoke paths, or resource policies. It remains
`BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW`; the replay and executor
release flags remain false. No AWS mutation, Lambda invocation, queue operation
or provider write was performed.

### Windsor deployed erasure-gate configuration refresh (4 Nov 2026, 22:09 UTC)

A fresh redacted configuration audit covered all 181 versions of the seven
expected `eu-west-2` production functions. No version had
`ERASURE_REPLAY_BARRIER_VERSION` enabled or configured, no version contained
the HMAC keyring, and no version had post-write review enabled. Both replay
release flags remain false.

The separate paired pre-write readiness setting
(`ERASURE_EXECUTION_ENABLED` plus `ERASURE_PROTOCOL_VERSION`) was present on
41 configurations: 39 published versions and two `$LATEST` configurations.
Forty are on review-api (including its `live` alias target version 102), and
one is on the erasure worker. This is the existing pre-write recovery path; it
does not establish post-write release authorization or replay-barrier
admission. The audit omitted all environment values and made no AWS changes.
Historical version invocation rights and the safety of every enabled pre-write
path remain part of the unchecked writer/IAM review.

# 8 November storage correction

The earlier static package markers in this document (`ERASURE_REPLAY#` and
the HMAC keyring) described the superseded permanent DynamoDB tombstone model.
For #349, the selected marker is now the bounded Todoist project-comment
entry `todoist-calendar-sync:deleted:v1`; the source admission helper is
`activeProjectDeletionTombstone`. The code-package auditor reports these
strings only as triage evidence: their presence does not prove every writer
checks the comment before its first write. Historical versions without this
implementation remain unsafe for post-write fence release unless denied.

The 8 November AWS inventory predates this source change. It remains read-only
evidence about the deployed packages and IAM/Function URL boundary; it does
not prove the new marker is deployed or authorize any AWS update. Permanent
DynamoDB HMAC markers and historical verification-key retention are not part
of the corrected #349 marker design.


## 8 November live execution and endpoint recheck

A focused read-only recheck found the production Review API `live` alias and
the production erasure worker configured with
`ERASURE_EXECUTION_ENABLED=true` and `ERASURE_PROTOCOL_VERSION=1`; the
`ERASURE_REPLAY_BARRIER_VERSION` setting is absent. The erasure worker's SQS
event-source mapping is enabled. The deployed review API sets
`executionReadyAtIssue` from the execution/protocol pair, so a fresh exact
preview and operator confirmation can create an executable operation. This
does not prove that any operation was recently run, but the executor must not
be described as disabled. Both deployed bundles inspected lacked the new
project-comment tombstone marker, so the new #349 path is not live.

At the audit time, the erasure queue had no visible, in-flight, or delayed
messages, and no profile FENCE item was present for home, antonio, or work.
A paced full-table scan subsequently found zero `ERASURE_OPERATION#*` /
`STATE` rows across 151 pages, consuming 188 read-capacity units. Both public
Function URLs still have wildcard Lambda URL invoke policies and
`AuthType=NONE`;
unauthenticated ingress POST and review API GET requests returned 401 from the
deployed application handlers. The ingress requires its proxy secret plus
provider signature/channel token, and the review API validates Cloudflare
Access JWT issuer/audience and operator allowlist.

These findings are read-only. No AWS configuration, operation state, queue,
provider data, or Lambda version was changed. The #403 draft changes the
existing production execution setting to false for future master deployments
until #347/#349 acceptance is complete; it does not change the current live
configuration until merged and deployed.

### Windsor IAM trust and credential metadata refresh (8 Nov 2026)

A further read-only check refreshed the trust documents for the three roles
with candidate Lambda invocation grants. The GitHub Actions role trusts the
GitHub OIDC provider only with audience `sts.amazonaws.com` and a subject
pattern restricted to `repo:antonio1000homens/lambdas:*`. The Windsor VSS
role trusts only the account's named Administrator SSO role. The active
Administrator SSO role has one conditional federated trust statement. These
trust documents identify possible assumption routes; they do not establish
that a particular caller can assume each role or that the resulting session
can invoke an inventoried function.

The `vsstudio` IAM user has one active access key and no console login profile.
The key value was not retrieved or recorded. Its presence is not evidence that
the key is in use or that it can reach Lambda. The five previously reported
identity-policy invocation grants remain candidates, not effective-permission
proof. The AWS policy simulator still cannot resolve role assumption, session
policies, Lambda resource policies, or all external paths. No IAM policy,
credential, Lambda, queue, application setting, or provider data was changed.

### Windsor CloudTrail and IAM last-used evidence (8 Nov 2026)

A corrected read-only regional inventory queried CloudTrail trails (including
shadow trails) and CloudTrail Lake event data stores in all 17 regions whose
EC2 opt-in status was `opt-in-not-required` or `opted-in`. All 17 trail queries
and all 17 event-data-store queries succeeded. No trail or event data store was
returned. This account therefore has no configured CloudTrail trail or Lake
store available through those regional APIs for historical Lambda invocation
data-event review. This is a logging gap, not evidence that no direct Lambda
invocation occurred; IAM and package inventories still cannot resolve the
historical caller question.

IAM last-used metadata for the `vsstudio` active access key reported
CloudFormation in `eu-west-2` at 2026-10-27 18:54 UTC. The metadata does not
identify which CloudFormation operation ran and does not prove the key was
never used for Lambda. Role last-used metadata reported the current
Administrator SSO role at 2026-11-08 21:14 UTC in `eu-west-2`,
`S3-access-github-actions` at 2026-03-12 10:31 UTC in `eu-west-2`, and
`WindsorVsstudioAccess` at 2026-09-11 17:01 UTC in `us-east-1`. Role
last-used metadata has no action-level attribution and does not establish
Lambda invocation. No secret key value was retrieved. No IAM, CloudTrail,
Lambda, queue, application setting, or provider data was changed.


### Production state after PRs #403–#405 (8 Nov 2026, 23:42 UTC)

After deployment run 42536045650 completed successfully, the `todoist-calendar-sync`
CloudFormation stack was `UPDATE_COMPLETE` (updated 23:39:08 UTC) with
`ErasureExecutionEnabled=false`. A direct read of the live Review API returned
`ERASURE_EXECUTION_ENABLED=false`, protocol `1`, and no replay-barrier version.
The unqualified worker had no execution flag, protocol `1`, and no replay-barrier
version. The erasure worker's event-source mapping remained enabled.

Fresh read-only audits verified the expected seven production functions in
`243857182133` / `eu-west-2`: 223 published versions, two aliases, two enabled
event-source mappings, and 219 unique verified Lambda package digests. The
package scan found the project-marker key, replay-gate, and HMAC-keyring strings
in inspected packages; it also found the ingress tombstone suppression markers
in current ingress packages and fenced-review markers in the review API and
erasure worker. String presence does not prove check ordering or coverage of
every provider/DynamoDB write.

The redacted config audit found 71 Review API configurations with the paired
erasure execution/protocol settings enabled. The current `live` alias points to
version 136, whose execution setting is present but false; `$LATEST` is also
false. Historical qualified versions remain directly invokable candidates,
including configurations that still have execution enabled. The account-local
invoke inventory and candidate IAM simulation do not deny those old-version
paths. Thus the false stack setting protects the current deployment default,
but does **not** prove that every old executable is disabled or unreachable.
The replay barrier and HMAC keyring are absent from all seven functions'
inventoried configurations.

The audits remain `BLOCKED_PENDING_CALL_PATH_IAM_AND_APPROVAL_REVIEW` and
`BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT`. They do not cover all
accounts/regions, legacy names, all external callers, session/resource-policy
semantics, or a proven deny for qualified historical versions. No Lambda, IAM,
queue, operation, fence, or provider state was changed during these audits.
Keep execution disabled, do not release fences or enable replay admission, and
leave #347 and #349 open pending the writer boundary, independent review, and
disposable Work-profile fault-injection acceptance.

### Production qualified-version boundary update (9 Nov 2026)

A fresh production read-only audit after PRs #403–#406 found 223 published
versions across seven functions, two aliases, and two enabled SQS mappings.
For the ingress and Review API functions, exact resource-policy Deny statements
were installed on every old numeric published version: 87 ingress versions and
133 Review API versions. Direct harmless invocation probes for representative
old versions returned AWS `AccessDeniedException`; harmless DryRun probes for
both live aliases remained allowed. Review API v135 remains a guarded rollback
target. The live aliases point to ingress v89 and Review API v136. Private
readback reports are retained outside the repository.

The read-only inventory now reports whether an exact-version
`DenyUnreviewedQualifiedInvocation` statement is present. This is not a complete
effective-permissions proof: identity, trust/session, organization, endpoint,
URL, external account, legacy-name and other-region paths still require review.
The live resource-policy Denies are already in place; repository changes do not
create them. Keep execution disabled until the independent #347 boundary and
rollback review and the #349 disposable-profile acceptance are complete. No
fence release, DLQ replay, provider deletion or production erasure test is
approved by this audit.

### Legacy deployment-role reactivation path (9 Nov 2026)

A read-only audit across all 17 opted-in/standard regions found the seven
canonical Todoist Calendar Sync functions only in `eu-west-2`. No legacy-prefix
application stack or Lambda function was present in any region, and the old
artifact bucket prefix was empty. The `lambdas` repository's current deploy
workflow no longer contains the old app target; its remaining source directory
contains tests only.

The old GitHub OIDC deployment role is still trusted for pushes from
`antonio1000homens/lambdas` `main` and `master`. At the time of this audit, its
legacy policy stack attached two managed policies that granted management of
old-prefix functions, URLs, event-source mappings, runtime roles, queues, and
the old stack. Legacy SSM parameters also remain. Subsequent guard deployment
is recorded below; this earlier finding is retained as history, not the current
effective-boundary conclusion.

PRs #413/#414 were subsequently merged and the Todoist deploy-role stack update
completed. The Todoist role now uses stack-qualified replacement policies and
no longer carries the legacy event-source-mapping policy. PR #125 in the
`lambdas` repository added and deployed a customer-managed explicit-deny policy
on the shared GitHub deploy role. Live IAM simulations confirmed Deny for
Todoist/legacy Lambda management, mappings targeting Todoist workers,
Todoist/legacy CloudFormation stacks, and legacy runtime-role pass operations;
unrelated NFC deploy operations remained allowed. The old managed policies are
still attached, but the new explicit Deny overrides the protected actions.
This closes the identified cross-repository deployment path; independent
review of the full invocation boundary and rollback behavior remains open.

### Post-deployment refresh after PR #412 (9 Nov 2026)

Production deployment run 42565444685 succeeded for master commit
`06c62fe6dd9f72dafc9cd64ad6130d5e4ff6f300`. A fresh seven-function code audit
verified the deployed package digests. Current ingress version 92 and Review
API version 139 are the `live` alias targets. Resource-policy Denies remain on
the older ingress versions 2–88 and Review API versions 2–134; the later
versions ingress 89–92 and Review API 135–139 do not have that version-specific
Deny statement. The latest ingress and Review API packages contain the current
project-tombstone implementation strings; the worker package contains the
tombstone suppression path. String presence still does not prove ordering at
every write boundary. The Review API versions 135–139 and the erasure worker
currently have execution disabled, while the erasure worker's SQS mapping is
enabled. No erasure operation, fence release, DLQ replay, or provider mutation
was performed.

The post-deployment findings do not close #347: all actual invocation
principals, direct/alias/URL paths and future rollback/publish behavior still
need independent review. They also do not satisfy #349's disposable erasure
E2E, fault-injection, retry/quarantine, and rollback rehearsal. Keep production
execution disabled until both tickets' acceptance criteria are verified.
