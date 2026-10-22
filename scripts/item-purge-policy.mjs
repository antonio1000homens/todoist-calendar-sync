import { createHash } from "node:crypto";

/**
 * The operator purge inventory deliberately errs on the side of refusing a
 * deletion. Only exact provider identities or explicit cross-record links
 * count. Titles, dates and fuzzy string matches never establish ownership.
 */
export const PURGE_FAMILIES = new Set([
  "EVENT", "TASK", "TASKOWNER", "BASELINE", "RECURRENCE", "CANONICAL",
  "CONFLICT_STATE", "REVIEW_CASE", "MANUAL", "REPAIR", "REPAIR_PREVIEW",
  "DELIVERY", "AUDIT", "PROJECTION", "COMPLETED_EVENT", "COMPLETED_TASK",
  "FUTURE_SPLIT", "CONSOLIDATED_TASK", "REJECTED_PAIR", "SYNC_CONTROL",
  "VERSION",
]);
const SHARED_FAMILIES = new Set(["RECONCILE", "RECONCILE_RUN", "RECONCILE_OUTCOME", "SYNC", "WATCH", "WATCH_CHANNEL", "CIRCUIT"]);
const hash = value => createHash("sha256").update(value).digest("hex");
export const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
export const fingerprint = value => hash(JSON.stringify(stable(value)));
const keyOf = row => JSON.stringify([row.pk, row.sk]);
const kindOf = row => String(row.pk || "").split("#")[0];
const tokens = value => String(value || "").split(/[#:/]/);

function visit(value, callback, path = "", depth = 0) {
  if (depth > 24) throw new Error("Deeply nested state record needs manual inspection");
  if (typeof value === "string") callback(value, path);
  else if (Array.isArray(value)) value.forEach((part, index) => visit(part, callback, path + "[" + index + "]", depth + 1));
  else if (value && typeof value === "object")
    for (const [key, part] of Object.entries(value)) visit(part, callback, path ? path + "." + key : key, depth + 1);
}
function providerRefs(row) {
  const tasks = new Set(), events = new Set(), series = new Set();
  function recurse(node, path = "", side) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((child, i) => recurse(child, path + "[" + i + "]", side)); return; }
    const activeSide = node.side === "todoist" || node.side === "calendar" ? node.side : side;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && value) {
        if (/^(taskId|providerTaskId|linkedTaskId|discardedTaskId)$/.test(key)) tasks.add(value);
        if (/^(eventId|providerEventId|masterEventId|activeInstanceId|calendarProjectionId|oldMasterId|newMasterId)$/.test(key)) events.add(value);
        if (key === "seriesId") series.add(value);
        if (key === "id" && path.endsWith(".ref") && activeSide === "todoist") tasks.add(value);
        if (key === "id" && path.endsWith(".ref") && activeSide === "calendar") events.add(value);
      } else if (Array.isArray(value) && /^(candidateTaskIds|candidateEventIds)$/.test(key)) {
        for (const item of value) if (typeof item === "string") (key === "candidateTaskIds" ? tasks : events).add(item);
      }
      if (value && typeof value === "object") recurse(value, path ? path + "." + key : key, activeSide);
    }
  }
  recurse(row);
  return { tasks, events, series };
}
export function planPurge(rows, target) {
  const { profile, taskId, eventId } = target;
  if (!["home", "antonio", "work"].includes(profile) || !/^[A-Za-z0-9_.-]{1,256}$/.test(taskId)
      || (eventId && !/^[A-Za-z0-9_.-]{1,1024}$/.test(eventId))) {
    throw new Error("Explicit valid profile and provider IDs are required");
  }
  const conflictHashes = new Set([
    hash("taskId:" + taskId),
    ...(eventId ? [hash("eventId:" + eventId)] : []),
  ]);
  const presentKeys = new Set(), included = new Map(), blockers = new Set();
  const matchedReason = row => {
    const reasons = [];
    const pk = String(row.pk || "");
    const segments = tokens(pk);
    if (segments.includes(taskId)) reasons.push("task ID in partition key");
    if (eventId && segments.includes(eventId)) reasons.push("event ID in partition key");
    if (pk.startsWith("CONFLICT_STATE#" + profile + "#") && conflictHashes.has(pk.split("#").at(-1))) reasons.push("conflict identity hash");
    visit(row, (value, path) => {
      if (path === "pk" || path === "sk") return;
      if (value === taskId) reasons.push("task ID at " + path);
      if (eventId && value === eventId) reasons.push("event ID at " + path);
      if (/(^|\.)(sourceAuditKey|decisionId|caseId|previewId|operationId)$/.test(path) && presentKeys.has(value)) reasons.push("linked record at " + path);
    });
    return [...new Set(reasons)];
  };
  for (const row of rows) {
    if (!row || typeof row.pk !== "string" || typeof row.sk !== "string") throw new Error("Malformed DynamoDB primary key: manual handling required");
    const key = keyOf(row);
    if (presentKeys.has(key)) throw new Error("Duplicate DynamoDB key in scan: manual handling required");
    presentKeys.add(key);
  }
  // Record links can point in either direction and can be nested in a preview.
  for (let round = 0; round < 6; round++) {
    let changed = false;
    const ownedKeys = new Set([...included.values()].map(value => value.row.pk));
    for (const row of rows) {
      const key = keyOf(row);
      if (included.has(key)) continue;
      const reasons = matchedReason(row);
      visit(row, (value, path) => {
        if (path !== "pk" && ownedKeys.has(value)) reasons.push("references inventoried " + path);
      });
      if (reasons.length) {
        included.set(key, { row, reasons: [...new Set(reasons)] });
        changed = true;
      }
    }
    if (!changed) break;
  }
  const records = [...included.values()].map(({ row, reasons }) => {
    const family = kindOf(row);
    const refs = providerRefs(row);
    const hazards = [];
    if (!PURGE_FAMILIES.has(family)) hazards.push("unrecognised/shared state family");
    if (SHARED_FAMILIES.has(family)) hazards.push("profile-wide state must be repaired manually");
    if (row.profile && row.profile !== profile) hazards.push("belongs to a different profile");
    if ([...refs.tasks].some(id => id !== taskId)) hazards.push("references another Todoist task");
    if ([...refs.events].some(id => id !== eventId)) hazards.push("references another Calendar item");
    if (refs.series.size || row.recurrenceOwner || row.owner === "calendar" || row.owner === "todoist")
      hazards.push("recurrence/series ownership needs manual handling");
    if (family === "TASKOWNER" && row.taskId !== taskId) hazards.push("task owner mismatch");
    if (family === "EVENT" && (!eventId || row.eventId !== eventId)) hazards.push("mapping to a different event");
    if (family === "TASK" && row.taskId !== taskId) hazards.push("mapping to a different task");
    if (family === "DELIVERY" && !reasons.some(reason => /task ID|event ID/.test(reason)))
      hazards.push("delivery receipt attribution is indirect");
    hazards.forEach(hazard => blockers.add(row.pk + " / " + row.sk + ": " + hazard));
    return { pk: row.pk, sk: row.sk, type: family, reasons, hazards, digest: fingerprint(row) };
  }).sort((a,b) => a.pk.localeCompare(b.pk) || a.sk.localeCompare(b.sk));
  return { records, blockers: [...blockers].sort(), inventoryDigest: fingerprint(records.map(({pk,sk,digest})=>[pk,sk,digest])) };
}
