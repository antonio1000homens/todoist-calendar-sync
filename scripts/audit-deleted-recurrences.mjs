#!/usr/bin/env node
/** Bounded, strictly read-only audit for #292. There is no --apply mode.
 * Repairs are performed by the reviewed reconciliation worker, not this CLI.
 */
import { ReviewStore } from "../dist/review-store.js";
import { StateRepository } from "../dist/repository.js";
import { auditDeletedRecurrenceCase } from "./deleted-recurrence-audit.mjs";
import { defaultProviderClientFactory } from "../dist/mutation-budget.js";

const table = process.env.STATE_TABLE_NAME?.trim();
if (!table) throw new Error("Explicit STATE_TABLE_NAME is required");
const args = process.argv.slice(2);
for (const arg of args) if (arg!=="--include-dismissed"
  && !["--profile=", "--case=", "--max-cases="].some(prefix => arg.startsWith(prefix)))
  throw new Error("Read-only audit supports only --profile, --case, --max-cases and --include-dismissed; it has no --apply mode");
const selected = args.find(arg => arg.startsWith("--profile="))?.slice(10) || "antonio";
const profiles = selected === "all" ? ["home", "antonio", "work"] : [selected];
if (profiles.some(profile => !["home", "antonio", "work"].includes(profile))) throw new Error("Unknown profile");
const caseId = args.find(arg => arg.startsWith("--case="))?.slice(7);
const includeDismissed = args.includes("--include-dismissed");
if(caseId && (caseId.length>200 || !/^[A-Za-z0-9._-]+$/.test(caseId)))
  throw new Error("--case must contain an exact review decision ID");
const maxCases = Number(args.find(arg => arg.startsWith("--max-cases="))?.slice(12) || "30");
if (!Number.isSafeInteger(maxCases) || maxCases < 1 || maxCases > 100)
  throw new Error("--max-cases must be in 1..100");

const store = new ReviewStore();
const state = new StateRepository();
const report = [];
let checked = 0;
let truncated = false;
for (const profile of profiles) {
  const provider = await defaultProviderClientFactory(profile);
  let cursor;
  do {
    // A precise historical case must be readable without a GSI sweep.
    // Normal listing covers open cases; opted-in history also includes
    // previously dismissed cases that still have attributable stale links.
    const page = caseId
      ? {items:[await store.getCase(caseId)].filter(Boolean),cursor:undefined}
      : await store.listCases(profile,cursor,includeDismissed,10);
    cursor = page.cursor;
    for (const item of page.items) {
      if (item.profile!==profile
        || item.status!=="open" && !(includeDismissed && item.status==="dismissed")
        || !item.decision?.type?.includes("recurrence_task_deleted")) continue;
      if (checked >= maxCases) { truncated = true; break; }
      checked++;
      report.push(await auditDeletedRecurrenceCase(item,provider,state));
    }
    if (truncated) break;
  } while (cursor);
  if (truncated) break;
}
console.log(JSON.stringify({ mode: "dry-run", table, checked, truncated, includeDismissed, cases: report,
  note: "No provider or DynamoDB writes. Guarded cleanup requires separately reviewed deployment and reconciliation." }, null, 2));
