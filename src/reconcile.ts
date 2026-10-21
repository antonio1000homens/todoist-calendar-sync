import type { Handler } from "aws-lambda";
import { ManualInterventionService } from "./manual-intervention.js";
import { reconciliationRunStatus, StateRepository } from "./repository.js";
import { deliverPendingReconciliationOutcome } from "./reconciliation-outcomes.js";
import type { Profile } from "./types.js";

const profileList: Profile[] = ["home", "antonio", "work"];
const QUEUED_ALERT_MS = 10 * 60_000;
const RUNNING_ALERT_MS = 15 * 60_000;

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-health", event, ...detail }));
}

/** Read-only provider health watchdog. It never enqueues reconciliation work. */
export async function checkReconciliationHealth(
  state: StateRepository, manual: ManualInterventionService, profiles: Profile[] = profileList,
): Promise<void> {
  for (const profile of profileList) {
    try {
      const current = await state.getReconciliationState(profile);
      // Notifications belong to generations, so a new run cannot hide an
      // undelivered outcome from an earlier one.
      if (manual.enabled) {
        if (current?.notificationPending) await state.preserveReconciliationOutcome(current);
        const outcomes = await state.listPendingReconciliationOutcomes(profile);
        for (const outcome of outcomes) {
          try {
            await deliverPendingReconciliationOutcome(state, manual, outcome);
          } catch (error) {
            log("outcome_notification_retry_failed", { profile, generation: outcome.generation, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (!current) continue;
      const runStatus = reconciliationRunStatus(current);

      if (!current.pending || !["queued", "running", "failed"].includes(runStatus)) continue;
      const last = runStatus === "running"
        ? current.lastProgressAt || current.lastStartedAt
        : current.lastEnqueuedAt || current.requestedAt;
      const ageMs = last ? Date.now() - Date.parse(last) : Number.POSITIVE_INFINITY;
      const threshold = runStatus === "running" ? RUNNING_ALERT_MS : QUEUED_ALERT_MS;
      const stale = runStatus === "failed" || ageMs >= threshold;

      if (!stale) {
        if (current.lastHealthAlertAt) await state.clearReconciliationHealthAlert(profile, current.generation);
        continue;
      }
      if (current.lastHealthAlertAt || !manual.enabled) continue;

      const detail = runStatus === "failed"
        ? `The previous run failed: ${current.lastError || "unknown error"}. Click to start a fresh generation after addressing the cause.`
        : `${runStatus} for ${Math.floor(ageMs / 60_000)} minutes without progress. Click to request a fresh manual reconciliation.`;
      const delivered = await manual.alertReconciliationNeeded(profile, current.generation, current.slackChannelId, detail);
      if (!delivered) continue;
      await state.markReconciliationHealthAlert(profile, current.generation);
      log("reconciliation_health_alerted", { profile, generation: current.generation, status: runStatus, ageMs });
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-health", event: "profile_health_check_failed", profile,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

export const handler: Handler = async (_event, context) => {
  log("reconciliation_health_check", { awsRequestId: context.awsRequestId, profiles: profileList });
  await checkReconciliationHealth(new StateRepository(), new ManualInterventionService());
};
