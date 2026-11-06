/**
 * #351: narrowly scoped post-retirement incident cleanup. Provider objects and
 * all historical completion/replay evidence remain untouched.
 *
 * Fail closed on incomplete inventory, shared refs, active cases, concurrent
 * changes, or bounded transaction limits. It is safe to retry the SAME receipt.
 */
import {GetCommand,TransactWriteCommand,type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {retainedAuditProviderIds} from "./audit-policy.js";
import {strongInventory,type InventoryRow} from "./recurrence-retirement-inspection.js";
import {retirementDispositionKeys} from "./recurrence-retirement-disposition.js";
import {RetirementOperationService,type RetirementOperation} from "./recurrence-retirement-apply.js";
import type {Profile} from "./types.js";

type Db=Pick<DynamoDBDocumentClient,"send">;
export type CleanupPlan={
  operationId:string;profile:Profile;
  eligible:boolean;blockedReasons:string[];
  safeAuditKeys:string[];safeReferenceKeys:Array<{pk:string;sk:string}>;
  protectedRecordCount:number;
  providerWrites:false;
};
function reject(message:string,status=409):never{
  throw Object.assign(new Error(message),{status});
}
function table(){if(!process.env.STATE_TABLE_NAME)reject("State table required for retirement cleanup",503);return process.env.STATE_TABLE_NAME!;}
function expectedIds(op:RetirementOperation){
  return new Set([op.target.taskId,op.target.eventId,op.providerVersions?.masterEventId]
    .filter((v):v is string=>!!v));
}
function auditReferences(row:InventoryRow):{taskIds:string[];eventIds:string[]}|undefined{
  if(!row.detail || typeof row.detail!=="object"||Array.isArray(row.detail))return;
  return retainedAuditProviderIds(row.detail as Record<string,unknown>);
}
function key(row:{pk?:string;sk?:string}){return row.pk+"|"+row.sk;}
export function planRetirementIncidentCleanup(op:RetirementOperation,rows:readonly InventoryRow[]):CleanupPlan{
  if(op.status!=="retired"||!op.providerVersions?.masterEventId)
    reject("Only completed whole-series retirement receipts can be cleaned");
  const safeAuditKeys:string[]=[];
  const safeReferenceKeys:Array<{pk:string;sk:string}>=[];
  const blockers:string[]=[];
  let protectedRecordCount=0;
  const ids=expectedIds(op);
  const refs=new Map<string,InventoryRow>();
  const unique=new Set<string>();
  for(const row of rows){
    if(typeof row.pk!=="string"||typeof row.sk!=="string"||unique.has(key(row)))
      reject("Incomplete, duplicated or invalid state inventory");
    unique.add(key(row));
    if(row.pk.startsWith("AUDIT_REF#"+op.profile+"#"))
      refs.set(key(row),row);
  }
  const protectedKinds=["COMPLETED_EVENT#","COMPLETED_SERIES#","COMPLETED_HISTORY#",
    "ERASURE_REPLAY#","REPLAY#","DELIVERY#"];
  for(const row of rows){
    if(protectedKinds.some(type=>row.pk!.startsWith(type))){
      protectedRecordCount++;
      continue;
    }
    if(!row.pk!.startsWith("AUDIT#"+op.profile+"#") ||row.sk!=="STATE")continue;
    const references=auditReferences(row);
    const taskIds=references?.taskIds||[],eventIds=references?.eventIds||[];
    if(!taskIds.includes(op.target.taskId)&&!eventIds.includes(op.target.eventId))continue;
    if(!taskIds.length&&!eventIds.length)continue;
    if([...taskIds,...eventIds].some(id=>!ids.has(id))){
      protectedRecordCount++;
      continue;
    }
    if(typeof row.createdAt!=="string"||typeof row.action!=="string"
      ||typeof row.expiresAt!=="number"){
      protectedRecordCount++;
      blockers.push("Attributable audit has no immutable createdAt/action/TTL version: "+row.pk);
      continue;
    }
    // A significant audit already related to a distinct active review case
    // is never discarded just because its provider IDs overlap.
    if(rows.some(other=>String(other.pk).startsWith("REVIEW_CASE#")
      &&["open","repairing","queued","running","needs_review"].includes(String(other.status))
      &&(other.sourceAuditKey===row.pk||other.sourceAuditId===row.pk))){
      protectedRecordCount++;
      blockers.push("An open review case still references attributable audit "+row.pk);
      continue;
    }
    const indexed=rows.filter(ref=>ref.pk?.startsWith("AUDIT_REF#"+op.profile+"#")
      &&ref.auditKey===row.pk);
    const expectedPrefixes=[
      "AUDIT_REF#"+op.profile+"#todoist#"+op.target.taskId,
      "AUDIT_REF#"+op.profile+"#calendar#"+op.target.eventId,
      "AUDIT_REF#"+op.profile+"#calendar#"+op.providerVersions.masterEventId,
    ];
    const foreign=indexed.filter(ref=>!expectedPrefixes.includes(ref.pk!));
    if(foreign.length){
      blockers.push("Attributable audit has a foreign provider reverse index: "+foreign[0].pk);
      protectedRecordCount++;
      continue;
    }
    // Audit and reverse pointers are added as one unit, never an orphaned
    // pointer deletion when the underlying audit is preserved.
    safeAuditKeys.push(row.pk!);
    safeReferenceKeys.push(...indexed.map(ref=>({pk:ref.pk!,sk:ref.sk!})));
  }
  const duplicatePointers=new Set(safeReferenceKeys.map(key));
  if(duplicatePointers.size!==safeReferenceKeys.length)
    blockers.push("Duplicate conflict audit reference candidate found");
  // Audits and their reverse pointers must be removed together; if the bounded
  // batch is too large, report pending instead of deleting a random subset.
  if(safeAuditKeys.length+safeReferenceKeys.length+retirementDispositionKeys({
    profile:op.profile,taskId:op.target.taskId,seriesIds:[op.target.seriesId],
    eventIds:[op.target.eventId,op.providerVersions.masterEventId],
  }).length+1>65)
    blockers.push("Attributable cleanup exceeds the bounded single-transaction limit");
  return {
    operationId:op.operationId,profile:op.profile,eligible:blockers.length===0,
    blockedReasons:[...new Set(blockers)],safeAuditKeys:[...new Set(safeAuditKeys)].sort(),
    safeReferenceKeys:safeReferenceKeys.sort((a,b)=>key(a).localeCompare(key(b))),
    protectedRecordCount,providerWrites:false,
  };
}
export function buildIncidentCleanupTransaction(op:RetirementOperation,plan:CleanupPlan,
  rows:readonly InventoryRow[],now:string,stateTable:string):TransactWriteCommand{
  if(op.status!=="retired"||!plan.eligible||plan.blockedReasons.length
    ||op.operationId!==plan.operationId||op.profile!==plan.profile)
    reject("Incident cleanup requires the unchanged retired operation and complete safe plan");
  const index=new Map(rows.map(row=>[key(row),row]));
  const tableRows=plan.safeAuditKeys.map(pk=>{
    const row=index.get(pk+"|STATE");
    const refs=row&&auditReferences(row);
    const ids=expectedIds(op);
    if(!row||!refs||(refs.taskIds.length+refs.eventIds.length===0)
      ||[...refs.taskIds,...refs.eventIds].some(id=>!ids.has(id)))
      reject("Audit references changed after cleanup planning");
    return {Delete:{
      TableName:stateTable,Key:{pk,sk:"STATE"},
      ConditionExpression:"createdAt = :created AND #action = :action AND #detail = :detail AND expiresAt = :ttl",
      ExpressionAttributeNames:{"#action":"action","#detail":"detail"},
      ExpressionAttributeValues:{":created":row.createdAt,":action":row.action,
        ":detail":row.detail,":ttl":row.expiresAt},
    }};
  });
  const pointers=plan.safeReferenceKeys.map(ref=>{
    const row=index.get(key(ref));
    if(!row||typeof row.auditKey!=="string"||!plan.safeAuditKeys.includes(row.auditKey))
      reject("Audit reference changed during cleanup planning");
    return {Delete:{TableName:stateTable,Key:ref,
      ConditionExpression:"auditKey = :audit AND #profile = :profile",
      ExpressionAttributeNames:{"#profile":"profile"},
      ExpressionAttributeValues:{":audit":row.auditKey,":profile":op.profile}}};
  });
  const guard=retirementDispositionKeys({profile:op.profile,taskId:op.target.taskId,
    eventIds:[op.target.eventId,op.providerVersions!.masterEventId],
    seriesIds:[op.target.seriesId]}).map(Key=>({ConditionCheck:{
    TableName:stateTable,Key,
    ConditionExpression:"operationId = :id AND #status = :retired",
    ExpressionAttributeNames:{"#status":"status"},
    ExpressionAttributeValues:{":id":op.operationId,":retired":"retired"},
  }}));
  const operation={Update:{
    TableName:stateTable,Key:{pk:"RETIREMENT_OPERATION#"+op.operationId,sk:"STATE"},
    UpdateExpression:"SET cleanupStatus = :done, cleanupCheckedAt = :now, cleanedAuditCount = :count, retainedEvidenceCount = :protected, updatedAt = :now",
    ConditionExpression:"#status = :retired AND (attribute_not_exists(cleanupStatus) OR cleanupStatus = :pending OR cleanupStatus = :done)",
    ExpressionAttributeNames:{"#status":"status"},
    ExpressionAttributeValues:{":retired":"retired",":pending":"pending",
      ":done":"completed",":now":now,":count":plan.safeAuditKeys.length,
      ":protected":plan.protectedRecordCount},
  }};
  return new TransactWriteCommand({TransactItems:[...tableRows,...pointers,...guard,operation] as never});
}
export class RetirementIncidentCleanupService {
  private readonly db:Db;
  private readonly inventory:()=>Promise<InventoryRow[]>;
  private readonly ops:RetirementOperationService;
  constructor(deps:{db?:Db;inventory?:()=>Promise<InventoryRow[]>}={}){
    this.db=deps.db||documentClient;
    this.inventory=deps.inventory||strongInventory;
    this.ops=new RetirementOperationService({db:this.db});
  }
  async cleanup(operationId:string,actorSubject:string):Promise<{
    operationId:string;status:"completed"|"needs_review";
    deletedAudits:number;protectedRecords:number;blockers:string[];providerWrites:false;
  }>{
    const op=await this.ops.get(operationId);
    if(!op||op.actorSubject!==actorSubject)reject("Unknown or unowned retirement operation",403);
    if(op.status!=="retired")reject("Only completed retirements may clean attributable incidents");
    const rows=await this.inventory();
    const plan=planRetirementIncidentCleanup(op,rows);
    if(!plan.eligible)return {operationId,status:"needs_review",deletedAudits:0,
      protectedRecords:plan.protectedRecordCount,blockers:plan.blockedReasons,providerWrites:false};
    const command=buildIncidentCleanupTransaction(op,plan,rows,new Date().toISOString(),table());
    try{await this.db.send(command);}
    catch(error){
      if((error as {name?:string}).name==="TransactionCanceledException")
        reject("Incident evidence changed before conditional cleanup; no audit was deleted");
      throw error;
    }
    return {operationId,status:"completed",deletedAudits:plan.safeAuditKeys.length,
      protectedRecords:plan.protectedRecordCount,blockers:[],providerWrites:false};
  }
}
