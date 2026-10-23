/** Reusable lifecycle and durable async contract for per-item erasure jobs. */
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";

export type ErasureOperationStatus = "previewed" | "queued" | "fencing" | "deleting" | "verifying" | "succeeded" | "partial_failure";
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
  evidence: {
    mappingsDisableRequestedAt?: number;
    mappingsDisabledAt?: number;
    preFenceDrainAt?: number;
    fenceInstalledAt?: number;
    workerTimeoutElapsedAt?: number;
    postTimeoutDrainAt?: number;
    mappingsRestoredAt?: number;
    fenceReleasedAt?: number;
  };
}
export interface ErasureOperation {
  operationId: string;
  profile: Profile;
  target: { taskId: string; eventId?: string; deleteCalendar: boolean };
  previewFingerprint: string;
  confirmationFingerprint: string;
  confirmationId: string;
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

const transitions: Record<ErasureOperationStatus, ErasureOperationStatus[]> = {
  previewed: ["queued"], queued: ["fencing", "partial_failure"], fencing: ["deleting", "partial_failure"],
  deleting: ["verifying", "partial_failure"], verifying: ["succeeded", "partial_failure"],
  succeeded: [], partial_failure: ["queued"],
};

export function advanceErasureOperation(current: ErasureOperation, status: ErasureOperationStatus,
  patch: Partial<Pick<ErasureOperation, "result" | "error" | "requestId">> = {}, now = new Date().toISOString()): ErasureOperation {
  if (!transitions[current.status].includes(status)) throw new Error(`Invalid erasure operation transition ${current.status} -> ${status}`);
  return { ...current, ...patch, status, updatedAt: now };
}

function operationKey(id: string) { return { pk: `ERASURE_OPERATION#${id}`, sk: "STATE" }; }
function confirmationKey(operationId: string) { return { pk: `ERASURE_CONFIRMATION#${operationId}`, sk: "STATE" }; }
type ErasurePreview = Pick<ErasureOperation, "operationId" | "profile" | "target" | "selectedActions" | "inventory">;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function erasurePreviewFingerprint(preview: Omit<ErasurePreview, "operationId">): string {
  const content={version:1,profile:preview.profile,target:preview.target,selectedActions:preview.selectedActions,inventory:preview.inventory};
  return createHash("sha256").update(canonical(content)).digest("hex");
}
function stateTable(): string {
  const value = process.env.STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("STATE_TABLE_NAME is required");
  return value;
}

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
const lifecycleEvidenceKeys: Array<keyof FencedLifecycle["evidence"]>=["mappingsDisableRequestedAt","mappingsDisabledAt","preFenceDrainAt","fenceInstalledAt",
  "workerTimeoutElapsedAt","postTimeoutDrainAt","mappingsRestoredAt","fenceReleasedAt"];
const phaseEvidence: Partial<Record<`${FencedLifecyclePhase}->${FencedLifecyclePhase}`,keyof FencedLifecycle["evidence"]>>={
  "disable_mappings->confirm_disabled":"mappingsDisableRequestedAt",
  "confirm_disabled->drain_before_fence":"mappingsDisabledAt",
  "drain_before_fence->install_fence":"preFenceDrainAt",
  "install_fence->wait_worker_timeout":"fenceInstalledAt",
  "wait_worker_timeout->drain_after_timeout":"workerTimeoutElapsedAt",
  "drain_after_timeout->ready_for_delete":"postTimeoutDrainAt",
  "confirm_restored->release_fence":"mappingsRestoredAt",
  "release_fence->complete":"fenceReleasedAt",
};
function validateInitialFencedLifecycle(lifecycle: FencedLifecycle): void {
  if(lifecycle.phase!=="disable_mappings" || !lifecycle.mappingIds.length
    || lifecycle.mappingIds.some((id,index)=>!id || lifecycle.mappingIds.indexOf(id)!==index)
    || lifecycle.enabledMappingIds.some((id,index)=>!lifecycle.mappingIds.includes(id)
      || lifecycle.enabledMappingIds.indexOf(id)!==index)
    || !Number.isInteger(lifecycle.timeoutSeconds) || lifecycle.timeoutSeconds<1
    || !Number.isInteger(lifecycle.pollMs) || lifecycle.pollMs<1000 || lifecycle.pollMs>60_000
    || !Number.isFinite(lifecycle.nextRunAt) || lifecycle.nextRunAt<0
    || lifecycleEvidenceKeys.some(key=>lifecycle.evidence?.[key]!==undefined))
    throw new Error("Invalid initial fenced lifecycle");
}
function validateLifecycleAdvance(current: FencedLifecycle, next: FencedLifecycle,
  expectedStatus: ErasureOperationStatus, nextStatus: ErasureOperationStatus, now: number): void {
  if(JSON.stringify(current.mappingIds)!==JSON.stringify(next.mappingIds)
    || JSON.stringify(current.enabledMappingIds)!==JSON.stringify(next.enabledMappingIds)
    || current.timeoutSeconds!==next.timeoutSeconds || current.pollMs!==next.pollMs)
    throw new Error("Fenced lifecycle mapping identity and timeout are immutable");
  if(!lifecyclePhaseEdges[current.phase].includes(next.phase)) throw new Error(`Invalid fenced lifecycle phase ${current.phase} -> ${next.phase}`);
  const edge=`${current.phase}->${next.phase}` as const;
  const requiredEvidence=phaseEvidence[edge];
  for(const key of lifecycleEvidenceKeys) {
    const before=current.evidence?.[key],after=next.evidence?.[key];
    if(before!==after && (key!==requiredEvidence || before!==undefined || !Number.isFinite(after)))
      throw new Error("Fenced lifecycle evidence is immutable outside its verified phase transition");
  }
  if(requiredEvidence && !Number.isFinite(next.evidence?.[requiredEvidence]))
    throw new Error(`Missing persisted evidence for ${current.phase} -> ${next.phase}`);
  if(requiredEvidence) {
    const timestamp=next.evidence[requiredEvidence] as number;
    if(timestamp<current.nextRunAt || timestamp>now) throw new Error("Fenced lifecycle evidence timestamp is outside the current phase window");
  }
  if(next.nextRunAt<now) throw new Error("Fenced lifecycle next-run time cannot be backdated");
  if(next.phase==="wait_worker_timeout" && next.nextRunAt!==(next.evidence.fenceInstalledAt as number)+next.timeoutSeconds*1000+2000)
    throw new Error("Worker timeout must be scheduled from persisted fence installation evidence");
  if(nextStatus!==expectedStatus) {
    const validDelete=expectedStatus==="fencing" && current.phase==="drain_after_timeout"
      && next.phase==="ready_for_delete" && nextStatus==="deleting";
    const validSuccess=expectedStatus==="verifying" && current.phase==="release_fence"
      && next.phase==="complete" && nextStatus==="succeeded";
    if(!validDelete && !validSuccess) throw new Error("Invalid fenced lifecycle operation status transition");
  }
}

/** Exact preview is immutable after submission; workers use conditional status changes. */
export class ErasureOperationStore {
  constructor(private readonly db = documentClient, private readonly newConfirmationId = randomUUID) {}

  async issueConfirmation(preview: ErasurePreview, now = Date.now(), lifetimeMs = 5 * 60_000): Promise<{
    confirmationId: string; previewFingerprint: string; expiresAt: number;
  }> {
    if (!preview.operationId || preview.selectedActions.deleteTodoist !== true
      || preview.selectedActions.deleteCalendar !== preview.target.deleteCalendar
      || (preview.target.deleteCalendar && !preview.target.eventId)) throw new Error("Invalid erasure operation preview");
    const confirmationId=this.newConfirmationId();
    const previewFingerprint=erasurePreviewFingerprint(preview);
    const expiresAt=now+lifetimeMs;
    await this.db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:stateTable(),Item:{
      ...confirmationKey(preview.operationId),operationId:preview.operationId,confirmationId,previewFingerprint,
      status:"issued",expiresAt,createdAt:new Date(now).toISOString(),
    },ConditionExpression:"attribute_not_exists(pk)"}}]}));
    return {confirmationId,previewFingerprint,expiresAt};
  }

  async create(operation: ErasureOperation, now = Date.now()): Promise<void> {
    if (operation.status !== "previewed" || !operation.operationId || !operation.previewFingerprint
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

  async startFencedLifecycle(id: string, lifecycle: FencedLifecycle, now = Date.now()): Promise<void> {
    validateInitialFencedLifecycle(lifecycle);
    const current=await this.get(id);
    if(!current || current.status!=="queued" || current.lifecycle
      || !current.confirmationId || current.confirmationFingerprint!==current.previewFingerprint
      || current.previewFingerprint!==erasurePreviewFingerprint(current))
      throw new Error("Erasure operation is not ready to begin fencing");
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:fencing, lifecycle=:lifecycle, updatedAt=:updatedAt",
      ConditionExpression:"#status=:queued AND attribute_not_exists(lifecycle) AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":queued":"queued",":fencing":"fencing",
        ":lifecycle":lifecycle,":updatedAt":new Date(now).toISOString(),":fingerprint":current.previewFingerprint}}));
  }

  /** CAS one durable fencing phase and optionally its operation status. */
  async saveLifecycle(id: string, expectedStatus: ErasureOperationStatus, expectedPhase: FencedLifecyclePhase,
    lifecycle: FencedLifecycle, nextStatus: ErasureOperationStatus = expectedStatus, now = Date.now()): Promise<void> {
    const current=await this.get(id);
    if(!current || current.status!==expectedStatus || current.lifecycle?.phase!==expectedPhase)
      throw new Error("Erasure lifecycle changed; refresh before continuing");
    validateLifecycleAdvance(current.lifecycle,lifecycle,expectedStatus,nextStatus,now);
    if(!Number.isFinite(lifecycle.nextRunAt) || lifecycle.nextRunAt<0) throw new Error("Invalid durable erasure next-run time");
    if(nextStatus!==expectedStatus && !transitions[expectedStatus].includes(nextStatus))
      throw new Error(`Invalid erasure operation transition ${expectedStatus} -> ${nextStatus}`);
    await this.db.send(new UpdateCommand({TableName:stateTable(),Key:operationKey(id),
      UpdateExpression:"SET #status=:next, lifecycle=:lifecycle, updatedAt=:updatedAt",
      ConditionExpression:"#status=:expected AND lifecycle.#phase=:phase AND previewFingerprint=:fingerprint",
      ExpressionAttributeNames:{"#status":"status","#phase":"phase"},ExpressionAttributeValues:{":expected":expectedStatus,
        ":next":nextStatus,":phase":expectedPhase,":lifecycle":lifecycle,":updatedAt":new Date(now).toISOString(),
        ":fingerprint":current.previewFingerprint}}));
  }
}

export interface FencedLifecycleDependencies {
  now(): number;
  disableMappings(ids: string[]): Promise<void>;
  mappingStates(ids: string[]): Promise<Array<{ id: string; state: string }>>;
  inspectFence(profile: string): Promise<{ fence?: { operationId?: string }; leases: unknown[] }>;
  beginFence(profile: string, operationId: string): Promise<void>;
  restoreMappings(ids: string[]): Promise<void>;
  finishFence(profile: string, operationId: string): Promise<void>;
  save(expectedStatus: ErasureOperationStatus, expectedPhase: FencedLifecyclePhase,
    next: FencedLifecycle, nextStatus?: ErasureOperationStatus): Promise<void>;
}

const defaultFencePollMs=5_000;
function nextPhase(current: FencedLifecycle, phase: FencedLifecyclePhase, now: number,
  patch: Partial<FencedLifecycle> = {}): FencedLifecycle {
  const next={...current,...patch,phase,nextRunAt:now};
  delete next.lastError;
  return next;
}

export function initialFencedLifecycle(input: { mappingIds: string[]; enabledMappingIds: string[]; timeoutSeconds: number }, now=Date.now()): FencedLifecycle {
  const mappingIds=[...new Set(input.mappingIds)].sort();
  const enabledMappingIds=[...new Set(input.enabledMappingIds)].sort();
  if(!mappingIds.length || mappingIds.some(id=>!id) || enabledMappingIds.some(id=>!mappingIds.includes(id))
    || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds<1) throw new Error("Invalid fenced lifecycle mapping inventory");
  return {phase:"disable_mappings",mappingIds,enabledMappingIds,timeoutSeconds:input.timeoutSeconds,
    pollMs:defaultFencePollMs,nextRunAt:now,evidence:{}};
}

/**
 * Perform at most one bounded phase per invocation. All external actions are
 * idempotent or followed by a readback phase so an ambiguous crash is safe to
 * retry. A failure retains the current phase and schedules a durable retry.
 */
export async function advanceFencedLifecycle(input: {
  operation: Pick<ErasureOperation,"operationId"|"profile"|"status"|"lifecycle">;
  dependencies: FencedLifecycleDependencies;
}): Promise<{ phase: FencedLifecyclePhase; nextRunAt: number; status: ErasureOperationStatus; waiting: boolean }> {
  const {operation,dependencies:dep}=input;
  const current=operation.lifecycle;
  if(!current) throw new Error("Fenced lifecycle is not initialized");
  if(operation.status!=="fencing" && operation.status!=="deleting" && operation.status!=="verifying")
    throw new Error("Operation is not in a resumable fenced lifecycle state");
  const now=dep.now();
  if(current.nextRunAt>now) return {phase:current.phase,nextRunAt:current.nextRunAt,status:operation.status,waiting:true};

  let next: FencedLifecycle;
  let nextStatus: ErasureOperationStatus|undefined;
  try {
    switch(current.phase) {
      case "disable_mappings":
        await dep.disableMappings(current.mappingIds);
        next=nextPhase(current,"confirm_disabled",now,{evidence:{...current.evidence,mappingsDisableRequestedAt:now}});
        break;
      case "confirm_disabled": {
        const states=await dep.mappingStates(current.mappingIds);
        if(current.mappingIds.some(id=>states.find(item=>item.id===id)?.state!=="Disabled"))
          next={...current,nextRunAt:now+current.pollMs};
        else next=nextPhase(current,"drain_before_fence",now,{evidence:{...current.evidence,mappingsDisabledAt:now}});
        break;
      }
      case "drain_before_fence": {
        const {leases}=await dep.inspectFence(operation.profile);
        if(leases.length) next={...current,nextRunAt:now+current.pollMs};
        else next=nextPhase(current,"install_fence",now,{evidence:{...current.evidence,preFenceDrainAt:now}});
        break;
      }
      case "install_fence":
        await dep.beginFence(operation.profile,operation.operationId);
        next={...current,phase:"wait_worker_timeout",nextRunAt:now+current.timeoutSeconds*1000+2000};
        next.evidence={...current.evidence,fenceInstalledAt:now};
        delete next.lastError;
        break;
      case "wait_worker_timeout":
        next=nextPhase(current,"drain_after_timeout",now,{evidence:{...current.evidence,workerTimeoutElapsedAt:now}});
        break;
      case "drain_after_timeout": {
        const {leases}=await dep.inspectFence(operation.profile);
        if(leases.length) next={...current,nextRunAt:now+current.pollMs};
        else {
          next=nextPhase(current,"ready_for_delete",now,{evidence:{...current.evidence,postTimeoutDrainAt:now}});
          nextStatus="deleting";
        }
        break;
      }
      case "ready_for_delete":
      case "complete":
        return {phase:current.phase,nextRunAt:current.nextRunAt,status:operation.status,waiting:false};
      case "restore_mappings":
        await dep.restoreMappings(current.enabledMappingIds);
        next=nextPhase(current,"confirm_restored",now);
        break;
      case "confirm_restored": {
        const states=await dep.mappingStates(current.mappingIds);
        const enabled=new Set(current.enabledMappingIds);
        if(current.mappingIds.some(id=>states.find(item=>item.id===id)?.state!==(enabled.has(id)?"Enabled":"Disabled")))
          next={...current,nextRunAt:now+current.pollMs};
        else next=nextPhase(current,"release_fence",now,{evidence:{...current.evidence,mappingsRestoredAt:now}});
        break;
      }
      case "release_fence": {
        const {fence,leases}=await dep.inspectFence(operation.profile);
        if(leases.length) next={...current,nextRunAt:now+current.pollMs};
        else if(fence && fence.operationId!==operation.operationId) throw new Error("A different operation owns the profile fence");
        else {
          // Missing fence means a previous invocation released it and crashed
          // before persisting the phase; treat that ambiguous response safely.
          if(fence) await dep.finishFence(operation.profile,operation.operationId);
          next=nextPhase(current,"complete",now,{evidence:{...current.evidence,fenceReleasedAt:now}});
          nextStatus="succeeded";
        }
        break;
      }
    }
  } catch(error) {
    next={...current,nextRunAt:now+current.pollMs,lastError:error instanceof Error?error.message:String(error)};
  }
  await dep.save(operation.status,current.phase,next,nextStatus);
  return {phase:next.phase,nextRunAt:next.nextRunAt,status:nextStatus??operation.status,waiting:next.nextRunAt>now};
}

export function beginFencedRestoreLifecycle(current: FencedLifecycle, now=Date.now()): FencedLifecycle {
  if(current.phase!=="ready_for_delete") throw new Error("Provider deletion has not reached its fenced lifecycle boundary");
  return nextPhase(current,"restore_mappings",now);
}

/** Require the exact consumed preview plus a fresh readback immediately before provider mutation. */
export function assertErasureReadyForDelete(operation: ErasureOperation,
  freshSnapshot: Omit<ErasurePreview,"operationId">): void {
  const evidence=operation.lifecycle?.evidence;
  const evidenceTimeline=[evidence?.mappingsDisableRequestedAt,evidence?.mappingsDisabledAt,evidence?.preFenceDrainAt,
    evidence?.fenceInstalledAt,evidence?.workerTimeoutElapsedAt,evidence?.postTimeoutDrainAt];
  if(operation.status!=="deleting" || operation.lifecycle?.phase!=="ready_for_delete"
    || !operation.confirmationId || operation.confirmationFingerprint!==operation.previewFingerprint
    || operation.previewFingerprint!==erasurePreviewFingerprint(operation)
    || operation.previewFingerprint!==erasurePreviewFingerprint(freshSnapshot)
    || !Number.isFinite(evidence?.mappingsDisabledAt) || !Number.isFinite(evidence?.preFenceDrainAt)
    || !Number.isFinite(evidence?.mappingsDisableRequestedAt)
    || !Number.isFinite(evidence?.fenceInstalledAt) || !Number.isFinite(evidence?.workerTimeoutElapsedAt)
    || !Number.isFinite(evidence?.postTimeoutDrainAt)
    || evidenceTimeline.some((timestamp,index)=>index>0 && (timestamp as number)<(evidenceTimeline[index-1] as number))
    || (evidence?.workerTimeoutElapsedAt??0)<(evidence?.fenceInstalledAt??0)+operation.lifecycle.timeoutSeconds*1000+2000)
    throw new Error("Erasure is not ready: confirmation, inventory, or fenced lifecycle changed");
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
