#!/usr/bin/env node
/** Bounded, strictly read-only audit for #292. There is no --apply mode.
 * Repairs are performed by the reviewed reconciliation worker, not this CLI.
 */
import { ReviewStore } from "../dist/review-store.js";
import { StateRepository } from "../dist/repository.js";
import { reviewCaseEvidenceIds } from "../dist/deleted-review-identities.js";
import { deletedRecurrenceStatus } from "../dist/deletion-review-state.js";
import { cancelledOccurrenceMasterId } from "../dist/verified-deletion.js";
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
      const { taskIds, eventIds } = reviewCaseEvidenceIds(item);
      const entry = { profile, caseId: item.id, taskIds, eventIds };
      if (!taskIds.length || !eventIds.length || taskIds.length + eventIds.length > 20) {
        report.push({ ...entry, state: "unverified", reason: "Incomplete or excessive exact IDs" });
        continue;
      }
      const snapshots = [];
      const read = async (side, id) => {
        let object = null, lookupError;
        try { object = side === "todoist"
          ? await provider.todoist.getTask(id) : await provider.calendar.getEvent(id); }
        catch (error) { if (![404, 410].includes(Number(error?.status)))
          lookupError = String(error?.message || error); }
        const mapping = side === "todoist"
          ? await state.getMappingByTaskAnyProfile(id)
          : (await Promise.all(["home", "antonio", "work"]
            .map(owner => state.getMappingByEvent(owner, id)))).find(Boolean);
        snapshots.push({ ref: { profile, side, id }, object, lookupError, mapping,
          checkedAt: new Date().toISOString() });
      };
      for (const id of taskIds) await read("todoist", id);
      for (const id of eventIds) await read("calendar", id);
      // Older decisions store only the active Calendar occurrence. The
      // cancelled occurrence may directly identify its master; fetch that
      // master separately instead of guessing from an ID suffix.
      const recordedMasterId=item.decision.masterEventId || item.decision.mappingSnapshot?.masterEventId;
      const activeId=item.decision.activeInstanceId || item.decision.mappingSnapshot?.activeInstanceId;
      const observedActive=snapshots.find(snapshot=>snapshot.ref.side==="calendar"
        && snapshot.ref.id===activeId && !snapshot.lookupError);
      const recoveredMasterId=!recordedMasterId
        ? cancelledOccurrenceMasterId(activeId,observedActive?.object||undefined)
        : undefined;
      if(recoveredMasterId && !eventIds.includes(recoveredMasterId)) {
        if(taskIds.length+eventIds.length+1>20) {
          report.push({...entry,state:"unverified",reason:"Recovered master exceeds bounded identity limit"});
          continue;
        }
        await read("calendar",recoveredMasterId);
      }
      const deletion = await deletedRecurrenceStatus(item, snapshots,
        (owner, seriesId) => state.getRecurrenceLink(owner, seriesId));
      report.push({
        ...entry, deletion, recurrenceLinks: deletion?.staleLinks || [],
        action: deletion?.bothGone && ["pending_cleanup","stale_recurrence"].includes(deletion.state)
          ? "candidate_for_guarded_reconciliation" : "retain_for_manual_review",
      });
    }
    if (truncated) break;
  } while (cursor);
  if (truncated) break;
}
console.log(JSON.stringify({ mode: "dry-run", table, checked, truncated, includeDismissed, cases: report,
  note: "No provider or DynamoDB writes. Guarded cleanup requires separately reviewed deployment and reconciliation." }, null, 2));
