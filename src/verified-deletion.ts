import type { CalendarEvent, CompletedCalendarProjection, Profile } from "./types.js";
/** Legacy decisions may omit masterEventId. Recover it ONLY from a direct
 * cancelled occurrence read, never by stripping an ID suffix or trusting an
 * old mapping/comment. The caller must then independently verify the master. */
export function cancelledOccurrenceMasterId(
  activeInstanceId: string | undefined, occurrence: CalendarEvent | undefined,
): string | undefined {
  if (!activeInstanceId || !occurrence || occurrence.id !== activeInstanceId
    || occurrence.status !== "cancelled" || !occurrence.recurringEventId
    || occurrence.recurringEventId === activeInstanceId) return undefined;
  return occurrence.recurringEventId;
}
/** Provider reads, not a date/title or a cancelled occurrence alone, must
 * establish the exact master and active occurrence. Missing master metadata
 * cannot establish Calendar-owned iCalUID key absence and fails closed. */
export function verifyCancelledSeries(
  masterId: string | undefined, activeInstanceId: string | undefined,
  eventIds: string[], events: Map<string, CalendarEvent | undefined>,
): { valid: boolean; masterSeriesId?: string; reason?: string } {
  if (!masterId || !activeInstanceId || masterId === activeInstanceId
    || !eventIds.includes(masterId) || !eventIds.includes(activeInstanceId))
    return { valid: false, reason: "Missing or inconsistent recurring master/active-instance identities" };
  const master = events.get(masterId);
  if (!master || master.id !== masterId || master.status !== "cancelled"
    || master.recurringEventId || !master.recurrence?.some(rule => rule.startsWith("RRULE:"))
    || !master.iCalUID)
    return { valid: false, reason: "Cancelled recurring master or its iCalUID cannot be independently verified" };
  for (const id of eventIds) {
    if (id === masterId) continue;
    const occurrence = events.get(id);
    if (!occurrence || occurrence.id !== id || occurrence.status !== "cancelled"
      || occurrence.recurringEventId !== masterId || occurrence.recurrence?.length
      || occurrence.iCalUID && occurrence.iCalUID !== master.iCalUID)
      return { valid: false, reason: "Recorded occurrence is absent, live or not linked to the exact recurring master" };
  }
  return { valid: true, masterSeriesId: master.iCalUID };
}

/** Full, bounded cancelled-series instance verification for legacy masterless
 * retirement. A confirmed historical exception is never deleted and is
 * accepted only with exact immutable completed-history evidence. A live or
 * future successor fails closed even when master and active reads are cancelled.
 * The caller must use the provider's fully paginated showDeleted=true read. */
export async function verifyCancelledSeriesInstances(
  input: {
    profile: Profile; taskIds: string[]; masterId: string; masterSeriesId: string;
    activeInstanceId: string; instances: CalendarEvent[]; nowMs: number;
  },
  completedHistory: (eventId: string) => Promise<CompletedCalendarProjection | undefined>,
): Promise<{valid:boolean;fingerprint?:string;reason?:string}> {
  const {instances,masterId,masterSeriesId,activeInstanceId,taskIds,profile,nowMs}=input;
  if(!Array.isArray(instances)||!instances.length||instances.length>100)
    return {valid:false,reason:"Cancelled Calendar series instance inventory is missing or excessive"};
  const unique=new Set<string>();
  const completions:Array<{id:string;history:CompletedCalendarProjection}>=[];
  for(const instance of instances){
    if(!instance||typeof instance.id!=="string"||!instance.id
      ||unique.has(instance.id)||instance.recurringEventId!==masterId
      ||instance.iCalUID && instance.iCalUID!==masterSeriesId)
      return {valid:false,reason:"Cancelled series contains an unverified, duplicate or foreign occurrence"};
    unique.add(instance.id);
    if(instance.status==="cancelled")continue;
    if(instance.status!=="confirmed"||instance.id===activeInstanceId)
      return {valid:false,reason:"A live or ambiguous Calendar recurrence occurrence remains"};
    const started=Date.parse(instance.originalStartTime?.dateTime
      ||instance.originalStartTime?.date||instance.start?.dateTime||instance.start?.date||"");
    if(!Number.isFinite(started)||started>=nowMs)
      return {valid:false,reason:"A future or undated Calendar occurrence remains"};
    const marker=await completedHistory(instance.id);
    if(!marker||marker.profile!==profile||!taskIds.includes(marker.taskId)
      ||marker.eventId!==instance.id||marker.masterEventId!==masterId
      ||marker.seriesId!==masterSeriesId||marker.seriesId===marker.taskId
      ||!Number.isFinite(Date.parse(marker.completedAt))||Date.parse(marker.completedAt)>nowMs)
      return {valid:false,reason:"A surviving Calendar occurrence has no matching immutable completed-history guard"};
    completions.push({id:instance.id,history:marker});
  }
  if(!unique.has(activeInstanceId))
    return {valid:false,reason:"Verified active cancelled occurrence is missing from complete series inventory"};
  const stable=instances.map(instance=>({
    id:instance.id,status:instance.status,etag:instance.etag,updated:instance.updated,
    recurringEventId:instance.recurringEventId,iCalUID:instance.iCalUID,
    start:instance.start,originalStartTime:instance.originalStartTime,
  })).sort((a,b)=>a.id.localeCompare(b.id));
  return {valid:true,fingerprint:JSON.stringify({
    instances:stable,completions:completions.sort((a,b)=>a.id.localeCompare(b.id)),
  })};
}
