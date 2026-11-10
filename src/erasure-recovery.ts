/** Isolated, fail-closed recovery of a review_required erasure. Never resumes provider deletion. */
import {createHash, randomUUID} from "node:crypto";
import {GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {ErasureOperationStore, erasurePreviewFingerprint, type ErasureOperation, type FencedMapping} from "./erasure-executor.js";
import type {CrossProfileErasureEvidence} from "./erasure-cross-profile-evidence.js";
import type {ErasurePreviewResult,KnownTargetReadback} from "./erasure-preview.js";
import {assessPostWriteRecovery,type PostWriteRecoveryAssessment} from "./erasure-postwrite-preview.js";

export type RecoveryStatus = "queued" | "restoring" | "verifying" | "completed" | "blocked";
export const CALENDAR_DRIFT_CANCEL_PHRASE="CANCEL ERASURE AND RESTORE SYNC";
export interface RecoveryState {
  status:RecoveryStatus;
  fingerprint:string;
  lifecycleFingerprint:string;
  epoch:number;
  hasJournal:boolean;
  startedAt:string;
  lastError?:string;
  mode?:"calendar_drift_cancel";
  approvedCalendarDriftCommitment?:string;
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
  /** Read-only result for exact originally mapped provider IDs, not global erasure proof. */
  knownTargetReadback?:KnownTargetReadback;
  /** Provider/state preview blockers before the global-absence policy is evaluated. */
  snapshotSafetyBlockerCount?:number;
  operationFingerprint:string;
  recoveryStatus?:RecoveryStatus;
  crossProfileEvidence?:CrossProfileErasureEvidence;
  /** Read-only comparisons only. None of these booleans can grant recovery. */
  /** Review-only triage: cannot issue recovery confirmation or release a fence. */
  calendarDriftReview?:{candidateForSeparateApproval:boolean;releaseAllowed:false};
  evidenceChecks?:{
    originalPreWritePhase:boolean;
    originalConfirmationIntact:boolean;
    auditComplete:boolean;
    freshPreviewSelfConsistent:boolean;
    primaryProviderMatches:boolean;
    originalPreviewMatches:boolean;
    todoistTaskMatches:boolean;
    calendarEventMatches:boolean;
    commentsMatch:boolean;
    projectCommentIdsMatch:boolean;
    knownCalendarAliasesMatch:boolean;
    stateInventoryMatches:boolean;
    providerSafetyBlockerCount:number;
  };
}
export interface RecoveryAdapters {
  listWorkerMappings():Promise<FencedMapping[]>;
  mappingStates(ids:string[]):Promise<Array<{id:string;state:string}>>;
  restoreMappings(ids:string[]):Promise<void>;
  readSnapshot(operation:ErasureOperation):Promise<ErasurePreviewResult>;
  /** Exact operation-target reads for bounded post-write assessment. */
  readKnownTargetSnapshot?(operation:ErasureOperation):Promise<ErasurePreviewResult>;
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
const driftConfirmationKey=(id:string)=>({pk:"ERASURE_CALENDAR_DRIFT_CONFIRMATION#"+id,sk:"STATE"});
const postwriteReviewTokenKey=(id:string)=>({pk:"ERASURE_POSTWRITE_CONFIRMATION#"+id,sk:"STATE"});
const postwriteReviewPhrase="REVIEW AND KEEP FENCED";
function postwriteEvidenceDigest(inspection:{fingerprint:string;operation:ErasureOperation;preview:RecoveryPreview}):string {
  const {operation,preview,fingerprint}=inspection;
  return digest({mode:"post_write",fingerprint,epoch:preview.epoch,profile:operation.profile,
    originalUpdatedAt:operation.updatedAt,originalStatus:operation.status,
    originalConfirmationId:operation.confirmationId,
    originalPreviewFingerprint:operation.previewFingerprint,originalSelections:operation.selectedActions,
    originalTargets:operation.target,originalActionPlan:operation.actionPlan,originalInventory:operation.inventory,
    lifecycle:operation.lifecycle});
}
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
  // Guard both domains independently: the fresh cross-profile snapshot must
  // validate its own fingerprint, while the immutable confirmation was issued
  // against the *target-only* snapshot before any global audit was requested.
  // Comparing the global-audit digest directly against the original digest
  // will always fail even if not one provider item has changed.
  const freshSelfConsistent=erasurePreviewFingerprint(snapshot)===snapshot.previewFingerprint;
  const targetBaseline=snapshot.crossProfileEvidence
    ?snapshot.primaryProviderSnapshotFingerprint:snapshot.providerSnapshotFingerprint;
  const auditVerified=!snapshot.crossProfileEvidence
    || (snapshot.crossProfileEvidence.allProfilesQueried===true
      &&snapshot.crossProfileEvidence.stateScan?.allPagesReceived===true
      &&snapshot.crossProfileEvidence.stateScan?.stronglyConsistent===true);
  const identical=snapshot.blockers.length===0
    &&freshSelfConsistent&&auditVerified
    &&typeof targetBaseline==="string"&&/^[a-f0-9]{64}$/.test(targetBaseline)
    &&targetBaseline===operation.providerSnapshotFingerprint
    &&erasurePreviewFingerprint({...snapshot,providerSnapshotFingerprint:targetBaseline})
      ===operation.previewFingerprint;
  if(noWrites&&identical)return "pre_write";
  const noProviders=!snapshot.actionPlan.todoistTask&&!snapshot.actionPlan.calendarEvent
    &&snapshot.actionPlan.comments.length===0;
  // A completely absent provider inventory is not proof when its exact
  // preview fingerprint is inconsistent with the readback; fail closed.
  if(snapshot.blockers.length===0&&noProviders&&snapshot.inventory.length===0
    &&erasurePreviewFingerprint(snapshot)===snapshot.previewFingerprint)return "fully_deleted";
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
/** Explain an ineligible pre-write inspection without exposing provider content,
 * credentials, raw IDs, hashes, or authorising any state mutation. */
function readOnlyRecoveryEvidenceChecks(operation:ErasureOperation,snapshot:ErasurePreviewResult):
  NonNullable<RecoveryPreview["evidenceChecks"]> {
  const lifecycle=operation.lifecycle!;
  const audit=snapshot.crossProfileEvidence;
  const baseline=audit?snapshot.primaryProviderSnapshotFingerprint:snapshot.providerSnapshotFingerprint;
  const originalPreviewMatches=typeof baseline==="string"
    &&/^[a-f0-9]{64}$/.test(baseline)
    &&erasurePreviewFingerprint({...snapshot,providerSnapshotFingerprint:baseline})
      ===operation.previewFingerprint;
  // Wrap optional values in an object so JSON.stringify always has a
  // stable input; compare immutable digests rather than public descriptions.
  const same=(original:unknown,current:unknown)=>digest({value:original})===digest({value:current});
  return {
    originalPreWritePhase:!lifecycle.evidence.deletionStarted
      &&!lifecycle.deletionProgress&&recoverableBeforeWrite.has(lifecycle.phase),
    originalConfirmationIntact:operation.confirmationFingerprint===operation.previewFingerprint
      &&erasurePreviewFingerprint(operation)===operation.previewFingerprint,
    auditComplete:!audit||(audit.allProfilesQueried===true
      &&audit.stateScan?.allPagesReceived===true
      &&audit.stateScan?.stronglyConsistent===true),
    freshPreviewSelfConsistent:erasurePreviewFingerprint(snapshot)===snapshot.previewFingerprint,
    primaryProviderMatches:baseline===operation.providerSnapshotFingerprint,
    originalPreviewMatches,
    todoistTaskMatches:same(operation.actionPlan.todoistTask,snapshot.actionPlan.todoistTask),
    calendarEventMatches:same(operation.actionPlan.calendarEvent,snapshot.actionPlan.calendarEvent),
    commentsMatch:same(operation.actionPlan.comments,snapshot.actionPlan.comments),
    projectCommentIdsMatch:same(operation.actionPlan.projectCommentIds,snapshot.actionPlan.projectCommentIds),
    knownCalendarAliasesMatch:same(
      {aliases:operation.actionPlan.knownCalendarAliases,complete:operation.actionPlan.knownCalendarAliasesComplete},
      {aliases:snapshot.actionPlan.knownCalendarAliases,complete:snapshot.actionPlan.knownCalendarAliasesComplete}),
    stateInventoryMatches:same(operation.inventory,snapshot.inventory),
    providerSafetyBlockerCount:snapshot.blockers.length,
  };
}
/** Triage only. A Calendar revision can make the original full-body digest differ
 * even when no erasure deletion was attempted. This never authorises recovery.
 * A future distinct typed cancellation must independently bind fresh provider
 * snapshots to a one-time token and revalidate before each worker transition. */
function calendarOnlyPreWriteDriftCandidate(operation:ErasureOperation,snapshot:ErasurePreviewResult,
  checks:NonNullable<RecoveryPreview["evidenceChecks"]>,blockingReasons:readonly string[],
  mappingStates:Array<{id:string;state:string}>,requireAllDisabled=true):boolean {
  const original=operation.actionPlan.calendarEvent,current=snapshot.actionPlan.calendarEvent;
  return blockingReasons.length===0
    && !operation.recovery&&!operation.postwriteReview
    && operation.selectedActions.deleteCalendar===true
    && snapshot.crossProfileEvidence!==undefined
    && checks.originalPreWritePhase&&checks.originalConfirmationIntact
    && checks.auditComplete&&checks.freshPreviewSelfConsistent
    && checks.todoistTaskMatches&&Boolean(snapshot.actionPlan.todoistTask)
    && checks.commentsMatch&&checks.projectCommentIdsMatch
    && checks.knownCalendarAliasesMatch&&checks.stateInventoryMatches
    && checks.providerSafetyBlockerCount===0
    && !checks.calendarEventMatches&&!checks.primaryProviderMatches&&!checks.originalPreviewMatches
    && Boolean(original&&current)
    && operation.profile===snapshot.profile
    && operation.target.taskId===snapshot.target.taskId
    && operation.target.eventId===snapshot.target.eventId
    && operation.target.eventId===original?.id
    && original?.id===current?.id&&original?.calendarId===current?.calendarId
    && typeof original?.etag==="string"&&original.etag.length>0
    && typeof current?.etag==="string"&&current.etag.length>0
    && snapshot.knownTargetReadback?.todoist==="present"
    && snapshot.knownTargetReadback?.calendar==="present"
    && (!requireAllDisabled||mappingStates.every(x=>x.state==="Disabled"));
}
/** Stable fingerprint of current target/provider revision, not global audit time. */
function calendarDriftCommitment(operation:ErasureOperation,snapshot:ErasurePreviewResult,epoch:number):string {
  return digest({domain:"calendar-drift-cancellation-v1",operationId:operation.operationId,
    profile:operation.profile,epoch,originalPreview:operation.previewFingerprint,
    target:snapshot.target,actions:snapshot.selectedActions,
    primaryProvider:snapshot.primaryProviderSnapshotFingerprint,
    todoist:snapshot.actionPlan.todoistTask,calendar:snapshot.actionPlan.calendarEvent,
    comments:snapshot.actionPlan.comments,projectCommentIds:snapshot.actionPlan.projectCommentIds,
    calendarAliases:snapshot.actionPlan.knownCalendarAliases,
    aliasesComplete:snapshot.actionPlan.knownCalendarAliasesComplete,
    inventory:snapshot.inventory,readback:snapshot.knownTargetReadback});
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

  async inspect(id:string,options:{knownIdentityOnly?:boolean}={}):Promise<{preview:RecoveryPreview;fingerprint:string;operation:ErasureOperation;hasJournal:boolean;calendarDriftCommitment?:string}> {
    if(!idPattern.test(id))throw Object.assign(new Error("Invalid recovery operation ID"),{status:400});
    const op=await this.erasures.get(id);
    if(!op)throw Object.assign(new Error("Erasure operation not found; absence cannot prove success"),{status:404});
    if(op.status!=="review_required"||!op.lifecycle)
      throw Object.assign(new Error("Only a persisted review_required erasure can be inspected for recovery"),{status:409});
    const blockers=validateLifecycle(op);
    // Read each source even if another is blocked; never issue confirmation on a partial read or exception.
    const readSnapshot=options.knownIdentityOnly&&this.adapters.readKnownTargetSnapshot
      ?this.adapters.readKnownTargetSnapshot.bind(this.adapters):this.adapters.readSnapshot.bind(this.adapters);
    const [control,mappings,snapshot]=await Promise.all([
      readControl(this.db,op.profile),this.adapters.listWorkerMappings(),readSnapshot(op),
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
    // Take a structural snapshot before adding the expected generic digest-drift
    // blocker. Candidate assessment is informational and cannot change allowed.
    const structuralBlockers=[...blockers];
    const evidenceChecks=readOnlyRecoveryEvidenceChecks(op,snapshot);
    const calendarDriftCandidate=calendarOnlyPreWriteDriftCandidate(
      op,snapshot,evidenceChecks,structuralBlockers,active);
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
      providerItemsAbsent:!snapshot.actionPlan.todoistTask&&!snapshot.actionPlan.calendarEvent
        &&snapshot.actionPlan.comments.length===0
        &&(options.knownIdentityOnly
          ?snapshot.knownTargetReadback?.todoist==="absent"
            &&snapshot.knownTargetReadback.calendar==="absent"
            &&snapshot.knownTargetReadback.configuredCalendarLink==="not_found"
          :snapshot.crossProfileEvidence?.knownIdentitiesAbsentFromCurrentProviders===true),
      stateRowsAbsent:snapshot.inventory.length===0
        &&(snapshot.crossProfileEvidence?.stateScan.relatedRowCount??0)===0,
      ...(snapshot.knownTargetReadback?{knownTargetReadback:snapshot.knownTargetReadback}:{}),
      snapshotSafetyBlockerCount:snapshot.blockers.length,
      evidenceChecks,
      calendarDriftReview:{candidateForSeparateApproval:calendarDriftCandidate,releaseAllowed:false},
      operationFingerprint:op.previewFingerprint,
      recoveryStatus:op.recovery?.status,
      ...(snapshot.crossProfileEvidence?{crossProfileEvidence:snapshot.crossProfileEvidence}:{})};
    const fingerprint=digest({operationId:id,profile:op.profile,epoch:control.epoch,
      fence:control.fence,hasJournal:Boolean(control.journal),
      lifecycle:op.lifecycle,operationFingerprint:op.previewFingerprint,
      mappingInventory:mappings.sort((a,b)=>a.id.localeCompare(b.id)),mappingStates,
      snapshotFingerprint:snapshot.previewFingerprint,
      crossProfileEvidenceFingerprint:snapshot.crossProfileEvidence?.evidenceFingerprint,classification});
    return {preview,fingerprint,operation:op,hasJournal:Boolean(control.journal),
      ...(calendarDriftCandidate&&control.epoch
        ?{calendarDriftCommitment:calendarDriftCommitment(op,snapshot,control.epoch)}:{}),
    };
  }

  /** Post-write review is separate from the pre-write RESTORE SYNC executor.
   * It can persist a fenced acknowledgement but NEVER queues or releases work. */
  async inspectPostWrite(id:string):Promise<PostWriteRecoveryAssessment> {
    const inspection=await this.inspect(id,{knownIdentityOnly:true});
    return {...assessPostWriteRecovery(inspection.operation,inspection.preview),
      ...(inspection.operation.postwriteReview?.status==="reviewed_fenced"
        ?{reviewStatus:"reviewed_fenced" as const}:{})};
  }

  private async inspectPostWriteCandidate(id:string) {
    const inspection=await this.inspect(id,{knownIdentityOnly:true});
    const assessment=assessPostWriteRecovery(inspection.operation,inspection.preview);
    if(assessment.classification!=="fully_deleted_candidate"||!inspection.preview.epoch
      ||inspection.operation.recovery||inspection.operation.postwriteReview)
      throw Object.assign(new Error("Post-write review requires fresh, fully deleted candidate evidence; keep fence"),{status:409});
    return {inspection,assessment,postflightFingerprint:postwriteEvidenceDigest(inspection)};
  }

  /** Create a NEW short-lived post-write token; an erasure or pre-write
   * confirmation cannot be reused. This does not authorise provider writes. */
  async issuePostWriteReviewToken(id:string,operator:string):Promise<{
    confirmationId:string;expiresAt:number;operationId:string;profile:string;releaseAllowed:false;
  }> {
    if(!operator||operator.length>256)throw Object.assign(new Error("Invalid operator identity"),{status:400});
    const {inspection,postflightFingerprint}=await this.inspectPostWriteCandidate(id);
    const confirmationId=this.newToken(),now=Date.now(),expiresAt=now+5*60_000;
    await this.db.send(new PutCommand({TableName:table(),Item:{
      ...postwriteReviewTokenKey(id),operationId:id,profile:inspection.operation.profile,
      mode:"post_write",status:"issued",operator,confirmationId,
      inspectedFingerprint:inspection.fingerprint,postflightFingerprint,
      originalPreviewFingerprint:inspection.operation.previewFingerprint,epoch:inspection.preview.epoch,
      expiresAt:Math.ceil(expiresAt/1000),expiresAtMs:expiresAt,createdAt:new Date(now).toISOString(),
    },ConditionExpression:"attribute_not_exists(pk) OR (#status=:issued AND expiresAtMs<=:now)",
      ExpressionAttributeNames:{"#status":"status"},
      ExpressionAttributeValues:{":issued":"issued",":now":now}}));
    return {confirmationId,expiresAt,operationId:id,profile:inspection.operation.profile,releaseAllowed:false};
  }

  /** Atomically consume one bound token and journal a *fenced-only* operator
   * acknowledgement. No worker, provider, mapping, marker or profile changes. */
  async acknowledgePostWriteReview(id:string,confirmationId:string,operator:string,
    typed:{operationId:string;profile:string;phrase:string}):Promise<{status:"reviewed_fenced";releaseAllowed:false}> {
    if(!idPattern.test(id)||!uuid.test(confirmationId)||!operator||operator.length>256
      ||typed?.operationId!==id||typed?.profile===undefined
      ||typed.phrase!==postwriteReviewPhrase)
      throw Object.assign(new Error("Exact typed REVIEW AND KEEP FENCED, operation and confirmation are required"),{status:400});
    const issued=(await this.db.send(new GetCommand({
      TableName:table(),Key:postwriteReviewTokenKey(id),ConsistentRead:true}))).Item;
    if(!issued||issued.status!=="issued"||issued.mode!=="post_write"
      ||issued.operator!==operator||issued.operationId!==id||issued.profile!==typed.profile
      ||issued.confirmationId!==confirmationId||issued.expiresAtMs<=Date.now())
      throw Object.assign(new Error("Post-write review token expired, consumed or changed"),{status:409});
    const {inspection,postflightFingerprint}=await this.inspectPostWriteCandidate(id);
    const {operation,preview,fingerprint,hasJournal}=inspection;
    if(operation.profile!==typed.profile||fingerprint!==issued.inspectedFingerprint
      ||postflightFingerprint!==issued.postflightFingerprint
      ||issued.originalPreviewFingerprint!==operation.previewFingerprint
      ||issued.epoch!==preview.epoch)
      throw Object.assign(new Error("Post-write provider or fence evidence drifted; obtain a new preview"),{status:409});
    const now=Date.now(),time=new Date(now).toISOString();
    const reviewed={
      mode:"post_write" as const,status:"reviewed_fenced" as const,epoch:preview.epoch!,
      confirmationId,inspectedFingerprint:fingerprint,postflightFingerprint,reviewedAt:time,
    };
    const transactions:any[]=[
      {Update:{TableName:table(),Key:operationKey(id),
        UpdateExpression:"SET postwriteReview=:review, updatedAt=:now",
        ConditionExpression:"#status=:required AND attribute_not_exists(postwriteReview) AND attribute_not_exists(recovery) AND previewFingerprint=:original AND updatedAt=:updated AND lifecycle.#phase=:phase",
        ExpressionAttributeNames:{"#status":"status","#phase":"phase"},
        ExpressionAttributeValues:{":required":"review_required",":review":reviewed,":now":time,
          ":original":operation.previewFingerprint,":updated":operation.updatedAt,":phase":operation.lifecycle!.phase}}},
      {Update:{TableName:table(),Key:postwriteReviewTokenKey(id),
        UpdateExpression:"SET #status=:consumed, consumedAt=:now REMOVE #ttl, expiresAtMs, #operator",
        ConditionExpression:"#status=:issued AND mode=:mode AND #operator=:operator AND operationId=:id AND confirmationId=:token AND inspectedFingerprint=:fingerprint AND postflightFingerprint=:postflight AND originalPreviewFingerprint=:original AND epoch=:epoch AND expiresAtMs>:time",
        ExpressionAttributeNames:{"#status":"status","#ttl":"expiresAt","#operator":"operator"},
        ExpressionAttributeValues:{":issued":"issued",":consumed":"consumed",":mode":"post_write",
          ":operator":operator,":id":id,":token":confirmationId,":fingerprint":fingerprint,
          ":postflight":postflightFingerprint,":original":operation.previewFingerprint,
          ":epoch":preview.epoch,":time":now,":now":time}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(operation.profile,"FENCE"),
        ConditionExpression:"operationId=:id AND #state=:active",
        ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":id":id,":active":"active"}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(operation.profile,"EPOCH"),
        ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":preview.epoch}}},
    ];
    if(hasJournal)transactions.push({ConditionCheck:{TableName:table(),Key:profileKey(operation.profile,"JOURNAL"),
      ConditionExpression:"operationId=:id",ExpressionAttributeValues:{":id":id}}});
    else transactions.push({ConditionCheck:{TableName:table(),Key:profileKey(operation.profile,"JOURNAL"),
      ConditionExpression:"attribute_not_exists(pk)"}});
    try {await this.db.send(new TransactWriteCommand({TransactItems:transactions}));}
    catch(error) {
      if((error as {name?:string})?.name==="TransactionCanceledException"
        ||(error as {name?:string})?.name==="ConditionalCheckFailedException")
        throw Object.assign(new Error("Post-write review state changed; no recovery or fence release occurred"),{status:409});
      throw error;
    }
    return {status:"reviewed_fenced",releaseAllowed:false};
  }

  /**
   * Bounded unattended recovery ONLY for independently verified pre-provider-write
   * erasures. Reuses the same three-step inspection, single-use token and CAS
   * transaction as the operator path; it never resumes provider deletion.
   * A refused or inconclusive inspection leaves every fence and mapping alone.
   */
  async startAutomaticPreWriteRecovery(id:string):Promise<{queued:boolean;blockerCount:number}> {
    const actor="system:erasure-prewrite-watchdog";
    let issued:{preview:RecoveryPreview;confirmationId:string;expiresAt:number};
    try {
      // This is the same operator-only pre-write inspection and short-lived
      // confirmation issuance, without a third expensive provider scan.
      issued=await this.issueConfirmation(id,actor);
    } catch(error) {
      if(error instanceof Error && (error as {status?:number}).status===409
        &&error.message==="Recovery is blocked; inspect safety evidence")
        return {queued:false,blockerCount:1};
      throw error; // A provider/IAM/timeout failure is not proof of safety.
    }
    if(!issued.preview.allowed||issued.preview.classification!=="pre_write")
      throw new Error("Automatic recovery requires independently verified pre-write evidence");
    // apply() re-inspects all sources, then locks the exact operation/fence/
    // epoch through the existing CAS. No new provider deletion is possible.
    await this.apply(id,issued.confirmationId,actor);
    return {queued:true,blockerCount:0};
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


  /** Distinct 5-minute token: only a proved untouched pre-write operation with
   * exact Calendar-only revision drift can be considered. This does not queue work. */
  async issueCalendarDriftCancellation(id:string,operator:string):Promise<{
    preview:RecoveryPreview;confirmationId:string;expiresAt:number;mode:"calendar_drift_cancel";
  }> {
    if(!operator||operator.length>256)throw Object.assign(new Error("Operator identity required"),{status:400});
    const inspected=await this.inspect(id);
    if(!inspected.preview.calendarDriftReview?.candidateForSeparateApproval
      ||!inspected.calendarDriftCommitment||!inspected.preview.epoch||inspected.preview.allowed)
      throw Object.assign(new Error("Exact Calendar-only drift inspection is not eligible"),{status:409});
    const now=Date.now(),expiresAt=now+5*60_000,confirmationId=this.newToken();
    await this.db.send(new PutCommand({TableName:table(),Item:{
      ...driftConfirmationKey(id),operationId:id,profile:inspected.operation.profile,
      mode:"calendar_drift_cancel",status:"issued",operator,confirmationId,
      currentEvidenceCommitment:inspected.calendarDriftCommitment,
      originalPreviewFingerprint:inspected.operation.previewFingerprint,
      epoch:inspected.preview.epoch,expiresAt:Math.ceil(expiresAt/1000),
      expiresAtMs:expiresAt,createdAt:new Date(now).toISOString(),
    },ConditionExpression:"attribute_not_exists(pk) OR expiresAt < :now",
      ExpressionAttributeValues:{":now":Math.floor(now/1000)}}));
    return {preview:inspected.preview,confirmationId,expiresAt,mode:"calendar_drift_cancel"};
  }

  /** Cancel an erasure that NEVER attempted provider deletion. The operator must
   * type a distinct phrase; the worker subsequently rechecks every invariant. */
  async applyCalendarDriftCancellation(id:string,confirmationId:string,operator:string,
    typed:{operationId:string;profile:string;phrase:string}):Promise<void> {
    if(!idPattern.test(id)||typeof confirmationId!=="string"
      ||!confirmationId||confirmationId.length>256||!operator||operator.length>256
      ||typed?.operationId!==id||typed.phrase!==CALENDAR_DRIFT_CANCEL_PHRASE)
      throw Object.assign(new Error("Exact CANCEL ERASURE AND RESTORE SYNC confirmation required"),{status:400});
    const issued=(await this.db.send(new GetCommand({TableName:table(),
      Key:driftConfirmationKey(id),ConsistentRead:true}))).Item;
    if(!issued||issued.status!=="issued"||issued.mode!=="calendar_drift_cancel"
      ||issued.operator!==operator||issued.operationId!==id||issued.profile!==typed.profile
      ||issued.confirmationId!==confirmationId
      ||typeof issued.expiresAtMs!=="number"||issued.expiresAtMs<=Date.now())
      throw Object.assign(new Error("Calendar drift token expired, mismatched or consumed"),{status:409});
    const current=await this.inspect(id);
    if(!current.preview.calendarDriftReview?.candidateForSeparateApproval
      ||!current.calendarDriftCommitment||current.calendarDriftCommitment!==issued.currentEvidenceCommitment
      ||current.operation.profile!==typed.profile
      ||current.operation.previewFingerprint!==issued.originalPreviewFingerprint
      ||current.preview.epoch!==issued.epoch)
      throw Object.assign(new Error("Calendar/provider/fence evidence drifted; inspect again"),{status:409});
    const now=Date.now(),time=new Date(now).toISOString();
    const recovery:RecoveryState={status:"queued",mode:"calendar_drift_cancel",
      fingerprint:current.fingerprint,lifecycleFingerprint:digest(current.operation.lifecycle),
      approvedCalendarDriftCommitment:current.calendarDriftCommitment,
      epoch:current.preview.epoch!,hasJournal:current.hasJournal,startedAt:time};
    const tx:any[]=[
      {Update:{TableName:table(),Key:operationKey(id),
        UpdateExpression:"SET recovery=:recovery, updatedAt=:now",
        ConditionExpression:"#status=:review AND attribute_not_exists(recovery) AND previewFingerprint=:fingerprint AND lifecycle.#phase=:phase AND updatedAt=:observedUpdatedAt",
        ExpressionAttributeNames:{"#status":"status","#phase":"phase"},
        ExpressionAttributeValues:{":review":"review_required",":recovery":recovery,
          ":fingerprint":current.operation.previewFingerprint,":phase":current.operation.lifecycle!.phase,
          ":observedUpdatedAt":current.operation.updatedAt,":now":time}}},
      {Update:{TableName:table(),Key:driftConfirmationKey(id),
        UpdateExpression:"SET #status=:consumed, consumedAt=:now",
        ConditionExpression:"#status=:issued AND mode=:mode AND operator=:operator AND confirmationId=:token AND currentEvidenceCommitment=:digest AND expiresAtMs>:time",
        ExpressionAttributeNames:{"#status":"status"},
        ExpressionAttributeValues:{":issued":"issued",":consumed":"consumed",":mode":"calendar_drift_cancel",
          ":operator":operator,":token":confirmationId,":digest":current.calendarDriftCommitment,
          ":time":now,":now":time}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(current.operation.profile,"FENCE"),
        ConditionExpression:"operationId=:id AND #state=:active",
        ExpressionAttributeNames:{"#state":"state"},ExpressionAttributeValues:{":id":id,":active":"active"}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(current.operation.profile,"EPOCH"),
        ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":current.preview.epoch}}},
      current.hasJournal
        ?{ConditionCheck:{TableName:table(),Key:profileKey(current.operation.profile,"JOURNAL"),
          ConditionExpression:"operationId=:id",ExpressionAttributeValues:{":id":id}}}
        :{ConditionCheck:{TableName:table(),Key:profileKey(current.operation.profile,"JOURNAL"),
          ConditionExpression:"attribute_not_exists(pk)"}},
    ];
    try {await this.db.send(new TransactWriteCommand({TransactItems:tx}));}
    catch(error) {
      if(["TransactionCanceledException","ConditionalCheckFailedException"]
        .includes((error as {name?:string})?.name||""))
        throw Object.assign(new Error("Calendar drift cancellation lost operation/fence CAS; no recovery was queued"),{status:409});
      throw error;
    }
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
