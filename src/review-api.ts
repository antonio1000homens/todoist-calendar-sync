import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { reconciliationSummary, StateRepository } from "./repository.js";
import { ReviewEngine } from "./review-engine.js";
import { reviewCaseEvidenceIds } from "./deleted-review-identities.js";
import { inspectRecurrenceRetirement } from "./recurrence-retirement-inspection.js";
import { previewRecurrenceRetirement } from "./recurrence-retirement-preview.js";
import { RetirementOperationService, RETIREMENT_APPROVAL_PHRASE,
  PAST_DUE_ACTIVE_TASK_APPROVAL_PHRASE } from "./recurrence-retirement-apply.js";
import { RetirementUndoService, RETIREMENT_UNDO_PHRASE } from "./recurrence-retirement-undo.js";
import { RetirementIncidentCleanupService } from "./recurrence-retirement-cleanup.js";
import { deletedRecurrenceStatus } from "./deletion-review-state.js";
import { assessUnmappedConflictDeletion } from "./unmapped-deletion-assessment.js";
import { assessOrphanReadiness } from "./orphan-readiness.js";
import { OrphanApprovalService } from "./orphan-approval.js";
import { ReviewStore } from "./review-store.js";
import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { clearDeadLetterMessagesForProfile } from "./dead-letter-queue.js";
import { enqueueErasureOperation, enqueueErasureRecovery } from "./erasure-queue.js";
import { ErasureRecoveryService, CALENDAR_DRIFT_CANCEL_PHRASE } from "./erasure-recovery.js";
import { recoveryAdapters } from "./erasure-recovery-adapters.js";
import { ERASURE_BACKUP_RETENTION_NOTICE, ERASURE_REVIEW_REQUIRED_MESSAGE, ErasureOperationStore } from "./erasure-executor.js";
import { buildErasurePreview } from "./erasure-preview.js";
import { acquireProfileAdmissionLease } from "./erasure-protocol.js";
import type { Delivery, Profile } from "./types.js";
import type { ReconciliationState } from "./repository.js";
import { REVIEW_PROFILES, operationHasWriteEvidence, entityKey, type EntityRef, type ReviewCase, type ReviewSnapshot, type RepairIntent, type ReviewActor, type Side } from "./review-types.js";
import { randomUUID } from "node:crypto";
import { erasureExecutionEnabled } from "./erasure-readiness.js";

const REVIEW_ORIGIN = "https://calendar-sync.alf-broadcast.co.uk";
type Claims = { email?: unknown; sub?: unknown; aud?: unknown };
let remoteKeys: ReturnType<typeof createRemoteJWKSet> | undefined;
let remoteKeysIssuer: string | undefined;

function response(statusCode: number, payload: unknown): LambdaFunctionURLResult {
  return { statusCode, headers: { "content-type":"application/json", "cache-control":"no-store", "x-content-type-options":"nosniff" }, body: JSON.stringify(payload) };
}
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function profile(value: string | null): Profile {
  if (!value || !REVIEW_PROFILES.includes(value as Profile)) fail(400, "A valid profile is required");
  return value as Profile;
}
function errorStatus(error: unknown): number { return Number((error as {status?:number})?.status) || 500; }
function requestOrigin(event: LambdaFunctionURLEvent): string | undefined {
  return Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === "origin")?.[1];
}
function requestHeader(event: LambdaFunctionURLEvent, wanted: string): string | undefined {
  return Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === wanted.toLowerCase())?.[1];
}
function bodyJson(event: LambdaFunctionURLEvent): Record<string, unknown> {
  if (!event.body || event.body.length > 64_000) fail(400, "A valid JSON request body is required");
  try {
    const parsed = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(400, "A JSON object is required");
    return parsed as Record<string, unknown>;
  } catch { return fail(400, "A valid JSON request body is required"); }
}
function accessConfig(): { issuer: string; audience: string; operators: Set<string> } {
  const issuer = process.env.CF_ACCESS_ISSUER?.replace(/\/$/, "");
  const audience = process.env.CF_ACCESS_AUDIENCE?.trim();
  const operators = new Set((process.env.REVIEW_OPERATOR_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!issuer || !audience || !operators.size) throw new Error("Cloudflare Access review authentication is not configured");
  return { issuer, audience, operators };
}
async function authenticate(event: LambdaFunctionURLEvent, requireSameOrigin: boolean): Promise<ReviewActor> {
  if (requireSameOrigin) {
    const origin = requestOrigin(event);
    try { if (!origin || new URL(origin).origin !== REVIEW_ORIGIN) fail(403, "Same-origin request required"); }
    catch (error) { if (errorStatus(error) < 500) throw error; fail(403, "Same-origin request required"); }
  }
  const assertion = requestHeader(event, "cf-access-jwt-assertion");
  if (!assertion) fail(401, "Cloudflare Access authentication required");
  const { issuer, audience, operators } = accessConfig();
  if (!remoteKeys || remoteKeysIssuer !== issuer) {
    remoteKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeysIssuer = issuer;
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, remoteKeys, { issuer, audience, algorithms: ["RS256"] }));
  } catch { fail(401, "Cloudflare Access assertion is invalid or expired"); }
  const claims = payload as Claims;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!subject || !email || !operators.has(email)) fail(403, "This Cloudflare Access identity is not an allowed review operator");
  return { subject, email };
}
function selectedIntent(body: Record<string, unknown>, caseId: string, selectedProfile: Profile): RepairIntent {
  const allowed = ["caseId","profile","action","taskId","eventId","winner","owner","scope","leftovers","decisionAction","targetProfile"];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, "Unsupported repair fields");
  if (!["flatten","todoist-only","todoist-only-delete-calendar","calendar-history-only","link","transfer","separate","create","exclude","decision","verify","move"].includes(String(body.action))) fail(400,"Invalid repair action");
  if (!["none","todoist","calendar"].includes(String(body.winner))) fail(400,"Invalid field winner");
  if (!["occurrence","series","future"].includes(String(body.scope))) fail(400,"Invalid recurrence scope");
  if (body.owner !== undefined && !["todoist","calendar"].includes(String(body.owner))) fail(400,"Invalid recurrence owner");
  const itemId = (value:unknown):string|undefined => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f]/.test(value)) fail(400,"Invalid provider item ID");
    return value;
  };
  if (body.leftovers !== undefined && (!body.leftovers || typeof body.leftovers !== "object" || Array.isArray(body.leftovers))) fail(400, "Invalid leftover dispositions");
  const leftovers: Record<string,"exclude"|"create"|"unchanged"|"retain-unlinked"|"delete"> = {};
  for (const [key,value] of Object.entries((body.leftovers || {}) as Record<string,unknown>)) {
    if (!/^(home|antonio|work):(todoist|calendar):.{1,1024}$/.test(key) || !["exclude","create","unchanged","retain-unlinked","delete"].includes(String(value))) fail(400,"Invalid leftover disposition");
    leftovers[key] = value as "exclude"|"create"|"unchanged"|"retain-unlinked"|"delete";
  }
  const decisionAction = typeof body.decisionAction === "string" ? body.decisionAction : undefined;
  const taskId = decisionAction?.startsWith("bind_task:") ? decisionAction.slice("bind_task:".length)
    : itemId(body.taskId);
  if (decisionAction && (decisionAction.length > 256 || /[\u0000-\u001f]/.test(decisionAction))) fail(400,"Invalid decision action");
  if (body.targetProfile !== undefined && !REVIEW_PROFILES.includes(body.targetProfile as Profile)) fail(400,"Invalid destination profile");
  return {
    caseId, profile:selectedProfile,
    action:body.action as RepairIntent["action"],
    taskId,
    eventId:itemId(body.eventId),
    winner:body.winner as RepairIntent["winner"],
    owner:body.owner as Side|undefined,
    scope:body.scope as RepairIntent["scope"],
    leftovers,
    decisionAction,
    targetProfile:typeof body.targetProfile === "string" ? body.targetProfile as Profile : undefined,
  };
}
function assertOwned(subject: string, owner: string): void {
  if (subject !== owner) fail(403, "This record belongs to another review operator");
}
/** Enrich read-only case snapshots with *only* identities recorded by this
 * immutable alert, never arbitrary repair-search IDs or `includedBy` links.
 * A failed candidate lookup is reported as unverified, not an absent item.
 * This helper grants no deletion eligibility or provider-write authority. */
export async function hydrateCaseOrphanEvidence(
  item: ReviewCase,
  snapshots: ReviewSnapshot[],
  readSnapshot: (ref: EntityRef) => Promise<ReviewSnapshot>,
): Promise<ReviewSnapshot[]> {
  const ids=reviewCaseEvidenceIds(item);
  const refs:EntityRef[]=[
    ...ids.taskIds.map(id=>({profile:item.profile,side:"todoist" as const,id})),
    ...ids.eventIds.map(id=>({profile:item.profile,side:"calendar" as const,id})),
  ];
  if(refs.length>20) fail(409,"The review alert references more than 20 provider identities; narrow the case before verifying an orphan");
  const found=new Map(snapshots.map(snapshot=>[entityKey(snapshot.ref),snapshot]));
  for(const ref of refs){
    const key=entityKey(ref);
    if(found.has(key))continue;
    let snapshot:ReviewSnapshot;
    try {
      snapshot=await readSnapshot(ref);
      if(snapshot.ref.profile!==item.profile||snapshot.ref.side!==ref.side||snapshot.ref.id!==ref.id)
        throw new Error("Provider snapshot identity mismatch");
    } catch {
      // An API outage, foreign ownership, or failed lookup is not a 404/410.
      snapshot={ref,object:null,lookupError:"The direct provider lookup or ownership verification failed",checkedAt:new Date().toISOString()};
    }
    found.set(key,{...snapshot,includedBy:[...(snapshot.includedBy||[]),"Exact identity recorded on selected review alert"]});
  }
  // Preserve the pre-existing affected-item ordering; append extra case
  // evidence without reshuffling repair selections or their test fixtures.
  return [...found.values()];
}
export function reconciliationAlertRelation(
  alertedGeneration: unknown, observedAt: unknown, current?: ReconciliationState,
): "unavailable" | "different_generation" | "completed_since_alert" | "failed_since_alert" | "progressed_since_alert" | "same_generation" {
  if (!current || typeof alertedGeneration !== "string") return "unavailable";
  if (current.generation !== alertedGeneration) return "different_generation";
  const alertTime = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
  if (Number.isFinite(alertTime) && !current.pending && current.lastCompletedAt
    && Date.parse(current.lastCompletedAt) > alertTime) return "completed_since_alert";
  if (Number.isFinite(alertTime) && current.lastFailedAt && Date.parse(current.lastFailedAt) > alertTime) return "failed_since_alert";
  if (Number.isFinite(alertTime) && current.lastProgressAt && Date.parse(current.lastProgressAt) > alertTime) return "progressed_since_alert";
  return "same_generation";
}
async function enqueueRepair(operationId: string, selectedProfile: Profile, attempt: number): Promise<void> {
  const delivery: Delivery = { id:`repair:${operationId}:attempt:${attempt}`, kind:"repair", profile:selectedProfile, mode:"aws",
    receivedAt:new Date().toISOString(), headers:{}, body:"", repair:{operationId} };
  await enqueueDelivery(delivery);
}

export async function handler(event: LambdaFunctionURLEvent, dependencies: {
  buildErasurePreview?: typeof buildErasurePreview;
  createErasureOperationStore?: () => ErasureOperationStore;
  createErasureRecoveryService?: () => ErasureRecoveryService;
  enqueueErasureRecovery?: typeof enqueueErasureRecovery;
  acquireWriteLease?: (selectedProfile:Profile,owner:string)=>Promise<()=>Promise<void>>;
  createReviewStore?:()=>ReviewStore;
  createOrphanApprovalService?:(store:ReviewStore)=>OrphanApprovalService;
  createReviewEngine?:(store:ReviewStore)=>ReviewEngine;
  createStateRepository?:()=>StateRepository;
  inspectRecurrenceRetirement?: typeof inspectRecurrenceRetirement;
  previewRecurrenceRetirement?: typeof previewRecurrenceRetirement;
  createRetirementOperationService?:()=>RetirementOperationService;
  createRetirementUndoService?:()=>RetirementUndoService;
  createRetirementIncidentCleanupService?:()=>RetirementIncidentCleanupService;
  clearDeadLetterMessagesForProfile?:typeof clearDeadLetterMessagesForProfile;
  requestReconciliation?:typeof requestReconciliation;
  enqueueRepair?:typeof enqueueRepair;
} = {}): Promise<LambdaFunctionURLResult> {
  const previewBuilder = dependencies.buildErasurePreview || buildErasurePreview;
  const erasureStore = () => dependencies.createErasureOperationStore?.() || new ErasureOperationStore();
  const recoveryService = () => dependencies.createErasureRecoveryService?.()
    || new ErasureRecoveryService(recoveryAdapters(false));
  const manualWriteLeases:(()=>Promise<void>)[]=[];
  try {
    const path = event.rawPath || "/";
    if (!path.startsWith("/review/api/")) return response(404,{error:"not_found"});
    const method = event.requestContext.http.method;
    if (!["GET","POST"].includes(method)) return response(405,{error:"method_not_allowed"});
    const segments = path.slice("/review/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
    const body = method === "POST" ? bodyJson(event) : undefined;
    const actor = await authenticate(event, method === "POST");
    // #287: the old global task-ID erasure flow is not a valid orphan deletion
    // workflow. Its preview/confirmation creation must be explicitly opted in
    // for legacy operator tooling; the review page can no longer reach it.
    // Keep already recorded operation status, queue handoff and break-glass
    // recovery available so an interrupted durable erasure is not stranded.
    if (method === "POST" && ((segments[0] === "erasure-previews" && segments.length === 1)
      || (segments[0] === "erasure-operations" && segments.length === 1))
      && process.env.ERASURE_LEGACY_UNSCOPED_API_ENABLED !== "true") {
      fail(410, "Unscoped item erasure is retired from review. Use the selected alert's verified-orphan workflow; existing operation status and recovery remain available.");
    }
    const store = dependencies.createReviewStore?.() || new ReviewStore();
    const orphanApproval = () => dependencies.createOrphanApprovalService?.(store)
      || new OrphanApprovalService({cases:store});
    const reviewEngine=dependencies.createReviewEngine?.(store) || new ReviewEngine(store);
    const enqueueRepairFn=dependencies.enqueueRepair || enqueueRepair;
    const admissionOwner=randomUUID();
    const writeProfiles:Profile[]=[];
    if(method==="POST") {
      if(segments[0]==="erasure-previews"&&typeof body?.profile==="string"&&REVIEW_PROFILES.includes(body.profile as Profile)) {
        writeProfiles.push(body.profile as Profile);
      } else if(segments[0]==="erasure-operations") {
        const operationStore=erasureStore();
        if(segments[2]==="start"&&segments[1]) {
          const operation=await operationStore.get(segments[1]);
          if(operation) writeProfiles.push(operation.profile);
        } else if(typeof body?.operationId==="string"&&typeof body?.confirmationId==="string") {
          const issued=await operationStore.getIssuedPreview(body.operationId,body.confirmationId);
          if(issued) writeProfiles.push(issued.profile);
        }
      } else if(segments[0]==="cases"&&segments.length>=3&&segments[1]) {
        if(segments[2]==="previews") writeProfiles.push(...REVIEW_PROFILES);
        else {
          const item=await store.getCase(segments[1]);
          if(item) writeProfiles.push(item.profile);
        }
      } else if(segments[0]==="previews"&&segments[2]==="submit"&&segments[1]) {
        const preview=await store.getPreview(segments[1]);
        if(preview) writeProfiles.push(preview.intent.profile);
      } else if(segments[0]==="operations"&&segments[2]==="resume"&&segments[1]) {
        const operation=await store.getOperation(segments[1]);
        if(operation) writeProfiles.push(operation.preview.intent.profile);
      } else if(segments[0]==="reconciliation"&&typeof body?.profile==="string"
        &&!["retirement-apply","retirement-undo-apply"].includes(segments[1])) {
        // Retirement Apply installs its OWN exclusive profile fence and waits
        // for all admission/writer leases to drain. Holding one here would
        // deadlock the drain and make a safe commit impossible.
        writeProfiles.push(profile(body.profile));
      }
      for(const selectedProfile of [...new Set(writeProfiles)]) {
        const acquire=dependencies.acquireWriteLease || acquireProfileAdmissionLease;
        manualWriteLeases.push(await acquire(selectedProfile,admissionOwner));
      }
    }
    const requireAdmissionProfile=(selectedProfile:Profile):void=>{
      if(method==="POST"&&process.env.ERASURE_PROTOCOL_VERSION==="1"&&!writeProfiles.includes(selectedProfile))
        fail(409,"The profile changed while this request was acquiring its admission lease; reload and retry");
    };

    // Rollout-gated, state-only review: never queues recovery or releases a fence.
    if(segments[0]==="erasure-postwrite-recoveries"&&segments[1]) {
      const id=segments[1],action=segments[2];
      const recovery=recoveryService();
      if(method==="GET"&&segments.length===2) {
        const assessment=await recovery.inspectPostWrite(id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-review-api",
          event:"postwrite_recovery_evidence_inspected",operationId:id,
          classification:assessment.classification,blockerCount:assessment.blockers.length}));
        return response(200,{assessment});
      }
      if(method==="POST"&&segments.length===3&&action==="review-token") {
        if(Object.keys(body||{}).length)fail(400,"Post-write review token accepts no request fields");
        const issued=await recovery.issuePostWriteReviewToken(id,actor.subject);
        return response(200,{...issued});
      }
      if(method==="POST"&&segments.length===3&&action==="acknowledge") {
        if(Object.keys(body||{}).sort().join(",")!=="confirmationId,operationId,phrase,profile"
          ||typeof body?.confirmationId!=="string"||body.operationId!==id
          ||body.phrase!=="REVIEW AND KEEP FENCED"
          ||!REVIEW_PROFILES.includes(body.profile as Profile))
          fail(400,"Post-write review requires exact operation, profile and REVIEW AND KEEP FENCED phrase");
        const reviewed=await recovery.acknowledgePostWriteReview(id,body.confirmationId,actor.subject,{
          operationId:body.operationId,profile:body.profile as Profile,phrase:body.phrase,
        });
        console.log(JSON.stringify({service:"todoist-calendar-sync-review-api",
          event:"postwrite_review_recorded_fenced",operationId:id}));
        return response(200,{review:reviewed});
      }
      return response(404,{error:"not_found"});
    }

    // Break-glass recovery is intentionally disjoint from erasure submission:
    // it cannot acquire a profile write lease while the erasure fence is active.
    if(segments[0]==="erasure-recoveries"&&segments[1]&&[2,3].includes(segments.length)) {
      const id=segments[1],action=segments[2];
      const recovery=recoveryService();
      if(method==="GET"&&segments.length===2) {
        const inspected=await recovery.inspect(id);
        console.log(JSON.stringify({service:"todoist-calendar-sync-review-api",event:"recovery_preview",
          operationId:id,allowed:inspected.preview.allowed,classification:inspected.preview.classification,
          blockers:inspected.preview.blockers.length}));
        return response(200,{preview:inspected.preview});
      }
      if(method==="GET"&&action==="status") {
        const current=await recovery.status(id);
        if(!current)return response(404,{error:"recovery_not_started"});
        return response(200,{recovery:{status:current.status,startedAt:current.startedAt,
          ...(current.lastError?{lastError:current.lastError}:{} )}});
      }
      if(method==="POST"&&action==="confirm") {
        if(Object.keys(body||{}).length)fail(400,"Recovery confirmation creation accepts no request fields");
        const issued=await recovery.issueConfirmation(id,actor.subject);
        return response(200,{...issued});
      }
      if(method==="POST"&&action==="apply") {
        if(Object.keys(body||{}).sort().join(",")!=="confirmationId,operationId,phrase,profile"
          ||typeof body?.confirmationId!=="string"||body.confirmationId.length>256
          ||body.operationId!==id||body.phrase!=="RESTORE SYNC"
          ||!REVIEW_PROFILES.includes(body.profile as Profile))
          fail(400,"Recovery requires an exact operation ID, profile, and typed RESTORE SYNC confirmation");
        const operation=await erasureStore().get(id);
        if(!operation||operation.profile!==body.profile)fail(409,"Recovery profile or operation changed");
        await recovery.apply(id,body.confirmationId,actor.subject);
        console.log(JSON.stringify({service:"todoist-calendar-sync-review-api",event:"recovery_accepted",
          operationId:id,profile:operation.profile}));
        try { await (dependencies.enqueueErasureRecovery||enqueueErasureRecovery)(id); }
        catch {return response(503,{error:"recovery_enqueue_failed",
          message:"Recovery was accepted durably but its queue send failed. Retry dispatch for the same recovery, never confirm erasure again."});}
        return response(202,{recovery:{status:"queued",operationId:id}});
      }
      if(method==="POST"&&action==="calendar-drift-confirm") {
        if(Object.keys(body||{}).length)fail(400,"Drift-cancellation confirmation accepts no request fields");
        const issued=await recovery.issueCalendarDriftCancellation(id,actor.subject);
        return response(200,{...issued});
      }
      if(method==="POST"&&action==="calendar-drift-apply") {
        if(Object.keys(body||{}).sort().join(",")!=="confirmationId,operationId,phrase,profile"
          ||typeof body?.confirmationId!=="string"||body.confirmationId.length>256
          ||body.operationId!==id||body.phrase!==CALENDAR_DRIFT_CANCEL_PHRASE
          ||!REVIEW_PROFILES.includes(body.profile as Profile))
          fail(400,"Calendar drift cancellation requires the exact operation, profile, and distinct typed phrase");
        const operation=await erasureStore().get(id);
        if(!operation||operation.profile!==body.profile)fail(409,"Recovery profile or operation changed");
        await recovery.applyCalendarDriftCancellation(id,body.confirmationId,actor.subject,{
          operationId:body.operationId,profile:body.profile as Profile,phrase:body.phrase,
        });
        console.log(JSON.stringify({service:"todoist-calendar-sync-review-api",
          event:"calendar_drift_cancellation_accepted",operationId:id,profile:operation.profile}));
        try { await (dependencies.enqueueErasureRecovery||enqueueErasureRecovery)(id); }
        catch {return response(503,{error:"recovery_enqueue_failed",
          message:"Cancellation accepted durably; retry dispatch only, never replay the erasure"});}
        return response(202,{recovery:{status:"queued",operationId:id,mode:"calendar_drift_cancel"}});
      }
      if(method==="POST"&&action==="dispatch") {
        if(Object.keys(body||{}).length)fail(400,"Recovery dispatch accepts no request fields");
        const state=await recovery.status(id);
        if(!state||!["queued","restoring","verifying"].includes(state.status))
          fail(409,"Only an accepted incomplete recovery may be dispatched");
        await (dependencies.enqueueErasureRecovery||enqueueErasureRecovery)(id);
        return response(202,{recovery:{status:state.status,operationId:id}});
      }
      return response(404,{error:"not_found"});
    }

    if ((method === "GET" && segments[0] === "erasure-operations" && segments.length === 2)
      || (method === "POST" && segments[0] === "erasure-operations" && segments[2] === "start" && segments.length === 3)) {
      const operationStore = erasureStore();
      const operation = await operationStore.get(segments[1]);
      if (!operation) return response(404,{error:"erasure_operation_not_found"});
      if(method==="POST") requireAdmissionProfile(operation.profile);
      if (method === "GET") return response(200,{operation:{operationId:operation.operationId,profile:operation.profile,status:operation.status,
        recoveryStatus:operation.recovery?.status,
        providerDeletionReady:operation.providerDeletionReady===true,
        executionEnabled:erasureExecutionEnabled(),
        queueReady:erasureExecutionEnabled()&&operation.providerDeletionReady===true,
        backupRetentionNotice:ERASURE_BACKUP_RETENTION_NOTICE,
        phase:operation.lifecycle?.phase,nextRunAt:operation.lifecycle?.nextRunAt,
        deletionProgress:operation.lifecycle?.deletionProgress?{
          stage:operation.lifecycle.deletionProgress.stage,
          commentsCompleted:operation.lifecycle.deletionProgress.commentIndex,
          stateRowsCompleted:operation.lifecycle.deletionProgress.stateIndex,
        }:undefined,
        ...(operation.lifecycle?.lastError?{lastError:operation.lifecycle.lastError}:{}),
        ...(operation.status==="review_required"?{
          operatorRecoveryRequired:operation.recovery?.status!=="completed",
          message:operation.recovery?.status==="completed"
            ?"This original erasure was stopped. Profile admission has been safely restored; the previous deletion is never resumed."
            :ERASURE_REVIEW_REQUIRED_MESSAGE}:{}),
        createdAt:operation.createdAt,updatedAt:operation.updatedAt}});
      if (Object.keys(body || {}).length) fail(400,"Erasure start accepts no request fields");
      if (operation.status === "review_required") fail(409,"Operator break-glass recovery is required before service admission or a fresh preview can resume");
      if (!["previewed","queued","fencing","deleting","verifying"].includes(operation.status))
        fail(409,"This erasure operation cannot be started or resumed");
      // Readiness is a hard admission gate for every start/resume request. An
      // active persisted lifecycle must not be re-enqueued after readiness is
      // revoked; the worker's own guard is only a second line of defense.
      if (!erasureExecutionEnabled())
        fail(409,"Erasure execution is disabled by deployment configuration; this operation cannot be queued or resumed");
      if (operation.providerDeletionReady !== true)
        fail(409,"The provider deletion and postflight workflow is not available; this operation cannot be queued or resumed");
      if (operation.status === "previewed") {
        try { await operationStore.transition(operation.operationId,"previewed","queued"); }
        catch {
          const latest=await operationStore.get(operation.operationId);
          if (latest?.status !== "queued") throw new Error("Erasure operation changed while it was being started; refresh before retrying");
        }
      }
      try {
        await enqueueErasureOperation(operation.operationId,operation.lifecycle?.nextRunAt);
      } catch {
        return response(503,{error:"erasure_enqueue_failed",message:"The confirmed operation remains durable. Retry this same start request."});
      }
      return response(202,{operation:{operationId:operation.operationId,status:operation.status === "previewed"?"queued":operation.status,
        phase:operation.lifecycle?.phase,nextRunAt:operation.lifecycle?.nextRunAt}});
    }

    if (method === "POST" && segments[0] === "erasure-previews" && segments.length === 1) {
      const allowed = ["profile","taskId","eventId","deleteCalendar"];
      if (Object.keys(body || {}).some(key => !allowed.includes(key))
        || typeof body?.profile !== "string" || typeof body?.taskId !== "string"
        || (body?.eventId !== undefined && typeof body.eventId !== "string")
        || typeof body?.deleteCalendar !== "boolean") fail(400,"Exact erasure target and action selections are required");
      const preview = await previewBuilder({profile:profile(body.profile),taskId:body.taskId,
        ...(typeof body.eventId === "string" ? {eventId:body.eventId} : {}),deleteCalendar:body.deleteCalendar},
        {allowLeaseOwner:admissionOwner});
      if (!preview.blockers.length) {
        let issued;
        try { issued = await erasureStore().issueConfirmation(preview); }
        catch (error) {
          if (error instanceof Error && error.message.includes("too large for one durable operation")) fail(413,error.message);
          throw error;
        }
        const {actionPlan,...safePreview}=preview;
        return response(200,{preview:{...safePreview,executionEnabled:erasureExecutionEnabled(),
          confirmation:{confirmationId:issued.confirmationId,expiresAt:issued.expiresAt}}});
      }
      const {actionPlan,...safePreview}=preview;
      return response(200,{preview:{...safePreview,executionEnabled:erasureExecutionEnabled()}});
    }

    if (method === "POST" && segments[0] === "erasure-operations" && segments.length === 1) {
      if (Object.keys(body || {}).sort().join(",") !== "confirmationId,operationId"
        || typeof body?.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.operationId)
        || typeof body?.confirmationId !== "string" || body.confirmationId.length > 256)
        fail(400,"A preview operation ID and its single-use confirmation are required");
      const operationStore = erasureStore();
      const issued = await operationStore.getIssuedPreview(body.operationId,body.confirmationId);
      if (!issued) fail(409,"The preview confirmation is missing, expired, or already used; request a fresh preview");
      requireAdmissionProfile(issued.profile);
      const current = await previewBuilder({profile:issued.profile,taskId:issued.target.taskId,
        ...(issued.target.eventId ? {eventId:issued.target.eventId} : {}),deleteCalendar:issued.selectedActions.deleteCalendar},
        {newOperationId:()=>body!.operationId as string,ignoreOperationId:body.operationId,allowLeaseOwner:admissionOwner});
      if (current.blockers.length || current.previewFingerprint !== issued.previewFingerprint)
        fail(409,"The exact provider/state inventory changed or became unsafe; request a fresh preview");
      const now=new Date().toISOString();
      // A previously issued preview (or a previously persisted preview-only
      // operation) is never silently upgraded by flipping the deployment flag.
      const providerDeletionReady=erasureExecutionEnabled()&&issued.executionReadyAtIssue===true;
      const operation = {operationId:current.operationId,profile:current.profile,target:current.target,
        selectedActions:current.selectedActions,providerSnapshotFingerprint:current.providerSnapshotFingerprint,
        inventory:current.inventory,actionPlan:issued.actionPlan,previewFingerprint:current.previewFingerprint,
        providerDeletionReady,
        confirmationId:body.confirmationId,confirmationFingerprint:current.previewFingerprint,
        status:"previewed" as const,createdAt:now,updatedAt:now};
      try { await operationStore.create(operation); }
      catch { fail(409,"The confirmation expired, was already used, or the operation changed; request a fresh preview"); }
      return response(201,{operation:{operationId:operation.operationId,profile:operation.profile,status:operation.status,
        previewFingerprint:operation.previewFingerprint,inventoryCount:operation.inventory.length,
        queueReady:providerDeletionReady,providerDeletionReady,
        backupRetentionNotice:ERASURE_BACKUP_RETENTION_NOTICE}});
    }

    if (method === "GET" && segments[0] === "cases" && segments.length === 1) {
      const selected = event.queryStringParameters?.profile;
      const profiles = selected && selected !== "all" ? [profile(selected)] : REVIEW_PROFILES;
      const history = event.queryStringParameters?.history === "true";
      const results = await Promise.all(profiles.map(async item => ({ profile:item, ...(await store.listCases(item,undefined,history)) })));
      const items = results.flatMap(result=>result.items).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return response(200,{items});
    }
    // #287: explicit on-demand server diagnostic. Never returns a deletion token,
    // never accepts arbitrary IDs, and makes no provider or DynamoDB writes.
    if (method === "GET" && segments[0] === "cases" && segments[2] === "orphan-readiness" && segments.length === 3) {
      if (Object.keys(event.queryStringParameters || {}).length) fail(400,"Orphan readiness accepts no IDs or other query parameters");
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      if (item.status !== "open" || item.operationId)
        return response(200,{readiness:assessOrphanReadiness(item,[])});
      const intent:RepairIntent = {caseId:item.id,profile:item.profile,action:item.decision?"decision":"link",
        taskId:item.taskId || (typeof item.decision?.context?.providerTaskId==="string" ? item.decision.context.providerTaskId : undefined),
        eventId:item.eventId || (typeof item.decision?.context?.providerEventId==="string" ? item.decision.context.providerEventId : undefined),
        winner:"none",scope:"occurrence",leftovers:{}};
      let snapshots:ReviewSnapshot[];
      try {
        snapshots = await hydrateCaseOrphanEvidence(item,
          await reviewEngine.collect(intent,item.decision),ref=>reviewEngine.snapshot(ref));
      } catch {
        // A failed provider or state read must never be treated as an absent
        // counterpart. Fail the diagnostic rather than returning eligibility.
        fail(503,"A direct provider or ownership lookup failed; orphan readiness cannot be established");
      }
      return response(200,{readiness:assessOrphanReadiness(item,snapshots)});
    }
    // #287: isolated, selected-alert approval path. No provider DELETE, worker
    // dispatch or deletion-capable token is exposed by either POST endpoint.
    // Confirmation is separately default-deny until the full worker/replay
    // barrier integration has passed destructive acceptance.
    if (segments[0] === "cases" && segments.length === 3
      && ["orphan-previews","orphan-confirmations"].includes(segments[2]) && method === "POST") {
      if(Object.keys(event.queryStringParameters || {}).length)
        fail(400,"Orphan approval does not accept query parameters");
      const item=await store.getCase(segments[1]);
      if(!item)return response(404,{error:"conflict_not_found"});
      requireAdmissionProfile(item.profile);
      if(segments[2]==="orphan-previews") {
        if(Object.keys(body||{}).sort().join(",")!=="id,side"
          || !["todoist","calendar"].includes(String(body?.side))
          || typeof body?.id!=="string")
          fail(400,"Preview requires exactly one recorded provider side and ID");
        const preview=await orphanApproval().issue(item.id,body!.side as Side,body!.id as string,actor);
        return response(200,{preview});
      }
      if(Object.keys(body||{}).sort().join(",")!=="confirmationId,exactId,phrase,previewId"
        || ["confirmationId","exactId","phrase","previewId"].some(key=>typeof body?.[key]!=="string"))
        fail(400,"Confirmation requires the exact preview, nonce, ID and typed phrase");
      if(process.env.ORPHAN_APPROVAL_CONFIRMATION_ENABLED!=="true")
        fail(409,"Orphan confirmation recording is disabled until production safety integration has passed review");
      const operation=await orphanApproval().confirm(item.id,{
        previewId:body!.previewId as string,confirmationId:body!.confirmationId as string,
        exactId:body!.exactId as string,phrase:body!.phrase as string,
      },actor);
      return response(201,{operation});
    }
    // Operator-scoped, read-only status for a confirmed but un-dispatched
    // operation. An operation ID from another case is never sufficient.
    if (segments[0]==="cases" && segments[2]==="orphan-operations"
      && segments.length===4 && method==="GET") {
      if(Object.keys(event.queryStringParameters || {}).length)
        fail(400,"Orphan operation status accepts no query parameters");
      const operation=await orphanApproval().status(segments[1],segments[3],actor);
      return response(200,{operation});
    }
    if (method === "GET" && segments[0] === "cases" && segments.length === 2) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const repairOperationId = item.decision?.type === "operational_dlq" && item.decision.context?.kind === "repair"
        ? item.decision.context.repairOperationId : undefined;
      if (item.decision?.type === "operational_dlq" && item.decision.context?.kind === "repair") {
        if (typeof repairOperationId !== "string" || !repairOperationId) fail(409,"Repair operation context is unavailable; provider items cannot be safely hydrated");
        const operation = await store.getOperation(repairOperationId);
        const preview = operation?.preview;
        if (!operation || !preview || operation.id !== repairOperationId || operation.preview.id !== preview.id
          || preview.intent.profile !== item.profile || preview.intent.caseId !== item.id
          || (operation.status !== "failed" && operation.status !== "needs_review")) {
          fail(409,"Repair operation does not match this incident; provider items cannot be safely hydrated");
        }
        const snapshots = await hydrateCaseOrphanEvidence(item,
          await reviewEngine.collect(preview.intent,item.decision),ref=>reviewEngine.snapshot(ref));
        return response(200,{item:{...item,taskId:preview.intent.taskId,eventId:preview.intent.eventId,
          repairContext:{operationId:operation.id,status:operation.status,itemPlan:preview.itemPlan}},snapshots});
      }
      const intent: RepairIntent = { caseId:item.id, profile:item.profile, action:item.decision?"decision":"link",
        taskId:item.taskId || (typeof item.decision?.context?.providerTaskId === "string" ? item.decision.context.providerTaskId : undefined),
        eventId:item.eventId || (typeof item.decision?.context?.providerEventId === "string" ? item.decision.context.providerEventId : undefined),
        winner:"none", scope:"occurrence", leftovers:{} };
      const snapshots = await hydrateCaseOrphanEvidence(item,
        await reviewEngine.collect(intent,item.decision),ref=>reviewEngine.snapshot(ref));
      const deletionCleanup = await deletedRecurrenceStatus(item, snapshots,
        (profile, seriesId) => reviewEngine.state.getRecurrenceLink(profile, seriesId));
      const unmappedDeletion = assessUnmappedConflictDeletion(item,snapshots);
      const reconciliation = item.decision?.type === "operational_reconciliation_stuck"
        ? await new StateRepository().getReconciliationState(item.profile) : undefined;
      const alertedGeneration = item.reconciliationGeneration || item.decision?.context?.reconciliationGeneration;
      const observedAt = item.decision?.context?.observedAt;
      const liveRelation = reconciliationAlertRelation(alertedGeneration, observedAt, reconciliation);
      const liveRun = reconciliation ? {
        generation: reconciliation.generation, pending: reconciliation.pending, status: reconciliation.status,
        requestedAt: reconciliation.requestedAt, lastEnqueuedAt: reconciliation.lastEnqueuedAt,
        lastStartedAt: reconciliation.lastStartedAt, lastProgressAt: reconciliation.lastProgressAt,
        lastCompletedAt: reconciliation.lastCompletedAt, lastFailedAt: reconciliation.lastFailedAt,
        queueState: reconciliation.queueState, lastDeliveryId: reconciliation.lastDeliveryId,
        lastStartedDeliveryId: reconciliation.lastStartedDeliveryId,
        progressCheckpoint: reconciliation.progressCheckpoint, nextContinuation: reconciliation.nextContinuation,
        result: reconciliation.result, failureContext: reconciliation.failureContext,
      } : undefined;
      return response(200,{item,snapshots,deletionCleanup,unmappedDeletion,...(item.decision?.type === "operational_reconciliation_stuck"
        ? { reconciliation: { run: liveRun, relationToAlert: liveRelation, observedAt: new Date().toISOString() } } : {})});
    }
    if (method === "GET" && segments[0] === "search" && segments.length === 1) {
      const selectedProfile = profile(event.queryStringParameters?.profile || null);
      const side = event.queryStringParameters?.side;
      const query = event.queryStringParameters?.q?.trim();
      if (!query || query.length < 2 || query.length > 200 || !["todoist","calendar"].includes(side || "")) fail(400,"Choose a search phrase of 2–200 characters and a provider");
      const pair = await reviewEngine.clients(selectedProfile);
      const needle = query.toLocaleLowerCase();
      if (side === "todoist") {
        const items = (await pair.todoist.listTasks()).filter(item => `${item.content} ${item.description || ""}`.toLocaleLowerCase().includes(needle)).slice(0,40)
          .map(item=>({id:item.id,title:item.content,description:item.description,due:item.due,is_completed:item.is_completed,is_deleted:item.is_deleted,url:`https://app.todoist.com/app/task/${item.id}`}));
        return response(200,{items});
      }
      const items = (await pair.calendar.listDelta()).items.filter(item => `${item.summary || ""} ${item.description || ""}`.toLocaleLowerCase().includes(needle)).slice(0,40)
        .map(item=>({id:item.id,title:item.summary,summary:item.summary,description:item.description,start:item.start,end:item.end,recurrence:item.recurrence,recurringEventId:item.recurringEventId,originalStartTime:item.originalStartTime,url:item.htmlLink,status:item.status}));
      return response(200,{items});
    }
    if (method === "POST" && segments[0] === "cases" && segments[2] === "previews" && segments.length === 3) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const intent = selectedIntent(body!,item.id,item.profile);
      const preview = await reviewEngine.preview(actor,intent);
      return response(200,{preview});
    }
    // Read-only recheck for an unselected repair action. Do not manufacture
    // a mutating intent or call the preview/apply pipeline.
    if (method === "GET" && segments[0] === "cases" && segments[2] === "affected" && segments.length === 3) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const query = event.queryStringParameters || {};
      if (Object.keys(query).some(key => !["taskId","eventId"].includes(key)))
        fail(400,"Unsupported recheck parameters");
      const checkedId = (value: string | undefined): string | undefined => {
        if (!value) return undefined;
        if (value.length > 1024 || [...value].some(char => char.charCodeAt(0) < 32))
          fail(400,"Invalid provider item ID");
        return value;
      };
      const selectedTaskId = checkedId(query.taskId) || undefined;
      const selectedEventId = checkedId(query.eventId) || undefined;
      const intent: RepairIntent = {caseId:item.id,profile:item.profile,action:"link",
        taskId:selectedTaskId,eventId:selectedEventId,winner:"none",scope:"occurrence",leftovers:{}};
      const snapshots = await hydrateCaseOrphanEvidence(item,
        await reviewEngine.collect(intent,item.decision),ref=>reviewEngine.snapshot(ref));
      const deletionCleanup = await deletedRecurrenceStatus(item, snapshots,
        (profile, seriesId) => reviewEngine.state.getRecurrenceLink(profile, seriesId));
      const unmappedDeletion = assessUnmappedConflictDeletion(item,snapshots);
      return response(200,{item,snapshots,deletionCleanup,unmappedDeletion});
    }
    if (method === "POST" && segments[0] === "cases" && segments[2] === "affected" && segments.length === 3) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const intent = selectedIntent(body!,item.id,item.profile);
      const snapshots = await hydrateCaseOrphanEvidence(item,
        await reviewEngine.collect(intent,item.decision),ref=>reviewEngine.snapshot(ref));
      return response(200,{snapshots});
    }
    if (method === "POST" && segments[0] === "cases" && segments[2] === "dismiss" && segments.length === 3) {
      if (Object.keys(body || {}).length) fail(400,"Dismiss accepts no request fields");
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      requireAdmissionProfile(item.profile);
      return response(200,{item:await store.dismissCase(item.id,`Alert dismissed by ${actor.email}`)});
    }
    if (method === "POST" && segments[0] === "previews" && segments[2] === "submit" && segments.length === 3) {
      const idempotencyKey = requestHeader(event,"idempotency-key") || "";
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) fail(400,"A valid Idempotency-Key header is required");
      const preview = await store.getPreview(segments[1]);
      if (!preview) return response(404,{error:"preview_not_found"});
      requireAdmissionProfile(preview.intent.profile);
      assertOwned(actor.subject,preview.actor.subject);
      const operation = await store.submit(preview,actor,idempotencyKey);
      if (operation.status === "queued") {
        try { await enqueueRepairFn(operation.id,operation.preview.intent.profile,operation.attempt); }
        catch { return response(503,{error:"repair_enqueue_failed",message:"The repair was saved but queue delivery was not confirmed. Retry this same submission.",operation}); }
      }
      return response(operation.status === "succeeded" ? 200 : 202,{operation});
    }
    if (method === "GET" && segments[0] === "operations" && segments.length === 2) {
      const operation = await store.getOperation(segments[1]);
      if (!operation) return response(404,{error:"operation_not_found"});
      requireAdmissionProfile(operation.preview.intent.profile);
      assertOwned(actor.subject,operation.actor.subject);
      return response(200,{operation});
    }
    if (method === "POST" && segments[0] === "operations" && segments[2] === "resume" && segments.length === 3) {
      const operation = await store.getOperation(segments[1]);
      if (!operation) return response(404,{error:"operation_not_found"});
      requireAdmissionProfile(operation.preview.intent.profile);
      assertOwned(actor.subject,operation.actor.subject);
      if (operation.abandoned) fail(409,"This unapplied repair was released; refresh affected items and create a new preview instead of resuming it");
      if (!["failed","needs_review","queued"].includes(operation.status)) fail(409,"Only queued, failed, or interrupted repairs can be resumed");
      if (operation.status !== "queued" && !operationHasWriteEvidence(operation)) fail(409,"No provider write is recorded for this repair; refresh affected items and create a new preview instead of resuming it");
      // Every explicit retry gets a new SQS deduplication ID, including a
      // queued operation whose earlier send may have been accepted but is
      // still waiting behind another delivery in this profile's FIFO group.
      operation.attempt += 1;
      operation.status = "queued";
      await store.saveOperation(operation);
      try { await enqueueRepairFn(operation.id,operation.preview.intent.profile,operation.attempt); }
      catch(error) {
        const message=error instanceof Error?error.message:String(error);
        return response(503,{error:"repair_enqueue_failed",message:`The repair remains queued, but delivery of attempt ${operation.attempt} was not confirmed. Retry this operation; completed repair steps are checkpointed.`,operation,
          queueDelivery:{enqueued:false,attempt:operation.attempt,error:message}});
      }
      return response(202,{operation,queueDelivery:{enqueued:true,attempt:operation.attempt}});
    }
    // #351: a non-actionable Run diagnostic is selectable without a ReviewCase.
    // Inspection is diagnostic-bound and read-only. It does not issue an apply
    // token or alter provider objects or state.
    if (method === "GET" && segments[0] === "reconciliation"
      && segments[1] === "retirement-inspection" && segments.length === 2) {
      const query = event.queryStringParameters || {};
      if (Object.keys(query).sort().join(",") !== "eventId,generation,profile,seriesId,taskId")
        fail(400,"Inspect requires the exact recorded profile, generation, Todoist, occurrence and series identities");
      const selected = profile(query.profile || null);
      const target = {profile:selected,generation:query.generation || "",
        taskId:query.taskId || "",eventId:query.eventId || "",seriesId:query.seriesId || ""};
      const inspection = await (dependencies.inspectRecurrenceRetirement || inspectRecurrenceRetirement)(target);
      return response(200,{inspection});
    }
    // Fresh read-only #351 preview. The returned plan is not an approval
    // token: it cannot enqueue work, authorise provider changes or mutate state.
    if (method === "GET" && segments[0] === "reconciliation"
      && segments[1] === "retirement-preview" && segments.length === 2) {
      const query = event.queryStringParameters || {};
      if (Object.keys(query).sort().join(",") !== "eventId,generation,profile,seriesId,taskId")
        fail(400,"Retirement preview requires the exact recorded profile, generation, task, occurrence and series");
      const selected = profile(query.profile || null);
      const target = {profile:selected,generation:query.generation || "",
        taskId:query.taskId || "",eventId:query.eventId || "",seriesId:query.seriesId || ""};
      return response(200,await (dependencies.previewRecurrenceRetirement || previewRecurrenceRetirement)(target));
    }
    // #351 conditional Apply is disjoint from erasure of provider objects.
    // The operator approves an exact checked version, then independently
    // confirms with a one-use secret and typed keep-provider phrase.
    if (method==="POST"&&segments[0]==="reconciliation"&&segments[1]==="retirement-approvals"
      &&segments.length===2) {
      if(Object.keys(body||{}).sort().join(",")
        !=="eventId,generation,planFingerprint,profile,seriesId,taskId")
        fail(400,"Retirement approval requires exact target identity and preview fingerprint");
      const selected=profile(typeof body?.profile==="string"?body.profile:null);
      requireAdmissionProfile(selected);
      const target={profile:selected,generation:String(body!.generation||""),
        taskId:String(body!.taskId||""),eventId:String(body!.eventId||""),
        seriesId:String(body!.seriesId||"")};
      const service=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      const result=await service.issue(target,String(body!.planFingerprint||""),actor.subject);
      return response(201,result);
    }
    if (method==="POST"&&segments[0]==="reconciliation"&&segments[1]==="retirement-apply"
      &&segments.length===2) {
      if(Object.keys(body||{}).sort().join(",")
        !=="confirmationId,operationId,phrase,profile")
        fail(400,"Apply requires exact operation, profile, token and confirmation phrase");
      const selected=profile(typeof body?.profile==="string"?body.profile:null);
      if(body!.phrase!==RETIREMENT_APPROVAL_PHRASE
        &&body!.phrase!==PAST_DUE_ACTIVE_TASK_APPROVAL_PHRASE)
        fail(400,"Retirement requires the typed confirmation phrase issued for this evidence mode");
      const service=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      const result=await service.apply(String(body!.operationId||""),
        String(body!.confirmationId||""),selected,actor.subject,String(body!.phrase));
      return response(result.status==="fencing"?202:200,{operation:result});
    }
    if(method==="GET"&&segments[0]==="reconciliation"&&segments[1]==="retirement-operations"
      &&segments.length===3) {
      const service=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      return response(200,{operation:await service.status(segments[2],actor.subject)});
    }
    // Cleanup is independently authorized for the exact completed retirement.
    // It never deletes or edits provider objects, completion history or unknown
    // review evidence. Any ownership ambiguity remains visible for review.
    if(method==="POST"&&segments[0]==="reconciliation"&&segments[1]==="retirement-cleanup"
      &&segments.length===2){
      if(Object.keys(body||{}).sort().join(",")!=="operationId,profile")
        fail(400,"Retirement cleanup requires exact operation ID and profile");
      const selected=profile(typeof body?.profile==="string"?body.profile:null);
      requireAdmissionProfile(selected);
      const service=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      const op=await service.get(String(body!.operationId||""));
      if(!op||op.profile!==selected||op.actorSubject!==actor.subject)
        fail(403,"Retirement cleanup operation or operator does not match");
      const cleanup=dependencies.createRetirementIncidentCleanupService?.()
        ||new RetirementIncidentCleanupService();
      const result=await cleanup.cleanup(op.operationId,actor.subject);
      return response(result.status==="completed"?200:409,{cleanup:result});
    }
    // Completed association retirements have a compact, non-actionable receipt
    // history separate from the live case inbox.
    if(method==="GET"&&segments[0]==="reconciliation"&&segments[1]==="retirement-history"
      &&segments.length===2){
      const query=event.queryStringParameters||{};
      if(Object.keys(query).join(",")!=="profile")fail(400,"Exactly one profile is required for retirement history");
      const selected=profile(query.profile||null);
      const service=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      return response(200,{profile:selected,operations:await service.history(selected)});
    }
    if(method==="GET"&&segments[0]==="reconciliation"&&segments[1]==="retirement-undo-inspection"
      &&segments.length===2){
      const query=event.queryStringParameters||{};
      if(Object.keys(query).join(",")!=="operationId")fail(400,"Exact retirement operation ID required");
      const service=dependencies.createRetirementUndoService?.()||new RetirementUndoService();
      return response(200,{inspection:await service.inspect(query.operationId||"",actor.subject)});
    }
    if(method==="POST"&&segments[0]==="reconciliation"&&segments[1]==="retirement-undo-approvals"
      &&segments.length===2){
      if(Object.keys(body||{}).sort().join(",")!=="fingerprint,operationId,profile")
        fail(400,"Undo approval requires exact operation ID, profile and inspected fingerprint");
      const selected=profile(typeof body?.profile==="string"?body.profile:null);
      requireAdmissionProfile(selected);
      const service=dependencies.createRetirementUndoService?.()||new RetirementUndoService();
      const opService=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      const current=await opService.get(String(body!.operationId||""));
      if(!current||current.profile!==selected)fail(409,"Undo operation profile changed");
      return response(201,await service.approveUndo(current.operationId,String(body!.fingerprint||""),actor.subject));
    }
    if(method==="POST"&&segments[0]==="reconciliation"&&segments[1]==="retirement-undo-apply"
      &&segments.length===2){
      if(Object.keys(body||{}).sort().join(",")!=="confirmationId,operationId,phrase,profile")
        fail(400,"Undo Apply requires exact operation ID, profile, token and phrase");
      const selected=profile(typeof body?.profile==="string"?body.profile:null);
      if(body!.phrase!==RETIREMENT_UNDO_PHRASE)fail(400,"Undo requires a typed re-enable confirmation");
      const service=dependencies.createRetirementUndoService?.()||new RetirementUndoService();
      const opService=dependencies.createRetirementOperationService?.()||new RetirementOperationService();
      const current=await opService.get(String(body!.operationId||""));
      if(!current||current.profile!==selected)fail(409,"Undo operation profile changed");
      const result=await service.applyUndo(current.operationId,String(body!.confirmationId||""),actor.subject,String(body!.phrase));
      return response(result.status==="fencing"?202:200,{operation:result});
    }
    if (method === "GET" && segments[0] === "reconciliation" && segments[1] === "diagnostics" && segments.length === 2) {
      const selected = profile(event.queryStringParameters?.profile || null);
      const state = new StateRepository();
      const current = await state.getReconciliationState(selected);
      const generation = event.queryStringParameters?.generation || current?.generation;
      if (!generation || !/^[A-Za-z0-9._-]{1,200}$/.test(generation)) fail(400,"A valid reconciliation generation is required");
      const rawLimit = Number(event.queryStringParameters?.limit || 50);
      if (!Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > 50) fail(400,"Diagnostic page limit must be between 1 and 50");
      const after = event.queryStringParameters?.after;
      if (after && !/^ITEM#[a-f0-9]{64}$/.test(after)) fail(400,"Invalid reconciliation diagnostic cursor");
      const result = await state.listReconciliationDiagnostics(selected,generation,rawLimit,after);
      const items = await Promise.all(result.items.map(async item => {
        if(item.taskId && item.eventId && item.seriesId && await state.isRetired({
          profile:selected,taskId:item.taskId,eventIds:[item.eventId],seriesIds:[item.seriesId]}))
          return {...item,caseStatus:"retired",reason:"association_retired_by_operator"};
        if (!item.caseId) return item;
        const currentCase = await store.getCase(item.caseId);
        return { ...item, caseStatus: currentCase?.status || item.caseStatus || "case_not_found" };
      }));
      return response(200,{profile:selected,generation,items,next:result.next});
    }
    if (method === "GET" && segments[0] === "reconciliation" && segments.length === 1) {
      const selected=profile(event.queryStringParameters?.profile || null);
      const [reconciliation, actionableCaseCount] = await Promise.all([
        new StateRepository().getReconciliationState(selected), store.countActionableCases(selected),
      ]);
      return response(200,{reconciliation, summary:reconciliationSummary(reconciliation, actionableCaseCount)});
    }
    if (method === "POST" && segments[0] === "reconciliation" && segments.length === 1) {
      const selected = profile(typeof body?.profile === "string" ? body.profile : null);
      requireAdmissionProfile(selected);
      let clearedDlq: Awaited<ReturnType<typeof clearDeadLetterMessagesForProfile>>;
      try {
        clearedDlq = await (dependencies.clearDeadLetterMessagesForProfile || clearDeadLetterMessagesForProfile)(selected);
      } catch (error) {
        console.error(JSON.stringify({ event:"profile_dlq_clear_failed", profile:selected, error:error instanceof Error ? error.message : String(error) }));
        return response(503,{error:"dlq_clear_failed",message:"The profile DLQ could not be cleared; reconciliation was not started."});
      }
      const state = dependencies.createStateRepository?.() || new StateRepository();
      const result = await (dependencies.requestReconciliation || requestReconciliation)(state,selected,"manual",enqueueDelivery,{requester:actor.email});
      const [current, actionableCaseCount] = await Promise.all([state.getReconciliationState(selected),store.countActionableCases(selected)]);
      return response(result.enqueueError?503:202,{reconciliation:result,clearedDlq,
        run:current,summary:reconciliationSummary(current,actionableCaseCount)});
    }
    return response(404,{error:"not_found"});
  } catch(error) {
    const status=errorStatus(error);
    if (status >= 500) console.error(JSON.stringify({
      service:"todoist-calendar-sync-review-api", event:"request_failed", method:event.requestContext.http.method,
      route:(event.rawPath||"/").split("/").filter(Boolean).slice(0,3).join("/"),
      error:error instanceof Error?error.message:String(error),
      stack:error instanceof Error?error.stack:undefined,
    }));
    return response(status,{error:status<500?error instanceof Error?error.message:"request_rejected":"review_api_failed"});
  } finally {
    const released=await Promise.allSettled(manualWriteLeases.reverse().map(release=>release()));
    const failed=released.find((item):item is PromiseRejectedResult=>item.status==="rejected");
    if(failed) throw failed.reason;
  }
}
