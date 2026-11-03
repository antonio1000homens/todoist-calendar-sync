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

### Initial live read-only findings (3 Nov 2026, London account hosting sync)

- Ingress: 70 numbered published versions (2–71), live alias points to 71.
  Review API: 90 numbered published versions (2–91), live points to 91.
- Two enabled SQS event-source mappings targeted unqualified worker and
  erasure-worker functions; none targeted old ingress/review-api qualifiers.
- Sampled historical numeric qualifiers had no version resource policy.
  The unqualified and live ingress/review-api URLs had resource-based
  invoke permissions with additional Function URL conditions.
- The sync deployment GitHub Actions role did not explicitly allow
  lambda:InvokeFunction in inspected policy statements. However, an
  AdministratorAccess role has a policy permitting all actions, and a
  vsstudio IAM user has AWSLambda_FullAccess (lambda:* on all resources).
  Removing version resource policies cannot deny these identity grants.
- Current seven Lambda configurations showed ERASURE_REPLAY_BARRIER_VERSION
  and ERASURE_POSTWRITE_REVIEW_VERSION absent. The existing independent
  ERASURE_EXECUTION_ENABLED flag was true on the review API and erasure worker.

Before any future version retirement, enumerate all IAM principals, permission
boundaries, SSO permission sets and cross-account invocation; validate
CodeDeploy rollback targets, CloudFormation/SAM ownership, Function URLs,
EventBridge/Step Functions, legacy names and every deployed region. Inspect
CloudTrail Lambda data-event recording coverage and qualified invocation
metrics (no CloudTrail records is NOT proof of no invocation), and confirm
old deployment bundles and their code digests. Obtain operator/security
approval and a rollback plan; published Lambda version deletion is
irreversible and may break deployment rollback.

This report does not authorize production mutation, nor complete the first
issue #307 acceptance box. Keep ERASURE_REPLAY_BARRIER_VERSION OFF,
post-write recovery blocked and all active fences preserved.
