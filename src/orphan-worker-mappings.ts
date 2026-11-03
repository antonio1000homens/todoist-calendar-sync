/**
 * #287: read-only, bounded worker mapping inventory before any orphan fence.
 * This is NOT a complete proof that all historic/qualified Lambda writers
 * are retired (#307), nor is it a mapping disable/enable implementation.
 */
import {createHash} from "node:crypto";
import {LambdaClient, ListEventSourceMappingsCommand,
  GetEventSourceMappingCommand, GetFunctionConfigurationCommand} from "@aws-sdk/client-lambda";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sqsArn=/^arn:[a-z0-9-]+:sqs:[a-z0-9-]+:\d{12}:[a-zA-Z0-9_.-]+$/;
const MAX_PAGES=10,MAX_MAPPINGS=100;

export interface OrphanWorkerMappingInventory {
  verified:boolean;
  checkedAt:string;
  mappingCount:number;
  timeoutSeconds?:number;
  /** Privacy-minimised snapshot; no mapping identifiers in diagnostic output. */
  fingerprint?:string;
  blockers:string[];
}
export interface OrphanWorkerMappingSources {
  lambda?:Pick<LambdaClient,"send">;
  functionName?:string;
  now?:()=>Date;
}

/** An empty, partially paginated, mutable, non-SQS or unqualified mapping
 * list is never used as evidence of a drained/safely fenceable worker.
 * A future privileged fence adapter must repeat this inspection under a
 * version/epoch fence and durably record the disable/restore manifest. */
export async function inspectOrphanWorkerMappings(
  sources:OrphanWorkerMappingSources={},
):Promise<OrphanWorkerMappingInventory> {
  const when=sources.now?.()??new Date();
  if(!Number.isFinite(when.getTime()))throw new Error("Invalid worker inspection clock");
  const blockers:string[]=[];
  const fn=sources.functionName??process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim();
  const result=(mappingCount:number,timeoutSeconds?:number,fingerprint?:string):OrphanWorkerMappingInventory=>({
    verified:blockers.length===0,checkedAt:when.toISOString(),mappingCount,
    ...(timeoutSeconds!==undefined?{timeoutSeconds}:{}),
    ...(fingerprint?{fingerprint}:{}),blockers,
  });
  if(!fn||fn.length>256||/[\u0000-\u001f]/.test(fn)) {
    blockers.push("Configured target worker function is unavailable");
    return result(0);
  }
  const lambda=sources.lambda??new LambdaClient({});
  const config=await lambda.send(new GetFunctionConfigurationCommand({FunctionName:fn}));
  const timeout=config.Timeout;
  if(typeof timeout!=="number"||!Number.isInteger(timeout)||timeout<1||timeout>900)
    blockers.push("Target worker timeout is unavailable or invalid");
  if(config.State!=="Active"||config.LastUpdateStatus!=="Successful")
    blockers.push("Target worker is not active with a completed configuration update");

  let marker:string|undefined;
  const seenTokens=new Set<string>();
  const mappings:Array<{id:string;arn:string;state:string;functionArn:string}>=[];
  let pages=0;
  do {
    if(++pages>MAX_PAGES){
      blockers.push("Target worker mapping pagination exceeds the safety budget");
      break;
    }
    const page=await lambda.send(new ListEventSourceMappingsCommand({
      FunctionName:fn,MaxItems:100,Marker:marker,
    }));
    for(const row of page.EventSourceMappings??[]){
      const id=row.UUID||"",arn=row.EventSourceArn||"";
      if(!uuid.test(id)||!sqsArn.test(arn)||!row.FunctionArn) {
        blockers.push("Target worker has an unsupported or incomplete event-source mapping");
        continue;
      }
      mappings.push({id,arn,state:row.State||"",functionArn:row.FunctionArn});
      if(mappings.length>MAX_MAPPINGS){
        blockers.push("Target worker has too many event-source mappings");
        break;
      }
    }
    if(mappings.length>MAX_MAPPINGS)break;
    const next=page.NextMarker;
    if(!next){marker=undefined;break;}
    if(seenTokens.has(next)||next===marker){
      blockers.push("Target worker mapping pagination repeated a page cursor");
      break;
    }
    seenTokens.add(next);marker=next;
  }while(marker);
  if(!mappings.length)blockers.push("Target worker has no verified SQS event-source mappings");
  if(new Set(mappings.map(x=>x.id)).size!==mappings.length)
    blockers.push("Target worker returned duplicate event-source mapping IDs");
  if(mappings.some(x=>x.state!=="Enabled"))
    blockers.push("Target worker mapping is not in the expected Enabled state");
  // Re-read every mapping by exact UUID. A list snapshot alone is stale, and
  // a transitioning mapping must be rejected before any future fence action.
  if(!blockers.length){
    for(const item of mappings){
      const live=await lambda.send(new GetEventSourceMappingCommand({UUID:item.id}));
      if(live.UUID!==item.id||live.EventSourceArn!==item.arn
        ||live.FunctionArn!==item.functionArn||live.State!=="Enabled"){
        blockers.push("Target worker mapping changed during independent readback");
        break;
      }
    }
  }
  if(blockers.length)return result(mappings.length,timeout);
  const manifest=mappings.map(x=>[x.id,x.arn,x.state,x.functionArn])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  const fingerprint=createHash("sha256").update(JSON.stringify([fn,timeout,manifest])).digest("hex");
  return result(mappings.length,timeout,fingerprint);
}
