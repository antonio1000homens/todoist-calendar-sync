# Calendar Cloudflare Worker

This Worker owns `POST /calendar` and Todoist webhook routes (`/todoist` or
`/todoist-<profile>` using lowercase letters, digits, and single hyphens) on
`calendar-sync.alf-broadcast.co.uk`. It accepts the legacy and current Google
Calendar channel-ID generations used by the application. For accepted webhook
routes, it removes any incoming `x-gcp-proxy-auth`, injects the canonical Worker
secret, and forwards the original request body and provider headers to AWS
ingress. The Lambda validates the configured Todoist route and Todoist HMAC
before queueing a delivery.

The secret is provisioned from the canonical AWS SSM parameter
`/todoist-calendar-sync/proxy-shared-secret` during the production deployment.
No secret value is stored in this repository or logged by the Worker.
