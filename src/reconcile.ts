import type { Handler } from "aws-lambda";
import { ManualInterventionService } from "./manual-intervention.js";
import { reconciliationRunStatus, StateRepository } from "./repository.js";
import { deliverPendingReconciliationOutcome } from "./reconciliation-outcomes.js";
import { ManualDecisionStore } from "./manual-intervention.js";
import { ReviewStore } from "./review-store.js";
import { acquireProfileAdmissionLease } from "./erasure-protocol.js";
import type { Profile } from "./types.js";

const profileList: Profile[] = ["home", "antonio", "work"];
const QUEUED_ALERT_MS = 10 * 60_000;
const RUNNING_ALERT_MS = 15 * 60_000;

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-health", event, ...detail }));
}

/** Health watchdog; serialize its state and Slack writes against profile erasure fences. */
export async function checkReconciliationHealth(
  state: StateRepository, manual: ManualInterventionService, profiles: Profile[] = profileList,
  lookupBudget: { deadlineAtMs?: number; requestId?: string } = {},
  acquireWriteLease: (profile:Profile)=>Promise<()=>Promise<void>> = acquireProfileAdmissionLease,
): Promise<void> {
  for (const profile of profiles) {
    let releaseLease:(()=>Promise<void>)|undefined;
    try {
      // Health inspection may persist outcomes, retire incidents, and mark
      // alerts. Fence admission before the first read/write and hold it across
      // all provider/Slack delivery and the final state checkpoint.
      releaseLease=await acquireWriteLease(profile);
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
        const reviewStore = new ReviewStore();
        for (const operation of await reviewStore.pendingNotifications(profile)) {
          try {
            const reviewCase = await reviewStore.getCase(operation.preview.intent.caseId);
            const decisionId = reviewCase?.decision?.decisionId;
            const decision = decisionId ? await new ManualDecisionStore().get(decisionId) : undefined;
            const status = operation.status === "succeeded" ? "Succeeded"
              : operation.status === "needs_review" ? "Needs review" : "Failed";
            const text = operation.notificationText || status + ": " + (operation.verified?.length || 0) + " pairs verified"
              + (operation.error ? ". " + operation.error : "");
            const replyTs = await manual.deliverReconciliationOutcome(
              decision?.slackChannelId, decision?.slackMessageTs, operation.notificationReplyTs, text,
            );
            await reviewStore.completeNotification(operation.id, replyTs);
          } catch (error) {
            log("repair_outcome_notification_retry_failed", { profile, operationId:operation.id, error:error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (!current) continue;
      // A stuck alert describes one run. Once a later generation replaces it,
      // or the alerted run reaches a terminal state, it is stale; it must not
      // remain actionable alongside the current run.
      await manual.retireStaleReconciliationIncidents(profile,current.generation,current.pending,lookupBudget);
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

      const statusCode = current.lastError?.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
      const failureCategory = runStatus !== "failed" ? undefined : current.failureContext?.category
        || (/timeout|timed out/i.test(current.lastError || "") ? "timeout"
          : /queue|enqueue|sqs/i.test(current.lastError || "") ? "queue_failure"
            : statusCode ? `provider_http_${statusCode}` : "worker_failure");
      const classifiedStatus = statusCode || failureCategory?.match(/(?:provider_http_)(\d{3})/)?.[1];
      const failureSummary = failureCategory === "timeout" ? "A worker operation timed out."
        : failureCategory === "queue_failure" ? "A queue handoff failed."
          : classifiedStatus ? `A provider request returned HTTP ${classifiedStatus}.`
            : runStatus === "failed" ? "The worker recorded a failure; the underlying cause is not classified." : undefined;
      const detail = runStatus === "failed"
        ? `${failureSummary} A fresh generation is required after addressing the cause.`
        : `${runStatus} for ${Math.floor(ageMs / 60_000)} minutes without a recorded progress update. This monitor observation does not identify why progress stopped.`;
      const diagnostic = {
        reconciliationGeneration: current.generation,
        reconciliationStatus: runStatus,
        reconciliationPending: current.pending,
        requestedAt: current.requestedAt,
        lastEnqueuedAt: current.lastEnqueuedAt,
        lastStartedAt: current.lastStartedAt,
        lastProgressAt: current.lastProgressAt,
        lastCompletedAt: current.lastCompletedAt,
        lastFailedAt: current.lastFailedAt,
        reconciliationResult: current.result,
        progressCheckpoint: current.progressCheckpoint,
        nextContinuation: current.nextContinuation,
        lastDeliveryId: current.lastDeliveryId,
        lastStartedDeliveryId: current.lastStartedDeliveryId,
        queueState: current.queueState || "unknown",
        queueStateNote: "Queue acceptance is recorded when available; current SQS and DLQ state is not queried by this monitor.",
        failureCategory,
        failureSummary,
        failureContext: current.failureContext,
        incidentClassification: runStatus === "failed" ? "worker_failure" : "monitor_stall",
        observedAt: new Date().toISOString(),
      };
      const delivered = await manual.alertReconciliationNeeded(profile, current.generation, current.slackChannelId, detail, diagnostic);
      if (!delivered) continue;
      await state.markReconciliationHealthAlert(profile, current.generation);
      log("reconciliation_health_alerted", { profile, generation: current.generation, status: runStatus, ageMs });
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-health", event: "profile_health_check_failed", profile,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      try { await releaseLease?.(); }
      catch(error) { console.error(JSON.stringify({service:"todoist-calendar-sync-health",event:"profile_admission_release_failed",profile,
        error:error instanceof Error?error.message:String(error)})); }
    }
  }
}

export const handler: Handler = async (_event, context) => {
  log("reconciliation_health_check", { awsRequestId: context.awsRequestId, profiles: profileList });
  const remainingMs = typeof context.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 25_000;
  const deadlineAtMs = Date.now() + Math.max(0, remainingMs - 4_000);
  await checkReconciliationHealth(new StateRepository(), new ManualInterventionService(), profileList, {
    deadlineAtMs,
    requestId: context.awsRequestId,
  });
};
