#!/usr/bin/env bash
set -euo pipefail

zone_id="${CLOUDFLARE_ZONE_ID:-0f12928eb058337bf9af778cb6e8ba90}"
ruleset_name="todoist-calendar-sync Calendar webhook WAF exceptions"
api="https://api.cloudflare.com/client/v4/zones/${zone_id}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

api_call() {
  curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json' "$@"
}

expression='http.host eq "calendar-sync.alf-broadcast.co.uk" and http.request.method eq "POST" and http.request.uri.path eq "/calendar"'
rules="$(jq -cn --arg expression "$expression" '[{ref:"calendar_sync_webhook_skip_current_phase",description:"Allow Google Calendar webhook POSTs through the remaining custom WAF rules",expression:$expression,action:"skip",action_parameters:{phase:"current"},enabled:true}]')"
existing_id="$(api_call "${api}/rulesets?per_page=100" | jq -r --arg name "$ruleset_name" '.result[] | select(.name == $name and .kind == "custom" and .phase == "http_request_firewall_custom") | .id' | head -n1)"
payload="$(jq -cn --arg name "$ruleset_name" --argjson rules "$rules" '{name:$name,description:"Calendar-specific WAF bypass owned by todoist-calendar-sync",kind:"custom",phase:"http_request_firewall_custom",rules:$rules}')"

if [[ -n "$existing_id" ]]; then
  api_call -X PUT "${api}/rulesets/${existing_id}" --data "$payload" >/dev/null
  action=updated
else
  response="$(api_call -X POST "${api}/rulesets" --data "$payload")"
  existing_id="$(jq -r '.result.id // empty' <<<"$response")"
  [[ -n "$existing_id" ]] || { echo 'Cloudflare did not return a ruleset ID.' >&2; exit 1; }
  action=created
fi

echo "Calendar WAF custom ruleset ${action}: ${existing_id}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "ruleset_id=${existing_id}" >> "$GITHUB_OUTPUT"; fi
