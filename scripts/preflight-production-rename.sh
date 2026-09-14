#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
LEGACY_STACK_NAME="${LEGACY_STACK_NAME:-gcp-app2-sync}"
TARGET_STACK_NAME="${TARGET_STACK_NAME:-todoist-calendar-sync}"
LEGACY_SSM_PREFIX="${LEGACY_SSM_PREFIX:-/lambdas/gcp-app2-sync}"
TARGET_SSM_PREFIX="${TARGET_SSM_PREFIX:-/todoist-calendar-sync}"

aws sts get-caller-identity --region "$AWS_REGION" >/dev/null

if ! aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$LEGACY_STACK_NAME" >/dev/null 2>&1; then
  echo "Legacy stack not found: $LEGACY_STACK_NAME" >&2
  exit 1
fi

legacy_status="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" --stack-name "$LEGACY_STACK_NAME" \
  --query 'Stacks[0].StackStatus' --output text)"
case "$legacy_status" in
  *_COMPLETE) ;;
  *) echo "Legacy stack is not in a stable *_COMPLETE state: $legacy_status" >&2; exit 1 ;;
esac

if aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$TARGET_STACK_NAME" >/dev/null 2>&1; then
  target_status="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" --stack-name "$TARGET_STACK_NAME" \
    --query 'Stacks[0].StackStatus' --output text)"
  echo "Target stack already exists: $TARGET_STACK_NAME ($target_status)"
else
  echo "Target stack does not yet exist: $TARGET_STACK_NAME"
fi

output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" --stack-name "$LEGACY_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text
}

queue_url="$(output QueueUrl)"
dlq_url="$(output DlqUrl)"
state_table="$(output StateTableName)"
ingress_url="$(output IngressFunctionUrl)"

for required in queue_url dlq_url state_table ingress_url; do
  value="${!required:-}"
  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "Legacy stack output is missing: $required" >&2
    exit 1
  fi
done

read -r visible inflight delayed < <(aws sqs get-queue-attributes \
  --region "$AWS_REGION" --queue-url "$queue_url" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed \
  --query '[Attributes.ApproximateNumberOfMessages,Attributes.ApproximateNumberOfMessagesNotVisible,Attributes.ApproximateNumberOfMessagesDelayed]' \
  --output text)

read -r dlq_visible dlq_inflight < <(aws sqs get-queue-attributes \
  --region "$AWS_REGION" --queue-url "$dlq_url" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query '[Attributes.ApproximateNumberOfMessages,Attributes.ApproximateNumberOfMessagesNotVisible]' \
  --output text)

state_status="$(aws dynamodb describe-table --region "$AWS_REGION" --table-name "$state_table" --query 'Table.TableStatus' --output text)"
deletion_protection="$(aws dynamodb describe-table --region "$AWS_REGION" --table-name "$state_table" --query 'Table.DeletionProtectionEnabled' --output text)"
pitr_status="$(aws dynamodb describe-continuous-backups --region "$AWS_REGION" --table-name "$state_table" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)"

suffixes=(
  calendar-watch-token
  todoist-webhook-secret
  proxy-shared-secret
  google/home google/antonio google/work
  todoist/home todoist/antonio todoist/work
)
legacy_missing=0
target_missing=0
for suffix in "${suffixes[@]}"; do
  aws ssm get-parameter --region "$AWS_REGION" --name "${LEGACY_SSM_PREFIX%/}/$suffix" --query 'Parameter.Name' --output text >/dev/null 2>&1 || legacy_missing=$((legacy_missing + 1))
  aws ssm get-parameter --region "$AWS_REGION" --name "${TARGET_SSM_PREFIX%/}/$suffix" --query 'Parameter.Name' --output text >/dev/null 2>&1 || target_missing=$((target_missing + 1))
done

cat <<EOF
Production rename preflight
  region:                 $AWS_REGION
  legacy stack:           $LEGACY_STACK_NAME ($legacy_status)
  target stack:           $TARGET_STACK_NAME
  source queue visible:   $visible
  source queue in-flight: $inflight
  source queue delayed:   $delayed
  DLQ visible:            $dlq_visible
  DLQ in-flight:          $dlq_inflight
  state table:            $state_table ($state_status)
  deletion protection:    $deletion_protection
  PITR:                   $pitr_status
  legacy SSM missing:     $legacy_missing / ${#suffixes[@]}
  target SSM missing:     $target_missing / ${#suffixes[@]}
  ingress URL present:    yes
EOF

[[ "$state_status" == "ACTIVE" ]] || { echo 'State table must be ACTIVE.' >&2; exit 1; }
[[ "$deletion_protection" == "True" || "$deletion_protection" == "true" ]] || { echo 'State table deletion protection must be enabled.' >&2; exit 1; }
[[ "$pitr_status" == "ENABLED" ]] || { echo 'State table PITR must be enabled.' >&2; exit 1; }
(( legacy_missing == 0 )) || { echo 'One or more legacy SSM parameters are missing.' >&2; exit 1; }
(( target_missing == 0 )) || { echo 'Canonical SSM parameters are not complete; run scripts/migrate-ssm-prefix.sh first.' >&2; exit 1; }

if (( visible != 0 || inflight != 0 || delayed != 0 )); then
  echo 'Source queue is not drained. Do not start the ownership/physical-name cutover.' >&2
  exit 3
fi

printf 'Read-only production rename preflight passed. No AWS resources were modified.\n'
