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
  "COMPLETED_SERIES", "FUTURE_SPLIT", "CONSOLIDATED_TASK", "REJECTED_PAIR", "SYNC_CONTROL",
  "VERSION",
]);
const SHARED_FAMILIES = new Set(["RECONCILE", "RECONCILE_RUN", "RECONCILE_OUTCOME", "SYNC", "WATCH", "WATCH_CHANNEL", "CIRCUIT"]);
const LINK_FIELDS = new Set(["sourceAuditKey", "decisionId", "caseId", "previewId", "operationId", "incidentId", "repairId"]);
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
export const publicInventoryRecord = record => ({
  pk: record.pk, sk: record.sk, type: record.type, classification: record.classification,
  reasons: record.reasons, hazards: record.hazards,
});

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
        if (/^(taskId|providerTaskId|linkedTaskId|discardedTaskId|retainedTaskId|ownerTaskId)$/.test(key)) tasks.add(value);
        if (/^(eventId|providerEventId|masterEventId|activeInstanceId|calendarProjectionId|oldMasterId|newMasterId|lastEventId|occurrenceId|selectedEventId|previousEventId|cancelledEventId)$/.test(key)) events.add(value);
        if (key === "seriesId") series.add(value);
        if (key === "id" && path.endsWith(".ref") && activeSide === "todoist") tasks.add(value);
        if (key === "id" && path.endsWith(".ref") && activeSide === "calendar") events.add(value);
      } else if (Array.isArray(value) && /^(candidateTaskIds|candidateEventIds|taskIds|eventIds)$/.test(key)) {
        for (const item of value) if (typeof item === "string") ((key === "candidateTaskIds" || key === "taskIds") ? tasks : events).add(item);
      }
      if (value && typeof value === "object") recurse(value, path ? path + "." + key : key, activeSide);
    }
  }
  recurse(row);
  return { tasks, events, series };
}
export function planPurge(rows, target) {
  const { profile, taskId, eventId } = target;
  const extraProtectedTaskIds = target.protectedTaskIds ?? [];
  const extraProtectedEventIds = target.protectedEventIds ?? [];
  if (!["home", "antonio", "work"].includes(profile) || !/^[A-Za-z0-9_.-]{1,256}$/.test(taskId)
      || (eventId && !/^[A-Za-z0-9_.-]{1,1024}$/.test(eventId))) {
    throw new Error("Explicit valid profile and provider IDs are required");
  }
  if (!Array.isArray(extraProtectedTaskIds) || !extraProtectedTaskIds.every(id => typeof id === "string" && /^[A-Za-z0-9_.-]{1,256}$/.test(id))
      || !Array.isArray(extraProtectedEventIds) || !extraProtectedEventIds.every(id => typeof id === "string" && /^[A-Za-z0-9_.-]{1,1024}$/.test(id)))
    throw new Error("Protected state requires exact, valid provider IDs");
  if (eventId && extraProtectedEventIds.includes(eventId))
    throw new Error("A selected Calendar event cannot also be a protected event");
  const protectedTaskIds = new Set([...(target.preserveTask ? [taskId] : []), ...extraProtectedTaskIds]);
  const protectedEventIds = new Set(extraProtectedEventIds);
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
    for (const protectedId of protectedTaskIds) if (segments.includes(protectedId)) reasons.push("protected task ID in partition key");
    for (const protectedId of protectedEventIds) if (segments.includes(protectedId)) reasons.push("protected event ID in partition key");
    if (pk.startsWith("CONFLICT_STATE#" + profile + "#") && conflictHashes.has(pk.split("#").at(-1))) reasons.push("conflict identity hash");
    visit(row, (value, path) => {
      if (path === "pk" || path === "sk") return;
      const taskPath = /(^|\.)(taskId|providerTaskId|linkedTaskId|discardedTaskId|retainedTaskId|ownerTaskId|candidateTaskIds|identityRefs\.taskIds)(\[\d+\])?$/.test(path)
        || /(^|\.)ref\.id$/.test(path) && path.includes("todoist");
      const eventPath = /(^|\.)(eventId|providerEventId|masterEventId|activeInstanceId|oldMasterId|newMasterId|calendarProjectionId|lastEventId|occurrenceId|selectedEventId|previousEventId|cancelledEventId|candidateEventIds|identityRefs\.eventIds)(\[\d+\])?$/.test(path);
      if (value === taskId && taskPath) reasons.push("task ID at " + path);
      if (eventId && value === eventId && eventPath) reasons.push("event ID at " + path);
      const identityField = /(^|[._])[^.[\]]*(?:id|identity)(?:$|\[\d+\])/i.test(path);
      if (value === taskId && !taskPath && identityField) reasons.push("selected identity at unrecognized field " + path);
      if (eventId && value === eventId && !eventPath && identityField) reasons.push("selected identity at unrecognized field " + path);
      if ([...protectedTaskIds].some(id => value === id && taskPath)) reasons.push("protected task ID at " + path);
      if ([...protectedEventIds].some(id => value === id && eventPath)) reasons.push("protected event ID at " + path);
      if (LINK_FIELDS.has(path.split(".").at(-1)) && presentKeys.has(value)) reasons.push("linked record at " + path);
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
  // Seed the graph only from exact task/event IDs or the deterministic conflict hash.
  for (const row of rows) {
    if (kindOf(row) === "DELIVERY") {
      const refs = providerRefs(row);
      const hasIdentityRefs = Array.isArray(row.identityRefs?.taskIds) || Array.isArray(row.identityRefs?.eventIds);
      if (hasIdentityRefs && !refs.tasks.has(taskId) && !(eventId && refs.events.has(eventId))) continue;
      if (!hasIdentityRefs && row.profile !== profile) continue;
      const key = keyOf(row);
      if (!included.has(key)) included.set(key, {
        row,
        reasons: hasIdentityRefs ? ["delivery receipt references selected provider identity"]
          : ["legacy delivery receipt has no provider identity and requires manual attribution"],
      });
    }
  }
  for (let round = 0; round < 32; round++) {
    let changed = false;
    const ownedIds = new Set();
    for (const {row} of included.values()) {
      ownedIds.add(row.pk);
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === "string" && LINK_FIELDS.has(field)) ownedIds.add(value);
      }
    }
    const references = new Set();
    for (const {row} of included.values()) visit(row, (value, path) => {
      if (path !== "pk" && path !== "sk" && typeof value === "string") references.add(value);
    });
    const linkedKeys = new Map();
    const linkedIncidentIds = new Set();
    for (const {row} of included.values()) visit(row, (value, path) => {
      if (typeof value !== "string") return;
      const field = path.split(".").at(-1);
      if (field === "incidentId") linkedIncidentIds.add(value);
      const targetKey = field === "sourceAuditKey" ? value
        : field === "decisionId" ? "MANUAL#" + value
          : field === "caseId" ? "REVIEW_CASE#" + value
            : field === "previewId" ? "REPAIR_PREVIEW#" + value
              : field === "operationId" || field === "repairId" ? "REPAIR#" + value
                : undefined;
      if (targetKey) linkedKeys.set(targetKey, path);
    });
    const includedSeries = new Set();
    for (const {row} of included.values()) for (const seriesId of providerRefs(row).series) includedSeries.add(seriesId);
    for (const row of rows) {
      const key = keyOf(row);
      if (included.has(key)) continue;
      const reasons = matchedReason(row);
      visit(row, (value, path) => {
        if (path !== "pk" && path !== "sk" && typeof value === "string" && ownedIds.has(value))
          reasons.push("references inventoried " + path);
      });
      if (references.has(row.pk)) reasons.push("referenced by inventoried record");
      if (linkedKeys.has(row.pk)) reasons.push("linked record at " + linkedKeys.get(row.pk));
      if (kindOf(row) === "AUDIT" && tokens(row.pk).some(segment => linkedIncidentIds.has(segment)))
        reasons.push("audit record for an inventoried incident");
      if (kindOf(row) === "COMPLETED_SERIES"
        && (includedSeries.has(row.seriesId) || includedSeries.has(tokens(row.pk).at(-1))))
        reasons.push("completed-series certificate for an inventoried series");
      if (reasons.length) {
        included.set(key, { row, reasons: [...new Set(reasons)] });
        changed = true;
      }
    }
    if (!changed) break;
    if (round === 31) throw new Error("Item provenance graph did not converge; manual handling required");
  }
  const records = [...included.values()].map(({ row, reasons }) => {
    const family = kindOf(row);
    const refs = providerRefs(row);
    const hazards = [];
    const otherTaskIds = [...refs.tasks].filter(id => id !== taskId);
    const otherEventIds = [...refs.events].filter(id => id !== eventId);
    const directTargetRef = refs.tasks.has(taskId) || (eventId && refs.events.has(eventId))
      || tokens(row.pk).includes(taskId) || (eventId && tokens(row.pk).includes(eventId))
      || (family === "CONFLICT_STATE" && reasons.some(reason => reason === "conflict identity hash"));
    let classification = "selected-only";
    if (family === "DELIVERY" && !directTargetRef) {
      classification = "unattributable";
      hazards.push("delivery receipt has no exact selected provider identity; replay safety cannot be proven");
    } else if (family === "DELIVERY") {
      classification = target.preserveTask && refs.tasks.has(taskId)
        || [...protectedTaskIds].some(id => refs.tasks.has(id))
        || [...protectedEventIds].some(id => refs.events.has(id))
        || otherTaskIds.length || otherEventIds.length
        ? "shared with protected state" : "selected-only";
      hazards.push("delivery receipt may be pending, delayed, or replayable; exact identity does not prove quiescence");
    } else if (target.preserveTask && (refs.tasks.has(taskId) || tokens(row.pk).includes(taskId))) {
      classification = "shared with protected state";
      hazards.push("selected Todoist task is explicitly retained");
    } else if ([...protectedTaskIds].some(id => refs.tasks.has(id) || tokens(row.pk).includes(id))
      || [...protectedEventIds].some(id => refs.events.has(id) || tokens(row.pk).includes(id))) {
      classification = "shared with protected state";
      hazards.push("record references an explicitly protected provider item");
    } else if (otherTaskIds.length || otherEventIds.length) {
      classification = "shared with protected state";
      hazards.push("record also references another task or event that must be preserved");
    } else if (refs.series.size || row.recurrenceOwner || row.owner === "calendar" || row.owner === "todoist") {
      classification = "shared with protected state";
      hazards.push("record is linked to a recurring series or owner that may include protected occurrences");
    } else if (!directTargetRef && !reasons.some(reason => /linked record|references inventoried|referenced by inventoried|linked operation/.test(reason))) {
      classification = "ambiguous";
      hazards.push("record has no exact identity path to the selected item");
    }
    if (!PURGE_FAMILIES.has(family) || SHARED_FAMILIES.has(family)) {
      classification = "ambiguous";
      hazards.push("unrecognised or profile-wide state family needs manual handling");
    }
    if (row.profile && row.profile !== profile) hazards.push("belongs to a different profile");
    const scoped = new Set(["EVENT","TASK","BASELINE","RECURRENCE","CANONICAL","CONFLICT_STATE","COMPLETED_SERIES",
      "PROJECTION","COMPLETED_EVENT","COMPLETED_TASK","CONSOLIDATED_TASK","REJECTED_PAIR","AUDIT"]);
    if (scoped.has(family) && !row.pk.startsWith(family + "#" + profile + "#"))
      hazards.push("key belongs to a different profile");
    if (family === "REJECTED_PAIR") {
      const [, , rejectedTask, rejectedEvent] = row.pk.split("#");
      if (rejectedTask !== taskId || rejectedEvent !== eventId) {
        hazards.push("rejected pair is shared with another task/event");
        classification = "shared with protected state";
      }
    }
    if (family === "SYNC_CONTROL" && !row.pk.startsWith("SYNC_CONTROL#" + profile + ":")) {
      hazards.push("sync control belongs to a different profile");
      classification = "ambiguous";
    }
    if (family === "CANONICAL" && row.providerId && row.providerId !== taskId && row.providerId !== eventId) {
      hazards.push("canonical alias points to another provider identity");
      classification = "shared with protected state";
    }
    if (otherTaskIds.length) hazards.push("references another Todoist task");
    if (otherEventIds.length) hazards.push("references another Calendar item");
    if (family === "TASKOWNER" && row.taskId !== taskId) { hazards.push("task owner mismatch"); classification = "ambiguous"; }
    if (family === "EVENT" && (!eventId || row.eventId !== eventId)) { hazards.push("mapping to a different event"); classification = "shared with protected state"; }
    if (family === "TASK" && row.taskId !== taskId) { hazards.push("mapping to a different task"); classification = "shared with protected state"; }
    if (refs.series.size || row.recurrenceOwner || row.owner === "calendar" || row.owner === "todoist")
      hazards.push("recurrence/series ownership needs manual handling");
    if ((row.profile && row.profile !== profile)
      || (scoped.has(family) && !row.pk.startsWith(family + "#" + profile + "#")))
      classification = "ambiguous";
    hazards.forEach(hazard => blockers.add(row.pk + " / " + row.sk + ": " + hazard));
    return { pk: row.pk, sk: row.sk, type: family, classification, reasons, hazards: [...new Set(hazards)], digest: fingerprint(row) };
  }).sort((a,b) => a.pk.localeCompare(b.pk) || a.sk.localeCompare(b.sk));
  const counts = Object.fromEntries(["selected-only", "shared with protected state", "ambiguous", "unattributable"]
    .map(classification => [classification, records.filter(record => record.classification === classification).length]));
  return { records, counts, blockers: [...blockers].sort(), inventoryDigest: fingerprint(records.map(({pk,sk,digest,classification})=>[pk,sk,digest,classification])) };
}
