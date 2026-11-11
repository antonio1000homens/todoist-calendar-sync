/** Isolated, fail-closed recovery of a review_required erasure. Never resumes provider deletion. */
import {createHash, randomUUID} from "node:crypto";
import {GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import {ErasureOperationStore, erasurePreviewFingerprint, type ErasureOperation,
  type ErasurePostWriteCompletionReceipt,type FencedMapping} from "./erasure-executor.js";
import type {CrossProfileErasureEvidence} from "./erasure-cross-profile-evidence.js";
import type {ErasurePreviewResult,KnownTargetReadback} from "./erasure-preview.js";
import {assessPostWriteRecovery,type PostWriteRecoveryAssessment} from "./erasure-postwrite-preview.js";
import {erasureExecutionEnabled} from "./erasure-readiness.js";
import {inspectRecoveryComparisons,type InspectionComparisons,
  type ProjectTombstoneInspection} from "./erasure-recovery-inspection.js";

export type RecoveryStatus = "queued" | "restoring" | "verifying" | "completed" | "blocked";
export type GuardedRecoveryMode = "strict_pre_write" | "calendar_drift_cancel";
export interface RecoveryState {
  status:RecoveryStatus;
  /** A Calendar-drift cancellation is never admitted through the automatic watchdog. */
  mode?:GuardedRecoveryMode;
  /** Operation-bound current Calendar revision. Checked at every worker step. */
  calendarDigest?:string;
  calendarEtag?:string;
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
  /** Explanatory comparison snapshots and exact recorded-comment check.
   * Never used to grant recovery, issue tokens, or release a fence. */
  comparisonDetails?:InspectionComparisons;
  projectTombstone?:ProjectTombstoneInspection;
  /** Explanation-only statuses from this inspection, never used to grant recovery. */
  diagnostics?:Record<
    "lifecycle"|"originalConfirmation"|"audit"|"freshPreview"|"originalProviderSnapshot"
    |"operationFingerprint"|"snapshotBlockers"|"todoistTask"|"calendarEvent"
    |"comments"|"projectCommentIds"|"calendarAliases"|"stateInventory"
    |"fence"|"epoch"|"mappingInventory"|"mappingStates"|"workerLeases",
    "verified"|"missing"|"mismatched">;
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
const erasureConfirmationKey=(id:string)=>({pk:"ERASURE_CONFIRMATION#"+id,sk:"STATE"});
const confirmationKey=(id:string)=>({pk:"ERASURE_RECOVERY_CONFIRMATION#"+id,sk:"STATE"});
const legacyPostwriteReviewTokenKey=(id:string)=>({pk:"ERASURE_POSTWRITE_CONFIRMATION#"+id,sk:"STATE"});
/** A timed-out write-ahead claim on the first project-comment tombstone is
 * recoverable only while its original mapping, task, Calendar event, comments,
 * and DynamoDB inventory all still match the confirmed snapshot. Recovery
 * restores sync and never resumes deletion. */
function initialProjectCommentAttempt(operation:ErasureOperation,allowDriftCancellation=false):boolean {
  const lifecycle=operation.lifecycle;
  const progress=lifecycle?.deletionProgress;
  const deletionStarted=lifecycle?.evidence?.deletionStarted;
  const item=operation.actionPlan.comments?.[0];
  const attempt=progress?.attempt;
  const recoveryMode=operation.recovery?.mode;
  return operation.status==="review_required"&&lifecycle?.phase==="delete"
    &&Boolean(deletionStarted)
    &&progress?.stage==="comments"&&progress.commentIndex===0&&progress.stateIndex===0
    &&progress.finalCommentIndex===undefined
    &&item?.kind==="project"&&item.id===operation.actionPlan.projectCommentIds?.[0]
    &&Boolean(attempt&&uuid.test(attempt.id)&&Number.isFinite(attempt.startedAt)
      &&attempt.startedAt>=deletionStarted!.completedAt
      &&attempt.startedAt+((lifecycle.timeoutSeconds*1000)+2000)<=Date.now())
    &&!operation.postwriteReview
    &&(!operation.recovery||recoveryMode==="strict_pre_write"
      ||(allowDriftCancellation&&recoveryMode==="calendar_drift_cancel"));
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
  const noWrites=(!lifecycle.evidence.deletionStarted && !lifecycle.deletionProgress
    && recoverableBeforeWrite.has(lifecycle.phase))||initialProjectCommentAttempt(operation);
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
    originalPreWritePhase:(!lifecycle.evidence.deletionStarted
      &&!lifecycle.deletionProgress&&recoverableBeforeWrite.has(lifecycle.phase))
      ||initialProjectCommentAttempt(operation,operation.recovery?.mode==="calendar_drift_cancel"),
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
/** Diagnostic comparisons deliberately cannot influence the existing recoveryMode/guards. */
function readOnlyRecoveryDiagnostics(
  op:ErasureOperation,snapshot:ErasurePreviewResult,
  checks:NonNullable<RecoveryPreview["evidenceChecks"]>,
  control:{fence?:Record<string,unknown>;epoch?:number;leases:Record<string,unknown>[]},
  mappings:FencedMapping[],active:Array<{id:string;state:string}>,id:string,
):NonNullable<RecoveryPreview["diagnostics"]> {
  type Status="verified"|"missing"|"mismatched";
  const original=op.lifecycle!.mappingIds||[];
  const baseline=snapshot.crossProfileEvidence
    ?snapshot.primaryProviderSnapshotFingerprint:snapshot.providerSnapshotFingerprint;
  const status=(ok:boolean,missing:boolean):Status=>ok?"verified":missing?"missing":"mismatched";
  const compare=(ok:boolean,expected:unknown,current:unknown):Status=>
    status(ok,expected!==undefined&&expected!==null&&(current===undefined||current===null));
  const currentIds=mappings.map(item=>item.id).sort();
  const exactMappingInventory=currentIds.length===original.length
    &&currentIds.every((value,i)=>value===[...original].sort()[i])
    &&mappings.every(value=>/^[0-9a-f-]{36}$/i.test(value.id)
      &&value.eventSourceArn?.includes(":sqs:")&&["Enabled","Disabled"].includes(value.state));
  const originallyEnabled=new Set(Array.isArray(op.lifecycle!.enabledMappingIds)
    ?op.lifecycle!.enabledMappingIds:[]);
  const mapped=active.length===original.length&&new Set(active.map(value=>value.id)).size===original.length
    &&active.every(value=>original.includes(value.id)&&["Enabled","Disabled"].includes(value.state))
    &&active.every(value=>originallyEnabled.has(value.id)||value.state==="Disabled");
  return {
    lifecycle:status(checks.originalPreWritePhase,!op.lifecycle?.phase),
    originalConfirmation:status(checks.originalConfirmationIntact,!op.confirmationId||!op.confirmationFingerprint),
    audit:status(checks.auditComplete,Boolean(snapshot.crossProfileEvidence
      &&(!snapshot.crossProfileEvidence.stateScan||snapshot.crossProfileEvidence.allProfilesQueried===undefined))),
    freshPreview:status(checks.freshPreviewSelfConsistent,!snapshot.previewFingerprint),
    originalProviderSnapshot:compare(checks.primaryProviderMatches,op.providerSnapshotFingerprint,baseline),
    operationFingerprint:compare(checks.originalPreviewMatches,op.previewFingerprint,baseline),
    snapshotBlockers:status(checks.providerSafetyBlockerCount===0,false),
    todoistTask:compare(checks.todoistTaskMatches,op.actionPlan.todoistTask,snapshot.actionPlan.todoistTask),
    calendarEvent:compare(checks.calendarEventMatches,op.actionPlan.calendarEvent,snapshot.actionPlan.calendarEvent),
    comments:compare(checks.commentsMatch,op.actionPlan.comments,snapshot.actionPlan.comments),
    projectCommentIds:compare(checks.projectCommentIdsMatch,op.actionPlan.projectCommentIds,snapshot.actionPlan.projectCommentIds),
    calendarAliases:status(checks.knownCalendarAliasesMatch,false),
    stateInventory:compare(checks.stateInventoryMatches,op.inventory,snapshot.inventory),
    fence:status(control.fence?.operationId===id&&control.fence.state==="active",!control.fence),
    epoch:status(typeof control.epoch==="number"&&Number.isFinite(control.epoch)&&control.epoch>0,control.epoch===undefined),
    mappingInventory:status(exactMappingInventory,mappings.length===0),
    mappingStates:status(mapped,active.length===0),
    workerLeases:status(control.leases.length===0,false),
  };
}
/** Triage only. A Calendar revision can make the original full-body digest differ
 * even when no erasure deletion was attempted. A candidate is never strict
 * recovery: cancellation uses a distinct one-time confirmation and revalidates
 * the exact current Calendar revision before every worker transition. */
function calendarOnlyPreWriteDriftCandidate(operation:ErasureOperation,snapshot:ErasurePreviewResult,
  checks:NonNullable<RecoveryPreview["evidenceChecks"]>,blockingReasons:readonly string[],
  mappingStates:Array<{id:string;state:string}>,
  options:{duringRestore?:boolean;targetOnlySnapshot?:boolean}={}):boolean {
  const original=operation.actionPlan.calendarEvent,current=snapshot.actionPlan.calendarEvent;
  // The exact first project-comment attempt proves deletion could not yet have
  // started. For that one cancellation path, exact target reads plus the full
  // strongly consistent DynamoDB identity inventory are sufficient: this
  // path preserves both provider objects and never resumes deletion. Later
  // stages and every deletion proof still require the complete cross-profile audit.
  const targetOnlyCancellation=options.targetOnlySnapshot===true
    &&initialProjectCommentAttempt(operation,options.duringRestore===true);
  return blockingReasons.length===0
    && (options.duringRestore?operation.recovery?.mode==="calendar_drift_cancel":!operation.recovery)
    && !operation.postwriteReview
    && operation.selectedActions.deleteCalendar===true
    && (snapshot.crossProfileEvidence!==undefined||targetOnlyCancellation)
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
    && mappingStates.every(x=>x.state==="Disabled" || (options.duringRestore
      &&operation.lifecycle?.enabledMappingIds.includes(x.id)
      &&["Enabled","Enabling"].includes(x.state)));
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

  async inspect(id:string,options:{knownIdentityOnly?:boolean}={}):Promise<{
    preview:RecoveryPreview;fingerprint:string;operation:ErasureOperation;hasJournal:boolean;
    /** Private to server-side callers; never returned through the review API. */
    snapshot:ErasurePreviewResult;
  }> {
    if(!idPattern.test(id))throw Object.assign(new Error("Invalid recovery operation ID"),{status:400});
    const op=await this.erasures.get(id);
    if(!op)throw Object.assign(new Error("Erasure operation not found; absence cannot prove success"),{status:404});
    if(op.status!=="review_required"||!op.lifecycle)
      throw Object.assign(new Error("Only a persisted review_required erasure can be inspected for recovery"),{status:409});
    const blockers=validateLifecycle(op);
    // Read each source even if another is blocked; never issue confirmation on a partial read or exception.
    // A timed-out claim on the very first project-comment tombstone is
    // recoverable only before provider deletion can begin. For this one exact
    // lifecycle shape, the immutable operation already binds the target-only
    // provider snapshot; re-reading every profile's full task inventory adds
    // no evidence to the no-write proof and can exhaust the review deadline.
    // The exact target, comment set and full DDB inventory are still reread,
    // and every later deletion stage continues to require the full audit.
    const knownTargetOnly=options.knownIdentityOnly||initialProjectCommentAttempt(op);
    const readSnapshot=knownTargetOnly&&this.adapters.readKnownTargetSnapshot
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
      op,snapshot,evidenceChecks,structuralBlockers,active,{targetOnlySnapshot:knownTargetOnly});
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
    const diagnostics=readOnlyRecoveryDiagnostics(op,snapshot,evidenceChecks,control,mappings,active,id);
    const comparisonDetails=inspectRecoveryComparisons(op,snapshot);
    const projectTombstone=snapshot.projectTombstone||{
      status:"not_checked" as const,recordedCommentFound:null,markerMatchesTaskAndCalendar:null,
      recordedCommentCount:op.actionPlan.projectCommentIds?.length||0,foundCommentCount:0,
      explanation:"The exact recorded project comment has not been read; do not infer that the tombstone is present.",
    };
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
      evidenceChecks,diagnostics,comparisonDetails,projectTombstone,
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
    return {preview,fingerprint,operation:op,hasJournal:Boolean(control.journal),snapshot};
  }

  private postWriteAssessment(inspection:Awaited<ReturnType<ErasureRecoveryService["inspect"]>>):PostWriteRecoveryAssessment {
    const base=assessPostWriteRecovery(inspection.operation,inspection.preview);
    const completionBlockers=[...base.completionBlockers];
    if(base.classification==="fully_deleted_candidate") {
      if(inspection.operation.providerDeletionReady!==true)
        completionBlockers.push("The original operation was not approved for provider deletion; keep the fence.");
      if(!erasureExecutionEnabled())
        completionBlockers.push("The existing erasure execution gate is disabled; keep the fence until the approved writer/IAM release boundary is enabled.");
      if(process.env.ERASURE_PROTOCOL_VERSION!=="1")
        completionBlockers.push("The existing profile fence/lease protocol is not active; keep the fence.");
      if(inspection.operation.recovery)
        completionBlockers.push("A separate recovery is already recorded for this operation; do not run post-write completion.");
    }
    const eligible=base.completionEligible&&completionBlockers.length===0;
    return {...base,completionEligible:eligible,
      completionBlockers:[...new Set(completionBlockers)].sort(),
      blockers:eligible?[]:[...new Set(completionBlockers)].sort(),
      onlyAvailableAction:eligible?"automatic_completion_pending":"keep_fenced",
      ...(base.completion?{completion:{...base.completion,status:eligible?"pending" as const:"blocked" as const}}:{})};
  }

  /** Validate a partial post-write state checkpoint before allowing the existing
   * deletion adapter to continue. Only original inventory rows at/after the
   * durable stateIndex may be touched; provider-delete stages are never resumed. */
  private postWriteStateCleanupBlockers(
    inspection:Awaited<ReturnType<ErasureRecoveryService["inspect"]>>,
  ):string[] {
    const {operation,snapshot,preview}=inspection;
    const lifecycle=operation.lifecycle,progress=lifecycle?.deletionProgress;
    const blockers:string[]=[];
    if(operation.status!=="review_required"||lifecycle?.phase!=="delete")
      blockers.push("The original operation is not stopped at the state-cleanup phase.");
    if(!progress||!["state","verify"].includes(progress.stage)||progress.attempt)
      blockers.push("The deletion checkpoint is missing, outside state cleanup, or has an uncertain write-ahead attempt.");
    if(!lifecycle?.evidence.deletionStarted||lifecycle.evidence.deletionStarted.operationId!==operation.operationId
      ||lifecycle.evidence.deletionStarted.phase!=="deletionStarted")
      blockers.push("The original provider-deletion start receipt is missing or mismatched.");
    if(!lifecycle?.evidence.fenceInstalled||lifecycle.evidence.fenceInstalled.operationId!==operation.operationId)
      blockers.push("The original operation-owned fence receipt is missing or mismatched.");
    if(operation.providerDeletionReady!==true||!erasureExecutionEnabled()
      ||process.env.ERASURE_PROTOCOL_VERSION!=="1")
      blockers.push("The original operation approval or existing deployment/protocol gate is not active.");
    if(operation.recovery)blockers.push("A separate recovery is already recorded for this operation.");
    if(operation.target.deleteCalendar!==true||operation.selectedActions.deleteTodoist!==true
      ||operation.selectedActions.deleteCalendar!==true||!operation.target.taskId||!operation.target.eventId
      ||operation.actionPlan.todoistTask?.id!==operation.target.taskId
      ||operation.actionPlan.calendarEvent?.id!==operation.target.eventId
      ||!operation.actionPlan.calendarEvent?.calendarId)
      blockers.push("The immutable original Todoist and Calendar deletion targets are incomplete or inconsistent.");
    if(!preview.providerItemsAbsent||preview.knownTargetReadback?.todoist!=="absent"
      ||preview.knownTargetReadback.calendar!=="absent"
      ||preview.knownTargetReadback.configuredCalendarLink!=="not_found")
      blockers.push("The exact original Todoist task, Calendar event and configured task link are not all proven absent.");
    if(preview.snapshotSafetyBlockerCount!==0||snapshot.blockers.length)
      blockers.push("The current attributable state inventory has a safety blocker.");
    if(!preview.fenceOwned||!Number.isSafeInteger(preview.epoch)||!preview.epoch||preview.leaseCount!==0)
      blockers.push("The operation-owned fence, epoch or drained lease evidence is incomplete.");
    const tombstone=preview.projectTombstone;
    const projectIds=operation.actionPlan.projectCommentIds||[];
    if(tombstone?.status!=="present"||tombstone.recordedCommentFound!==true
      ||tombstone.markerMatchesTaskAndCalendar!==true
      ||tombstone.recordedCommentCount!==projectIds.length||tombstone.foundCommentCount!==projectIds.length)
      blockers.push("The exact original project-comment inventory does not have a matching active tombstone.");
    const projectComments=operation.actionPlan.comments.filter(item=>item.kind==="project").map(item=>item.id).sort();
    if(!Array.isArray(projectIds)||new Set(projectIds).size!==projectIds.length
      ||projectComments.length!==projectIds.length
      ||projectComments.some((value,index)=>value!==[...projectIds].sort()[index]))
      blockers.push("The original project-comment inventory is incomplete or inconsistent.");
    const event=operation.actionPlan.calendarEvent;
    const aliases=operation.actionPlan.knownCalendarAliases||[];
    const aliasKeys=aliases.map(alias=>[alias.profile,alias.calendarId,alias.eventId].join("\u0000")).sort();
    const snapshotAliases=snapshot.actionPlan.knownCalendarAliases||[];
    const snapshotAliasKeys=snapshotAliases.map(alias=>[alias.profile,alias.calendarId,alias.eventId].join("\u0000")).sort();
    if(operation.actionPlan.knownCalendarAliasesComplete!==true
      ||snapshot.actionPlan.knownCalendarAliasesComplete!==true
      ||preview.evidenceChecks?.knownCalendarAliasesMatch!==true
      ||!aliases.length||aliases.length>32||new Set(aliasKeys).size!==aliases.length
      ||JSON.stringify(aliasKeys)!==JSON.stringify(snapshotAliasKeys)
      ||!aliases.some(alias=>alias.profile===operation.profile
        &&alias.calendarId===event?.calendarId&&alias.eventId===event?.id))
      blockers.push("The complete bounded original Calendar alias inventory is not proven to match the fresh readback.");
    const mappingIds=lifecycle?.mappingIds||[],enabled=new Set(lifecycle?.enabledMappingIds||[]);
    const mappingStates=inspection.mappingStates||[];
    if(mappingStates.length!==mappingIds.length||new Set(mappingStates.map(item=>item.id)).size!==mappingIds.length
      ||mappingIds.some(id=>{
        const item=mappingStates.find(value=>value.id===id);
        return !item||!["Enabled","Disabled"].includes(item.state)||(!enabled.has(id)&&item.state!=="Disabled");
      }))
      blockers.push("The live worker mapping inventory is missing, transitional or has an originally-disabled mapping enabled.");
    if(progress&&lifecycle) {
      if(!Number.isInteger(progress.stateIndex)||progress.stateIndex<0||progress.stateIndex>operation.inventory.length
        ||progress.commentIndex!==operation.actionPlan.comments.length
        ||(progress.finalCommentIndex!==undefined&&progress.finalCommentIndex!==projectIds.length))
        blockers.push("The persisted comment/state indexes do not match the original deletion manifest.");
      const ordered=[...operation.inventory].sort((a,b)=>
        Number(a.type==="SYNC_CONTROL")-Number(b.type==="SYNC_CONTROL")
        ||a.key.pk.localeCompare(b.key.pk)||a.key.sk.localeCompare(b.key.sk));
      const originalKeys=ordered.map(item=>item.key.pk+"\u0000"+item.key.sk);
      const remaining=new Map(ordered.slice(progress.stateIndex).map(item=>[item.key.pk+"\u0000"+item.key.sk,item]));
      const currentRows=snapshot.inventory||[];
      const currentKeys=currentRows.map(item=>item.key.pk+"\u0000"+item.key.sk);
      if(new Set(originalKeys).size!==originalKeys.length||new Set(currentKeys).size!==currentKeys.length
        ||currentRows.some(item=>{
          const original=remaining.get(item.key.pk+"\u0000"+item.key.sk);
          return !original||item.type!==original.type||(item.digest!==original.digest
            &&!(original.receiptCleanup==="scrub_identity_refs"&&original.scrubbedDigest===item.digest));
        }))
        blockers.push("Remaining DynamoDB rows include an unrecorded, duplicate, already-processed or changed item; preserve the fence.");
    }
    const unrelated=inspection.blockers.filter(item=>
      item!=="Partial or ambiguous provider/record deletion requires a separately reviewed reconciliation");
    blockers.push(...unrelated);
    return [...new Set(blockers)].sort();
  }

  private completedPostWriteAssessment(operation:ErasureOperation):PostWriteRecoveryAssessment {
    const receipt=operation.postWriteCompletion!;
    return {
      operationId:operation.operationId,profile:operation.profile,classification:"completed",
      releaseAllowed:false,onlyAvailableAction:"completed",potentialDisposition:"completed",
      completionEligible:false,completionBlockers:[],blockers:[],
      completion:{status:"completed",automatic:true,tombstoneRetained:true,providerDeletesReplayed:false,
        completedAt:receipt.completedAt,epoch:receipt.epoch,originalMappingCount:receipt.originalMappingCount,
        restoredMappingCount:receipt.restoredMappingCount,fenceReleased:true},
      knownIdentity:{status:"known_identity_deleted",scope:"recorded_original_targets_in_configured_profile",
        releaseAllowed:false},
      evidence:{originalProviderWriteIndicated:true,originalCalendarDeletionSelected:true,
        exactTodoistAndCalendarTargetsRecorded:true,matchingFence:true,epochVerified:true,leasesDrained:true,
        providersAbsent:true,stateRowsAbsent:true,mappingStateCount:receipt.originalMappingCount,
        workerMappingsRestored:true,deletionCheckpointComplete:true,projectTombstonePresent:true,
        knownCalendarAliasesComplete:true},
    };
  }

  /** Read-only inspection. The existing worker watchdog performs the bounded
   * operation-scoped completion when every exact checkpoint is independently proven. */
  async inspectPostWrite(id:string):Promise<PostWriteRecoveryAssessment> {
    const operation=await this.erasures.get(id);
    if(!operation)throw Object.assign(new Error("Erasure operation not found; absence cannot prove success"),{status:404});
    if(operation.status==="succeeded"&&operation.postWriteCompletion?.status==="completed")
      return this.completedPostWriteAssessment(operation);
    const inspection=await this.inspect(id,{knownIdentityOnly:true});
    return this.postWriteAssessment(inspection);
  }

  /** Idempotent finalizer for the exact, already-deleted operation. It never
   * calls a provider delete or starts a new queue; the active tombstone and
   * operation-owned fence remain in place until mappings are restored and one
   * conditional DynamoDB transaction retires the identity-bearing operation. */
  async completePostWriteIfSafe(id:string):Promise<{
    status:"completed"|"blocked"|"in_progress"|"not_applicable";blockers:string[];
  }> {
    if(!idPattern.test(id))throw Object.assign(new Error("Invalid recovery operation ID"),{status:400});
    const existing=await this.erasures.get(id);
    if(!existing)return {status:"blocked",blockers:["The original operation record is missing; absence cannot prove completion."]};
    if(existing.status==="succeeded"&&existing.postWriteCompletion?.status==="completed")
      return {status:"completed",blockers:[]};
    if(existing.status!=="review_required"||!existing.lifecycle)
      return {status:"not_applicable",blockers:[]};
    const indicated=Boolean(existing.lifecycle.evidence?.deletionStarted||existing.lifecycle.deletionProgress
      ||["delete","verify_deletion"].includes(existing.lifecycle.phase));
    if(!indicated)return {status:"not_applicable",blockers:[]};
    if(existing.recovery)return {status:"blocked",blockers:["A separate recovery is already recorded; preserve the existing fence."]};
    if(existing.providerDeletionReady!==true)
      return {status:"blocked",blockers:["The original operation was not approved for provider deletion; preserve the existing fence."]};
    if(!erasureExecutionEnabled())
      return {status:"blocked",blockers:["The existing erasure execution gate is disabled; preserve the fence until the approved writer/IAM release boundary is enabled."]};
    if(process.env.ERASURE_PROTOCOL_VERSION!=="1")
      return {status:"blocked",blockers:["The existing profile fence/lease protocol is not active; preserve the existing fence."]};

    let inspection=await this.inspect(id,{knownIdentityOnly:true});
    let assessment=this.postWriteAssessment(inspection);
    if(!assessment.completionEligible) {
      const cleanupBlockers=this.postWriteStateCleanupBlockers(inspection);
      if(cleanupBlockers.length)
        return {status:"blocked",blockers:[...new Set([...assessment.completionBlockers,...cleanupBlockers])].sort()};
      // Reuse the existing fenced deletion adapter only after the provider
      // stages are complete. It processes one exact original state row at a
      // time, including eligible delivery-receipt scrubbing; it cannot enter
      // comments/Todoist/Calendar stages while status is review_required.
      let steps=0;
      while(steps<10) {
        const current=await this.erasures.get(id);
        const progress=current?.lifecycle?.deletionProgress;
        if(!current||current.status!=="review_required"||current.lifecycle?.phase!=="delete"
          ||!progress||!["state","verify"].includes(progress.stage)||progress.attempt)
          return {status:"blocked",blockers:["The state-cleanup checkpoint changed or has an uncertain write-ahead attempt; the fence remains active."]};
        const control=await readControl(this.db,current.profile);
        if(control.fence?.operationId!==id||control.fence.state!=="active"
          ||control.epoch!==inspection.preview.epoch||control.leases.length!==0
          ||Boolean(control.journal)!==inspection.hasJournal
          ||(control.journal&&control.journal.operationId!==id))
          return {status:"blocked",blockers:["The operation-owned fence, epoch, lease drain or journal ownership changed during state cleanup."]};
        const advanced=await this.erasures.advanceFencedLifecycle(id);
        if(advanced.waiting)
          return {status:"in_progress",blockers:["Exact original state cleanup is waiting for its persisted checkpoint; the existing watchdog will continue without replaying provider deletes."]};
        steps++;
        const latest=await this.erasures.get(id);
        if(!latest||latest.status!=="review_required")
          return {status:"blocked",blockers:["The original operation changed while state cleanup was in progress; preserve the fence."]};
        if(latest.lifecycle?.phase==="verify_deletion") {
          inspection=await this.inspect(id,{knownIdentityOnly:true});
          assessment=this.postWriteAssessment(inspection);
          break;
        }
        if(latest.lifecycle?.phase!=="delete"||!latest.lifecycle.deletionProgress
          ||!["state","verify"].includes(latest.lifecycle.deletionProgress.stage)
          ||latest.lifecycle.deletionProgress.attempt)
          return {status:"blocked",blockers:["State cleanup did not persist a safe next checkpoint; preserve the fence."]};
      }
      if(!assessment.completionEligible)
        return {status:"in_progress",blockers:["The exact original state inventory is being removed under the active fence. The existing watchdog will continue from the persisted checkpoint."]};
    }
    const operation=inspection.operation,lifecycle=operation.lifecycle!,progress=lifecycle.deletionProgress!;
    const enabledIds=[...lifecycle.enabledMappingIds];
    // Recheck the owner and immutable operation immediately before the mapping
    // write. The fence prevents new admissions while this bounded step runs.
    const [preRestoreControl,preRestoreOperation]=await Promise.all([
      readControl(this.db,operation.profile),this.erasures.get(id),
    ]);
    if(preRestoreControl.fence?.operationId!==id||preRestoreControl.fence.state!=="active"
      ||preRestoreControl.epoch!==inspection.preview.epoch||preRestoreControl.leases.length!==0
      ||Boolean(preRestoreControl.journal)!==inspection.hasJournal
      ||(preRestoreControl.journal&&preRestoreControl.journal.operationId!==id)
      ||!preRestoreOperation||preRestoreOperation.status!=="review_required"
      ||preRestoreOperation.updatedAt!==operation.updatedAt
      ||digest(preRestoreOperation.lifecycle)!==digest(operation.lifecycle)
      ||preRestoreOperation.previewFingerprint!==operation.previewFingerprint)
      return {status:"blocked",blockers:["The operation changed before mapping restoration; the fence remains active."]};
    // Lambda mapping updates are idempotent. A retry reads the actual state and
    // only re-enables UUIDs that the original operation recorded as enabled.
    await this.adapters.restoreMappings(enabledIds);

    const [liveMappings,mappingStates,control,latest]=await Promise.all([
      this.adapters.listWorkerMappings(),this.adapters.mappingStates(lifecycle.mappingIds),
      readControl(this.db,operation.profile),this.erasures.get(id),
    ]);
    if(latest?.status==="succeeded"&&latest.postWriteCompletion?.status==="completed")
      return {status:"completed",blockers:[]};
    const expectedIds=[...lifecycle.mappingIds].sort();
    const liveIds=liveMappings.map(item=>item.id).sort();
    const enabled=new Set(enabledIds);
    const statesById=new Map(mappingStates.map(item=>[item.id,item.state]));
    const mappingInventoryMatches=liveMappings.length===expectedIds.length
      &&liveIds.every((value,index)=>value===expectedIds[index])
      &&liveMappings.every(item=>uuid.test(item.id)&&item.eventSourceArn?.includes(":sqs:")
        &&["Enabled","Disabled"].includes(item.state));
    const mappingStatesMatch=mappingStates.length===expectedIds.length
      &&new Set(mappingStates.map(item=>item.id)).size===expectedIds.length
      &&expectedIds.every(mappingId=>statesById.get(mappingId)===(enabled.has(mappingId)?"Enabled":"Disabled"));
    if(!mappingInventoryMatches||!mappingStatesMatch)
      return {status:"blocked",blockers:["Worker mappings do not match the exact original enablement inventory after restoration; the fence remains active."]};
    if(control.fence?.operationId!==id||control.fence.state!=="active"
      ||control.epoch!==inspection.preview.epoch||control.leases.length!==0
      ||Boolean(control.journal)!==inspection.hasJournal
      ||(control.journal&&control.journal.operationId!==id))
      return {status:"blocked",blockers:["The operation-owned fence, epoch, lease drain or journal ownership changed; the fence was not released."]};
    if(!latest||latest.status!=="review_required"||latest.updatedAt!==operation.updatedAt
      ||latest.previewFingerprint!==operation.previewFingerprint
      ||digest(latest.lifecycle)!==digest(operation.lifecycle)||latest.recovery
      ||latest.postWriteCompletion)
      return {status:"blocked",blockers:["The recorded operation changed during completion; refresh evidence before retrying."]};

    const deletionStarted=lifecycle.evidence.deletionStarted!;
    const projectCommentIds=operation.actionPlan.projectCommentIds||[];
    const completion:ErasurePostWriteCompletionReceipt={
      mode:"known_identity_post_write",status:"completed",completedAt:new Date().toISOString(),
      epoch:inspection.preview.epoch!,originalMappingCount:lifecycle.mappingIds.length,
      restoredMappingCount:enabledIds.length,tombstoneRetained:true,providerDeletesReplayed:false,
    };
    const names:Record<string,string>={
      "#status":"status","#phase":"phase","#progress":"deletionProgress","#stage":"stage",
      "#commentIndex":"commentIndex","#stateIndex":"stateIndex","#startedAt":"startedAt",
      "#attempt":"attempt","#deletionStarted":"deletionStarted","#receiptPhase":"phase",
      "#mappingIds":"mappingIds","#enabledMappingIds":"enabledMappingIds",
      "#finalCommentIndex":"finalCommentIndex","#error":"error",
      "#target":"target","#selectedActions":"selectedActions","#previewFingerprint":"previewFingerprint",
      "#providerSnapshotFingerprint":"providerSnapshotFingerprint","#confirmationFingerprint":"confirmationFingerprint",
      "#confirmationId":"confirmationId","#providerDeletionReady":"providerDeletionReady",
      "#inventory":"inventory","#actionPlan":"actionPlan","#lifecycle":"lifecycle","#recovery":"recovery",
      "#postwriteReview":"postwriteReview","#requestId":"requestId","#result":"result",
    };
    const values:Record<string,any>={
      ":review":"review_required",":succeeded":"succeeded",":phase":lifecycle.phase,
      ":stage":progress.stage,":commentIndex":progress.commentIndex,":stateIndex":progress.stateIndex,
      ":startedAt":progress.startedAt,":id":id,":deletionStarted":"deletionStarted",
      ":deletionReceiptId":deletionStarted.receiptId,":deletionStartedAt":deletionStarted.completedAt,
      ":ready":true,":fingerprint":operation.previewFingerprint,":confirmationId":operation.confirmationId,
      ":taskId":operation.target.taskId,":eventId":operation.target.eventId,
      ":calendarId":operation.actionPlan.calendarEvent!.calendarId,":profile":operation.profile,
      ":projectCommentCount":projectCommentIds.length,":commentCount":operation.actionPlan.comments.length,
      ":inventoryCount":operation.inventory.length,":mappingCount":lifecycle.mappingIds.length,
      ":enabledMappingCount":enabledIds.length,":timeoutSeconds":lifecycle.timeoutSeconds,
      ":pollMs":lifecycle.pollMs,":updatedAt":operation.updatedAt,
    };
    const conditions=[
      "#status=:review","profile=:profile","lifecycle.#phase=:phase",
      "lifecycle.#progress.#stage=:stage","lifecycle.#progress.#commentIndex=:commentIndex",
      "lifecycle.#progress.#stateIndex=:stateIndex","lifecycle.#progress.#startedAt=:startedAt",
      "attribute_not_exists(lifecycle.#progress.#attempt)",
      "lifecycle.evidence.#deletionStarted.operationId=:id",
      "lifecycle.evidence.#deletionStarted.#receiptPhase=:deletionStarted",
      "lifecycle.evidence.#deletionStarted.receiptId=:deletionReceiptId",
      "lifecycle.evidence.#deletionStarted.completedAt=:deletionStartedAt",
      "lifecycle.timeoutSeconds=:timeoutSeconds","lifecycle.pollMs=:pollMs",
      "size(lifecycle.#mappingIds)=:mappingCount","size(lifecycle.#enabledMappingIds)=:enabledMappingCount",
      "providerDeletionReady=:ready","previewFingerprint=:fingerprint",
      "confirmationFingerprint=:fingerprint","confirmationId=:confirmationId",
      "target.taskId=:taskId","target.eventId=:eventId","target.deleteCalendar=:ready",
      "selectedActions.deleteTodoist=:ready","selectedActions.deleteCalendar=:ready",
      "actionPlan.todoistTask.id=:taskId","actionPlan.calendarEvent.id=:eventId",
      "actionPlan.calendarEvent.calendarId=:calendarId","actionPlan.knownCalendarAliasesComplete=:ready",
      "size(actionPlan.projectCommentIds)=:projectCommentCount","size(actionPlan.comments)=:commentCount",
      "size(inventory)=:inventoryCount","updatedAt=:updatedAt","attribute_not_exists(recovery)",
      "attribute_not_exists(postWriteCompletion)",
    ];
    if(progress.finalCommentIndex===undefined)conditions.push("attribute_not_exists(lifecycle.#progress.#finalCommentIndex)");
    else {values[":finalCommentIndex"]=progress.finalCommentIndex;conditions.push("lifecycle.#progress.#finalCommentIndex=:finalCommentIndex");}
    lifecycle.mappingIds.forEach((mappingId,index)=>{
      values[":mapping"+index]=mappingId;conditions.push("contains(lifecycle.#mappingIds, :mapping"+index+")");
    });
    enabledIds.forEach((mappingId,index)=>{
      values[":enabled"+index]=mappingId;conditions.push("contains(lifecycle.#enabledMappingIds, :enabled"+index+")");
    });
    projectCommentIds.forEach((commentId,index)=>{
      values[":projectComment"+index]=commentId;conditions.push("contains(actionPlan.projectCommentIds, :projectComment"+index+")");
    });
    const items:any[]=[
      {Update:{TableName:table(),Key:operationKey(id),
        UpdateExpression:"SET #status=:succeeded, postWriteCompletion=:completion, updatedAt=:completedAt REMOVE #target, #selectedActions, #previewFingerprint, #providerSnapshotFingerprint, #confirmationFingerprint, #confirmationId, #providerDeletionReady, #inventory, #actionPlan, #lifecycle, #recovery, #postwriteReview, #requestId, #result, #error",
        ConditionExpression:conditions.join(" AND "),ExpressionAttributeNames:names,
        ExpressionAttributeValues:{...values,":completion":completion,":completedAt":completion.completedAt}}},
      {Delete:{TableName:table(),Key:erasureConfirmationKey(id),
        ConditionExpression:"#status=:consumed AND operationId=:id AND confirmationId=:confirmationId AND consumedBy=:id AND previewFingerprint=:fingerprint",
        ExpressionAttributeNames:{"#status":"status"},
        ExpressionAttributeValues:{":consumed":"consumed",":id":id,":confirmationId":operation.confirmationId,
          ":fingerprint":operation.previewFingerprint}}},
      // Invalidate any unconsumed pre-write or legacy post-write review tokens
      // for this operation. Neither token can be reused after the terminal CAS.
      {Delete:{TableName:table(),Key:confirmationKey(id)}},
      {Delete:{TableName:table(),Key:legacyPostwriteReviewTokenKey(id)}},
      {Delete:{TableName:table(),Key:profileKey(operation.profile,"FENCE"),
        ConditionExpression:"operationId=:id AND #state=:active",
        ExpressionAttributeNames:{"#state":"state"},
        ExpressionAttributeValues:{":id":id,":active":"active"}}},
      {ConditionCheck:{TableName:table(),Key:profileKey(operation.profile,"EPOCH"),
        ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":inspection.preview.epoch}}},
    ];
    if(inspection.hasJournal)items.push({Delete:{TableName:table(),Key:profileKey(operation.profile,"JOURNAL"),
      ConditionExpression:"operationId=:id",ExpressionAttributeValues:{":id":id}}});
    else items.push({ConditionCheck:{TableName:table(),Key:profileKey(operation.profile,"JOURNAL"),
      ConditionExpression:"attribute_not_exists(pk)"}});
    try {
      await this.db.send(new TransactWriteCommand({TransactItems:items}));
    } catch(error) {
      try {
        if(await this.verifyPostWriteCompletion(id,operation.profile,inspection.preview.epoch!))
          return {status:"completed",blockers:[]};
      } catch { /* A failed readback is not proof of a committed release. */ }
      if(["TransactionCanceledException","ConditionalCheckFailedException"].includes((error as {name?:string})?.name||""))
        return {status:"blocked",blockers:["Final completion conditions changed; the operation-owned fence remains protected. Re-inspect before retrying."]};
      throw error;
    }
    return {status:"completed",blockers:[]};
  }

  private async verifyPostWriteCompletion(id:string,profile:ErasureOperation["profile"],epoch:number):Promise<boolean> {
    const [operation,confirmation,recoveryToken,legacyPostwriteToken,control]=await Promise.all([
      this.db.send(new GetCommand({TableName:table(),Key:operationKey(id),ConsistentRead:true})),
      this.db.send(new GetCommand({TableName:table(),Key:erasureConfirmationKey(id),ConsistentRead:true})),
      this.db.send(new GetCommand({TableName:table(),Key:confirmationKey(id),ConsistentRead:true})),
      this.db.send(new GetCommand({TableName:table(),Key:legacyPostwriteReviewTokenKey(id),ConsistentRead:true})),
      readControl(this.db,profile),
    ]);
    const terminal=operation.Item as ErasureOperation|undefined;
    const receipt=terminal?.postWriteCompletion;
    const originalFenceReleased=!control.fence
      ||(typeof control.fence.operationId==="string"&&control.fence.operationId!==id);
    const originalJournalReleased=!control.journal
      ||(typeof control.journal.operationId==="string"&&control.journal.operationId!==id);
    return Boolean(terminal?.operationId===id&&terminal.profile===profile&&terminal.status==="succeeded"
      &&receipt?.mode==="known_identity_post_write"&&receipt.status==="completed"
      &&receipt.epoch===epoch&&Number.isFinite(Date.parse(receipt.completedAt))
      &&receipt.tombstoneRetained===true&&receipt.providerDeletesReplayed===false
      &&!terminal.target&&!terminal.selectedActions&&!terminal.actionPlan&&!terminal.inventory
      &&!terminal.previewFingerprint&&!terminal.providerSnapshotFingerprint
      &&!terminal.confirmationFingerprint&&!terminal.confirmationId&&!terminal.lifecycle
      &&!terminal.recovery&&!terminal.postwriteReview&&!terminal.requestId&&!terminal.result&&!terminal.error
      &&!confirmation.Item&&!recoveryToken.Item&&!legacyPostwriteToken.Item
      &&originalFenceReleased&&originalJournalReleased
      &&typeof control.epoch==="number"&&control.epoch>=epoch);
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

  async issueConfirmation(id:string,operator:string,
    mode:GuardedRecoveryMode="strict_pre_write"):Promise<{preview:RecoveryPreview;confirmationId:string;expiresAt:number;mode:GuardedRecoveryMode}> {
    if(!["strict_pre_write","calendar_drift_cancel"].includes(mode))throw Object.assign(new Error("Invalid recovery mode"),{status:400});
    const inspected=await this.inspect(id);
    const eligible=mode==="strict_pre_write"?inspected.preview.allowed
      :inspected.preview.calendarDriftReview?.candidateForSeparateApproval===true
        &&inspected.preview.classification==="partial_or_ambiguous"
        &&inspected.preview.blockers.length===1
        &&inspected.preview.blockers[0]==="Partial or ambiguous provider/record deletion requires a separately reviewed reconciliation";
    if(!eligible)throw Object.assign(new Error("Recovery is blocked; inspect safety evidence"),{status:409});
    const confirmationId=this.newToken(),expiresAt=Date.now()+5*60_000;
    // DynamoDB TTL requires epoch *seconds*; the UI/action-time clock uses milliseconds.
    await this.db.send(new PutCommand({TableName:table(),Item:{
      ...confirmationKey(id),operationId:id,profile:inspected.operation.profile,operator,
      confirmationId,inspectedFingerprint:inspected.fingerprint,mode,
      expiresAt:Math.ceil(expiresAt/1000),expiresAtMs:expiresAt,status:"issued",
      createdAt:new Date().toISOString(),
    },ConditionExpression:"attribute_not_exists(pk) OR expiresAt < :now",
      ExpressionAttributeValues:{":now":Math.floor(Date.now()/1000)}}));
    return {preview:inspected.preview,confirmationId,expiresAt,mode};
  }

  async apply(id:string,confirmationId:string,operator:string,
    mode:GuardedRecoveryMode="strict_pre_write"):Promise<void> {
    if(!idPattern.test(id)||typeof confirmationId!=="string"||confirmationId.length>256)
      throw Object.assign(new Error("Invalid recovery confirmation"),{status:400});
    const issued=(await this.db.send(new GetCommand({TableName:table(),Key:confirmationKey(id),ConsistentRead:true}))).Item;
    if(!issued||issued.status!=="issued"||issued.operationId!==id||issued.operator!==operator
      ||issued.confirmationId!==confirmationId||(issued.mode||"strict_pre_write")!==mode
      ||typeof issued.expiresAtMs!=="number"||issued.expiresAtMs<=Date.now())
      throw Object.assign(new Error("Recovery confirmation is expired, changed, or consumed"),{status:409});
    const current=await this.inspect(id);
    const eligible=mode==="strict_pre_write"?current.preview.allowed
      :current.preview.calendarDriftReview?.candidateForSeparateApproval===true
        &&current.preview.classification==="partial_or_ambiguous"
        &&current.preview.blockers.length===1
        &&current.preview.blockers[0]==="Partial or ambiguous provider/record deletion requires a separately reviewed reconciliation";
    if(!eligible||current.fingerprint!==issued.inspectedFingerprint||!current.preview.epoch)
      throw Object.assign(new Error("Safety evidence drifted; obtain a new recovery preview"),{status:409});
    const event=mode==="calendar_drift_cancel"?current.snapshot.actionPlan.calendarEvent:undefined;
    if(mode==="calendar_drift_cancel"&&(!event||!/^[0-9a-f]{64}$/.test(event.digest)
      ||!event.etag))throw Object.assign(new Error("Current Calendar revision cannot be securely bound"),{status:409});
    const now=Date.now();
    const recovery:RecoveryState={status:"queued",mode,fingerprint:current.fingerprint,
      ...(event?{calendarDigest:event.digest,calendarEtag:event.etag}:{}),
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
        ConditionExpression:"#status=:issued AND #operator=:operator AND confirmationId=:token AND inspectedFingerprint=:digest AND expiresAtMs>:time",
        ExpressionAttributeNames:{"#status":"status","#operator":"operator"},
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
    const targetOnlySnapshot=recovery.mode==="calendar_drift_cancel"
      &&initialProjectCommentAttempt(op,true)&&Boolean(this.adapters.readKnownTargetSnapshot);
    const readSnapshot=targetOnlySnapshot
      ?this.adapters.readKnownTargetSnapshot!.bind(this.adapters):this.adapters.readSnapshot.bind(this.adapters);
    const [live,states,snapshot]=await Promise.all([
      this.adapters.listWorkerMappings(),this.adapters.mappingStates(original),readSnapshot(op)]);
    if(live.length!==original.length||new Set(live.map(x=>x.id)).size!==original.length
      ||live.some(x=>!original.includes(x.id)||!x.eventSourceArn.includes(":sqs:"))
      ||states.length!==original.length||new Set(states.map(x=>x.id)).size!==original.length
      ||states.some(x=>!original.includes(x.id)
        ||!["Enabled","Disabled","Enabling"].includes(x.state)))
      return {safe:false,mappings:[]};
    const mapped=expectedMappingStates(op,states);
    if(mapped.some(x=>!x.originallyEnabled&&x.state!=="Disabled"))return {safe:false,mappings:mapped};
    // All restorations are pre-deletion only. For explicitly approved Calendar
    // drift cancellation, bind the current event revision from the single-use
    // confirmation and check the unchanged task, project comments, aliases,
    // strongly-consistent state and original fence every worker step.
    // The automatic watchdog can ONLY request strict_pre_write mode.
    if(recovery.mode==="calendar_drift_cancel"){
      const checks=readOnlyRecoveryEvidenceChecks(op,snapshot);
      const current=snapshot.actionPlan.calendarEvent;
      const safe=calendarOnlyPreWriteDriftCandidate(op,snapshot,checks,[],mapped,
        {duringRestore:true,targetOnlySnapshot})
        &&typeof recovery.calendarDigest==="string"
        &&current?.digest===recovery.calendarDigest
        &&typeof recovery.calendarEtag==="string"
        &&current?.etag===recovery.calendarEtag;
      return {safe,mappings:mapped};
    }
    // The cross-profile audit digest deliberately differs from the immutable
    // target-only preview hash. Compare like-for-like, as operator inspection does.
    const baseline=snapshot.crossProfileEvidence
      ?snapshot.primaryProviderSnapshotFingerprint:snapshot.providerSnapshotFingerprint;
    const unchanged=snapshot.blockers.length===0
      &&erasurePreviewFingerprint(snapshot)===snapshot.previewFingerprint
      &&recoveryMode(op,snapshot)==="pre_write"
      &&baseline===op.providerSnapshotFingerprint
      &&erasurePreviewFingerprint({...snapshot,providerSnapshotFingerprint:baseline})===op.previewFingerprint;
    return {safe:unchanged,mappings:mapped};
  }
}
