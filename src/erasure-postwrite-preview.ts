/**
 * Read-only evidence assessment for an erasure that may have written to a
 * provider. It never issues a confirmation or performs a write. A separate
 * worker-owned finalizer may act only on the exact, complete operation proof
 * described here; it never resumes provider deletion.
 */
import type {ErasureOperation} from "./erasure-executor.js";
import type {RecoveryPreview} from "./erasure-recovery.js";

export type PostWriteClassification =
  "not_post_write" | "fully_deleted_candidate" | "partial_or_ambiguous" | "completed";
export type PostWriteAction = "keep_fenced" | "automatic_completion_pending" | "completed";
export interface PostWriteRecoveryAssessment {
  operationId:string;
  profile:ErasureOperation["profile"];
  classification:PostWriteClassification;
  /** The inspection itself is read-only and never grants a release. */
  releaseAllowed:false;
  reviewStatus?:"reviewed_fenced";
  onlyAvailableAction:PostWriteAction;
  potentialDisposition:"automatic_known_identity_completion"|"use_pre_write_recovery"|"keep_fenced_and_escalate"|"completed";
  completionEligible:boolean;
  completionBlockers:string[];
  completion?:{
    status:"pending"|"blocked"|"completed";
    automatic:true;
    tombstoneRetained:true;
    providerDeletesReplayed:false;
    completedAt?:string;
    epoch?:number;
    originalMappingCount?:number;
    restoredMappingCount?:number;
    fenceReleased?:true;
  };
  blockers:string[];
  /** Scoped diagnostic; never claims global Calendar erasure. */
  knownIdentity:{
    status:"known_identity_deleted"|"partial_or_ambiguous"|"not_post_write";
    scope:"recorded_original_targets_in_configured_profile";
    releaseAllowed:false;
  };
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
    deletionCheckpointComplete:boolean;
    projectTombstonePresent:boolean;
    knownCalendarAliasesComplete:boolean;
  };
}

const afterWritePhases=new Set(["delete","verify_deletion","restore_mappings","confirm_restored","release_fence","complete"]);
const fullDeletionBlocker="Full deletion needs durable replay/tombstone assurance before restoring admission";

function deletionCheckpointComplete(operation:ErasureOperation):boolean {
  const lifecycle=operation.lifecycle,progress=lifecycle?.deletionProgress;
  if(!lifecycle||!progress||!["delete","verify_deletion"].includes(lifecycle.phase)||progress.attempt)
    return false;
  const projectIds=operation.actionPlan?.projectCommentIds||[];
  const legacyFinalCommentComplete=progress.finalCommentIndex===undefined
    ||progress.finalCommentIndex===projectIds.length;
  const stageComplete=progress.stage==="verify"
    ||(progress.stage==="state"&&progress.stateIndex===operation.inventory.length);
  return stageComplete&&progress.commentIndex===operation.actionPlan.comments.length
    &&progress.stateIndex===operation.inventory.length&&legacyFinalCommentComplete
    &&Number.isFinite(progress.startedAt);
}

function completeAliasInventory(operation:ErasureOperation):boolean {
  const aliases=operation.actionPlan.knownCalendarAliases||[];
  const event=operation.actionPlan.calendarEvent;
  return operation.actionPlan.knownCalendarAliasesComplete===true
    &&Boolean(event&&event.id===operation.target.eventId&&event.calendarId)
    &&aliases.length>0&&aliases.length<=32
    &&aliases.every(item=>item&&["home","antonio","work"].includes(item.profile)
      &&typeof item.calendarId==="string"&&item.calendarId.length>0
      &&typeof item.eventId==="string"&&item.eventId.length>0)
    &&new Set(aliases.map(item=>JSON.stringify([item.profile,item.calendarId,item.eventId]))).size===aliases.length
    &&aliases.some(item=>item.profile===operation.profile&&item.calendarId===event!.calendarId
      &&item.eventId===operation.target.eventId);
}

function exactProjectCommentInventory(operation:ErasureOperation):boolean {
  const ids=operation.actionPlan.projectCommentIds||[];
  const projectComments=operation.actionPlan.comments.filter(item=>item.kind==="project").map(item=>item.id);
  return ids.length>0&&ids.length<=32&&new Set(ids).size===ids.length
    &&ids.every(id=>typeof id==="string"&&id.length>0)
    &&projectComments.length===ids.length
    &&ids.every(id=>projectComments.includes(id));
}

/** No raw provider IDs, comments, task titles, hashes or mapping UUIDs leave
 * this assessment. It uses only the operation's immutable known targets and
 * its exact active 18-day project-comment tombstone, not a global Calendar scan. */
export function assessPostWriteRecovery(operation:ErasureOperation,inspection:RecoveryPreview):PostWriteRecoveryAssessment {
  const lifecycle=operation.lifecycle;
  const indicated=Boolean(lifecycle&&(lifecycle.evidence?.deletionStarted
    ||lifecycle.deletionProgress||afterWritePhases.has(lifecycle.phase)));
  const deletionReceipt=lifecycle?.evidence?.deletionStarted;
  const writeReceipt=Boolean(deletionReceipt&&deletionReceipt.operationId===operation.operationId
    &&deletionReceipt.phase==="deletionStarted"&&/^[0-9a-f-]{36}$/i.test(deletionReceipt.receiptId)
    &&Number.isFinite(deletionReceipt.completedAt));
  const deletionSelected=operation.selectedActions.deleteCalendar===true
    &&operation.selectedActions.deleteTodoist===true&&operation.target.deleteCalendar===true;
  const targets=Boolean(operation.target.taskId&&operation.target.eventId
    &&operation.actionPlan?.todoistTask?.id===operation.target.taskId
    &&operation.actionPlan?.calendarEvent?.id===operation.target.eventId
    &&operation.actionPlan?.calendarEvent?.calendarId);
  const aliasesComplete=completeAliasInventory(operation);
  const projectCommentsExact=exactProjectCommentInventory(operation);
  const checkpointComplete=deletionCheckpointComplete(operation);
  const tombstone=inspection.projectTombstone;
  const tombstonePresent=Boolean(tombstone?.status==="present"
    &&tombstone.recordedCommentFound===true&&tombstone.markerMatchesTaskAndCalendar===true
    &&tombstone.recordedCommentCount===(operation.actionPlan.projectCommentIds||[]).length
    &&tombstone.foundCommentCount===tombstone.recordedCommentCount);
  const knownReadback=inspection.knownTargetReadback;
  const knownTargetsAbsent=knownReadback?.todoist==="absent"&&knownReadback.calendar==="absent"
    &&knownReadback.configuredCalendarLink==="not_found";
  const unrelatedBlockers=inspection.blockers.filter(item=>item!==fullDeletionBlocker);
  const originalEnabled=new Set(lifecycle?.enabledMappingIds||[]);
  const mappingInventorySafe=Boolean(lifecycle&&inspection.mappingStates.length===lifecycle.mappingIds.length
    &&inspection.mappingStates.every(item=>lifecycle.mappingIds.includes(item.id)
      &&(item.originallyEnabled?["Enabled","Disabled"].includes(item.state):item.state==="Disabled")));
  const mappingsRestored=Boolean(lifecycle&&inspection.mappingStates.length===lifecycle.mappingIds.length
    &&inspection.mappingStates.every(item=>item.state===(originalEnabled.has(item.id)?"Enabled":"Disabled")));
  const candidate=inspection.classification==="fully_deleted"&&indicated&&writeReceipt
    &&deletionSelected&&targets&&aliasesComplete&&projectCommentsExact&&checkpointComplete
    &&tombstonePresent&&knownTargetsAbsent&&inspection.snapshotSafetyBlockerCount===0
    &&inspection.providerItemsAbsent&&inspection.stateRowsAbsent&&inspection.fenceOwned
    &&typeof inspection.epoch==="number"&&inspection.epoch>0&&inspection.leaseCount===0
    &&mappingInventorySafe&&unrelatedBlockers.length===0;
  const classification:PostWriteClassification=!indicated?"not_post_write":
    candidate?"fully_deleted_candidate":"partial_or_ambiguous";
  const completionBlockers:string[]=[];
  if(!indicated)completionBlockers.push("No durable provider-write boundary is recorded; use the separate pre-write recovery path.");
  if(indicated&&!writeReceipt)completionBlockers.push("The operation has no valid deletion-start receipt.");
  if(!deletionSelected)completionBlockers.push("The original operation did not select both Todoist and Calendar deletion.");
  if(!targets)completionBlockers.push("The immutable operation does not contain both exact provider targets.");
  if(!aliasesComplete)completionBlockers.push("The original Calendar alias inventory is incomplete or does not include the selected target.");
  if(!projectCommentsExact)completionBlockers.push("The original project-comment inventory is missing, duplicated or inconsistent.");
  if(!checkpointComplete)completionBlockers.push("Deletion checkpoints are incomplete or contain an uncertain write-ahead attempt; provider deletes will not be replayed.");
  if(!tombstonePresent)completionBlockers.push("The exact original project-comment tombstone is missing, ambiguous or expired.");
  if(!knownTargetsAbsent)completionBlockers.push("Exact readback does not prove the recorded Todoist task, Calendar event and configured Calendar link are absent.");
  if(inspection.snapshotSafetyBlockerCount!==0||!inspection.providerItemsAbsent||!inspection.stateRowsAbsent)
    completionBlockers.push("Attributable provider comments or DynamoDB state remain, or the exact identity scan is incomplete.");
  if(!inspection.fenceOwned)completionBlockers.push("The active profile fence is missing or is not owned by this operation.");
  if(typeof inspection.epoch!=="number"||inspection.epoch<1)completionBlockers.push("The monotonic profile epoch is missing or invalid.");
  if(inspection.leaseCount!==0)completionBlockers.push("A profile admission or writer lease is still active.");
  if(!mappingInventorySafe)completionBlockers.push("The original worker mapping inventory or state has changed.");
  completionBlockers.push(...unrelatedBlockers);
  const blockers=candidate?[]:[...new Set(completionBlockers)].sort();
  return {
    operationId:operation.operationId,profile:operation.profile,classification,releaseAllowed:false,
    onlyAvailableAction:candidate?"automatic_completion_pending":"keep_fenced",
    potentialDisposition:!indicated?"use_pre_write_recovery":candidate
      ?"automatic_known_identity_completion":"keep_fenced_and_escalate",
    completionEligible:candidate,completionBlockers:blockers,
    ...(candidate?{completion:{status:"pending" as const,automatic:true as const,
      tombstoneRetained:true as const,providerDeletesReplayed:false as const}}:{}),
    blockers,
    knownIdentity:{status:!indicated?"not_post_write":candidate
      ?"known_identity_deleted":"partial_or_ambiguous",
      scope:"recorded_original_targets_in_configured_profile",releaseAllowed:false},
    evidence:{
      originalProviderWriteIndicated:indicated,originalCalendarDeletionSelected:deletionSelected,
      exactTodoistAndCalendarTargetsRecorded:targets,matchingFence:inspection.fenceOwned,
      epochVerified:typeof inspection.epoch==="number"&&inspection.epoch>0,
      leasesDrained:inspection.leaseCount===0,providersAbsent:knownTargetsAbsent,
      stateRowsAbsent:inspection.stateRowsAbsent,mappingStateCount:inspection.mappingStates.length,
      workerMappingsRestored:mappingsRestored,deletionCheckpointComplete:checkpointComplete,
      projectTombstonePresent:tombstonePresent,knownCalendarAliasesComplete:aliasesComplete,
    },
  };
}
