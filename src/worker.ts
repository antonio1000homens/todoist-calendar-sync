import type { Context, SQSHandler, SQSRecord } from "aws-lambda";
import { reconcileUnmappedCalendar } from "./calendar-reconciliation.js";
import { ManualInterventionService } from "./manual-intervention.js";
import {
  createBudgetedClientFactory,
  defaultProviderClientFactory,
  isMutationBudgetExhausted,
  ReconciliationMutationBudget,
} from "./mutation-budget.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import { enqueueDelivery, requestReconciliation } from "./queue.js";
import { SnapshotReconciler } from "./reconciliation.js";
import { StateRepository } from "./repository.js";
import { processStatusInbox } from "./status-inbox.js";
import { Synchronizer } from "./sync.js";
import type { Delivery, ReconciliationContinuation, TodoistWebhookPayload } from "./types.js";

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-worker", event, ...detail }));
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const provider = error as Error & { status?: number; body?: string; code?: string; cause?: unknown };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    status: provider.status,
    code: provider.code,
    providerBody: provider.body?.slice(0, 2000),
    cause: provider.cause instanceof Error ? { name: provider.cause.name, message: provider.cause.message } : provider.cause,
  };
}

function deliverySummary(delivery: Delivery | undefined): Record<string, unknown> {
  if (!delivery) return {};
  const summary: Record<string, unknown> = {
    deliveryId: delivery.id,
    kind: delivery.kind,
    profile: delivery.profile,
    receivedAt: delivery.receivedAt,
    providerMetadata: delivery.headers,
  };
  if (delivery.orphan) summary.orphan = delivery.orphan;
  if (delivery.reconcile) summary.reconcile = delivery.reconcile;
  if (delivery.manual) {
    summary.manual = {
      decisionId: delivery.manual.decisionId,
      action: delivery.manual.action,
      command: delivery.manual.command,
      targetType: delivery.manual.targetType,
      targetId: delivery.manual.targetId,
      slackUserId: delivery.manual.slackUserId,
    };
  }
  if (delivery.kind === "todoist") {
    try {
      const payload = JSON.parse(delivery.body) as TodoistWebhookPayload;
      summary.todoist = {
        eventName: payload.event_name,
        taskId: payload.event_data?.id,
        projectId: payload.event_data?.project_id,
        updatedAt: payload.event_data?.updated_at,
        oldProjectId: payload.event_data_extra?.old_item?.project_id,
        updateIntent: payload.event_data_extra?.update_intent,
      };
    } catch {
      summary.todoist = { parseable: false, bodyBytes: Buffer.byteLength(delivery.body || "") };
    }
  }
  return summary;
}

function sqsSummary(record: SQSRecord): Record<string, unknown> {
  const sentTimestamp = Number(record.attributes.SentTimestamp);
  const receiveCount = Number(record.attributes.ApproximateReceiveCount || "1");
  return {
    messageId: record.messageId,
    messageGroupId: record.attributes.MessageGroupId,
    sequenceNumber: record.attributes.SequenceNumber,
    receiveCount,
    sentTimestamp: Number.isFinite(sentTimestamp) ? new Date(sentTimestamp).toISOString() : record.attributes.SentTimestamp,
    approximateAgeMs: Number.isFinite(sentTimestamp) ? Math.max(0, Date.now() - sentTimestamp) : undefined,
    bodyBytes: Buffer.byteLength(record.body || ""),
    expectedDlqAfterFailure: receiveCount >= 1,
  };
}

async function scheduleOrphan(delivery: Delivery, eventId: string, taskId: string): Promise<void> {
  const message: Delivery = {
    ...delivery,
    id: `${delivery.id}:orphan:${eventId}:${taskId}`,
    kind: "orphan",
    orphan: { eventId, taskId, attempt: 2 },
  };
  await enqueueDelivery(message);
  log("orphan_recheck_enqueued", { ...deliverySummary(message), messageGroupId: `sync:${message.profile}` });
}

interface ReconciliationProcessingResult {
  continuationRequired: boolean;
  continuationQueued?: boolean;
}

async function enqueueReconciliationContinuation(
  delivery: Delivery,
  state: StateRepository,
  continuation: ReconciliationContinuation,
): Promise<Delivery> {
  if (!delivery.reconcile?.generation) throw new Error("Reconciliation continuation requires a generation");
  const next: Delivery = {
    ...delivery,
    id: `reconcile:${delivery.profile}:${delivery.reconcile.generation}:chunk:${continuation.sequence}`,
    receivedAt: new Date().toISOString(),
    headers: { ...delivery.headers, "x-todoist-calendar-sync-continuation": "true" },
    reconcile: {
      reason: delivery.reconcile.reason,
      generation: delivery.reconcile.generation,
      continuation,
    },
  };
  await enqueueDelivery(next);
  await state.markReconciliationEnqueued(delivery.profile, delivery.reconcile.generation);
  return next;
}

async function processReconciliation(
  delivery: Delivery,
  state: StateRepository,
): Promise<ReconciliationProcessingResult> {
  const mutationBudget = new ReconciliationMutationBudget();
  const budgetedClientFactory = createBudgetedClientFactory(mutationBudget, defaultProviderClientFactory);
  const reconciler = new SnapshotReconciler(
    state,
    budgetedClientFactory,
    undefined,
    (repairDelivery) => new ProjectAwareSynchronizer(state, undefined, budgetedClientFactory).process(repairDelivery),
    (profile) => new Synchronizer(state, undefined, budgetedClientFactory).reconcile(profile),
  );

  if (!delivery.reconcile?.generation) {
    const profiles = delivery.reconcileProfiles || [delivery.profile];
    log("legacy_reconciliation_started", { deliveryId: delivery.id, profiles, mutationBudget: mutationBudget.snapshot() });
    for (const profile of profiles) {
      if (mutationBudget.exhausted) {
        log("legacy_reconciliation_mutation_budget_exhausted", {
          deliveryId: delivery.id,
          profile,
          mutationBudget: mutationBudget.snapshot(),
          continuation: "hourly reconciliation will continue remaining work",
        });
        break;
      }
      if (!await state.mutationAllowed(profile)) {
        log("legacy_reconciliation_circuit_open_skipped", { deliveryId: delivery.id, profile });
        continue;
      }
      try {
        // Legacy queued messages predate resumable chunks. Preserve their old
        // single-invocation behavior rather than generating continuation state
        // that an old producer cannot recover.
        await reconciler.reconcile(profile, undefined, Number.MAX_SAFE_INTEGER);
        if (mutationBudget.exhausted) {
          log("legacy_reconciliation_mutation_budget_exhausted", {
            deliveryId: delivery.id,
            profile,
            stage: "mapped_state",
            mutationBudget: mutationBudget.snapshot(),
            continuation: "hourly reconciliation will continue remaining work",
          });
          break;
        }
        const calendarRecovery = await reconcileUnmappedCalendar(
          profile,
          state,
          defaultProviderClientFactory,
          mutationBudget,
        );
        log("legacy_reconciliation_profile_completed", {
          deliveryId: delivery.id,
          profile,
          calendarRecovery,
          mutationBudget: mutationBudget.snapshot(),
        });
        if (calendarRecovery.mutationCapReached || mutationBudget.exhausted) break;
      } catch (error) {
        if (!isMutationBudgetExhausted(error)) throw error;
        log("legacy_reconciliation_mutation_budget_exhausted", {
          deliveryId: delivery.id,
          profile,
          error: serializeError(error),
          mutationBudget: mutationBudget.snapshot(),
          continuation: "hourly reconciliation will continue remaining work",
        });
        break;
      }
    }
    log("legacy_reconciliation_completed", { deliveryId: delivery.id, profiles, mutationBudget: mutationBudget.snapshot() });
    return { continuationRequired: false };
  }

  const { generation, reason, continuation } = delivery.reconcile;
  if (!await state.beginReconciliation(delivery.profile, generation)) {
    log("reconciliation_stale_or_completed_skipped", { ...deliverySummary(delivery) });
    return { continuationRequired: false };
  }

  const startedAt = Date.now();
  log("reconciliation_started", { ...deliverySummary(delivery), mutationBudget: mutationBudget.snapshot() });

  const deferContinuation = async (
    action: string,
    stage: "mapped_state" | "calendar_snapshot",
    detail: Record<string, unknown> = {},
  ): Promise<ReconciliationProcessingResult> => {
    await state.audit(delivery.profile, action, {
      deliveryId: delivery.id,
      generation,
      reason,
      stage,
      mutationBudget: mutationBudget.snapshot(),
      ...detail,
    });
    log("reconciliation_continuation_required", {
      ...deliverySummary(delivery),
      reason,
      stage,
      action,
      mutationBudget: mutationBudget.snapshot(),
      durationMs: Date.now() - startedAt,
      continuation: "pending generation retained for later scheduled/profile-triggered retry",
      ...detail,
    });
    return { continuationRequired: true };
  };

  if (!await state.mutationAllowed(delivery.profile)) {
    return deferContinuation("reconciliation_circuit_open_deferred", "mapped_state");
  }

  const deferForMutationBudget = async (
    stage: "mapped_state" | "calendar_snapshot",
    detail: Record<string, unknown> = {},
  ): Promise<ReconciliationProcessingResult> => deferContinuation(
    "reconciliation_mutation_budget_exhausted",
    stage,
    detail,
  );

  let snapshot;
  try {
    snapshot = await reconciler.reconcile(delivery.profile, continuation);
  } catch (error) {
    if (!isMutationBudgetExhausted(error)) throw error;
    return deferForMutationBudget("mapped_state", { budgetError: serializeError(error) });
  }

  if (snapshot.continuation) {
    try {
      const next = await enqueueReconciliationContinuation(delivery, state, snapshot.continuation);
      await state.audit(delivery.profile, "reconciliation_chunk_queued", {
        deliveryId: delivery.id,
        generation,
        reason,
        processedCandidates: snapshot.processedCandidates,
        continuation: snapshot.continuation,
        nextDeliveryId: next.id,
        mutationBudget: mutationBudget.snapshot(),
      });
      log("reconciliation_chunk_queued", {
        ...deliverySummary(delivery),
        processedCandidates: snapshot.processedCandidates,
        nextDelivery: deliverySummary(next),
        mutationBudget: mutationBudget.snapshot(),
        durationMs: Date.now() - startedAt,
      });
      return { continuationRequired: false, continuationQueued: true };
    } catch (error) {
      return deferContinuation("reconciliation_chunk_enqueue_deferred", "mapped_state", {
        processedCandidates: snapshot.processedCandidates,
        continuation: snapshot.continuation,
        enqueueError: serializeError(error),
      });
    }
  }

  if (mutationBudget.exhausted) return deferForMutationBudget("mapped_state");

  const calendarRecovery = await reconcileUnmappedCalendar(
    delivery.profile,
    state,
    defaultProviderClientFactory,
    mutationBudget,
  );

  if (calendarRecovery.mutationCapReached || mutationBudget.exhausted) {
    return deferForMutationBudget("calendar_snapshot", { calendarRecovery });
  }
  if (calendarRecovery.blocked > 0) {
    return deferContinuation("reconciliation_calendar_snapshot_circuit_deferred", "calendar_snapshot", { calendarRecovery });
  }

  await state.completeReconciliation(delivery.profile, generation);
  log("reconciliation_completed", {
    ...deliverySummary(delivery),
    reason,
    calendarRecovery,
    mutationBudget: mutationBudget.snapshot(),
    durationMs: Date.now() - startedAt,
  });
  return { continuationRequired: false };
}

export const handler: SQSHandler = async (event, context: Context) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const startedAt = Date.now();
    let delivery: Delivery | undefined;
    let state: StateRepository | undefined;
    let manual: ManualInterventionService | undefined;
    let meaningfulMutation = false;
    let calendarMutationBlocked = false;
    try {
      delivery = JSON.parse(record.body) as Delivery;
      state = new StateRepository();
      manual = new ManualInterventionService();

      // Synchronizers already call recordMutation only after an actual provider
      // write. Intercept that signal at the shared repository boundary so the
      // worker can distinguish meaningful changes from stale/echo/no-op webhook
      // deliveries without duplicating synchronizer logic.
      const recordMutation = state.recordMutation.bind(state);
      state.recordMutation = async (profile) => {
        await recordMutation(profile);
        meaningfulMutation = true;
      };

      // Keep the normal audit record as the source of truth, then let the
      // manual-control observer turn only conflict/blocked outcomes into Slack
      // decisions. Notification failure never suppresses the underlying audit.
      const audit = state.audit.bind(state);
      state.audit = async (profile, action, detail) => {
        await audit(profile, action, detail);
        if (delivery) await manual?.observeAudit(delivery, profile, action, detail);
      };

      // A Calendar delta must never advance its incremental cursor past changes
      // that were suppressed after the circuit opened mid-delivery. Track every
      // mutation gate result and withhold putSyncToken once a Calendar event is
      // blocked. Baseline establishment is unaffected because it does not call
      // mutationAllowed while applying provider changes.
      const mutationAllowed = state.mutationAllowed.bind(state);
      state.mutationAllowed = async (profile) => {
        const allowed = await mutationAllowed(profile);
        if (!allowed && delivery?.kind === "calendar") calendarMutationBlocked = true;
        return allowed;
      };
      const putSyncToken = state.putSyncToken.bind(state);
      state.putSyncToken = async (profile, token) => {
        if (delivery?.kind === "calendar" && calendarMutationBlocked) {
          log("calendar_sync_token_withheld_circuit_block", {
            awsRequestId: context.awsRequestId,
            delivery: deliverySummary(delivery),
            profile,
          });
          return;
        }
        await putSyncToken(profile, token);
      };

      log("delivery_started", {
        awsRequestId: context.awsRequestId,
        sqs: sqsSummary(record),
        delivery: deliverySummary(delivery),
      });

      if (await state.isDeliveryCompleted(delivery.id)) {
        log("delivery_duplicate_completed_skipped", {
          awsRequestId: context.awsRequestId,
          sqs: sqsSummary(record),
          delivery: deliverySummary(delivery),
        });
        continue;
      }

      if (delivery.kind === "manual") {
        if (delivery.manual?.command === "show_status") {
          await processStatusInbox(delivery, state);
        } else {
          await manual.processManualDelivery(delivery, state);
        }
        await state.markDeliveryCompleted(delivery.id, delivery.profile, delivery.kind);
        log("manual_delivery_completed", {
          awsRequestId: context.awsRequestId,
          durationMs: Date.now() - startedAt,
          delivery: deliverySummary(delivery),
        });
        continue;
      }

      if (delivery.kind === "reconcile") {
        const reconciliation = await processReconciliation(delivery, state);
        if (!reconciliation.continuationRequired) {
          await state.markDeliveryCompleted(delivery.id, delivery.profile, delivery.kind);
          log(reconciliation.continuationQueued ? "delivery_completed_with_queued_continuation" : "delivery_completed", {
            awsRequestId: context.awsRequestId,
            durationMs: Date.now() - startedAt,
            delivery: deliverySummary(delivery),
            continuationQueued: reconciliation.continuationQueued || false,
          });
        } else {
          log("delivery_completed_with_deferred_continuation", {
            awsRequestId: context.awsRequestId,
            durationMs: Date.now() - startedAt,
            delivery: deliverySummary(delivery),
            completedDeliveryMarkerWritten: false,
          });
        }
        continue;
      }

      if (delivery.kind === "todoist" && await manual.interceptTodoistDeletion(delivery, state)) {
        await state.markDeliveryCompleted(delivery.id, delivery.profile, delivery.kind);
        log("todoist_delete_deferred_for_manual_decision", {
          awsRequestId: context.awsRequestId,
          durationMs: Date.now() - startedAt,
          delivery: deliverySummary(delivery),
        });
        continue;
      }

      const hadCalendarToken = delivery.kind === "calendar"
        ? Boolean(await state.getSyncToken(delivery.profile))
        : true;

      if (delivery.kind === "calendar" && !await state.mutationAllowed(delivery.profile)) {
        await state.audit(delivery.profile, "calendar_delivery_deferred_circuit_open", {
          deliveryId: delivery.id,
          providerMetadata: delivery.headers,
        });
        const reconciliation = await requestReconciliation(state, delivery.profile, "webhook");
        log("calendar_delivery_deferred_circuit_open", {
          awsRequestId: context.awsRequestId,
          delivery: deliverySummary(delivery),
          reconciliation,
          syncTokenAdvanced: false,
        });
        await state.markDeliveryCompleted(delivery.id, delivery.profile, delivery.kind);
        continue;
      }

      await new ProjectAwareSynchronizer(state, scheduleOrphan).process(delivery);

      if (delivery.kind === "calendar" || delivery.kind === "todoist") {
        const baselineRecovery = delivery.kind === "calendar" && !hadCalendarToken;
        if (meaningfulMutation || baselineRecovery || calendarMutationBlocked) {
          const reason = baselineRecovery ? "baseline_recovery" as const : "webhook" as const;
          const reconciliation = await requestReconciliation(state, delivery.profile, reason);
          if (reconciliation.enqueueError) {
            console.error(JSON.stringify({
              service: "todoist-calendar-sync-worker",
              event: "reconciliation_enqueue_deferred",
              awsRequestId: context.awsRequestId,
              delivery: deliverySummary(delivery),
              reconciliation,
              note: "Durable pending state is retained; a later webhook or hourly scheduler will retry enqueue.",
            }));
          } else {
            log(reconciliation.coalesced ? "reconciliation_coalesced" : "reconciliation_requested", {
              awsRequestId: context.awsRequestId,
              triggerDeliveryId: delivery.id,
              reconciliation,
              calendarMutationBlocked,
            });
          }
        } else {
          log("reconciliation_not_requested_for_noop_delivery", {
            awsRequestId: context.awsRequestId,
            triggerDeliveryId: delivery.id,
            kind: delivery.kind,
            profile: delivery.profile,
          });
        }
      }

      await state.markDeliveryCompleted(delivery.id, delivery.profile, delivery.kind);
      log("delivery_completed", {
        awsRequestId: context.awsRequestId,
        durationMs: Date.now() - startedAt,
        delivery: deliverySummary(delivery),
      });
    } catch (error) {
      if (delivery?.kind === "reconcile" && delivery.reconcile?.generation && state) {
        await state.recordReconciliationFailure(
          delivery.profile,
          delivery.reconcile.generation,
          error instanceof Error ? error.message : String(error),
        ).catch((stateError: unknown) => {
          console.error(JSON.stringify({
            service: "todoist-calendar-sync-worker",
            event: "reconciliation_failure_state_write_failed",
            delivery: deliverySummary(delivery),
            error: serializeError(stateError),
          }));
        });
      }

      await manual?.reportDeliveryFailure(delivery, error).catch((manualError: unknown) => {
        console.error(JSON.stringify({
          service: "todoist-calendar-sync-worker",
          event: "manual_failure_notification_failed",
          delivery: deliverySummary(delivery),
          error: serializeError(manualError),
        }));
      });

      console.error(JSON.stringify({
        service: "todoist-calendar-sync-worker",
        event: "delivery_failed_for_dlq",
        awsRequestId: context.awsRequestId,
        durationMs: Date.now() - startedAt,
        sqs: sqsSummary(record),
        delivery: deliverySummary(delivery),
        error: serializeError(error),
        dlqPolicy: { maxReceiveCount: 1, action: "quarantine_after_this_failed_receive" },
      }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
