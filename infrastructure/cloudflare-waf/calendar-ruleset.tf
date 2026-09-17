resource "cloudflare_ruleset" "calendar_sync_custom_waf" {
  zone_id     = var.cloudflare_zone_id
  name        = "todoist-calendar-sync Calendar webhook WAF exceptions"
  description = "Calendar-specific WAF bypass owned by todoist-calendar-sync"
  kind        = "custom"
  phase       = "http_request_firewall_custom"

  rules = [{
    ref         = "calendar_sync_webhook_skip_current_phase"
    description = "Allow Google Calendar webhook POSTs through the remaining custom WAF rules"
    expression  = <<-EOT
      http.host eq "calendar-sync.alf-broadcast.co.uk" and
      http.request.method eq "POST" and
      http.request.uri.path eq "/calendar"
    EOT
    action      = "skip"
    action_parameters = {
      phase = "current"
    }
    enabled = true
  }]
}

output "calendar_sync_custom_ruleset_id" {
  description = "Pass this ID to Windsor's CALENDAR_SYNC_CUSTOM_RULESET_ID repository variable."
  value       = cloudflare_ruleset.calendar_sync_custom_waf.id
}
