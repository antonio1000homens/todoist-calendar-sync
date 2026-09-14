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
google_prefix="${GOOGLE_CREDENTIALS_PARAMETER_PREFIX:-${ssm_prefix%/}/google}"
todoist_prefix="${TODOIST_TOKEN_PARAMETER_PREFIX:-${ssm_prefix%/}/todoist}"
slack_bot_token_parameter="${SLACK_BOT_TOKEN_PARAMETER:-/lambdas/shared/slack-bot-token}"
todoist_calendar_sync_slack_channel="${TODOIST_CALENDAR_SYNC_SLACK_CHANNEL:-}"
sync_profile_config_json="${SYNC_PROFILE_CONFIG_JSON:-}"
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
    "CalendarWatchTokenParameter=$calendar_watch_token_parameter" \
    "TodoistWebhookSecretParameter=$todoist_webhook_secret_parameter" \
    "ProxySharedSecretParameter=$proxy_shared_secret_parameter" \
    "GoogleCredentialsParameterPrefix=$google_prefix" \
    "TodoistTokenParameterPrefix=$todoist_prefix" \
    "SlackBotTokenParameter=$slack_bot_token_parameter" \
    "TodoistCalendarSyncSlackChannel=$todoist_calendar_sync_slack_channel" \
    "ProfileConfigJson=$sam_profile_config_json" \
    ${BILLING_ALARM_EMAIL:+"BillingAlarmEmail=$BILLING_ALARM_EMAIL"}
