# Calendar Cloudflare Worker

This Worker owns only `POST /calendar` on `calendar-sync.alf-broadcast.co.uk`.
It accepts the legacy and current Google Calendar channel-ID generations used by
the application, removes any incoming `x-gcp-proxy-auth`, injects the canonical
Worker secret, and forwards the request to the AWS ingress Lambda.

The secret is provisioned from the canonical AWS SSM parameter
`/todoist-calendar-sync/proxy-shared-secret` during the production deployment.
No secret value is stored in this repository or logged by the Worker.
