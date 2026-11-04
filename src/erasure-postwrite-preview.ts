/**
 * Read-only evidence assessment for an erasure that may have written to a
 * provider. This must NEVER issue a recovery confirmation, mutate mappings,
 * or construct/execute a fence-release transaction. The post-write executor
 * and its separately scoped operator authorisation are not implemented.
 */
import type {ErasureOperation} from "./erasure-executor.js";
import type {RecoveryPreview} from "./erasure-recovery.js";

export type PostWriteClassification = "not_post_write" | "fully_deleted_candidate" | "partial_or_ambiguous";
export interface PostWriteRecoveryAssessment {
  operationId:string;
  profile:ErasureOperation["profile"];
  classification:PostWriteClassification;
  releaseAllowed:false;
  reviewStatus?:"reviewed_fenced";
  reviewEnabled?:boolean;
  onlyAvailableAction:"keep_fenced";
  potentialDisposition:"independent_full_deletion_verification"|"new_reviewed_deletion_authorization"|"use_pre_write_recovery";
  blockers:string[];
  evidence:{
    originalProviderWriteIndicated:boolean;
    originalCalendarDeletionSelected:boolean;
    exactTodoistAndCalendarTargetsRecorded:boolean;
    matchingFence:boolean;
    epochVerified:boolean;
    leasesDrained:boolean;
    providersAbsent:boolean;
    stateRowsAbsent:boolean;
    mappingStateCount:number;
    workerMappingsRestored:boolean;
  };
}

const afterWritePhases=new Set(["delete","verify_deletion","restore_mappings","confirm_restored","release_fence","complete"]);
/** No raw provider IDs, comments, task titles, timestamps or mapping UUIDs
 * leave this assessment. Every boolean is derived from a separate strong
 * read or immutable, originally-confirmed erasure evidence. */
export function assessPostWriteRecovery(operation:ErasureOperation,inspection:RecoveryPreview):PostWriteRecoveryAssessment {
  const lifecycle=operation.lifecycle;
  const indicated=Boolean(lifecycle && (lifecycle.evidence?.deletionStarted
    || lifecycle.deletionProgress || afterWritePhases.has(lifecycle.phase)));
  const writeReceipt=Boolean(lifecycle?.evidence?.deletionStarted
    &&lifecycle.evidence.deletionStarted.operationId===operation.operationId
    &&lifecycle.evidence.deletionStarted.phase==="deletionStarted");
  const unrelatedBlockers=inspection.blockers.filter(x=>
    x!=="Full deletion needs durable replay/tombstone assurance before restoring admission");
  const deletionSelected=operation.selectedActions.deleteCalendar===true
    && operation.selectedActions.deleteTodoist===true
    && operation.target.deleteCalendar===true;
  const targets=Boolean(operation.target.taskId&&operation.target.eventId
    &&operation.actionPlan?.todoistTask?.id===operation.target.taskId
    &&operation.actionPlan?.calendarEvent?.id===operation.target.eventId);
  const mappingsRestored=Boolean(lifecycle && inspection.mappingStates.length===lifecycle.mappingIds.length
    &&inspection.mappingStates.every(m=>m.state===(m.originallyEnabled?"Enabled":"Disabled")));
  const candidate=inspection.classification==="fully_deleted"
    &&indicated&&writeReceipt&&deletionSelected&&targets
    &&inspection.fenceOwned&&Boolean(inspection.epoch)&&inspection.leaseCount===0
    &&unrelatedBlockers.length===0
    &&inspection.providerItemsAbsent&&inspection.stateRowsAbsent;
  const classification:PostWriteClassification=!indicated?"not_post_write":
    candidate?"fully_deleted_candidate":"partial_or_ambiguous";
  const blockers=[...inspection.blockers];
  if(!indicated)blockers.push("No provider-write boundary is indicated; use pre-write recovery if independently verified");
  if(indicated&&!writeReceipt)blockers.push("No valid durable deletion-start receipt proves the original provider-write stage");
  if(!deletionSelected)blockers.push("Original confirmation did not select deletion of both Todoist and Calendar");
  if(!targets)blockers.push("Original immutable inventory lacks both exact provider targets; aliases require separate verification");
  if(!inspection.fenceOwned)blockers.push("Matching active profile fence is not verified");
  if(!inspection.epoch)blockers.push("Monotonic erasure epoch is missing");
  if(inspection.leaseCount!==0)blockers.push("Provider admission or writer leases have not drained");
  if(!inspection.providerItemsAbsent || !inspection.stateRowsAbsent)
    blockers.push("One or more original provider items, mapping comments or attributable state rows remain or are ambiguous");
  if(!mappingsRestored)blockers.push("Worker mapping states differ from original enablement; restoration remains guarded");
  if(classification==="partial_or_ambiguous")
    blockers.push("Partial or unverified deletion requires a NEW independently reviewed authorization and action-time version checks");
  // Even a perfect snapshot does not prove source/alias completeness, old
  // qualified consumer safety, or the immutable marker/fence transaction.
  if(inspection.crossProfileEvidence)blockers.push(...inspection.crossProfileEvidence.missingProof);
  else blockers.push("No read-only all-profile provider, comment and state provenance report was collected");
  blockers.push("Complete replay-barrier rollout, alias and old-Lambda coverage, executable post-write authorisation and verified atomic release are not yet accepted");
  blockers.push("Disposable Work-profile staging and independent security/privacy review remain required");
  const potentialDisposition=classification==="not_post_write"?"use_pre_write_recovery":
    classification==="fully_deleted_candidate"?"independent_full_deletion_verification":
    "new_reviewed_deletion_authorization";
  return {
    operationId:operation.operationId,profile:operation.profile,classification,releaseAllowed:false,
    onlyAvailableAction:"keep_fenced",potentialDisposition,
    blockers:[...new Set(blockers)].sort(),
    evidence:{
      originalProviderWriteIndicated:indicated,originalCalendarDeletionSelected:deletionSelected,
      exactTodoistAndCalendarTargetsRecorded:targets,matchingFence:inspection.fenceOwned,
      epochVerified:typeof inspection.epoch==="number"&&inspection.epoch>0,
      leasesDrained:inspection.leaseCount===0,providersAbsent:inspection.providerItemsAbsent,
      stateRowsAbsent:inspection.stateRowsAbsent,mappingStateCount:inspection.mappingStates.length,
      workerMappingsRestored:mappingsRestored,
    },
  };
}
