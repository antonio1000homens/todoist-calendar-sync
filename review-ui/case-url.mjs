export function caseUrl(currentHref, caseId) {
  const url = new URL(currentHref);
  if (caseId) url.searchParams.set("case", caseId);
  else url.searchParams.delete("case");
  return url;
}

export function caseIdsFromEvidence(item) {
  const context=item?.decision?.context||{};
  const strings=(value)=>Array.isArray(value)?value.filter((id)=>typeof id==="string"&&id.length>0):[];
  return {
    taskIds:[item?.taskId,item?.decision?.taskId,context.providerTaskId,context.taskId,context.masterTaskId,
      ...strings(context.candidateTaskIds),...(Array.isArray(context.candidates)?context.candidates.map(candidate=>candidate?.id):[])].filter((id)=>typeof id==="string"&&id.length>0),
    eventIds:[item?.eventId,item?.decision?.eventId,item?.decision?.masterEventId,item?.decision?.activeInstanceId,context.providerEventId,context.eventId,
      context.masterEventId,context.activeInstanceId,...strings(context.candidateEventIds)].filter((id)=>typeof id==="string"&&id.length>0),
    seriesIds:[item?.decision?.seriesId,context.seriesId].filter((id)=>typeof id==="string"&&id.length>0),
  };
}

export function caseIdentityState(item, snapshots=[]) {
  const ids=caseIdsFromEvidence(item);
  const verified=new Set(snapshots.filter((snapshot)=>snapshot?.object?.id===snapshot?.ref?.id)
    .map((snapshot)=>`${snapshot.ref.side}:${snapshot.ref.id}`));
  return {
    taskIds:[...new Set(ids.taskIds)], eventIds:[...new Set(ids.eventIds)],
    seriesIds:[...new Set(ids.seriesIds)],
    verifiedTaskIds:[...new Set(ids.taskIds.filter((id)=>verified.has(`todoist:${id}`)))],
    verifiedEventIds:[...new Set(ids.eventIds.filter((id)=>verified.has(`calendar:${id}`)))],
    hasAnyRecordedIdentity:ids.taskIds.length+ids.eventIds.length>0,
  };
}

export function dispositionGuidance(disposition) {
  if(disposition==="unchanged") return "No new exclusion is added. Existing provider, mapping and sync-control state is preserved; the same conflict can return on a later reconciliation if the inconsistency remains.";
  if(disposition==="exclude") return "Adds a sync guard for this exact provider ID. It does not delete Calendar history or automatically suppress other members of the series; future scans may record this as blocked.";
  if(disposition==="retain-unlinked") return "Keeps this exact object and detaches only the obsolete mapping shown in the preview. Available only when the transfer guard verifies ownership.";
  return "No disposition selected.";
}

export function snapshotRelationship(snapshot, selectedIds={}) {
  const reasons=Array.isArray(snapshot?.includedBy)?snapshot.includedBy:[];
  return reasons.length?reasons:["The review service did not record why this item was included; treat its relationship as unknown."];
}

export function groupAffectedSnapshots(snapshots=[]) {
  const groups=new Map();
  for(const snapshot of snapshots){
    const object=snapshot?.object;
    const recurrence=snapshot?.recurrence;
    const masterId=recurrence?.masterEventId||snapshot?.mapping?.masterEventId||object?.recurringEventId
      ||(object?.recurrence?.length?snapshot?.ref?.id:undefined);
    const groupId=masterId?`${snapshot.ref.profile}:series:${recurrence?.seriesId||masterId}`:undefined;
    const key=groupId||`${snapshot?.ref?.profile}:${snapshot?.ref?.side}:${snapshot?.ref?.id}`;
    const current=groups.get(key)||{key,seriesId:recurrence?.seriesId,masterId,items:[]};
    current.items.push(snapshot);groups.set(key,current);
  }
  return [...groups.values()].map(group=>({...group,items:group.items.sort((a,b)=>{
    const role=(snapshot)=>snapshot?.object?.recurringEventId?1:snapshot?.object?.recurrence?.length?0:2;
    return role(a)-role(b)||String(a.ref.id).localeCompare(String(b.ref.id));
  })}));
}
