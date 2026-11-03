#!/usr/bin/env node
/** Bounded, strictly read-only audit for #292. There is no --apply mode.
 * Repairs are performed by the reviewed reconciliation worker, not this CLI.
 */
import { ReviewStore } from "../dist/review-store.js";
import { StateRepository } from "../dist/repository.js";
import { reviewCaseEvidenceIds } from "../dist/deleted-review-identities.js";
import { deletedRecurrenceStatus } from "../dist/deletion-review-state.js";
import { defaultProviderClientFactory } from "../dist/mutation-budget.js";

const table = process.env.STATE_TABLE_NAME?.trim();
if (!table) throw new Error("Explicit STATE_TABLE_NAME is required");
const args = process.argv.slice(2);
for (const arg of args) if (!["--profile=", "--case=", "--max-cases="].some(prefix => arg.startsWith(prefix)))
  throw new Error("Read-only audit supports only --profile, --case and --max-cases; it has no --apply mode");
const selected = args.find(arg => arg.startsWith("--profile="))?.slice(10) || "antonio";
const profiles = selected === "all" ? ["home", "antonio", "work"] : [selected];
if (profiles.some(profile => !["home", "antonio", "work"].includes(profile))) throw new Error("Unknown profile");
const caseId = args.find(arg => arg.startsWith("--case="))?.slice(7);
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
    const page = await store.listCases(profile, cursor, false, 10);
    cursor = page.cursor;
    for (const item of page.items) {
      if (item.status !== "open" || !item.decision?.type?.includes("recurrence_task_deleted")
        || (caseId && item.id !== caseId)) continue;
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
console.log(JSON.stringify({ mode: "dry-run", table, checked, truncated, cases: report,
  note: "No provider or DynamoDB writes. Guarded cleanup requires separately reviewed deployment and reconciliation." }, null, 2));
