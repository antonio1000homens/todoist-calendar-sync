import { DeleteCommand, GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildProjectMappingIndex, LEGACY_TASK_COMMENT_MARKERS, parseDeletionTombstoneComment,
  writeProjectDeletionTombstone } from "./mapping-comments.js";
import { profiles } from "./config.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { buildErasurePreview } from "./erasure-preview.js";
import { ErasureGateDriftError, type ErasureActionPlan, type ErasureOperation } from "./erasure-executor.js";
import { fingerprint } from "../scripts/item-purge-policy.mjs";
import { calendarEventGoneOnDirectRead } from "./sync.js";
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
      // Todoist may have accepted the tombstone update even if DynamoDB did
      // not persist this step's progress checkpoint. On redelivery, accept
      // only the same exact comment with the same confirmed identity/aliases;
      // all other content drift remains a hard stop.
      if(item.kind==="project"&&parseDeletionTombstoneComment(comment)) {
        const eventIds=(plan.knownCalendarAliases||[]).map(alias=>alias.eventId);
        await writeProjectDeletionTombstone(clients.todoist,{commentId:item.id,profile:operation.profile,
          projectId:profiles[operation.profile].todoistProjectId,taskId:operation.target.taskId,eventIds});
        return {progress:{...progress,commentIndex:progress.commentIndex+1},complete:false};
      }
      if(fingerprint(comment.content)!==item.digest) throw new ErasureGateDriftError();
      if(item.kind==="task") {
        validateComment(item.kind,comment.content,operation);
        await clients.todoist.deleteComment(item.id);
        try {
          const remaining=await clients.todoist.getComment(item.id);
          if(remaining.id!==item.id) throw new ErasureGateDriftError();
          throw new Error("Todoist mapping comment remains after delete readback");
        } catch(error) { if(!commentGone(error)) throw error; }
      } else {
        const eventIds=(plan.knownCalendarAliases||[]).map(alias=>alias.eventId);
        await writeProjectDeletionTombstone(clients.todoist,{commentId:item.id,profile:operation.profile,
          projectId:profiles[operation.profile].todoistProjectId,taskId:operation.target.taskId,eventIds});
      }
    } catch(error) {
      if(item.kind==="project"||!commentGone(error)) throw error;
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
    }
    return {progress:{...progress,stage:"state"},complete:false};
  }
  if(progress.stage==="state") {
    const ordered=[...operation.inventory].sort((a,b)=>Number(a.type==="SYNC_CONTROL")-Number(b.type==="SYNC_CONTROL")
      ||a.key.pk.localeCompare(b.key.pk)||a.key.sk.localeCompare(b.key.sk));
    const record=ordered[progress.stateIndex];
    if(!record) return {progress:{...progress,stage:"finalize_comments",finalCommentIndex:0},complete:false};
    const response=await db.send(new GetCommand({TableName:tableName(),Key:record.key,ConsistentRead:true}));
    const existing=response.Item as Record<string,unknown>|undefined;
    if(existing) {
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
  if(progress.stage==="finalize_comments") {
    // The project mapping comment is a temporary recovery guard ONLY while
    // the confirmed deletion is fenced. Successful sync must retain no
    // project comment containing the deleted task's identity.
    const commentIds=plan.projectCommentIds||[];
    const index=progress.finalCommentIndex??0;
    if(!commentIds.length||index>commentIds.length)throw new ErasureGateDriftError();
    const id=commentIds[index];
    if(!id)return {progress:{...progress,stage:"verify"},complete:false};
    let comment:Awaited<ReturnType<typeof clients.todoist.getComment>>|undefined;
    try { comment=await clients.todoist.getComment(id); }
    catch(error) { if(!commentGone(error))throw error; }
    if(comment) {
      const marker=parseDeletionTombstoneComment(comment);
      const aliases=(plan.knownCalendarAliases||[]).map(alias=>alias.eventId);
      if(comment.id!==id||comment.project_id!==profiles[operation.profile].todoistProjectId||comment.task_id
        ||!marker||marker.profile!==operation.profile
        ||marker.projectId!==profiles[operation.profile].todoistProjectId
        ||marker.taskId!==operation.target.taskId
        ||aliases.some(alias=>!marker.eventIds.includes(alias)))
        throw new ErasureGateDriftError();
      await clients.todoist.deleteComment(id);
      try {
        const remaining=await clients.todoist.getComment(id);
        if(remaining.id!==id)throw new ErasureGateDriftError();
        throw new Error("Deleted task's project mapping comment remains after cleanup");
      } catch(error) { if(!commentGone(error))throw error; }
    }
    return {progress:{...progress,finalCommentIndex:index+1},complete:false};
  }
  return {progress,complete:true};
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
  const requiredAliases=(operation.actionPlan.knownCalendarAliases||[]).map(alias=>alias.eventId);
  const requiredComments=operation.actionPlan.projectCommentIds||[];
  const remainingMapping=buildProjectMappingIndex(projectComments).parsed.some(({payload})=>
    payload.profile===operation.profile&&(payload.taskId===operation.target.taskId
      ||requiredAliases.includes(payload.eventId)));
  const remainingMarker=projectComments.some(comment=>{
    const marker=parseDeletionTombstoneComment(comment);
    return marker?.profile===operation.profile&&marker.projectId===projectId
      &&(marker.taskId===operation.target.taskId
        ||requiredAliases.some(alias=>marker.eventIds.includes(alias)));
  });
  // The original exact project comments must be physically absent. An
  // expired marker is still deleted-task identity and fails this check.
  const removedOriginalComments=requiredComments.length>0
    &&requiredComments.every(id=>!projectComments.some(comment=>comment.id===id));
  const providersAbsent=preview.blockers.length===0
    &&!preview.actionPlan.todoistTask&&!preview.actionPlan.calendarEvent&&preview.actionPlan.comments.length===0
    &&removedOriginalComments&&!remainingMapping&&!remainingMarker;
  return {providersAbsent,stateAbsent:preview.inventory.length===0};
}

export async function createErasureDeletionProgress(now=Date.now()):Promise<ErasureDeletionProgress> {
  return {stage:"comments",commentIndex:0,stateIndex:0,startedAt:now};
}
