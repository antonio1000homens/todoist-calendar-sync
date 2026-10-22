// Keep repair identifiers bound to the case and verified live provider snapshots.
// A previous case's (or an unresolved) selection must never be previewable.
export function emptyRepairSelection(item) {
  return {
    caseId: item?.id || "", profile: item?.profile || "",
    taskId: "", eventId: "", verifiedTaskId: "", verifiedEventId: "",
    manualTask: false, manualEvent: false,
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
    [item.taskId, item.decision?.taskId, context.providerTaskId, mapping?.taskId]);
  const event = resolve("calendar", current.eventId, current.manualEvent,
    [item.eventId, item.decision?.eventId, context.providerEventId,
      item.decision?.activeInstanceId, mapping?.activeInstanceId,
      mapping?.eventId, item.decision?.masterEventId, mapping?.masterEventId]);
  return { ...current, taskId:task.id, verifiedTaskId:task.verified,
    eventId:event.id, verifiedEventId:event.verified };
}

export function editRepairSelection(previous, side, id, verified = false) {
  if (side === "todoist") return {
    ...previous, taskId:id, verifiedTaskId:verified ? id : "", manualTask:true,
  };
  return { ...previous, eventId:id, verifiedEventId:verified ? id : "", manualEvent:true };
}

export function repairPreviewAllowed(form, selected, details, action, decisionAction) {
  if (!selected || !details || form.caseId !== selected.id || form.profile !== selected.profile
      || details.item?.id !== selected.id || details.item?.profile !== selected.profile) return false;
  // A typed or outdated ID cannot be silently included in a different repair.
  if (form.taskId && form.taskId !== form.verifiedTaskId
      || form.eventId && form.eventId !== form.verifiedEventId) return false;
  const hasTask = Boolean(form.taskId && form.verifiedTaskId === form.taskId);
  const hasEvent = Boolean(form.eventId && form.verifiedEventId === form.eventId);
  switch (action) {
    case "link":
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
  const match = /^Choose Create counterpart or Exclude for (home|antonio|work):(todoist|calendar):([^\s]+)$/.exec(message || '');
  return match ? `${match[1]}:${match[2]}:${match[3]}` : undefined;
}
