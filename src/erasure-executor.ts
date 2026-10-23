/** Reusable lifecycle and durable async contract for per-item erasure jobs. */
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";

export type ErasureOperationStatus = "previewed" | "queued" | "fencing" | "deleting" | "verifying" | "succeeded" | "partial_failure" | "review_required";
export type FencedLifecyclePhase = "disable_mappings" | "confirm_disabled" | "drain_before_fence"
  | "install_fence" | "wait_worker_timeout" | "drain_after_timeout" | "ready_for_delete"
  | "restore_mappings" | "confirm_restored" | "release_fence" | "complete";
export interface FencedLifecycle {
  phase: FencedLifecyclePhase;
  mappingIds: string[];
  enabledMappingIds: string[];
  timeoutSeconds: number;
  pollMs: number;
  nextRunAt: number;
  lastError?: string;
  evidence: Partial<Record<FencedEvidenceKey, FencedReceipt>>;
}
export type FencedEvidenceKey = "mappingsDisableRequested" | "mappingsDisabled" | "preFenceDrain" | "fenceInstalled"
  | "workerTimeoutElapsed" | "postTimeoutDrain" | "providerDeletionVerified" | "mappingsRestored" | "fenceReleased";
export interface FencedReceipt { operationId: string; phase: FencedEvidenceKey; receiptId: string; completedAt: number }
export interface ErasureOperation {
  operationId: string;
  profile: Profile;
  target: { taskId: string; eventId?: string; deleteCalendar: boolean };
  previewFingerprint: string;
  providerSnapshotFingerprint: string;
  confirmationFingerprint: string;
  confirmationId: string;
  /** Set only by a future trusted executor release that wires provider deletion and readback. */
  providerDeletionReady?: boolean;
  selectedActions: { deleteTodoist: boolean; deleteCalendar: boolean };
  inventory: Array<{ type: string; key: { pk: string; sk: string }; digest: string; classification: string }>;
  status: ErasureOperationStatus;
  lifecycle?: FencedLifecycle;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  result?: Record<string, unknown>;
  error?: string;
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
  readFreshSnapshot(operation: ErasureOperation): Promise<Omit<ErasurePreview,"operationId">>;
  readMappingStates(ids: string[]): Promise<Array<{ id: string; state: string }>>;
  inspectFence(profile: string): Promise<{ fence?: { operationId?: string }; leases: unknown[] }>;
}
/** Bind these process-trusted adapters when constructing the worker service, never per request. */
export interface ErasureWorkerAdapters extends FencedLifecycleAdapters, ErasureDeletionVerifier, ErasureSnapshotReader {}

export class ErasureGateDriftError extends Error {
  constructor() {
    super("Erasure is not ready: persisted action receipts, confirmation, inventory, or lifecycle changed");
    this.name="ErasureGateDriftError";
  }
}

export const ERASURE_REVIEW_REQUIRED_MESSAGE="Operator break-glass recovery is required. Preserve any protections that remain, inspect the actual profile fence and worker mapping state, and escalate if either is missing, changed, or cannot be verified. Do not start a fresh preview until service admission is restored; this operation cannot be resumed.";

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
type ErasurePreview = Pick<ErasureOperation, "operationId" | "profile" | "target" | "selectedActions" | "inventory" | "providerSnapshotFingerprint">;
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
    providerSnapshotFingerprint:preview.providerSnapshotFingerprint,inventory:preview.inventory};
  return createHash("sha256").update(canonical(content)).digest("hex");
}
function stateTable(): string {
  const value = process.env.STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("STATE_TABLE_NAME is required");
  return value;
}
const defaultFencePollMs=5_000;
const lifecyclePhaseEdges: Record<FencedLifecyclePhase,FencedLifecyclePhase[]>={
  disable_mappings:["disable_mappings","confirm_disabled"],
  confirm_disabled:["confirm_disabled","drain_before_fence"],
  drain_before_fence:["drain_before_fence","install_fence"],
  install_fence:["install_fence","wait_worker_timeout"],
  wait_worker_timeout:["drain_after_timeout"],
  drain_after_timeout:["drain_after_timeout","ready_for_delete"],
  ready_for_delete:["restore_mappings"],
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
        providerSnapshotFingerprint:preview.providerSnapshotFingerprint,inventory:preview.inventory},
      status:"issued",expiresAt,createdAt:new Date(now).toISOString(),
    },ConditionExpression:"attribute_not_exists(pk)"}}]}));
    return {confirmationId,previewFingerprint,expiresAt};
  }

  async getIssuedPreview(operationId: string, confirmationId: string): Promise<{
    profile: Profile; target: ErasureOperation["target"]; selectedActions: ErasureOperation["selectedActions"];
    providerSnapshotFingerprint: string; inventory: ErasureOperation["inventory"]; previewFingerprint: string;
  } | undefined> {
    const result=await this.db.send(new GetCommand({TableName:stateTable(),Key:confirmationKey(operationId),ConsistentRead:true}));
    const item=result.Item;
    if(!item || item.status!=="issued" || item.operationId!==operationId || item.confirmationId!==confirmationId
      || typeof item.expiresAt!=="number" || item.expiresAt<=Date.now() || !item.preview) return undefined;
    const preview=item.preview as {profile:Profile;target:ErasureOperation["target"];
      selectedActions:ErasureOperation["selectedActions"];providerSnapshotFingerprint:string;inventory:ErasureOperation["inventory"]};
    return {...preview,previewFingerprint:item.previewFingerprint as string};
  }

  async create(operation: ErasureOperation): Promise<void> {
    const now=Date.now();
    if (operation.status !== "previewed" || !operation.operationId || !operation.previewFingerprint
      || operation.lifecycle!==undefined
      || operation.providerDeletionReady!==false
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
      ConditionExpression:"#status=:queued AND attribute_not_exists(lifecycle) AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":queued":"queued",":fencing":"fencing",
        ":lifecycle":lifecycle,":updatedAt":new Date(Date.now()).toISOString(),":fingerprint":current.previewFingerprint}}));
  }

  /** Execute one trusted adapter action/readback and persist its opaque receipt with a CAS. */
  async advanceFencedLifecycle(id: string): Promise<{
    phase: FencedLifecyclePhase; nextRunAt: number; status: ErasureOperationStatus; waiting: boolean;
  }> {
    const operation=await this.get(id);
    const current=operation?.lifecycle;
    if(!operation || !current || !["fencing","deleting","verifying"].includes(operation.status))
      throw new Error("Operation is not in a resumable fenced lifecycle state");
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
          else {
            if(fence) await adapters.finishFence(operation.profile,operation.operationId);
            next=this.#advance(operation.operationId,current,"complete",now,"fenceReleased");
            nextStatus="succeeded";
          }
          break;
        }
      }
    } catch(error) {
      next={...current,nextRunAt:now+current.pollMs,lastError:error instanceof Error?error.message:String(error)};
    }
    await this.#persistLifecycle(operation,next,nextStatus,now);
    return {phase:next.phase,nextRunAt:next.nextRunAt,status:nextStatus,waiting:next.nextRunAt>now};
  }

  async markDeletionVerified(id: string): Promise<void> {
    const operation=await this.get(id);
    const current=operation?.lifecycle;
    if(!operation || operation.status!=="deleting" || current?.phase!=="ready_for_delete")
      throw new Error("Erasure is not ready for post-deletion verification");
    const now=Date.now();
    const result=await this.#worker().verifyDeletion(operation);
    if(!result.providersAbsent || !result.stateAbsent) throw new Error("Deletion postflight readback is not clear; retain the profile fence");
    const next=this.#advance(operation.operationId,current,"restore_mappings",now,"providerDeletionVerified");
    await this.#persistLifecycle(operation,next,"verifying",now);
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
    if(operation.status!=="deleting" || lifecycle?.phase!=="ready_for_delete"
      || !operation.confirmationId || operation.confirmationFingerprint!==operation.previewFingerprint
      || operation.previewFingerprint!==erasurePreviewFingerprint(operation)
      || operation.previewFingerprint!==erasurePreviewFingerprint(freshSnapshot)
      || !mappingsStillDisabled || fenceState.fence?.operationId!==operation.operationId || fenceState.leases.length!==0
      || !validReceipts || times.some((time,index)=>!Number.isFinite(time)
        || (index>0 && (time as number)<(times[index-1] as number)))
      || (times[4] as number)<(times[3] as number)+lifecycle.timeoutSeconds*1000+2000)
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

  #advance(operationId:string,current: FencedLifecycle, phase: FencedLifecyclePhase, now: number,
    evidenceKey?: FencedEvidenceKey): FencedLifecycle {
    const evidence={...current.evidence};
    if(evidenceKey) evidence[evidenceKey]={operationId,phase:evidenceKey,receiptId:randomUUID(),completedAt:now};
    const next={...current,phase,nextRunAt:now,evidence};
    delete next.lastError;
    return next;
  }

  async #persistLifecycle(operation: ErasureOperation, candidate: FencedLifecycle,
    nextStatus: ErasureOperationStatus, now: number): Promise<void> {
    const current=operation.lifecycle;
    if(!current || !lifecyclePhaseEdges[current.phase].includes(candidate.phase)
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
      "ready_for_delete->restore_mappings":"providerDeletionVerified",
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
    const validVerify=operation.status==="deleting"&&current.phase==="ready_for_delete"
      &&candidate.phase==="restore_mappings"&&nextStatus==="verifying";
    if(nextStatus!==operation.status&&!validDelete&&!validSuccess&&!validVerify) throw new Error("Invalid lifecycle operation status transition");
    if(candidate.nextRunAt<now) throw new Error("Durable next-run time cannot be backdated");
    if(candidate.phase==="wait_worker_timeout"&&candidate.nextRunAt!==
      (candidate.evidence.fenceInstalled?.completedAt??0)+candidate.timeoutSeconds*1000+2000)
      throw new Error("Worker timeout must start at persisted fence installation time");
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(operation.operationId),
      UpdateExpression:"SET #status=:next, lifecycle=:lifecycle, updatedAt=:updatedAt",
      ConditionExpression:"#status=:expected AND lifecycle.#phase=:phase AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status","#phase":"phase"},ExpressionAttributeValues:{":expected":operation.status,
        ":next":nextStatus,":phase":current.phase,":lifecycle":candidate,":updatedAt":new Date(now).toISOString(),
        ":fingerprint":operation.previewFingerprint}}));
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
