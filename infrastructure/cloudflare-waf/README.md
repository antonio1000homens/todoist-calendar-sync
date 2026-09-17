# Calendar WAF custom ruleset

This Terraform stack owns the Calendar-specific zone custom ruleset only. It
does not manage the zone `http_request_firewall_custom` entry point; Windsor
continues to own that entry point and executes this ruleset from it.

The ruleset has one narrow rule for `POST /calendar` on
`calendar-sync.alf-broadcast.co.uk`. Its `phase = "current"` skip action skips
the remaining custom rules in the zone phase, including Windsor's geography
block and non-Sky managed challenge rules.

State is stored in the existing project S3 bucket under:

```text
todoist-calendar-sync/cloudflare-waf/terraform.tfstate
```

The deployment workflow prints only the resulting ruleset ID. Set that value
as Windsor's `CALENDAR_SYNC_CUSTOM_RULESET_ID` repository variable before
removing Windsor's inline Calendar exceptions.
