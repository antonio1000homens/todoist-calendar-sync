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
    status: ["verified", "missing", "mismatched"].includes(preview?.diagnostics?.[key])
      ? preview.diagnostics[key] : "unavailable",
  }));
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
