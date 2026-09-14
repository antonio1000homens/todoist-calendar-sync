import {
  createBudgetedClientFactory,
  defaultProviderClientFactory,
  isMutationBudgetExhausted,
  ReconciliationMutationBudget,
  type ProviderClientFactory,
} from "./mutation-budget.js";
import { StateRepository } from "./repository.js";
import { hasCanonicalState, selectCalendarRecurrenceInstance, toTodoistTask } from "./sync.js";
import type { CalendarEvent, Mapping, Profile, ReconciliationContinuation, RecurrenceLink, TodoistTask } from "./types.js";

const MAX_PROVIDER_MUTATIONS = 10;
const DEFAULT_CALENDAR_RECOVERY_CANDIDATE_LIMIT = 20;

export interface CalendarRecoverySummary {
  scanned: number;
  skipped: number;
  imported: number;
  rebound: number;
  conflicts: number;
  blocked: number;
  providerMutations: number;
  mutationCapReached: boolean;
  continuation?: ReconciliationContinuation;
}

function candidateLimit(): number {
  const configured = Number(process.env.TODOIST_CALENDAR_SYNC_RECONCILIATION_CANDIDATE_LIMIT);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CALENDAR_RECOVERY_CANDIDATE_LIMIT;
}

function taskComment(event: CalendarEvent): string {
  return `todoist-calendar-sync\ncalendarEventId=${event.id}\ncalendarUrl=${event.htmlLink || ""}`;
}

function eventPoint(event: CalendarEvent, key: "start" | "end"): string | undefined {
  const point = event[key];
  return point?.dateTime || point?.date;
}

function eventEnded(event: CalendarEvent, now = Date.now()): boolean {
  const end = eventPoint(event, "end") || eventPoint(event, "start");
  if (!end) return false;
  const parsed = Date.parse(end);
  return Number.isFinite(parsed) && parsed < now;
}

function isTodoistOwnedProjection(event: CalendarEvent): boolean {
  const shared = event.extendedProperties?.shared;
  return Boolean(
    shared?.syncSource === "todoist-calendar-sync"
    || shared?.syncRecurrenceOwner === "todoist"
    || shared?.taskId,
  );
}

function recurrenceLink(mapping: Mapping): RecurrenceLink {
  return {
    profile: mapping.profile,
    owner: "calendar",
    seriesId: mapping.seriesId!,
    masterEventId: mapping.masterEventId,
    activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart,
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    updatedAt: mapping.updatedAt,
  };
}

function originalStart(event: CalendarEvent): string | undefined {
  return event.originalStartTime?.dateTime
    || event.originalStartTime?.date
    || event.start?.dateTime
    || event.start?.date;
}

/**
 * Snapshot-style Calendar recovery independent of the incremental sync token.
 * listDelta(undefined) is used only as a read-only full listing here; its
 * nextSyncToken is deliberately ignored so recovery can never advance the
 * incremental cursor.
 *
 * Candidate processing is bounded independently from the provider mutation
 * budget. A mostly-no-op Calendar with many events can otherwise issue many
 * DynamoDB ownership/mapping reads in one tight loop even with Lambda
 * concurrency fixed at one.
 */
export async function reconcileUnmappedCalendar(
  profile: Profile,
  state = new StateRepository(),
  clientFactory: ProviderClientFactory = defaultProviderClientFactory,
  mutationBudget = new ReconciliationMutationBudget(MAX_PROVIDER_MUTATIONS),
  continuation?: ReconciliationContinuation,
  maxCandidates = candidateLimit(),
): Promise<CalendarRecoverySummary> {
  if (continuation && continuation.phase !== "calendar") {
    throw new Error(`Calendar recovery cannot resume continuation phase ${continuation.phase}`);
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("Calendar recovery candidate limit must be a positive integer");
  }

  const startMutationCount = mutationBudget.used;
  const summary: CalendarRecoverySummary = {
    scanned: 0,
    skipped: 0,
    imported: 0,
    rebound: 0,
    conflicts: 0,
    blocked: 0,
    providerMutations: 0,
    mutationCapReached: mutationBudget.exhausted,
  };

  const finishSummary = (): CalendarRecoverySummary => {
    summary.providerMutations = mutationBudget.used - startMutationCount;
    // Preserve a cap detected by a rejected worst-case reservation. In that
    // case used may still be below limit even though continuing is unsafe.
    summary.mutationCapReached = summary.mutationCapReached || mutationBudget.exhausted;
    return summary;
  };

  if (!await state.mutationAllowed(profile)) {
    summary.blocked += 1;
    finishSummary();
    await state.audit(profile, "calendar_snapshot_reconcile_circuit_open", { summary });
    return summary;
  }

  if (mutationBudget.exhausted) {
    finishSummary();
    await state.audit(profile, "calendar_snapshot_reconcile_mutation_budget_exhausted", { summary, mutationBudget: mutationBudget.snapshot() });
    return summary;
  }

  const pair = await createBudgetedClientFactory(mutationBudget, clientFactory)(profile);
  const tasks = await pair.todoist.listTasks();
  const snapshot = await pair.calendar.listDelta();
  const now = Date.now();
  const reservedTaskIds = new Set<string>();

  const canMutate = async (): Promise<boolean> => {
    if (!await state.mutationAllowed(profile)) {
      summary.blocked += 1;
      return false;
    }
    return true;
  };

  const findCanonicalTask = async (event: CalendarEvent): Promise<{ task?: TodoistTask; ambiguous: boolean }> => {
    const matches = tasks.filter((task) => hasCanonicalState(event, task));
    if (matches.length !== 1) return { task: undefined, ambiguous: matches.length > 1 };

    const candidate = matches[0];
    if (reservedTaskIds.has(candidate.id)) return { task: undefined, ambiguous: true };

    const existing = await state.getMappingByTaskAnyProfile(candidate.id);
    if (existing) return { task: undefined, ambiguous: true };

    return { task: candidate, ambiguous: false };
  };

  const createOrBindStandalone = async (event: CalendarEvent): Promise<void> => {
    if (await state.getMappingByEvent(profile, event.id)) {
      summary.skipped += 1;
      return;
    }
    const match = await findCanonicalTask(event);
    if (match.ambiguous) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_unmapped_ambiguous", { eventId: event.id });
      return;
    }

    let task = match.task;
    let created = false;
    if (!task) {
      if (!await canMutate()) return;
      task = await pair.todoist.upsertTask(toTodoistTask(event));
      tasks.push(task);
      await state.recordMutation(profile);
      created = true;
    }
    reservedTaskIds.add(task.id);

    let commentId: string | undefined;
    if (await canMutate()) {
      const existingComment = await pair.todoist.findComment(task.id, event.id);
      const comment = await pair.todoist.upsertComment(task.id, taskComment(event), existingComment?.id);
      commentId = comment.id;
      await state.recordMutation(profile);
    }

    const mapping: Mapping = {
      profile,
      eventId: event.id,
      taskId: task.id,
      projectId: task.project_id,
      commentId,
      updatedAt: new Date().toISOString(),
    };
    await state.putMapping(mapping);
    if (created) summary.imported += 1;
    else summary.rebound += 1;
    await state.audit(profile, created ? "calendar_snapshot_imported_task" : "calendar_snapshot_rebound_mapping", {
      eventId: event.id,
      taskId: task.id,
      commentId,
    });
  };

  const createOrBindSeries = async (master: CalendarEvent): Promise<void> => {
    const seriesId = master.iCalUID || master.id;
    if (await state.getRecurrenceLink(profile, seriesId)) {
      summary.skipped += 1;
      return;
    }
    const instances = await pair.calendar.listInstances(master.id, new Date(now - 24 * 60 * 60_000).toISOString());
    const active = selectCalendarRecurrenceInstance(instances, undefined, now);
    if (!active || active.status === "cancelled" || eventEnded(active, now)) {
      summary.skipped += 1;
      return;
    }
    if (await state.getMappingByEvent(profile, active.id)) {
      summary.skipped += 1;
      return;
    }

    const match = await findCanonicalTask(active);
    if (match.ambiguous) {
      summary.conflicts += 1;
      await state.audit(profile, "calendar_snapshot_recurring_ambiguous", { seriesId, masterEventId: master.id, eventId: active.id });
      return;
    }

    let task = match.task;
    let created = false;
    if (!task) {
      if (!await canMutate()) return;
      task = await pair.todoist.upsertTask(toTodoistTask(active));
      tasks.push(task);
      await state.recordMutation(profile);
      created = true;
    }
    reservedTaskIds.add(task.id);

    const start = originalStart(active);
    const mapping: Mapping = {
      profile,
      eventId: active.id,
      taskId: task.id,
      projectId: task.project_id,
      recurrenceOwner: "calendar",
      seriesId,
      masterEventId: master.id,
      activeInstanceId: active.id,
      originalStart: start,
      activeEffectiveStart: active.start?.dateTime || active.start?.date || start,
      updatedAt: new Date().toISOString(),
    };
    await state.putMapping(mapping);
    await state.putRecurrenceLink(recurrenceLink(mapping));
    if (created) summary.imported += 1;
    else summary.rebound += 1;
    await state.audit(profile, created ? "calendar_snapshot_imported_recurring_task" : "calendar_snapshot_rebound_recurring_mapping", {
      seriesId,
      masterEventId: master.id,
      eventId: active.id,
      taskId: task.id,
    });
  };

  const afterEventId = continuation?.afterEventId;
  const candidates = snapshot.items
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((event) => !afterEventId || event.id > afterEventId);

  for (let index = 0; index < candidates.length; index += 1) {
    const event = candidates[index];
    summary.scanned += 1;
    try {
      if (event.status === "cancelled" || (event.status && event.status !== "confirmed")) {
        summary.skipped += 1;
      } else if (isTodoistOwnedProjection(event) || event.recurringEventId) {
        summary.skipped += 1;
      } else if (event.recurrence?.length) {
        await createOrBindSeries(event);
      } else if (eventEnded(event, now)) {
        summary.skipped += 1;
      } else {
        await createOrBindStandalone(event);
      }
    } catch (error) {
      if (!isMutationBudgetExhausted(error)) throw error;
      summary.mutationCapReached = true;
      await state.audit(profile, "calendar_snapshot_reconcile_mutation_budget_exhausted", {
        eventId: event.id,
        error: error.message,
        mutationBudget: mutationBudget.snapshot(),
      });
      break;
    }

    if (mutationBudget.exhausted) {
      summary.mutationCapReached = true;
      break;
    }

    if (summary.scanned >= maxCandidates && index < candidates.length - 1) {
      summary.continuation = {
        sequence: (continuation?.sequence || 0) + 1,
        phase: "calendar",
        afterEventId: event.id,
      };
      break;
    }
  }

  finishSummary();
  await state.audit(
    profile,
    summary.continuation ? "calendar_snapshot_reconcile_chunk_completed" : "calendar_snapshot_reconcile_completed",
    { summary, mutationBudget: mutationBudget.snapshot() },
  );
  return summary;
}
