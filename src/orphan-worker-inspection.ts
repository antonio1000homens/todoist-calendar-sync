/** #287: default-disabled read-only SQS inspection of a persisted orphan. */
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { DynamoOrphanJournal, assertTrustedProof, type OrphanJournal, type OrphanDeletionOperation, type VerifiedOrphanProof } from "./orphan-deletion-executor.js";
import { collectOrphanEvidence } from "./orphan-proof-reader.js";
import { inspectErasureFence } from "./erasure-protocol.js";
import { inspectOrphanWorkerMappings, type OrphanWorkerMappingInventory } from "./orphan-worker-mappings.js";
import type { Profile } from "./types.js";

const OP_ID=/^[A-Za-z0-9_-]{1,128}$/;
const PROFILES=new Set<Profile>(["home","antonio","work"]);
type DB=Pick<DynamoDBDocumentClient,"send">;
export interface OrphanInspectionResult {
  operationId:string; caseId:string; profile:Profile;
  status:"inspection_passed_not_authorized"|"blocked";
  checkedAt:string; blockers:string[];
  deletionAuthorized:false; executionQueued:false;
}
export interface OrphanInspectionSources {
  journal?:Pick<OrphanJournal,"get">;
  db?:DB;
  collectProof?:(op:OrphanDeletionOperation)=>Promise<VerifiedOrphanProof>;
  inspectFence?:(profile:Profile)=>Promise<{fence?:Record<string,unknown>;leases:Record<string,unknown>[]}>;
  inspectMappings?:()=>Promise<OrphanWorkerMappingInventory>;
  now?:()=>Date;
}
const lockKey=(id:string)=>({pk:"ORPHAN_CASE_LOCK#"+id,sk:"STATE"});
function stateTable():string {
  const value=process.env.STATE_TABLE_NAME?.trim();
  if(!value)throw new Error("State table is not configured for orphan inspection");
  return value;
}
function validConfirmedOperation(op:OrphanDeletionOperation,now:number):boolean {
  const confirmed=Date.parse(op.confirmedAt),expiry=Date.parse(op.confirmationExpiresAt);
  return OP_ID.test(op.id)&&typeof op.caseId==="string"&&!!op.caseId
    &&PROFILES.has(op.profile)&&["todoist","calendar"].includes(op.side)
    &&typeof op.targetId==="string"&&!!op.targetId
    &&op.version===0&&op.phase==="confirmed"
    &&Number.isFinite(confirmed)&&Number.isFinite(expiry)
    &&expiry>confirmed&&expiry-confirmed<=300000&&now<=expiry
    &&typeof op.caseUpdatedAt==="string"&&!!op.caseUpdatedAt
    &&typeof op.actorSubject==="string"&&!!op.actorSubject
    &&/^[a-f0-9]{64}$/.test(op.providerDigest)
    &&(op.side==="calendar"?typeof op.providerEtag==="string"&&!!op.providerEtag:op.providerEtag===undefined);
}
function sameLock(op:OrphanDeletionOperation,row:Record<string,unknown>|undefined):boolean {
  return Boolean(row&&row.operationId===op.id&&row.caseId===op.caseId
    &&row.profile===op.profile&&row.side===op.side&&row.targetId===op.targetId
    &&row.caseUpdatedAt===op.caseUpdatedAt);
}
/** Loads all identities from the durable journal; the queue supplies ONLY an op ID.
 * No provider, fence, mapping, operation, case or replay state is mutated.
 * The returned diagnostic is never an authorization to start deletion. */
export async function inspectConfirmedOrphanOperation(
  id:string,sources:OrphanInspectionSources={},
):Promise<OrphanInspectionResult> {
  if(process.env.ORPHAN_WORKER_INSPECTION_ENABLED!=="true")
    throw new Error("Read-only orphan worker inspection is disabled");
  if(!OP_ID.test(id))throw new Error("Invalid orphan inspection operation ID");
  const now=sources.now?.()??new Date();
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid inspection time");
  const db=sources.db??documentClient;
  const journal=sources.journal??new DynamoOrphanJournal(db);
  const op=await journal.get(id);
  if(!op||op.id!==id)throw new Error("Orphan inspection operation was not found");
  const blockers:string[]=[];
  const result=():OrphanInspectionResult=>({
    operationId:op.id,caseId:op.caseId,profile:op.profile,
    status:blockers.length?"blocked":"inspection_passed_not_authorized",
    checkedAt:now.toISOString(),blockers:[...blockers],
    deletionAuthorized:false,executionQueued:false,
  });
  if(!validConfirmedOperation(op,now.getTime())) {
    blockers.push("Operation identity, phase or five-minute confirmation is invalid");
    return result();
  }
  const lock=await db.send(new GetCommand({
    TableName:stateTable(),Key:lockKey(op.caseId),ConsistentRead:true,
  }));
  if(!sameLock(op,lock.Item as Record<string,unknown>|undefined)) {
    blockers.push("Exclusive case lock is absent or does not match the operation");
    return result();
  }
  const fence=await (sources.inspectFence??inspectErasureFence)(op.profile);
  if(fence.fence)blockers.push("Another erasure profile fence is already present");
  if(!Array.isArray(fence.leases))
    blockers.push("Writer and admission lease inventory is incomplete");
  else if(fence.leases.length)
    blockers.push("Writer or admission leases are still in flight");
  if(blockers.length)return result();
  // A complete, stable SQS mapping manifest is required for a successful
  // read-only inspection. This is not an authorization to disable it.
  const mappings=await (sources.inspectMappings??(()=>inspectOrphanWorkerMappings()))();
  if(!mappings.verified||!mappings.fingerprint||!/^[a-f0-9]{64}$/.test(mappings.fingerprint)
    ||!Number.isInteger(mappings.timeoutSeconds)||!mappings.mappingCount
    ||mappings.blockers.length){
    blockers.push("Target worker SQS mapping inventory is missing, changing or unsafe");
    return result();
  }
  const proof=await (sources.collectProof??(operation=>collectOrphanEvidence(operation)))(op);
  try {assertTrustedProof(op,proof);}
  catch {blockers.push("Fresh direct-provider and state orphan proof is blocked or changed");}
  return result();
}
