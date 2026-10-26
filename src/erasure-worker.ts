import type { SQSHandler, SQSRecord } from "aws-lambda";
import { GetEventSourceMappingCommand, GetFunctionConfigurationCommand, LambdaClient,
  ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand } from "@aws-sdk/client-lambda";
import { documentClient } from "./dynamodb-capacity.js";
import { ErasureGateDriftError, ErasureOperationStore, type ErasureOperation, type ErasureWorkerAdapters, type FencedMapping } from "./erasure-executor.js";
import { beginErasureFence, finishErasureFence, inspectErasureFence } from "./erasure-protocol.js";
import { enqueueErasureOperation } from "./erasure-queue.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { buildErasurePreview } from "./erasure-preview.js";
import { executeErasureDeletionStep, verifyErasurePostflight } from "./erasure-deletion.js";
import { erasureExecutionEnabled } from "./erasure-readiness.js";

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

export function parseErasureQueueRecord(record: Pick<SQSRecord,"body">): string {
  let payload:unknown;
  try { payload=JSON.parse(record.body); } catch { throw new Error("Invalid erasure queue message JSON"); }
  if(!payload||typeof payload!=="object"||Array.isArray(payload)) throw new Error("Invalid erasure queue message");
  const value=payload as Record<string,unknown>;
  if(Object.keys(value).sort().join(",")!=="operationId,version"||value.version!==1
    ||typeof value.operationId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId))
    throw new Error("Invalid erasure queue message schema");
  return value.operationId;
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
    await store.startFencedLifecycle(operationId,timeoutSeconds);
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
      if(!(error instanceof ErasureGateDriftError)) throw error;
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
      if(!(error instanceof ErasureGateDriftError)) throw error;
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

export const handler:SQSHandler=async event=>{
  const batchItemFailures=[];
  for(const record of event.Records){
    try {
      const operationId=parseErasureQueueRecord(record);
      const result=await processErasureOperation(operationId);
      console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",event:"operation_step",operationId,...result}));
    } catch(error) {
      console.error(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",event:"operation_step_failed",
        messageId:record.messageId,error:error instanceof Error?error.message:String(error)}));
      batchItemFailures.push({itemIdentifier:record.messageId});
    }
  }
  return {batchItemFailures};
};
