#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
SSM_PREFIX="${SSM_PREFIX:-/todoist-calendar-sync}"
SHARED_SSM_PREFIX="${SHARED_SSM_PREFIX:-/lambdas/shared}"

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo 'GITHUB_ENV is required; this script is intended for GitHub Actions.' >&2
  exit 1
fi

load_parameter() {
  local env_name="$1"
  local parameter_name="$2"
  local value

  if ! value="$(aws ssm get-parameter \
      --name "$parameter_name" \
      --with-decryption \
      --region "$AWS_REGION" \
      --query 'Parameter.Value' \
      --output text)"; then
    echo "Unable to load required SSM parameter: ${parameter_name}" >&2
    exit 1
  fi

  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "SSM parameter returned an empty value: ${parameter_name}" >&2
    exit 1
  fi

  echo "::add-mask::${value}"
  {
    echo "${env_name}<<__SSM_${env_name}__"
    printf '%s\n' "$value"
    echo "__SSM_${env_name}__"
  } >> "$GITHUB_ENV"
}

case "$mode" in
  provider-smoke)
    load_parameter GOOGLE_HOME_CREDENTIALS "${SSM_PREFIX%/}/google/home"
    load_parameter GOOGLE_ANTONIO_CREDENTIALS "${SSM_PREFIX%/}/google/antonio"
    load_parameter GOOGLE_WORK_CREDENTIALS "${SSM_PREFIX%/}/google/work"
    load_parameter TODOIST_HOME_TOKEN "${SSM_PREFIX%/}/todoist/home"
    load_parameter TODOIST_ANTONIO_TOKEN "${SSM_PREFIX%/}/todoist/antonio"
    load_parameter TODOIST_WORK_TOKEN "${SSM_PREFIX%/}/todoist/work"
    load_parameter SLACK_BOT_TOKEN "${SHARED_SSM_PREFIX%/}/slack-bot-token"
    ;;
  *)
    echo 'Usage: scripts/load-ssm-secrets.sh provider-smoke' >&2
    exit 2
    ;;
esac
