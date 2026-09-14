#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
SOURCE_PREFIX="${SOURCE_PREFIX:-/lambdas/gcp-app2-sync}"
TARGET_PREFIX="${TARGET_PREFIX:-/todoist-calendar-sync}"
DRY_RUN=false
DELETE_SOURCE=false

usage() {
  cat <<'EOF'
Usage: scripts/migrate-ssm-prefix.sh [--dry-run] [--delete-source]

Copies the todoist-calendar-sync project parameters from the legacy SSM
hierarchy to /todoist-calendar-sync without printing plaintext values.

Environment overrides:
  AWS_REGION     AWS region (default: eu-west-2)
  SOURCE_PREFIX  source hierarchy (default: /lambdas/gcp-app2-sync)
  TARGET_PREFIX  target hierarchy (default: /todoist-calendar-sync)
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --delete-source) DELETE_SOURCE=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ "$SOURCE_PREFIX" == /* && "$TARGET_PREFIX" == /* ]] || {
  echo 'SOURCE_PREFIX and TARGET_PREFIX must start with /.' >&2
  exit 2
}
[[ "$SOURCE_PREFIX" != "$TARGET_PREFIX" ]] || {
  echo 'SOURCE_PREFIX and TARGET_PREFIX must differ.' >&2
  exit 2
}

suffixes=(
  calendar-watch-token
  todoist-webhook-secret
  proxy-shared-secret
  google/home
  google/antonio
  google/work
  todoist/home
  todoist/antonio
  todoist/work
)

aws sts get-caller-identity --region "$AWS_REGION" >/dev/null

for suffix in "${suffixes[@]}"; do
  source_name="${SOURCE_PREFIX%/}/$suffix"
  target_name="${TARGET_PREFIX%/}/$suffix"

  if ! aws ssm get-parameter --region "$AWS_REGION" --name "$source_name" --query 'Parameter.Name' --output text >/dev/null 2>&1; then
    echo "Missing source parameter: $source_name" >&2
    exit 1
  fi

  if $DRY_RUN; then
    echo "would copy $source_name -> $target_name"
    continue
  fi

  value="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$source_name" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text)"

  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::add-mask::%s\n' "$value"
  fi

  aws ssm put-parameter \
    --region "$AWS_REGION" \
    --name "$target_name" \
    --type SecureString \
    --value "$value" \
    --overwrite >/dev/null
  unset value

  actual="$(aws ssm get-parameter --region "$AWS_REGION" --name "$target_name" --query 'Parameter.Name' --output text)"
  [[ "$actual" == "$target_name" ]] || {
    echo "Failed to verify target parameter: $target_name" >&2
    exit 1
  }
  echo "copied $source_name -> $target_name"
done

if $DELETE_SOURCE; then
  $DRY_RUN && {
    echo '--delete-source ignored in --dry-run mode.' >&2
    exit 2
  }
  echo 'Refusing automatic source deletion.' >&2
  echo 'Delete legacy parameters only after production is verified on /todoist-calendar-sync.' >&2
  exit 3
fi

printf 'SSM prefix migration complete. Legacy parameters were retained.\n'
