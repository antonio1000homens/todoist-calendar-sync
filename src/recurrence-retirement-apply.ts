/**
 * #351 phase 4: explicit, version-bound, operator-approved KEEP-PROVIDER
 * association retirement. Only DynamoDB state changes; no Todoist/Calendar
 * mutation method is invoked.
 *
 * Fencing protocol:
 *  - the review API authenticates the operator and issues a private token;
 *  - Apply installs an epoch-incrementing profile erasure-protocol fence;
 *  - ALL existing worker/admission leases must drain before fresh inspection;
 *  - a single conditional Dynamo transaction retires indices and installs
 *    durable scoped tombstones/receipt;
 *  - release the profile fence only after the transaction succeeds.
 *
 * A crash during fencing is resumable with the SAME operation/token. Unknown
 * transaction outcomes leave the profile fenced until verified, never assumed
 * to have failed. Incident cleanup/Undo are separate follow-up phases.
 */
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import { beginErasureFence, finishErasureFence, inspectErasureFence } from "./erasure-protocol.js";
import { retirementDispositionEnabled, retirementDispositionKeys } from "./recurrence-retirement-disposition.js";
import { previewRecurrenceRetirement, type RetirementPreview } from "./recurrence-retirement-preview.js";
import { reviewHash } from "./review-store.js";
import type { InventoryRow, RetirementDiagnosticTarget, RetirementInspectionDependencies } from "./recurrence-retirement-inspection.js";
import type { Profile } from "./types.js";

const validOperationId=/^[0-9a-f-]{36}$/i;
const validFingerprint=/^[a-f0-9]{64}$/;
const APPROVAL_MS=30*60_000;
export const RETIREMENT_APPROVAL_PHRASE="RETIRE ASSOCIATION KEEP PROVIDER ITEMS";
type Db=Pick<DynamoDBDocumentClient,"send">;
export type RetirementOperation={
  pk:string;sk:"STATE";operationId:string;profile:Profile;
  target:RetirementDiagnosticTarget;actorSubject:string;
  status:"previewed"|"fencing"|"needs_review"|"retired"|"re_enabled";
  planFingerprint:string;inspectionFingerprint:string;
  confirmationHash:string;confirmationExpiresAt:string;
  createdAt:string;retiredAt?:string;updatedAt?:string;
  lookupPk?:string;lookupSk?:string;
  /** Provider identity/ETag proof held stable across future Undo checks. */
  providerVersions?: {masterEventId:string;masterEtag:string;occurrenceEtag:string;
    completedAt:string;rrule:string[]};
  cleanupStatus?:"pending"|"completed";
  retainedEvidenceCount?:number;
};
export type RetirementOperationStatus={
  operationId:string;profile:Profile;target:RetirementDiagnosticTarget;
  status:RetirementOperation["status"];createdAt:string;
  retiredAt?:string;cleanupStatus?:RetirementOperation["cleanupStatus"];
  planFingerprint:string;retainedEvidenceCount?:number;
  profileFenceActive?:boolean;
};
export type IssueRetirementApproval={
  operation:RetirementOperationStatus;
  confirmationId:string;
  phrase:typeof RETIREMENT_APPROVAL_PHRASE;
  providerWrites:false;
};
type FenceInspection=Awaited<ReturnType<typeof inspectErasureFence>>;
export type RetirementOperationDependencies={
  db?:Db;
  preview?:typeof previewRecurrenceRetirement;
  inspector?:RetirementInspectionDependencies;
  beginFence?:(profile:Profile,operationId:string)=>Promise<void>;
  inspectFence?:(profile:Profile)=>Promise<FenceInspection>;
  finishFence?:(profile:Profile,operationId:string)=>Promise<void>;
};
function error(message:string,status=409):never {
  throw Object.assign(new Error(message),{status});
}
function table():string {
  if(!process.env.STATE_TABLE_NAME)error("Retirement requires STATE_TABLE_NAME",503);
  return process.env.STATE_TABLE_NAME!;
}
function requireExecutionGate():void {
  if(process.env.ERASURE_PROTOCOL_VERSION!=="1" || !retirementDispositionEnabled())
    error("Operator retirement requires enabled profile fencing and durable retirement admission",503);
}
function operationKey(id:string){return {pk:"RETIREMENT_OPERATION#"+id,sk:"STATE"} as const;}
function sha(value:string){return createHash("sha256").update(value).digest("hex");}
function exposed(value:RetirementOperation):RetirementOperationStatus {
  return {operationId:value.operationId,profile:value.profile,target:value.target,
    status:value.status,createdAt:value.createdAt,planFingerprint:value.planFingerprint,
    ...(value.retiredAt?{retiredAt:value.retiredAt}:{}),
    ...(value.cleanupStatus?{cleanupStatus:value.cleanupStatus}:{}),
    ...(value.retainedEvidenceCount!==undefined?{retainedEvidenceCount:value.retainedEvidenceCount}:{})};
}
function sameTarget(a:RetirementDiagnosticTarget,b:RetirementDiagnosticTarget):boolean {
  return a.profile===b.profile && a.generation===b.generation
    && a.taskId===b.taskId && a.eventId===b.eventId && a.seriesId===b.seriesId;
}
function rowKey(row:{pk?:string;sk?:string}){return row.pk+"|"+row.sk;}
/** Literal row CAS: every currently stored attribute is compared at commit. */
function conditionalDelete(tableName:string, row:InventoryRow) {
  if(!row.pk||!row.sk)error("Retirement record has no storage key");
  const names:Record<string,string>={};
  const values:Record<string,unknown>={};
  const predicates=["attribute_exists(pk)"];
  let i=0;
  for(const [field,value] of Object.entries(row)){
    if(field==="pk"||field==="sk"||value===undefined)continue;
    const fieldKey="#a"+i,valueKey=":v"+i;
    names[fieldKey]=field;values[valueKey]=value;
    predicates.push(fieldKey+" = "+valueKey);i+=1;
  }
  // Fail closed if the record has no independently useful revision fields.
  if(i<2)error("Retirement record is missing version or identity attributes: "+row.pk);
  return {Delete:{TableName:tableName,Key:{pk:row.pk,sk:row.sk},
    ConditionExpression:predicates.join(" AND "),
    ExpressionAttributeNames:names,ExpressionAttributeValues:values}};
}
function guardControl(tableName:string,pk:string) {
  return {ConditionCheck:{TableName:tableName,Key:{pk,sk:"STATE"},
    ConditionExpression:"attribute_not_exists(activeRepair) AND (attribute_not_exists(excluded) OR excluded = :false) AND (attribute_not_exists(pendingRefresh) OR pendingRefresh = :false) AND attribute_not_exists(pendingRefreshAt)",
    ExpressionAttributeValues:{":false":false}}};
}
/**
 * Pure transaction builder, independently testable. No arbitrary inventory row
 * can be deleted: the keys and complete fingerprints must appear in the exact
 * safety-assessed plan. Records with shared audit/case references are untouched.
 */
export function buildRetirementTransaction(
  operation:RetirementOperation,
  preview:RetirementPreview,
  inventory:readonly InventoryRow[],
  timestamp:string,
  tableName:string,
):TransactWriteCommand {
  const target=operation.target;
  if(operation.status!=="previewed"&&operation.status!=="fencing")
    error("Retirement operation has an incompatible status");
  if(!sameTarget(preview.target,target)||preview.planFingerprint!==operation.planFingerprint
    ||preview.inspectionFingerprint!==operation.inspectionFingerprint
    ||preview.status!=="reviewable"||preview.blockers.length)
    error("Retirement evidence changed since operator approval");
  const expectedIndexes=[
    "TASK#"+target.profile+"#"+target.taskId+"|MAP",
    "TASKOWNER#"+target.taskId+"|MAP",
    "EVENT#"+target.profile+"#"+target.eventId+"|MAP",
    "RECURRENCE#"+target.profile+"#"+target.seriesId+"|STATE",
  ].sort();
  const actual=preview.indexRemovalCandidates.map(rowKey).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expectedIndexes))
    error("Whole-series retirement requires the exact four stable mapping/index keys");
  if(preview.conditionalCleanupCandidates.length>16)
    error("Retirement cleanup is not bounded");
  const approved=new Map([...preview.indexRemovalCandidates,
    ...preview.conditionalCleanupCandidates].map(item=>[rowKey(item),item]));
  if(approved.size!==4+preview.conditionalCleanupCandidates.length)
    error("Retirement plan contains overlapping state keys");
  const inventoryByKey=new Map<string,InventoryRow>();
  for(const row of inventory){
    if(!row.pk||!row.sk||inventoryByKey.has(rowKey(row)))
      error("Retirement scan has malformed or repeated state keys");
    inventoryByKey.set(rowKey(row),row);
  }
  const deletes=[...approved].map(([id,planned])=>{
    const row=inventoryByKey.get(id);
    if(!row||reviewHash(row)!==planned.recordFingerprint)
      error("Mapping, canonical or baseline changed after preview: "+id);
    if(!expectedIndexes.includes(id) &&
      !(
        id==="BASELINE#"+target.profile+"#TASK#"+target.taskId+"|RECONCILE"
        ||id==="CANONICAL#"+target.profile+"#todoist#"+target.taskId+"|STATE"
        ||id==="CANONICAL#"+target.profile+"#calendar#"+target.eventId+"|STATE"
      ))error("Retirement plan contains a non-attributable cleanup record");
    return conditionalDelete(tableName,row);
  });
  const mapping=inventoryByKey.get("TASK#"+target.profile+"#"+target.taskId+"|MAP");
  if(!mapping || mapping.activeInstanceId!==target.eventId
    || typeof mapping.masterEventId!=="string"||!mapping.masterEventId
    ||mapping.recurrenceOwner!=="calendar"||mapping.seriesId!==target.seriesId)
    error("Retirement transaction does not identify one Calendar-owned active whole series");
  const markerIds={
    profile:target.profile,taskId:target.taskId,seriesIds:[target.seriesId],
    eventIds:[...new Set([target.eventId,mapping.masterEventId].filter((x):x is string=>typeof x==="string"))],
  };
  const markers=retirementDispositionKeys(markerIds);
  if(JSON.stringify(markers.map(x=>x.pk).sort())
    !==JSON.stringify(preview.futureSuppressionIdentityKeys.slice().sort()))
    error("Future re-import exclusion does not cover the complete approved identity");
  const markerRows=markers.map(Key=>({Put:{TableName:tableName,
    Item:{...Key,profile:target.profile,operationId:operation.operationId,
      status:"retired",taskId:target.taskId,seriesId:target.seriesId,
      masterEventId:mapping.masterEventId,createdAt:timestamp,
      planFingerprint:operation.planFingerprint},
    ConditionExpression:"attribute_not_exists(pk)"}}));
  // A separate writer profile could otherwise race an owner into the same
  // event/series between the strongly consistent scan and this transaction.
  const otherProfiles=(["home","antonio","work"] as const).filter(p=>p!==target.profile);
  const foreignGuardKeys=otherProfiles.flatMap(p=>[
    "TASK#"+p+"#"+target.taskId,
    "EVENT#"+p+"#"+target.eventId,
    "EVENT#"+p+"#"+mapping.masterEventId,
    "RECURRENCE#"+p+"#"+target.seriesId,
  ]);
  const foreignGuards=foreignGuardKeys.map(pk=>({ConditionCheck:{
    TableName:tableName,Key:{pk,sk:pk.startsWith("RECURRENCE#")?"STATE":"MAP"},
    ConditionExpression:"attribute_not_exists(pk)"}}));
  const controlKeys=[
    "SYNC_CONTROL#"+target.profile+":todoist:"+target.taskId,
    ...[target.eventId,mapping.masterEventId].map(id=>"SYNC_CONTROL#"+target.profile+":calendar:"+id),
  ];
  const receipt={Update:{
    TableName:tableName,Key:operationKey(operation.operationId),
    UpdateExpression:"SET #status = :retired, retiredAt = :at, updatedAt = :at, cleanupStatus = :pending, retainedEvidenceCount = :count",
    ConditionExpression:"(#status = :previewed OR #status = :fencing) AND confirmationHash = :confirmation AND planFingerprint = :fingerprint AND actorSubject = :actor",
    ExpressionAttributeNames:{"#status":"status"},
    ExpressionAttributeValues:{
      ":retired":"retired",":previewed":"previewed",":fencing":"fencing",
      ":at":timestamp,":pending":"pending",
      ":count":preview.incidentEvidenceForSeparateReview.length,
      ":confirmation":operation.confirmationHash,":fingerprint":operation.planFingerprint,
      ":actor":operation.actorSubject,
    },
  }};
  const fenceCheck={ConditionCheck:{TableName:tableName,
    Key:{pk:"ERASURE#"+target.profile,sk:"FENCE"},
    ConditionExpression:"operationId = :id AND #state = :active",
    ExpressionAttributeNames:{"#state":"state"},
    ExpressionAttributeValues:{":id":operation.operationId,":active":"active"}}};
  const items=[...deletes,...markerRows,...foreignGuards,
    ...controlKeys.map(pk=>guardControl(tableName,pk)),fenceCheck,receipt];
  if(items.length>75)error("Retirement transaction exceeds bounded DynamoDB item count");
  // A transaction containing both the marker and all index deletes ensures
  // there is no moment in which a removed mapping can be recreated unfenced.
  return new TransactWriteCommand({TransactItems:items as never});
}
export class RetirementOperationService {
  private readonly db:Db;
  private readonly preview:typeof previewRecurrenceRetirement;
  private readonly beginFence:(p:Profile,id:string)=>Promise<void>;
  private readonly inspectFence:(p:Profile)=>Promise<FenceInspection>;
  private readonly finishFence:(p:Profile,id:string)=>Promise<void>;
  constructor(private readonly deps:RetirementOperationDependencies={}) {
    this.db=deps.db||documentClient;
    this.preview=deps.preview||previewRecurrenceRetirement;
    this.beginFence=deps.beginFence||beginErasureFence;
    this.inspectFence=deps.inspectFence||inspectErasureFence;
    this.finishFence=deps.finishFence||finishErasureFence;
  }
  async get(operationId:string):Promise<RetirementOperation|undefined> {
    if(!validOperationId.test(operationId))error("Invalid retirement operation ID",400);
    const result=await this.db.send(new GetCommand({
      TableName:table(),Key:operationKey(operationId),ConsistentRead:true}));
    if(!result.Item)return undefined;
    const value=result.Item as RetirementOperation;
    if(value.operationId!==operationId||value.pk!==operationKey(operationId).pk
      ||!value.target||value.profile!==value.target.profile)
      error("Retirement receipt identity is corrupt");
    return value;
  }
  async status(operationId:string,actorSubject:string):Promise<RetirementOperationStatus> {
    const op=await this.get(operationId);
    if(!op)error("Retirement operation not found",404);
    if(op.actorSubject!==actorSubject)error("Retirement operation belongs to another operator",403);
    const state=exposed(op);
    if(op.status==="fencing"||op.status==="needs_review"||op.status==="retired"){
      const fence=await this.inspectFence(op.profile);
      state.profileFenceActive=fence.fence?.operationId===op.operationId;
    }
    return state;
  }
  async history(profile:Profile,limit=50):Promise<RetirementOperationStatus[]> {
    if(!(["home","antonio","work"] as const).includes(profile))
      error("Invalid history profile",400);
    const page=await this.db.send(new QueryCommand({TableName:table(),
      IndexName:"ProfileLookupIndex",
      KeyConditionExpression:"lookupPk = :profile AND begins_with(lookupSk,:prefix)",
      ExpressionAttributeValues:{":profile":"PROFILE#"+profile,
        ":prefix":"RETIREMENT_OPERATION#"},
      Limit:Math.min(50,Math.max(1,limit)),ScanIndexForward:false}));
    return ((page.Items||[]) as RetirementOperation[])
      .filter(item=>item.profile===profile&&["retired","re_enabled"].includes(item.status))
      .map(exposed);
  }

  async issue(
    target:RetirementDiagnosticTarget,expectedFingerprint:string,actorSubject:string,
  ):Promise<IssueRetirementApproval> {
    requireExecutionGate();
    if(!validFingerprint.test(expectedFingerprint)||!actorSubject)
      error("Exact current retirement preview and authenticated operator required",400);
    const {inspection,preview}=await this.preview(target,this.deps.inspector);
    if(preview.status!=="reviewable"||!inspection.eligibleForFutureApproval)
      error("Retirement preview contains unresolved safety blockers");
    if(preview.planFingerprint!==expectedFingerprint)
      error("The preview changed; inspect the new version before requesting approval");
    const operationId=randomUUID(),confirmationId=randomUUID();
    const timestamp=new Date().toISOString();
    const operation:RetirementOperation={
      ...operationKey(operationId),operationId,profile:target.profile,target,actorSubject,
      lookupPk:"PROFILE#"+target.profile,
      lookupSk:"RETIREMENT_OPERATION#"+timestamp+"#"+operationId,
      planFingerprint:preview.planFingerprint,inspectionFingerprint:preview.inspectionFingerprint,
      confirmationHash:sha(confirmationId),confirmationExpiresAt:new Date(Date.now()+APPROVAL_MS).toISOString(),
      createdAt:timestamp,status:"previewed",
      ...(inspection.mapping?.masterEventId && inspection.calendar.master?.etag
        && inspection.calendar.occurrence?.etag && inspection.task.status==="completed_verified"
        && inspection.task.value && "completed_at" in inspection.task.value
        && Array.isArray(inspection.calendar.master.recurrence)
        ?{providerVersions:{
          masterEventId:inspection.mapping.masterEventId,
          masterEtag:inspection.calendar.master.etag,
          occurrenceEtag:inspection.calendar.occurrence.etag,
          completedAt:String(inspection.task.value.completed_at),
          rrule:inspection.calendar.master.recurrence,
        }}:{}),
    };
    await this.db.send(new PutCommand({TableName:table(),Item:operation,
      ConditionExpression:"attribute_not_exists(pk)"}));
    return {operation:exposed(operation),confirmationId,phrase:RETIREMENT_APPROVAL_PHRASE,providerWrites:false};
  }
  private async noteRejectedPreflight(operationId:string,actorSubject:string):Promise<void> {
    await this.db.send(new UpdateCommand({TableName:table(),Key:operationKey(operationId),
      UpdateExpression:"SET #status = :review, updatedAt = :now",
      ConditionExpression:"#status = :fencing AND actorSubject = :actor",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":review":"needs_review",":fencing":"fencing",
        ":actor":actorSubject,":now":new Date().toISOString()}}));
  }

  async apply(
    operationId:string,confirmationId:string,profile:Profile,actorSubject:string,phrase:string,
  ):Promise<RetirementOperationStatus> {
    requireExecutionGate();
    if(phrase!==RETIREMENT_APPROVAL_PHRASE||!validOperationId.test(operationId)
      ||!validOperationId.test(confirmationId))
      error("Apply requires exact operation, token and typed keep-provider confirmation",400);
    const operation=await this.get(operationId);
    if(!operation)error("Retirement operation not found",404);
    if(operation.actorSubject!==actorSubject||operation.profile!==profile)
      error("Retirement approval does not belong to this operator and profile",403);
    if(operation.confirmationHash!==sha(confirmationId))
      error("Retirement approval token does not match",403);
    if(operation.status==="re_enabled")error("This retirement has already been undone");
    if(operation.status==="retired"){
      // A lost response after successful transaction is an idempotent success.
      const fence=await this.inspectFence(profile);
      if(fence.fence?.operationId===operationId&&!fence.leases.length)
        await this.finishFence(profile,operationId);
      return exposed(operation);
    }
    if(!["previewed","fencing"].includes(operation.status))
      error("Retirement operation is not applicable");
    // An existing fence owned by THIS operation remains resumable even if a
    // 30-minute token expired while an earlier writer drained. The same
    // confirmation token and the same authenticated operator are still needed.
    const existingFence=await this.inspectFence(profile);
    if(Date.parse(operation.confirmationExpiresAt)<=Date.now()
      && existingFence.fence?.operationId!==operationId)
      error("Retirement approval expired; start a new preview");
    await this.beginFence(profile,operationId);
    const drain=await this.inspectFence(profile);
    if(drain.fence?.operationId!==operationId)
      error("Another operation owns the profile write fence");
    if(operation.status==="previewed"){
      // A durable "fencing" receipt makes an interrupted operation discoverable
      // and preserves its original approval as the only resumable identity.
      await this.db.send(new UpdateCommand({TableName:table(),Key:operationKey(operationId),
        UpdateExpression:"SET #status = :fencing, updatedAt = :now",
        ConditionExpression:"#status = :previewed AND actorSubject = :actor AND confirmationHash = :confirmation",
        ExpressionAttributeNames:{"#status":"status"},
        ExpressionAttributeValues:{":fencing":"fencing",":previewed":"previewed",
          ":now":new Date().toISOString(),":actor":actorSubject,":confirmation":operation.confirmationHash}}));
    }
    if(drain.leases.length){
      // All writers are barred from acquiring a NEW lease. Existing in-flight
      // writes must drain before we run the exact read/transaction.
      return {...exposed(operation),status:"fencing",profileFenceActive:true};
    }
    let command:TransactWriteCommand;
    try {
      let inventory:readonly InventoryRow[]|undefined;
      const {inspection,preview}=await this.preview(operation.target,{
        ...this.deps.inspector,onInventory:rows=>{
          inventory=rows;this.deps.inspector?.onInventory?.(rows);
        },
      });
      if(!inventory||preview.status!=="reviewable"||!inspection.eligibleForFutureApproval
        ||preview.planFingerprint!==operation.planFingerprint
        ||preview.inspectionFingerprint!==operation.inspectionFingerprint)
        error("Retirement changed after approval; no state changes were applied");
      command=buildRetirementTransaction(operation,preview,inventory,new Date().toISOString(),table());
    } catch (preflightError) {
      // No DynamoDB retirement transaction has been sent. Releasing our
      // exclusive profile fence is safe; the stale approval remains unusable
      // because any retry must pass the same version check.
      await this.finishFence(profile,operationId);
      await this.noteRejectedPreflight(operationId,actorSubject);
      throw preflightError;
    }
    try{await this.db.send(command);}
    catch(writeError) {
      // A rejected DynamoDB transaction is atomic and had no writes; release
      // the temporary profile fence and let the operator re-inspect.
      // For transport/unknown outcomes, keep the fence and require receipt
      // readback on retry before any release.
      if((writeError as {name?:string}).name==="TransactionCanceledException"){
        await this.finishFence(profile,operationId);
        await this.noteRejectedPreflight(operationId,actorSubject);
        error("A mapping, repair or owner changed before atomic retirement");
      }
      throw writeError;
    }
    await this.finishFence(profile,operationId);
    const updated=await this.get(operationId);
    if(!updated||updated.status!=="retired")
      error("Retirement receipt readback was unavailable; exclusions remain active",503);
    return exposed(updated);
  }
}
