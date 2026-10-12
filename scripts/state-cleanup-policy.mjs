import { createHash } from "node:crypto";
import { AUDIT_RETENTION_DAYS } from "../dist/audit-policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_RETENTIONS = [30, 90];
const PROFILES = new Set(["home", "antonio", "work"]);
const MAPPING_PREFIXES = ["EVENT", "TASK", "TASKOWNER"];

export function fingerprint(...values) {
  return createHash("sha256").update(values.join("\u0000")).digest("hex").slice(0, 12);
}

/**
 * Only old AUDIT records created with the previous 30/90-day TTL qualify.
 * Significant/unknown actions may appear here, so an explicit backed-up
 * production decision is still required before applying deletion.
 */
export function classifyLegacyAudit(item, nowMs = Date.now()) {
  if (!item || item.sk !== "STATE" || typeof item.pk !== "string") return null;
  const parts = item.pk.split("#");
  if (parts[0] !== "AUDIT" || !PROFILES.has(parts[1]) || parts.length < 4) return null;
  if (typeof item.action !== "string" || !item.action) return null;
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) return null;
  if (!Number.isSafeInteger(item.expiresAt)) return null;
  const createdMs = Date.parse(item.createdAt);
  if (createdMs > nowMs - AUDIT_RETENTION_DAYS * DAY_MS) return null;
  // Already past its original TTL? Leave it to DynamoDB's automatic deletion.
  if (item.expiresAt * 1000 <= nowMs) return null;
  const actualDays = (item.expiresAt * 1000 - createdMs) / DAY_MS;
  const originalRetentionDays = LEGACY_RETENTIONS.find((days) => Math.abs(days - actualDays) < 0.1);
  if (!originalRetentionDays) return null;
  return { action: item.action, originalRetentionDays };
}

function mappingType(item) {
  if (!item || item.sk !== "MAP" || typeof item.pk !== "string") return null;
  const kind = item.pk.split("#", 1)[0];
  return MAPPING_PREFIXES.includes(kind) ? kind : null;
}

export function expectedMappingKey(kind, profile, eventId, taskId) {
  if (kind === "EVENT") return { pk: "EVENT#" + profile + "#" + eventId, sk: "MAP" };
  if (kind === "TASK") return { pk: "TASK#" + profile + "#" + taskId, sk: "MAP" };
  if (kind === "TASKOWNER") return { pk: "TASKOWNER#" + taskId, sk: "MAP" };
  throw new Error("Unknown mapping kind");
}

/** Report-only. Missing/overwritten indices must never be deleted on scan evidence alone. */
export function inspectMappingIntegrity(rows) {
  const groups = new Map();
  let malformedRows = 0;
  for (const item of rows) {
    const kind = mappingType(item);
    if (!kind) continue;
    const { profile, eventId, taskId } = item;
    if (!PROFILES.has(profile) || typeof eventId !== "string" || !eventId
        || typeof taskId !== "string" || !taskId) {
      malformedRows += 1;
      continue;
    }
    const expected = expectedMappingKey(kind, profile, eventId, taskId);
    if (item.pk !== expected.pk) {
      malformedRows += 1;
      continue;
    }
    const id = JSON.stringify([profile, eventId, taskId]);
    if (!groups.has(id)) groups.set(id, { profile, eventId, taskId, kinds: new Set() });
    groups.get(id).kinds.add(kind);
  }
  const anomalies = [];
  let complete = 0;
  for (const group of groups.values()) {
    if (group.kinds.size === MAPPING_PREFIXES.length) {
      complete += 1;
      continue;
    }
    anomalies.push({
      profile: group.profile, eventId: group.eventId, taskId: group.taskId,
      fingerprint: fingerprint(group.profile, group.eventId, group.taskId),
      present: MAPPING_PREFIXES.filter((kind) => group.kinds.has(kind)),
      missing: MAPPING_PREFIXES.filter((kind) => !group.kinds.has(kind)),
    });
  }
  return { uniqueMappings: groups.size, complete, malformedRows, anomalies };
}

export function summarizeUnmappedConflicts(rows) {
  const counts = new Map();
  for (const item of rows) {
    if (item.action !== "todoist_snapshot_reconcile_unmapped_conflict") continue;
    const taskId = item.detail?.taskId;
    const eventId = item.detail?.eventId;
    const id = fingerprint(String(taskId ?? "unknown"), String(eventId ?? "unknown"));
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])
    .map(([fingerprint, count]) => ({ fingerprint, count }));
}
