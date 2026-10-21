import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { StateRepository } from "./repository.js";
import { ReviewEngine } from "./review-engine.js";
import { ReviewStore } from "./review-store.js";
import type { Profile } from "./types.js";
import { REVIEW_PROFILES, type RepairIntent, type ReviewActor } from "./review-types.js";

const REVIEW_ORIGIN = "https://calendar-sync.alf-broadcast.co.uk";
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function response(statusCode: number, payload: unknown): LambdaFunctionURLResult {
  return { statusCode, headers: { "content-type":"application/json", "cache-control":"no-store", "x-content-type-options":"nosniff" }, body: JSON.stringify(payload) };
}
function profile(value: string | null): Profile {
  if (!value || !REVIEW_PROFILES.includes(value as Profile)) throw Object.assign(new Error("A valid profile is required"), { status:400 });
  return value as Profile;
}
function body(event: LambdaFunctionURLEvent): Record<string, unknown> {
  if (!event.body) return {};
  if (Buffer.byteLength(event.body) > 262144) throw Object.assign(new Error("Request body is too large"), { status:413 });
  const parsed = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body,"base64").toString("utf8") : event.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("A JSON object is required"), { status:400 });
  return parsed as Record<string, unknown>;
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(label + " is required"), { status:400 });
  return value.trim();
}
async function authenticate(event: LambdaFunctionURLEvent): Promise<ReviewActor> {
  const token = event.headers?.["cf-access-jwt-assertion"] || event.headers?.["Cf-Access-Jwt-Assertion"];
  const team = (process.env.CF_ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//,"").replace(/\/$/,"");
  const audience = process.env.CF_ACCESS_AUDIENCE || "";
  if (!team || !audience || !token) throw Object.assign(new Error("Review access is not configured or authorized"), { status:401 });
  jwks ??= createRemoteJWKSet(new URL("https://" + team + "/cdn-cgi/access/certs"));
  let payload;
  try { ({ payload } = await jwtVerify(token, jwks, { issuer:"https://" + team, audience, clockTolerance:5 })); }
  catch { throw Object.assign(new Error("Review access token is invalid or expired"), { status:401 }); }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  const allowed = (process.env.REVIEW_OPERATOR_EMAIL || "").toLowerCase();
  if (!email || email !== allowed || typeof payload.sub !== "string") throw Object.assign(new Error("Review access is limited to the configured operator"), { status:403 });
  return { subject:payload.sub, email };
}
function sameOrigin(event: LambdaFunctionURLEvent): void {
  const method = event.requestContext.http.method;
  if (!["POST","PUT","PATCH","DELETE"].includes(method)) return;
  const origin = event.headers?.origin || event.headers?.Origin;
  if (origin !== REVIEW_ORIGIN) throw Object.assign(new Error("Cross-origin submissions are not allowed"), { status:403 });
}
function errorStatus(error: unknown): number { return Number((error as {status?:number})?.status) || 500; }

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  try {
    const path = event.rawPath || "/";
    if (!path.startsWith("/review/api/")) return response(404,{error:"not_found"});
    sameOrigin(event);
    const actor = await authenticate(event);
    const method = event.requestContext.http.method;
    const segments = path.slice("/review/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
    const store = new ReviewStore();
    if (method === "GET" && segments[0] === "cases" && segments.length === 1) {
      const selected = event.queryStringParameters?.profile;
      const profiles = selected ? [profile(selected)] : REVIEW_PROFILES;
      const history = event.queryStringParameters?.history === "true";
      const results = await Promise.all(profiles.map(async item => ({ profile:item, ...(await store.listCases(item,undefined,history)) })));
      return response(200,{items:results.flatMap(result=>result.items),actor:actor.email});
    }
    if (method === "GET" && segments[0] === "cases" && segments.length === 2) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const intent: RepairIntent = { caseId:item.id, profile:item.profile, action:item.decision?"decision":"link", taskId:item.taskId, eventId:item.eventId,
        winner:"none", scope:"occurrence", leftovers:{} };
      const snapshots = await new ReviewEngine(store).collect(intent,item.decision);
      return response(200,{item,snapshots});
    }
    if (method === "GET" && segments[0] === "search" && segments.length === 1) {
      const selectedProfile = profile(event.queryStringParameters?.profile || null);
      const side = event.queryStringParameters?.side;
      if (side !== "todoist" && side !== "calendar") throw Object.assign(new Error("side must be todoist or calendar"),{status:400});
      const query=(event.queryStringParameters?.q||"").trim().toLocaleLowerCase();
      if (query.length<2) return response(200,{items:[]});
      const pair=await defaultProviderClientFactory(selectedProfile);
      const items = side === "todoist"
        ? (await pair.todoist.listTasks()).map(item=>({id:item.id,title:item.content,start:item.due?.date||item.due?.datetime}))
        : (await pair.calendar.listDelta()).items.map(item=>({id:item.id,title:item.summary,start:item.start?.date||item.start?.dateTime}));
      const filtered=items.filter(item=>(String(item.title || "") + " " + item.id).toLocaleLowerCase().includes(query)).slice(0,40);
      return response(200,{items:filtered});
    }
    if (method === "GET" && segments[0] === "reconciliation" && segments.length === 1) {
      const selected=profile(event.queryStringParameters?.profile || null);
      return response(200,{reconciliation:await new StateRepository().getReconciliationState(selected)});
    }
    if (method === "POST" && segments.join("/") === "previews") {
      const input=body(event), intent=input.intent as RepairIntent;
      if (!intent || typeof intent!=="object") throw Object.assign(new Error("intent is required"),{status:400});
      return response(200,{preview:await new ReviewEngine(store).preview(actor,intent)});
    }
    if (method === "POST" && segments.join("/") === "repairs") {
      const input=body(event),previewId=requiredText(input.previewId,"previewId"),idempotencyKey=requiredText(input.idempotencyKey,"idempotencyKey");
      const preview=await store.getPreview(previewId);
      if (!preview) return response(404,{error:"preview_not_found"});
      const operation=await store.submit(preview,actor,idempotencyKey);
      if (operation.status === "queued") await enqueueDelivery({id:"repair:" + operation.id,kind:"repair",profile:operation.preview.intent.profile,mode:"aws",receivedAt:new Date().toISOString(),headers:{},body:"",repair:{operationId:operation.id}});
      return response(202,{operation});
    }
    if (method === "GET" && segments[0] === "operations" && segments.length === 2) {
      const operation=await store.getOperation(segments[1]);
      if (!operation || operation.actor.subject!==actor.subject) return response(404,{error:"operation_not_found"});
      return response(200,{operation});
    }
    if (method === "POST" && segments.join("/") === "reconcile") {
      const selected=profile(requiredText(body(event).profile,"profile"));
      const reconciliation=await requestReconciliation(new StateRepository(),selected,"manual",undefined,{requester:actor.email});
      if (reconciliation.enqueueError) return response(503,{error:"reconciliation_queue_failed",detail:reconciliation.enqueueError});
      return response(202,{reconciliation});
    }
    if (method === "POST" && segments[0] === "cases" && segments[2] === "dismiss" && segments.length===3) {
      const item=await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      if (item.status === "repairing") return response(409,{error:"conflict_has_active_repair"});
      await store.updateCase(item.id,"dismissed","Alert dismissed by operator",item.operationId);
      return response(200,{dismissed:true,id:item.id});
    }
    return response(404,{error:"not_found"});
  } catch(error) {
    const status=errorStatus(error);
    return response(status,{error:status<500?error instanceof Error?error.message:"request_rejected":"review_api_failed"});
  }
}
