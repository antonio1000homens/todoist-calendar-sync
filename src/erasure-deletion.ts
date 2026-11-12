import { DeleteCommand, GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildProjectMappingIndex, LEGACY_TASK_COMMENT_MARKERS, parseDeletionTombstoneComment,
  type TodoistCommentRecord } from "./mapping-comments.js";
import { profiles } from "./config.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { buildErasurePreview } from "./erasure-preview.js";
import { ErasureGateDriftError, type ErasureActionPlan, type ErasureOperation } from "./erasure-executor.js";
import { fingerprint } from "../scripts/item-purge-policy.mjs";
import { calendarEventGoneOnDirectRead } from "./sync.js";
import {todoistCalendarLinkRemovalPatch,unlinkedCalendarEventDigest} from "./erasure-calendar-link.js";
import type { Profile } from "./types.js";

export type ErasureDeletionProgress = {
  stage: "comments" | "todoist" | "calendar" | "state" | "finalize_comments" | "verify";
  /** Index through exact project comments to remove after provider and state deletion. */
  finalCommentIndex?: number;
  commentIndex: number;
  stateIndex: number;
  startedAt: number;
  attempt?: { id: string; startedAt: number };
};

type Dependencies = {
  db: Pick<DynamoDBDocumentClient, "send">;
  clients: Awaited<ReturnType<typeof defaultProviderClientFactory>>;
  inspectFence: (profile: Profile) => Promise<{ fence?: { operationId?: string }; leases: Record<string,unknown>[] }>;
};

function tableName(): string {
  const value=process.env.STATE_TABLE_NAME?.trim();
  if(!value) throw new Error("STATE_TABLE_NAME is required");
  return value;
}
const todoistGone=(error: unknown)=>Number((error as {status?:number})?.status)===404;
const commentGone=todoistGone;

function validateComment(kind: "project"|"task", content: string, operation: ErasureOperation): void {
  const {target,profile}=operation;
  if(kind==="project") {
    const index=buildProjectMappingIndex([{id:"candidate",content,project_id:profiles[profile].todoistProjectId}]);
    const item=index.parsed.find(value=>value.comment.id==="candidate");
    if(!item || item.payload.profile!==profile || item.payload.projectId!==profiles[profile].todoistProjectId
      || item.payload.taskId!==target.taskId || item.payload.eventId!==target.eventId || item.payload.seriesId)
      throw new ErasureGateDriftError();
  } else {
    const lines=String(content||"").split(/\r?\n/);
    const eventId=lines.find(line=>line.startsWith("calendarEventId="))?.slice("calendarEventId=".length);
    if(!LEGACY_TASK_COMMENT_MARKERS.has(lines[0]) || !target.eventId || eventId!==target.eventId)
      throw new ErasureGateDriftError();
  }
}

/** Receipt scrubbing must remain under the operation-owned exclusive fence.
 * Project comments are deleted immediately; a retained identity marker is not required. */
async function verifyFenceBeforeReceiptScrub(operation:ErasureOperation,
  inspectFence:Dependencies["inspectFence"]):Promise<void> {
  if(operation.actionPlan.scrubCompletedDeliveryIdentityRefsAfterTombstone!==true)
    throw new ErasureGateDriftError();
  const protocol=await inspectFence(operation.profile);
  if(protocol.fence?.operationId!==operation.operationId||protocol.leases.length)
    throw new ErasureGateDriftError();
}

function exactDeleteCondition(item: Record<string, unknown>): {ConditionExpression:string;ExpressionAttributeNames:Record<string,string>;ExpressionAttributeValues:Record<string,unknown>} {
  const names:Record<string,string>={"#pk":"pk","#sk":"sk"};
  const values:Record<string,unknown>={};
  const terms=["attribute_exists(#pk)","#pk = :keyPk","#sk = :keySk"];
  values[":keyPk"]=item.pk; values[":keySk"]=item.sk;
  for(const [name,value] of Object.entries(item)) {
    if(name==="pk"||name==="sk") continue;
    const index=Object.keys(names).length;
    const attr=`#a${index}`, val=`:v${index}`;
    names[attr]=name; values[val]=value;
    terms.push(`${attr} = ${val}`);
  }
  const ConditionExpression=terms.join(" AND ");
  if(ConditionExpression.length>3500 || Object.keys(values).length>100)
    throw new Error("Exact conditional deletion is too large for a DynamoDB condition; operation remains fenced for manual review");
  return {ConditionExpression,ExpressionAttributeNames:names,ExpressionAttributeValues:values};
}

/** Execute one idempotent, operation-bound deletion step. Inputs come only from the confirmed durable operation. */
export async function executeErasureDeletionStep(operation: ErasureOperation, current: ErasureDeletionProgress,
  dependencies: Dependencies): Promise<{progress:ErasureDeletionProgress;complete:boolean}> {
  const {db,clients}=dependencies;
  const progress={...current};
  // A successful step result advances the checkpoint and clears the durable
  // write-ahead attempt claim. If the function throws, the caller retains the
  // old claimed checkpoint and cannot repeat the provider mutation.
  delete progress.attempt;
  const plan:ErasureActionPlan=operation.actionPlan;
  if(progress.stage==="comments") {
    const item=plan.comments[progress.commentIndex];
    if(!item) return {progress:{...progress,stage:"todoist"},complete:false};
    try {
      const comment=await clients.todoist.getComment(item.id);
      if(comment.id!==item.id||typeof comment.content!=="string") throw new ErasureGateDriftError();
      const marker=item.kind==="project"?parseDeletionTombstoneComment(comment):undefined;
      if(marker) {
        // Resume an older, already-fenced operation without retaining its
        // previously written tombstone. Never delete an unrelated marker.
        const aliases=[...new Set((plan.knownCalendarAliases||[]).map(alias=>alias.eventId))].sort();
        if(comment.project_id!==profiles[operation.profile].todoistProjectId||comment.task_id
          ||marker.profile!==operation.profile||marker.projectId!==comment.project_id
          ||marker.taskId!==operation.target.taskId
          ||JSON.stringify([...new Set(marker.eventIds)].sort())!==JSON.stringify(aliases))
          throw new ErasureGateDriftError();
      } else {
        if(fingerprint(comment.content)!==item.digest) throw new ErasureGateDriftError();
        validateComment(item.kind,comment.content,operation);
      }
      // No retained comment or 18-day tombstone: the profile fence supplies
      // in-flight isolation. A 404 on a retry means this exact ID is gone.
      await clients.todoist.deleteComment(item.id);
    } catch(error) {
      if(!commentGone(error)) throw error;
    }
    return {progress:{...progress,commentIndex:progress.commentIndex+1},complete:false};
  }
  if(progress.stage==="todoist") {
    if(plan.todoistTask) {
      let task:any;
      try { task=await clients.todoist.getTask(operation.target.taskId); }
      catch(error) { if(!todoistGone(error)) throw error; }
      if(task) {
        if(task.id!==operation.target.taskId || task.project_id!==profiles[operation.profile].todoistProjectId
          || fingerprint(task)!==plan.todoistTask.digest) throw new ErasureGateDriftError();
        await clients.todoist.deleteTask(operation.target.taskId);
        try {
          const remaining=await clients.todoist.getTask(operation.target.taskId);
          if(remaining.id!==operation.target.taskId) throw new ErasureGateDriftError();
          throw new Error("Todoist task remains after delete readback");
        } catch(error) { if(!todoistGone(error)) throw error; }
      }
    }
    return {progress:{...progress,stage:"calendar"},complete:false};
  }
  if(progress.stage==="calendar") {
    if(operation.selectedActions.deleteCalendar && plan.calendarEvent) {
      let event:any;
      try { event=await clients.calendar.getEvent(operation.target.eventId!); }
      catch(error) { if(!calendarEventGoneOnDirectRead(error)) throw error; }
      if(event && event.status!=="cancelled") {
        if(!plan.calendarEvent || event.id!==operation.target.eventId || event.etag!==plan.calendarEvent.etag
          || fingerprint(event)!==plan.calendarEvent.digest) throw new ErasureGateDriftError();
        await clients.calendar.deleteEvent(operation.target.eventId!,plan.calendarEvent.etag);
      } else if(event && event.id!==operation.target.eventId) throw new ErasureGateDriftError();
      try {
        const remaining=await clients.calendar.getEvent(operation.target.eventId!);
        if(remaining.id!==operation.target.eventId || remaining.status!=="cancelled")
          throw new Error("Calendar event remains live after delete readback");
      } catch(error) { if(!calendarEventGoneOnDirectRead(error)) throw error; }
    } else if(plan.calendarEvent?.unlinkTodoistTask===operation.target.taskId) {
      const approved=plan.calendarEvent;
      let event:any;
      try {event=await clients.calendar.getEvent(operation.target.eventId!);}
      catch {throw new ErasureGateDriftError();}
      if(!event||event.id!==operation.target.eventId||event.status==="cancelled")
        throw new ErasureGateDriftError();
      const afterDigest=unlinkedCalendarEventDigest(event,operation.target.taskId);
      if(event.extendedProperties?.shared?.taskId===operation.target.taskId) {
        if(event.etag!==approved.etag||fingerprint(event)!==approved.digest)
          throw new ErasureGateDriftError();
        const patch=todoistCalendarLinkRemovalPatch(event,operation.target.taskId);
        if(!patch)throw new ErasureGateDriftError();
        await clients.calendar.updateSharedEventPropertiesIfUnchanged(event.id,event.etag,patch);
      } else if(afterDigest!==approved.unlinkDigest) {
        throw new ErasureGateDriftError();
      }
      const readback=await clients.calendar.getEvent(operation.target.eventId!);
      if(!readback||readback.id!==operation.target.eventId||readback.status==="cancelled"
        ||readback.extendedProperties?.shared?.taskId===operation.target.taskId
        ||unlinkedCalendarEventDigest(readback,operation.target.taskId)!==approved.unlinkDigest)
        throw new ErasureGateDriftError();
    }
    return {progress:{...progress,stage:"state"},complete:false};
  }
  if(progress.stage==="state") {
    const ordered=[...operation.inventory].sort((a,b)=>Number(a.type==="SYNC_CONTROL")-Number(b.type==="SYNC_CONTROL")
      ||a.key.pk.localeCompare(b.key.pk)||a.key.sk.localeCompare(b.key.sk));
    const record=ordered[progress.stateIndex];
    if(!record) return {progress:{...progress,stage:"verify"},complete:false};
    if(record.type==="DELIVERY") {
      if(record.key.sk!=="COMPLETED"||record.receiptCleanup!=="scrub_identity_refs"
        ||!/^[a-f0-9]{64}$/.test(record.scrubbedDigest||""))
        throw new ErasureGateDriftError();
      await verifyFenceBeforeReceiptScrub(operation,dependencies.inspectFence);
    }
    const response=await db.send(new GetCommand({TableName:tableName(),Key:record.key,ConsistentRead:true}));
    const existing=response.Item as Record<string,unknown>|undefined;
    if(existing) {
      if(record.type==="DELIVERY") {
        if(fingerprint(existing)===record.scrubbedDigest)
          return {progress:{...progress,stateIndex:progress.stateIndex+1},complete:false};
        if(fingerprint(existing)!==record.digest)throw new ErasureGateDriftError();
        const refs=existing.identityRefs as Record<string,unknown>|undefined;
        if(!Array.isArray(refs?.taskIds)||!Array.isArray(refs?.eventIds))throw new ErasureGateDriftError();
        if(operation.actionPlan.knownCalendarAliasesComplete!==true
          ||!Array.isArray(operation.actionPlan.knownCalendarAliases))throw new ErasureGateDriftError();
        const knownEventIds=new Set(operation.actionPlan.knownCalendarAliases
          .filter(alias=>alias.profile===operation.profile&&alias.calendarId===profiles[operation.profile].calendarId)
          .map(alias=>alias.eventId));
        const scrubbed={...existing,identityRefs:{...refs,
          taskIds:refs.taskIds.filter(id=>id!==operation.target.taskId),
          eventIds:refs.eventIds.filter(id=>id!==operation.target.eventId&&!knownEventIds.has(String(id)))}};
        if(fingerprint(scrubbed)!==record.scrubbedDigest)throw new ErasureGateDriftError();
        const names={"#profile":"profile","#kind":"kind","#refs":"identityRefs","#tasks":"taskIds","#events":"eventIds"};
        const values:Record<string,unknown>={":profile":existing.profile,":kind":existing.kind,
          ":completedAt":existing.completedAt,":expiresAt":existing.expiresAt,
          ":taskCount":refs.taskIds.length,":eventCount":refs.eventIds.length,
          ":tasks":scrubbed.identityRefs.taskIds,":events":scrubbed.identityRefs.eventIds};
        const conditions=["#profile=:profile","#kind=:kind","completedAt=:completedAt","expiresAt=:expiresAt",
          "size(#refs.#tasks)=:taskCount","size(#refs.#events)=:eventCount"];
        // The size checks plus membership checks for every old list member
        // prevent overwriting a concurrently changed receipt with the plan's
        // stale retained values.
        for(const [index,id] of (refs.taskIds as unknown[]).entries()) {
          if(typeof id!=="string")throw new ErasureGateDriftError();
          const token=":expectedTask"+index;
          conditions.push("contains(#refs.#tasks,"+token+")");values[token]=id;
        }
        for(const [index,id] of (refs.eventIds as unknown[]).entries()) {
          if(typeof id!=="string")throw new ErasureGateDriftError();
          const token=":expectedEvent"+index;
          conditions.push("contains(#refs.#events,"+token+")");values[token]=id;
        }
        try {
          await db.send(new UpdateCommand({TableName:tableName(),Key:record.key,
            UpdateExpression:"SET #refs.#tasks=:tasks, #refs.#events=:events",
            ConditionExpression:conditions.join(" AND "),ExpressionAttributeNames:names,ExpressionAttributeValues:values}));
        } catch(error) {
          const after=await db.send(new GetCommand({TableName:tableName(),Key:record.key,ConsistentRead:true}));
          if(after.Item&&fingerprint(after.Item)===record.scrubbedDigest)
            return {progress:{...progress,stateIndex:progress.stateIndex+1},complete:false};
          throw error;
        }
        return {progress:{...progress,stateIndex:progress.stateIndex+1},complete:false};
      }
      if(fingerprint(existing)!==record.digest) throw new ErasureGateDriftError();
      try {
        await db.send(new DeleteCommand({TableName:tableName(),Key:record.key,...exactDeleteCondition(existing)}));
      } catch(error) {
        const after=await db.send(new GetCommand({TableName:tableName(),Key:record.key,ConsistentRead:true}));
        if(after.Item) throw error;
      }
    }
    return {progress:{...progress,stateIndex:progress.stateIndex+1},complete:false};
  }
  if((progress.stage as string)==="finalize_comments") {
    // Legacy saved checkpoints only: retire exact project tombstones instead
    // of carrying them to expiry. New operations delete comments up front.
    const commentIds=plan.projectCommentIds||[];
    const index=progress.finalCommentIndex??0;
    if(index>commentIds.length)throw new ErasureGateDriftError();
    const id=commentIds[index];
    if(!id)return {progress:{...progress,stage:"verify"},complete:false};
    let comment:TodoistCommentRecord|undefined;
    try {comment=await clients.todoist.getComment(id);}
    catch(error) {if(!commentGone(error))throw error;}
    if(comment) {
      const marker=parseDeletionTombstoneComment(comment);
      const aliases=[...new Set((plan.knownCalendarAliases||[]).map(alias=>alias.eventId))].sort();
      if(comment.id!==id||comment.project_id!==profiles[operation.profile].todoistProjectId||comment.task_id
        ||!marker||marker.profile!==operation.profile||marker.projectId!==comment.project_id
        ||marker.taskId!==operation.target.taskId
        ||JSON.stringify([...new Set(marker.eventIds)].sort())!==JSON.stringify(aliases))
        throw new ErasureGateDriftError();
      await clients.todoist.deleteComment(id);
    }
    return {progress:{...progress,finalCommentIndex:index+1},complete:false};
  }
  return {progress,complete:true};
}

/** Successful erasure cannot retain an app-owned project mapping comment
 * referring to the deleted task or any recorded Calendar alias. */
export function erasureProjectCommentsAbsent(operation:ErasureOperation,
  projectComments:TodoistCommentRecord[]):boolean {
  const originalIds=operation.actionPlan.projectCommentIds||[];
  if(!originalIds.length)return false;
  const aliases=new Set([operation.target.eventId,...(operation.actionPlan.knownCalendarAliases||[])
    .map(alias=>alias.eventId)].filter((id):id is string=>Boolean(id)));
  const index=buildProjectMappingIndex(projectComments);
  return !projectComments.some(comment=>originalIds.includes(comment.id))
    &&!index.parsed.some(({payload})=>payload.taskId===operation.target.taskId
      ||aliases.has(payload.eventId))
    &&!index.malformed.some(({comment})=>Boolean(comment.content?.includes(operation.target.taskId)
      ||[...aliases].some(alias=>comment.content?.includes(alias))))
    &&!projectComments.some(comment=>{
      const marker=parseDeletionTombstoneComment(comment);
      return Boolean(marker&&(marker.taskId===operation.target.taskId
        ||marker.eventIds.some(alias=>aliases.has(alias))));
    });
}

/** Action-time readback is deliberately a full exact inventory pass and must prove no attributable data remains. */
export async function verifyErasurePostflight(operation:ErasureOperation,dependencies:Dependencies):Promise<{providersAbsent:boolean;stateAbsent:boolean}> {
  const preview=await buildErasurePreview({profile:operation.profile,taskId:operation.target.taskId,
    ...(operation.target.eventId?{eventId:operation.target.eventId}:{}),deleteCalendar:operation.selectedActions.deleteCalendar},
    {db:dependencies.db,clients:dependencies.clients,inspectFence:async()=>dependencies.inspectFence(operation.profile),
      newOperationId:()=>operation.operationId,ignoreOperationId:operation.operationId,
      allowFenceOperationId:operation.operationId,allowJournalOperationId:operation.operationId});
  const projectId=profiles[operation.profile].todoistProjectId;
  const projectComments=await dependencies.clients.todoist.listProjectComments(projectId,true);
  const providersAbsent=preview.blockers.length===0
    &&!preview.actionPlan.todoistTask&&!preview.actionPlan.calendarEvent&&preview.actionPlan.comments.length===0
    &&erasureProjectCommentsAbsent(operation,projectComments);
  return {providersAbsent,stateAbsent:preview.inventory.length===0};
}

export async function createErasureDeletionProgress(now=Date.now()):Promise<ErasureDeletionProgress> {
  return {stage:"comments",commentIndex:0,stateIndex:0,startedAt:now};
}
