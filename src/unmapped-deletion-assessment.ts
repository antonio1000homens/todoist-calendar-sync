import type {ReviewCase,ReviewSnapshot} from "./review-types.js";
import {reviewCaseEvidenceIds} from "./deleted-review-identities.js";

export type RecordedProviderState="deleted"|"live"|"unverified";
export interface UnmappedDeletionAssessment {
  state:"providers_deleted"|"partial"|"unverified";
  bothGone:boolean;
  taskIds:string[];
  eventIds:string[];
  taskStates:Array<{id:string;state:RecordedProviderState}>;
  eventStates:Array<{id:string;state:RecordedProviderState}>;
  reason:string;
}

/**
 * Presentation-only, current-read assessment for a deleted-pair review alert.
 * This NEVER grants cleanup eligibility: complete mapping/index/repair/series
 * ownership is still independently checked inside guarded reconciliation.
 * It uses only IDs recorded by the alert, not a repair-selected replacement.
 */
export function assessUnmappedConflictDeletion(
  item:ReviewCase,snapshots:ReviewSnapshot[],
):UnmappedDeletionAssessment | undefined {
  const standaloneDeletedPair=item.decision?.type==="standalone_todoist_task_deleted";
  const applicable=standaloneDeletedPair||item.decision?.type==="todoist_unmapped_conflict"
    || ["todoist_unmapped_conflict","calendar_snapshot_recurring_identity_conflict"].includes(item.reason);
  if(!applicable)return undefined;
  const {taskIds,eventIds}=reviewCaseEvidenceIds(item);
  const base={taskIds,eventIds,taskStates:[] as Array<{id:string;state:RecordedProviderState}>,
    eventStates:[] as Array<{id:string;state:RecordedProviderState}>};
  if(!taskIds.length||!eventIds.length||taskIds.length+eventIds.length>20)
    return {...base,state:"unverified",bothGone:false,reason:"The alert lacks a bounded, exact identity on both providers"};
  const get=(side:"todoist"|"calendar",id:string):RecordedProviderState=>{
    const candidates=snapshots.filter(s=>s.ref.profile===item.profile&&s.ref.side===side&&s.ref.id===id);
    // A failed, absent, duplicate or stale snapshot is NOT evidence of
    // provider deletion. A 404/410 observed via a fresh direct read is.
    if(candidates.length!==1)return "unverified";
    const snapshot=candidates[0];
    if(snapshot.lookupError||typeof snapshot.checkedAt!=="string"
      ||!Number.isFinite(Date.parse(snapshot.checkedAt)))return "unverified";
    const obj=snapshot.object;
    if(obj===null)return "deleted";
    if(!obj||obj.id!==id)return "unverified";
    if(side==="calendar")return "status" in obj
      ?obj.status==="cancelled"?"deleted":obj.status==="confirmed"?"live":"unverified"
      :"unverified";
    if("is_deleted" in obj && obj.is_deleted===true)return "deleted";
    return "live"; // completed Todoist tasks remain protected as live history
  };
  const taskStates=taskIds.map(id=>({id,state:get("todoist",id)}));
  const eventStates=eventIds.map(id=>({id,state:get("calendar",id)}));
  const all=[...taskStates,...eventStates];
  if(all.some(ref=>ref.state==="unverified"))
    return {...base,taskStates,eventStates,state:"unverified",bothGone:false,
      reason:"A required direct provider read failed, changed identity, or returned incomplete status"};
  if(all.every(ref=>ref.state==="deleted"))
    return {...base,taskStates,eventStates,state:"providers_deleted",bothGone:true,
      reason:standaloneDeletedPair
        ?"Recorded one-off provider identities are deleted. Mapping, audit and repair state still require guarded reconciliation"
        :"Recorded provider identities are deleted. Mapping, recurrence, audit and repair state still require guarded reconciliation"};
  return {...base,taskStates,eventStates,state:"partial",bothGone:false,
    reason:"At least one recorded provider item or Calendar series remains live; do not remove or recreate it based on stale evidence"};
}
