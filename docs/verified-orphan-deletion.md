# Issue #287 — verified, single-target orphan deletion

## Phase 3 — authenticated, read-only server readiness diagnostic

A follow-up branch implements \`GET /review/api/cases/{caseId}/orphan-readiness\`. This
endpoint uses the authenticated operator's selected, persisted review case;
it **rejects arbitrary query IDs**, reads the current provider graph and exact
case-recorded identities, and reports why each recorded Todoist/Calendar
candidate cannot currently be deleted. The UI has a separate **Inspect
deletion readiness (read-only)** control with explicit per-ID blockers.
Failed provider discovery yields HTTP 503 rather than treating incomplete
reads as verified absence.

The diagnostic rejects/flags closed or operation-owned cases, stale or
failed direct reads, recurring items, active controls, saved mapping links,
Calendar task metadata, other live items in the read-only graph and missing
counterpart IDs. It retains the exact case profile, ignores search-only IDs as
selection candidates, and never authorizes a provider write. Its
\`canExecute\` fields are **always false**, and it issues no preview token,
confirmation ID, operation record, mutation, or terminal case state.

**Important:** This is **not** exhaustive cross-provider absence proof. The
backend still needs canonical/reverse metadata enumeration, owner and completed
history inventory, a durable preview/confirmation record, worker admission and
replay fencing, transactional state cleanup, deletion readback, orphan-specific
retirement and two completed reconciliation passes. No deletion is enabled in
the UI or API, even if the read-only report shows an absent recorded counterpart.

## Scope and present implementation status

Merged PR #289 implements the **non-destructive review UI and recovery transition**. This follow-up adds an on-demand read-only server diagnostic. **The actual orphan deletion is not implemented, enabled or safe to approve.** A displayed 404 or missing mapping is not sufficient to prove an orphan.

The review page now offers a single case-scoped `Item to delete` dropdown with title, provider, full ID and status. Candidates come solely from the exact selected case's recorded provider identities and provider snapshots. Rechecking uses the existing read-only current-case endpoint; the operator cannot paste arbitrary IDs into the orphan selector. No orphan is currently eligible or confirmable.

The standalone two-ID plus Calendar-checkbox erasure UI is removed. Its previously-started durable operations remain inspectable, and an independently verified `review_required` operation can use the existing typed `RESTORE SYNC` recovery. Recovery cannot start or resume provider deletion.

## Unscoped API retirement (phase 2 hardening)

The old `POST /review/api/erasure-previews` and `POST /review/api/erasure-operations`
are now **410 Gone by default**, even when generic erasure execution is switched on.
This prevents the former manual two-ID UI from being recreated by directly calling
its arbitrary-ID write endpoints. This is *not* the new orphan deletion executor.
The two endpoints can be explicitly re-enabled only for existing isolated legacy
operator tooling using `ERASURE_LEGACY_UNSCOPED_API_ENABLED=true`; do not set this
in normal production deployment. Existing `GET /erasure-operations/{id}`,
`POST /erasure-operations/{id}/start` (for already-issued operations), and
`/erasure-recoveries/{id}` remain functional. The new case-bound API must
have its own authorization/confirmation, not reuse the legacy opt-in flag.


## Safety invariants for the required executor

Before making **any** candidate eligible, the backend must issue an immutable, single-case, single-profile, single-provider and exact-ID preview with all of the following proof:

1. Current case is open, versioned and item-level; no active repair, erasure or cross-profile ownership.
2. Selected provider identity is live, active, of the correct project/calendar and has a version and canonical ID. Title is for display only.
3. Counterpart is **authoritatively absent** after direct provider reads **and** complete enumeration of equivalent, metadata-linked and reverse-linked candidates. Failed calls, partial delta feeds, empty snapshots and ambiguous matches cannot prove absence.
4. Every task/event and owner mapping index is read consistently, including task-owner/canonical identity, recurrence ownership, synchronization controls, project comments and retained completed-task history. Shared or foreign references are blockers. A stale mapping may be conditionally retired only after all its owners and versions have been verified.
5. Recurring or historical items do not qualify by inference. No generic series deletion, automatic completed-history purge or broad `leftovers:delete`.
6. A profile-level admission/fence protocol drains in-flight workers and protects replay/reconciliation before the first provider write. A durable operation journal must record the exact provider digest, intended DynamoDB effects, confirmation nonce and replay/compensation checkpoints.
7. Explicit confirmation includes the exact case, single selected provider ID and `PERMANENTLY ERASE`. The action re-verifies the frozen preview and fences after confirmation; no implicit second provider deletion is allowed.
8. Provider deletion is side-specific and version-aware (Calendar ETag where supported), followed by direct provider readback. A 429, 5xx, 403, changed ETag, ambiguous 404 or external linked item must preserve repair-required evidence rather than claim success.
9. All state removals use transactional/conditional ownership versions. A partially completed deletion must be resumable only at an idempotent checkpoint, without retrying the provider write unsafely.
10. Postflight must prove provider absence and no attributable dangling indexes or new counterpart. Independently verify at least two subsequent full reconciliation passes and webhook replay behaviour. Only a verified single-case operation may mark `orphan_removed`; the existing two-sided `resolveVerifiedDeletedCase` rule remains unchanged.

## Work remaining

Implement a dedicated orphan preview + confirmation API, immutable durable operation store, fenced single-side executor and postflight verifier. Extend both provider adapters as needed; the current `erasure-preview` requires `taskId`, always selects Todoist deletion, and uses a general live-table purge plan. Reusing that plan as Calendar-only orphan deletion would be unsafe. Retain the existing erasure/recovery API for operations already recorded, but address future arbitrary-ID preview creation before enabling a general deletion release.

Unit tests should cover both providers, stale/cancelled/ambiguous identities, missing vs failed direct reads, zero or multiple matches, recurrence, conflicting mapping indexes, retained history, cross-profile claims, CAS failures and recovery. Integration tests must include intentional failed writes, webhook echo/retries and two subsequent reconciliation passes with disposable provider objects.

**Operator guidance:** Do not merge PR #289 as complete, do not enable orphan deletion from a UI-only match, and leave issue #287 open until the durable executor and destructive end-to-end acceptance criteria pass.
