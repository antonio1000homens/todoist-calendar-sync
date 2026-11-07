/**
 * Read-only and deliberately conservative state classification for #367.
 * Exact provider IDs are discovery hints, never deletion authorisation.
 * This module does not import provider clients or DynamoDB mutation APIs.
 */
import { createHash } from "node:crypto";

export const RESIDUE_CLASSES = [
  "already_retired",
  "awaiting_defined_TTL",
  "eligible_and_exclusively_attributable",
  "shared_or_active",
  "unknown_or_incomplete",
  "expired_but_still_present",
];

const TASK_FIELDS = new Set([
  "taskId", "providerTaskId", "masterTaskId", "ownerTaskId", "linkedTaskId",
  "discardedTaskId", "retainedTaskId", "sourceTaskId", "destinationTaskId",
]);
const EVENT_FIELDS = new Set([
  "eventId", "providerEventId", "masterEventId", "activeInstanceId",
  "recurringMasterId", "recurringEventId", "occurrenceId", "calendarProjectionId",
  "oldMasterId", "newMasterId", "sourceEventId", "destinationEventId",
]);
const TASK_ARRAY_FIELDS = new Set(["taskIds", "candidateTaskIds"]);
const EVENT_ARRAY_FIELDS = new Set(["eventIds", "candidateEventIds"]);
const TRACKED_FAMILIES = new Set([
  "REVIEW_CASE", "AUDIT", "AUDIT_REF", "CONFLICT_STATE", "REVIEW_CONFLICT",
  "DELETION_REVIEW", "REPAIR_PREVIEW", "REPAIR", "MANUAL", "SYNC_CONTROL",
  "BASELINE", "CANONICAL", "EVENT", "TASK", "TASKOWNER", "RECURRENCE",
  "COMPLETED_TASK", "COMPLETED_EVENT", "COMPLETED_SERIES", "RECONCILE_DIAGNOSTIC",
]);
export const NONDESTRUCTIVE_FAMILIES = new Set(["COMPLETED_TASK", "COMPLETED_EVENT", "COMPLETED_SERIES"]);
const VALID_ID = /^[A-Za-z0-9_.@-]{1,256}$/;

export function validateResidueScope(scope) {
  if (!["home", "antonio", "work"].includes(scope.profile)) throw new Error("Explicit valid --profile is required");
  for (const [field, max] of [["caseIds", 5], ["taskIds", 16], ["eventIds", 32]]) {
    if (!Array.isArray(scope[field]) || scope[field].length > max
      || scope[field].some(id => typeof id !== "string" || !VALID_ID.test(id)))
      throw new Error("Invalid " + field);
  }
  if (!scope.caseIds.length || !scope.taskIds.length && !scope.eventIds.length)
    throw new Error("At least one exact case ID and provider ID are required");
  if (new Set(scope.caseIds).size !== scope.caseIds.length
    || new Set(scope.taskIds).size !== scope.taskIds.length
    || new Set(scope.eventIds).size !== scope.eventIds.length) throw new Error("Duplicate scope ID");
  return scope;
}

export function scopeDigest(scope, table) {
  return createHash("sha256").update(JSON.stringify({
    table, profile: scope.profile, caseIds: [...scope.caseIds].sort(),
    taskIds: [...scope.taskIds].sort(), eventIds: [...scope.eventIds].sort(),
  })).digest("hex");
}

export function familyOf(row) {
  const pk = typeof row?.pk === "string" ? row.pk : "";
  const family = pk.split("#")[0];
  return TRACKED_FAMILIES.has(family) ? family : null;
}

export function collectExactReferences(value) {
  const refs = { todoist: new Set(), calendar: new Set(), cases: new Set() };
  const seen = new WeakSet();
  function walk(item, field = "", depth = 0) {
    if (!item || typeof item !== "object" || depth > 20 || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      if (TASK_ARRAY_FIELDS.has(field)) for (const id of item) if (typeof id === "string") refs.todoist.add(id);
      if (EVENT_ARRAY_FIELDS.has(field)) for (const id of item) if (typeof id === "string") refs.calendar.add(id);
      for (const v of item) walk(v, field, depth + 1);
      return;
    }
    if (item.ref && typeof item.ref === "object"
      && ["todoist", "calendar"].includes(item.ref.side) && typeof item.ref.id === "string")
      refs[item.ref.side].add(item.ref.id);
    for (const [key, val] of Object.entries(item)) {
      if (typeof val === "string") {
        if (TASK_FIELDS.has(key)) refs.todoist.add(val);
        if (EVENT_FIELDS.has(key)) refs.calendar.add(val);
        if (key === "caseId" || key === "coalescedInto") refs.cases.add(val);
      } else if (val && typeof val === "object") walk(val, key, depth + 1);
    }
  }
  walk(value);
  return refs;
}

function hasExactKeyReference(row, scope) {
  const pk = String(row.pk || "");
  const family = familyOf(row);
  if (family === "REVIEW_CASE") return scope.caseIds.some(id => pk === "REVIEW_CASE#" + id);
  if (family === "DELETION_REVIEW" || family === "AUDIT_REF") {
    return [...scope.taskIds.map(id => "todoist#" + id), ...scope.eventIds.map(id => "calendar#" + id)]
      .some(ref => pk === family + "#" + scope.profile + "#" + ref);
  }
  if (family === "CONFLICT_STATE") {
    const values = [
      ...scope.taskIds.map(id => "taskId:" + id),
      ...scope.eventIds.flatMap(id => ["eventId:" + id, "seriesId:" + id]),
    ];
    return values.some(value => pk === "CONFLICT_STATE#" + scope.profile + "#"
      + createHash("sha256").update(value).digest("hex"));
  }
  return false;
}

export function assessResidueRow(row, scope, indexedAuditKeys = new Set(), nowSeconds = Date.now() / 1000) {
  const family = familyOf(row);
  if (!family) return null;
  const refs = collectExactReferences(row);
  const exactCase = hasExactKeyReference(row, scope)
    || [...refs.cases].some(id => scope.caseIds.includes(id))
    || family === "REVIEW_CONFLICT" && typeof row.incidentId === "string"
      && scope.caseIds.includes(row.incidentId);
  const providerMatch = [...refs.todoist].some(id => scope.taskIds.includes(id))
    || [...refs.calendar].some(id => scope.eventIds.includes(id))
    || hasExactKeyReference(row, scope);
  if (!exactCase && !providerMatch) return null;

  const shared = [...refs.todoist].some(id => !scope.taskIds.includes(id))
    || [...refs.calendar].some(id => !scope.eventIds.includes(id));
  const ttl = typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt)
    && row.expiresAt > 0 ? row.expiresAt : null;
  const expired = ttl !== null && ttl <= nowSeconds;
  const directReceipt = family === "REVIEW_CASE" && hasExactKeyReference(row, scope)
    && row.status === "resolved" && typeof row.result === "string"
    && row.result.startsWith("resolved_deleted");
  const active = family === "REPAIR"
    && (["queued", "running", "needs_review"].includes(row.status)
      || row.notificationPending === true || row.writeStarted === true
      || row.nonResumable === false && row.status === "failed")
    || family === "REPAIR_PREVIEW" && Boolean(row.submittedOperation)
    || family === "REVIEW_CASE" && ["open", "dismissed", "repairing"].includes(row.status)
    || family === "CONFLICT_STATE" && row.active === true
    || family === "MANUAL" && (row.status === "pending" || row.status === "open")
    || NONDESTRUCTIVE_FAMILIES.has(family);

  let classification;
  if (directReceipt) classification = "already_retired";
  else if (shared || active) classification = "shared_or_active";
  else if (expired) classification = "expired_but_still_present";
  else if (ttl !== null) classification = "awaiting_defined_TTL";
  else classification = "unknown_or_incomplete";

  const matchingUnindexedAudit = family === "AUDIT" && providerMatch
    && !indexedAuditKeys.has(row.pk);
  // NEVER classify an item as eligible for deletion based on DynamoDB alone.
  // Provider absence, mapping ownership, series inventory and write fences are not established here.
  return {
    family, classification, matchingUnindexedAudit,
    terminalRepairNoTtl: family === "REPAIR" && ttl === null
      && ["succeeded", "failed"].includes(row.status),
    expiredUnsubmittedPreview: family === "REPAIR_PREVIEW"
      && !row.submittedOperation && expired,
    crossReferenced: shared,
  };
}

export function emptyResidueReport() {
  return {
    matchedRows: 0, byClass: Object.fromEntries(RESIDUE_CLASSES.map(c => [c, 0])),
    byFamily: {}, matchingAuditsWithoutExactReversePointer: 0,
    terminalRepairsWithoutTtl: 0, expiredUnsubmittedPreviews: 0,
    crossReferencedRows: 0, seenTrackedFamilies: {},
  };
}

export function countResidueRow(report, row, assessment) {
  const family = familyOf(row);
  if (family) report.seenTrackedFamilies[family] = (report.seenTrackedFamilies[family] || 0) + 1;
  if (!assessment) return;
  report.matchedRows += 1;
  report.byClass[assessment.classification] += 1;
  report.byFamily[assessment.family] ||= Object.fromEntries(RESIDUE_CLASSES.map(c => [c, 0]));
  report.byFamily[assessment.family][assessment.classification] += 1;
  if (assessment.matchingUnindexedAudit) report.matchingAuditsWithoutExactReversePointer += 1;
  if (assessment.terminalRepairNoTtl) report.terminalRepairsWithoutTtl += 1;
  if (assessment.expiredUnsubmittedPreview) report.expiredUnsubmittedPreviews += 1;
  if (assessment.crossReferenced) report.crossReferencedRows += 1;
}
