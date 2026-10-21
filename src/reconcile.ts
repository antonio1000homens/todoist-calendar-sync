import type { Handler } from "aws-lambda";
import { ManualInterventionService } from "./manual-intervention.js";
import { StateRepository } from "./repository.js";
import type { Profile } from "./types.js";

const profileList: Profile[] = ["home", "antonio", "work"];
const QUEUED_ALERT_MS = 10 * 60_000;
const RUNNING_ALERT_MS = 15 * 60_000;

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-health", event, ...detail }));
}

/** Read-only provider health watchdog. It never enqueues reconciliation work. */
export const handler: Handler = async (_event, context) => {
  const state = new StateRepository();
  const manual = new ManualInterventionService();
  log("reconciliation_health_check", { awsRequestId: context.awsRequestId, profiles: profileList });

  for (const profile of profileList) {
    try {
      const current = await state.getReconciliationState(profile);
      if (!current) continue;
      const runStatus = current.status || (current.lastFailedAt ? "failed" : current.pending ? "queued" : "succeeded");

      if (current.notificationPending && manual.enabled) {
        const status = runStatus === "needs_review" ? "⚠️ Needs review" : runStatus === "failed" ? "❌ Failed" : "✅ Succeeded";
        const details = Object.entries(current.result || {}).map(([key, value]) => `${key}: ${value}`).join(" · ") || "No changes needed";
        const failure = current.lastError ? `\nReason: ${current.lastError}\nFix the reported issue, then request a fresh reconciliation in Slack.` : "";
        const text = `*${status} — ${profile}*\n${details}\nUnresolved: ${current.unresolved || 0}${failure}`;
        try {
          const replyTs = await manual.deliverReconciliationOutcome(current.slackChannelId, current.slackThreadTs, current.notificationReplyTs, text);
          if (replyTs && !current.notificationReplyTs) await state.storeReconciliationReply(profile, current.generation, replyTs);
          const succeeded = runStatus === "succeeded";
          await manual.updateReconciliationIncident(current.slackChannelId, current.slackMessageTs, text, succeeded);
          if (succeeded && current.slackDecisionId) await manual.finishReconciliationDecision(current.slackDecisionId, text);
          if (replyTs) await state.markReconciliationNotified(profile, current.generation, replyTs);
        } catch (error) {
          log("outcome_notification_retry_failed", { profile, generation: current.generation, error: error instanceof Error ? error.message : String(error) });
        }
      }

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
        : `${current.status} for ${Math.floor(ageMs / 60_000)} minutes without progress. Click to request a fresh manual reconciliation.`;
      await manual.alertReconciliationNeeded(profile, current.generation, current.slackChannelId, detail);
      await state.markReconciliationHealthAlert(profile, current.generation);
      log("reconciliation_health_alerted", { profile, generation: current.generation, status: runStatus, ageMs });
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-health", event: "profile_health_check_failed", profile,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
};
