import type { SQSHandler, SQSRecord } from "aws-lambda";
import { GetEventSourceMappingCommand, GetFunctionConfigurationCommand, LambdaClient,
  ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand } from "@aws-sdk/client-lambda";
import { documentClient } from "./dynamodb-capacity.js";
import {BatchGetCommand} from "@aws-sdk/lib-dynamodb";
import { ErasureGateDriftError, ErasureOperationStore, type ErasureOperation, type ErasureWorkerAdapters, type FencedMapping } from "./erasure-executor.js";
import {ErasureReplayBlockedError,ErasureReplayUnavailableError} from "./erasure-replay-barrier.js";
import { beginErasureFence, finishErasureFence, inspectErasureFence } from "./erasure-protocol.js";
import { enqueueErasureOperation, enqueueErasureRecovery } from "./erasure-queue.js";
import { ErasureRecoveryService } from "./erasure-recovery.js";
import { recoveryAdapters } from "./erasure-recovery-adapters.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { buildErasurePreview } from "./erasure-preview.js";
import { executeErasureDeletionStep, verifyErasurePostflight } from "./erasure-deletion.js";
import { erasureExecutionEnabled } from "./erasure-readiness.js";
import { inspectConfirmedOrphanOperation } from "./orphan-worker-inspection.js";
import { processOrphanManifestStage } from "./orphan-manifest-stage-worker.js";
import { inspectOrphanPauseRecovery } from "./orphan-pause-recovery-inspection.js";

const lambda=new LambdaClient({});
function targetWorkerFunction(): string {
  const value=process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim();
  if(!value) throw new Error("ERASURE_TARGET_WORKER_FUNCTION_NAME is required");
  return value;
}
function mappingUuid(id: string): string {
  if(!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid worker event-source mapping ID");
  return id;
}
function unavailableDeletionBoundary(): never {
  throw new Error("Provider deletion/readback is not wired into the async fencing worker");
}

const adapters: ErasureWorkerAdapters={
  async listWorkerMappings(): Promise<FencedMapping[]> {
    const rows=[];
    let marker:string|undefined;
    do {
      const page=await lambda.send(new ListEventSourceMappingsCommand({FunctionName:targetWorkerFunction(),MaxItems:100,Marker:marker}));
      rows.push(...(page.EventSourceMappings||[]));
      marker=page.NextMarker;
    } while(marker);
    return rows.filter(row=>row.EventSourceArn?.includes(":sqs:")&&row.UUID).map(row=>({
      id:row.UUID!,state:row.State as "Enabled"|"Disabled",eventSourceArn:row.EventSourceArn!,
    }));
  },
  async disableMappings(ids) {
    await Promise.all(ids.map(async id=>{
      const mapping=await lambda.send(new GetEventSourceMappingCommand({UUID:mappingUuid(id)}));
      if(mapping.State==="Disabled") return;
      if(mapping.State!=="Enabled") throw new Error("Worker mapping is in a transitional state; retry the bounded phase");
      await lambda.send(new UpdateEventSourceMappingCommand({UUID:id,Enabled:false}));
    }));
  },
  async mappingStates(ids) {
    return Promise.all(ids.map(async id=>({id,state:(await lambda.send(new GetEventSourceMappingCommand({UUID:mappingUuid(id)}))).State||"Unknown"})));
  },
  async inspectFence(profile) {
    const result=await inspectErasureFence(profile as ErasureOperation["profile"]);
    return {fence:result.fence?{operationId:typeof result.fence.operationId==="string"?result.fence.operationId:undefined}:undefined,
      leases:result.leases};
  },
  async beginFence(profile,operationId) { await beginErasureFence(profile as ErasureOperation["profile"],operationId); },
  async restoreMappings(ids) {
    await Promise.all(ids.map(async id=>{
      const mapping=await lambda.send(new GetEventSourceMappingCommand({UUID:mappingUuid(id)}));
      if(mapping.State==="Enabled") return;
      if(mapping.State!=="Disabled") throw new Error("Worker mapping is in a transitional state; retry the bounded phase");
      await lambda.send(new UpdateEventSourceMappingCommand({UUID:id,Enabled:true}));
    }));
  },
  async finishFence(profile,operationId) { await finishErasureFence(profile as ErasureOperation["profile"],operationId); },
  async verifyDeletion(operation) {
    return verifyErasurePostflight(operation,{db:documentClient,clients:await defaultProviderClientFactory(operation.profile),
      inspectFence:async profile=>{const value=await inspectErasureFence(profile as ErasureOperation["profile"]);return {fence:value.fence?{operationId:value.fence.operationId as string}:undefined,leases:value.leases};}});
  },
  async readFreshSnapshot(operation) {
    const preview=await buildErasurePreview({profile:operation.profile,taskId:operation.target.taskId,
      ...(operation.target.eventId?{eventId:operation.target.eventId}:{}),deleteCalendar:operation.selectedActions.deleteCalendar},
      {db:documentClient,clients:await defaultProviderClientFactory(operation.profile),
        inspectFence:async profile=>{const value=await inspectErasureFence(profile);return {fence:value.fence?{operationId:value.fence.operationId as string}:undefined,leases:value.leases};},
        newOperationId:()=>operation.operationId,ignoreOperationId:operation.operationId,
        allowFenceOperationId:operation.operationId,allowJournalOperationId:operation.operationId});
    return preview;
  },
  async readMappingStates(ids) { return this.mappingStates(ids); },
  async executeDeletionStep(operation,progress) {
    return executeErasureDeletionStep(operation,progress,{db:documentClient,
      clients:await defaultProviderClientFactory(operation.profile),
      inspectFence:async profile=>{const value=await inspectErasureFence(profile);return {fence:value.fence?{operationId:value.fence.operationId as string}:undefined,leases:value.leases};}});
  },
};
const store=new ErasureOperationStore(documentClient,undefined,adapters);
const recoveryService=new ErasureRecoveryService(recoveryAdapters(true),documentClient,store);

export function parseErasureQueueCommand(record: Pick<SQSRecord,"body">):{kind:"erasure"|"recovery"|"orphan_inspection"|"orphan_manifest_stage"|"orphan_pause_recovery";id:string} {
  let payload:unknown;
  try { payload=JSON.parse(record.body); } catch { throw new Error("Invalid erasure queue message JSON"); }
  if(!payload||typeof payload!=="object"||Array.isArray(payload)) throw new Error("Invalid erasure queue message");
  const value=payload as Record<string,unknown>;
  if(value.version!==1)throw new Error("Invalid erasure queue message protocol version");
  const keys=Object.keys(value).sort().join(",");
  const kind=keys==="operationId,version"?"erasure":keys==="recoveryOperationId,version"?"recovery"
    :keys==="orphanInspectionOperationId,version"?"orphan_inspection"
    :keys==="orphanManifestStageOperationId,version"?"orphan_manifest_stage"
    :keys==="orphanPauseRecoveryOperationId,version"?"orphan_pause_recovery":undefined;
  if(!kind)throw new Error("Invalid erasure queue message schema");
  const id=kind==="erasure"?value.operationId
    :kind==="recovery"?value.recoveryOperationId
    :kind==="orphan_inspection"?value.orphanInspectionOperationId
    :kind==="orphan_manifest_stage"?value.orphanManifestStageOperationId:value.orphanPauseRecoveryOperationId;
  if(typeof id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error("Invalid queue operation ID");
  return {kind,id};
}
/** Legacy parser is deletion-only; recovery payloads must never become deletion commands. */
export function parseErasureQueueRecord(record:Pick<SQSRecord,"body">):string {
  const command=parseErasureQueueCommand(record);
  if(command.kind!=="erasure")throw new Error("Recovery queue command is not an erasure deletion");
  return command.id;
}

/** Process one durable step. The Lambda entrypoint owns all trusted adapters and queue dispatch. */
export async function processErasureOperation(operationId: string): Promise<{
  status: string; phase?: string; nextRunAt?: number; scheduled: boolean;
}> {
  let operation=await store.get(operationId);
  // A successful operation erases its operation/confirmation records. Retried
  // queue deliveries after that atomic cleanup are identity-free no-ops.
  if(!operation) return {status:"succeeded",scheduled:false};
  if(operation.status==="succeeded"||operation.status==="review_required")
    return {status:operation.status,phase:operation.lifecycle?.phase,scheduled:false};
  // Independent execution switch: a persisted approval cannot bypass a
  // revoked deployment-level gate via a queued or delayed SQS delivery.
  if(!erasureExecutionEnabled()||operation.providerDeletionReady!==true) {
    if(operation.lifecycle&&["fencing","deleting","verifying"].includes(operation.status)) {
      await store.markExecutionDisabledReviewRequired(operationId);
      return {status:"review_required",phase:operation.lifecycle.phase,scheduled:false};
    }
    throw new Error("Provider deletion workflow is not enabled for this preview; no worker or fence action was started");
  }
  if(operation.status==="previewed") {
    await store.transition(operationId,"previewed","queued");
    operation=await store.get(operationId);
    if(!operation) throw new Error("Erasure operation disappeared after queue transition");
  }
  if(operation.status==="queued") {
    const target=await lambda.send(new GetFunctionConfigurationCommand({FunctionName:targetWorkerFunction()}));
    const timeoutSeconds=Number(target.Timeout);
    if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1) throw new Error("Target worker timeout could not be verified");
    try {await store.startFencedLifecycle(operationId,timeoutSeconds);}
    catch(error) {
      if(!(error instanceof ErasureReplayUnavailableError)&&!(error instanceof ErasureReplayBlockedError))throw error;
      await store.markQueuedReplayBlocked(operationId);
      console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",event:"operation_step",
        operationId,status:"review_required",phase:"queued",scheduled:false}));
      return {status:"review_required",phase:"queued",scheduled:false};
    }
    await enqueueErasureOperation(operationId);
    return {status:"fencing",phase:"disable_mappings",scheduled:true};
  }
  if(!operation.lifecycle) {
    if(["succeeded","partial_failure"].includes(operation.status)) return {status:operation.status,scheduled:false};
    throw new Error("Active erasure operation has no fenced lifecycle");
  }
  if(operation.lifecycle.phase==="ready_for_delete") {
    try { await store.beginDeletion(operationId); }
    catch(error) {
      if(!(error instanceof ErasureGateDriftError)&&!(error instanceof ErasureReplayUnavailableError)) throw error;
      await store.markReviewRequired(operationId);
      return {status:"review_required",phase:operation.lifecycle.phase,scheduled:false};
    }
    await enqueueErasureOperation(operationId);
    return {status:"deleting",phase:"delete",scheduled:true};
  }
  if(operation.lifecycle.phase==="complete") return {status:operation.status,phase:operation.lifecycle.phase,scheduled:false};

  const result=await store.advanceFencedLifecycle(operationId);
  if(result.phase==="ready_for_delete") {
    try { await store.beginDeletion(operationId); }
    catch(error) {
      if(!(error instanceof ErasureGateDriftError)&&!(error instanceof ErasureReplayUnavailableError)) throw error;
      await store.markReviewRequired(operationId);
      return {status:"review_required",phase:result.phase,scheduled:false};
    }
    await enqueueErasureOperation(operationId);
    return {status:"deleting",phase:"delete",scheduled:true};
  }
  if(result.phase!=="complete"&&result.status!=="succeeded"&&result.status!=="review_required")
    await enqueueErasureOperation(operationId,result.nextRunAt);
  return {...result,scheduled:result.phase!=="complete"&&result.status!=="succeeded"&&result.status!=="review_required"};
}

const WATCHDOG_PROFILES=["antonio","home","work"] as const;
const WATCHDOG_UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * This runs independently of the disabled source SQS trigger (EventBridge
 * invokes the erasure worker itself). Enumerates exactly three known fence
 * records; never scans, replays deletions or bypasses the existing recovery CAS.
 */
export async function inspectStuckErasureRecovery():Promise<{fenced:number;queued:number;completed:number;inProgress:number;blocked:number}> {
  const table=process.env.STATE_TABLE_NAME;
  if(!table)throw new Error("STATE_TABLE_NAME is required for erasure recovery watchdog");
  const response=await documentClient.send(new BatchGetCommand({RequestItems:{
    [table]:{Keys:WATCHDOG_PROFILES.map(profile=>({pk:`ERASURE#${profile}`,sk:"FENCE"})),
      ConsistentRead:true},
  }}));
  if(response.UnprocessedKeys&&Object.keys(response.UnprocessedKeys).length)
    throw new Error("Incomplete erasure fence inventory; no automatic recovery attempted");
  const fences=response.Responses?.[table]||[];
  let queued=0,completed=0,inProgress=0,blocked=0;
  for(const fence of fences) {
    const profile=String(fence.pk||"").replace(/^ERASURE#/,"");
    const id=fence.operationId;
    if(!WATCHDOG_PROFILES.includes(profile as typeof WATCHDOG_PROFILES[number])
       ||typeof id!=="string"||!WATCHDOG_UUID.test(id)) {
      blocked++;
      console.warn(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
        event:"recovery_watchdog_blocked",profile:WATCHDOG_PROFILES.includes(profile as typeof WATCHDOG_PROFILES[number])?profile:"unknown",
        reason:"invalid_fence_owner"}));
      continue;
    }
    try {
      const operation=await store.get(id);
      if(!operation||operation.profile!==profile) {
        blocked++;
        console.warn(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
          event:"recovery_watchdog_blocked",operationId:id,profile,reason:"missing_or_wrong_operation"}));
        continue;
      }
      if(operation.recovery&&["queued","restoring","verifying"].includes(operation.recovery.status)) {
        // Idempotent recovery redelivery if a previous SQS send was lost.
        await enqueueErasureRecovery(id);
        queued++;
        continue;
      }
      if(operation.status!=="review_required"||operation.recovery)continue;
       // Post-write completion is considered before pre-write recovery. It is
       // limited to the immutable known-target manifest and never replays a
       // Todoist/Calendar delete. The existing EventBridge watchdog is the
       // scheduler; no new queue or per-operation approval is required.
       const postWrite=await recoveryService.completePostWriteIfSafe(id);
       if(postWrite.status==="completed") {
         completed++;
         console.info(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
           event:"postwrite_completion_completed",operationId:id,profile}));
         continue;
       }
       if(postWrite.status==="in_progress") {
         inProgress++;
         console.info(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
           event:"postwrite_state_cleanup_progress",operationId:id,profile,blockerCount:postWrite.blockers.length}));
         continue;
       }
       if(postWrite.status==="blocked") {
         blocked++;
         console.warn(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
           event:"postwrite_completion_blocked",operationId:id,profile,blockerCount:postWrite.blockers.length}));
         continue;
       }
       const result=await recoveryService.startAutomaticPreWriteRecovery(id);
      if(result.queued) {
        await enqueueErasureRecovery(id);
        queued++;
        console.info(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
          event:"recovery_watchdog_queued",operationId:id,profile,mode:"verified_pre_write"}));
      } else {
        blocked++;
        console.warn(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
          event:"recovery_watchdog_blocked",operationId:id,profile,
          reason:"independent_evidence_blocked",blockerCount:result.blockerCount}));
      }
    } catch(error) {
      blocked++;
      // A provider, IAM, or DDB failure must never become permission to
      // release a fence. Alert through state monitoring, not via a retry loop.
      console.error(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
        event:"recovery_watchdog_failed",operationId:id,profile,
        errorType:error instanceof Error?error.name:"UnknownError"}));
    }
  }
  return {fenced:fences.length,queued,completed,inProgress,blocked};
}

/** Isolated, separately bounded Lambda runtime; never shares SQS-worker concurrency. */
export async function watchdogHandler(event:{source?:string;"detail-type"?:string}):Promise<void> {
  if(event.source!=="aws.events"||event["detail-type"]!=="Scheduled Event")
    throw new Error("Unsupported erasure recovery watchdog event");
  const report=await inspectStuckErasureRecovery();
  console.info(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
    event:"recovery_watchdog_run",...report}));
}

export const handler:SQSHandler=async event=>{
  const batchItemFailures=[];
  for(const record of event.Records){
    try {
      const command=parseErasureQueueCommand(record);
      if(command.kind==="orphan_pause_recovery") {
        // Read-only operator recovery inspection. This report can NEVER
        // authorise a mapping pause, release a fence, or delete providers.
        const report=await inspectOrphanPauseRecovery(command.id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
          event:"orphan_pause_recovery",operationId:command.id,
          status:report.status,blockers:report.blockers,
          mappingChangesAuthorized:false,fenceAuthorized:false,deletionAuthorized:false}));
      } else if(command.kind==="orphan_manifest_stage") {
        // Independent, default-denied, single DynamoDB manifest create only.
        // No fence or mapping mutation; never dispatch another SQS message.
        const staged=await processOrphanManifestStage(command.id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
          event:"orphan_manifest_stage",operationId:command.id,status:staged.status,
          mappingCount:staged.mappingCount,deletionAuthorized:false,executionQueued:false}));
      } else if(command.kind==="orphan_inspection") {
        // Read-only diagnostic path; never call the deletion state machine,
        // modify an operation or enqueue a provider-mutation command.
        const diagnostic=await inspectConfirmedOrphanOperation(command.id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
          event:"orphan_inspection",operationId:command.id,status:diagnostic.status,
          blockerCount:diagnostic.blockers.length,deletionAuthorized:false,executionQueued:false}));
      } else if(command.kind==="recovery") {
        const result=await recoveryService.process(command.id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",event:"recovery_step",
          operationId:command.id,status:result.status}));
        if(result.retry)await enqueueErasureRecovery(command.id,10);
      } else {
        const result=await processErasureOperation(command.id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",event:"operation_step",
          operationId:command.id,...result}));
      }
    } catch(error) {
      console.error(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",event:"operation_step_failed",
        messageId:record.messageId,error:error instanceof Error?error.message:String(error)}));
      batchItemFailures.push({itemIdentifier:record.messageId});
    }
  }
  return {batchItemFailures};
};
