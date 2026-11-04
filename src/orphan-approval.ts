/**
 * #287: case-scoped, server-issued orphan preview and single-use confirmation.
 * No API or worker in this module starts provider deletion. A confirmation
 * records a durable operation for a *future* explicitly gated executor.
 */
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { profiles } from "./config.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { ReviewStore, reviewHash } from "./review-store.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { assertTrustedProof, type OrphanDeletionOperation, type VerifiedOrphanProof } from "./orphan-deletion-executor.js";
import { collectOrphanEvidence } from "./orphan-proof-reader.js";
import type { Profile, TodoistTask, CalendarEvent } from "./types.js";
import type { ReviewActor, ReviewCase, Side } from "./review-types.js";

export const ORPHAN_APPROVAL_WINDOW_MS = 5 * 60_000;
const key=(prefix:string,id:string)=>({pk:prefix+"#"+id,sk:"STATE"});
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const providerId=(id:unknown):id is string=>typeof id==="string"&&id.length>0&&id.length<=1024
  && !/[\u0000-\u001f]/.test(id);
const safeUuid=(id:unknown):id is string=>typeof id==="string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export class OrphanApprovalError extends Error {
  constructor(readonly status:number,message:string){super(message);this.name="OrphanApprovalError";}
}
export interface OrphanApprovalPreview {
  id:string; caseId:string; profile:Profile; caseUpdatedAt:string;
  side:Side; targetId:string; title:string; actorSubject:string;
  providerDigest:string; providerEtag?:string;
  proofCheckedAt:string; proofDigest:string;
  nonceDigest:string; operationId:string;
  status:"issued"|"consumed";
  createdAt:string; expiresAt:number; expiresAtMs:number;
  consumedAt?:string;
}
export interface OrphanPreviewResult {
  previewId:string;caseId:string;profile:Profile;side:Side;targetId:string;
  title:string; caseUpdatedAt:string; checkedAt:string;expiresAt:string;
  confirmationId:string;
  /** A preview authorises no provider write. */
  executionQueued:false; stateCleanupPlanned:false;
  warning:string;
}
export interface OrphanApprovalSources {
  db?:Pick<DynamoDBDocumentClient,"send">;
  cases?:Pick<ReviewStore,"getCase">;
  readTarget?:(profile:Profile,side:Side,id:string)=>Promise<TodoistTask|CalendarEvent>;
  collectProof?:(operation:OrphanDeletionOperation)=>Promise<VerifiedOrphanProof>;
  newId?:()=>string;
  now?:()=>Date;
}
function table():string {
  const name=process.env.STATE_TABLE_NAME?.trim();
  if(!name)throw new OrphanApprovalError(503,"State table is not configured");
  return name;
}
const isConflict=(error:unknown)=>["ConditionalCheckFailedException","TransactionCanceledException"]
  .includes(String((error as {name?:string})?.name||""));
function targetIsStandalone(profile:Profile,side:Side,id:string,object:TodoistTask|CalendarEvent):boolean {
  if(!object || object.id!==id)return false;
  if(side==="todoist"){
    const task=object as TodoistTask;
    return task.project_id===profiles[profile].todoistProjectId
      && task.is_deleted===false&&task.is_completed===false
      && !task.due?.is_recurring && typeof task.content==="string"&&!!task.content.trim();
  }
  const event=object as CalendarEvent;
  return event.status==="confirmed" && !!event.etag && typeof event.summary==="string"&&!!event.summary.trim()
    && !event.recurringEventId && !event.recurrence?.length
    && !event.extendedProperties?.shared?.syncRecurrenceOwner;
}
function titleOf(side:Side,object:TodoistTask|CalendarEvent):string {
  return (side==="todoist"?(object as TodoistTask).content:(object as CalendarEvent).summary)||"";
}
function assertRecorded(item:ReviewCase,side:Side,id:string):void {
  if(item.status!=="open"||item.operationId||item.reason.startsWith("operational_"))
    throw new OrphanApprovalError(409,"Only an open item-level review alert can preview orphan deletion");
  const evidence=reviewCaseEvidenceIds(item);
  const own=side==="todoist"?evidence.taskIds:evidence.eventIds;
  if(own.length!==1||own[0]!==id)
    throw new OrphanApprovalError(409,"Target must be the sole exact recorded identity on that provider side of this alert");
}
function assertMatchingCase(item:ReviewCase|undefined,preview:OrphanApprovalPreview):void {
  if(!item||item.id!==preview.caseId||item.profile!==preview.profile
    ||item.updatedAt!==preview.caseUpdatedAt)
    throw new OrphanApprovalError(409,"Alert identity, profile or version changed; request a new preview");
  assertRecorded(item,preview.side,preview.targetId);
}
function proofDigest(value:VerifiedOrphanProof):string {
  return reviewHash({caseId:value.caseId,profile:value.profile,caseUpdatedAt:value.caseUpdatedAt,
    side:value.side,targetId:value.targetId,providerDigest:value.providerDigest,
    providerEtag:value.providerEtag,checks:value.checks,blockers:value.blockers});
}
function operationFromPreview(preview:OrphanApprovalPreview,at:string):OrphanDeletionOperation {
  return {id:preview.operationId,caseId:preview.caseId,profile:preview.profile,
    caseUpdatedAt:preview.caseUpdatedAt,side:preview.side,targetId:preview.targetId,
    providerDigest:preview.providerDigest,
    ...(preview.providerEtag?{providerEtag:preview.providerEtag}:{}),
    actorSubject:preview.actorSubject,confirmedAt:at,
    confirmationExpiresAt:new Date(preview.expiresAtMs).toISOString(),
    phase:"confirmed",version:0,createdAt:at,updatedAt:at};
}
function checkedProof(preview:OrphanApprovalPreview,proof:VerifiedOrphanProof):void {
  const op=operationFromPreview(preview,new Date().toISOString());
  try {assertTrustedProof(op,proof);}
  catch {throw new OrphanApprovalError(409,"Current provider or ownership proof is incomplete, stale or has changed");}
  if(proofDigest(proof)!==preview.proofDigest)
    throw new OrphanApprovalError(409,"Deletion proof changed since preview; review the refreshed evidence before confirming");
}
export class OrphanApprovalService {
  private readonly db:Pick<DynamoDBDocumentClient,"send">;
  private readonly cases:Pick<ReviewStore,"getCase">;
  private readonly makeId:()=>string;
  private readonly now:()=>Date;
  constructor(private readonly sources:OrphanApprovalSources={}) {
    this.db=sources.db||documentClient;this.cases=sources.cases||new ReviewStore();
    this.makeId=sources.newId||randomUUID;this.now=sources.now||(()=>new Date());
  }
  private async readTarget(profile:Profile,side:Side,id:string):Promise<TodoistTask|CalendarEvent> {
    if(this.sources.readTarget)return this.sources.readTarget(profile,side,id);
    const clients=await defaultProviderClientFactory(profile);
    return side==="todoist"?clients.todoist.getTask(id):clients.calendar.getEvent(id);
  }
  private async collect(op:OrphanDeletionOperation):Promise<VerifiedOrphanProof> {
    return this.sources.collectProof?this.sources.collectProof(op):collectOrphanEvidence(op,{store:this.cases});
  }
  async issue(caseId:string,side:Side,targetId:string,actor:ReviewActor):Promise<OrphanPreviewResult> {
    if(!providerId(caseId)||!providerId(targetId)||!["todoist","calendar"].includes(side)
      || !providerId(actor.subject))throw new OrphanApprovalError(400,"Exact case and provider identity required");
    const item=await this.cases.getCase(caseId);
    if(!item)throw new OrphanApprovalError(404,"Selected review alert not found");
    assertRecorded(item,side,targetId);
    let object:TodoistTask|CalendarEvent;
    try {object=await this.readTarget(item.profile,side,targetId);}
    catch(error){
      if(Number((error as {status?:number})?.status)===404)
        throw new OrphanApprovalError(409,"The selected provider object is absent; there is nothing to delete");
      throw error;
    }
    if(!targetIsStandalone(item.profile,side,targetId,object))
      throw new OrphanApprovalError(409,"Selected provider object is not a verified live standalone item in this profile");
    const at=this.now();
    const previewId=this.makeId(),operationId=this.makeId(),confirmationId=this.makeId();
    if(!safeUuid(previewId)||!safeUuid(operationId)||!safeUuid(confirmationId)
      ||new Set([previewId,operationId,confirmationId]).size!==3)
      throw new OrphanApprovalError(503,"Secure preview identifiers could not be created");
    const expiresAtMs=at.getTime()+ORPHAN_APPROVAL_WINDOW_MS;
    const preview:OrphanApprovalPreview={
      id:previewId,caseId:item.id,profile:item.profile,caseUpdatedAt:item.updatedAt,
      side,targetId,title:titleOf(side,object),actorSubject:actor.subject,
      providerDigest:reviewHash(object),
      ...(side==="calendar"?{providerEtag:(object as CalendarEvent).etag}:{}),
      proofCheckedAt:"",proofDigest:"",nonceDigest:sha(confirmationId),
      operationId,status:"issued",createdAt:at.toISOString(),
      expiresAt:Math.ceil(expiresAtMs/1000),expiresAtMs,
    };
    const operation=operationFromPreview(preview,at.toISOString());
    let proof:VerifiedOrphanProof;
    try {proof=await this.collect(operation);}catch{
      throw new OrphanApprovalError(503,"Full provider or state inventory could not be completed; no deletion preview issued");
    }
    // These checks are server-derived, never accepted from an HTTP body.
    try {assertTrustedProof(operation,proof);}catch {
      throw new OrphanApprovalError(409,"Live counterpart, ambiguous ownership, stale mapping, recurrence or other orphan safety check blocked deletion preview");
    }
    preview.proofCheckedAt=proof.checkedAt;
    preview.proofDigest=proofDigest(proof);
    const fresh=await this.cases.getCase(caseId);
    assertMatchingCase(fresh,preview);
    if(this.now().getTime()>=expiresAtMs)throw new OrphanApprovalError(409,"Preview timed out during provider verification; request another");
    try {
      await this.db.send(new PutCommand({TableName:table(),Item:{...preview,...key("ORPHAN_PREVIEW",preview.id)},
        ConditionExpression:"attribute_not_exists(pk)"}));
    }catch(error) {
      if(isConflict(error))throw new OrphanApprovalError(409,"Preview identifier already exists");
      throw error;
    }
    return {previewId,caseId,profile:preview.profile,side,targetId,title:preview.title,
      caseUpdatedAt:preview.caseUpdatedAt,checkedAt:proof.checkedAt,
      expiresAt:new Date(expiresAtMs).toISOString(),confirmationId,
      executionQueued:false,stateCleanupPlanned:false,
      warning:"This is an immutable single-target preview. Confirmation will record an operation only; it will NOT start provider deletion while production executor integration is disabled."};
  }
  async confirm(caseId:string,input:{
    previewId:string;confirmationId:string;exactId:string;phrase:string;
  },actor:ReviewActor):Promise<{operationId:string;caseId:string;profile:Profile;side:Side;
    targetId:string;status:"confirmed_not_dispatched";executionQueued:false}> {
    if(!providerId(caseId)||!safeUuid(input.previewId)||!safeUuid(input.confirmationId)
      ||!providerId(input.exactId)||input.phrase!=="PERMANENTLY ERASE")
      throw new OrphanApprovalError(400,"Exact preview, confirmation, provider ID and PERMANENTLY ERASE phrase are required");
    const read=await this.db.send(new GetCommand({TableName:table(),
      Key:key("ORPHAN_PREVIEW",input.previewId),ConsistentRead:true}));
    const preview=read.Item as OrphanApprovalPreview|undefined;
    if(!preview||preview.id!==input.previewId||preview.caseId!==caseId)
      throw new OrphanApprovalError(404,"Case-bound deletion preview was not found");
    if(preview.status!=="issued"||preview.consumedAt || preview.actorSubject!==actor.subject
      ||preview.targetId!==input.exactId||preview.nonceDigest!==sha(input.confirmationId))
      throw new OrphanApprovalError(403,"Preview confirmation is consumed, belongs to another operator or does not match the exact target");
    if(!Number.isFinite(preview.expiresAtMs)||preview.expiresAtMs<=this.now().getTime())
      throw new OrphanApprovalError(409,"Preview confirmation expired; request a fresh provider check");
    const item=await this.cases.getCase(caseId);
    assertMatchingCase(item,preview);
    let proof:VerifiedOrphanProof;
    try {proof=await this.collect(operationFromPreview(preview,this.now().toISOString()));}
    catch {throw new OrphanApprovalError(503,"Current provider/state verification is unavailable; no operation was recorded");}
    checkedProof(preview,proof);
    const now=this.now().toISOString();
    const nowMs=this.now().getTime();
    if(nowMs>=preview.expiresAtMs)throw new OrphanApprovalError(409,"Confirmation expired before the safety proof finished");
    const op=operationFromPreview(preview,now);
    try {
      await this.db.send(new TransactWriteCommand({TransactItems:[
        {ConditionCheck:{TableName:table(),Key:key("REVIEW_CASE",caseId),
          ConditionExpression:"#state = :open AND #modified = :revision AND #profile = :profile AND attribute_not_exists(#operation)",
          ExpressionAttributeNames:{"#state":"status","#modified":"updatedAt","#profile":"profile","#operation":"operationId"},
          ExpressionAttributeValues:{":open":"open",":revision":preview.caseUpdatedAt,":profile":preview.profile}}},
        {Update:{TableName:table(),Key:key("ORPHAN_PREVIEW",preview.id),
          UpdateExpression:"SET #state = :used, #consumed = :now",
          ConditionExpression:"#state = :issued AND attribute_not_exists(#consumed) AND #actor = :actor AND #case = :case"
            +" AND #target = :target AND #digest = :digest AND #nonce = :nonce AND #expiry > :millis",
          ExpressionAttributeNames:{"#state":"status","#consumed":"consumedAt","#actor":"actorSubject",
            "#case":"caseId","#target":"targetId","#digest":"proofDigest","#nonce":"nonceDigest","#expiry":"expiresAtMs"},
          ExpressionAttributeValues:{":used":"consumed",":issued":"issued",":now":now,":actor":actor.subject,
            ":case":caseId,":target":preview.targetId,":digest":preview.proofDigest,":nonce":sha(input.confirmationId),
            ":millis":nowMs}}},
        {Put:{TableName:table(),Item:{...op,...key("ORPHAN_DELETE",op.id)},
          ConditionExpression:"attribute_not_exists(pk)"}},
        {Put:{TableName:table(),Item:{...key("ORPHAN_CASE_LOCK",caseId),
          operationId:op.id,caseId,profile:op.profile,side:op.side,targetId:op.targetId,
          caseUpdatedAt:op.caseUpdatedAt,createdAt:now},
          ConditionExpression:"attribute_not_exists(pk)"}},
      ]}));
    } catch(error) {
      if(isConflict(error))throw new OrphanApprovalError(409,"Alert, preview or prior deletion operation changed; no duplicate deletion can start");
      throw error;
    }
    // Crucially: no enqueue and no call to advanceGuardedOrphanDeletion.
    return {operationId:op.id,caseId,profile:op.profile,side:op.side,targetId:op.targetId,
      status:"confirmed_not_dispatched",executionQueued:false};
  }
  async status(caseId:string,operationId:string,actor:ReviewActor):Promise<OrphanDeletionOperation> {
    if(!providerId(caseId)||!safeUuid(operationId))throw new OrphanApprovalError(400,"Invalid operation identity");
    const row=await this.db.send(new GetCommand({TableName:table(),
      Key:key("ORPHAN_DELETE",operationId),ConsistentRead:true}));
    const op=row.Item as OrphanDeletionOperation|undefined;
    if(!op||op.id!==operationId||op.caseId!==caseId)
      throw new OrphanApprovalError(404,"No operation belongs to this review alert");
    if(op.actorSubject!==actor.subject)throw new OrphanApprovalError(403,"This operation belongs to another operator");
    return op;
  }
}
