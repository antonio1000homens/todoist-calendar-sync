#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stack_name="${STACK_NAME:-}"
region="${AWS_REGION:-eu-west-2}"
code_bucket="${CODE_BUCKET:-aws2022-lambda-code}"
resource_name_prefix="${RESOURCE_NAME_PREFIX:-${stack_name}}"
ssm_prefix="${SSM_PREFIX:-/todoist-calendar-sync}"
calendar_watch_token_parameter="${CALENDAR_WATCH_TOKEN_PARAMETER:-${ssm_prefix%/}/calendar-watch-token}"
todoist_webhook_secret_parameter="${TODOIST_WEBHOOK_SECRET_PARAMETER:-${ssm_prefix%/}/todoist-webhook-secret}"
proxy_shared_secret_parameter="${PROXY_SHARED_SECRET_PARAMETER:-${ssm_prefix%/}/proxy-shared-secret}"
calendar_watch_callback_url="${CALENDAR_WATCH_CALLBACK_URL:-https://calendar-sync.alf-broadcast.co.uk/calendar}"
google_prefix="${GOOGLE_CREDENTIALS_PARAMETER_PREFIX:-${ssm_prefix%/}/google}"
todoist_prefix="${TODOIST_TOKEN_PARAMETER_PREFIX:-${ssm_prefix%/}/todoist}"
slack_bot_token_parameter="${SLACK_BOT_TOKEN_PARAMETER:-/lambdas/shared/slack-bot-token}"
todoist_calendar_sync_slack_channel="${TODOIST_CALENDAR_SYNC_SLACK_CHANNEL:-}"
sync_profile_config_json="${SYNC_PROFILE_CONFIG_JSON:-}"
cloudflare_access_issuer="${CF_ACCESS_ISSUER:-}"
cloudflare_access_audience="${CF_ACCESS_AUDIENCE:-}"
review_operator_emails="${REVIEW_OPERATOR_EMAILS:-}"
# A destructive production feature; deployments must explicitly opt in.
erasure_execution_enabled="${ERASURE_EXECUTION_ENABLED:-false}"
capacity_reduction_approved="${DYNAMODB_CAPACITY_REDUCTION_APPROVED:-false}"
# Explicit production opt-in; do not turn on retention cleanup for new stacks.
completed_history_cleanup_apply="${COMPLETED_HISTORY_CLEANUP_APPLY:-false}"
if [[ "$completed_history_cleanup_apply" != "true" && "$completed_history_cleanup_apply" != "false" ]]; then
  echo "COMPLETED_HISTORY_CLEANUP_APPLY must be true or false" >&2
  exit 2
fi
# Explicitly pass every provisioned table/index capacity. Otherwise a new
# template default can silently override the existing 5/5 GSI stack parameter.
state_table_read_capacity="${STATE_TABLE_READ_CAPACITY:-20}"
state_table_write_capacity="${STATE_TABLE_WRITE_CAPACITY:-20}"
profile_lookup_index_read_capacity="${PROFILE_LOOKUP_INDEX_READ_CAPACITY:-5}"
profile_lookup_index_write_capacity="${PROFILE_LOOKUP_INDEX_WRITE_CAPACITY:-5}"
# SAM's key=value parameter parser consumes JSON quotes unless they are escaped.
# Keep the value JSON for validation, but escape quotes only at the CLI boundary.
sam_profile_config_json="${sync_profile_config_json//\"/\\\"}"
skip_source_validation="${SKIP_SOURCE_VALIDATION:-false}"

require_value() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required deployment value: ${name}" >&2
    exit 2
  fi
}

validate_parameter_name() {
  local name="$1"
  local found

  if ! found="$(aws ssm get-parameter \
      --region "$region" \
      --name "$name" \
      --query 'Parameter.Name' \
      --output text 2>/dev/null)"; then
    echo "Required SSM parameter is missing or unreadable: ${name}" >&2
    return 1
  fi

  if [ "$found" != "$name" ]; then
    echo "Unexpected SSM parameter returned while validating ${name}: ${found}" >&2
    return 1
  fi
}

require_value STACK_NAME
require_value TODOIST_CALENDAR_SYNC_SLACK_CHANNEL
require_value SYNC_PROFILE_CONFIG_JSON
require_value CF_ACCESS_ISSUER
require_value CF_ACCESS_AUDIENCE
require_value REVIEW_OPERATOR_EMAILS

if [[ ! "$stack_name" =~ ^[a-zA-Z][-a-zA-Z0-9]*$ ]]; then
  echo "STACK_NAME is not a valid CloudFormation stack name: $stack_name" >&2
  exit 2
fi
if [[ ! "$resource_name_prefix" =~ ^[a-z0-9-]+$ ]]; then
  echo "RESOURCE_NAME_PREFIX must contain only lowercase letters, digits and hyphens." >&2
  exit 2
fi
if [[ "$ssm_prefix" != /* ]]; then
  echo "SSM_PREFIX must start with /, got: $ssm_prefix" >&2
  exit 2
fi
if [[ ! "$todoist_calendar_sync_slack_channel" =~ ^C[A-Z0-9]+$ ]]; then
  echo "TODOIST_CALENDAR_SYNC_SLACK_CHANNEL must be a Slack channel ID (C...)." >&2
  exit 2
fi
if [[ "$erasure_execution_enabled" != "true" && "$erasure_execution_enabled" != "false" ]]; then
  echo "ERASURE_EXECUTION_ENABLED must be exactly true or false." >&2
  exit 2
fi

# Validate profile JSON without logging it.
SYNC_PROFILE_CONFIG_JSON="$sync_profile_config_json" node --input-type=module <<'NODE'
const raw = process.env.SYNC_PROFILE_CONFIG_JSON;
const value = JSON.parse(raw);
for (const profile of ['home', 'antonio', 'work']) {
  const entry = value?.[profile];
  if (!entry || typeof entry !== 'object') throw new Error(`Missing profile ${profile}`);
  for (const field of ['calendarId', 'channelId', 'todoistRoute', 'todoistProjectId']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`Missing ${profile}.${field}`);
  }
}
NODE

cd "$script_dir"
# Fail closed on accidental paid provisioned-capacity changes, even when the
# deploy job reuses a previously validated SAM build.
STATE_TABLE_READ_CAPACITY="$state_table_read_capacity" \
STATE_TABLE_WRITE_CAPACITY="$state_table_write_capacity" \
PROFILE_LOOKUP_INDEX_READ_CAPACITY="$profile_lookup_index_read_capacity" \
PROFILE_LOOKUP_INDEX_WRITE_CAPACITY="$profile_lookup_index_write_capacity" \
  node scripts/check-dynamodb-capacity.mjs

if [ "$skip_source_validation" = "true" ]; then
  if [ ! -f .aws-sam/build/template.yaml ]; then
    echo "SKIP_SOURCE_VALIDATION=true but .aws-sam/build/template.yaml does not exist." >&2
    exit 1
  fi
  echo "Reusing validated SAM build produced earlier in this job."
else
  npm ci
  export PATH="$script_dir/node_modules/.bin:$PATH"
  command -v esbuild >/dev/null
  sam validate --lint --template template.yaml
  sam build --template template.yaml
  npm test
  bash scripts/check-public-source.sh
fi

aws sts get-caller-identity --region "$region" >/dev/null

# This stack deploys automatically on successful master CI. Do not lower
# live provisioned throughput merely because a new default was merged.
# Compare all four live stack parameters; if CloudFormation cannot verify
# them, fail closed before any SAM deployment / infrastructure mutation.
if [ "$capacity_reduction_approved" != "true" ]; then
  current_capacity="$(aws cloudformation describe-stacks \
    --region "$region" --stack-name "$stack_name" \
    --query "Stacks[0].Parameters[?ParameterKey=='StateTableReadCapacity' || ParameterKey=='StateTableWriteCapacity' || ParameterKey=='ProfileLookupIndexReadCapacity' || ParameterKey=='ProfileLookupIndexWriteCapacity'].[ParameterKey,ParameterValue]" \
    --output text)"
  current_table_read=""
  current_table_write=""
  current_index_read=""
  current_index_write=""
  while read -r capacity_key capacity_value; do
    case "$capacity_key" in
      StateTableReadCapacity) current_table_read="$capacity_value" ;;
      StateTableWriteCapacity) current_table_write="$capacity_value" ;;
      ProfileLookupIndexReadCapacity) current_index_read="$capacity_value" ;;
      ProfileLookupIndexWriteCapacity) current_index_write="$capacity_value" ;;
    esac
  done <<< "$current_capacity"
  for current in "$current_table_read" "$current_table_write" "$current_index_read" "$current_index_write"; do
    if [[ ! "$current" =~ ^[1-9][0-9]*$ ]]; then
      echo "Cannot verify all current DynamoDB capacity parameters. Refusing an unapproved deployment." >&2
      exit 1
    fi
  done
  if (( state_table_read_capacity < current_table_read ||
        state_table_write_capacity < current_table_write ||
        profile_lookup_index_read_capacity < current_index_read ||
        profile_lookup_index_write_capacity < current_index_write )); then
    echo "Production DynamoDB capacity reduction is not approved. Confirm #256 retry rollout, current throttles/queue health and set DYNAMODB_CAPACITY_REDUCTION_APPROVED=true in the production environment for the controlled deployment." >&2
    exit 1
  fi
fi

for parameter_name in \
  "$calendar_watch_token_parameter" \
  "$todoist_webhook_secret_parameter" \
  "$proxy_shared_secret_parameter" \
  "$google_prefix/home" \
  "$google_prefix/antonio" \
  "$google_prefix/work" \
  "$todoist_prefix/home" \
  "$todoist_prefix/antonio" \
  "$todoist_prefix/work" \
  "$slack_bot_token_parameter"; do
  validate_parameter_name "$parameter_name"
done

echo "Validated required SSM parameter names without decrypting values."

sam deploy \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$stack_name" \
  --region "$region" \
  --s3-bucket "$code_bucket" \
  --s3-prefix todoist-calendar-sync/sam \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ResourceNamePrefix=$resource_name_prefix" \
    "StateTableReadCapacity=$state_table_read_capacity" \
    "StateTableWriteCapacity=$state_table_write_capacity" \
    "ProfileLookupIndexReadCapacity=$profile_lookup_index_read_capacity" \
    "ProfileLookupIndexWriteCapacity=$profile_lookup_index_write_capacity" \
    "CompletedHistoryCleanupApply=$completed_history_cleanup_apply" \
    "ErasureExecutionEnabled=$erasure_execution_enabled" \
    "CalendarWatchTokenParameter=$calendar_watch_token_parameter" \
    "TodoistWebhookSecretParameter=$todoist_webhook_secret_parameter" \
    "ProxySharedSecretParameter=$proxy_shared_secret_parameter" \
    "CalendarWatchCallbackUrl=$calendar_watch_callback_url" \
    "GoogleCredentialsParameterPrefix=$google_prefix" \
    "TodoistTokenParameterPrefix=$todoist_prefix" \
    "SlackBotTokenParameter=$slack_bot_token_parameter" \
    "TodoistCalendarSyncSlackChannel=$todoist_calendar_sync_slack_channel" \
    "ProfileConfigJson=$sam_profile_config_json" \
    "CloudflareAccessIssuer=$cloudflare_access_issuer" \
    "CloudflareAccessAudience=$cloudflare_access_audience" \
    "ReviewOperatorEmails=$review_operator_emails" \
    ${BILLING_ALARM_EMAIL:+"BillingAlarmEmail=$BILLING_ALARM_EMAIL"}
