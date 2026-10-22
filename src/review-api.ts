import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { StateRepository } from "./repository.js";
import { ReviewEngine } from "./review-engine.js";
import { ReviewStore } from "./review-store.js";
import type { Profile } from "./types.js";
import { REVIEW_PROFILES, type RepairIntent } from "./review-types.js";


function response(statusCode: number, payload: unknown): LambdaFunctionURLResult {
  return { statusCode, headers: { "content-type":"application/json", "cache-control":"no-store", "x-content-type-options":"nosniff" }, body: JSON.stringify(payload) };
}
function profile(value: string | null): Profile {
  if (!value || !REVIEW_PROFILES.includes(value as Profile)) throw Object.assign(new Error("A valid profile is required"), { status:400 });
  return value as Profile;
}
function errorStatus(error: unknown): number { return Number((error as {status?:number})?.status) || 500; }

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  try {
    const path = event.rawPath || "/";
    if (!path.startsWith("/review/api/")) return response(404,{error:"not_found"});
    const method = event.requestContext.http.method;
    if (method !== "GET") return response(405,{error:"read_only_dashboard"});
    const segments = path.slice("/review/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
    const store = new ReviewStore();
    if (method === "GET" && segments[0] === "cases" && segments.length === 1) {
      const selected = event.queryStringParameters?.profile;
      const profiles = selected ? [profile(selected)] : REVIEW_PROFILES;
      const history = event.queryStringParameters?.history === "true";
      const results = await Promise.all(profiles.map(async item => ({ profile:item, ...(await store.listCases(item,undefined,history)) })));
      return response(200,{items:results.flatMap(result=>result.items),readOnly:true});
    }
    if (method === "GET" && segments[0] === "cases" && segments.length === 2) {
      const item = await store.getCase(segments[1]);
      if (!item) return response(404,{error:"conflict_not_found"});
      const intent: RepairIntent = { caseId:item.id, profile:item.profile, action:item.decision?"decision":"link", taskId:item.taskId, eventId:item.eventId,
        winner:"none", scope:"occurrence", leftovers:{} };
      const snapshots = await new ReviewEngine(store).collect(intent,item.decision);
      return response(200,{item,snapshots});
    }
    if (method === "GET" && segments[0] === "reconciliation" && segments.length === 1) {
      const selected=profile(event.queryStringParameters?.profile || null);
      return response(200,{reconciliation:await new StateRepository().getReconciliationState(selected)});
    }
    return response(404,{error:"not_found"});
  } catch(error) {
    const status=errorStatus(error);
    return response(status,{error:status<500?error instanceof Error?error.message:"request_rejected":"review_api_failed"});
  }
}
