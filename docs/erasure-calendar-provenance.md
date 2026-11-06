# Issue #333 — independently attested Calendar direct-ID coverage

**Read-only observer, not recovery authorization.** This procedure does not
install markers, modify mappings, clear fences, replay events or authorize
`ERASURE_REPLAY_BARRIER_VERSION`. Keep that setting OFF under #307/#330.

## Why a separate registry is necessary

Google `users/me/calendarList` lists only calendars on each credential's
calendar list. It cannot enumerate calendars reachable through a calendar ID
that is known to the application, including legacy routing and direct-ID-only
sharing. The current configured calendar is also sometimes absent from
CalendarList. A CalendarList-only report therefore cannot prove a negative.

**Authoritative input:** a separately maintained, independently reviewed
private register containing *every* source/destination Calendar ID that any
deployed profile can address (current routing, historical routes, explicit
shared ACLs and any calendars observed on the three CalendarLists).
The registry must be prepared independently from the live event inventory and
reviewed against deployed configuration, historical routes, delegated shares
and the relevant owners' ACL records. Google does not offer a universal
direct-ID discovery endpoint. If the reviewer cannot attest that the register
exhausts this set, **do not set `complete:true`**; the report stays incomplete.

The register is signed with an **offline Ed25519 key**. The public SPKI DER
base64 trust key is supplied via the optional SAM parameter
`ErasureCalendarProvenancePublicKeySpki`, passed by the deployment variable
`ERASURE_CALENDAR_PROVENANCE_PUBLIC_KEY_SPKI_B64`. An absent trust key
cannot be supplied by a command-line override. The audit reads it from the
exact verified Lambda deployment being audited. The signer and external ACL
reviewer must be independent of the live provider enumeration. Never treat
a signature as proof that an inaccurate registry is comprehensive.

## Private manifest format

Prepare a JSON object locally (do **not** commit real calendar IDs, the
evidence record, the signed manifest or the signing key to GitHub). The
example identifiers are deliberately fictional.

```json
{
  "version": 1,
  "source": "independently-reviewed-routing-and-calendar-acl-register",
  "evidenceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "complete": true,
  "observedAt": "2026-11-04T21:00:00.000Z",
  "expiresAt": "2026-11-04T21:04:00.000Z",
  "accountId": "123456789012",
  "region": "eu-west-2",
  "functionName": "verified-deployed-function-name",
  "qualifier": "42",
  "routingFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "profiles": {
    "home": {
      "configuredCalendarId": "home@example.test",
      "calendars": [{"id":"home@example.test","origin":"configured","direction":"both","accessRole":"owner"}]
    },
    "antonio": {
      "configuredCalendarId": "antonio@example.test",
      "calendars": [{"id":"antonio@example.test","origin":"configured","direction":"both","accessRole":"owner"}]
    },
    "work": {
      "configuredCalendarId": "work@example.test",
      "calendars": [
        {"id":"work@example.test","origin":"configured","direction":"both","accessRole":"owner"},
        {"id":"shared-direct@example.test","origin":"shared","direction":"both","accessRole":"reader"},
        {"id":"old-route@example.test","origin":"legacy","direction":"destination","accessRole":"reader"}
      ]
    }
  }
}
```

Use `origin` from `configured`, `legacy`, `shared`, `calendar-list`;
`direction` from `source`, `destination`, `both`; `accessRole` from
`owner`, `writer`, `reader`, `writerWithoutPrivateAccess`,
`freeBusyReader`. One `configured` entry with `both` direction is mandatory
per profile, and no ID may appear twice within a profile. Each profile's
actual CalendarList IDs must also be represented: any unexpected new listed
ID prevents completeness, as do mismatched listed access roles.

The `evidenceSha256` must reference the separately reviewed *private*
source/ACL evidence, not the current Calendar event output itself.
`routingFingerprint` is SHA-256 of a canonical sorted-key encoding of
the deployed `SYNC_PROFILE_CONFIG_JSON`; use
`calendarRoutingFingerprint(JSON.parse(...))` from
`dist/erasure-calendar-provenance.js` after `npm run build` using a **secure,
local** copy of that deployed configuration.

## Offline signing and audit

1. Generate an Ed25519 keypair off-repository. Example using OpenSSL:
   `openssl genpkey -algorithm Ed25519 -out /secure/calendar-audit.key`
2. Export the public trust key:
   `openssl pkey -in /secure/calendar-audit.key -pubout -outform DER | openssl base64 -A`.
   Store this *public* value in the protected deployment variable noted above.
   Do not store or upload the private key.
3. Complete and independently review the register; set `observedAt` and
   `expiresAt` for a maximum five-minute freshness window. Then sign:
   `npm run build && node scripts/sign-erasure-calendar-provenance.mjs --manifest=/secure/calendar-registry.json --private-key=/secure/calendar-audit.key > /secure/calendar-registry.signed.json`.
   Restrict the signed file's permissions; it contains private Calendar IDs.
4. Run the existing read-only live audit with its original required
   `--profile`, `--expected-account`, `--region`, `--function`,
   `--qualifier`, `--task-id`, `--event-id` arguments, and add:
   `--calendar-provenance-file=/secure/calendar-registry.signed.json`.

Signing the document does not call any provider. The live CLI validates the
signature and deployment binding before injecting the register into the
read-only observer. The CLI still exits 2 (non-authoritative evidence only).
If the key or registry is unavailable, omit the optional manifest argument:
the observer still runs, with calendar coverage explicitly **incomplete**.
Bad signatures, conflicting deployment identities, malformed manifests,
unavailable provider pages or service errors fail closed.

## What the redacted evidence represents

The observer combines the signed register's full Calendar IDs with the
fresh CalendarList entries for each of `home`, `antonio`, `work`,
enumerates all available calendars directly by ID, pages unfiltered event
details including deleted exceptions, indexes task tags, recurrence masters,
instances and aliases, and compares direct event reads/ETags against the full
inventories. Results include only counts, completeness flags and fingerprints
of the attestation, calendar scope and event evidence. No Calendar IDs,
event IDs, task titles, credential secrets or comment bodies are returned.

Coverage is false when the signature is absent, the signed snapshot is older
than five minutes, the deployed routing scope differs, listed calendars are
not included, ACL roles disagree, calendars are free/busy-only or hide private
details, the events endpoint is unreadable, ETags are missing, or direct event
versions conflict. Pagination loops and provider 429/5xx remain fatal.

A provider 404 alone never proves erasure. The derived
`knownIdentitiesAbsentFromCurrentProviders` may be true only in combination
with complete current signed Calendar scope, inventories and closed identity
alias evidence; it is *still not* a release or cleanup authorization.
Current provider snapshots, DynamoDB table scans and independent historical
ACL review are not transactional. Action-time verification, writer admission,
privacy/IAM approvals and #330 gates remain mandatory.
