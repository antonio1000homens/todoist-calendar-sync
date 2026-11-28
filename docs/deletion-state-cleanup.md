# Verified provider deletion state cleanup

After a mapped provider pair has been deleted and the provider response or
direct absence read confirms that deletion, automatic webhook, snapshot
reconciliation, and approved manual deletion paths call
`StateRepository.purgeDeletedPair` with the exact task, event, and recurrence
identities. The method uses consistent point reads followed by one conditional
transaction. It removes only matching `TASK`, `EVENT`, `TASKOWNER`, `RECURRENCE`,
`BASELINE`, `CANONICAL`, and `VERSION` rows. A changed identity or version
leaves the newer row intact and makes cleanup incomplete so delivery/review can
retry with current evidence. It does not scan the table or use TTL to perform
cleanup.

Single-instance cancellation and this-and-future recurrence edits do not invoke
whole-pair cleanup: the surviving series, active occurrence, exceptions, and
their correlation state remain available. Completed Calendar history follows
its existing seven-day retention policy and is managed separately.

Audit rows remain for operational diagnosis and delivery rows remain for
webhook deduplication. Neither is a correlation source, and neither can
reconstruct or authorize a mapping. No owner marker, deletion tombstone, or
erasure fence is retained by this cleanup.
