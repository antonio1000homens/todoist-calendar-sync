#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
region="${AWS_REGION:-eu-west-2}"
stack_name="${DEPLOYMENT_ROLE_STACK_NAME:-todoist-calendar-sync-github-actions-role}"
e2e_access_stack_name="${E2E_ACCESS_STACK_NAME:-todoist-calendar-sync-github-actions-e2e-access}"
role_name="${DEPLOYMENT_ROLE_NAME:-GitHubActionsTodoistCalendarSyncDeployRole}"
code_bucket="${CODE_BUCKET:-}"
application_stack="${APPLICATION_STACK_NAME:-todoist-calendar-sync}"
legacy_application_stack="${LEGACY_APPLICATION_STACK_NAME:-gcp-app2-sync}"
resource_name_prefix="${RESOURCE_NAME_PREFIX:-todoist-calendar-sync}"
legacy_resource_name_prefix="${LEGACY_RESOURCE_NAME_PREFIX:-gcp-app2-sync}"
legacy_sam_bucket="${SAM_CLI_MANAGED_SOURCE_BUCKET_NAME:-}"

if [[ -z "$code_bucket" ]]; then
  echo 'CODE_BUCKET is required.' >&2
  exit 2
fi
if [[ -z "$legacy_sam_bucket" ]]; then
  echo 'SAM_CLI_MANAGED_SOURCE_BUCKET_NAME is required during the legacy cutover.' >&2
  exit 2
fi

aws sts get-caller-identity --region "$region" >/dev/null

aws cloudformation deploy \
  --region "$region" \
  --stack-name "$stack_name" \
  --template-file "$script_dir/github-actions-deploy-role.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "DeploymentRoleName=$role_name" \
    "CodeBucketName=$code_bucket" \
    "ApplicationStackName=$application_stack" \
    "LegacyApplicationStackName=$legacy_application_stack" \
    "ResourceNamePrefix=$resource_name_prefix" \
    "LegacyResourceNamePrefix=$legacy_resource_name_prefix" \
    "SamCliManagedSourceBucketName=$legacy_sam_bucket" \
  >&2

aws cloudformation deploy \
  --region "$region" \
  --stack-name "$e2e_access_stack_name" \
  --template-file "$script_dir/github-actions-e2e-access.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "DeploymentRoleName=$role_name" \
    "ResourceNamePrefix=$resource_name_prefix" \
  >&2

role_arn="$(aws cloudformation describe-stacks \
  --region "$region" \
  --stack-name "$stack_name" \
  --query "Stacks[0].Outputs[?OutputKey=='DeploymentRoleArn'].OutputValue | [0]" \
  --output text)"

if [[ ! "$role_arn" =~ ^arn:aws[a-zA-Z-]*:iam::[0-9]{12}:role/.+ ]]; then
  echo "Unable to resolve deployment role ARN from stack $stack_name" >&2
  exit 1
fi

printf '%s\n' "$role_arn"
