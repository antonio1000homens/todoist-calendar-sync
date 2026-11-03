/**
 * #287 read-only authoritative inventory for the guarded orphan executor.
 * This is not an HTTP deletion endpoint. Missing/partial provider responses
 * must fail closed; the executor re-evaluates proof under its worker fence.
 */
import { ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient, pacingDelayMs, scanPageItemLimit } from "./dynamodb-capacity.js";
import { profiles } from "./config.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { ReviewStore, reviewHash } from "./review-store.js";
import { ORPHAN_REQUIRED_CHECKS, type OrphanDeletionOperation, type VerifiedOrphanProof,
  type OrphanProofCheck, type ProviderTarget } from "./orphan-deletion-executor.js";
import type { Profile, TodoistTask, CalendarEvent } from "./types.js";
import type { ReviewCase } from "./review-types.js";

export interface ProviderInventory {
  profile: Profile;
  tasks: TodoistTask[];
  events: CalendarEvent[];
  comments: Array<{ id: string; content: string }>;
}
export interface OrphanEvidenceInventory {
  item?: ReviewCase;
  target: ProviderTarget | null;
  counterparts: Array<{ side:"todoist"|"calendar"; id:string; object:TodoistTask|CalendarEvent|null }>;
  providers: ProviderInventory[];
  stateRows: Array<Record<string,unknown>>;
}
const allProfiles:Profile[]=["home","antonio","work"];
const live=(side:"todoist"|"calendar",object:TodoistTask|CalendarEvent|null):boolean=>
  Boolean(object && (side==="todoist"
    ? (object as TodoistTask).is_completed===false && (object as TodoistTask).is_deleted===false
    : (object as CalendarEvent).status==="confirmed"));
const refers=(value:unknown,id:string):boolean=>{
  if(typeof value==="string")return value.includes(id);
  if(Array.isArray(value))return value.some(x=>refers(x,id));
  return Boolean(value && typeof value==="object" && Object.values(value).some(x=>refers(x,id)));
};
const titleSame=(a:unknown,b:unknown):boolean=>typeof a==="string"&&typeof b==="string"&&
  a.trim().length>0 && a.trim().toLowerCase()===b.trim().toLowerCase();
const isMapping=(row:Record<string,unknown>)=>/^(TASK#|EVENT#|TASKOWNER#|MAPPING#)/.test(String(row.pk));
const isRecurrence=(row:Record<string,unknown>)=>String(row.pk).startsWith("RECURRENCE#");
const isCompleted=(row:Record<string,unknown>)=>String(row.pk).startsWith("COMPLETED_");
const isControl=(row:Record<string,unknown>)=>String(row.pk).startsWith("SYNC_CONTROL#");
const isOtherOperation=(row:Record<string,unknown>)=>/^(REPAIR#|REPAIR_PREVIEW#|ERASURE_OPERATION#|ERASURE_CONFIRMATION#)/.test(String(row.pk));
const isFence=(row:Record<string,unknown>)=>String(row.pk).startsWith("ERASURE#") &&
  (String(row.sk)==="FENCE"||String(row.sk).startsWith("WRITER#")||String(row.sk).startsWith("ADMISSION#"));

/** Evaluate a complete read-only inventory. This does not grant deletion
 * eligibility by itself; it is fresh proof consumed by the fenced executor. */
export function evaluateOrphanEvidence(op:OrphanDeletionOperation, data:OrphanEvidenceInventory,
  checkedAt=new Date().toISOString()):VerifiedOrphanProof {
  const checks=Object.fromEntries(ORPHAN_REQUIRED_CHECKS.map(name=>[name,false])) as Record<OrphanProofCheck,boolean>;
  const errors:string[]=[];
  const item=data.item;
  checks.case_open_unchanged=Boolean(item && item.id===op.caseId && item.profile===op.profile &&
    item.status==="open" && item.updatedAt===op.caseUpdatedAt && !item.operationId &&
    !item.reason.startsWith("operational_"));
  const obj=data.target?.item;
  checks.exact_target_live=Boolean(obj && data.target?.side===op.side &&
    obj.id===op.targetId && live(op.side,obj) && reviewHash(obj)===op.providerDigest &&
    (op.side!=="todoist" || (obj as TodoistTask).project_id===profiles[op.profile].todoistProjectId) &&
    (op.side!=="calendar" || (obj as CalendarEvent).etag===op.providerEtag));
  checks.scope_standalone=Boolean(checks.exact_target_live && obj &&
    (op.side==="todoist" ? !(obj as TodoistTask).due?.is_recurring :
      !(obj as CalendarEvent).recurringEventId && !(obj as CalendarEvent).recurrence?.length &&
      !(obj as CalendarEvent).extendedProperties?.shared?.syncRecurrenceOwner));
  const evidence=item?reviewCaseEvidenceIds(item):{taskIds:[],eventIds:[]};
  const sameSide=op.side==="todoist"?evidence.taskIds:evidence.eventIds;
  const otherSide=op.side==="todoist"?"calendar":"todoist";
  const others=otherSide==="todoist"?evidence.taskIds:evidence.eventIds;
  // A direct 404 in the alert profile alone is not authoritative absence:
  // a moved/foreign counterpart may still be visible in another profile.
  // Require the complete provider inventory, and cross-check EVERY recorded
  // counterpart ID across all three profiles before allowing deletion.
  checks.complete_provider_enumeration=data.providers.length===3 &&
    allProfiles.every(profile=>data.providers.filter(value=>value.profile===profile).length===1) &&
    data.providers.every(value=>Array.isArray(value.tasks)&&Array.isArray(value.events)&&Array.isArray(value.comments));
  const liveRecordedCounterparts:string[]=[];
  if(checks.complete_provider_enumeration) for(const provider of data.providers) {
    const objects=otherSide==="todoist"?provider.tasks:provider.events;
    for(const id of others) if(objects.some(object=>object.id===id&&live(otherSide,object)))
      liveRecordedCounterparts.push(provider.profile+":"+otherSide+":"+id);
  }
  checks.all_recorded_counterparts_absent=checks.complete_provider_enumeration &&
    sameSide.length===1 && sameSide[0]===op.targetId &&
    others.length<=20 && data.counterparts.length===others.length &&
    others.every(id=>data.counterparts.filter(entry=>entry.side===otherSide&&entry.id===id&&entry.object===null).length===1) &&
    liveRecordedCounterparts.length===0;
  const reverse:string[]=[...liveRecordedCounterparts];
  if(obj && checks.complete_provider_enumeration) {
    for(const provider of data.providers) {
      if(op.side==="todoist") {
        for(const event of provider.events) if(live("calendar",event) &&
          (event.extendedProperties?.shared?.taskId===op.targetId ||
            refers(event.description,op.targetId) ||
            provider.profile===op.profile && titleSame(event.summary,(obj as TodoistTask).content)))
          reverse.push(provider.profile+":calendar:"+event.id);
        if(provider.profile!==op.profile && provider.tasks.some(t=>t.id===op.targetId&&live("todoist",t)))
          reverse.push(provider.profile+":todoist:"+op.targetId);
      } else {
        for(const task of provider.tasks) if(live("todoist",task) &&
          (refers(task.description,op.targetId) ||
            provider.profile===op.profile && titleSame(task.content,(obj as CalendarEvent).summary)))
          reverse.push(provider.profile+":todoist:"+task.id);
        if(provider.profile!==op.profile && provider.events.some(e=>e.id===op.targetId&&live("calendar",e)))
          reverse.push(provider.profile+":calendar:"+op.targetId);
      }
    }
  }
  checks.no_reverse_provider_links=checks.complete_provider_enumeration && reverse.length===0;
  if(reverse.length)errors.push("Live or ambiguous reverse candidates: "+reverse.join(", "));
  const wellFormed=Array.isArray(data.stateRows)&&data.stateRows.every(row=>
    row&&typeof row.pk==="string"&&typeof row.sk==="string");
  const otherRows=wellFormed?data.stateRows.filter(row=>refers(row,op.targetId) &&
    row.pk!=="REVIEW_CASE#"+op.caseId && row.pk!=="MANUAL#"+op.caseId &&
    row.pk!=="ORPHAN_DELETE#"+op.id &&
    // The preview that authorized this operation (and another preview by the
    // same operator for this exact alert/item) is evidence, not a provider
    // association. A foreign or differently targeted preview still blocks.
    !(String(row.pk).startsWith("ORPHAN_PREVIEW#") && row.caseId===op.caseId
      && row.profile===op.profile && row.side===op.side
      && row.targetId===op.targetId && row.actorSubject===op.actorSubject) &&
    !(row.pk==="ORPHAN_CASE_LOCK#"+op.caseId && row.operationId===op.id
      && row.profile===op.profile && row.targetId===op.targetId) &&
    !(String(row.pk).startsWith("AUDIT#") && row.pk===item?.sourceAuditKey) &&
    !(String(row.pk).startsWith("REVIEW_CONFLICT#") && row.incidentId===op.caseId) &&
    !String(row.pk).startsWith("RECONCILE#")):[];
  checks.cross_profile_mapping_indexes_clear=wellFormed&&!otherRows.some(isMapping);
  checks.recurrence_ownership_clear=wellFormed&&!otherRows.some(isRecurrence);
  checks.completed_history_safe=wellFormed&&!otherRows.some(isCompleted);
  checks.sync_controls_clear=wellFormed&&!otherRows.some(row=>isControl(row)&&
    (row.activeRepair||row.excluded===true||row.fencedAt||row.pendingRefresh));
  checks.no_active_repair_or_erasure=wellFormed&&!otherRows.some(isOtherOperation)&&!data.stateRows.some(row=>isFence(row) && !(row.pk==="ERASURE#"+op.profile && row.sk==="FENCE" && row.operationId===op.id));
  checks.canonical_records_clear=wellFormed&&!otherRows.some(row=>!isMapping(row)&&!isRecurrence(row)&&
    !isCompleted(row)&&!isControl(row)&&!isOtherOperation(row)&&!isFence(row));
  const comments=data.providers.flatMap(profile=>profile.comments.filter(comment=>refers(comment.content,op.targetId))
    .map(comment=>profile.profile+":"+comment.id));
  checks.project_and_task_comments_clear=checks.complete_provider_enumeration&&comments.length===0;
  if(comments.length)errors.push("Mapping comments need manual review: "+comments.join(", "));
  if(otherRows.length)errors.push("State references require conditional owner review: "+
    otherRows.slice(0,8).map(row=>String(row.pk)+"/"+String(row.sk)).join(", "));
  for(const check of ORPHAN_REQUIRED_CHECKS)if(!checks[check])errors.push("Unverified: "+check);
  return {caseId:op.caseId,profile:op.profile,caseUpdatedAt:op.caseUpdatedAt,
    side:op.side,targetId:op.targetId,checkedAt,checks,blockers:errors,
    providerDigest:obj?reviewHash(obj):"",
    ...(op.side==="calendar"?{providerEtag:(obj as CalendarEvent|null)?.etag}:{})};
}

export class OrphanEvidenceUnavailable extends Error {
  constructor(message:string){super(message);this.name="OrphanEvidenceUnavailable";}
}
type Clients=Awaited<ReturnType<typeof defaultProviderClientFactory>>;
export interface OrphanEvidenceSources {
  store?:Pick<ReviewStore,"getCase">;
  db?:Pick<DynamoDBDocumentClient,"send">;
  clients?:(profile:Profile)=>Promise<Clients>;
  maxRows?:number;
  maxCommentScanTasks?:number;
  deadlineMs?:number;
}
const providerNotFound=(error:unknown)=>Number((error as {status?:number})?.status)===404;
async function fullStateRead(db:Pick<DynamoDBDocumentClient,"send">,limit:number,deadline:number):
  Promise<Array<Record<string,unknown>>> {
  if(!process.env.STATE_TABLE_NAME)throw new OrphanEvidenceUnavailable("State table is not configured");
  const rows:Array<Record<string,unknown>>=[];
  let cursor:Record<string,unknown>|undefined;
  do {
    if(Date.now()>deadline)throw new OrphanEvidenceUnavailable("Full state inventory timed out");
    const start=Date.now();
    const page=await db.send(new ScanCommand({TableName:process.env.STATE_TABLE_NAME,
      ConsistentRead:true,Limit:scanPageItemLimit(),ExclusiveStartKey:cursor,ReturnConsumedCapacity:"TOTAL"}));
    rows.push(...((page.Items||[]) as Array<Record<string,unknown>>));
    if(rows.length>limit)throw new OrphanEvidenceUnavailable("State inventory exceeds safe review budget");
    cursor=page.LastEvaluatedKey as Record<string,unknown>|undefined;
    if(cursor)await new Promise(resolve=>setTimeout(resolve,
      pacingDelayMs(Number(page.ConsumedCapacity?.CapacityUnits||0),Date.now()-start)));
  } while(cursor);
  return rows;
}
/** Trusted on-demand provider/state reader; any incomplete pagination, API
 * failure, rate limit or deadline throws. No provider/state writes occur. */
export async function collectOrphanEvidence(op:OrphanDeletionOperation,sources:OrphanEvidenceSources={}):
  Promise<VerifiedOrphanProof> {
  const deadline=Date.now()+(sources.deadlineMs??80_000);
  const store=sources.store||new ReviewStore();
  const cached=new Map<Profile,Clients>();
  const get=async(profile:Profile):Promise<Clients>=>{
    const old=cached.get(profile);if(old)return old;
    const value=await (sources.clients||defaultProviderClientFactory)(profile);
    cached.set(profile,value);return value;
  };
  const item=await store.getCase(op.caseId);
  const recorded=item?reviewCaseEvidenceIds(item):{taskIds:[],eventIds:[]};
  const side=op.side==="todoist"?"calendar":"todoist";
  const opposite=side==="todoist"?recorded.taskIds:recorded.eventIds;
  if(opposite.length>20)throw new OrphanEvidenceUnavailable("Too many recorded counterpart identities");
  const read=async(side:"todoist"|"calendar",id:string):Promise<TodoistTask|CalendarEvent|null>=>{
    const pair=await get(op.profile);
    try {
      const result=side==="todoist"?await pair.todoist.getTask(id):await pair.calendar.getEvent(id);
      if(result.id!==id)throw new OrphanEvidenceUnavailable("Provider returned a different identity");
      if(side==="calendar"&&(result as CalendarEvent).status==="cancelled")return null;
      return result;
    } catch(error){if(providerNotFound(error))return null;throw error;}
  };
  const [target,...values]=await Promise.all([read(op.side,op.targetId),...opposite.map(id=>read(side,id))]);
  const providers:ProviderInventory[]=[];
  let taskCount=0;
  for(const profile of allProfiles) {
    if(Date.now()>deadline)throw new OrphanEvidenceUnavailable("Full provider inventory timed out");
    const pair=await get(profile);
    const [tasks,delta,projectComments]=await Promise.all([
      pair.todoist.listTasks(profiles[profile].todoistProjectId),
      pair.calendar.listDelta(),
      pair.todoist.listProjectComments(profiles[profile].todoistProjectId,true),
    ]);
    taskCount+=tasks.length;
    if(taskCount>(sources.maxCommentScanTasks??100))
      throw new OrphanEvidenceUnavailable("Too many tasks for complete legacy task-comment inventory");
    const comments=projectComments.map(c=>({id:c.id,content:c.content||""}));
    for(const task of tasks) {
      if(Date.now()>deadline)throw new OrphanEvidenceUnavailable("Full task-comment inventory timed out");
      const items=await pair.todoist.listTaskComments(task.id);
      comments.push(...items.map(c=>({id:c.id,content:c.content||""})));
    }
    providers.push({profile,tasks,events:delta.items,comments});
  }
  const rows=await fullStateRead(sources.db||documentClient,sources.maxRows??20000,deadline);
  return evaluateOrphanEvidence(op,{item,target:target?{side:op.side,item:target} as ProviderTarget:null,
    counterparts:opposite.map((id,index)=>({side,id,object:values[index]})),providers,stateRows:rows});
}
