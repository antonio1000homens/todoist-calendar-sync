/**
 * Staged post-write mapping retry. This is deliberately not imported by an API,
 * queue, or deployed worker route. It may run only after the atomic replay
 * release transaction has committed the marker/fence and the protocol is live.
 */
import {GetEventSourceMappingCommand,ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,LambdaClient} from "@aws-sdk/client-lambda";
import {GetCommand,type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {acquireErasureProtocolLease} from "./erasure-protocol.js";
import {completePostWriteMappingRestore,postWriteWorkerMappingManifest,
  REPLAY_PROFILES} from "./erasure-replay-barrier.js";
import type {Profile} from "./types.js";

const OPERATION_ID=/^[A-Za-z0-9_-]{1,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQS_ARN=/^arn:[a-z0-9-]+:sqs:[a-z0-9-]+:\d{12}:[a-zA-Z0-9_.-]+$/;
const MAX_MAPPING_PAGES=10;
const MAX_MAPPINGS=100;
const DEFAULT_TIMEOUT_MS=60_000;

type Db=Pick<DynamoDBDocumentClient,"send">;
type Lambda=Pick<LambdaClient,"send">;
type Mapping={id:string;eventSourceArn:string;functionArn:string};
type RestoreRecord={operationId:string;profile:Profile;epoch:number;state:"pending"|"complete";
  mappingIds:string[];enabledMappingIds:string[];mappingFingerprint:string;verifiedAt?:string};
export type PostWriteMappingRestoreResult={state:"complete";alreadyComplete:boolean;mappingCount:number};
export interface PostWriteMappingRestoreSources {
  db?:Db;
  lambda?:Lambda;
  functionName?:string;
  now?:()=>Date;
  pause?:(ms:number)=>Promise<void>;
  timeoutMs?:number;
  acquireWriterLease?:(profile:Profile,epoch:number)=>Promise<()=>Promise<void>>;
}

function tableName():string {
  const table=process.env.STATE_TABLE_NAME?.trim();
  if(!table)throw new Error("STATE_TABLE_NAME is required");
  return table;
}
async function readEpoch(db:Db,profile:Profile):Promise<number> {
  const result=await db.send(new GetCommand({TableName:tableName(),
    Key:{pk:`ERASURE#${profile}`,sk:"EPOCH"},ConsistentRead:true}));
  return typeof result.Item?.epoch==="number"?result.Item.epoch:0;
}
function targetFunction(sources:PostWriteMappingRestoreSources):string {
  const name=sources.functionName??process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim();
  if(!name||name.length>256||/[\u0000-\u001f]/.test(name))
    throw new Error("Configured post-write worker function is unavailable");
  return name;
}
function readRecord(value:Record<string,unknown>|undefined,operationId:string):RestoreRecord {
  if(!value||value.pk!==`ERASURE_POSTWRITE_RESTORE#${operationId}`||value.sk!=="STATE"
    ||value.schemaVersion!==1||value.operationId!==operationId
    ||!REPLAY_PROFILES.includes(value.profile as Profile)
    ||!Number.isSafeInteger(value.epoch)||Number(value.epoch)<1
    ||(value.state!=="pending"&&value.state!=="complete")
    ||!Array.isArray(value.mappingIds)||!Array.isArray(value.enabledMappingIds)
    ||typeof value.mappingFingerprint!=="string")
    throw new Error("Durable post-write mapping restore record is invalid or absent");
  if(value.state==="complete"&&(typeof value.verifiedAt!=="string"
    ||!Number.isFinite(Date.parse(value.verifiedAt))
    ||new Date(value.verifiedAt).toISOString()!==value.verifiedAt))
    throw new Error("Completed post-write mapping restore record lacks a valid verification time");
  const manifest=postWriteWorkerMappingManifest({
    mappingIds:value.mappingIds as string[],enabledMappingIds:value.enabledMappingIds as string[],
  });
  if(manifest.fingerprint!==value.mappingFingerprint)
    throw new Error("Durable post-write mapping manifest fingerprint does not match");
  return {operationId,profile:value.profile as Profile,epoch:Number(value.epoch),state:value.state,
    ...manifest,mappingFingerprint:manifest.fingerprint,
    ...(typeof value.verifiedAt==="string"?{verifiedAt:value.verifiedAt}:{})};
}
function assertMappingOwner(mapping:{UUID?:string;EventSourceArn?:string;FunctionArn?:string},
  expected:Mapping,functionName:string):void {
  if(mapping.UUID!==expected.id||mapping.EventSourceArn!==expected.eventSourceArn
    ||mapping.FunctionArn!==expected.functionArn||!SQS_ARN.test(mapping.EventSourceArn)
    ||!mapping.FunctionArn.endsWith(":function:"+functionName))
    throw new Error("Worker mapping identity changed during post-write restoration");
}
async function listMappings(lambda:Lambda,functionName:string):Promise<Mapping[]> {
  const mappings:Mapping[]=[];
  let marker:string|undefined;
  const seen=new Set<string>();
  for(let pageNumber=0;pageNumber<MAX_MAPPING_PAGES;pageNumber++) {
    const page=await lambda.send(new ListEventSourceMappingsCommand({
      FunctionName:functionName,MaxItems:100,Marker:marker,
    }));
    for(const item of page.EventSourceMappings??[]) {
      if(!item.EventSourceArn?.includes(":sqs:"))continue;
      if(!item.UUID||!UUID.test(item.UUID)||!SQS_ARN.test(item.EventSourceArn)
        ||!item.FunctionArn||!item.FunctionArn.endsWith(":function:"+functionName))
        throw new Error("Worker SQS mapping inventory contains an invalid mapping");
      mappings.push({id:item.UUID,eventSourceArn:item.EventSourceArn,functionArn:item.FunctionArn});
      if(mappings.length>MAX_MAPPINGS)throw new Error("Worker mapping inventory exceeds the restoration safety limit");
    }
    const next=page.NextMarker;
    if(!next)return mappings;
    if(next===marker||seen.has(next))throw new Error("Worker mapping inventory repeated a pagination cursor");
    seen.add(next);marker=next;
  }
  throw new Error("Worker mapping inventory exceeded the pagination safety limit");
}
function assertSameInventory(actual:Mapping[],record:RestoreRecord):void {
  const actualIds=actual.map(item=>item.id).sort();
  if(actualIds.length!==record.mappingIds.length
    ||actualIds.some((id,index)=>id!==record.mappingIds[index]))
    throw new Error("Current worker mapping inventory differs from the atomic release manifest");
}
async function getMapping(lambda:Lambda,id:string,expected:Mapping,functionName:string) {
  const current=await lambda.send(new GetEventSourceMappingCommand({UUID:id}));
  assertMappingOwner(current,expected,functionName);
  return current;
}
async function enableAndWait(lambda:Lambda,id:string,expected:Mapping,functionName:string,
  timeoutMs:number,pause:(ms:number)=>Promise<void>):Promise<void> {
  const first=await getMapping(lambda,id,expected,functionName);
  if(first.State==="Enabled")return;
  if(first.State!=="Disabled")throw new Error("Worker mapping is transitional; leave the durable restore pending and retry");
  await lambda.send(new UpdateEventSourceMappingCommand({UUID:id,Enabled:true}));
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const current=await getMapping(lambda,id,expected,functionName);
    if(current.State==="Enabled")return;
    if(current.State!=="Enabling"&&current.State!=="Updating")
      throw new Error("Worker mapping did not enter the expected enabling state");
    await pause(1000);
  }
  throw new Error("Worker mapping did not return to Enabled before the retry deadline");
}

/**
 * Restore only mappings recorded as originally enabled. The strongly
 * consistent pending record exists in the same DynamoDB transaction as the
 * replay markers and fence release; a failed or partial Lambda operation
 * leaves that record pending for an idempotent retry.
 */
export async function restorePostWriteWorkerMappings(
  operationId:string,sources:PostWriteMappingRestoreSources={},
):Promise<PostWriteMappingRestoreResult> {
  if(!OPERATION_ID.test(operationId))throw new Error("Invalid post-write mapping restore operation ID");
  if(process.env.ERASURE_PROTOCOL_VERSION!=="1"||process.env.ERASURE_REPLAY_BARRIER_VERSION!=="1")
    throw new Error("Post-write mapping restore requires the enabled erasure replay and lease protocol");
  const table=tableName(),db=sources.db??documentClient;
  const lambda=sources.lambda??new LambdaClient({});
  const functionName=targetFunction(sources);
  const initial=await db.send(new GetCommand({TableName:table,
    Key:{pk:`ERASURE_POSTWRITE_RESTORE#${operationId}`,sk:"STATE"},ConsistentRead:true}));
  const record=readRecord(initial.Item,operationId);
  if(record.state==="complete")return {state:"complete",alreadyComplete:true,mappingCount:record.mappingIds.length};
  const epoch=await readEpoch(db,record.profile);
  if(epoch!==record.epoch)throw new Error("Profile epoch changed; do not resume mappings from a stale post-write record");
  const releaseLease=(sources.acquireWriterLease??(async(profile,expectedEpoch)=>
    acquireErasureProtocolLease(profile,"writer",undefined,expectedEpoch)))(record.profile,epoch);
  const release=await releaseLease;
  try {
    // Re-read after obtaining the profile writer lease. A new fence cannot be
    // installed until this lease is released, so mapping changes are serialized
    // against the next erasure operation.
    const fresh=await db.send(new GetCommand({TableName:table,
      Key:{pk:`ERASURE_POSTWRITE_RESTORE#${operationId}`,sk:"STATE"},ConsistentRead:true}));
    const currentRecord=readRecord(fresh.Item,operationId);
    if(currentRecord.state==="complete")return {state:"complete",alreadyComplete:true,mappingCount:currentRecord.mappingIds.length};
    if(currentRecord.profile!==record.profile||currentRecord.epoch!==record.epoch
      ||currentRecord.mappingFingerprint!==record.mappingFingerprint)
      throw new Error("Post-write mapping restore record changed while acquiring its writer lease");

    const original=await listMappings(lambda,functionName);
    assertSameInventory(original,currentRecord);
    const byId=new Map(original.map(item=>[item.id,item]));
    const enabled=new Set(currentRecord.enabledMappingIds);
    for(const id of currentRecord.mappingIds) {
      const expected=byId.get(id)!;
      if(enabled.has(id)) {
        await enableAndWait(lambda,id,expected,functionName,sources.timeoutMs??DEFAULT_TIMEOUT_MS,
          sources.pause??(ms=>new Promise(resolve=>setTimeout(resolve,ms))));
      } else {
        const mapping=await getMapping(lambda,id,expected,functionName);
        if(mapping.State!=="Disabled")
          throw new Error("An originally disabled worker mapping changed state; keep the restore pending");
      }
    }

    // Re-list and re-read every mapping. Extra, missing, foreign, or
    // transitional mappings keep the durable item pending for retry/review.
    const finalInventory=await listMappings(lambda,functionName);
    assertSameInventory(finalInventory,currentRecord);
    const finalById=new Map(finalInventory.map(item=>[item.id,item]));
    const observedStates=[];
    for(const id of currentRecord.mappingIds) {
      const mapping=await getMapping(lambda,id,finalById.get(id)!,functionName);
      const expectedState=enabled.has(id)?"Enabled":"Disabled";
      if(mapping.State!==expectedState)
        throw new Error("Worker mapping readback does not match the original enabled/disabled state");
      observedStates.push({id,state:mapping.State});
    }
    const verifiedAt=(sources.now?.()??new Date()).toISOString();
    const command=completePostWriteMappingRestore({operationId,profile:currentRecord.profile,
      epoch:currentRecord.epoch,mappingIds:currentRecord.mappingIds,
      enabledMappingIds:currentRecord.enabledMappingIds,observedStates,verifiedAt});
    try {await db.send(command);}
    catch(error) {
      if((error as {name?:string}).name!=="ConditionalCheckFailedException")throw error;
      const after=await db.send(new GetCommand({TableName:table,
        Key:{pk:`ERASURE_POSTWRITE_RESTORE#${operationId}`,sk:"STATE"},ConsistentRead:true}));
      const completed=readRecord(after.Item,operationId);
      if(completed.state!=="complete"||completed.mappingFingerprint!==currentRecord.mappingFingerprint)throw error;
      return {state:"complete",alreadyComplete:true,mappingCount:completed.mappingIds.length};
    }
    return {state:"complete",alreadyComplete:false,mappingCount:currentRecord.mappingIds.length};
  } finally {
    await release();
  }
}
