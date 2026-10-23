import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { reconciliationSummary, StateRepository } from "./repository.js";
import { ReviewEngine } from "./review-engine.js";
import { ReviewStore } from "./review-store.js";
import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { clearDeadLetterMessagesForProfile } from "./dead-letter-queue.js";
import { enqueueErasureOperation } from "./erasure-queue.js";
import { ERASURE_REVIEW_REQUIRED_MESSAGE, ErasureOperationStore } from "./erasure-executor.js";
import type { Delivery, Profile } from "./types.js";
import type { ReconciliationState } from "./repository.js";
import { REVIEW_PROFILES, operationHasWriteEvidence, type RepairIntent, type ReviewActor, type Side } from "./review-types.js";

const REVIEW_ORIGIN = "https://calendar-sync.alf-broadcast.co.uk";
type Claims = { email?: unknown; sub?: unknown; aud?: unknown };
let remoteKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

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
  remoteKeys ||= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
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
  if (!["flatten","link","transfer","separate","create","exclude","decision","verify","move"].includes(String(body.action))) fail(400,"Invalid repair action");
  if (!["none","todoist","calendar"].includes(String(body.winner))) fail(400,"Invalid field winner");
  if (!["occurrence","series","future"].includes(String(body.scope))) fail(400,"Invalid recurrence scope");
  if (body.owner !== undefined && !["todoist","calendar"].includes(String(body.owner))) fail(400,"Invalid recurrence owner");
  const itemId = (value:unknown):string|undefined => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f]/.test(value)) fail(400,"Invalid provider item ID");
    return value;
  };
  if (body.leftovers !== undefined && (!body.leftovers || typeof body.leftovers !== "object" || Array.isArray(body.leftovers))) fail(400, "Invalid leftover dispositions");
  const leftovers: Record<string,"exclude"|"create"|"unchanged"|"retain-unlinked"> = {};
  for (const [key,value] of Object.entries((body.leftovers || {}) as Record<string,unknown>)) {
    if (!/^(home|antonio|work):(todoist|calendar):.{1,1024}$/.test(key) || !["exclude","create","unchanged","retain-unlinked"].includes(String(value))) fail(400,"Invalid leftover disposition");
    leftovers[key] = value as "exclude"|"create"|"unchanged"|"retain-unlinked";
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

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  try {
    const path = event.rawPath || "/";
    if (!path.startsWith("/review/api/")) return response(404,{error:"not_found"});
    const method = event.requestContext.http.method;
    if (!["GET","POST"].includes(method)) return response(405,{error:"method_not_allowed"});
    const segments = path.slice("/review/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
    const body = method === "POST" ? bodyJson(event) : undefined;
    const actor = await authenticate(event, method === "POST");
    const store = new ReviewStore();

    if ((method === "GET" && segments[0] === "erasure-operations" && segments.length === 2)
      || (method === "POST" && segments[0] === "erasure-operations" && segments[2] === "start" && segments.length === 3)) {
      const operation = await new ErasureOperationStore().get(segments[1]);
      if (!operation) return response(404,{error:"erasure_operation_not_found"});
      if (method === "GET") return response(200,{operation:{operationId:operation.operationId,status:operation.status,
        phase:operation.lifecycle?.phase,nextRunAt:operation.lifecycle?.nextRunAt,
        ...(operation.status==="review_required"?{operatorRecoveryRequired:true,
          message:ERASURE_REVIEW_REQUIRED_MESSAGE}:{}),
        createdAt:operation.createdAt,updatedAt:operation.updatedAt}});
      if (Object.keys(body || {}).length) fail(400,"Erasure start accepts no request fields");
      if (operation.status === "review_required") fail(409,"Operator break-glass recovery is required before service admission or a fresh preview can resume");
      if (operation.lifecycle?.phase === "ready_for_delete") fail(409,"Fencing is complete; provider deletion requires the separate confirmed deletion workflow");
      if (!["previewed","queued","fencing","deleting","verifying"].includes(operation.status))
        fail(409,"This erasure operation cannot be started or resumed");
      if (operation.status === "previewed") {
        const erasureStore=new ErasureOperationStore();
        try { await erasureStore.transition(operation.operationId,"previewed","queued"); }
        catch {
          const latest=await erasureStore.get(operation.operationId);
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

    if (method === "GET" && segments[0] === "cases" && segments.length === 1) {
      const selected = event.queryStringParameters?.profile;
      const profiles = selected && selected !== "all" ? [profile(selected)] : REVIEW_PROFILES;
      const history = event.queryStringParameters?.history === "true";
      const results = await Promise.all(profiles.map(async item => ({ profile:item, ...(await store.listCases(item,undefined,history)) })));
      const items = results.flatMap(result=>result.items).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return response(200,{items});
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
        const snapshots = await new ReviewEngine(store).collect(preview.intent,item.decision);
        return response(200,{item:{...item,taskId:preview.intent.taskId,eventId:preview.intent.eventId,
          repairContext:{operationId:operation.id,status:operation.status,itemPlan:preview.itemPlan}},snapshots});
      }
      const intent: RepairIntent = { caseId:item.id, profile:item.profile, action:item.decision?"decision":"link",
        taskId:item.taskId || (typeof item.decision?.context?.providerTaskId === "string" ? item.decision.context.providerTaskId : undefined),
        eventId:item.eventId || (typeof item.decision?.context?.providerEventId === "string" ? item.decision.context.providerEventId : undefined),
        winner:"none", scope:"occurrence", leftovers:{} };
      const snapshots = await new ReviewEngine(store).collect(intent,item.decision);
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
      return response(200,{item,snapshots,...(item.decision?.type === "operational_reconciliation_stuck"
        ? { reconciliation: { run: liveRun, relationToAlert: liveRelation, observedAt: new Date().toISOString() } } : {})});
    }
    if (method === "GET" && segments[0] === "search" && segments.length === 1) {
      const selectedProfile = profile(event.queryStringParameters?.profile || null);
      const side = event.queryStringParameters?.side;
      const query = event.queryStringParameters?.q?.trim();
      if (!query || query.length < 2 || query.length > 200 || !["todoist","calendar"].includes(side || "")) fail(400,"Choose a search phrase of 2–200 characters and a provider");
      const pair = await new ReviewEngine(store).clients(selectedProfile);
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
      const preview = await new ReviewEngine(store).preview(actor,intent);
      return response(200,{preview});
    }
    if (method === "POST" && segments[0] === "cases" && segments[2] === "affected" && segments.length === 3) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const intent = selectedIntent(body!,item.id,item.profile);
      const snapshots = await new ReviewEngine(store).collect(intent,item.decision);
      return response(200,{snapshots});
    }
    if (method === "POST" && segments[0] === "cases" && segments[2] === "dismiss" && segments.length === 3) {
      if (Object.keys(body || {}).length) fail(400,"Dismiss accepts no request fields");
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      return response(200,{item:await store.dismissCase(item.id,`Alert dismissed by ${actor.email}`)});
    }
    if (method === "POST" && segments[0] === "previews" && segments[2] === "submit" && segments.length === 3) {
      const idempotencyKey = requestHeader(event,"idempotency-key") || "";
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) fail(400,"A valid Idempotency-Key header is required");
      const preview = await store.getPreview(segments[1]);
      if (!preview) return response(404,{error:"preview_not_found"});
      assertOwned(actor.subject,preview.actor.subject);
      const operation = await store.submit(preview,actor,idempotencyKey);
      if (operation.status === "queued") {
        try { await enqueueRepair(operation.id,operation.preview.intent.profile,operation.attempt); }
        catch { return response(503,{error:"repair_enqueue_failed",message:"The repair was saved but queue delivery was not confirmed. Retry this same submission.",operation}); }
      }
      return response(operation.status === "succeeded" ? 200 : 202,{operation});
    }
    if (method === "GET" && segments[0] === "operations" && segments.length === 2) {
      const operation = await store.getOperation(segments[1]);
      if (!operation) return response(404,{error:"operation_not_found"});
      assertOwned(actor.subject,operation.actor.subject);
      return response(200,{operation});
    }
    if (method === "POST" && segments[0] === "operations" && segments[2] === "resume" && segments.length === 3) {
      const operation = await store.getOperation(segments[1]);
      if (!operation) return response(404,{error:"operation_not_found"});
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
      try { await enqueueRepair(operation.id,operation.preview.intent.profile,operation.attempt); }
      catch(error) {
        const message=error instanceof Error?error.message:String(error);
        return response(503,{error:"repair_enqueue_failed",message:`The repair remains queued, but delivery of attempt ${operation.attempt} was not confirmed. Retry this operation; completed repair steps are checkpointed.`,operation,
          queueDelivery:{enqueued:false,attempt:operation.attempt,error:message}});
      }
      return response(202,{operation,queueDelivery:{enqueued:true,attempt:operation.attempt}});
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
      let clearedDlq: Awaited<ReturnType<typeof clearDeadLetterMessagesForProfile>>;
      try {
        clearedDlq = await clearDeadLetterMessagesForProfile(selected);
      } catch (error) {
        console.error(JSON.stringify({ event:"profile_dlq_clear_failed", profile:selected, error:error instanceof Error ? error.message : String(error) }));
        return response(503,{error:"dlq_clear_failed",message:"The profile DLQ could not be cleared; reconciliation was not started."});
      }
      const state = new StateRepository();
      const result = await requestReconciliation(state,selected,"manual",enqueueDelivery,{requester:actor.email});
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
  }
}
