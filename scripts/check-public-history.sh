#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'EOF'
gitleaks is required for the full-history audit.
Install it locally (for example with Homebrew) and rerun this script.
EOF
  exit 2
fi

# Fetch every ordinary remote ref available before scanning. Pull-request refs
# may require an explicit mirror clone and are assessed separately before the
# visibility change.
git fetch --all --tags --prune >/dev/null 2>&1 || true

printf 'Scanning all reachable Git history with secret values redacted...\n'

if gitleaks help 2>&1 | grep -Eq '^[[:space:]]+git[[:space:]]'; then
  exec gitleaks git --redact --no-banner --log-opts='--all' .
fi

# Compatibility with older v8 installations where `detect` is still the
# documented command.
exec gitleaks detect --source . --redact --no-banner --log-opts='--all'
