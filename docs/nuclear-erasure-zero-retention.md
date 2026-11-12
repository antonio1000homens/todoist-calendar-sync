# Nuclear erasure: zero-retention implementation (#349)

**Decision (12 November 2026):** the user accepts the residual risk that delayed SQS, webhook or manually replayed events may recreate a deleted relationship. This is an explicit trade-off for immediate, permanent removal of the selected identity; it does **not** authorize deleting unrelated objects or releasing a different operation's fence. Broader historical-writer hardening remains tracked by #347, independently of this opt-in action.

## Behaviour

- Delete only the exact selected Todoist and Calendar objects, associated project/task mapping comments, attributable DynamoDB rows, identity references in eligible completed delivery receipts, and app-owned Calendar shared links on retained events.
- Never create an 18-day project-comment tombstone or permanent replay marker. Do not retain project notes/comments containing the deleted task/event identity after success, and do not reconnect or recover the deleted relationship.
- The operation uses the existing profile writer fence and conditional deletion inventory during execution; it removes its own temporary operation/confirmation/fence state upon successful guarded completion.
- No **separate user-facing** confirmation or post-deletion verification action is introduced. Internal conditional checks, delivery progress claims and postflight/error handling prevent misreporting failed or unrelated deletions as successful.
- When a provider action fails or an unexpected concurrent change is detected, leave the operation fenced for review rather than deleting unrelated data or silently claiming success.

## Source changes

- `src/erasure-deletion.ts`: delete exact project mapping comments directly, accept provider 404 for already-removed comments, scrub receipt identities under the correct operation fence without relying on any comment marker, and require no deleted-identity-bearing project comment in postflight.
- `src/mapping-comments.ts`: retire the project tombstone writer. Legacy parser and explicit expired-marker cleanup remain for previously persisted markers; they must not create new markers.
- `src/erasure-replay-providers.ts`: existing legacy marker reader remains for old in-flight operations, but no fresh nuclear erasure writes markers.
- `test/erasure-deletion.test.mjs`: cover immediate deletion, missing-comment idempotence, wrong-owner rejection, receipt scrubbing, legacy in-flight marker cleanup and preservation of unrelated notes.

## Deployment caveats

Existing **already-completed** operations may have left 18-day markers under the previous release; this code does not silently delete their markers, because an unrelated or in-progress operation might still own them. Use the existing explicitly scoped legacy cleanup process to assess such markers separately. Existing exceptional erasure execution flags, action-time gate, operation-owned admission fences and deployment policies are unchanged by this PR.

This PR changes only future/current nuclear deletion behaviour. It does not automatically execute deletion of any real Todoist task or Calendar event, create test provider objects, or close #347 / #349 without acceptance evidence.
