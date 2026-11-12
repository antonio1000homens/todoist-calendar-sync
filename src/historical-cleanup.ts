import { profiles } from "./config.js";
import { createHash, randomUUID } from "node:crypto";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { cancelledOccurrenceMasterId, classifyDeletedRecurrenceLinks, deletedSeriesKeys,
  readExactRecurrenceLinks, verifyCancelledSeries, verifyCancelledSeriesInstances } from "./verified-deletion.js";
import { todoistCalendarLinkRemovalPatch, unlinkedCalendarEventDigest } from "./erasure-calendar-link.js";
import { DELETION_TOMBSTONE_COMMENT_MARKER, parseDeletionTombstoneComment, parseMappingComment, LEGACY_TASK_COMMENT_MARKERS,
  deleteExactTaskProjectMappingComments, type TodoistCommentRecord } from "./mapping-comments.js";
import type { ReviewEngine } from "./review-engine.js";
import type { ReviewStore } from "./review-store.js";
import type { ReviewCase } from "./review-types.js";
import type { CalendarEvent,Profile } from "./types.js";
import type { ErasureOperation } from "./erasure-executor.js";
import {erasureAdmissionFingerprint,makeHistoricalCleanupScope,scopeConflict,type ScopedAdmission,ScopedAdmissionBlockedError} from "./scoped-erasure-admission.js";
import {erasurePreviewFingerprint,validErasureActionPlan} from "./erasure-executor.js";
import {getErasureEpoch} from "./erasure-protocol.js";

export type HistoricalCleanupPhase = "checking_providers" | "clearing_todoist_comments"
  | "checking_calendar_links" | "cleaning_dynamodb" | "verified_complete";

/** Inventory matching markers as protected resources, even if their normal
 * retention window ends during this attempt. The scope never authorizes
 * writes to these comments. */
function retainedTombstones(comments: TodoistCommentRecord[], identity: {
  profile: Profile; projectId: string; taskIds: string[]; eventIds: string[];
}): Map<string, string> {
  const retained = new Map<string, string>();
  for (const comment of comments) {
    if (String(comment.content || "").split(/\r?\n/, 1)[0] !== DELETION_TOMBSTONE_COMMENT_MARKER) continue;
    const marker = parseDeletionTombstoneComment(comment);
    if (!marker || marker.projectId !== identity.projectId || marker.profile !== identity.profile
      || comment.project_id !== identity.projectId || comment.task_id || comment.is_deleted || !comment.id)
      throw new ScopedAdmissionBlockedError("erasure_tombstone_inventory_unverified");
    if (!identity.taskIds.includes(marker.taskId) && !marker.eventIds.some(id => identity.eventIds.includes(id))) continue;
    if (!identity.taskIds.includes(marker.taskId) || marker.eventIds.some(id => !identity.eventIds.includes(id))
      || retained.has(comment.id))
      throw new ScopedAdmissionBlockedError("protected_erasure_tombstone");
    retained.set(comment.id, comment.content!);
  }
  return retained;
}

export async function cleanVerifiedDeletedCase(input: {
  item: ReviewCase; store: ReviewStore; engine: ReviewEngine; idempotencyKey?:string;
  fencedErasure?:ErasureOperation;
  acquireScopedAdmission?:(input:{profile:Profile;fenceOperationId:string;epoch:number;
    scope:ReturnType<typeof makeHistoricalCleanupScope>})=>Promise<ScopedAdmission>;
  onPhase?: (phase: HistoricalCleanupPhase) => Promise<void> | void;
}): Promise<{ status: "complete" | "blocked"; phase: HistoricalCleanupPhase; blocker?: string; deletedComments?: number; unlinkedEvents?: number;cleanupStarted?:boolean }> {
  const { item, store, engine } = input;
  let phase: HistoricalCleanupPhase = "checking_providers";
  let deletedComments=0,unlinkedEvents=0;
  let terminal=false;
  let cleanupStarted=false;
  let scopedAdmission:ScopedAdmission|undefined;
  let scopedEpoch:number|undefined;
  const setPhase = async (value: HistoricalCleanupPhase) => { phase = value; await input.onPhase?.(value); };
  const block = (blocker: string) => ({ status: "blocked" as const, phase, blocker, deletedComments, unlinkedEvents,cleanupStarted });
  if(item.status==="resolved"&&item.result?.startsWith("resolved_deleted"))return {status:"complete" as const,phase:"verified_complete" as const,deletedComments:0,unlinkedEvents:0};
  if (item.status !== "open" && item.status !== "dismissed") return block("case_not_actionable");
  const decisionType=item.decision?.type;
  if(!["standalone_todoist_task_deleted","todoist_owned_recurrence_task_deleted","todoist_unmapped_conflict"].includes(decisionType||"")
    && !["todoist_unmapped_conflict","calendar_snapshot_recurring_identity_conflict"].includes(item.reason))
    return block("case_type_not_eligible_for_historical_cleanup");
  if (item.operationId || item.result?.startsWith("resolved_deleted")) return block("case_owned_or_already_resolved");
  const ids = reviewCaseEvidenceIds(item);
  if (!ids.taskIds.length || !ids.eventIds.length || ids.taskIds.length + ids.eventIds.length > 20)
    return block("exact_case_identity_incomplete_or_over_limit");
  const taskIds = ids.taskIds, eventIds = [...ids.eventIds];
  const fingerprint=createHash("sha256").update(JSON.stringify([item.profile,[...taskIds].sort(),[...eventIds].sort()])).digest("hex");
  const owner=randomUUID();
  const existing=await store.getHistoricalCleanupCheckpoint(item.id);
  deletedComments=Number(existing?.deletedComments)||0;
  unlinkedEvents=Number(existing?.unlinkedEvents)||0;
  if(existing?.fingerprint&&existing.fingerprint!==fingerprint)return block("historical_cleanup_identity_changed");
  if(existing?.status==="complete")return {status:"complete",phase:"verified_complete",deletedComments:Number(existing.deletedComments)||0,unlinkedEvents:Number(existing.unlinkedEvents)||0};
  const checkpoint=async(patch:Record<string,unknown>,release=false)=>{
    if(input.fencedErasure&&scopedAdmission)await scopedAdmission.assertActive();
    return store.saveHistoricalCleanupCheckpoint({caseId:item.id,profile:item.profile,fingerprint,owner,
      patch:{phase,...patch},release});
  };
  try {
    const pair = await engine.clients(item.profile);
    const recurring=item.decision?.type?.includes("recurrence_task_deleted")===true;
    const contextMaster=typeof item.decision?.context?.masterEventId==="string"?item.decision.context.masterEventId:undefined;
    const unmappedRecurring=!recurring&&(item.decision?.type==="todoist_unmapped_conflict"
      ||item.reason==="calendar_snapshot_recurring_identity_conflict")
      &&Boolean(item.decision?.masterEventId||contextMaster);
    const recordedMasterId=item.decision?.masterEventId||item.decision?.mappingSnapshot?.masterEventId
      ||(unmappedRecurring?contextMaster:undefined);
    const activeInstanceId=item.decision?.activeInstanceId||item.decision?.mappingSnapshot?.activeInstanceId
      ||(unmappedRecurring?item.decision?.eventId||item.eventId:undefined);
    const legacyMaster=recurring&&!recordedMasterId;
    let masterId=recordedMasterId;
    if((recurring||unmappedRecurring)&&(!activeInstanceId||!eventIds.includes(activeInstanceId)))
      return block("recurrence_identity_incomplete");
    if(legacyMaster){
      let occurrence:CalendarEvent;
      try{occurrence=await pair.calendar.getEvent(activeInstanceId!);}
      catch{return block("legacy_recurrence_master_unverifiable");}
      masterId=cancelledOccurrenceMasterId(activeInstanceId,occurrence);
      if(!masterId)return block("legacy_recurrence_master_not_verified");
      if(!eventIds.includes(masterId))eventIds.push(masterId);
      if(taskIds.length+eventIds.length>20)return block("recurrence_identity_inventory_over_limit");
    }
    const recurringIdentity=recurring||unmappedRecurring;
    if(recurringIdentity&&(!masterId||masterId===activeInstanceId))return block("recurrence_master_identity_ambiguous");
    for (const id of taskIds) {
      const snapshot = await engine.snapshot({ profile: item.profile, side: "todoist", id });
      if (snapshot.object) return block("todoist_task_still_exists");
      if(snapshot.control?.activeRepair)return block("active_repair_owns_todoist_identity");
      if(snapshot.control?.excluded===true)return block("todoist_identity_is_excluded");
    }
    const events = new Map<string, CalendarEvent | undefined>();
    for (const id of eventIds) {
      const snapshot=await engine.snapshot({profile:item.profile,side:"calendar",id});
      if(snapshot.control?.activeRepair)return block("active_repair_owns_calendar_identity");
      if(snapshot.control?.excluded===true)return block("calendar_identity_is_excluded");
      if(snapshot.object&&snapshot.object.id!==id)return block("calendar_identity_mismatch");
      events.set(id,snapshot.object as CalendarEvent|undefined);
    }
    let masterSeriesId:string|undefined,legacyMasterProof:{master:CalendarEvent;occurrence:CalendarEvent}|undefined;
    let legacyInstanceFingerprint:string|undefined;
    if(recurringIdentity){
      const relationship=verifyCancelledSeries(masterId,activeInstanceId,eventIds,events);
      if(!relationship.valid||!relationship.masterSeriesId)return block("recurrence_series_not_verified");
      masterSeriesId=relationship.masterSeriesId;
      if(legacyMaster)legacyMasterProof={master:events.get(masterId!)!,occurrence:events.get(activeInstanceId!)!};
      let instances:CalendarEvent[];
      try{instances=await pair.calendar.listEventInstances(masterId!);}
      catch{return block("complete_recurrence_instance_inventory_unavailable");}
      const checked=await verifyCancelledSeriesInstances({profile:item.profile,taskIds,masterId:masterId!,
        masterSeriesId,activeInstanceId:activeInstanceId!,instances,nowMs:Date.now()},
        id=>engine.state.getCompletedCalendarProjectionByEvent(item.profile,id));
      if(!checked.valid)return block(checked.reason||"recurrence_instance_inventory_unverified");
      legacyInstanceFingerprint=checked.fingerprint;
    }else for (const event of events.values()) if (event && event.status !== "cancelled"
      && (event.recurrence?.length || event.recurringEventId)) return block("calendar_recurrence_or_live_alias_requires_review");
    // Inventory exact mapping and owner indexes before either provider is
    // changed. The terminal transaction CASes these versions again.
    const staleMappingRows=await store.inventoryVerifiedDeletedMappings(item.profile,taskIds,eventIds);
    const seriesKeys=recurringIdentity?deletedSeriesKeys(taskIds,eventIds,masterSeriesId!,
      [item.decision?.seriesId,item.decision?.mappingSnapshot?.seriesId]):[...new Set([...taskIds,...eventIds])];
    if(seriesKeys.length>20)return block("recurrence_identity_inventory_over_limit");
    const links=await readExactRecurrenceLinks(seriesKeys,(profile,seriesId)=>engine.state.getRecurrenceLink(profile,seriesId));
    const classification=classifyDeletedRecurrenceLinks(item.profile,taskIds,eventIds,links,seriesKeys,
      recurring?{masterId:masterId!,activeInstanceId:activeInstanceId!,...(legacyMaster?{legacyMasterVerified:true}:{})}:undefined);
    if(classification.blocked.length)return block("recurrence_ownership_ambiguous");
    if(!recurringIdentity&&classification.stale.length)return block("recurrence_identity_requires_review");

    const projectId=profiles[item.profile].todoistProjectId;
    const initialComments=await pair.todoist.listProjectComments(projectId,true);
    const tombstoneIdentity = {profile:item.profile, projectId, taskIds, eventIds};
    const tombstones = retainedTombstones(initialComments, tombstoneIdentity);
    const verifyTombstones = (comments: TodoistCommentRecord[]): void => {
      const fresh = retainedTombstones(comments, tombstoneIdentity);
      if (fresh.size !== tombstones.size || [...tombstones].some(([id, content]) => fresh.get(id) !== content))
        throw new ScopedAdmissionBlockedError("erasure_tombstone_inventory_changed");
    };
    const readProjectComments = () => pair.todoist.listProjectComments(projectId, true);
    const candidates:Array<{comment:TodoistCommentRecord;eventId:string}>=[];
    for(const comment of initialComments){
      const parsed=parseMappingComment(comment);
      if(parsed&&!('error'in parsed)&&comment.project_id===projectId&&!comment.task_id
        &&parsed.payload.profile===item.profile&&parsed.payload.projectId===projectId
        &&taskIds.includes(parsed.payload.taskId)&&eventIds.includes(parsed.payload.eventId))
        candidates.push({comment,eventId:parsed.payload.eventId});
      else if(String(comment.content||"").startsWith("todoist-calendar-sync:mapping:v1\n")
        &&taskIds.some(id=>String(comment.content).includes(id)))return block("malformed_app_mapping_comment_identity_ambiguous");
    }
    const legacyCandidates:Array<{comment:TodoistCommentRecord;taskId:string;eventId:string}>=[];
    for(const taskId of taskIds)for(const eventId of eventIds){
      let comment:TodoistCommentRecord|undefined;
      try{comment=await pair.todoist.findLegacyTaskComment(taskId,eventId);}
      catch(error){if(![404,410].includes(Number((error as {status?:number}).status)))throw error;continue;}
      if(!comment)continue;
      const lines=String(comment.content||"").split(/\r?\n/);
      if(!LEGACY_TASK_COMMENT_MARKERS.has(lines[0])||comment.task_id&&comment.task_id!==taskId
        ||!lines.includes(`calendarEventId=${eventId}`))return block("legacy_task_comment_ownership_ambiguous");
      legacyCandidates.push({comment,taskId,eventId});
    }
    for(const event of events.values())if(event&&event.status!=="cancelled"){
      const shared=event.extendedProperties?.shared||{},taskId=shared.taskId;
      if(!taskId||!taskIds.includes(taskId)){
        if(taskId||Object.keys(shared).some(key=>key==="taskUrl"||key==="originalSummary"||key.startsWith("sync")||key.startsWith("todoist")))
          return block("calendar_link_provenance_ambiguous");
      }else if(event.recurrence?.length||event.recurringEventId||!event.etag)return block("calendar_recurrence_or_etag_ambiguous");
    }
    if ([...candidates, ...legacyCandidates].some(({comment}) => tombstones.has(comment.id)))
      return block("protected_erasure_tombstone");
    const retirement=await store.prepareHistoricalCaseRetirement(item,{
      profile:item.profile,taskIds,eventIds,staleMappingRows,staleLinks:classification.stale,seriesKeys,
      ...(recurringIdentity?{masterId,activeInstanceId,masterSeriesId,...(legacyMaster?{legacyMasterProof}:{})}:{}),
    });
    if(!retirement)return block(store.lastVerifiedDeletionBlocker||"dynamodb_preflight_blocked");
    const mappingSignature=(rows:typeof staleMappingRows)=>JSON.stringify(rows
      .map(row=>[row.pk,row.sk,row.profile,row.taskId,row.eventId,row.updatedAt])
      .sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
    const linkSignature=(values:typeof links)=>JSON.stringify(values.map(link=>[link.profile,link.owner,link.seriesId,
      link.taskId,link.eventId,link.masterEventId||"",link.activeInstanceId||"",link.updatedAt])
      .sort((a,b)=>String(a[2]).localeCompare(String(b[2]))));
    // Recurrence keys participate in isolation, including verified iCalUIDs.
    // Only exact event IDs are sent to the provider.
    const scopeEventIds = [...new Set([...eventIds, ...seriesKeys.filter(id => !taskIds.includes(id))])];
    let scopedIdentityFingerprint:string|undefined;
    const checkpointPk = `HISTORICAL_CLEANUP#${item.id}`;
    const identityRowsFingerprint=(rows:Array<{pk:string;sk:string;fingerprint:string}>)=>
      JSON.stringify(rows.filter(row=>row.pk!==checkpointPk||row.sk!=="OP").map(row=>[row.pk,row.sk,row.fingerprint]));
    const overlapsOtherErasure = (rows: Array<{pk:string;status?:unknown}>) =>
      rows.some(row=>row.pk.startsWith("ERASURE_OPERATION#")
        && row.pk!==`ERASURE_OPERATION#${input.fencedErasure?.operationId}`
        && !["previewed", "succeeded"].includes(String(row.status)));
    const stateBeforeExternalWrite=async(projectComment?:TodoistCommentRecord):Promise<string|undefined>=>{
      const projectComments = await readProjectComments();
      verifyTombstones(projectComments);
      if (projectComment && !projectComments.some(comment=>comment.id===projectComment.id
        && comment.content===projectComment.content && comment.project_id===projectId && !comment.task_id))
        return "todoist_mapping_comment_changed";
      const currentCase = await store.getCase(item.id);
      if (!currentCase || currentCase.updatedAt !== item.updatedAt || currentCase.status !== item.status || currentCase.operationId)
        return "case_status_revision_or_operation_changed";
      if(scopedIdentityFingerprint!==undefined){
        const freshInventory=await store.inventoryScopedIdentityRows(taskIds,scopeEventIds);
        if(!freshInventory.complete)return "incomplete_owner_inventory";
        if(overlapsOtherErasure(freshInventory.rows))return "shared_erasure_identity";
        if(freshInventory.rows.some(row=>row.pk.startsWith("SYNC_CONTROL#")&&row.activeRepair))return "active_repair_owns_identity";
        if(freshInventory.rows.some(row=>row.pk.startsWith("SYNC_CONTROL#")&&row.excluded===true))return "identity_is_excluded";
        if(identityRowsFingerprint(freshInventory.rows)!==scopedIdentityFingerprint)
          return "owner_inventory_changed_before_provider_write";
      }
      const freshMappings=await store.inventoryVerifiedDeletedMappings(item.profile,taskIds,eventIds);
      if(mappingSignature(freshMappings)!==mappingSignature(staleMappingRows))return "mapping_ownership_changed_before_provider_write";
      const freshLinks=await readExactRecurrenceLinks(seriesKeys,(profile,seriesId)=>engine.state.getRecurrenceLink(profile,seriesId));
      if(linkSignature(freshLinks)!==linkSignature(links))return "recurrence_ownership_changed_before_provider_write";
      for(const taskId of taskIds){
        const snapshot=await engine.snapshot({profile:item.profile,side:"todoist",id:taskId});
        if(snapshot.object)return "todoist_task_reappeared_before_provider_write";
        if(snapshot.control?.activeRepair)return "active_repair_owns_todoist_identity";
        if(snapshot.control?.excluded===true)return "todoist_identity_is_excluded";
      }
      for(const eventId of eventIds){
        const snapshot=await engine.snapshot({profile:item.profile,side:"calendar",id:eventId});
        if(snapshot.control?.activeRepair)return "active_repair_owns_calendar_identity";
        if(snapshot.control?.excluded===true)return "calendar_identity_is_excluded";
        const before=events.get(eventId),after=snapshot.object as CalendarEvent|null;
        if((!before&&after)||(before&&!after))return "calendar_identity_changed_before_provider_write";
        if(before&&after&&(before.id!==after.id||before.status!==after.status||before.etag!==after.etag))
          return "calendar_identity_changed_before_provider_write";
      }
      return undefined;
    };

    const identityScan = input.fencedErasure || tombstones.size
      ? await store.inventoryScopedIdentityRows(taskIds, scopeEventIds) : undefined;
    if(identityScan) {
      if (!identityScan.complete) return block("incomplete_owner_inventory");
      if (overlapsOtherErasure(identityScan.rows)) return block("shared_erasure_identity");
      if(identityScan.rows.some(row=>row.pk.startsWith("SYNC_CONTROL#")&&row.activeRepair))
        return block("active_repair_owns_identity");
      if(identityScan.rows.some(row=>row.pk.startsWith("SYNC_CONTROL#")&&row.excluded===true))
        return block("identity_is_excluded");
      // The selected case's manual decision is already validated and fenced
      // by the retirement plan. A pending decision from another case owns
      // its own review evidence and still blocks admission.
      const liveStatuses=new Set(["open","repairing","pending","queued","running","needs_review"]);
      if(identityScan.rows.some(row=>row.pk.startsWith("REPAIR#")&&liveStatuses.has(String(row.status))
        ||row.pk.startsWith("REPAIR_PREVIEW#")&&row.status==="issued"&&Number(row.expiresAt)>Date.now()))
        return block("writer_not_protocol_aware");
      if(identityScan.rows.some(row=>liveStatuses.has(String(row.status))
        && (row.pk.startsWith("REVIEW_CASE#")&&row.pk!==`REVIEW_CASE#${item.id}`
          ||row.pk.startsWith("MANUAL#")&&(row.pk!==`MANUAL#${item.id}`||row.sk!=="STATE"))))
        return block("shared_review_identity");
      scopedIdentityFingerprint = identityRowsFingerprint(identityScan.rows);
    }
    if(input.fencedErasure){
      const erasure=input.fencedErasure,plan=erasure.actionPlan;
      if(erasure.profile!==item.profile||erasure.status!=="review_required"
        ||erasure.previewFingerprint!==erasure.confirmationFingerprint
        ||erasurePreviewFingerprint(erasure)!==erasure.previewFingerprint
        ||!validErasureActionPlan(plan,erasure)
        ||!Array.isArray(plan?.projectCommentIds)||plan.projectCommentIds.length>100
        ||erasure.selectedActions.deleteTodoist&&plan.projectCommentIds.length===0
        ||(erasure.selectedActions.deleteCalendar&&plan.knownCalendarAliasesComplete!==true))
        return block("incomplete_owner_inventory");
      if(!identityScan)return block("incomplete_owner_inventory");
      const projectCommentIds=[...new Set([...candidates.map(value=>value.comment.id),
        ...legacyCandidates.map(value=>value.comment.id), ...tombstones.keys()])];
      const resources=[...identityScan.rows.map(row=>row.pk+"|"+row.sk),
        ...retirement.resourceKeys, `${checkpointPk}|OP`];
      const erasureResources:string[]=[];
      for(const entry of erasure.inventory){
        const keyValue=(entry as {key?:{pk?:unknown;sk?:unknown}})?.key;
        if(typeof keyValue?.pk!=="string"||typeof keyValue.sk!=="string")
          return block("incomplete_owner_inventory");
        erasureResources.push(keyValue.pk+"|"+keyValue.sk);
      }
      erasureResources.push("ERASURE_OPERATION#"+erasure.operationId+"|STATE",
        "ERASURE_CONFIRMATION#"+erasure.operationId+"|STATE",
        "ERASURE_RECOVERY_CONFIRMATION#"+erasure.operationId+"|STATE");
      const activeErasureComments=[...new Set([...plan.projectCommentIds,
        ...plan.comments.map(comment=>comment.id)])];
      const entities=[...taskIds.map(id=>item.profile+":todoist:"+id),
        ...scopeEventIds.map(id=>item.profile+":calendar:"+id)];
      const erasureEntities=[erasure.profile+":todoist:"+erasure.target.taskId,
        ...(erasure.target.eventId?[erasure.profile+":calendar:"+erasure.target.eventId]:[]),
        ...(plan.knownCalendarAliases||[]).map(alias=>alias.profile+":calendar:"+alias.eventId)];
      const scope=makeHistoricalCleanupScope({profile:item.profile,caseId:item.id,
        fenceFingerprint:erasureAdmissionFingerprint(erasure as unknown as Record<string,unknown>),entities,taskIds,eventIds:scopeEventIds,
        resourceKeys:resources,projectCommentIds,writeClasses:["todoist_project_comment_delete",
          "todoist_task_comment_delete","calendar_shared_link_patch","dynamodb_review_state_cleanup"]});
      const erasureScope={profile:erasure.profile,entities:erasureEntities,
        taskIds:[erasure.target.taskId],
        eventIds:[...(erasure.target.eventId?[erasure.target.eventId]:[]),
          ...(plan.knownCalendarAliases||[]).map(alias=>alias.eventId)],
        resourceKeys:erasureResources,projectCommentIds:activeErasureComments};
      if(activeErasureComments.some(id=>tombstones.has(id)))return block("protected_erasure_tombstone");
      const conflict=scopeConflict(scope,erasureScope as typeof scope);
      if(conflict)return block(conflict==="scoped_admission_overlap"?"shared_erasure_identity":conflict);
      const acquire=input.acquireScopedAdmission;
      if(!acquire||!Number.isSafeInteger(erasure.lifecycle?.evidence?.fenceInstalled?.completedAt))
        return block("writer_not_protocol_aware");
      scopedEpoch=await getErasureEpoch(item.profile);
      try{
        scopedAdmission=await acquire({profile:item.profile,fenceOperationId:erasure.operationId,epoch:scopedEpoch,scope});
        if (scopedAdmission.fingerprint !== scope.fingerprint) return block("incomplete_owner_inventory");
      }
      catch(error){return block(error instanceof ScopedAdmissionBlockedError?error.blocker:"scoped_admission_overlap");}
    }
    const beforeCleanup=await stateBeforeExternalWrite();
    if(beforeCleanup)return block(beforeCleanup);
    if(!await checkpoint({status:"running",idempotencyKey:input.idempotencyKey,
      startedAt:existing?.startedAt||new Date().toISOString()}))return block("historical_cleanup_in_progress");
    cleanupStarted=true;
    await setPhase("clearing_todoist_comments");
    await checkpoint({phase});
    try{
      for(const taskId of taskIds)deletedComments+=await deleteExactTaskProjectMappingComments(pair.todoist,initialComments,{
        profile:item.profile,projectId,taskId,eventIds,
        onBeforeDelete:async comment=>{
          const ownerBlocker=await stateBeforeExternalWrite(comment);
          if(ownerBlocker)throw new ScopedAdmissionBlockedError(ownerBlocker);
          if(!await checkpoint({pendingProviderWrite:{type:"todoist_project_comment_delete",id:comment.id}}))
            throw new Error("historical_cleanup_checkpoint_conflict");
        },
        onDeleted:async()=>{
          deletedComments++;
          if(!await checkpoint({deletedComments,pendingProviderWrite:null}))throw new Error("historical_cleanup_checkpoint_conflict");
        },
      });
    }catch(error){
      const message=error instanceof Error?error.message:"";
      if(message.includes("changed before task deletion cleanup"))return block("todoist_mapping_comment_changed");
      if(message.includes("remains after deletion"))return block("todoist_mapping_comment_delete_unverified");
      throw error;
    }
    // Legacy task comments are fetched by exact task/event pair. Only the
    // legacy marker plus exact event breadcrumb proves application ownership.
    for (const candidate of legacyCandidates) {
      const {taskId,eventId}=candidate;
      const current = await pair.todoist.getComment(candidate.comment.id);
      const fresh = String(current.content || "").split(/\r?\n/);
      if (current.id !== candidate.comment.id || current.task_id && current.task_id !== taskId
        || !LEGACY_TASK_COMMENT_MARKERS.has(fresh[0]) || !fresh.includes(`calendarEventId=${eventId}`))
        return block("legacy_task_comment_changed");
      const ownerBlocker=await stateBeforeExternalWrite();
      if(ownerBlocker)return block(ownerBlocker);
      if(!await checkpoint({pendingProviderWrite:{type:"todoist_legacy_comment_delete",id:current.id}}))return block("historical_cleanup_checkpoint_conflict");
      await pair.todoist.deleteComment(current.id);
      try { await pair.todoist.getComment(current.id); return block("legacy_task_comment_delete_unverified"); }
      catch (error) { if (![404, 410].includes(Number((error as { status?: number }).status))) throw error; deletedComments++; }
      if(!await checkpoint({deletedComments,pendingProviderWrite:null}))return block("historical_cleanup_checkpoint_conflict");
    }
    const remaining = await readProjectComments();
    verifyTombstones(remaining);
    if (remaining.some(comment => {
      const parsed = parseMappingComment(comment);
      return parsed&&!("error"in parsed)&&parsed.payload.profile===item.profile
        &&parsed.payload.projectId===projectId&&taskIds.includes(parsed.payload.taskId)
        &&eventIds.includes(parsed.payload.eventId)
        ||String(comment.content||"").startsWith("todoist-calendar-sync:mapping:v1\n")
          &&taskIds.some(id=>String(comment.content).includes(id));
    })) return block("todoist_mapping_comment_remains");
    for(const taskId of taskIds)for(const eventId of eventIds){
      let comment:TodoistCommentRecord|undefined;
      try{comment=await pair.todoist.findLegacyTaskComment(taskId,eventId);}
      catch(error){if(![404,410].includes(Number((error as {status?:number}).status)))throw error;}
      if(comment){
        const lines=String(comment.content||"").split(/\r?\n/);
        if(LEGACY_TASK_COMMENT_MARKERS.has(lines[0])&&(!comment.task_id||comment.task_id===taskId)
          &&lines.includes(`calendarEventId=${eventId}`))return block("legacy_task_comment_remains");
        return block("legacy_task_comment_ownership_ambiguous");
      }
    }

    await setPhase("checking_calendar_links");
    await checkpoint({phase});
    for (const [eventId, original] of events) {
      if (!original || original.status === "cancelled") continue;
      const taskId = original.extendedProperties?.shared?.taskId;
      if (!taskId || !taskIds.includes(taskId)) {
        if (taskId || Object.keys(original.extendedProperties?.shared||{}).some(key=>key==="taskUrl"||key==="originalSummary"||key.startsWith("sync")||key.startsWith("todoist")))
          return block("calendar_link_provenance_ambiguous");
        continue;
      }
      if (original.recurrence?.length || original.recurringEventId || !original.etag)
        return block("calendar_recurrence_or_etag_ambiguous");
      const patch = todoistCalendarLinkRemovalPatch(original, taskId);
      if (patch) {
        const ownerBlocker=await stateBeforeExternalWrite();
        if(ownerBlocker)return block(ownerBlocker);
        const digest = unlinkedCalendarEventDigest(original, taskId);
        if(!await checkpoint({pendingProviderWrite:{type:"calendar_shared_link_patch",eventId,etag:original.etag,digest}}))return block("historical_cleanup_checkpoint_conflict");
        await pair.calendar.updateSharedEventPropertiesIfUnchanged(eventId, original.etag, patch);
        const after = await pair.calendar.getEvent(eventId);
        if (after.status === "cancelled" || after.extendedProperties?.shared?.taskId === taskId
          || unlinkedCalendarEventDigest(after, taskId) !== digest) return block("calendar_link_removal_unverified");
        events.set(eventId,after);
        unlinkedEvents++;
        if(!await checkpoint({unlinkedEvents,pendingProviderWrite:null}))return block("historical_cleanup_checkpoint_conflict");
      }
    }
    await setPhase("cleaning_dynamodb");
    await checkpoint({phase});
    // Re-read every provider identity after provider edits and the ownership
    // inventory. A task revival or changed Calendar identity keeps the case open.
    for(const id of taskIds)if((await engine.snapshot({profile:item.profile,side:"todoist",id})).object)
      return block("todoist_task_reappeared_before_terminal_cleanup");
    for(const id of eventIds){
      const latest=await engine.snapshot({profile:item.profile,side:"calendar",id});
      const previous=events.get(id);
      const latestEvent=latest.object as CalendarEvent|null;
      if(latestEvent&&previous&&latestEvent.id!==previous.id)return block("calendar_identity_changed_before_terminal_cleanup");
      const latestShared=latestEvent?.extendedProperties?.shared||{};
      if(latestEvent&&latestEvent.status!=="cancelled"
        &&(taskIds.includes(latestShared.taskId)||Object.keys(latestShared).some(key=>key==="taskUrl"
          ||key==="originalSummary"||key.startsWith("sync")||key.startsWith("todoist"))))
        return block("calendar_link_reappeared_before_terminal_cleanup");
    }
    if(recurringIdentity){
      const relationship=verifyCancelledSeries(masterId,activeInstanceId,eventIds,events);
      if(!relationship.valid||relationship.masterSeriesId!==masterSeriesId)return block("recurrence_series_changed_before_terminal_cleanup");
      let instances:CalendarEvent[];
      try{instances=await pair.calendar.listEventInstances(masterId!);}catch{return block("complete_recurrence_instance_inventory_unavailable");}
      const checked=await verifyCancelledSeriesInstances({profile:item.profile,taskIds,masterId:masterId!,
        masterSeriesId:masterSeriesId!,activeInstanceId:activeInstanceId!,instances,nowMs:Date.now()},
        id=>engine.state.getCompletedCalendarProjectionByEvent(item.profile,id));
      if(!checked.valid||checked.fingerprint!==legacyInstanceFingerprint)return block("recurrence_instance_inventory_changed_before_terminal_cleanup");
    }
    if(scopedIdentityFingerprint!==undefined){
      const finalInventory=await store.inventoryScopedIdentityRows(taskIds,scopeEventIds);
      if(!finalInventory.complete)return block("incomplete_owner_inventory");
      if(overlapsOtherErasure(finalInventory.rows))return block("shared_erasure_identity");
      if(identityRowsFingerprint(finalInventory.rows)!==scopedIdentityFingerprint)
        return block("owner_inventory_changed_before_terminal_cleanup");
      if(finalInventory.rows.some(row=>row.pk.startsWith("SYNC_CONTROL#")&&row.activeRepair))
        return block("active_repair_owns_identity");
      if(finalInventory.rows.some(row=>row.pk.startsWith("SYNC_CONTROL#")&&row.excluded===true))
        return block("identity_is_excluded");
    }
    const closed = await retirement.commit(async () => {
      verifyTombstones(await readProjectComments());
      if (!await checkpoint({phase})) throw new ScopedAdmissionBlockedError("historical_cleanup_checkpoint_conflict");
      const authorization = {checkpoint:{fingerprint,owner}};
      if (!scopedAdmission || !input.fencedErasure || scopedEpoch===undefined) return authorization;
      return {...authorization, scope:{owner:scopedAdmission.owner,version:await scopedAdmission.assertActive(),
        operationId:input.fencedErasure.operationId,epoch:scopedEpoch}};
    });
    if (!closed) return block(store.lastVerifiedDeletionBlocker || "dynamodb_case_cleanup_blocked");
    const terminalCase=await store.getCase(item.id);
    const terminalIds=terminalCase?reviewCaseEvidenceIds(terminalCase):undefined;
    if(!terminalCase||terminalCase.profile!==item.profile||terminalCase.status!=="resolved"
      ||!terminalCase.result?.startsWith("resolved_deleted")||terminalCase.operationId
      ||terminalIds?.taskIds.length||terminalIds?.eventIds.length)return block("terminal_case_postflight_unverified");
    if((await store.inventoryVerifiedDeletedMappings(item.profile,taskIds,eventIds)).length)
      return block("stale_mapping_postflight_remaining");
    for(const seriesId of seriesKeys)if(await engine.state.getRecurrenceLink(item.profile,seriesId))
      return block("recurrence_link_postflight_remaining");
    terminal=true;
    await checkpoint({status:"complete",deletedComments,unlinkedEvents,completedAt:new Date().toISOString(),pendingProviderWrite:null},true);
    await setPhase("verified_complete");
    return { status: "complete", phase, deletedComments, unlinkedEvents,cleanupStarted:true };
  } catch (error) {
    const status = Number((error as { status?: number }).status);
    return block(error instanceof ScopedAdmissionBlockedError?error.blocker:status === 401 || status === 403 ? "provider_auth_failed"
      : status === 429 ? "provider_rate_limited" : status >= 500 ? "provider_unavailable"
      : error instanceof Error ? error.message.slice(0, 180) : "provider_check_failed");
  } finally {
    try {
      if(!terminal&&cleanupStarted){
        const latest=await store.getHistoricalCleanupCheckpoint(item.id);
        if(latest?.status!=="complete")await checkpoint({status:"retryable"},true);
      }
    } finally {
      await scopedAdmission?.release();
    }
  }
}
