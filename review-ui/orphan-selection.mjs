// UI-only classification of exact provider identities observed in the
// selected review case. This never authorizes deletion: an absent/empty local
// snapshot cannot establish authoritative counterpart absence.
const exactId=value=>typeof value==="string"&&value.length>0&&value.length<=1024;
const strings=value=>Array.isArray(value)?value.filter(exactId):[];
export function recordedOrphanIdentities(item) {
  if(!item?.id||!item?.profile)return {todoist:[],calendar:[]};
  const decision=item.decision||{},context=decision.context||{};
  const candidates=Array.isArray(context.candidates)
    ?context.candidates.map(entry=>entry?.id).filter(exactId):[];
  const tasks=[item.taskId,decision.taskId,context.providerTaskId,context.taskId,
    context.masterTaskId,...strings(context.candidateTaskIds),...candidates];
  const events=[item.eventId,decision.eventId,decision.masterEventId,
    decision.activeInstanceId,context.providerEventId,context.eventId,
    context.masterEventId,context.activeInstanceId,...strings(context.candidateEventIds)];
  const unique=values=>[...new Set(values.filter(exactId))];
  return {todoist:unique(tasks),calendar:unique(events)};
}
const key=(ref)=>`${ref.profile}:${ref.side}:${ref.id}`;
const isLive=s=>Boolean(s?.object?.id===s?.ref?.id&&!s.lookupError&&(s.ref.side==="todoist"
  ?s.object.is_deleted===false&&s.object.is_completed===false
  :s.object.status==="confirmed"));
const isRecurring=s=>s?.ref?.side==="todoist"?s.object?.due?.is_recurring===true
  :Boolean(s?.object?.recurringEventId||s?.object?.recurrence?.length
    ||s?.recurrence||s?.object?.extendedProperties?.shared?.syncRecurrenceOwner);
const title=s=>s.ref.side==="todoist"?s.object?.content:s.object?.summary;
const reasonFor=s=>{
  if(!s)return "Provider identity has not been directly verified";
  if(s.lookupError)return "Provider identity or ownership could not be verified; retry the direct lookup before considering deletion";
  if(!s.object)return "Missing (404/410); this object cannot be deleted again";
  if(!isLive(s))return s.ref.side==="calendar"?"Cancelled or unverified Calendar object":"Deleted, completed or missing explicit Todoist status fields";
  if(s.mapping||s.recurrence||s.control?.activeRepair||s.control?.excluded)return "Linked, controlled, or mapping/ownership evidence requires repair";
  if(s.object?.extendedProperties?.shared?.taskId)return "Calendar metadata references a Todoist counterpart";
  if(isRecurring(s))return "Recurring item requires separately verified owner and scope";
  return "Current item verified; independent counterpart absence, cross-profile ownership, replay fences and recovery evidence are not yet proven";
};
export function orphanItemsForCase({item,snapshots=[]}={}) {
  if(!item?.id||!item?.profile||!Array.isArray(snapshots))return [];
  const ids=recordedOrphanIdentities(item);
  const anchored=snapshots.some(s=>s?.ref?.profile===item.profile&&
    (s.ref.side==="todoist"?ids.todoist:ids.calendar)?.includes(s.ref.id));
  if(!anchored)return [];
  const refs=new Map();
  // Every additional item must be in the graph freshly returned for this
  // exact case. Do not source candidates from title search or the global inbox.
  for(const snap of snapshots){
    if(!snap?.ref||snap.ref.profile!==item.profile
      ||!["todoist","calendar"].includes(snap.ref.side)||!exactId(snap.ref.id))continue;
    const ref=snap.ref;
    // includedBy describes repair graph discovery, NOT immutable alert membership.
    // Search/recheck can introduce arbitrary other objects, which may never
    // become deletion candidates merely because they appear in snapshots.
    const allowed=(ref.side==="todoist"?ids.todoist:ids.calendar).includes(ref.id);
    if(!allowed)continue;
    if(!refs.has(key(ref)))refs.set(key(ref),snap);
  }
  return [...refs.values()].map(s=>{
    const side=s.ref.side,id=s.ref.id,objectTitle=title(s);
    const provider=side==="todoist"?"Todoist":"Calendar";
    const currentTitle=typeof objectTitle==="string"&&objectTitle.trim()?objectTitle.trim():"Title unavailable";
    const live=isLive(s),reason=item.status!=="open"
      ?"Only an open, item-level review alert can request an orphan deletion"
      :reasonFor(s);
    return {
      key:key(s.ref),profile:item.profile,side,id,title:currentTitle,
      label:`${provider} · ${currentTitle} · ${id}`,
      live,eligibility:"blocked",reason,
      status:s.lookupError?"unverified":!s.object?"missing":!live?"not live":s.mapping||s.recurrence?"linked":"verification required",
      // No UI-only proof may elevate a candidate to eligible; only a future
      // durable server-side operation can do so after complete postflight.
      eligible:false,
    };
  }).sort((a,b)=>a.side.localeCompare(b.side)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
}
export function chosenOrphan(items,caseItem,selectedKey) {
  return items.find(c=>c.key===selectedKey&&c.profile===caseItem?.profile&&c.eligible===true);
}
