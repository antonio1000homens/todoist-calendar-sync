/**
 * #287 phase 14: strictly opt-in, non-destructive worker entrypoint for the
 * immutable #319 fence manifest. Never disables mappings, installs a fence,
 * writes replay markers, invokes providers, or enqueues a deletion.
 */
import {
  LambdaClient, ListEventSourceMappingsCommand, GetEventSourceMappingCommand,
} from "@aws-sdk/client-lambda";
import {DynamoOrphanJournal, OrphanSafetyError, type OrphanDeletionOperation} from "./orphan-deletion-executor.js";
import {inspectConfirmedOrphanOperation, type OrphanInspectionResult} from "./orphan-worker-inspection.js";
import {inspectOrphanWorkerMappings, type OrphanWorkerMappingInventory} from "./orphan-worker-mappings.js";
import {
  stageOrphanFenceManifest, type OrphanFenceManifest, type OrphanFenceManifestRequest,
  type OrphanMappingRow,
} from "./orphan-fence-manifest.js";
import {getErasureEpoch} from "./erasure-protocol.js";
import type {Profile} from "./types.js";

const OP_ID=/^[A-Za-z0-9_-]{1,128}$/;
const MAX_PAGES=10,MAX_MAPPINGS=100;
type Lambda=Pick<LambdaClient,"send">;
export interface OrphanManifestStageSources {
  lambda?:Lambda;
  functionName?:string;
  inventory?:(lambda:Lambda,fn:string)=>Promise<OrphanWorkerMappingInventory>;
  readMappings?:(lambda:Lambda,fn:string)=>Promise<OrphanMappingRow[]>;
  inspect?:(id:string,inventory:OrphanWorkerMappingInventory)=>Promise<OrphanInspectionResult>;
  getOperation?:(id:string)=>Promise<OrphanDeletionOperation|undefined>;
  epoch?:(profile:Profile)=>Promise<number>;
  stage?:(input:OrphanFenceManifestRequest)=>Promise<OrphanFenceManifest>;
  now?:()=>Date;
}
/** Default denied independently of generic erasure and orphan-confirmation
 * switches. SAM intentionally does not advertise/enable these flags. */
export function orphanManifestStageEnabled():boolean {
  return process.env.ORPHAN_FENCE_STAGING_ENABLED==="true"
    && process.env.ORPHAN_WORKER_INSPECTION_ENABLED==="true"
    && process.env.ERASURE_PROTOCOL_VERSION==="1";
}
function requireStaging():void {
  if(!orphanManifestStageEnabled())
    throw new OrphanSafetyError("Orphan manifest worker staging is disabled");
}
/** Independently enumerate exact qualified mappings *again* after #318's
 * complete readback. #319 will hash and compare both authoritative reads.
 * Incomplete/changed pages throw; do not return an optimistic partial set. */
export async function readOrphanManifestWorkerMappings(
  lambda:Lambda,fn:string,
):Promise<OrphanMappingRow[]> {
  if(!fn||fn.length>256||/[\u0000-\u001f]/.test(fn))
    throw new OrphanSafetyError("Orphan manifest target worker is unavailable");
  const rows:OrphanMappingRow[]=[];
  let marker:string|undefined;
  const seen=new Set<string>();
  const cursors=new Set<string>();
  for(let pageIndex=0;pageIndex<MAX_PAGES;pageIndex++){
    const page=await lambda.send(new ListEventSourceMappingsCommand({
      FunctionName:fn,MaxItems:100,Marker:marker,
    }));
    for(const mapping of page.EventSourceMappings??[]){
      const id=mapping.UUID??"";
      if(!id||seen.has(id)||mapping.State!=="Enabled"||!mapping.EventSourceArn||!mapping.FunctionArn)
        throw new OrphanSafetyError("Worker mapping list contains duplicate, disabled or incomplete entries");
      seen.add(id);
      rows.push({id,eventSourceArn:mapping.EventSourceArn,
        functionArn:mapping.FunctionArn,state:"Enabled"});
      if(rows.length>MAX_MAPPINGS)
        throw new OrphanSafetyError("Worker mapping list exceeds the safety budget");
    }
    if(!page.NextMarker){
      if(!rows.length)throw new OrphanSafetyError("Worker has no confirmed SQS mappings");
      for(const item of rows){
        const fresh=await lambda.send(new GetEventSourceMappingCommand({UUID:item.id}));
        if(fresh.UUID!==item.id||fresh.State!=="Enabled"
          ||fresh.EventSourceArn!==item.eventSourceArn
          ||fresh.FunctionArn!==item.functionArn)
          throw new OrphanSafetyError("Worker mapping changed between list and direct readback");
      }
      return rows;
    }
    if(page.NextMarker===marker||cursors.has(page.NextMarker))
      throw new OrphanSafetyError("Worker mapping pagination cursor repeated");
    cursors.add(page.NextMarker);marker=page.NextMarker;
  }
  throw new OrphanSafetyError("Worker mapping pagination did not complete within the safety budget");
}
export interface OrphanManifestStageReceipt {
  operationId:string;caseId:string;profile:Profile;
  status:"manifest_staged_no_execution";mappingCount:number;
  deletionAuthorized:false;executionQueued:false;
}
/** Consumes ONLY an operation ID from SQS, then loads independent current
 * server-side approval and Lambda evidence. Every state mutation is limited
 * to the #319 DynamoDB conditional create and cannot retarget an operation.
 * A duplicate/indeterminate commit fails closed; never overwrite or retry
 * a mapping pause on the strength of this receipt. */
export async function processOrphanManifestStage(
  id:string,sources:OrphanManifestStageSources={},
):Promise<OrphanManifestStageReceipt> {
  requireStaging();
  if(!OP_ID.test(id))throw new OrphanSafetyError("Invalid orphan manifest stage operation ID");
  const now=sources.now?.()??new Date();
  if(!Number.isFinite(now.getTime()))throw new OrphanSafetyError("Invalid orphan manifest staging clock");
  const fn=sources.functionName??process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim();
  if(!fn||fn.length>256||/[\u0000-\u001f]/.test(fn))
    throw new OrphanSafetyError("Configured target worker is missing");
  const lambda=sources.lambda??new LambdaClient({});
  const inventory=await (sources.inventory??((client,name)=>
    inspectOrphanWorkerMappings({lambda:client,functionName:name,now:()=>now})))(lambda,fn);
  if(!inventory.verified||inventory.blockers.length||!inventory.fingerprint)
    throw new OrphanSafetyError("Target worker mapping inventory is incomplete or blocked");
  const inspected=await (sources.inspect??((operationId,observed)=>
    inspectConfirmedOrphanOperation(operationId,{inspectMappings:async()=>observed,now:()=>now})))(id,inventory);
  if(inspected.operationId!==id||inspected.status!=="inspection_passed_not_authorized"
    ||inspected.blockers.length||inspected.deletionAuthorized!==false||inspected.executionQueued!==false)
    throw new OrphanSafetyError("Fresh confirmed orphan case inspection did not pass");
  const rows=await (sources.readMappings??readOrphanManifestWorkerMappings)(lambda,fn);
  const operation=await (sources.getOperation??(operationId=>new DynamoOrphanJournal().get(operationId)))(id);
  if(!operation||operation.id!==id||operation.caseId!==inspected.caseId
    ||operation.profile!==inspected.profile)
    throw new OrphanSafetyError("Durable orphan operation identity changed after inspection");
  const epoch=await (sources.epoch??getErasureEpoch)(operation.profile);
  const input:OrphanFenceManifestRequest={
    operation,mappingInventory:inventory,mappings:rows,
    targetWorkerFunction:fn,expectedErasureEpoch:epoch,now,
  };
  const saved=await (sources.stage??stageOrphanFenceManifest)(input);
  if(saved.operationId!==id||saved.caseId!==operation.caseId||saved.profile!==operation.profile
    ||saved.status!=="staged"||saved.version!==0||saved.mappingIds.length!==rows.length)
    throw new OrphanSafetyError("Durable orphan manifest commit result was inconsistent");
  return {operationId:id,caseId:operation.caseId,profile:operation.profile,
    status:"manifest_staged_no_execution",mappingCount:rows.length,
    deletionAuthorized:false,executionQueued:false};
}
