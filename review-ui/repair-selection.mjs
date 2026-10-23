// Keep repair identifiers bound to the case and verified live provider snapshots.
// A previous case's (or an unresolved) selection must never be previewable.
export function emptyRepairSelection(item) {
  return {
    caseId: item?.id || "", profile: item?.profile || "",
    taskId: "", eventId: "", verifiedTaskId: "", verifiedEventId: "",
    manualTask: false, manualEvent: false,
    searchedTask: undefined, searchedEvent: undefined,
  };
}

function liveIds(item, snapshots, side) {
  return [...new Set((snapshots || [])
    .filter(snapshot => snapshot?.ref?.profile === item.profile
      && snapshot.ref.side === side && snapshot.object?.id === snapshot.ref.id
      && (side !== "calendar" || snapshot.object.status !== "cancelled"))
    .map(snapshot => snapshot.ref.id))];
}

export function reconcileRepairSelection(item, snapshots, previous) {
  const current = previous?.caseId === item.id && previous?.profile === item.profile
    ? previous : emptyRepairSelection(item);
  const context = item.decision?.context || {};
  const mapping = item.decision?.mappingSnapshot;
  const resolve = (side, value, manual, hints) => {
    const ids = liveIds(item, snapshots, side);
    // An explicit selection (including intentionally clearing an ID for Create)
    // is not replaced by an unrelated item discovered during refresh.
    if (manual) { const id = value && ids.includes(value) ? value : ""; return { id, verified: id }; }
    const id = hints.find(hint => ids.includes(hint)) || (ids.length === 1 ? ids[0] : "");
    return { id, verified: id };
  };
  const task = resolve("todoist", current.taskId, current.manualTask,
    [mapping?.taskId, item.decision?.taskId, context.providerTaskId, item.taskId]);
  const event = resolve("calendar", current.eventId, current.manualEvent,
    [mapping?.activeInstanceId, mapping?.eventId, mapping?.masterEventId,
      item.decision?.activeInstanceId, item.decision?.eventId, context.providerEventId,
      item.decision?.masterEventId, item.eventId]);
  return { ...current, taskId:task.id, verifiedTaskId:task.verified,
    eventId:event.id, verifiedEventId:event.verified,
    // A provider refresh takes precedence over earlier search evidence. Never
    // retain search metadata for an ID that was cleared or became unverified.
    searchedTask:task.verified && current.searchedTask?.id === task.id ? current.searchedTask : undefined,
    searchedEvent:event.verified && current.searchedEvent?.id === event.id ? current.searchedEvent : undefined };
}

export function editRepairSelection(previous, side, id, verified = false, searchResult = undefined) {
  // Search responses carry recurrence data, but aren't part of case snapshots.
  // Bind their metadata to the selected ID and case to prevent stale leakage.
  const searched = verified && searchResult?.id === id ? {
    id, caseId:previous.caseId, profile:previous.profile,
    due:searchResult.due, recurrence:searchResult.recurrence,
    recurringEventId:searchResult.recurringEventId, status:searchResult.status,
  } : undefined;
  if (side === "todoist") return {
    ...previous, taskId:id, verifiedTaskId:verified ? id : "", manualTask:true, searchedTask:searched,
  };
  return { ...previous, eventId:id, verifiedEventId:verified ? id : "", manualEvent:true, searchedEvent:searched };
}

// Only derive recurrence requirements from the *selected*, live provider snapshot.
// A different case's recurrence must not accidentally block the current repair.
export function repairRecurrenceOwnerRequirement(form, details, action) {
  if (!["link","transfer","create"].includes(action) || !form?.profile || details?.item?.profile !== form.profile
    || details?.item?.id !== form.caseId) return undefined;
  const current = (side, id) => {
    if (!id) return undefined;
    const snapshot = (details.snapshots || []).find(snapshot => snapshot.ref?.profile === form.profile
      && snapshot.ref.side === side && snapshot.ref.id === id && snapshot.object?.id === id);
    if (snapshot) return snapshot.object;
    // A searched item was verified live by the provider's search endpoint,
    // although the case detail has not yet collected it into snapshots.
    const searched = side === "calendar" ? form.searchedEvent : form.searchedTask;
    const verifiedId = side === "calendar" ? form.verifiedEventId : form.verifiedTaskId;
    return verifiedId === id && searched?.id === id && searched.caseId === form.caseId
      && searched.profile === form.profile ? searched : undefined;
  };
  const event = current("calendar", form.eventId);
  const task = current("todoist", form.taskId);
  if ((action === "link" || action === "transfer" || action === "create" && !form.taskId) && event?.recurringEventId) return "calendar-occurrence";
  if ((action === "link" || action === "transfer" || action === "create" && !form.taskId) && event?.recurrence?.length) return "calendar-series";
  if (action === "link" && task?.due?.is_recurring) return "todoist-task";
  return undefined;
}

// Map actionable API validation to the adjacent form control, not just the page notice.
export function repairValidationField(message) {
  if (/^Creating a yearly Calendar series from a standalone event requires Future occurrences|^Changing a Calendar series to Todoist ownership requires a future-only preview|^Choose the Calendar master to repair a whole series|^Select the Calendar master for a future-only repair|^Use a master-level recurrence repair/.test(message || "")) return "scope";
  if (/^Choose which provider owns the recurrence|^Choose Todoist recurrence ownership|^Creating a counterpart for a Calendar (series|occurrence) requires Calendar recurrence ownership|^Todoist recurrence ownership requires/.test(message || "")) return "owner";
  if (/^Use Todoist fields for a Todoist-owned yearly Calendar series repair|^Fields differ:|^Use Calendar fields for/.test(message || "")) return "winner";
  if (/^Verification requires live Todoist/.test(message || "")) return "taskId";
  if (/^Verification requires live Calendar|^Selected pair does not match/.test(message || "")) return "eventId";
  if (/^Calendar series has no active occurrence|^Choose the active Calendar occurrence|^Calendar repair sources must be confirmed/.test(message || "")) return "eventId";
  return undefined;
}

// Failed operation status alone does not prove that resuming can do useful work.
// A validated checkpoint is read-only; any other started checkpoint may have
// crossed a side-effect boundary and must retain its existing recovery path.
function stableOperationValue(value) {
  const normalize = item => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key, child])=>[key,normalize(child)]))
    : item;
  return JSON.stringify(normalize(value)) ?? "undefined";
}
export function operationResumeEligibility(operation) {
  if (!operation || !["failed", "needs_review", "queued"].includes(operation.status)) return "none";
  const steps = operation.steps || {};
  const snapshotObjects = new Map((operation.preview?.snapshots || []).map(snapshot => [
    `${snapshot.ref.profile}:${snapshot.ref.side}:${snapshot.ref.id}`, snapshot.object ?? null,
  ]));
  const providerProgress = Object.entries(operation.expectedProviders || {}).some(([key, object]) =>
    !snapshotObjects.has(key) || stableOperationValue(object) !== stableOperationValue(snapshotObjects.get(key)));
  const hasWriteEvidence = Object.keys(steps).some(name => name !== "validated")
    || Object.values(operation.creations || {}).length > 0
    || providerProgress
    || operation.writeStarted === true
    || operation.outcomes !== undefined || operation.verified !== undefined
    || operation.recurrenceBindings !== undefined;
  if (operation.abandoned) return hasWriteEvidence ? "none" : "fresh-preview";
  if (operation.status === "queued") return "resume";
  if (operation.status === "needs_review" && !hasWriteEvidence) return "fresh-preview";
  if (operation.status === "needs_review") return "resume";
  return hasWriteEvidence ? "resume" : "fresh-preview";
}

export function repairPreviewAllowed(form, selected, details, action, decisionAction, owner = "") {
  if (!selected || !details || form.caseId !== selected.id || form.profile !== selected.profile
      || details.item?.id !== selected.id || details.item?.profile !== selected.profile) return false;
  if (repairRecurrenceOwnerRequirement(form, details, action) && !["todoist","calendar"].includes(owner)) return false;
  // A typed or outdated ID cannot be silently included in a different repair.
  if (form.taskId && form.taskId !== form.verifiedTaskId
      || form.eventId && form.eventId !== form.verifiedEventId) return false;
  const hasTask = Boolean(form.taskId && form.verifiedTaskId === form.taskId);
  const hasEvent = Boolean(form.eventId && form.verifiedEventId === form.eventId);
  switch (action) {
    case "link":
    case "transfer":
    case "verify": return hasTask && hasEvent;
    case "create": return hasTask !== hasEvent;
    case "move": return hasTask;
    case "decision": return Boolean(decisionAction) && (hasTask || hasEvent);
    case "separate":
    case "exclude": return hasTask || hasEvent;
    default: return false;
  }
}

// Preview validation may discover a mapped item outside the original case snapshots.
// Refresh the complete affected set rather than guessing a safe disposition.
export function missingDispositionReference(message) {
  const match = /^Choose (?:Create counterpart or Exclude|Create counterpart, Exclude, or Leave unchanged|Create counterpart, Exclude, Leave unchanged, or Retain unlinked) for (home|antonio|work):(todoist|calendar):([^\s]+)$/.exec(message || '');
  return match ? `${match[1]}:${match[2]}:${match[3]}` : undefined;
}
