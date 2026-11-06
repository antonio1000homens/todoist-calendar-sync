/**
 * #351: scoped, operator-approved retirement Undo.
 *
 * Undo removes ONLY this operation's exact DynamoDB exclusion markers.
 * It never recreates mappings, comments, tasks or Calendar events. All
 * original completed-history/replay markers remain unchanged.
 */
import {createHash,randomUUID} from "node:crypto";
import {GetCommand,UpdateCommand,TransactWriteCommand,
  type DynamoDBDocumentClient} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {beginErasureFence,finishErasureFence,inspectErasureFence} from "./erasure-protocol.js";
import {retirementDispositionKeys,retirementDispositionEnabled} from "./recurrence-retirement-disposition.js";
import {strongInventory,type InventoryRow} from "./recurrence-retirement-inspection.js";
import {defaultProviderClientFactory,type ProviderClientFactory} from "./mutation-budget.js";
import {RetirementOperationService,type RetirementOperation} from "./recurrence-retirement-apply.js";
import {reviewHash} from "./review-store.js";
import type {CalendarEvent,Profile} from "./types.js";

export const RETIREMENT_UNDO_PHRASE="RE-ENABLE ASSOCIATION SYNC WITHOUT RESTORING MAPPING";
const UUID=/^[0-9a-f-]{36}$/i;
const PROFILES=["home","antonio","work"] as const;
type Db=Pick<DynamoDBDocumentClient,"send">;
type LeaseState=Awaited<ReturnType<typeof inspectErasureFence>>;
export type UndoInspection={
  operationId:string;profile:Profile;
  scope:"operator_retirement_only";
  checkedAt:string;blockers:string[];
  eligible:boolean;fingerprint:string;
  markerKeys:string[];providerWrites:false;stateWrites:false;
  completionHistoryPreserved:true;
};
export type UndoDependencies={
  db?:Db;
  clientFactory?:ProviderClientFactory;
  inventory?:()=>Promise<InventoryRow[]>;
  beginFence?:(profile:Profile,id:string)=>Promise<void>;
  inspectFence?:(profile:Profile)=>Promise<LeaseState>;
  finishFence?:(profile:Profile,id:string)=>Promise<void>;
};
function reject(message:string,status=409):never {
  throw Object.assign(new Error(message),{status});
}
function table():string {
  if(!process.env.STATE_TABLE_NAME)reject("State table is required for Undo",503);
  return process.env.STATE_TABLE_NAME!;
}
function assertGate(){
  if(process.env.ERASURE_PROTOCOL_VERSION!=="1"||!retirementDispositionEnabled())
    reject("Retirement Undo requires the durable admission and writer fence",503);
}
function sha(value:string){return createHash("sha256").update(value).digest("hex");}
function opKey(id:string){return {pk:"RETIREMENT_OPERATION#"+id,sk:"STATE"} as const;}
function identities(op:RetirementOperation){
  if(!op.providerVersions?.masterEventId)reject("Missing original whole-series provider evidence");
  return {profile:op.profile,taskId:op.target.taskId,seriesIds:[op.target.seriesId],
    eventIds:[op.target.eventId,op.providerVersions.masterEventId]};
}
export function buildUndoTransaction(
  op:RetirementOperation,inspection:UndoInspection,rows:readonly InventoryRow[],
  timestamp:string,tableName:string,
):TransactWriteCommand {
  if(op.status!=="retired"||!inspection.eligible||inspection.blockers.length
    ||inspection.operationId!==op.operationId||inspection.profile!==op.profile)
    reject("Undo must be freshly verified and belong to the exact retired operation");
  if(op.undoApprovedFingerprint!==inspection.fingerprint||!op.undoConfirmationHash)
    reject("Undo evidence differs from the explicitly approved version");
  const markerKeys=retirementDispositionKeys(identities(op));
  if(JSON.stringify(markerKeys.map(k=>k.pk).sort())
    !==JSON.stringify(inspection.markerKeys.slice().sort()))
    reject("Undo marker manifest was changed after approval");
  const matched=markerKeys.map(Key=>{
    const row=rows.find(item=>item.pk===Key.pk&&item.sk===Key.sk);
    if(!row||row.operationId!==op.operationId||row.status!=="retired"
      ||row.profile!==op.profile||row.taskId!==op.target.taskId
      ||row.seriesId!==op.target.seriesId
      ||row.masterEventId!==op.providerVersions?.masterEventId)
      reject("An exclusion marker no longer belongs to the original retirement");
    return {Delete:{TableName:tableName,Key,
      ConditionExpression:"operationId = :id AND #status = :retired AND #profile = :profile AND taskId = :task AND seriesId = :series AND masterEventId = :master AND createdAt = :created",
      ExpressionAttributeNames:{"#status":"status","#profile":"profile"},
      ExpressionAttributeValues:{":id":op.operationId,":retired":"retired",
        ":profile":op.profile,":task":op.target.taskId,":series":op.target.seriesId,
        ":master":op.providerVersions!.masterEventId,":created":row.createdAt},
    }};
  });
  const id=op.target;
  const ownershipGuardKeys=PROFILES.flatMap(profile=>[
    {pk:"TASK#"+profile+"#"+id.taskId,sk:"MAP"},
    {pk:"EVENT#"+profile+"#"+id.eventId,sk:"MAP"},
    {pk:"EVENT#"+profile+"#"+op.providerVersions!.masterEventId,sk:"MAP"},
    {pk:"RECURRENCE#"+profile+"#"+id.seriesId,sk:"STATE"},
  ]);
  ownershipGuardKeys.push({pk:"TASKOWNER#"+id.taskId,sk:"MAP"});
  const ownershipGuards=ownershipGuardKeys.map(Key=>({ConditionCheck:{
    TableName:tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}}));
  const receipt={Update:{
    TableName:tableName,Key:opKey(op.operationId),
    UpdateExpression:"SET #status = :enabled, updatedAt = :now, reenabledAt = :now, undoStatus = :completed",
    ConditionExpression:"#status = :retired AND actorSubject = :actor AND undoConfirmationHash = :digest AND undoApprovedFingerprint = :fingerprint",
    ExpressionAttributeNames:{"#status":"status"},
    ExpressionAttributeValues:{":enabled":"re_enabled",":retired":"retired",
      ":now":timestamp,":completed":"completed",
      ":actor":op.actorSubject,":digest":op.undoConfirmationHash,
      ":fingerprint":inspection.fingerprint},
  }};
  const fence={ConditionCheck:{TableName:tableName,
    Key:{pk:"ERASURE#"+op.profile,sk:"FENCE"},
    ConditionExpression:"operationId = :id AND #state = :active",
    ExpressionAttributeNames:{"#state":"state"},
    ExpressionAttributeValues:{":id":op.operationId,":active":"active"}}};
  return new TransactWriteCommand({TransactItems:[
    ...matched,...ownershipGuards,fence,receipt,
  ] as never});
}
export class RetirementUndoService {
  private readonly db:Db;
  private readonly factory:ProviderClientFactory;
  private readonly inventory:()=>Promise<InventoryRow[]>;
  private readonly beginFence:(profile:Profile,id:string)=>Promise<void>;
  private readonly inspectFence:(profile:Profile)=>Promise<LeaseState>;
  private readonly finishFence:(profile:Profile,id:string)=>Promise<void>;
  private readonly operations:RetirementOperationService;
  constructor(deps:UndoDependencies={}) {
    this.db=deps.db||documentClient;
    this.factory=deps.clientFactory||defaultProviderClientFactory;
    this.inventory=deps.inventory||strongInventory;
    this.beginFence=deps.beginFence||beginErasureFence;
    this.inspectFence=deps.inspectFence||inspectErasureFence;
    this.finishFence=deps.finishFence||finishErasureFence;
    this.operations=new RetirementOperationService({db:this.db,beginFence:this.beginFence,
      inspectFence:this.inspectFence,finishFence:this.finishFence});
  }
  private async owned(operationId:string,actorSubject:string):Promise<RetirementOperation> {
    if(!UUID.test(operationId))reject("Invalid retirement operation ID",400);
    const op=await this.operations.get(operationId);
    if(!op)reject("Retirement receipt not found",404);
    if(op.actorSubject!==actorSubject)reject("Another operator owns this retirement",403);
    return op;
  }
  async inspect(operationId:string,actorSubject:string,
    onInventory?:(rows:readonly InventoryRow[])=>void):Promise<UndoInspection> {
    assertGate();
    const op=await this.owned(operationId,actorSubject);
    if(op.status!=="retired")reject("Only a retired association can be re-enabled");
    const nowMs=Date.now();
    const blockers:string[]=[];
    const rows=await this.inventory(); // complete; truncated scans throw
    onInventory?.(rows);
    const markerKeys=retirementDispositionKeys(identities(op));
    for(const Key of markerKeys){
      const match=rows.find(row=>row.pk===Key.pk&&row.sk===Key.sk);
      if(!match||match.operationId!==op.operationId||match.status!=="retired"
        ||match.profile!==op.profile||match.taskId!==op.target.taskId
        ||match.seriesId!==op.target.seriesId||
        match.masterEventId!==op.providerVersions?.masterEventId)
        blockers.push("The durable retirement marker is missing or belongs to another operation: "+Key.pk);
    }
    const relatedOwnerKey=(pk:string)=>
      /^(TASK#|TASKOWNER#|EVENT#|RECURRENCE#)/.test(pk);
    const ownerIds=new Set([op.target.taskId,op.target.eventId,op.target.seriesId,
      op.providerVersions!.masterEventId]);
    const owners=rows.filter(row=>typeof row.pk==="string"&&relatedOwnerKey(row.pk)
      &&[...ownerIds].some(id=>row.pk!.endsWith("#"+id)));
    if(owners.length)blockers.push("A live or competing mapping/recurrence owner exists; undo would rebind an active relationship");
    const controlKeys=new Set([
      "SYNC_CONTROL#"+op.profile+":todoist:"+op.target.taskId,
      "SYNC_CONTROL#"+op.profile+":calendar:"+op.target.eventId,
      "SYNC_CONTROL#"+op.profile+":calendar:"+op.providerVersions!.masterEventId,
    ]);
    if(rows.some(row=>controlKeys.has(String(row.pk))
      &&(row.activeRepair||row.excluded===true||row.pendingRefresh||row.pendingRefreshAt)))
      blockers.push("An active review, repair or pending refresh controls this identity");
    const pair=await this.factory(op.profile);
    const versions=op.providerVersions!;
    let master;
    let occurrence;
    let instances:CalendarEvent[]=[];
    try {
      master=await pair.calendar.getEvent(versions.masterEventId);
      occurrence=await pair.calendar.getEvent(op.target.eventId);
      instances=await pair.calendar.listEventInstances(versions.masterEventId);
    }catch {blockers.push("Calendar master, occurrence or complete instance list could not be verified");}
    if(!master||master.id!==versions.masterEventId||master.status==="cancelled"
      ||master.etag!==versions.masterEtag||JSON.stringify(master.recurrence)!==JSON.stringify(versions.rrule)
      ||(master.iCalUID||master.id)!==op.target.seriesId)
      blockers.push("Calendar master identity, recurrence or provider version changed");
    if(!occurrence||occurrence.id!==op.target.eventId
      ||occurrence.etag!==versions.occurrenceEtag||occurrence.status==="cancelled"
      ||occurrence.recurringEventId!==versions.masterEventId)
      blockers.push("Calendar selected occurrence identity or provider version changed");
    if(!instances.length||instances.length>20||instances.some(item=>{
      const start=Date.parse(item.start?.dateTime||item.start?.date||"");
      return !item.id||item.recurringEventId!==versions.masterEventId
        ||(item.iCalUID&&item.iCalUID!==op.target.seriesId)
        ||!Number.isFinite(start)||start>=nowMs;
    }))blockers.push("Calendar series contains an active, future, incomplete or changed occurrence");
    let activeTask;
    let completedTask;
    try {
      activeTask=await pair.todoist.getTask(op.target.taskId);
    }catch(error){
      if(Number((error as {status?:number}).status)!==404)blockers.push("Todoist task status lookup failed");
    }
    if(activeTask)blockers.push("Todoist has an active task; re-enable requires separate review");
    if(!activeTask){
      try {completedTask=await pair.todoist.findCompletedTaskById(op.target.taskId,versions.completedAt);}
      catch {blockers.push("Todoist completed-task verification failed or was unavailable");}
      if(!completedTask||completedTask.id!==op.target.taskId
        ||completedTask.is_deleted===true||completedTask.completed_at!==versions.completedAt)
        blockers.push("Completed Todoist task identity or completion version differs from retirement evidence");
    }
    const relevant=rows.filter(row=>markerKeys.some(k=>k.pk===row.pk&&k.sk===row.sk))
      .map(row=>({pk:row.pk,sk:row.sk,hash:reviewHash(row)}))
      .sort((a,b)=>String(a.pk).localeCompare(String(b.pk)));
    const fingerprint=reviewHash({operationId,target:op.target,master,occurrence,
      instances:instances.slice().sort((a,b)=>a.id.localeCompare(b.id)),
      completedTask,activeTask,relevant,
      ownerKeys:owners.map(row=>row.pk).sort()});
    return {operationId,profile:op.profile,scope:"operator_retirement_only",
      checkedAt:new Date().toISOString(),blockers:[...new Set(blockers)],
      eligible:blockers.length===0,fingerprint,markerKeys:markerKeys.map(k=>k.pk).sort(),
      providerWrites:false,stateWrites:false,completionHistoryPreserved:true};
  }
  async approveUndo(
    operationId:string,expectedFingerprint:string,actorSubject:string,
  ):Promise<{operationId:string;confirmationId:string;phrase:typeof RETIREMENT_UNDO_PHRASE;
    inspection:UndoInspection;providerWrites:false}> {
    assertGate();
    const inspection=await this.inspect(operationId,actorSubject);
    if(!inspection.eligible||inspection.fingerprint!==expectedFingerprint)
      reject("Re-enable verification changed or is blocked");
    const confirmationId=randomUUID();
    await this.db.send(new UpdateCommand({TableName:table(),Key:opKey(operationId),
      UpdateExpression:"SET undoConfirmationHash = :hash, undoApprovedFingerprint = :fingerprint, undoApprovalExpiresAt = :expiry, undoStatus = :approved",
      ConditionExpression:"#status = :retired AND actorSubject = :actor",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":hash":sha(confirmationId),":fingerprint":inspection.fingerprint,
        ":expiry":new Date(Date.now()+30*60_000).toISOString(),
        ":approved":"approved",":retired":"retired",":actor":actorSubject}}));
    return {operationId,confirmationId,phrase:RETIREMENT_UNDO_PHRASE,inspection,providerWrites:false};
  }
  async applyUndo(operationId:string,confirmationId:string,actorSubject:string,
    phrase:string):Promise<{status:"re_enabled"|"fencing";operationId:string;providerWrites:false}> {
    assertGate();
    if(phrase!==RETIREMENT_UNDO_PHRASE||!UUID.test(confirmationId))
      reject("Undo requires exact token and typed re-enable confirmation",400);
    const op=await this.owned(operationId,actorSubject);
    if(op.undoConfirmationHash!==sha(confirmationId))
      reject("Undo confirmation does not match",403);
    if(op.status==="re_enabled"){
      const fence=await this.inspectFence(op.profile);
      if(fence.fence?.operationId===operationId&&!fence.leases.length)
        await this.finishFence(op.profile,operationId);
      return {status:"re_enabled",operationId,providerWrites:false};
    }
    if(op.status!=="retired")reject("Retirement cannot be undone in this state");
    const previousFence=await this.inspectFence(op.profile);
    if(Date.parse(op.undoApprovalExpiresAt||"")<=Date.now()
      &&previousFence.fence?.operationId!==operationId)
      reject("Undo approval expired; inspect and approve again");
    await this.beginFence(op.profile,operationId);
    const fence=await this.inspectFence(op.profile);
    if(fence.fence?.operationId!==operationId)reject("A different operation owns this profile fence");
    if(fence.leases.length)return {status:"fencing",operationId,providerWrites:false};
    let command:TransactWriteCommand;
    try{
      let rows:readonly InventoryRow[]|undefined;
      const inspected=await this.inspect(operationId,actorSubject,items=>{rows=items;});
      if(!inspected.eligible||inspected.fingerprint!==op.undoApprovedFingerprint||!rows)
        reject("Undo evidence changed since approval; provider objects were not touched");
      command=buildUndoTransaction(op,inspected,rows,new Date().toISOString(),table());
    }catch(error){await this.finishFence(op.profile,operationId);throw error;}
    try{await this.db.send(command);}
    catch(error){
      if((error as {name?:string}).name==="TransactionCanceledException"){
        await this.finishFence(op.profile,operationId);
        reject("Undo mapping ownership or exclusion changed before atomic release");
      }
      throw error; // unknown commit: keep profile fenced
    }
    await this.finishFence(op.profile,operationId);
    return {status:"re_enabled",operationId,providerWrites:false};
  }
}
