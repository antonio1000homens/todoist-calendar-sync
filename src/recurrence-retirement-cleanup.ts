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
  /** Closed review incidents exclusively associated with an approved audit. */
  safeClosedCaseKeys:Array<{pk:string;sk:string}>;
  safeClosedConflictPointerKeys:Array<{pk:string;sk:string}>;
  safeResolvedManualKeys:Array<{pk:string;sk:string}>;
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
  const safeClosedCaseKeys:Array<{pk:string;sk:string}>=[];
  const safeClosedConflictPointerKeys:Array<{pk:string;sk:string}>=[];
  const safeResolvedManualKeys:Array<{pk:string;sk:string}>=[];
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
  // An attributable audit can have a persisted review case. Never delete its
  // source audit while leaving a dangling live/terminal case behind. Only an
  // exact closed incident (no ongoing repair, hand-off, or coalesced successor)
  // may be retired together with its owned conflict pointer/manual decision.
  const auditSet=new Set(safeAuditKeys);
  for(const review of rows.filter(row=>String(row.pk).startsWith("REVIEW_CASE#")
    &&typeof row.sourceAuditKey==="string"&&auditSet.has(row.sourceAuditKey))){
    const id=review.id;
    const caseKey={pk:review.pk!,sk:review.sk!};
    const taskId=review.taskId,eventId=review.eventId;
    if(review.sk!=="STATE"||typeof id!=="string"||caseKey.pk!=="REVIEW_CASE#"+id
      ||review.profile!==op.profile
      ||!["resolved","dismissed"].includes(String(review.status))
      ||typeof review.updatedAt!=="string"||typeof review.createdAt!=="string"
      ||review.operationId||review.coalescedInto||review.progressCheckpoint
      ||(taskId!==undefined&&taskId!==op.target.taskId)
      ||(eventId!==undefined&&!ids.has(String(eventId)))){
      blockers.push("An attributable audit is still referenced by a live, shared or unverified review case: "+caseKey.pk);
      continue;
    }
    const pointer=typeof review.conflictKey==="string"
      ?rows.find(row=>row.pk==="REVIEW_CONFLICT#"+op.profile+"#"+review.conflictKey
        &&row.sk==="INCIDENT#"+id):undefined;
    if(review.conflictKey!==undefined && (!pointer
      ||pointer.incidentId!==id||pointer.profile!==op.profile
      ||pointer.conflictKey!==review.conflictKey)){
      blockers.push("Closed review conflict pointer is missing or changed: "+caseKey.pk);
      continue;
    }
    const manual=rows.find(row=>row.pk==="MANUAL#"+id);
    if(manual && (manual.sk!=="STATE"||manual.profile!==op.profile
      ||manual.decisionId!==id||manual.status!=="resolved"
      ||typeof manual.createdAt!=="string"
      ||manual.operationId||manual.lookupPk||manual.lookupSk)){
      blockers.push("Closed review has an active or unverified manual decision: "+caseKey.pk);
      continue;
    }
    // A conflict pointer must NEVER represent a different case, even when
    // a shared conflict fingerprint has multiple closed incidents.
    safeClosedCaseKeys.push(caseKey);
    if(pointer)safeClosedConflictPointerKeys.push({pk:pointer.pk!,sk:pointer.sk!});
    if(manual)safeResolvedManualKeys.push({pk:manual.pk!,sk:manual.sk!});
  }
  const duplicatePointers=new Set(safeReferenceKeys.map(key));
  if(duplicatePointers.size!==safeReferenceKeys.length)
    blockers.push("Duplicate conflict audit reference candidate found");
  // Audits and their reverse pointers must be removed together; if the bounded
  // batch is too large, report pending instead of deleting a random subset.
  if(safeAuditKeys.length+safeReferenceKeys.length
    +safeClosedCaseKeys.length+safeClosedConflictPointerKeys.length
    +safeResolvedManualKeys.length+retirementDispositionKeys({
    profile:op.profile,taskId:op.target.taskId,seriesIds:[op.target.seriesId],
    eventIds:[op.target.eventId,op.providerVersions.masterEventId],
  }).length+1>65)
    blockers.push("Attributable cleanup exceeds the bounded single-transaction limit");
  return {
    operationId:op.operationId,profile:op.profile,eligible:blockers.length===0,
    blockedReasons:[...new Set(blockers)],safeAuditKeys:[...new Set(safeAuditKeys)].sort(),
    safeReferenceKeys:safeReferenceKeys.sort((a,b)=>key(a).localeCompare(key(b))),
    safeClosedCaseKeys:safeClosedCaseKeys.sort((a,b)=>key(a).localeCompare(key(b))),
    safeClosedConflictPointerKeys:safeClosedConflictPointerKeys.sort((a,b)=>key(a).localeCompare(key(b))),
    safeResolvedManualKeys:safeResolvedManualKeys.sort((a,b)=>key(a).localeCompare(key(b))),
    protectedRecordCount,providerWrites:false,
  };
}
export function buildIncidentCleanupTransaction(op:RetirementOperation,plan:CleanupPlan,
  rows:readonly InventoryRow[],now:string,stateTable:string):TransactWriteCommand{
  if(op.status!=="retired"||!plan.eligible||plan.blockedReasons.length
    ||op.operationId!==plan.operationId||op.profile!==plan.profile)
    reject("Incident cleanup requires the unchanged retired operation and complete safe plan");
  const checked=planRetirementIncidentCleanup(op,rows);
  const manifest=(value:CleanupPlan)=>JSON.stringify({
    audits:value.safeAuditKeys,
    refs:value.safeReferenceKeys.map(key),
    cases:value.safeClosedCaseKeys.map(key),
    conflicts:value.safeClosedConflictPointerKeys.map(key),
    manuals:value.safeResolvedManualKeys.map(key),
  });
  if(!checked.eligible||manifest(plan)!==manifest(checked))
    reject("Review case or audit cleanup manifest changed since planning");
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
  const closedCases=plan.safeClosedCaseKeys.map(ref=>{
    const row=index.get(key(ref));
    if(!row||!["resolved","dismissed"].includes(String(row.status))
      ||typeof row.sourceAuditKey!=="string"
      ||!plan.safeAuditKeys.includes(row.sourceAuditKey)
      ||row.profile!==op.profile||row.operationId||row.coalescedInto)
      reject("Review case no longer belongs exclusively to the retired audit");
    return {Delete:{TableName:stateTable,Key:ref,
      ConditionExpression:"#s = :s AND #profile = :profile AND updatedAt = :updated AND createdAt = :created AND sourceAuditKey = :audit AND attribute_not_exists(operationId) AND attribute_not_exists(coalescedInto)",
      ExpressionAttributeNames:{"#s":"status","#profile":"profile"},
      ExpressionAttributeValues:{":s":row.status,":profile":op.profile,
        ":updated":row.updatedAt,":created":row.createdAt,":audit":row.sourceAuditKey}}};
  });
  const closedConflictPointers=plan.safeClosedConflictPointerKeys.map(ref=>{
    const row=index.get(key(ref));
    if(!row||typeof row.incidentId!=="string"||row.profile!==op.profile
      ||ref.pk!=="REVIEW_CONFLICT#"+op.profile+"#"+row.conflictKey
      ||ref.sk!=="INCIDENT#"+row.incidentId
      ||!plan.safeClosedCaseKeys.some(item=>item.pk==="REVIEW_CASE#"+row.incidentId))
      reject("Closed conflict pointer is no longer exclusively attributable");
    return {Delete:{TableName:stateTable,Key:ref,
      ConditionExpression:"incidentId = :id AND #profile = :profile AND conflictKey = :conflict",
      ExpressionAttributeNames:{"#profile":"profile"},
      ExpressionAttributeValues:{":id":row.incidentId,":profile":op.profile,":conflict":row.conflictKey}}};
  });
  const resolvedManuals=plan.safeResolvedManualKeys.map(ref=>{
    const row=index.get(key(ref));
    if(!row||row.status!=="resolved"||row.profile!==op.profile
      ||ref.pk!=="MANUAL#"+row.decisionId||row.sk!=="STATE"
      ||!plan.safeClosedCaseKeys.some(item=>item.pk==="REVIEW_CASE#"+row.decisionId))
      reject("Manual decision is not exclusively attributable to a closed review");
    return {Delete:{TableName:stateTable,Key:ref,
      ConditionExpression:"#s = :resolved AND #profile = :profile AND decisionId = :id AND createdAt = :created AND attribute_not_exists(operationId)",
      ExpressionAttributeNames:{"#s":"status","#profile":"profile"},
      ExpressionAttributeValues:{":resolved":"resolved",":profile":op.profile,
        ":id":row.decisionId,":created":row.createdAt}}};
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
  return new TransactWriteCommand({TransactItems:[...tableRows,...pointers,
    ...closedCases,...closedConflictPointers,...resolvedManuals,...guard,operation] as never});
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
