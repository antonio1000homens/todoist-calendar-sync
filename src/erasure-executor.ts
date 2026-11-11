/** Reusable lifecycle and durable async contract for per-item erasure jobs. */
import { createHash, randomUUID } from "node:crypto";
import { erasureExecutionEnabled } from "./erasure-readiness.js";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";
import {atomicConfirmedErasureCompletion,ErasureReplayUnavailableError,
  verifyConfirmedErasureCompletion} from "./erasure-replay-barrier.js";

export type ErasureOperationStatus = "previewed" | "queued" | "fencing" | "deleting" | "verifying" | "succeeded" | "partial_failure" | "review_required";
export type FencedLifecyclePhase = "disable_mappings" | "confirm_disabled" | "drain_before_fence"
  | "install_fence" | "wait_worker_timeout" | "drain_after_timeout" | "ready_for_delete"
  | "delete" | "verify_deletion" | "restore_mappings" | "confirm_restored" | "release_fence" | "complete";
export interface ErasureDeletionProgress {
  stage: "comments" | "todoist" | "calendar" | "state" | "finalize_comments" | "verify";
  finalCommentIndex?: number;
  commentIndex: number;
  stateIndex: number;
  startedAt: number;
  /** Write-ahead claim for the current step; kept if its checkpoint ACK is lost. */
  attempt?: { id: string; startedAt: number };
}
export interface FencedLifecycle {
  phase: FencedLifecyclePhase;
  mappingIds: string[];
  enabledMappingIds: string[];
  timeoutSeconds: number;
  pollMs: number;
  nextRunAt: number;
  lastError?: string;
  evidence: Partial<Record<FencedEvidenceKey, FencedReceipt>>;
  deletionProgress?: ErasureDeletionProgress;
}
export type FencedEvidenceKey = "mappingsDisableRequested" | "mappingsDisabled" | "preFenceDrain" | "fenceInstalled"
  | "workerTimeoutElapsed" | "postTimeoutDrain" | "deletionStarted" | "providerDeletionVerified" | "mappingsRestored" | "fenceReleased";
export interface FencedReceipt { operationId: string; phase: FencedEvidenceKey; receiptId: string; completedAt: number }
export interface ErasurePostWriteCompletionReceipt {
  mode:"known_identity_post_write";
  status:"completed";
  completedAt:string;
  epoch:number;
  originalMappingCount:number;
  restoredMappingCount:number;
  tombstoneRetained:true;
  providerDeletesReplayed:false;
}
export interface ErasureOperation {
  operationId: string;
  profile: Profile;
  target: { taskId: string; eventId?: string; deleteCalendar: boolean };
  previewFingerprint: string;
  providerSnapshotFingerprint: string;
  confirmationFingerprint: string;
  confirmationId: string;
  /** Set only by the trusted, deployment-gated provider deletion workflow. */
  providerDeletionReady?: boolean;
  selectedActions: { deleteTodoist: boolean; deleteCalendar: boolean };
  inventory: Array<{ type: string; key: { pk: string; sk: string }; digest: string; classification: string;
    receiptCleanup?:"scrub_identity_refs";scrubbedDigest?:string }>;
  /** Exact temporary provider deletion inputs; removed together with the operation on success. */
  actionPlan: ErasureActionPlan;
  status: ErasureOperationStatus;
  lifecycle?: FencedLifecycle;
  recovery?: import("./erasure-recovery.js").RecoveryState;
  /** Post-write operator acknowledgement only: no executor, admission or fence release. */
  postwriteReview?: {
    mode:"post_write";status:"reviewed_fenced";epoch:number;
    confirmationId:string;inspectedFingerprint:string;postflightFingerprint:string;
    reviewedAt:string;
  };
  /** Identity-free terminal receipt retained after verified post-write completion. */
  postWriteCompletion?:ErasurePostWriteCompletionReceipt;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  result?: Record<string, unknown>;
  error?: string;
}
export interface ErasureActionPlan {
  todoistTask?: { id: string; digest: string };
  calendarEvent?: { id: string; calendarId:string; digest: string; etag: string;
    /** When retained, the exact event is patched to remove its Todoist link under this ETag. */
    unlinkTodoistTask?: string; unlinkDigest?: string };
  /** Exact event aliases captured before mutation, scoped by profile and Calendar. */
  knownCalendarAliases?:Array<{profile:Profile;calendarId:string;eventId:string}>;
  knownCalendarAliasesComplete?:boolean;
  /** Project comments become temporary markers under the fence, then are deleted before success. */
  projectCommentIds?:string[];
  /** Completed identity references are scrubbed only after every project tombstone is read back. */
  scrubCompletedDeliveryIdentityRefsAfterTombstone?:boolean;
  comments: Array<{ id: string; kind: "project" | "task"; digest: string }>;
}
export interface FencedMapping { id: string; state: "Enabled" | "Disabled"; eventSourceArn: string }
export interface FencedLifecycleAdapters {
  listWorkerMappings(): Promise<FencedMapping[]>;
  disableMappings(ids: string[]): Promise<void>;
  mappingStates(ids: string[]): Promise<Array<{ id: string; state: string }>>;
  inspectFence(profile: string): Promise<{ fence?: { operationId?: string }; leases: unknown[] }>;
  beginFence(profile: string, operationId: string): Promise<void>;
  restoreMappings(ids: string[]): Promise<void>;
  finishFence(profile: string, operationId: string): Promise<void>;
}
export interface ErasureDeletionVerifier {
  verifyDeletion(operation: ErasureOperation): Promise<{ providersAbsent: boolean; stateAbsent: boolean }>;
}
export interface ErasureSnapshotReader {
  readFreshSnapshot(operation: ErasureOperation): Promise<Omit<ErasurePreview,"operationId"> & {blockers?:string[]}>;
  readMappingStates(ids: string[]): Promise<Array<{ id: string; state: string }>>;
  inspectFence(profile: string): Promise<{ fence?: { operationId?: string }; leases: unknown[] }>;
}
export interface ErasureDeletionStepResult { progress: ErasureDeletionProgress; complete: boolean }
export interface ErasureDeletionWorker {
  executeDeletionStep?(operation:ErasureOperation,progress:ErasureDeletionProgress):Promise<ErasureDeletionStepResult>;
}
/** Bind these process-trusted adapters when constructing the worker service, never per request. */
export interface ErasureWorkerAdapters extends FencedLifecycleAdapters, ErasureDeletionVerifier, ErasureSnapshotReader, ErasureDeletionWorker {}

export class ErasureGateDriftError extends Error {
  constructor() {
    super("Erasure is not ready: persisted action receipts, confirmation, inventory, or lifecycle changed");
    this.name="ErasureGateDriftError";
  }
}

class ErasureDeletionAttemptClaimError extends Error {
  constructor(){super("Another worker claimed this deletion step");this.name="ErasureDeletionAttemptClaimError";}
}

export const ERASURE_REVIEW_REQUIRED_MESSAGE="Operator break-glass recovery is required. Preserve any protections that remain, inspect the actual profile fence and worker mapping state, and escalate if either is missing, changed, or cannot be verified. Do not start a fresh preview until service admission is restored; this operation cannot be resumed.";
export const ERASURE_BACKUP_RETENTION_NOTICE="Erasure removes live-table rows only. DynamoDB point-in-time recovery remains enabled with a 35-day recovery window, so deleted data may remain recoverable from backups during that period.";

const transitions: Record<ErasureOperationStatus, ErasureOperationStatus[]> = {
  previewed: ["queued"], queued: ["fencing", "partial_failure"], fencing: ["deleting", "partial_failure"],
  deleting: ["verifying", "partial_failure", "review_required"], verifying: ["succeeded", "partial_failure"],
  succeeded: [], partial_failure: ["queued"], review_required: [],
};

export function advanceErasureOperation(current: ErasureOperation, status: ErasureOperationStatus,
  patch: Partial<Pick<ErasureOperation, "result" | "error" | "requestId">> = {}, now = new Date().toISOString()): ErasureOperation {
  if (!transitions[current.status].includes(status)) throw new Error(`Invalid erasure operation transition ${current.status} -> ${status}`);
  return { ...current, ...patch, status, updatedAt: now };
}

function operationKey(id: string) { return { pk: `ERASURE_OPERATION#${id}`, sk: "STATE" }; }
function confirmationKey(operationId: string) { return { pk: `ERASURE_CONFIRMATION#${operationId}`, sk: "STATE" }; }
function validActionPlan(plan:ErasureActionPlan,operation:Pick<ErasureOperation,"profile"|"target"|"selectedActions"|"inventory">):boolean {
  if(!plan||!Array.isArray(plan.comments)) return false;
  if(plan.todoistTask&&(plan.todoistTask.id!==operation.target.taskId||!/^[a-f0-9]{64}$/.test(plan.todoistTask.digest))) return false;
  if(plan.calendarEvent&&((!operation.selectedActions.deleteCalendar
      &&(plan.calendarEvent.unlinkTodoistTask!==operation.target.taskId
        ||!/^[a-f0-9]{64}$/.test(plan.calendarEvent.unlinkDigest||"")))||plan.calendarEvent.id!==operation.target.eventId
    ||typeof plan.calendarEvent.calendarId!=="string"||!/^[^\u0000-\u001f\u007f]{1,1024}$/.test(plan.calendarEvent.calendarId)
    ||!/^[a-f0-9]{64}$/.test(plan.calendarEvent.digest)||typeof plan.calendarEvent.etag!=="string"||!plan.calendarEvent.etag)) return false;
  if(operation.selectedActions.deleteCalendar) {
    const aliases=plan.knownCalendarAliases;
    if(plan.knownCalendarAliasesComplete!==true||!Array.isArray(aliases)||!aliases.length||aliases.length>32
      ||aliases.some(alias=>!alias||!(["home","antonio","work"] as string[]).includes(alias.profile)
        ||typeof alias.calendarId!=="string"||!/^[^\u0000-\u001f\u007f]{1,1024}$/.test(alias.calendarId)
        ||typeof alias.eventId!=="string"||!/^[A-Za-z0-9_.-]{1,1024}$/.test(alias.eventId))
      ||new Set(aliases.map(alias=>JSON.stringify([alias.profile,alias.calendarId,alias.eventId]))).size!==aliases.length
      ||!plan.calendarEvent||!aliases.some(alias=>alias.profile===operation.profile
        &&alias.calendarId===plan.calendarEvent!.calendarId&&alias.eventId===operation.target.eventId)) return false;
  }
  const deliveryReceipts=operation.inventory.filter(item=>item.type==="DELIVERY");
  if(deliveryReceipts.length&&(plan.scrubCompletedDeliveryIdentityRefsAfterTombstone!==true
    ||operation.selectedActions.deleteTodoist!==true||!plan.projectCommentIds?.length
    ||!plan.comments.some(item=>item.kind==="project")
    ||deliveryReceipts.some(item=>item.key.sk!=="COMPLETED"
      ||!(["selected-only","shared with protected state"] as string[]).includes(item.classification)
      ||item.receiptCleanup!=="scrub_identity_refs"||!/^[a-f0-9]{64}$/.test(item.scrubbedDigest||"")))) return false;
  if(!deliveryReceipts.length&&plan.scrubCompletedDeliveryIdentityRefsAfterTombstone===true) return false;
  const ids=new Set<string>();
  return plan.comments.every(item=>typeof item.id==="string"&&item.id.length>0&&!ids.has(item.id)
    &&(ids.add(item.id),true)&&(item.kind==="project"||item.kind==="task")&&/^[a-f0-9]{64}$/.test(item.digest));
}
type ErasurePreview = Pick<ErasureOperation, "operationId" | "profile" | "target" | "selectedActions" | "inventory" | "providerSnapshotFingerprint" | "actionPlan">;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function erasurePreviewFingerprint(preview: Omit<ErasurePreview, "operationId">): string {
  const content={version:1,profile:preview.profile,target:preview.target,selectedActions:preview.selectedActions,
    providerSnapshotFingerprint:preview.providerSnapshotFingerprint,inventory:preview.inventory,actionPlan:preview.actionPlan};
  return createHash("sha256").update(canonical(content)).digest("hex");
}
function stateTable(): string {
  const value = process.env.STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("STATE_TABLE_NAME is required");
  return value;
}
function confirmedCompletionProof(operation:ErasureOperation,epoch:number) {
  return {operationId:operation.operationId,profile:operation.profile,taskId:operation.target.taskId,
    deleteCalendar:operation.selectedActions.deleteCalendar===true,eventId:operation.target.eventId,
    calendarId:operation.actionPlan.calendarEvent?.calendarId,
    knownCalendarAliases:operation.actionPlan.knownCalendarAliases,
    knownCalendarAliasesComplete:operation.actionPlan.knownCalendarAliasesComplete,
    projectCommentIds:operation.actionPlan.projectCommentIds,
    confirmationId:operation.confirmationId,previewFingerprint:operation.previewFingerprint,epoch};
}
const defaultFencePollMs=5_000;
const lifecyclePhaseEdges: Record<FencedLifecyclePhase,FencedLifecyclePhase[]>={
  disable_mappings:["disable_mappings","confirm_disabled"],
  confirm_disabled:["confirm_disabled","drain_before_fence"],
  drain_before_fence:["drain_before_fence","install_fence"],
  install_fence:["install_fence","wait_worker_timeout"],
  wait_worker_timeout:["drain_after_timeout"],
  drain_after_timeout:["drain_after_timeout","ready_for_delete"],
  ready_for_delete:["delete"],
  delete:["delete","verify_deletion"],
  verify_deletion:["restore_mappings"],
  restore_mappings:["restore_mappings","confirm_restored"],
  confirm_restored:["confirm_restored","release_fence"],
  release_fence:["release_fence","complete"],
  complete:["complete"],
};

/** Exact preview is immutable after submission; workers use conditional status changes. */
export class ErasureOperationStore {
  #workerAdapters?: ErasureWorkerAdapters;
  /**
   * Worker adapters are privileged process dependencies. Construct a worker-scoped store
   * in trusted service wiring; never accept adapter objects from an HTTP/job request.
   */
  constructor(private readonly db = documentClient, private readonly newConfirmationId = randomUUID,
    workerAdapters?: ErasureWorkerAdapters) {
    this.#workerAdapters=workerAdapters?Object.freeze({
      listWorkerMappings:workerAdapters.listWorkerMappings.bind(workerAdapters),
      disableMappings:workerAdapters.disableMappings.bind(workerAdapters),
      mappingStates:workerAdapters.mappingStates.bind(workerAdapters),
      inspectFence:workerAdapters.inspectFence.bind(workerAdapters),
      beginFence:workerAdapters.beginFence.bind(workerAdapters),
      restoreMappings:workerAdapters.restoreMappings.bind(workerAdapters),
      finishFence:workerAdapters.finishFence.bind(workerAdapters),
      verifyDeletion:workerAdapters.verifyDeletion.bind(workerAdapters),
      readFreshSnapshot:workerAdapters.readFreshSnapshot.bind(workerAdapters),
      readMappingStates:workerAdapters.readMappingStates.bind(workerAdapters),
      ...(workerAdapters.executeDeletionStep ? {executeDeletionStep:workerAdapters.executeDeletionStep.bind(workerAdapters)} : {}),
    }):undefined;
  }

  #worker(): ErasureWorkerAdapters {
    if(!this.#workerAdapters) throw new Error("Trusted erasure worker adapters are not configured");
    return this.#workerAdapters;
  }

  async issueConfirmation(preview: ErasurePreview, lifetimeMs = 5 * 60_000): Promise<{
    confirmationId: string; previewFingerprint: string; expiresAt: number;
  }> {
    if (!preview.operationId || !/^[a-f0-9]{64}$/.test(preview.providerSnapshotFingerprint)
      || !validActionPlan(preview.actionPlan,preview)
      || preview.selectedActions.deleteTodoist !== true
      || preview.selectedActions.deleteCalendar !== preview.target.deleteCalendar
      || (preview.target.deleteCalendar && !preview.target.eventId)) throw new Error("Invalid erasure operation preview");
    const now=Date.now();
    if(Buffer.byteLength(JSON.stringify({profile:preview.profile,target:preview.target,selectedActions:preview.selectedActions,inventory:preview.inventory}))>300_000)
      throw new Error("Exact inventory is too large for one durable operation; manual review is required");
    const confirmationId=this.newConfirmationId();
    const previewFingerprint=erasurePreviewFingerprint(preview);
    const expiresAt=now+lifetimeMs;
    await this.db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:stateTable(),Item:{
      ...confirmationKey(preview.operationId),operationId:preview.operationId,confirmationId,previewFingerprint,
      preview:{profile:preview.profile,target:preview.target,selectedActions:preview.selectedActions,
        providerSnapshotFingerprint:preview.providerSnapshotFingerprint,inventory:preview.inventory,actionPlan:preview.actionPlan},
      // Bind readiness to the exact confirmation issuance. A preview minted while
      // disabled must never become executable after a deployment flag flip.
      executionReadyAtIssue:erasureExecutionEnabled(),
      status:"issued",expiresAt,createdAt:new Date(now).toISOString(),
    },ConditionExpression:"attribute_not_exists(pk)"}}]}));
    return {confirmationId,previewFingerprint,expiresAt};
  }

  async getIssuedPreview(operationId: string, confirmationId: string): Promise<{
    profile: Profile; target: ErasureOperation["target"]; selectedActions: ErasureOperation["selectedActions"];
    providerSnapshotFingerprint: string; inventory: ErasureOperation["inventory"]; actionPlan: ErasureActionPlan; previewFingerprint: string;
    executionReadyAtIssue: boolean;
  } | undefined> {
    const result=await this.db.send(new GetCommand({TableName:stateTable(),Key:confirmationKey(operationId),ConsistentRead:true}));
    const item=result.Item;
    if(!item || item.status!=="issued" || item.operationId!==operationId || item.confirmationId!==confirmationId
      || typeof item.expiresAt!=="number" || item.expiresAt<=Date.now() || !item.preview) return undefined;
    const preview=item.preview as {profile:Profile;target:ErasureOperation["target"];
      selectedActions:ErasureOperation["selectedActions"];providerSnapshotFingerprint:string;inventory:ErasureOperation["inventory"];actionPlan:ErasureActionPlan};
    if(!validActionPlan(preview.actionPlan,preview)
      ||erasurePreviewFingerprint(preview)!==item.previewFingerprint) return undefined;
    return {...preview,previewFingerprint:item.previewFingerprint as string,
      executionReadyAtIssue:item.executionReadyAtIssue===true};
  }

  async create(operation: ErasureOperation): Promise<void> {
    const now=Date.now();
    if (operation.status !== "previewed" || !operation.operationId || !operation.previewFingerprint
      || operation.lifecycle!==undefined
      || !validActionPlan(operation.actionPlan,operation)
      || !/^[a-f0-9]{64}$/.test(operation.providerSnapshotFingerprint)
      || operation.confirmationFingerprint !== operation.previewFingerprint
      || operation.selectedActions.deleteTodoist !== true
      || operation.selectedActions.deleteCalendar !== operation.target.deleteCalendar
      || (operation.target.deleteCalendar && !operation.target.eventId)
      || operation.previewFingerprint !== erasurePreviewFingerprint(operation)) throw new Error("Invalid erasure operation preview");
    await this.db.send(new TransactWriteCommand({TransactItems:[
      {Put:{TableName:stateTable(),Item:{...operation,...operationKey(operation.operationId)},ConditionExpression:"attribute_not_exists(pk)"}},
      {Update:{TableName:stateTable(),Key:confirmationKey(operation.operationId),
        UpdateExpression:"SET #status=:consumed, consumedAt=:now, consumedBy=:operationId",
        ConditionExpression:"#status=:issued AND confirmationId=:confirmationId AND previewFingerprint=:fingerprint AND expiresAt>:now",
        ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":issued":"issued",":consumed":"consumed",
          ":confirmationId":operation.confirmationId,":fingerprint":operation.previewFingerprint,":operationId":operation.operationId,":now":now}}},
    ]}));
  }

  async get(id: string): Promise<ErasureOperation | undefined> {
    const result=await this.db.send(new GetCommand({TableName:stateTable(),Key:operationKey(id),ConsistentRead:true}));
    return result.Item as ErasureOperation|undefined;
  }

  async transition(id: string, expected: ErasureOperationStatus, next: ErasureOperationStatus,
    patch: Partial<Pick<ErasureOperation,"requestId"|"result"|"error">> = {}): Promise<void> {
    const current=await this.get(id);
    if(!current||current.status!==expected) throw new Error("Erasure operation state changed; refresh before continuing");
    if(next==="fencing" || current.lifecycle)
      throw new Error("Fenced lifecycle status transitions must use the action-verifying lifecycle service");
    const updated=advanceErasureOperation(current,next,patch);
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:next, updatedAt=:updatedAt"+(patch.error!==undefined?", error=:error":"")
        +(patch.result!==undefined?", #result=:result":"")+(patch.requestId!==undefined?", requestId=:requestId":""),
      ConditionExpression:"#status=:expected AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status",...(patch.result!==undefined?{"#result":"result"}:{})},
      ExpressionAttributeValues:{":expected":expected,":next":next,":updatedAt":updated.updatedAt,":fingerprint":current.previewFingerprint,
        ...(patch.error!==undefined?{":error":patch.error}:{}),...(patch.result!==undefined?{":result":patch.result}:{}),
        ...(patch.requestId!==undefined?{":requestId":patch.requestId}:{})}}));
  }

  async startFencedLifecycle(id: string, timeoutSeconds: number): Promise<void> {
    if(!Number.isInteger(timeoutSeconds) || timeoutSeconds<1) throw new Error("Invalid worker timeout");
    const current=await this.get(id);
    if(!current || current.status!=="queued" || current.providerDeletionReady!==true || current.lifecycle
      || !current.confirmationId || current.confirmationFingerprint!==current.previewFingerprint
      || current.previewFingerprint!==erasurePreviewFingerprint(current))
      throw new Error("Erasure operation is not ready to begin fencing");
    const epochResult=await this.db.send(new GetCommand({TableName:stateTable(),
      Key:{pk:`ERASURE#${current.profile}`,sk:"EPOCH"},ConsistentRead:true}));
    const storedEpoch=epochResult.Item?.epoch;
    if(storedEpoch!==undefined&&(!Number.isSafeInteger(storedEpoch)||storedEpoch<0))
      throw new ErasureGateDriftError();
    const mappings=await this.#worker().listWorkerMappings();
    if(!mappings.length || mappings.some(item=>!item.id || !["Enabled","Disabled"].includes(item.state)
      || !item.eventSourceArn.includes(":sqs:")) || new Set(mappings.map(item=>item.id)).size!==mappings.length)
      throw new Error("Worker SQS mapping inventory is missing, ambiguous, or invalid");
    const mappingIds=mappings.map(item=>item.id).sort();
    const lifecycle:FencedLifecycle={phase:"disable_mappings",mappingIds,
      enabledMappingIds:mappings.filter(item=>item.state==="Enabled").map(item=>item.id).sort(),
      timeoutSeconds,pollMs:defaultFencePollMs,nextRunAt:Date.now(),evidence:{}};
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:fencing, lifecycle=:lifecycle, updatedAt=:updatedAt",
      ConditionExpression:"#status=:queued AND attribute_not_exists(lifecycle) AND providerDeletionReady=:ready AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":queued":"queued",":fencing":"fencing",
        ":ready":true,":lifecycle":lifecycle,":updatedAt":new Date(Date.now()).toISOString(),":fingerprint":current.previewFingerprint}}));
  }

  /** Execute one trusted adapter action/readback and persist its opaque receipt with a CAS. */
  async advanceFencedLifecycle(id: string): Promise<{
    phase: FencedLifecyclePhase; nextRunAt: number; status: ErasureOperationStatus; waiting: boolean;
  }> {
    const operation=await this.get(id);
    const current=operation?.lifecycle;
    if(!operation || !current || !["fencing","deleting","verifying"].includes(operation.status))
      throw new Error("Operation is not in a resumable fenced lifecycle state");
    if(operation.providerDeletionReady!==true) throw new Error("Erasure executor is disabled; the active fence must remain for break-glass review");
    const adapters=this.#worker();
    const now=Date.now();
    if(current.nextRunAt>now) return {phase:current.phase,nextRunAt:current.nextRunAt,status:operation.status,waiting:true};
    let next:FencedLifecycle;
    let nextStatus=operation.status;
    try {
      switch(current.phase) {
        case "disable_mappings":
          await adapters.disableMappings(current.mappingIds);
          next=this.#advance(operation.operationId,current,"confirm_disabled",now,"mappingsDisableRequested");
          break;
        case "confirm_disabled": {
          const states=await adapters.mappingStates(current.mappingIds);
          if(current.mappingIds.some(mappingId=>states.find(item=>item.id===mappingId)?.state!=="Disabled"))
            next={...current,nextRunAt:now+current.pollMs};
          else next=this.#advance(operation.operationId,current,"drain_before_fence",now,"mappingsDisabled");
          break;
        }
        case "drain_before_fence": {
          const {leases}=await adapters.inspectFence(operation.profile);
          if(leases.length) next={...current,nextRunAt:now+current.pollMs};
          else next=this.#advance(operation.operationId,current,"install_fence",now,"preFenceDrain");
          break;
        }
        case "install_fence":
          await adapters.beginFence(operation.profile,operation.operationId);
          next=this.#advance(operation.operationId,current,"wait_worker_timeout",now,"fenceInstalled");
          next.nextRunAt=now+current.timeoutSeconds*1000+2000;
          break;
        case "wait_worker_timeout":
          next=this.#advance(operation.operationId,current,"drain_after_timeout",now,"workerTimeoutElapsed");
          break;
        case "drain_after_timeout": {
          const {fence,leases}=await adapters.inspectFence(operation.profile);
          if(fence?.operationId!==operation.operationId)
            throw new Error("Profile fence is missing or owned by a different erasure operation");
          if(leases.length) next={...current,nextRunAt:now+current.pollMs};
          else {
            next=this.#advance(operation.operationId,current,"ready_for_delete",now,"postTimeoutDrain");
            nextStatus="deleting";
          }
          break;
        }
        case "delete": {
          if(!adapters.executeDeletionStep) throw new Error("Trusted erasure deletion adapter is not configured");
          if(current.deletionProgress?.attempt) {
            const reviewAt=current.deletionProgress.attempt.startedAt+current.timeoutSeconds*1000+2000;
            if(now<reviewAt) next={...current,nextRunAt:reviewAt};
            else {
              next={...current,nextRunAt:now,lastError:ERASURE_REVIEW_REQUIRED_MESSAGE};
              nextStatus="review_required";
            }
            break;
          }
          const progress=current.deletionProgress
            ||{stage:"comments",commentIndex:0,stateIndex:0,startedAt:now};
          const attempt=await this.#claimDeletionAttempt(operation,current,progress,now);
          operation.lifecycle={...current,deletionProgress:{...progress,attempt}};
          const result=await adapters.executeDeletionStep(operation,operation.lifecycle.deletionProgress!);
          if(result.complete) {
            next=this.#advance(operation.operationId,current,"verify_deletion",now);
            // Preserve the final checkpoint (including the cleared write-ahead
            // claim). Recovery can distinguish completed steps from an uncertain
            // provider acknowledgement without replaying a destructive action.
            next.deletionProgress=result.progress;
          } else next={...current,deletionProgress:result.progress,nextRunAt:now};
          break;
        }
        case "verify_deletion": {
          const result=await adapters.verifyDeletion(operation);
          if(!result.providersAbsent||!result.stateAbsent) throw new ErasureGateDriftError();
          next=this.#advance(operation.operationId,current,"restore_mappings",now,"providerDeletionVerified");
          nextStatus="verifying";
          break;
        }
        case "ready_for_delete":
        case "complete":
          return {phase:current.phase,nextRunAt:current.nextRunAt,status:operation.status,waiting:false};
        case "restore_mappings":
          await adapters.restoreMappings(current.enabledMappingIds);
          next=this.#advance(operation.operationId,current,"confirm_restored",now);
          break;
        case "confirm_restored": {
          const states=await adapters.mappingStates(current.mappingIds);
          const originallyEnabled=new Set(current.enabledMappingIds);
          if(current.mappingIds.some(mappingId=>states.find(item=>item.id===mappingId)?.state!==
            (originallyEnabled.has(mappingId)?"Enabled":"Disabled"))) next={...current,nextRunAt:now+current.pollMs};
          else next=this.#advance(operation.operationId,current,"release_fence",now,"mappingsRestored");
          break;
        }
        case "release_fence": {
          const {fence,leases}=await adapters.inspectFence(operation.profile);
          if(leases.length) next={...current,nextRunAt:now+current.pollMs};
          else if(fence && fence.operationId!==operation.operationId) throw new Error("A different operation owns the profile fence");
          else if(!fence) throw new ErasureGateDriftError();
          else {
            const finalRead=await adapters.verifyDeletion(operation);
            if(!finalRead.providersAbsent||!finalRead.stateAbsent) throw new ErasureGateDriftError();
            if(fence) {
              await this.#finishAndEraseOperation(operation);
              return {phase:"complete",nextRunAt:now,status:"succeeded",waiting:false};
            }
            next=this.#advance(operation.operationId,current,"complete",now,"fenceReleased");
            nextStatus="succeeded";
          }
          break;
        }
      }
    } catch(error) {
      if(error instanceof ErasureDeletionAttemptClaimError)
        return {phase:"delete",nextRunAt:now+current.pollMs,status:operation.status,waiting:true};
      // Once provider deletion has been attempted, even a transient-looking
      // failure may mean the remote mutation succeeded but its response was
      // lost. Never retry the same destructive step from an old checkpoint.
      // Persist an actionable, fenced review state instead of silently
      // rescheduling. Ordinary pre-deletion and mapping-restore polling keep
      // their existing retry behaviour.
      const ambiguousProviderWrite=operation.status==="deleting"
        &&(current.phase==="delete"||current.phase==="verify_deletion");
      if(error instanceof ErasureGateDriftError||error instanceof ErasureReplayUnavailableError||ambiguousProviderWrite) {
        next={...(operation.lifecycle||current),nextRunAt:now,lastError:ERASURE_REVIEW_REQUIRED_MESSAGE};
        nextStatus="review_required";
      } else {
        next={...(operation.lifecycle||current),nextRunAt:now+current.pollMs,
          lastError:error instanceof Error?error.message:String(error)};
      }
    }
    await this.#persistLifecycle(operation,next,nextStatus,now);
    return {phase:next.phase,nextRunAt:next.nextRunAt,status:nextStatus,waiting:next.nextRunAt>now};
  }

  async beginDeletion(id:string):Promise<void> {
    const operation=await this.get(id);
    const current=operation?.lifecycle;
    if(!operation||operation.providerDeletionReady!==true||operation.status!=="deleting"||current?.phase!=="ready_for_delete")
      throw new Error("Erasure operation is no longer at the deletion gate");
    await this.assertReadyForDelete(id);
    const now=Date.now();
    const next=this.#advance(operation.operationId,current,"delete",now,"deletionStarted");
    next.deletionProgress={stage:"comments",commentIndex:0,stateIndex:0,startedAt:now};
    await this.#persistLifecycle(operation,next,"deleting",now);
  }

  async assertReadyForDelete(id: string): Promise<void> {
    const operation=await this.get(id);
    if(!operation) throw new Error("Erasure operation was not found");
    const reader=this.#worker();
    const [freshSnapshot,mappingStates,fenceState]=await Promise.all([
      reader.readFreshSnapshot(operation),reader.readMappingStates(operation.lifecycle?.mappingIds??[]),reader.inspectFence(operation.profile),
    ]);
    const lifecycle=operation.lifecycle;
    const evidence=lifecycle?.evidence;
    const required: FencedEvidenceKey[]=["mappingsDisableRequested","mappingsDisabled","preFenceDrain","fenceInstalled","workerTimeoutElapsed","postTimeoutDrain"];
    const receipts=required.map(key=>evidence?.[key]);
    const expectedMappingIds=lifecycle?.mappingIds??[];
    const currentMappings=new Map(mappingStates.map(mapping=>[mapping.id,mapping.state]));
    const mappingsStillDisabled=expectedMappingIds.length>0 && currentMappings.size===expectedMappingIds.length
      &&expectedMappingIds.every(mappingId=>currentMappings.get(mappingId)==="Disabled");
    const validReceipts=receipts.every((receipt,index)=>receipt?.operationId===operation.operationId
      && receipt.phase===required[index] && /^[0-9a-f-]{36}$/i.test(receipt.receiptId));
    const times=receipts.map(receipt=>receipt?.completedAt);
    if(operation.providerDeletionReady!==true || operation.status!=="deleting" || lifecycle?.phase!=="ready_for_delete"
      || !operation.confirmationId || operation.confirmationFingerprint!==operation.previewFingerprint
      || operation.previewFingerprint!==erasurePreviewFingerprint(operation)
      || operation.previewFingerprint!==erasurePreviewFingerprint(freshSnapshot)
      || Boolean(freshSnapshot.blockers?.length)
      || !mappingsStillDisabled || fenceState.fence?.operationId!==operation.operationId || fenceState.leases.length!==0
      || !validReceipts || times.some((time,index)=>!Number.isFinite(time)
        || (index>0 && (time as number)<(times[index-1] as number)))
      || (times[4] as number)<(times[3] as number)+lifecycle.timeoutSeconds*1000+2000)
      throw new ErasureGateDriftError();
    const epochResult=await this.db.send(new GetCommand({TableName:stateTable(),
      Key:{pk:`ERASURE#${operation.profile}`,sk:"EPOCH"},ConsistentRead:true}));
    const epoch=epochResult.Item?.epoch;
    if(typeof epoch!=="number"||!Number.isSafeInteger(epoch)||epoch<1)throw new ErasureGateDriftError();
    if(!operation.actionPlan.projectCommentIds?.length)
      throw new ErasureGateDriftError();
  }

  /** Stop a fenced operation durably when its action-time deletion gate has drifted. */
  async markReviewRequired(id: string): Promise<void> {
    const operation=await this.get(id);
    if(!operation || operation.status!=="deleting" || operation.lifecycle?.phase!=="ready_for_delete")
      throw new Error("Erasure operation is no longer at the deletion review gate");
    const message=ERASURE_REVIEW_REQUIRED_MESSAGE;
    const now=new Date().toISOString();
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:reviewRequired, #error=:error, updatedAt=:updatedAt, lifecycle.#lastError=:error",
      ConditionExpression:"#status=:deleting AND lifecycle.#phase=:ready AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status","#phase":"phase","#lastError":"lastError","#error":"error"},
      ExpressionAttributeValues:{":deleting":"deleting",":reviewRequired":"review_required",":ready":"ready_for_delete",
        ":error":message,":updatedAt":now,":fingerprint":operation.previewFingerprint}}));
  }

  /** A queued operation blocked by replay readiness has no fence to recover. */
  async markQueuedReplayBlocked(id:string):Promise<void> {
    const operation=await this.get(id);
    if(!operation||operation.status!=="queued"||operation.lifecycle)
      throw new Error("Operation is no longer a queued, unfenced erasure");
    const now=new Date().toISOString();
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:reviewRequired, #error=:error, updatedAt=:updatedAt",
      ConditionExpression:"#status=:queued AND attribute_not_exists(lifecycle) AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status","#error":"error"},
      ExpressionAttributeValues:{":reviewRequired":"review_required",":queued":"queued",
        ":error":ERASURE_REVIEW_REQUIRED_MESSAGE,":updatedAt":now,":fingerprint":operation.previewFingerprint}}));
  }

  /** Freeze an active execution when the deployment switch or durable readiness is revoked. */
  async markExecutionDisabledReviewRequired(id:string):Promise<void> {
    const operation=await this.get(id);
    const lifecycle=operation?.lifecycle;
    if(!operation||!lifecycle||!["fencing","deleting","verifying"].includes(operation.status)
      ||(erasureExecutionEnabled()&&operation.providerDeletionReady===true))
      throw new Error("Operation is not an active execution with a revoked readiness gate");
    const message=ERASURE_REVIEW_REQUIRED_MESSAGE;
    const now=new Date().toISOString();
    // Preserve the exact readiness state observed before the CAS. In particular,
    // deployment revocation must also freeze operations that remain provider-ready.
    const readinessCondition=operation.providerDeletionReady===undefined
      ?"attribute_not_exists(providerDeletionReady)"
      :"providerDeletionReady=:observedReady";
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:reviewRequired, #error=:error, updatedAt=:updatedAt, lifecycle.#lastError=:error",
      ConditionExpression:`#status=:status AND lifecycle.#phase=:phase AND ${readinessCondition} AND previewFingerprint=:fingerprint`,
      ExpressionAttributeNames:{"#status":"status","#phase":"phase","#lastError":"lastError","#error":"error"},
      ExpressionAttributeValues:{":status":operation.status,":phase":lifecycle.phase,
        ...(operation.providerDeletionReady===undefined?{}:{":observedReady":operation.providerDeletionReady}),
        ":reviewRequired":"review_required",":error":message,":updatedAt":now,":fingerprint":operation.previewFingerprint}}));
  }

  #advance(operationId:string,current: FencedLifecycle, phase: FencedLifecyclePhase, now: number,
    evidenceKey?: FencedEvidenceKey): FencedLifecycle {
    const evidence={...current.evidence};
    if(evidenceKey) evidence[evidenceKey]={operationId,phase:evidenceKey,receiptId:randomUUID(),completedAt:now};
    const next={...current,phase,nextRunAt:now,evidence};
    delete next.lastError;
    return next;
  }

  async #claimDeletionAttempt(operation:ErasureOperation,current:FencedLifecycle,
    progress:ErasureDeletionProgress,now:number):Promise<{id:string;startedAt:number}> {
    const attempt={id:randomUUID(),startedAt:now};
    try {
      await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(operation.operationId),
        UpdateExpression:"SET lifecycle.#progress.#attempt=:attempt, updatedAt=:updatedAt",
        ConditionExpression:"#status=:deleting AND lifecycle.#phase=:delete AND lifecycle.#progress.#stage=:stage AND lifecycle.#progress.#commentIndex=:commentIndex AND lifecycle.#progress.#stateIndex=:stateIndex"
          +(progress.finalCommentIndex===undefined?" AND attribute_not_exists(lifecycle.#progress.#finalCommentIndex)"
            :" AND lifecycle.#progress.#finalCommentIndex=:finalCommentIndex")
          +" AND attribute_not_exists(lifecycle.#progress.#attempt) AND providerDeletionReady=:ready AND previewFingerprint=:fingerprint",
        ExpressionAttributeNames:{"#status":"status","#phase":"phase","#progress":"deletionProgress",
          "#attempt":"attempt","#stage":"stage","#commentIndex":"commentIndex","#stateIndex":"stateIndex",
          "#finalCommentIndex":"finalCommentIndex"},
        ExpressionAttributeValues:{":deleting":"deleting",":delete":"delete",":stage":progress.stage,
          ":commentIndex":progress.commentIndex,":stateIndex":progress.stateIndex,
          ...(progress.finalCommentIndex===undefined?{}:{":finalCommentIndex":progress.finalCommentIndex}),
          ":attempt":attempt,
          ":updatedAt":new Date(now).toISOString(),":ready":true,":fingerprint":operation.previewFingerprint}}));
    } catch(error) {
      if((error as {name?:string})?.name==="ConditionalCheckFailedException")
        throw new ErasureDeletionAttemptClaimError();
      throw error;
    }
    return attempt;
  }

  async #persistLifecycle(operation: ErasureOperation, candidate: FencedLifecycle,
    nextStatus: ErasureOperationStatus, now: number): Promise<void> {
    const current=operation.lifecycle;
    // Verification previously had no same-phase edge. Permit it ONLY when
    // an ambiguous provider readback permanently transitions to manual review.
    // Do not allow an ordinary verify_deletion polling/retry loop.
    const terminalVerifyReview=current?.phase==="verify_deletion"
      &&candidate.phase==="verify_deletion"&&operation.status==="deleting"
      &&nextStatus==="review_required";
    if(!current || (!lifecyclePhaseEdges[current.phase].includes(candidate.phase)&&!terminalVerifyReview)
      || JSON.stringify(current.mappingIds)!==JSON.stringify(candidate.mappingIds)
      || JSON.stringify(current.enabledMappingIds)!==JSON.stringify(candidate.enabledMappingIds)
      || current.timeoutSeconds!==candidate.timeoutSeconds || current.pollMs!==candidate.pollMs)
      throw new Error("Invalid fenced lifecycle transition or immutable mapping inventory change");
    const required=({
      "disable_mappings->confirm_disabled":"mappingsDisableRequested",
      "confirm_disabled->drain_before_fence":"mappingsDisabled",
      "drain_before_fence->install_fence":"preFenceDrain",
      "install_fence->wait_worker_timeout":"fenceInstalled",
      "wait_worker_timeout->drain_after_timeout":"workerTimeoutElapsed",
      "drain_after_timeout->ready_for_delete":"postTimeoutDrain",
      "ready_for_delete->delete":"deletionStarted",
      "verify_deletion->restore_mappings":"providerDeletionVerified",
      "confirm_restored->release_fence":"mappingsRestored",
      "release_fence->complete":"fenceReleased",
    } as Partial<Record<string,FencedEvidenceKey>>)[`${current.phase}->${candidate.phase}`];
    for(const key of Object.keys(current.evidence) as FencedEvidenceKey[])
      if(JSON.stringify(candidate.evidence[key])!==JSON.stringify(current.evidence[key]))
        throw new Error("Persisted lifecycle receipts cannot be changed or removed");
    for(const key of Object.keys(candidate.evidence) as FencedEvidenceKey[])
      if(current.evidence[key]===undefined && key!==required)
        throw new Error("A lifecycle receipt can only be written by its verified phase action");
    if(required) {
      const receipt=candidate.evidence[required];
      if(!receipt || receipt.operationId!==operation.operationId || receipt.phase!==required
        || !/^[0-9a-f-]{36}$/i.test(receipt.receiptId) || receipt.completedAt<current.nextRunAt || receipt.completedAt>now)
        throw new Error("Lifecycle phase did not produce its required operation-bound receipt");
    }
    const validDelete=operation.status==="fencing"&&current.phase==="drain_after_timeout"
      &&candidate.phase==="ready_for_delete"&&nextStatus==="deleting";
    const validSuccess=operation.status==="verifying"&&current.phase==="release_fence"
      &&candidate.phase==="complete"&&nextStatus==="succeeded";
    const validVerify=operation.status==="deleting"&&current.phase==="verify_deletion"
      &&candidate.phase==="restore_mappings"&&nextStatus==="verifying";
    const validReview=nextStatus==="review_required"&&(
      (operation.status==="deleting"&&["ready_for_delete","delete","verify_deletion"].includes(current.phase))
      ||(operation.status==="verifying"&&current.phase==="release_fence"));
    if(nextStatus!==operation.status&&!validDelete&&!validSuccess&&!validVerify&&!validReview) throw new Error("Invalid lifecycle operation status transition");
    if(current.phase==="delete") {
      const before=current.deletionProgress||{stage:"comments",commentIndex:0,stateIndex:0,startedAt:0};
      const after=candidate.deletionProgress;
      const rank={comments:0,todoist:1,calendar:2,state:3,finalize_comments:4,verify:5} as const;
      if(!after||after.startedAt!==before.startedAt||rank[after.stage]<rank[before.stage]
        ||after.commentIndex<before.commentIndex||after.stateIndex<before.stateIndex
        ||(after.finalCommentIndex??0)<(before.finalCommentIndex??0)
        ||after.commentIndex>operation.actionPlan.comments.length||after.stateIndex>operation.inventory.length
        ||(after.finalCommentIndex??0)>(operation.actionPlan.projectCommentIds?.length??0))
        throw new Error("Deletion progress must advance monotonically within the confirmed inventory");
    }
    if(candidate.nextRunAt<now) throw new Error("Durable next-run time cannot be backdated");
    if(candidate.phase==="wait_worker_timeout"&&candidate.nextRunAt!==
      (candidate.evidence.fenceInstalled?.completedAt??0)+candidate.timeoutSeconds*1000+2000)
      throw new Error("Worker timeout must start at persisted fence installation time");
    const conditionAttempt=current.phase==="delete"&&current.deletionProgress?.attempt;
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(operation.operationId),
      UpdateExpression:"SET #status=:next, lifecycle=:lifecycle, updatedAt=:updatedAt",
      ConditionExpression:"#status=:expected AND lifecycle.#phase=:phase AND providerDeletionReady=:ready AND previewFingerprint=:fingerprint"
        +(conditionAttempt?" AND lifecycle.#progress.#attempt.#attemptId=:attemptId":""),
      ExpressionAttributeNames:{"#status":"status","#phase":"phase",...(conditionAttempt?{"#progress":"deletionProgress",
        "#attempt":"attempt","#attemptId":"id"}:{})},ExpressionAttributeValues:{":expected":operation.status,
        ":next":nextStatus,":phase":current.phase,":ready":true,":lifecycle":candidate,":updatedAt":new Date(now).toISOString(),
        ":fingerprint":operation.previewFingerprint,...(conditionAttempt?{":attemptId":conditionAttempt.id}:{})}}));
  }

  async #finishAndEraseOperation(operation:ErasureOperation):Promise<void> {
    if(operation.previewFingerprint!==erasurePreviewFingerprint(operation)
      ||operation.confirmationFingerprint!==operation.previewFingerprint)
      throw new ErasureGateDriftError();
    const fence=await this.#worker().inspectFence(operation.profile);
    if(fence.fence?.operationId!==operation.operationId||fence.leases.length)
      throw new ErasureGateDriftError();
    const epochResult=await this.db.send(new GetCommand({TableName:stateTable(),
      Key:{pk:`ERASURE#${operation.profile}`,sk:"EPOCH"},ConsistentRead:true}));
    const epoch=epochResult.Item?.epoch;
    if(typeof epoch!=="number"||!Number.isSafeInteger(epoch)||epoch<1)throw new ErasureGateDriftError();
    const proof=confirmedCompletionProof(operation,epoch);
    const command=atomicConfirmedErasureCompletion(proof);
    try {await this.db.send(command);}
    catch {
      try {if(await verifyConfirmedErasureCompletion(proof,this.db))return;}
      catch { /* An uncertain read must leave the operation fenced for review. */ }
      throw new ErasureGateDriftError();
    }
  }
}

export async function enterFencedErasure(input: {
  profile: string; operationId: string; mappings: unknown[]; timeoutSeconds: number;
  disableMappings(mappings: unknown[]): Promise<void>;
  waitForLeaseDrain(): Promise<void>;
  beginFence(profile: string, operationId: string): Promise<void>;
  pause(ms: number): Promise<void>;
}): Promise<void> {
  await input.disableMappings(input.mappings);
  await input.waitForLeaseDrain();
  await input.beginFence(input.profile, input.operationId);
  await input.pause(input.timeoutSeconds * 1000 + 2000);
  await input.waitForLeaseDrain();
}

export async function finishFencedErasure(input: {
  enabledMappingIds: string[];
  restoreMappings(ids: string[]): Promise<void>;
  finishFence(): Promise<void>;
}): Promise<void> {
  // Keep the fence and journal until the original event sources are verified restored.
  await input.restoreMappings(input.enabledMappingIds);
  await input.finishFence();
}
