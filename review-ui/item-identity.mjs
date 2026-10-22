// A displayed provider object must carry a stable, verifiable identity before
// the operator can select it or assign a disposition. Keep search and repair
// snapshots on the same presentation/validation path.
export function providerIdentity(value) {
  const ref = value?.ref || { profile:value?._profile, side:value?._side, id:value?.id };
  const object = value && Object.hasOwn(value, "object") ? value.object : value;
  const side = ref?.side, id = ref?.id;
  const title = object?.content || object?.summary || object?.title || "(Untitled)";
  const start = side === "todoist"
    ? object?.due?.datetime || object?.due?.date
    : object?.start?.dateTime || object?.start?.date;
  const end = side === "calendar" ? object?.end?.dateTime || object?.end?.date : undefined;
  const date = start ? end && end !== start ? `${start} → ${end}` : start
    : side === "todoist" ? "No due date" : "Start unavailable";
  let recurrence = "One-off / not recurring";
  if (side === "todoist" && object?.due?.is_recurring) {
    recurrence = `Recurring Todoist task (${object.due.string || "rule unavailable"})`;
  } else if (side === "calendar" && object?.recurringEventId) {
    const original = object.originalStartTime?.dateTime || object.originalStartTime?.date;
    recurrence = `Series occurrence · master ${object.recurringEventId}${original ? ` · original start ${original}` : ""}`;
  } else if (side === "calendar" && object?.recurrence?.length) {
    recurrence = `Series master · ${object.recurrence.join(" · ")}`;
  } else if (side === "calendar" && value?.mapping?.masterEventId === id) {
    recurrence = `Series master · ${value.mapping.recurrenceOwner || "owner unspecified"}-owned`;
  }
  const status = !object ? "Missing (404/410)"
    : side === "calendar" ? object.status === "cancelled" ? "Cancelled" : object.status === "confirmed" ? "Confirmed" : "Unknown"
    : object.is_deleted ? "Deleted" : object.is_completed ? "Completed" : "Active";
  const identified = Boolean(id && ref?.profile && ["calendar", "todoist"].includes(side)
    && object && object.id === id
    && (side === "todoist" || Boolean(start && ["Confirmed", "Cancelled"].includes(status))));
  const selectable = identified && status !== "Cancelled" && status !== "Deleted";
  return { profile:ref?.profile || "", side:side || "", id:id || "", title, date, recurrence, status, identified, selectable };
}

export function scopeLabel(scope) {
  return ({ occurrence:"This occurrence", series:"Entire series", future:"Future occurrences (preserve history)" })[scope] || "Scope not selected";
}

export function previewEffect(snapshot, intent, plan) {
  if (plan) return plan;
  const key = `${snapshot.ref.profile}:${snapshot.ref.side}:${snapshot.ref.id}`;
  const disposition = intent?.leftovers?.[key];
  if (disposition === "create") return { operation:"Create counterpart", result:"Link to newly created counterpart" };
  if (disposition === "exclude") return { operation:"Exclude", result:"Excluded from syncing" };
  return { operation:"Selected repair / contextual item", result:"See planned changes below" };
}
