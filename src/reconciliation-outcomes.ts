import type { ManualInterventionService } from "./manual-intervention.js";
import { reconciliationRunStatus, type ReconciliationState, type StateRepository } from "./repository.js";

/** Retrying Slack delivery never starts or modifies a reconciliation run. */
export async function deliverPendingReconciliationOutcome(
  state: StateRepository, manual: ManualInterventionService, run: ReconciliationState,
): Promise<void> {
  if (!run.notificationPending) return;
  const runStatus = reconciliationRunStatus(run);
  const status = runStatus === "needs_review" ? "Needs review" : runStatus === "failed" ? "Failed" : "Succeeded";
  const counts = Object.entries(run.result || {}).map(([name, count]) => `${name}: ${count}`).join(" · ") || "No changes needed";
  const failure = run.lastError ? `\nReason: ${run.lastError}\nNext action: fix the reported issue, then request a fresh reconciliation in Slack.` : "";
  const text = `*${status} — ${run.profile}*\n${counts}\nUnresolved: ${run.unresolved || 0}${failure}`;
  const replyTs = await manual.deliverReconciliationOutcome(run.slackChannelId, run.slackThreadTs, run.notificationReplyTs, text);
  if (!replyTs) throw new Error("Slack did not confirm delivery of the reconciliation outcome");
  if (!run.notificationReplyTs) {
    await state.storeReconciliationReply(run.profile, run.generation, replyTs);
    run.notificationReplyTs = replyTs;
  }
  const succeeded = runStatus === "succeeded";
  if (succeeded && run.slackDecisionId) await manual.finishReconciliationDecision(run.slackDecisionId, text);
  else await manual.updateReconciliationIncident(run.slackChannelId, run.slackMessageTs, text, false, run.slackDecisionId);
  await state.markReconciliationNotified(run.profile, run.generation, replyTs);
}
