import { writeFile } from "node:fs/promises";
import { StateRepository } from "../dist/repository.js";
import { requestReconciliation } from "../dist/queue.js";
import { runReconciliationAcceptance } from "./reconciliation-acceptance-runner.mjs";

const profiles = ["antonio", "home", "work"];
const pollIntervalMs = 15_000;
const timeoutMs = Number(process.env.RECONCILIATION_ACCEPTANCE_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const resultFile = process.env.RECONCILIATION_RESULT_FILE || "reconciliation-acceptance-result.json";
const state = new StateRepository();

async function run() {
  if (!process.env.STATE_TABLE_NAME) throw new Error("production reconciliation state table is not configured");
  if (!process.env.QUEUE_URL) throw new Error("production reconciliation FIFO queue is not configured");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 4 * 60 * 60 * 1000)
    throw new Error("reconciliation acceptance timeout must be between one minute and four hours");

  const result = await runReconciliationAcceptance({
    state,
    requestProfileReconciliation: profile => requestReconciliation(state, profile, "scheduled", undefined, { requester: "scheduled" }),
    profiles,
    timeoutMs,
    pollIntervalMs,
    onPass: ({ profile, pass, clean }) => console.log(JSON.stringify({
      service: "todoist-calendar-sync-production-reconciliation-acceptance",
      event: clean ? "pass_verified" : "pass_failed",
      profile, pass: pass.pass, status: pass.status, unresolved: pass.unresolved, counts: pass.counts,
    })),
  });
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
} catch {
  const result = {
    mode: "production-reconciliation-acceptance",
    status: "failed",
    failure: "reconciliation_state_read_failed",
    profiles: Object.fromEntries(profiles.map(profile => [profile, []])),
  };
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
