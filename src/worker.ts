import type { Context, SQSHandler, SQSRecord } from "aws-lambda";
import { reconcileUnmappedCalendar } from "./calendar-reconciliation.js";
import { ManualInterventionService } from "./manual-intervention.js";
import {
  createBudgetedClientFactory,
  defaultProviderClientFactory,
  isMutationBudgetExhausted,
  ReconciliationMutationBudget,
  type ProviderClientFactory,
} from "./mutation-budget.js";
import { OrphanRecoveringSynchronizer } from "./orphan-recovery.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import { enqueueDelivery, queuePendingRefresh } from "./queue.js";
import { SnapshotReconciler } from "./reconciliation.js";
import { ReconciliationItemError, reconciliationFailureDetails } from "./reconciliation-diagnostics.js";
import { StateRepository } from "./repository.js";
import { deliverPendingReconciliationOutcome } from "./reconciliation-outcomes.js";
import { processStatusInbox } from "./status-inbox.js";
import { Synchronizer } from "./sync.js";
import { ReviewEngine } from "./review-engine.js";
import { ReviewStore } from "./review-store.js";
import { acquireErasureProtocolLease, ErasureEpochChangedError, getErasureEpoch } from "./erasure-protocol.js";
import {assertReplayAdmission, ErasureReplayBlockedError, ErasureReplayUnavailableError, replayAdmissionEnabled} from "./erasure-replay-barrier.js";
import { logEvent } from "./observability.js";
import { ManualDecisionStore } from "./manual-intervention.js";
import type { Delivery, Profile, ReconciliationContinuation, TodoistWebhookPayload } from "./types.js";

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
    ...reconciliationFailureDetails(error),
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
      pendingRefreshRefs: delivery.reconcile.pendingRefreshRefs,
    },
  };
  await enqueueDelivery(next);
  await state.markReconciliationEnqueued(delivery.profile, delivery.reconcile.generation, next.id, {
    phase: continuation.phase, sequence: continuation.sequence, deliveryId: next.id,
    afterTaskId: continuation.afterTaskId, afterEventId: continuation.afterEventId,
  });
  return next;
}

export async function processReconciliation(
  delivery: Delivery,
  state: StateRepository,
  clientFactory: ProviderClientFactory = defaultProviderClientFactory,
): Promise<ReconciliationProcessingResult> {
  const mutationBudget = new ReconciliationMutationBudget();
  if (!delivery.reconcile?.generation) {
    log("legacy_reconciliation_delivery_skipped", { deliveryId: delivery.id, profile: delivery.profile, reason: "automatic legacy reconciliation is disabled; request a manual run in Slack" });
    return { continuationRequired: false };
  }
  const budgetedClientFactory = createBudgetedClientFactory(mutationBudget, clientFactory);
  const reconciler = new SnapshotReconciler(
    state,
    budgetedClientFactory,
    undefined,
    (repairDelivery) => new ProjectAwareSynchronizer(state, undefined, budgetedClientFactory).process(repairDelivery),
    (profile) => new Synchronizer(state, undefined, budgetedClientFactory).reconcile(profile),
  );

  const { generation, reason, continuation } = delivery.reconcile;
  if (!await state.beginReconciliation(delivery.profile, generation, delivery.id)) {
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
    const message = `${action}: ${stage}; reconciliation stopped and needs a fresh manual request`;
    await state.recordReconciliationFailure(delivery.profile, generation, message);
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
      continuation: "stopped; request a fresh reconciliation manually after addressing the cause",
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
    snapshot = continuation?.phase === "calendar" ? undefined : await reconciler.reconcile(delivery.profile, continuation);
  } catch (error) {
    if (!isMutationBudgetExhausted(error)) throw error;
    return deferForMutationBudget("mapped_state", { budgetError: serializeError(error) });
  }

  if (snapshot?.continuation) {
    try {
      await state.addReconciliationProgress(delivery.profile, generation, snapshot.counts, {
        phase: continuation?.phase || "mapped", sequence: continuation?.sequence || 0, deliveryId: delivery.id,
        afterTaskId: continuation?.afterTaskId, afterEventId: continuation?.afterEventId,
        observedAt: new Date().toISOString(),
      });
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

  if (snapshot) await state.addReconciliationProgress(delivery.profile, generation, snapshot.counts, {
    phase: continuation?.phase || "mapped", sequence: continuation?.sequence || 0, deliveryId: delivery.id,
    afterTaskId: continuation?.afterTaskId, afterEventId: continuation?.afterEventId,
    observedAt: new Date().toISOString(),
  });
  if (mutationBudget.exhausted) return deferForMutationBudget("mapped_state");

  const calendarRecovery = await reconcileUnmappedCalendar(
    delivery.profile,
    state,
    clientFactory,
    mutationBudget,
    continuation?.phase === "calendar" ? continuation : { phase: "calendar", sequence: continuation?.sequence || 0 },
  );
  await state.addReconciliationProgress(delivery.profile, generation, {
    calendar_scanned: calendarRecovery.scanned,
    calendar_imported: calendarRecovery.imported,
    calendar_rebound: calendarRecovery.rebound,
    calendar_conflicts: calendarRecovery.conflicts,
    calendar_blocked: calendarRecovery.blocked,
    calendar_skipped: calendarRecovery.skipped,
    provider_mutations: calendarRecovery.providerMutations,
  }, {
    phase: "calendar", sequence: continuation?.sequence || 0, deliveryId: delivery.id,
    afterTaskId: continuation?.afterTaskId, afterEventId: continuation?.afterEventId,
    observedAt: new Date().toISOString(),
  });

  if (calendarRecovery.continuation) {
    try {
      const continuation = { ...calendarRecovery.continuation, phase: "calendar" as const };
      const next = await enqueueReconciliationContinuation(delivery, state, continuation);
      await state.audit(delivery.profile, "reconciliation_chunk_queued", {
        deliveryId: delivery.id, generation, reason, continuation,
        nextDeliveryId: next.id, phase: "calendar", calendarRecovery,
      });
      return { continuationRequired: false, continuationQueued: true };
    } catch (error) {
      return deferContinuation("reconciliation_calendar_chunk_enqueue_deferred", "calendar_snapshot", {
        calendarRecovery, enqueueError: serializeError(error),
      });
    }
  }

  if (calendarRecovery.mutationCapReached || mutationBudget.exhausted) {
    return deferForMutationBudget("calendar_snapshot", { calendarRecovery });
  }
  if (calendarRecovery.blocked > 0) {
    return deferContinuation("reconciliation_calendar_snapshot_circuit_deferred", "calendar_snapshot", { calendarRecovery });
  }

  const aggregate = (await state.getReconciliationState(delivery.profile))?.result || {};
  const unresolved = (aggregate.conflict || 0) + (aggregate.blocked || 0)
    + (aggregate.calendar_conflicts || 0) + (aggregate.calendar_blocked || 0);
  await state.completeReconciliation(delivery.profile, generation, unresolved, aggregate);
  log("reconciliation_completed", {
    ...deliverySummary(delivery),
    reason,
    calendarRecovery,
    mutationBudget: mutationBudget.snapshot(),
    durationMs: Date.now() - startedAt,
  });
  return { continuationRequired: false };
}

async function deliverReconciliationOutcome(state: StateRepository, manual: ManualInterventionService, profile: Profile, generation: string): Promise<void> {
  const current = await state.getReconciliationOutcome(profile, generation);
  if (!current?.notificationPending || !manual.enabled) return;
  try {
    await deliverPendingReconciliationOutcome(state, manual, current);
  } catch (error) {
    log("reconciliation_outcome_notification_failed", { profile, generation, error: serializeError(error) });
  }
}

async function deliverRepairOutcome(manual: ManualInterventionService, operationId: string): Promise<void> {
  const store = new ReviewStore();
  const operation = await store.getOperation(operationId);
  if (!operation?.notificationPending) return;
  const reviewCase = await store.getCase(operation.preview.intent.caseId);
  const decisionId = reviewCase?.decision?.decisionId;
  const decision = decisionId ? await new ManualDecisionStore().get(decisionId) : undefined;
  const status = operation.status === "succeeded" ? "Succeeded"
    : operation.status === "needs_review" ? "Needs review" : "Failed";
  const text = operation.notificationText || status + ": " + (operation.verified?.length || 0) + " pairs verified"
    + (operation.error ? ". " + operation.error : "");
  const replyTs = await manual.deliverReconciliationOutcome(
    decision?.slackChannelId,
    decision?.slackMessageTs,
    operation.notificationReplyTs,
    text,
  );
  await store.completeNotification(operation.id, replyTs);
}

export const handler: SQSHandler = async (event, context: Context) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const startedAt = Date.now();
    let delivery: Delivery | undefined;
    let state: StateRepository | undefined;
    let manual: ManualInterventionService | undefined;
    let releaseWriterLease: (() => Promise<void>) | undefined;
    let meaningfulMutation = false;
    let calendarMutationBlocked = false;
    let suppressCompletionReceipt = false;
    try {
      delivery = JSON.parse(record.body) as Delivery;
      state = new StateRepository();
      if (process.env.ERASURE_PROTOCOL_VERSION === "1") {
        for (let attempt = 0; attempt < 3 && !releaseWriterLease; attempt++) {
          const currentErasureEpoch = await getErasureEpoch(delivery.profile);
          if ((delivery.erasureEpoch ?? 0) !== currentErasureEpoch) {
            logEvent("stale_erasure_epoch_delivery_dropped", { profile: delivery.profile, deliveryEpoch: delivery.erasureEpoch ?? 0, currentEpoch: currentErasureEpoch });
            break;
          }
          try {
            releaseWriterLease = await acquireErasureProtocolLease(
              delivery.profile,
              "writer",
              `${context.awsRequestId}:${record.messageId}`,
              currentErasureEpoch,
            );
          } catch (error) {
            if (!(error instanceof ErasureEpochChangedError) || attempt === 2) throw error;
          }
        }
        if (!releaseWriterLease) {
          continue;
        }
      }
      // Drop keyed erased-task webhooks before any delivery receipt, log with
      // provider identity, audit, repair, or state write. The profile writer
      // lease above remains held until the finally block releases it.
      // An unknown identity is never treated as proof of admission.
      if(delivery.kind==="todoist"&&replayAdmissionEnabled()) {
        let taskId:string|undefined;
        try {
          const parsed=JSON.parse(delivery.body) as TodoistWebhookPayload;
          taskId=parsed.event_data?.id;
        } catch { throw new ErasureReplayUnavailableError("Malformed Todoist webhook under replay admission"); }
        if(typeof taskId!=="string"||!taskId.length)
          throw new ErasureReplayUnavailableError("Todoist webhook missing its task identity");
        try {
          await assertReplayAdmission({profile:delivery.profile,taskId});
        } catch(error) {
          if(!(error instanceof ErasureReplayBlockedError))throw error;
          logEvent("erased_identity_delivery_suppressed",{profile:delivery.profile,kind:"todoist"});
          continue;
        }
      }
      manual = new ManualInterventionService();
      const identityRefs = { taskIds: new Set<string>(), eventIds: new Set<string>(), seriesIds: new Set<string>(), generation: delivery.reconcile?.generation };
      const collectIdentityRefs = (value: unknown, field = ""): void => {
        if (Array.isArray(value)) {
          if (field === "candidateTaskIds" || field === "taskIds") for (const id of value) if (typeof id === "string") identityRefs.taskIds.add(id);
          if (field === "candidateEventIds" || field === "eventIds") for (const id of value) if (typeof id === "string") identityRefs.eventIds.add(id);
          for (const item of value) collectIdentityRefs(item, field);
          return;
        }
        if (!value || typeof value !== "object") return;
        for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
          if (typeof item === "string" && ["taskId", "providerTaskId", "linkedTaskId", "ownerTaskId", "discardedTaskId", "retainedTaskId"].includes(name)) identityRefs.taskIds.add(item);
          if (typeof item === "string" && ["eventId", "providerEventId", "masterEventId", "activeInstanceId", "occurrenceId", "selectedEventId"].includes(name)) identityRefs.eventIds.add(item);
          if (typeof item === "string" && name === "seriesId") identityRefs.seriesIds.add(item);
          collectIdentityRefs(item, name);
        }
      };
      if (delivery.kind === "todoist") {
        try { collectIdentityRefs(JSON.parse(delivery.body).event_data); } catch { /* malformed deliveries are retained for operator review */ }
      }
      if (delivery.kind === "orphan" && delivery.orphan) collectIdentityRefs(delivery.orphan);
      if (delivery.manual?.targetId) {
        if (delivery.manual.targetType === "task") identityRefs.taskIds.add(delivery.manual.targetId);
        if (delivery.manual.targetType === "event") identityRefs.eventIds.add(delivery.manual.targetId);
      }
      const markCompleted = () => suppressCompletionReceipt ? Promise.resolve() : state!.markDeliveryCompleted(delivery!.id, delivery!.profile, delivery!.kind, {
        taskIds: [...identityRefs.taskIds], eventIds: [...identityRefs.eventIds],
        seriesIds: [...identityRefs.seriesIds], generation: identityRefs.generation,
      });

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
        if (action === "todoist_erased_item_replay_suppressed") {
          suppressCompletionReceipt = true;
          identityRefs.taskIds.clear();
          identityRefs.eventIds.clear();
          identityRefs.seriesIds.clear();
        }
        collectIdentityRefs(detail);
        await audit(profile, action, detail);
        if (delivery && action !== "todoist_erased_item_replay_suppressed") {
          const observedCase = await manual?.observeAudit(delivery, profile, action, detail);
          if (delivery.kind === "reconcile" && delivery.reconcile?.generation) {
            try {
              let linkedCase = observedCase;
              if (!linkedCase?.caseId) {
                try { linkedCase = await state!.getConflictIncidentCase(profile, action, detail) || linkedCase; }
                catch (error) {
                  log("reconciliation_case_link_lookup_failed", { profile, generation:delivery.reconcile.generation,
                    deliveryId:delivery.id, action, error:serializeError(error) });
                }
              }
              linkedCase ||= { caseStatus: "detector_unavailable" };
              await state!.recordReconciliationDiagnostic(profile, delivery.reconcile.generation, delivery.id, action, detail,
                linkedCase);
            } catch (error) {
              log("reconciliation_item_diagnostic_persist_failed", {
                profile, generation: delivery.reconcile.generation, deliveryId: delivery.id, action,
                error: serializeError(error),
              });
            }
          }
        }
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
        await markCompleted();
        log("manual_delivery_completed", {
          awsRequestId: context.awsRequestId,
          durationMs: Date.now() - startedAt,
          delivery: deliverySummary(delivery),
        });
        continue;
      }

      if (delivery.kind === "reconcile") {
        const reconciliation = await processReconciliation(delivery, state);
        if (!reconciliation.continuationRequired && !reconciliation.continuationQueued && delivery.reconcile?.generation) {
          const current = await state.getReconciliationState(delivery.profile);
          if (current?.generation === delivery.reconcile.generation) {
            const pending = current.pendingRefreshRefs || [];
            const followUp = current.followUpRefreshRefs || [];
            const followUpKeys = new Set(followUp.map(ref => `${ref.profile}:${ref.side}:${ref.id}`));
            // A ref requested after this reconciliation started may also be in
            // this generation. Keep its marker intact so the required fresh
            // pass can observe it even if this run already passed its cursor.
            const clearNow = pending.filter(ref => !followUpKeys.has(`${ref.profile}:${ref.side}:${ref.id}`));
            if(clearNow.length) await state.clearPendingRefresh(clearNow);
            const refreshCandidates = [...new Map([...pending,...followUp].map(ref=>[`${ref.profile}:${ref.side}:${ref.id}`,ref])).values()];
            const stillPending = refreshCandidates.length ? await state.pendingRefreshRefs(refreshCandidates) : [];
            const byProfile = new Map<Profile,typeof stillPending>();
            for(const ref of stillPending){const group=byProfile.get(ref.profile)||[];group.push(ref);byProfile.set(ref.profile,group);}
            for(const [profile,refs] of byProfile){
              const requested=await queuePendingRefresh(state,profile,refs);
              if(requested.enqueueError) log("pending_refresh_enqueue_deferred",{profile,enqueueError:requested.enqueueError,generation:requested.generation,referenceCount:refs.length});
            }
          }
          await deliverReconciliationOutcome(state, manual, delivery.profile, delivery.reconcile.generation);
        }
        if (!reconciliation.continuationRequired) {
          await markCompleted();
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

      if (delivery.kind === "repair") {
        if (!delivery.repair?.operationId) throw new Error("Repair delivery is missing its operation ID");
        const result = await new ReviewEngine().execute(delivery.repair.operationId);
        if (result.status === "succeeded" || result.status === "needs_review" || result.status === "failed") {
          await deliverRepairOutcome(manual, result.id);
          await markCompleted();
        }
        log("repair_delivery_completed", { awsRequestId:context.awsRequestId, status:result.status, operationId:result.id });
        continue;
      }

      if (delivery.kind === "todoist" && await manual.interceptTodoistDeletion(delivery, state)) {
        await markCompleted();
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
        log("calendar_delivery_deferred_circuit_open", {
          awsRequestId: context.awsRequestId,
          delivery: deliverySummary(delivery),
          reconciliationRequired: true,
          syncTokenAdvanced: false,
        });
        await manual.alertReconciliationNeeded(
          delivery.profile, `circuit:${delivery.id}`, undefined,
          "Calendar changes were deferred because the mutation circuit is open. Request reconciliation manually after the circuit cools down.",
        );
        await markCompleted();
        continue;
      }

      // An ambiguous linked Calendar identity is not resolved by this delivery.
      // Let the existing failure/retry/quarantine flow retain the original
      // payload (including deletes), rather than acknowledging lost work.
      await new OrphanRecoveringSynchronizer(state, scheduleOrphan).process(delivery);

      if (delivery.kind === "calendar" && delivery.headers["x-calendar-sync-cursor-expired"] === "true") {
        await state.audit(delivery.profile, "calendar_sync_cursor_expired_reconciliation_needed", { deliveryId: delivery.id });
        await manual.alertReconciliationNeeded(
          delivery.profile,
          `cursor:${delivery.id}`,
          undefined,
          "The Calendar incremental sync cursor expired. The event batch was baselined, which cannot detect earlier missed changes. Request a guarded reconciliation manually.",
        );
      }

      if (delivery.kind === "calendar" && calendarMutationBlocked) {
        await manual.alertReconciliationNeeded(
          delivery.profile, `blocked:${delivery.id}`, undefined,
          "A Calendar event could not be repaired because the mutation circuit opened, and the sync cursor was withheld. Request a guarded reconciliation manually after the circuit cools down.",
        );
      }

      if (delivery.kind === "calendar" || delivery.kind === "todoist") log("incremental_sync_completed", {
        awsRequestId: context.awsRequestId, delivery: deliverySummary(delivery), meaningfulMutation,
        baselineRecovery: delivery.kind === "calendar" && !hadCalendarToken, calendarMutationBlocked,
      });

      await markCompleted();
      log("delivery_completed", {
        awsRequestId: context.awsRequestId,
        durationMs: Date.now() - startedAt,
        delivery: deliverySummary(delivery),
      });
    } catch (error) {
      // Fence/lease acquisition failures happen before this invocation is an
      // authorized writer. Do not let generic error reporting mutate state
      // outside the profile fence.
      const mayWriteFailureState = process.env.ERASURE_PROTOCOL_VERSION !== "1" || !!releaseWriterLease;
      if (!mayWriteFailureState) {
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      // The suppression audit is intentionally identity-free. If its write
      // fails, generic incident reporting would persist the webhook task ID
      // and recreate the erased identity in DynamoDB. Leave the message for
      // retry without any secondary state writes or notifications.
      if (suppressCompletionReceipt) {
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      if (delivery?.kind === "reconcile" && delivery.reconcile?.generation && state) {
        await state.recordReconciliationFailure(
          delivery.profile,
          delivery.reconcile.generation,
          error instanceof Error ? error.message : String(error),
          error instanceof ReconciliationItemError ? {
            category: error.providerReason || (error.status ? `provider_http_${error.status}` : "provider_item_failure"),
            stage: error.stage, status: error.status, taskId: error.taskId, eventId: error.eventId, seriesId: error.seriesId,
          } : undefined,
        ).catch((stateError: unknown) => {
          console.error(JSON.stringify({
            service: "todoist-calendar-sync-worker",
            event: "reconciliation_failure_state_write_failed",
            delivery: deliverySummary(delivery),
            error: serializeError(stateError),
          }));
        });
        if (manual) await deliverReconciliationOutcome(state, manual, delivery.profile, delivery.reconcile.generation).catch((notifyError: unknown) => {
          log("reconciliation_outcome_notification_retry_deferred", { profile: delivery?.profile, generation: delivery?.reconcile?.generation, error: serializeError(notifyError) });
        });
      }

      // Reconciliation already has a run-level outcome. Create an actionable
      // review incident only when the failing item is actually identified.
      if (delivery?.kind !== "reconcile" || error instanceof ReconciliationItemError) await manual?.reportDeliveryFailure(delivery, error).catch((manualError: unknown) => {
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
    } finally {
      if (releaseWriterLease) {
        try {
          await releaseWriterLease();
        } catch (error) {
          // A retained lease blocks erasure until an operator can prove this
          // invocation ended. Never treat a failed release as a drained writer.
          console.error(JSON.stringify({
            service: "todoist-calendar-sync-worker",
            event: "erasure_writer_lease_release_failed",
            awsRequestId: context.awsRequestId,
            deliveryId: delivery?.id,
            profile: delivery?.profile,
            error: serializeError(error),
          }));
          if (!failures.some((failure) => failure.itemIdentifier === record.messageId)) {
            failures.push({ itemIdentifier: record.messageId });
          }
        }
      }
    }
  }
  return { batchItemFailures: failures };
};
