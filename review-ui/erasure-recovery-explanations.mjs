// Read-only display helpers. None of these determine whether recovery is authorised.
const diagnosticLabels = [
  ["lifecycle", "Pre-deletion lifecycle and deletion-start evidence"],
  ["originalConfirmation", "Original confirmation integrity"],
  ["audit", "Cross-profile audit, if present"],
  ["freshPreview", "Fresh inspection fingerprint integrity"],
  ["originalProviderSnapshot", "Original provider snapshot comparison"],
  ["operationFingerprint", "Original operation preview comparison"],
  ["snapshotBlockers", "Provider / state snapshot safety blockers"],
  ["todoistTask", "Todoist task identity and content"],
  ["calendarEvent", "Calendar event identity and content"],
  ["comments", "Todoist mapping comments"],
  ["projectCommentIds", "Project comment identities"],
  ["calendarAliases", "Known Calendar aliases"],
  ["stateInventory", "DynamoDB state inventory"],
  ["fence", "Active operation fence"],
  ["epoch", "Profile epoch"],
  ["mappingInventory", "Original SQS mapping inventory"],
  ["mappingStates", "Current SQS mapping states"],
  ["workerLeases", "Active admission / writer leases"],
];

export function recoveryDiagnosticRows(preview) {
  return diagnosticLabels.map(([key, label]) => ({
    key, label,
    // An expected deletion is a lifecycle transition, not generic drift.
    status: preview?.comparisonDetails?.[key]?.result ||
      (["verified", "missing", "mismatched"].includes(preview?.diagnostics?.[key])
        ? preview.diagnostics[key] : "unavailable"),
  }));
}

export const recoveryComparisonRows = preview =>
  diagnosticLabels.filter(([key]) => preview?.comparisonDetails?.[key])
    .map(([key,label]) => ({key,label,...preview.comparisonDetails[key]}));

export function recoveryTombstoneStatus(preview) {
  const evidence=preview?.projectTombstone;
  if (!evidence) return {status:"not_checked",recordedCommentFound:null,
    markerMatchesTaskAndCalendar:null,
    explanation:"The exact recorded project comment has not been inspected."};
  return evidence;
}

export function recoveryIndependentGuard(preview) {
  if (!preview) return "No inspection yet; read the current state before taking any action.";
  const d=preview.diagnostics||{};
  if (d.fence && d.fence!=="verified")
    return "The exact operation-owned fence is not verified. Recovery and mapping restoration remain blocked.";
  if (d.epoch && d.epoch!=="verified")
    return "The monotonic profile epoch is missing or altered. Recovery remains blocked.";
  if ((d.mappingInventory&&d.mappingInventory!=="verified")||
      (d.mappingStates&&d.mappingStates!=="verified"))
    return "Original worker SQS mapping inventory/state is not verified. Recovery remains blocked.";
  if (d.workerLeases&&d.workerLeases!=="verified")
    return "An active writer/admission lease blocks recovery.";
  if (d.originalConfirmation&&d.originalConfirmation!=="verified")
    return "The immutable original erasure confirmation is not verified.";
  if (d.audit&&d.audit!=="verified")
    return "The independent provider/state audit is incomplete.";
  if (preview.snapshotSafetyBlockerCount>0)
    return "Provider or DynamoDB snapshot safety blockers remain. The original contents must be verified privately.";
  if (preview.classification!=="pre_write"&& !preview.allowed)
    return "Strict recovery is blocked by the original pre-write equality and deletion-stage guards; a diagnostic lifecycle change is not permission to unfence.";
  if (!preview.allowed)
    return "At least one server-side recovery guard remains blocked; inspect the recorded blockers.";
  return "Local pre-write checks are eligible, but separate writer-boundary, deployment and rollback acceptance under #347/#349 is not proven by this inspection.";
}

export function recoveryNextSafeAction(preview) {
  if (!preview) return "Load the operation and run a read-only guarded inspection.";
  const marker=recoveryTombstoneStatus(preview);
  if (marker.status==="ambiguous"||marker.status==="missing")
    return "Keep the fence. Re-read the exact recorded Todoist project comment and escalate changed or missing marker evidence; do not invent a replacement or force a recovery.";
  if (marker.status==="not_checked" && preview.classification!=="pre_write")
    return "Keep the fence. Obtain a complete exact project-comment readback before assessing post-deletion recovery.";
  if (preview.calendarDriftReview?.candidateForSeparateApproval)
    return "Review the isolated Calendar revision and use only the separately guarded Calendar-drift cancellation, with fresh server verification.";
  if (!preview.allowed)
    return "Repeat the read-only provider/state inspection or escalate an independent guarded review. Do not release the fence, replay deletion or enable production gates.";
  return "Before any guarded recovery, complete independent #347 writer-boundary and #349 deployment/rollback acceptance; this inspection cannot establish those approvals.";
}

export function recoveryClassificationExplanation(preview) {
  if (!preview) return "Not yet inspected.";
  if (preview.allowed && preview.classification === "pre_write") {
    return "Verified pre-write candidate. No provider deletion is being resumed; confirmation is still required.";
  }
  if (preview.classification === "partial_or_ambiguous") {
    return "Unable to prove the original pre-deletion inventory is unchanged; this does not prove deletion occurred. The classification is a fail-closed safety result, not a deletion report.";
  }
  if (preview.classification === "fully_deleted") {
    return "Provider/state inventory appears absent, but this does not authorise sync restoration. Separate durable replay and tombstone safeguards apply.";
  }
  return "Recovery is blocked by one or more independent safety guards; the profile remains protected.";
}

export function workerMappingSummary(preview) {
  if (!preview || !Array.isArray(preview.mappingStates)) return "unknown (not inspected)";
  if (preview.diagnostics && (preview.diagnostics.mappingInventory !== "verified"
    || preview.diagnostics.mappingStates !== "verified")) return "unknown (mapping evidence drifted)";
  const states = preview.mappingStates.map(item => item.state);
  if (!states.length) return "unknown (no recorded mapping states)";
  if (states.every(state => state === "Disabled")) return "disabled";
  if (states.every(state => state === "Enabled")) return "enabled (recovery remains guarded)";
  return "mixed or transitional (review mapping evidence)";
}

export function recoveryExecutionSummary(status, hasOperation) {
  if (typeof status === "string" && status.length) {
    return status.replaceAll("_", " ");
  }
  return hasOperation ? "not started (per operation record)" : "unknown";
}

export const originalInventoryExplanation =
  "Some items or state still exist. This is normal before deletion. Absence is relevant to proving fully deleted, not a standalone pre-write blocker.";
