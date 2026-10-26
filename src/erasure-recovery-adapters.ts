/** Process-owned recovery adapters. API gets read-only AWS mapping permissions. */
import {GetEventSourceMappingCommand,ListEventSourceMappingsCommand,UpdateEventSourceMappingCommand,LambdaClient} from "@aws-sdk/client-lambda";
import {documentClient} from "./dynamodb-capacity.js";
import {buildErasurePreview} from "./erasure-preview.js";
import {defaultProviderClientFactory} from "./mutation-budget.js";
import {inspectErasureFence} from "./erasure-protocol.js";
import type {ErasureOperation,FencedMapping} from "./erasure-executor.js";
import type {RecoveryAdapters} from "./erasure-recovery.js";

const lambda=new LambdaClient({});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function target():string {
  const name=process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim();
  if(!name)throw new Error("Missing trusted recovery target worker function");
  return name;
}
export function recoveryAdapters(canRestore=false):RecoveryAdapters {
  return {
    async listWorkerMappings():Promise<FencedMapping[]> {
      const rows:FencedMapping[]=[];
      let marker:string|undefined;
      do {
        const page=await lambda.send(new ListEventSourceMappingsCommand({FunctionName:target(),MaxItems:100,Marker:marker}));
        for(const item of page.EventSourceMappings||[]) {
          if(!item.EventSourceArn?.includes(":sqs:")||!item.UUID)continue;
          rows.push({id:item.UUID,state:item.State as FencedMapping["state"],eventSourceArn:item.EventSourceArn});
        }
        marker=page.NextMarker;
      }while(marker);
      return rows;
    },
    async mappingStates(ids:string[]):Promise<Array<{id:string;state:string}>> {
      return Promise.all(ids.map(async id=>{
        if(!uuid.test(id))throw new Error("Invalid recovery event-source mapping UUID");
        const item=await lambda.send(new GetEventSourceMappingCommand({UUID:id}));
        // The mapping must still belong to the exact configured worker and an SQS source.
        const functionName=target();
        if(!item.FunctionArn?.endsWith(":function:"+functionName))
          throw new Error("Recovery mapping belongs to another Lambda function");
        if(!item.EventSourceArn?.includes(":sqs:"))throw new Error("Recovery mapping is not an SQS event source");
        return {id,state:item.State||"Unknown"};
      }));
    },
    async restoreMappings(ids:string[]):Promise<void> {
      if(!canRestore)throw new Error("The authenticated API has no recovery mapping-write privileges");
      for(const id of ids) {
        if(!uuid.test(id))throw new Error("Invalid recovery worker mapping");
        const mapping=await lambda.send(new GetEventSourceMappingCommand({UUID:id}));
        if(!mapping.FunctionArn?.endsWith(":function:"+target())||!mapping.EventSourceArn?.includes(":sqs:"))
          throw new Error("Recovery mapping identity changed");
        if(mapping.State==="Enabled")continue;
        if(mapping.State!=="Disabled")throw new Error("Recovery mapping is transitioning; wait for verification");
        await lambda.send(new UpdateEventSourceMappingCommand({UUID:id,Enabled:true}));
      }
    },
    async readSnapshot(operation:ErasureOperation) {
      return buildErasurePreview({profile:operation.profile,taskId:operation.target.taskId,
        ...(operation.target.eventId?{eventId:operation.target.eventId}:{}),
        deleteCalendar:operation.selectedActions.deleteCalendar},
      {db:documentClient,clients:await defaultProviderClientFactory(operation.profile),
        inspectFence:async profile=>{
          const value=await inspectErasureFence(profile);
          return {fence:value.fence,leases:value.leases};
        },
        newOperationId:()=>operation.operationId,ignoreOperationId:operation.operationId,
        allowFenceOperationId:operation.operationId,allowJournalOperationId:operation.operationId,
        // Bounded by the caller's Lambda timeout; any partial scan throws,
        // leaving the fence and mappings untouched.
        scanDeadlineMs:canRestore?95_000:68_000});
    },
  };
}
