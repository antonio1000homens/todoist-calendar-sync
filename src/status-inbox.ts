import { ManualDecisionStore, SlackManualNotifier, type ManualDecision } from "./manual-intervention.js";
import { defaultProviderClientFactory } from "./mutation-budget.js";
import { StateRepository } from "./repository.js";
import type { Delivery, Profile } from "./types.js";

interface DecisionStoreForStatus {
  get(decisionId: string): Promise<ManualDecision | undefined>;
  finish(decisionId: string, status: "resolved" | "stale" | "cancelled" | "expired", resolution: string, slackUserId?: string): Promise<void>;
  listPending(profile?: Profile): Promise<ManualDecision[]>;
}

interface DecisionNotifierForStatus {
  postDecision(decision: ManualDecision): Promise<void>;
  postText(text: string, channel?: string): Promise<void>;
}

export interface DecisionRenderSummary {
  attempted: number;
  rendered: number;
  failedDecisionIds: string[];
}

async function providerAuthFailurePersists(profile: Profile): Promise<boolean | undefined> {
  try {
    const pair = await defaultProviderClientFactory(profile);
    const probe = async (read: () => Promise<unknown>): Promise<boolean> => {
      try {
        await read();
        return false;
      } catch (error) {
        const status = Number((error as { status?: number }).status);
        if ([401, 403].includes(status)) return true;
        throw error;
      }
    };

    const [calendarAuthFailed, todoistAuthFailed] = await Promise.all([
      probe(() => pair.calendar.findByTodoistTaskId("__todoist_calendar_sync_auth_probe__")),
      probe(() => pair.todoist.listTasks()),
    ]);
    return calendarAuthFailed || todoistAuthFailed;
  } catch (error) {
    console.warn(JSON.stringify({
      service: "todoist-calendar-sync-manual",
      event: "provider_auth_revalidation_inconclusive",
      profile,
      error: error instanceof Error ? error.message : String(error),
    }));
    return undefined;
  }
}

export function formatDecisionRenderSummary(render: DecisionRenderSummary, profile?: Profile): string {
  const failedText = render.failedDecisionIds.length
    ? `\nFailed decision IDs:\n${render.failedDecisionIds.map((id) => `• \`${id}\``).join("\n")}`
    : "";
  const icon = render.rendered === render.attempted ? "✅" : "⚠️";
  const scope = profile ? ` — ${profile}` : "";
  return `${icon} Decision inbox render${scope}: *${render.rendered}/${render.attempted}* cards published.${failedText}`;
}

export async function renderPendingDecisionCards(
  decisions: ManualDecision[],
  channel: string | undefined,
  store: DecisionStoreForStatus,
  notifier: DecisionNotifierForStatus,
): Promise<DecisionRenderSummary> {
  const failedDecisionIds: string[] = [];
  let rendered = 0;

  for (const decision of decisions) {
    let before = decision;
    let beforeReadError: string | undefined;
    try {
      before = await store.get(decision.decisionId) || decision;
    } catch (error) {
      beforeReadError = error instanceof Error ? error.message : String(error);
    }

    console.log(JSON.stringify({
      service: "todoist-calendar-sync-manual",
      event: "status_decision_render_attempt",
      decisionId: decision.decisionId,
      decisionType: decision.type,
      targetChannel: channel,
      previousSlackMessageTs: before.slackMessageTs,
      beforeReadError,
    }));

    try {
      await notifier.postDecision({ ...decision, slackChannelId: channel });
      const after = await store.get(decision.decisionId);
      const posted = Boolean(after?.slackMessageTs && after.slackMessageTs !== before.slackMessageTs);
      if (!posted) {
        failedDecisionIds.push(decision.decisionId);
        console.error(JSON.stringify({
          service: "todoist-calendar-sync-manual",
          event: "status_decision_render_unconfirmed",
          decisionId: decision.decisionId,
          decisionType: decision.type,
          targetChannel: channel,
          previousSlackMessageTs: before.slackMessageTs,
          currentSlackMessageTs: after?.slackMessageTs,
          beforeReadError,
        }));
        continue;
      }
      rendered += 1;
      console.log(JSON.stringify({
        service: "todoist-calendar-sync-manual",
        event: "status_decision_render_succeeded",
        decisionId: decision.decisionId,
        decisionType: decision.type,
        targetChannel: channel,
        slackMessageTs: after?.slackMessageTs,
        beforeReadError,
      }));
    } catch (error) {
      failedDecisionIds.push(decision.decisionId);
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-manual",
        event: "status_decision_render_failed",
        decisionId: decision.decisionId,
        decisionType: decision.type,
        targetChannel: channel,
        beforeReadError,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return { attempted: decisions.length, rendered, failedDecisionIds };
}

export async function processStatusInbox(delivery: Delivery, state: StateRepository): Promise<void> {
  const manual = delivery.manual;
  if (!manual || manual.command !== "show_status") throw new Error("processStatusInbox requires show_status manual delivery");

  const store = new ManualDecisionStore();
  const notifier = new SlackManualNotifier(store);
  const [reconcile, decisions] = await Promise.all([
    state.getReconciliationState(delivery.profile),
    store.listPending(delivery.profile),
  ]);

  const actionable: ManualDecision[] = [];
  let retiredAuthDecisions = 0;
  for (const decision of decisions) {
    if (decision.type === "operational_provider_auth") {
      const stillFailing = await providerAuthFailurePersists(decision.profile);
      if (stillFailing === false) {
        await store.finish(
          decision.decisionId,
          "stale",
          "provider authentication recovered before status rendering",
          "status-revalidation",
        ).catch(() => undefined);
        retiredAuthDecisions += 1;
        continue;
      }
    }
    actionable.push(decision);
  }

  const channel = manual.slackChannelId;
  const retiredNote = retiredAuthDecisions
    ? `\nRecovered provider-auth alerts cleared: ${retiredAuthDecisions}`
    : "";
  const reconciliationLine = !reconcile
    ? "Reconciliation: no state available"
    : reconcile.pending
      ? `Reconciliation: ${reconcile.reason === "scheduled" ? "scheduled sync queued/in progress — no action required" : `${reconcile.reason || "sync"} queued/in progress`} (last completed ${reconcile.lastCompletedAt || "never"})`
      : `Reconciliation: up to date (last completed ${reconcile.lastCompletedAt || "never"})`;
  const decisionLine = actionable.length
    ? `Action required: ${actionable.length} manual decision${actionable.length === 1 ? "" : "s"} pending — interactive cards follow.`
    : "Action required: none.";

  await notifier.postText(
    `*Calendar ↔ Todoist status — ${delivery.profile}*\n${reconciliationLine}\n${decisionLine}${retiredNote}`,
    channel,
  );

  if (!actionable.length) return;

  const render = await renderPendingDecisionCards(actionable, channel, store, notifier);
  await notifier.postText(formatDecisionRenderSummary(render, delivery.profile), channel);
}
