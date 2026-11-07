/**
 * Fully read-only exact-identity audit helper for #292. This can be exercised
 * against fake providers/state and never imports a mutation/queue executor.
 * Its output describes eligibility, not permission to commit a retirement.
 */
import { reviewCaseEvidenceIds } from "../dist/deleted-review-identities.js";
import { deletedRecurrenceStatus } from "../dist/deletion-review-state.js";
import { cancelledOccurrenceMasterId, verifyCancelledSeriesInstances } from "../dist/verified-deletion.js";

export async function auditDeletedRecurrenceCase(item,provider,state){
  const {taskIds,eventIds}=reviewCaseEvidenceIds(item);
  const entry={profile:item.profile,caseId:item.id,taskIds,eventIds};
  if(!item.decision?.type?.includes("recurrence_task_deleted")
    ||!taskIds.length||!eventIds.length||taskIds.length+eventIds.length>20)
    return {...entry,state:"unverified",reason:"Incomplete or excessive exact recurring identity"};
  const snapshots=[];
  const seen=new Set();
  const read=async(side,id)=>{
    const key=side+":"+id;
    if(seen.has(key))return;
    seen.add(key);
    let object=null,lookupError;
    try {object=side==="todoist"
      ?await provider.todoist.getTask(id):await provider.calendar.getEvent(id);}
    catch(error){
      if(![404,410].includes(Number(error?.status)))
        lookupError="Direct provider lookup unavailable"; // Never expose credentials or API payloads.
    }
    const mapping=side==="todoist"
      ?await state.getMappingByTaskAnyProfile(id)
      :(await Promise.all(["home","antonio","work"].map(owner=>state.getMappingByEvent(owner,id)))).find(Boolean);
    snapshots.push({ref:{profile:item.profile,side,id},object,lookupError,mapping,
      checkedAt:new Date().toISOString()});
  };
  for(const id of taskIds)await read("todoist",id);
  for(const id of eventIds)await read("calendar",id);
  const recordedMaster=item.decision.masterEventId||item.decision.mappingSnapshot?.masterEventId;
  const activeId=item.decision.activeInstanceId||item.decision.mappingSnapshot?.activeInstanceId;
  const active=snapshots.find(snapshot=>snapshot.ref.side==="calendar"
    &&snapshot.ref.id===activeId&&!snapshot.lookupError);
  const recoveredMaster=!recordedMaster
    ?cancelledOccurrenceMasterId(activeId,active?.object||undefined):undefined;
  if(recoveredMaster&&!eventIds.includes(recoveredMaster)){
    if(taskIds.length+eventIds.length+1>20)
      return {...entry,state:"unverified",reason:"Recovered master exceeds bounded identity limit"};
    await read("calendar",recoveredMaster);
  }
  const deletion=await deletedRecurrenceStatus(item,snapshots,
    (owner,seriesId)=>state.getRecurrenceLink(owner,seriesId));
  // This is still a read-only recommendation, never authority to retire.
  // A cancelled master alone is not proof of a fully deleted series. Match
  // the worker's complete, paginated instance/history safety assessment.
  let instanceAssessment;
  if(recoveredMaster && deletion?.bothGone && deletion.masterId===recoveredMaster) {
    try {
      const master=snapshots.find(snapshot=>snapshot.ref.side==="calendar"
        && snapshot.ref.id===recoveredMaster)?.object;
      const instances=await provider.calendar.listEventInstances(recoveredMaster);
      if(!master?.iCalUID)throw new Error("Cancelled master iCalUID missing");
      instanceAssessment=await verifyCancelledSeriesInstances({
        profile:item.profile,taskIds,masterId:recoveredMaster,
        masterSeriesId:master.iCalUID,activeInstanceId:activeId,
        instances,nowMs:Date.now(),
      },id=>state.getCompletedCalendarProjectionByEvent(item.profile,id));
    } catch {
      instanceAssessment={valid:false,reason:"Complete instance or completed-history inventory unavailable"};
    }
  }
  const eligible=deletion?.bothGone&&["pending_cleanup","stale_recurrence"].includes(deletion.state)
    && (!recoveredMaster||instanceAssessment?.valid===true);
  return {...entry,deletion,recurrenceLinks:deletion?.staleLinks||[],
    ...(instanceAssessment ? {instanceAssessment:{
      valid:instanceAssessment.valid,
      ...(instanceAssessment.reason?{reason:instanceAssessment.reason}:{})
    }} : {}),
    action:eligible?"candidate_for_guarded_reconciliation":"retain_for_manual_review"};
}
