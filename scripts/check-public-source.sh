#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
report() {
  printf 'public-source check failed: %s\n' "$1" >&2
  fail=1
}

# These files must never be committed, even if their contents are encrypted or
# appear harmless. Report paths only; never echo file contents.
while IFS= read -r path; do
  case "$path" in
    .env|.env.*|config/bootstrap-ssm-migration.env|config/profile-config.env|flows.json|flows_cred.json|.flows*.backup|.config*.json|.config*.backup|.sessions.json)
      report "forbidden tracked file: $path"
      ;;
  esac
done < <(git ls-files)

# Build/generated output should be reproducible and must not be published as
# repository source.
if git ls-files 'dist/**' '.aws-sam/**' 'node_modules/**' | grep -q .; then
  report 'generated build output is tracked (dist/.aws-sam/node_modules)'
fi

# Look for high-confidence credential material. Keep the expressions narrow so
# documentation can safely mention variable names without failing the check.
secret_regex='AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----|bws_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}'
while IFS= read -r path; do
  report "credential-shaped content in tracked file: $path"
done < <(git grep -IlE "$secret_regex" -- . \
  ':(exclude)scripts/check-public-source.sh' \
  ':(exclude)package-lock.json' 2>/dev/null || true)

# Catch quoted literal secret assignments, but allow normal variable plumbing
# such as `client_secret: value.client_secret`. The scanner reports paths only.
while IFS= read -r path; do
  report "possible plaintext secret literal in: $path"
done < <(python3 - <<'PY'
import pathlib
import re
import subprocess

tracked = subprocess.check_output(
    ["git", "ls-files", "src", "scripts", "infrastructure", ".github", "*.json", "*.yaml", "*.yml"],
    text=True,
).splitlines()
pattern = re.compile(
    r"(?i)(client_secret|refresh_token|access_token|api[_-]?key|webhook_secret|password)"
    r"\s*[:=]\s*(['\"])(?!\$\{|<|replace|example|test)[^'\"\n]{8,}\2"
)
for name in tracked:
    path = pathlib.Path(name)
    if not path.is_file() or path.as_posix() == "scripts/check-public-source.sh":
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    if pattern.search(text):
        print(path.as_posix())
PY
)

# Real Slack channel IDs and personal/provider email addresses are operational
# metadata. Public tests/examples should use unmistakably synthetic identifiers.
while IFS= read -r path; do
  report "production-looking Slack channel ID in: $path"
done < <(git grep -IlE '\bC[0-9][A-Z0-9]{8,}\b' -- . \
  ':(exclude)scripts/check-public-source.sh' 2>/dev/null || true)

while IFS= read -r path; do
  report "non-test email address in public source: $path"
done < <(git grep -IlE '@[A-Za-z0-9.-]+\.(com|co\.uk|net|org|io|dev)\b' -- . \
  ':(exclude)scripts/check-public-source.sh' 2>/dev/null || true)

# The former service name is allowed only in explicit migration/compatibility
# surfaces. Any new active-code reference is a regression toward the legacy
# identity and should fail before publication.
while IFS= read -r path; do
  case "$path" in
    README.md|docs/production-rename.md|PROJECT-COMMENT-MIGRATION.md|scripts/migrate-ssm-prefix.sh|scripts/preflight-production-rename.sh|infrastructure/bootstrap-deployment-role.sh|infrastructure/github-actions-deploy-role.yaml|src/mapping-comments.ts|scripts/check-public-source.sh)
      ;;
    *) report "legacy gcp-app2 reference outside migration compatibility boundary: $path" ;;
  esac
done < <(git grep -IlEi 'gcp[-_]?app2' -- . 2>/dev/null || true)

if (( fail != 0 )); then
  exit 1
fi

printf 'Public-source boundary check passed.\n'
