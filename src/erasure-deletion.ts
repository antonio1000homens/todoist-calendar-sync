import { DeleteCommand, GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
  stage: "comments" | "todoist" | "calendar" | "state" | "verify";
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

async function verifyTombstonesBeforeReceiptScrub(operation:ErasureOperation, todoist:any,
  inspectFence:Dependencies["inspectFence"]):Promise<void> {
  const ids=operation.actionPlan.projectCommentIds||[];
  if(operation.actionPlan.scrubCompletedDeliveryIdentityRefsAfterTombstone!==true||!ids.length)
    throw new ErasureGateDriftError();
  const protocol=await inspectFence(operation.profile);
  if(protocol.fence?.operationId!==operation.operationId||protocol.leases.length)
    throw new ErasureGateDriftError();
  const projectId=profiles[operation.profile].todoistProjectId;
  const requiredEventIds=[...new Set((operation.actionPlan.knownCalendarAliases||[]).map(alias=>alias.eventId))];
  for(const id of ids) {
    const comment=await todoist.getComment(id);
    const marker=parseDeletionTombstoneComment(comment);
    if(comment.id!==id||comment.project_id!==projectId||!marker||marker.profile!==operation.profile
      ||marker.projectId!==projectId||marker.taskId!==operation.target.taskId
      ||Date.parse(marker.expiresAt)<=Date.now()
      ||requiredEventIds.some(eventId=>!marker.eventIds.includes(eventId)))
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
    if(!record) return {progress:{...progress,stage:"verify"},complete:false};
    if(record.type==="DELIVERY") {
      if(record.key.sk!=="COMPLETED"||record.receiptCleanup!=="scrub_identity_refs"
        ||!/^[a-f0-9]{64}$/.test(record.scrubbedDigest||""))
        throw new ErasureGateDriftError();
      await verifyTombstonesBeforeReceiptScrub(operation,clients.todoist,dependencies.inspectFence);
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
        const scrubbed={...existing,identityRefs:{...refs,
          taskIds:refs.taskIds.filter(id=>id!==operation.target.taskId),
          eventIds:refs.eventIds.filter(id=>id!==operation.target.eventId)}};
        if(fingerprint(scrubbed)!==record.scrubbedDigest)throw new ErasureGateDriftError();
        const names={"#profile":"profile","#kind":"kind","#refs":"identityRefs","#tasks":"taskIds","#events":"eventIds"};
        const values:Record<string,unknown>={":profile":existing.profile,":kind":existing.kind,
          ":completedAt":existing.completedAt,":expiresAt":existing.expiresAt,
          ":taskCount":refs.taskIds.length,":eventCount":refs.eventIds.length,
          ":tasks":scrubbed.identityRefs.taskIds,":events":scrubbed.identityRefs.eventIds};
        const conditions=["#profile=:profile","#kind=:kind","completedAt=:completedAt","expiresAt=:expiresAt",
          "size(#refs.#tasks)=:taskCount","size(#refs.#events)=:eventCount"];
        if((refs.taskIds as unknown[]).includes(operation.target.taskId)) {
          conditions.push("contains(#refs.#tasks,:taskId)");values[":taskId"]=operation.target.taskId;
        }
        if(operation.target.eventId&&(refs.eventIds as unknown[]).includes(operation.target.eventId)) {
          conditions.push("contains(#refs.#events,:eventId)");values[":eventId"]=operation.target.eventId;
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
  const markerComments=projectComments.map(comment=>({comment,marker:parseDeletionTombstoneComment(comment)}))
    .filter(value=>value.marker?.profile===operation.profile&&value.marker.projectId===projectId
      &&value.marker.taskId===operation.target.taskId&&Date.parse(value.marker.expiresAt)>Date.now());
  const markerVerified=requiredComments.length>0&&requiredComments.every(id=>markerComments.some(({comment,marker})=>
    comment.id===id&&requiredAliases.every(alias=>marker!.eventIds.includes(alias))));
  const providersAbsent=preview.blockers.length===0
    && !preview.actionPlan.todoistTask && !preview.actionPlan.calendarEvent && preview.actionPlan.comments.length===0
    &&markerVerified;
  return {providersAbsent,stateAbsent:preview.inventory.length===0};
}

export async function createErasureDeletionProgress(now=Date.now()):Promise<ErasureDeletionProgress> {
  return {stage:"comments",commentIndex:0,stateIndex:0,startedAt:now};
}
