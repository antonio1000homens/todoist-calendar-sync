/**
 * #367: Conservative read-only repair lifecycle assessment.
 *
 * This code does not decide deletion eligibility. A completed scan can prove
 * that a record has *known* dependants, but it cannot prove absence of queued
 * deliveries, stale idempotency submissions, or external operator references.
 */
import { operationHasWriteEvidence } from "../dist/review-types.js";

const REPAIR_KEY = /^REPAIR#([^#]+)$/;
const CASE_KEY = /^REVIEW_CASE#([^#]+)$/;
const PREVIEW_KEY = /^REPAIR_PREVIEW#([^#]+)$/;

const newCounts = () => Object.create(null);
const increment = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

export function parseRepairRetentionArgs(args) {
  const options = { maxPages: 60, profile: undefined };
  for (const arg of args) {
    if (arg.startsWith("--profile=")) options.profile = arg.slice("--profile=".length);
    else if (arg.startsWith("--max-pages=")) options.maxPages = Number(arg.slice("--max-pages=".length));
    else throw new Error("Unknown option: only --profile and --max-pages are accepted (no --apply)");
  }
  if (!["home", "antonio", "work", "all"].includes(options.profile))
    throw new Error("Explicit --profile must be home, antonio, work or all");
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 100)
    throw new Error("--max-pages must be 1..100");
  return options;
}

function ageBand(timestamp, nowMs) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "unknown";
  const age = Math.max(0, nowMs - Date.parse(timestamp));
  if (age < 7 * 86400000) return "under_7_days";
  if (age < 30 * 86400000) return "7_to_30_days";
  if (age < 90 * 86400000) return "30_to_90_days";
  return "90_days_or_more";
}

function operationReference(row) {
  // Deliberately typed fields only. Never match title/body/description text.
  const ref = row?.operationId || row?.activeRepair || row?.submittedOperation
    || row?.repair?.operationId;
  return typeof ref === "string" ? ref : undefined;
}

function family(row) {
  return String(row?.pk || "").split("#")[0];
}

export function assessRepairRetention(rows, {profile="all", nowMs=Date.now()}={}) {
  if (!["home", "antonio", "work", "all"].includes(profile)) throw new Error("Unknown profile");
  const cases = new Map(), previews = new Map(), operations = [];
  const references = new Map();
  const totals = { recordsScanned: rows.length, byStatus: newCounts(), byAge: newCounts(),
    byReason: newCounts(), byProfile: newCounts(), byLinkedCaseStatus: newCounts(),
    operationCount: 0, noTtl: 0, withinTtl: 0, expiredTtl: 0,
    pendingNotification: 0, recordedWriteEvidence: 0, activeRepairControlReferences: 0,
    currentCaseOwner: 0, missingCase: 0, originalPreviewPresent: 0, originalPreviewExpiredOrMissing: 0,
    ambiguousOrMalformed: 0, noKnownDbBacklink: 0, unsupportedForDelete: 0,
    qualifiedForAutomaticDelete: 0, mode: "read_only", cleanupPolicy: "retain_submitted_operations",
  };
  for (const row of rows) {
    if (!row || typeof row.pk !== "string") continue;
    if (row.sk !== "STATE" && (family(row) === "REPAIR" || family(row) === "REVIEW_CASE"
      || family(row) === "REPAIR_PREVIEW")) continue;
    const caseMatch = row.pk.match(CASE_KEY);
    const previewMatch = row.pk.match(PREVIEW_KEY);
    const repairMatch = row.pk.match(REPAIR_KEY);
    if (caseMatch) cases.set(caseMatch[1], row);
    if (previewMatch) previews.set(previewMatch[1], row);
    if (repairMatch) operations.push(row);
    const referenced = operationReference(row);
    if (referenced && !repairMatch) {
      const linked = references.get(referenced) || [];
      linked.push({kind:family(row), field:row.activeRepair === referenced ? "activeRepair"
        : row.submittedOperation === referenced ? "submittedOperation" : "operationId"});
      references.set(referenced, linked);
    }
  }
  for (const op of operations) {
    const operationId = op.pk.slice("REPAIR#".length);
    const intent = op.preview?.intent;
    const currentProfile = intent?.profile;
    if (profile !== "all" && currentProfile !== profile) continue;
    totals.operationCount++;
    increment(totals.byProfile, currentProfile || "unknown");
    increment(totals.byStatus, typeof op.status === "string" ? op.status : "missing");
    increment(totals.byAge, ageBand(op.updatedAt, nowMs));
    const validTtl = Number.isFinite(op.expiresAt) && op.expiresAt > 0;
    if (!validTtl) totals.noTtl++;
    else if (op.expiresAt * 1000 <= nowMs) totals.expiredTtl++;
    else totals.withinTtl++;
    const reasons = new Set();
    if (!["succeeded", "failed"].includes(op.status)) reasons.add("active_or_nonterminal");
    if (op.status === "failed" && op.abandoned !== true) reasons.add("failed_may_resume");
    if (op.notificationPending === true) {
      totals.pendingNotification++;
      reasons.add("pending_notification");
    }
    let evidence = false;
    try { evidence = operationHasWriteEvidence(op); }
    catch { reasons.add("malformed_operation_evidence"); }
    if (evidence) { totals.recordedWriteEvidence++; reasons.add("recorded_write_evidence"); }
    if (typeof op.id !== "string" || op.id !== operationId
      || !["home","antonio","work"].includes(currentProfile)
      || typeof intent?.caseId !== "string") reasons.add("malformed_operation_identity");
    const caseRecord = cases.get(intent?.caseId);
    if (!caseRecord) { totals.missingCase++; reasons.add("case_missing"); }
    increment(totals.byLinkedCaseStatus, caseRecord?.status || "missing");
    if (caseRecord?.operationId === operationId) {
      totals.currentCaseOwner++;
      reasons.add("current_case_reference");
    }
    const previewRecord = previews.get(op.preview?.id);
    if (previewRecord) {
      totals.originalPreviewPresent++;
      if (previewRecord.submittedOperation !== operationId) reasons.add("preview_submission_mismatch");
      else reasons.add("submitted_preview_reference");
    } else {
      totals.originalPreviewExpiredOrMissing++;
      // Preview TTL expiration is expected; operation embeds the original preview.
    }
    const refs = references.get(operationId) || [];
    if (!refs.length) totals.noKnownDbBacklink++;
    for (const ref of refs) if (ref.kind === "SYNC_CONTROL" && ref.field === "activeRepair") {
      totals.activeRepairControlReferences++;
      reasons.add("active_repair_control_reference");
    }
    for (const ref of refs) {
      if (ref.kind === "SYNC_CONTROL" && ref.field === "activeRepair") continue;
      if (ref.kind === "REVIEW_CASE" && caseRecord?.operationId === operationId) continue;
      if (ref.kind === "REPAIR_PREVIEW" && previewRecord?.submittedOperation === operationId) continue;
      reasons.add("other_durable_reference");
    }
    if (reasons.has("malformed_operation_identity") || reasons.has("malformed_operation_evidence"))
      totals.ambiguousOrMalformed++;
    // No operation qualifies for automatic deletion in the existing protocol:
    // GET/execute/replay/idempotency paths can still address its exact ID.
    // A versioned terminal tombstone / explicit retention migration is needed.
    reasons.add("idempotency_and_replay_retention");
    totals.unsupportedForDelete++;
    for (const reason of reasons) increment(totals.byReason, reason);
  }
  return totals;
}
