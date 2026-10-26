/** Isolated, fail-closed recovery of a review_required erasure. Never resumes provider deletion. */
import {createHash, randomUUID} from "node:crypto";
import {GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {ErasureOperationStore, erasurePreviewFingerprint, type ErasureOperation, type FencedMapping} from "./erasure-executor.js";
import type {ErasurePreviewResult} from "./erasure-preview.js";

export type RecoveryStatus = "queued" | "restoring" | "verifying" | "completed" | "blocked";
export interface RecoveryState {
  status:RecoveryStatus;
  fingerprint:string;
  lifecycleFingerprint:string;
  epoch:number;
  hasJournal:boolean;
  startedAt:string;
  lastError?:string;
}
export interface RecoveryPreview {
  operationId:string;
  profile:string;
  phase:string;
  classification:"pre_write"|"fully_deleted"|"partial_or_ambiguous";
  allowed:boolean;
  blockers:string[];
  mappingStates:Array<{id:string;state:string;originallyEnabled:boolean}>;
  epoch?:number;
  fenceOwned:boolean;
  leaseCount:number;
  providerItemsAbsent:boolean;
  stateRowsAbsent:boolean;
  operationFingerprint:string;
  recoveryStatus?:RecoveryStatus;
}
export interface RecoveryAdapters {
  listWorkerMappings():Promise<FencedMapping[]>;
  mappingStates(ids:string[]):Promise<Array<{id:string;state:string}>>;
  restoreMappings(ids:string[]):Promise<void>;
  readSnapshot(operation:ErasureOperation):Promise<ErasurePreviewResult>;
}
type Db=Pick<typeof documentClient,"send">;
const idPattern=/^[A-Za-z0-9_-]{1,128}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recoverableBeforeWrite=new Set([
  "wait_worker_timeout","drain_after_timeout","ready_for_delete"
]);
const activeRestore=new Set(["queued","restoring","verifying"]);
function table():string {
  const name=process.env.STATE_TABLE_NAME?.trim();
  if(!name)throw new Error("STATE_TABLE_NAME is required");
  return name;
}
const operationKey=(id:string)=>({pk:"ERASURE_OPERATION#"+id,sk:"STATE"});
const confirmationKey=(id:string)=>({pk:"ERASURE_RECOVERY_CONFIRMATION#"+id,sk:"STATE"});
const profileKey=(profile:string,sk:string)=>({pk:"ERASURE#"+profile,sk});
function digest(value:unknown):string {
  const canonical=(obj:unknown):unknown=>Array.isArray(obj)?obj.map(canonical)
    :obj && typeof obj==="object"?Object.fromEntries(Object.entries(obj).sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>[k,canonical(v)])):obj;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function recoveryMode(operation:ErasureOperation, snapshot:ErasurePreviewResult):RecoveryPreview["classification"] {
  const lifecycle=operation.lifecycle!;
  const noWrites=!lifecycle.evidence.deletionStarted && !lifecycle.deletionProgress
    && recoverableBeforeWrite.has(lifecycle.phase);
  const identical=snapshot.blockers.length===0
    && erasurePreviewFingerprint(snapshot)===snapshot.previewFingerprint
    && snapshot.previewFingerprint===operation.previewFingerprint
    && snapshot.providerSnapshotFingerprint===operation.providerSnapshotFingerprint;
  if(noWrites&&identical)return "pre_write";
  const noProviders=!snapshot.actionPlan.todoistTask&&!snapshot.actionPlan.calendarEvent
    &&snapshot.actionPlan.comments.length===0;
  if(snapshot.blockers.length===0&&noProviders&&snapshot.inventory.length===0)return "fully_deleted";
  return "partial_or_ambiguous";
}
/** Query every strong-consistent page. Never treat a partial read as a safe, empty lease inventory. */
async function readControl(db:Db,profile:string):Promise<{
  fence?:Record<string,unknown>;epoch?:number;journal?:Record<string,unknown>;leases:Record<string,unknown>[];
}> {
  const rows:Record<string,unknown>[]=[];
  let cursor:Record<string,unknown>|undefined;
  let pages=0;
  do {
    if(++pages>1000)throw new Error("Recovery control inventory exceeded the page limit");
    const result=await db.send(new QueryCommand({TableName:table(),KeyConditionExpression:"pk=:key",
      ExpressionAttributeValues:{":key":"ERASURE#"+profile},ConsistentRead:true,ExclusiveStartKey:cursor}));
    rows.push(...(result.Items||[]) as Record<string,unknown>[]);
    cursor=result.LastEvaluatedKey as Record<string,unknown>|undefined;
  }while(cursor);
  const names=new Set<string>();
  for(const item of rows) {
    if(typeof item.sk!=="string"||names.has(item.sk))throw new Error("Duplicated or malformed erasure control row");
    names.add(item.sk);
  }
  const get=(sk:string)=>rows.find(item=>item.sk===sk);
  const rawEpoch=get("EPOCH")?.epoch;
  return {fence:get("FENCE"),epoch:typeof rawEpoch==="number"&&Number.isSafeInteger(rawEpoch)&&rawEpoch>0?rawEpoch:undefined,
    journal:get("JOURNAL"),leases:rows.filter(item=>typeof item.sk==="string"&&!["FENCE","EPOCH","JOURNAL"].includes(item.sk))};
}
function validateLifecycle(op:ErasureOperation):string[] {
  const blockers:string[]=[];
  const lc=op.lifecycle;
  if(op.status!=="review_required"||!lc)blockers.push("Only a durable review_required lifecycle is recoverable");
  if(!lc)return blockers;
  if(!op.confirmationId||op.confirmationFingerprint!==op.previewFingerprint
    ||erasurePreviewFingerprint(op)!==op.previewFingerprint)blockers.push("Immutable erasure confirmation/inventory did not validate");
  if(!Array.isArray(lc.mappingIds)||!lc.mappingIds.length
    ||lc.mappingIds.some(id=>typeof id!=="string"||!uuid.test(id))
    ||new Set(lc.mappingIds).size!==lc.mappingIds.length)blockers.push("Recorded worker mapping UUID inventory is invalid");
  if(!Array.isArray(lc.enabledMappingIds)
    ||lc.enabledMappingIds.some(id=>!lc.mappingIds.includes(id))
    ||new Set(lc.enabledMappingIds).size!==lc.enabledMappingIds.length)
    blockers.push("Original mapping enablement inventory is invalid");
  for(const [name,receipt] of Object.entries(lc.evidence||{})) {
    if(!receipt||receipt.operationId!==op.operationId||receipt.phase!==name
      ||typeof receipt.receiptId!=="string"||!uuid.test(receipt.receiptId)
      ||!Number.isFinite(receipt.completedAt))blockers.push("Lifecycle evidence is malformed or owned by another operation");
  }
  if(!lc.evidence?.fenceInstalled)blockers.push("No validated durable fence installation receipt");
  if(lc.evidence?.fenceInstalled && Date.now() < lc.evidence.fenceInstalled.completedAt
    +lc.timeoutSeconds*1000+2000)
    blockers.push("Original worker timeout after fence installation has not elapsed");
  if(["drain_after_timeout","ready_for_delete"].includes(lc.phase) && !lc.evidence?.workerTimeoutElapsed)
    blockers.push("No durable receipt proving worker timeout completed");
  if(lc.phase==="ready_for_delete" && !lc.evidence?.postTimeoutDrain)
    blockers.push("No durable receipt proving the original writer lease drain");
  if(!Number.isFinite(lc.timeoutSeconds)||lc.timeoutSeconds<=0)blockers.push("Invalid original worker timeout");
  return blockers;
}
function expectedMappingStates(op:ErasureOperation, actual:Array<{id:string;state:string}>):Array<{id:string;state:string;originallyEnabled:boolean}> {
  const enabled=new Set(op.lifecycle!.enabledMappingIds);
  return actual.map(x=>({id:x.id,state:x.state,originallyEnabled:enabled.has(x.id)}));
}
export class ErasureRecoveryService {
  constructor(private readonly adapters:RecoveryAdapters,
    private readonly db:Db=documentClient,
    private readonly erasures:ErasureOperationStore=new ErasureOperationStore(db as typeof documentClient),
    private readonly newToken:()=>string=randomUUID) {}

  async inspect(id:string):Promise<{preview:RecoveryPreview;fingerprint:string;operation:ErasureOperation;hasJournal:boolean}> {
    if(!idPattern.test(id))throw Object.assign(new Error("Invalid recovery operation ID"),{status:400});
    const op=await this.erasures.get(id);
    if(!op)throw Object.assign(new Error("Erasure operation not found; absence cannot prove success"),{status:404});
    if(op.status!=="review_required"||!op.lifecycle)
      throw Object.assign(new Error("Only a persisted review_required erasure can be inspected for recovery"),{status:409});
    const blockers=validateLifecycle(op);
    // Read each source even if another is blocked; never issue confirmation on a partial read or exception.
    const [control,mappings,snapshot]=await Promise.all([
      readControl(this.db,op.profile),this.adapters.listWorkerMappings(),this.adapters.readSnapshot(op),
    ]);
    const original=op.lifecycle?.mappingIds||[];
    const presentIds=mappings.map(x=>x.id).sort();
    if(presentIds.length!==original.length||presentIds.some((x,i)=>x!==[...original].sort()[i]))
      blockers.push("Live worker SQS mapping UUID inventory differs from the recorded inventory");
    if(mappings.some(x=>!uuid.test(x.id)||!x.eventSourceArn?.includes(":sqs:")
      ||!["Enabled","Disabled"].includes(x.state)))blockers.push("Untrusted or transitional worker mapping");
    if(control.fence?.operationId!==id||control.fence.state!=="active")
      blockers.push("The active profile fence is missing, altered, or belongs to another operation");
    if(!control.epoch)blockers.push("The monotonic profile epoch is missing or invalid");
    if(control.journal&&control.journal.operationId!==id)blockers.push("Erasure journal is owned by another operation");
    if(control.leases.length)blockers.push("A profile admission or writer lease is still active");
    const active=await this.adapters.mappingStates(original);
    if(active.length!==original.length||new Set(active.map(x=>x.id)).size!==original.length
      ||active.some(x=>!original.includes(x.id)||!["Enabled","Disabled"].includes(x.state)))
      blockers.push("A recorded worker mapping is missing or transitional");
    const enabled=new Set(op.lifecycle?.enabledMappingIds||[]);
    if(active.some(x=>!enabled.has(x.id)&&x.state!=="Disabled"))
      blockers.push("A mapping originally disabled has become enabled");
    if(snapshot.blockers.length)blockers.push("Exact provider, comments, recurrence, or DynamoDB inventory is unsafe");
    const classification=op.lifecycle?recoveryMode(op,snapshot):"partial_or_ambiguous";
    if(classification==="partial_or_ambiguous")
      blockers.push("Partial or ambiguous provider/record deletion requires a separately reviewed reconciliation");
    if(classification==="fully_deleted")
      blockers.push("Full deletion needs durable replay/tombstone assurance before restoring admission");
    if(!op.lifecycle?.evidence.fenceInstalled)blockers.push("Recovery cannot infer fence ownership from current rows alone");
    if(op.recovery && op.recovery.status!=="blocked")
      blockers.push("A recovery has already been accepted; refresh its status instead of issuing another");
    if(op.recovery?.status==="blocked")
      blockers.push("Recovery previously blocked due to drift; operator escalation required");
    const mappingStates=expectedMappingStates(op,active);
    const preview:RecoveryPreview={operationId:id,profile:op.profile,phase:op.lifecycle?.phase||"unknown",classification,
      blockers:[...new Set(blockers)].sort(),allowed:blockers.length===0,
      mappingStates,epoch:control.epoch,fenceOwned:control.fence?.operationId===id,
      leaseCount:control.leases.length,
      providerItemsAbsent:!snapshot.actionPlan.todoistTask&&!snapshot.actionPlan.calendarEvent&&snapshot.actionPlan.comments.length===0,
      stateRowsAbsent:snapshot.inventory.length===0,operationFingerprint:op.previewFingerprint,
      recoveryStatus:op.recovery?.status};
    const fingerprint=digest({operationId:id,profile:op.profile,epoch:control.epoch,
      fence:control.fence,hasJournal:Boolean(control.journal),
      lifecycle:op.lifecycle,operationFingerprint:op.previewFingerprint,
      mappingInventory:mappings.sort((a,b)=>a.id.localeCompare(b.id)),mappingStates,
      snapshotFingerprint:snapshot.previewFingerprint,classification});
    return {preview,fingerprint,operation:op,hasJournal:Boolean(control.journal)};
  }

  async issueConfirmation(id:string,operator:string):Promise<{preview:RecoveryPreview;confirmationId:string;expiresAt:number}> {
    const inspected=await this.inspect(id);
    if(!inspected.preview.allowed)throw Object.assign(new Error("Recovery is blocked; inspect safety evidence"),{status:409});
    const confirmationId=this.newToken(),expiresAt=Date.now()+5*60_000;
    // DynamoDB TTL requires epoch *seconds*; the UI/action-time clock uses milliseconds.
    await this.db.send(new PutCommand({TableName:table(),Item:{
      ...confirmationKey(id),operationId:id,profile:inspected.operation.profile,operator,
      confirmationId,inspectedFingerprint:inspected.fingerprint,
      expiresAt:Math.ceil(expiresAt/1000),expiresAtMs:expiresAt,status:"issued",
      createdAt:new Date().toISOString(),
    },ConditionExpression:"attribute_not_exists(pk) OR expiresAt < :now",
      ExpressionAttributeValues:{":now":Math.floor(Date.now()/1000)}}));
    return {preview:inspected.preview,confirmationId,expiresAt};
  }

  async apply(id:string,confirmationId:string,operator:string):Promise<void> {
    if(!idPattern.test(id)||typeof confirmationId!=="string"||confirmationId.length>256)
      throw Object.assign(new Error("Invalid recovery confirmation"),{status:400});
    const issued=(await this.db.send(new GetCommand({TableName:table(),Key:confirmationKey(id),ConsistentRead:true}))).Item;
    if(!issued||issued.status!=="issued"||issued.operationId!==id||issued.operator!==operator
      ||issued.confirmationId!==confirmationId||typeof issued.expiresAtMs!=="number"||issued.expiresAtMs<=Date.now())
      throw Object.assign(new Error("Recovery confirmation is expired, changed, or consumed"),{status:409});
    const current=await this.inspect(id);
    if(!current.preview.allowed||current.fingerprint!==issued.inspectedFingerprint||!current.preview.epoch)
      throw Object.assign(new Error("Safety evidence drifted; obtain a new recovery preview"),{status:409});
    const now=Date.now();
    const recovery:RecoveryState={status:"queued",fingerprint:current.fingerprint,
      lifecycleFingerprint:digest(current.operation.lifecycle),
      epoch:current.preview.epoch,hasJournal:current.hasJournal,startedAt:new Date(now).toISOString()};
    // Lock the durable operation before SQS dispatch. No pre-existing fence/epoch may be changed.
    await this.db.send(new TransactWriteCommand({TransactItems:[
      {Update:{TableName:table(),Key:operationKey(id),
        UpdateExpression:"SET recovery=:recovery, updatedAt=:now",
        ConditionExpression:"#status=:review AND attribute_not_exists(recovery) AND previewFingerprint=:fingerprint AND lifecycle.#phase=:phase AND updatedAt=:observedUpdatedAt",
        ExpressionAttributeNames:{"#status":"status","#phase":"phase"},
        ExpressionAttributeValues:{":review":"review_required",":recovery":recovery,":fingerprint":current.operation.previewFingerprint,
          ":phase":current.operation.lifecycle!.phase,":observedUpdatedAt":current.operation.updatedAt,":now":new Date(now).toISOString()}}},
      {Update:{TableName:table(),Key:confirmationKey(id),
        UpdateExpression:"SET #status=:consumed, consumedAt=:now",
        ConditionExpression:"#status=:issued AND operator=:operator AND confirmationId=:token AND inspectedFingerprint=:digest AND expiresAtMs>:time",
        ExpressionAttributeNames:{"#status":"status"},
        ExpressionAttributeValues:{":issued":"issued",":consumed":"consumed",":operator":operator,":token":confirmationId,
          ":digest":current.fingerprint,":time":now,":now":new Date(now).toISOString()}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(current.operation.profile,"FENCE"),
        ConditionExpression:"operationId=:id AND #state=:active",
        ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":id":id,":active":"active"}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(current.operation.profile,"EPOCH"),
        ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":current.preview.epoch}}},
    ]}));
  }

  async status(id:string):Promise<RecoveryState|undefined> {
    return (await this.erasures.get(id))?.recovery;
  }

  private async advance(op:ErasureOperation,expected:RecoveryStatus,next:RecoveryStatus,error?:string):Promise<void> {
    await this.db.send(new UpdateCommand({TableName:table(),Key:operationKey(op.operationId),
      UpdateExpression:"SET recovery.#status=:next, updatedAt=:now"+(error?", recovery.lastError=:error":""),
      ConditionExpression:"#status=:review AND recovery.#status=:expected AND recovery.fingerprint=:digest AND recovery.epoch=:epoch",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":review":"review_required",":expected":expected,":next":next,":digest":op.recovery!.fingerprint,
        ":epoch":op.recovery!.epoch,":now":new Date().toISOString(),...(error?{":error":error}:{})}}));
  }

  async process(id:string):Promise<{status:RecoveryStatus;retry:boolean}> {
    const op=await this.erasures.get(id);
    if(!op?.recovery||op.status!=="review_required")return {status:"blocked",retry:false};
    const recovery=op.recovery;
    if(!activeRestore.has(recovery.status))return {status:recovery.status,retry:false};
    try {
      const observed=await this.inspectDuringRecovery(op);
      if(!observed.safe) {
        await this.advance(op,recovery.status,"blocked","Recovery safety evidence drifted; fence was preserved");
        return {status:"blocked",retry:false};
      }
      if(recovery.status==="queued") {
        await this.advance(op,"queued","restoring");
        return {status:"restoring",retry:true};
      }
      if(recovery.status==="restoring") {
        const disabled=observed.mappings.find(x=>x.originallyEnabled&&x.state==="Disabled");
        if(disabled) {
          await this.adapters.restoreMappings([disabled.id]);
          console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
            event:"recovery_mapping_restoration_requested",operationId:id,profile:op.profile,
            originalMappingCount:op.lifecycle!.mappingIds.length}));
          return {status:"restoring",retry:true};
        }
        if(observed.mappings.some(x=>x.originallyEnabled&&x.state==="Enabling"))
          return {status:"restoring",retry:true};
        await this.advance(op,"restoring","verifying");
        return {status:"verifying",retry:true};
      }
      if(observed.mappings.some(x=>x.state!==(x.originallyEnabled?"Enabled":"Disabled")))
        return {status:"verifying",retry:true};
      // Fence remains installed through mapping restoration. No new admission
      // lease can be created while the fence exists; inspect all old leases
      // immediately before this ownership/epoch guarded atomic release.
      const control=await readControl(this.db,op.profile);
      if(control.fence?.operationId!==id||control.fence.state!=="active"
        ||control.epoch!==recovery.epoch||control.leases.length>0
        ||Boolean(control.journal)!==recovery.hasJournal
        ||(control.journal&&control.journal.operationId!==id))
        throw new Error("Recovery fence, epoch, lease or journal drift");
      const items:any[]=[
        {Update:{TableName:table(),Key:operationKey(id),
          UpdateExpression:"SET recovery.#status=:done, recovery.completedAt=:now, updatedAt=:now",
          ConditionExpression:"#status=:review AND recovery.#status=:verify AND recovery.fingerprint=:digest AND recovery.epoch=:epoch AND previewFingerprint=:preview AND lifecycle.#phase=:phase",
          ExpressionAttributeNames:{"#status":"status","#phase":"phase"},
          ExpressionAttributeValues:{":review":"review_required",":verify":"verifying",":done":"completed",
            ":digest":recovery.fingerprint,":epoch":recovery.epoch,":preview":op.previewFingerprint,
            ":phase":op.lifecycle!.phase,":now":new Date().toISOString()}}},
        {Delete:{TableName:table(),Key:profileKey(op.profile,"FENCE"),
          ConditionExpression:"operationId=:id AND #state=:active",
          ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":id":id,":active":"active"}}},
        {ConditionCheck:{TableName:table(),Key:profileKey(op.profile,"EPOCH"),
          ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":recovery.epoch}}},
      ];
      if(recovery.hasJournal)items.push({Delete:{TableName:table(),Key:profileKey(op.profile,"JOURNAL"),
        ConditionExpression:"operationId=:id",ExpressionAttributeValues:{":id":id}}});
      items.push({Delete:{TableName:table(),Key:confirmationKey(id),
        ConditionExpression:"#status=:consumed AND operationId=:id AND inspectedFingerprint=:digest",
        ExpressionAttributeNames:{"#status":"status"},
        ExpressionAttributeValues:{":consumed":"consumed",":id":id,":digest":recovery.fingerprint}}});
      await this.db.send(new TransactWriteCommand({TransactItems:items}));
      console.log(JSON.stringify({service:"todoist-calendar-sync-erasure-worker",
        event:"recovery_fence_released",operationId:id,profile:op.profile,epoch:recovery.epoch}));
      return {status:"completed",retry:false};
    } catch(error) {
      // Fail closed: transport errors are retryable by SQS with no fence
      // modification; conditional/drift errors are not safe to retry blindly.
      if(error instanceof Error&&(/drift|different|missing|mismatch|blocked|unsafe|invalid/i).test(error.message)) {
        await this.advance(op,recovery.status,"blocked","Recovery stopped on changed safety evidence; fence preserved");
        return {status:"blocked",retry:false};
      }
      throw error;
    }
  }

  private async inspectDuringRecovery(op:ErasureOperation):Promise<{
    safe:boolean;mappings:RecoveryPreview["mappingStates"];
  }> {
    const recovery=op.recovery!;
    if(validateLifecycle(op).length || digest(op.lifecycle)!==recovery.lifecycleFingerprint)
      return {safe:false,mappings:[]};
    const control=await readControl(this.db,op.profile);
    if(control.fence?.operationId!==op.operationId||control.fence.state!=="active"
      ||control.epoch!==recovery.epoch||control.leases.length>0
      ||Boolean(control.journal)!==recovery.hasJournal
      ||(control.journal&&control.journal.operationId!==op.operationId))return {safe:false,mappings:[]};
    const original=op.lifecycle?.mappingIds||[];
    const [live,states,snapshot]=await Promise.all([
      this.adapters.listWorkerMappings(),this.adapters.mappingStates(original),this.adapters.readSnapshot(op)]);
    if(live.length!==original.length||new Set(live.map(x=>x.id)).size!==original.length
      ||live.some(x=>!original.includes(x.id)||!x.eventSourceArn.includes(":sqs:"))
      ||states.length!==original.length||new Set(states.map(x=>x.id)).size!==original.length
      ||states.some(x=>!original.includes(x.id)
        ||!["Enabled","Disabled","Enabling"].includes(x.state)))
      return {safe:false,mappings:[]};
    const mapped=expectedMappingStates(op,states);
    if(mapped.some(x=>!x.originallyEnabled&&x.state!=="Disabled"))return {safe:false,mappings:mapped};
    // Only pre-write recoveries are automated. Every worker step must still
    // observe the *original* provider and DynamoDB contents.
    const unchanged=snapshot.blockers.length===0
      &&erasurePreviewFingerprint(snapshot)===snapshot.previewFingerprint
      &&recoveryMode(op,snapshot)==="pre_write"
      &&snapshot.previewFingerprint===op.previewFingerprint
      &&snapshot.providerSnapshotFingerprint===op.providerSnapshotFingerprint;
    return {safe:unchanged,mappings:mapped};
  }
}
