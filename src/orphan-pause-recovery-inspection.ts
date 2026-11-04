/**
 * #287 phase 16: operator-visible read-only recovery inspection for a staged
 * pause claim. A claim is never a worker fence, and current Lambda mappings
 * are never proof that old qualified versions/IAM invokers are neutralised.
 *
 * No UpdateEventSourceMapping, profile fence, provider write, SQS send, replay
 * marker installation, journal transition or automatic lock cleanup exists.
 */
import {GetCommand,type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {inspectErasureFence} from "./erasure-protocol.js";
import {inspectOrphanWorkerMappings,type OrphanWorkerMappingInventory} from "./orphan-worker-mappings.js";
import {readOrphanWorkerPauseClaim} from "./orphan-mapping-pause-claim.js";
import {OrphanSafetyError,type OrphanDeletionOperation} from "./orphan-deletion-executor.js";
import type {OrphanFenceManifest} from "./orphan-fence-manifest.js";
import type {Profile} from "./types.js";

const ID=/^[A-Za-z0-9_-]{1,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const PROFILES=["antonio","home","work"] as const satisfies readonly Profile[];
type Db=Pick<DynamoDBDocumentClient,"send">;
type FenceState={fence?:Record<string,unknown>;leases:Record<string,unknown>[]};

export type PauseRecoveryBlocker=
  |"MISSING_CLAIM"|"CLAIM_OWNER_OR_MANIFEST_MISMATCH"
  |"APPROVAL_UNAVAILABLE_OR_CHANGED"|"APPROVAL_EXPIRED"
  |"MANIFEST_UNAVAILABLE_OR_CHANGED"|"CASE_LOCK_CHANGED"|"CASE_NO_LONGER_OPEN"
  |"WORKER_MAPPING_INCOMPLETE_OR_CHANGED"|"PROFILE_FENCE_OR_LEASE_PRESENT"
  |"ERASURE_EPOCH_CHANGED"|"HISTORIC_QUALIFIED_WRITER_AUDIT_OUTSTANDING"
  |"PROVIDER_AND_REPLAY_PROOF_NOT_RECHECKED_UNDER_FENCE";
export interface PauseRecoveryInspection{
  operationId:string;
  status:"no_claim"|"review_required"|"current_reads_consistent_audit_pending";
  claimPresent:boolean;ownerMatches:boolean;
  checkedAt:string;blockers:PauseRecoveryBlocker[];
  mappingChangesAuthorized:false;fenceAuthorized:false;deletionAuthorized:false;
}
export interface PauseRecoverySources {
  db?:Db;
  workerName?:string;
  mappings?:()=>Promise<OrphanWorkerMappingInventory>;
  profile?:(profile:Profile)=>Promise<FenceState>;
  now?:()=>Date;
}
function table():string{
  const name=process.env.STATE_TABLE_NAME?.trim();
  if(!name)throw new OrphanSafetyError("Pause recovery inspection requires state table");
  return name;
}
function requireReadOnlyGate():void{
  if(process.env.ORPHAN_PAUSE_INSPECTION_ENABLED!=="true"
    ||process.env.ORPHAN_WORKER_INSPECTION_ENABLED!=="true"
    ||process.env.ERASURE_PROTOCOL_VERSION!=="1")
    throw new OrphanSafetyError("Read-only orphan pause recovery inspection is disabled");
}
async function get(db:Db,pk:string,sk="STATE"):Promise<Record<string,unknown>|undefined>{
  const response=await db.send(new GetCommand({
    TableName:table(),Key:{pk,sk},ConsistentRead:true,
  }));
  return response.Item as Record<string,unknown>|undefined;
}
function isApproved(op:OrphanDeletionOperation|undefined,id:string,now:number):boolean{
  return Boolean(op&&op.id===id&&op.phase==="confirmed"&&op.version===0
    &&PROFILES.includes(op.profile)&&op.caseId&&op.targetId&&op.caseUpdatedAt
    &&["todoist","calendar"].includes(op.side)&&SHA.test(op.providerDigest)
    &&op.actorSubject&&
    (op.side==="calendar"?op.providerEtag:op.providerEtag===undefined)
    &&Number.isFinite(Date.parse(op.confirmedAt))
    &&Number.isFinite(Date.parse(op.confirmationExpiresAt)));
}
function matchesManifest(op:OrphanDeletionOperation,m:OrphanFenceManifest|undefined,worker:string):boolean{
  return Boolean(m&&m.status==="staged"&&m.version===0
    &&m.operationId===op.id&&m.caseId===op.caseId&&m.profile===op.profile
    &&m.caseUpdatedAt===op.caseUpdatedAt&&m.side===op.side
    &&m.targetId===op.targetId&&m.providerDigest===op.providerDigest
    &&m.targetWorkerFunction===worker&&SHA.test(m.mappingFingerprint)
    &&Array.isArray(m.mappingIds)
    &&Array.isArray(m.mappingIds)&&m.mappingIds.length>0
    &&Array.isArray(m.originallyEnabledIds)
    &&JSON.stringify(m.mappingIds)===JSON.stringify(m.originallyEnabledIds)
    &&Number.isSafeInteger(m.epoch)&&m.epoch>=0
    &&Number.isInteger(m.timeoutSeconds)&&m.timeoutSeconds>0);
}
/** Strongly consistent readback of exactly one operation, with bounded live
 * SQS mapping inspection and all three profile fences/leases. Provider reads
 * and historic IAM/qualified Lambda writer audits remain separate gates.
 * No result here can ever authorise mutation.
 */
export async function inspectOrphanPauseRecovery(
  id:string,sources:PauseRecoverySources={},
):Promise<PauseRecoveryInspection>{
  requireReadOnlyGate();
  if(!ID.test(id))throw new OrphanSafetyError("Invalid orphan pause recovery operation ID");
  const now=sources.now?.()??new Date();
  const at=now.getTime();
  if(!Number.isFinite(at))throw new OrphanSafetyError("Invalid recovery inspection time");
  const db=sources.db??documentClient;
  const worker=sources.workerName??process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim()??"";
  if(!worker||worker.length>256||/[\u0000-\u001f]/.test(worker))
    throw new OrphanSafetyError("Unknown target worker for pause recovery");

  const claim=await readOrphanWorkerPauseClaim(id,{db,workerName:worker});
  const blockers:PauseRecoveryBlocker[]=[];
  const summarize=(status:PauseRecoveryInspection["status"]):PauseRecoveryInspection=>({
    operationId:id,status,claimPresent:claim.found,ownerMatches:claim.owned,
    checkedAt:now.toISOString(),blockers:[...new Set(blockers)],
    mappingChangesAuthorized:false,fenceAuthorized:false,deletionAuthorized:false,
  });
  if(!claim.found){
    blockers.push("MISSING_CLAIM");
    return summarize("no_claim");
  }
  if(!claim.owned||claim.phase!=="claimed_no_mappings_modified"
    ||claim.mappingsDisabled!==false||claim.fenceInstalled!==false){
    blockers.push("CLAIM_OWNER_OR_MANIFEST_MISMATCH");
    return summarize("review_required");
  }
  const [opRow,manifestRow]=await Promise.all([
    get(db,"ORPHAN_DELETE#"+id),get(db,"ORPHAN_FENCE_MANIFEST#"+id),
  ]);
  const op=opRow as unknown as OrphanDeletionOperation|undefined;
  const manifest=manifestRow as unknown as OrphanFenceManifest|undefined;
  if(!isApproved(op,id,at)){
    blockers.push("APPROVAL_UNAVAILABLE_OR_CHANGED");
    return summarize("review_required");
  }
  const approved=op!;
  const confirmedAt=Date.parse(approved.confirmedAt),expires=Date.parse(approved.confirmationExpiresAt);
  if(confirmedAt>at||expires<=at||expires<=confirmedAt||expires-confirmedAt>300000)
    blockers.push("APPROVAL_EXPIRED");
  if(!matchesManifest(approved,manifest,worker))
    blockers.push("MANIFEST_UNAVAILABLE_OR_CHANGED");
  if(blockers.length)return summarize("review_required");
  const m=manifest!;
  const [lock,review]=await Promise.all([
    get(db,"ORPHAN_CASE_LOCK#"+approved.caseId),
    get(db,"REVIEW_CASE#"+approved.caseId),
  ]);
  if(lock?.operationId!==id||lock?.caseId!==approved.caseId||
    lock?.profile!==approved.profile||lock?.side!==approved.side||
    lock?.targetId!==approved.targetId||lock?.caseUpdatedAt!==approved.caseUpdatedAt)
    blockers.push("CASE_LOCK_CHANGED");
  if(review?.id!==approved.caseId||review?.profile!==approved.profile
    ||review?.status!=="open"||review?.updatedAt!==approved.caseUpdatedAt
    ||review.operationId!==undefined)
    blockers.push("CASE_NO_LONGER_OPEN");
  if(blockers.length)return summarize("review_required");
  // No parallel optimistic conclusions: a timeout/unavailable API throws for
  // SQS partial-batch retry; only complete verified inventories can be used.
  const inventory=await (sources.mappings??(()=>inspectOrphanWorkerMappings({
    functionName:worker,now:()=>now,
  })))();
  if(!inventory.verified||inventory.blockers.length||
    inventory.fingerprint!==m.mappingFingerprint||
    inventory.mappingCount!==m.mappingIds.length||
    inventory.timeoutSeconds!==m.timeoutSeconds)
    blockers.push("WORKER_MAPPING_INCOMPLETE_OR_CHANGED");
  for(const profile of PROFILES){
    const fence=await (sources.profile??inspectErasureFence)(profile);
    if(fence.fence||!Array.isArray(fence.leases)||fence.leases.length)
      blockers.push("PROFILE_FENCE_OR_LEASE_PRESENT");
    const epoch=await get(db,"ERASURE#"+profile,"EPOCH");
    if(epoch?.epoch!==undefined&&(typeof epoch.epoch!=="number"||!Number.isSafeInteger(epoch.epoch)||epoch.epoch<0))
      blockers.push("ERASURE_EPOCH_CHANGED");
    if(profile===approved.profile&&(epoch?.epoch??0)!==m.epoch)
      blockers.push("ERASURE_EPOCH_CHANGED");
  }
  if(blockers.length)return summarize("review_required");

  // #307 remains open. Even a clean current snapshot is not proof that
  // historical qualified functions, identity-policy direct invokers,
  // webhooks or aliases are unable to mutate this identity.
  blockers.push("HISTORIC_QUALIFIED_WRITER_AUDIT_OUTSTANDING");
  blockers.push("PROVIDER_AND_REPLAY_PROOF_NOT_RECHECKED_UNDER_FENCE");
  return summarize("current_reads_consistent_audit_pending");
}
