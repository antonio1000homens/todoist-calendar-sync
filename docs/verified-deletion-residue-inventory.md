# Verified-deletion residual state inventory (#367)

This command reports **candidate** DynamoDB rows associated with an *already resolved* normal sync deletion. It **never** deletes anything, invokes providers, seeds cases, schedules reconciliation, or changes retention. It is separate from #113 (explicit item erasure), #349 (post-write erasure recovery), and the #114 completed-history lifecycle.

## Scope and guardrails

- Explicit `STATE_TABLE_NAME` and `AWS_REGION`, `--profile`, at least one **exact** terminal `--case` and one exact Todoist or Calendar provider ID are required.
- Every case is strongly read from DynamoDB and must have `status=resolved`, `result` beginning `resolved_deleted`, and matching profile. A missing/expired terminal receipt refuses the inventory rather than trying to derive identities from another row.
- Caller-provided identities are **search hints only**. Titles, descriptions and dates are not used to match rows. A case's terminal receipt does not prove every historical alias, provider occurrence, mapping or active repair is absent. The report never marks any row `eligible_and_exclusively_attributable`; this count must remain **zero** until an independent provider/ownership proof is designed and reviewed.
- Strongly consistent, fully paginated **exact-ID** `AUDIT_REF#` queries are performed first (maximum `--max-ref-pages` per supplied ID). The operator-invoked table scan is bounded to 25 evaluated items per page, at most `--max-pages` per invocation, with read pacing and retries for throttling. Neither path is called during webhooks or routine reconciliation.
- Scans are resumable without repeating already completed pages. Cursor checkpoints can include full DynamoDB keys and remain **in a local file with permission 0600**, never in the JSON output. Default location: a scope-hashed filename under the operating system temporary directory. Use `--cursor-file=/secure/path` to select a dedicated destination. `--restart` intentionally discards prior progress for the same scope. Securely dispose of saved checkpoints after the report is complete.
- JSON contains only aggregate family/category counts, scan budget usage, and a clear complete/partial status. No raw task/event IDs, titles, descriptions, audit details, case IDs or cursor key values are printed. Do not treat base64 encodings of DynamoDB keys as redaction.

## Read-only command

Run in an authorised environment; use IAM permissions limited to `dynamodb:GetItem`, `dynamodb:Query` and `dynamodb:Scan` for the exact state table:

```bash
npm ci
export AWS_REGION=eu-west-2
export STATE_TABLE_NAME=todoist-calendar-sync-state-production
npm run state:inspect-verified-deletion-residue -- \
  --profile=home \
  --case=<exact-verified-deleted-review-case-ID> \
  --task-id=<recorded-task-ID> \
  --event-id=<recorded-calendar-master-ID> \
  --event-id=<recorded-calendar-occurrence-ID> \
  --max-pages=20 --max-ref-pages=8
```

Reissue the **same arguments** to resume a partial scan; optionally increase the per-run page budget within 1..80. A partial report returns exit status 2 and `scanComplete=false`; it is **not** evidence that any unmatched family is absent. Failures of provider/ownership proof are deliberate, not errors to solve by increasing delete permissions. A complete report can be replayed from the beginning with `--restart` if state changes.

For the two original #278 Home cases, use **separate scoped scans** so independent provider identities do not accidentally make a shared record look exclusively attributable. The exact identities are recorded in issue #278; they must not be copied into shared logs or screenshots.

## Meaning of the classifications

| Class | Meaning | Safe to delete? |
| --- | --- | --- |
| `already_retired` | Exact case receipt is identity-free, resolved-by-deletion state | No deletion needed |
| `awaiting_defined_TTL` | Attributable candidate with a valid **future** `expiresAt` | **No**; retain under existing policy |
| `expired_but_still_present` | Expiry is in the past but DynamoDB TTL has not physically removed the row | **No**; expiry is asynchronous |
| `shared_or_active` | Foreign reference, live/operational context, submitted preview, or pending repair | **Never automatically** |
| `unknown_or_incomplete` | Missing TTL, insufficient attribution, or unknown state | **No**, requires further investigation |
| `eligible_and_exclusively_attributable` | Reserved for a future independent proof; deliberately always 0 in this phase | Not implemented |

`matchingAuditsWithoutExactReversePointer` counts matched `AUDIT#` rows lacking an **exact supplied-identity** `AUDIT_REF#` pointer. This is not proof that no pointer exists for another ID. It is an investigative measure, not an approved deletion list. `terminalRepairsWithoutTtl` highlights terminal `REPAIR#` records whose initial write path has no explicit TTL; it does not prove they are orphaned. `expiredUnsubmittedPreviews` counts expired `REPAIR_PREVIEW#` records not marked submitted; independent operation references remain to be ruled out before any future cleanup.

`seenTrackedFamilies` counts **all observed rows** of each tracked family over scanned pages (including unrelated items); `byFamily` counts only rows matched by supplied exact identities or case references. A missing family in a **partial** scan provides no absence evidence. Hashed `CONFLICT_STATE#` keys can be matched only for explicitly supplied identity kinds; other opaque/indexed identities may remain unenumerated until source provenance is established.

## Record-family disposition review

| Family | Current treatment / investigation |
| --- | --- |
| `REVIEW_CASE#`, `REVIEW_CONFLICT#`, `DELETION_REVIEW#`, `CONFLICT_STATE#` | #278 retires exact attributable cases/indexes. Count any residual matching references; revalidate authority before considering cleanup |
| `AUDIT#`, `AUDIT_REF#` | New conflict audits have exact reverse pointers. Legacy records may lack them; #13 grants significant audits a 7-day forensic TTL. Do **not** replace that policy with immediate deletion without separate approval |
| `REPAIR_PREVIEW#` | Preview creation includes `expiresAt`; submitted previews remain linked to operations. DynamoDB TTL is asynchronous |
| `REPAIR#` | Initial creation embeds preview and has **no direct TTL**. Terminal status alone does not waive idempotency, recovery or audit retention; do not delete live/retryable/failed-with-writes operations |
| `MANUAL#`, `SYNC_CONTROL#`, `BASELINE#`, `CANONICAL#`, `TASK#`, `EVENT#`, `TASKOWNER#`, `RECURRENCE#` | Potentially shared, actively used state; inventory is not permission to remove |
| `COMPLETED_TASK#`, `COMPLETED_EVENT#`, `COMPLETED_SERIES#` | Protected historical/completion evidence under #114; never treated as normal conflict residue eligible for deletion |

## Follow-up decision gate

Record aggregate read-only evidence from representative resolved cases on #367, with scan completeness and exact read budgets. First decide whether anything actionable remains **beyond intended TTL retention**. If not, document the outcome and close #367 without adding another writer.

If a real gap is confirmed, separately review whether significant legacy conflict audits should keep their existing seven-day forensic window or qualify for a narrowly scoped early retirement with fresh provider/ownership proof, conditional race checks and backup gating. Independently decide a retention policy for truly terminal, unreferenced repair operations. Neither cleanup path is authorised by this inventory.
