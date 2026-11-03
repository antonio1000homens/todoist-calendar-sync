/**
 * Read-only Phase B provider validation for #290.
 *
 * No production synchronizer calls this module. In particular, it MUST NOT
 * complete Todoist tasks or POST/PUT/PATCH/DELETE Calendar events: an operator
 * or isolated fixture supplies genuine before/after completion observations.
 * This collector independently re-reads the persisted resources and inventories
 * Calendar exceptions before accepting the Phase B semantic verifier's result.
 */
import { occurrenceDates } from "./recurrence-semantics.js";
import {
  todoistPhaseBCandidate, verifyTodoistPhaseBReadback,
  type TodoistPhaseBAnchor, type TodoistPhaseBResult,
} from "./todoist-calendar-phase-b.js";
import { todoistRecurrenceKey } from "./todoist-recurrence.js";
import type { GoogleCalendar, Todoist } from "./providers.js";
import type { TodoistTask } from "./types.js";

export interface PhaseBValidationSource {
  /** Explicit task and profile identity, not a title or same-date match. */
  taskId: string;
  todoistProjectId: string;
  masterId: string;
  /** Recorded and independently verified original recurrence DTSTART. */
  anchor: TodoistPhaseBAnchor;
  /** Actual Todoist provider snapshots immediately before and after completion. */
  beforeCompletion: TodoistTask;
  afterCompletion: TodoistTask;
}

export interface PhaseBReadOnlyProviders {
  todoist: Pick<Todoist, "getTask">;
  calendar: Pick<GoogleCalendar,
    "getEvent" | "findByTodoistTaskId" | "listInstancesInWindow"
    | "listExplicitSeriesExceptions" | "getTimeZone">;
}

export interface PhaseBReadOnlyAssessment extends TodoistPhaseBResult {
  observations: {
    providerReadback: boolean;
    instanceCount: number;
    explicitExceptionCount: number;
  };
}

function results(result: TodoistPhaseBResult, reason: string, counts = {
  providerReadback: false, instanceCount: 0, explicitExceptionCount: 0,
}): PhaseBReadOnlyAssessment {
  return { ...result, disposition: "rolling_required", reason, observations: counts };
}

function identicalProviderDue(a: TodoistTask, b: TodoistTask): boolean {
  return a.id === b.id && a.project_id === b.project_id
    && a.is_deleted !== true && b.is_deleted !== true
    && a.is_completed !== true && b.is_completed !== true
    && a.due?.is_recurring === true && b.due?.is_recurring === true
    && (a.due?.date || "") === (b.due?.date || "")
    && (a.due?.datetime || "") === (b.due?.datetime || "")
    && (a.due?.timezone || "") === (b.due?.timezone || "")
    && todoistRecurrenceKey(a) === todoistRecurrenceKey(b);
}

function boundWindow(dates: string[]): { from: string; through: string } | undefined {
  if (dates.length < 4) return undefined;
  const start = Date.parse(dates[0] + "T00:00:00Z");
  const end = Date.parse(dates[3] + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  // Two-day margins preserve UTC+14 and UTC-12 local occurrences on both sides
  // of the civil-date boundary. The endpoint remains finite and paginated.
  return {
    from: new Date(start - 2 * 86_400_000).toISOString(),
    through: new Date(end + 3 * 86_400_000).toISOString(),
  };
}

/**
 * Collect fresh, independent readbacks without mutating either provider.
 *
 * This function intentionally cannot establish whether the supplied anchor
 * was originally derived from Todoist history or whether two snapshots were
 * captured around a real completion. The caller must separately substantiate
 * that provenance before acting on a native_exact observation. A successful
 * result is NEVER a write authorization or automatic migration decision.
 */
export async function assessTodoistPhaseBProviders(
  source: PhaseBValidationSource,
  providers: PhaseBReadOnlyProviders,
): Promise<PhaseBReadOnlyAssessment> {
  const proposal = todoistPhaseBCandidate(source.beforeCompletion, source.anchor);
  if (!proposal.family || proposal.reason !== "provider_readback_required" || !proposal.semantic)
    return { ...proposal, observations: {
      providerReadback: false, instanceCount: 0, explicitExceptionCount: 0,
    } };

  const refuse = (reason: string, counts?: PhaseBReadOnlyAssessment["observations"]) =>
    results(proposal, reason, counts);
  if (!source.taskId || !source.todoistProjectId || !source.masterId
    || source.beforeCompletion.id !== source.taskId
    || source.afterCompletion.id !== source.taskId
    || source.beforeCompletion.project_id !== source.todoistProjectId
    || source.afterCompletion.project_id !== source.todoistProjectId)
    return refuse("task_or_profile_identity_unverified");
  if (!identicalProviderDue(
    { ...source.beforeCompletion, due: source.afterCompletion.due },
    source.afterCompletion,
  )) return refuse("completion_snapshot_identity_unverified");

  const sequence = occurrenceDates(proposal.semantic, 4);
  const window = boundWindow(sequence);
  if (!window) return refuse("insufficient_bounded_occurrences");

  try {
    // These are independent provider reads. No synthetic Calendar master or
    // completion progression can be mistaken for persisted provider evidence.
    const latest = await providers.todoist.getTask(source.taskId);
    if (!identicalProviderDue(latest, source.afterCompletion)
      || latest.project_id !== source.todoistProjectId)
      return refuse("todoist_latest_readback_mismatch");

    const [master, linked, exceptions] = await Promise.all([
      providers.calendar.getEvent(source.masterId),
      providers.calendar.findByTodoistTaskId(source.taskId),
      providers.calendar.listExplicitSeriesExceptions(source.masterId),
    ]);
    if (master.id !== source.masterId || linked?.id !== source.masterId)
      return refuse("calendar_identity_or_duplicate_link_unverified");
    if (exceptions.length) return refuse("calendar_explicit_exceptions_present", {
      providerReadback: true, instanceCount: 0, explicitExceptionCount: exceptions.length,
    });

    const isTimed = Boolean(proposal.semantic.localTime);
    let timeZoneVerified = !isTimed;
    if (isTimed) {
      const calendarZone = await providers.calendar.getTimeZone();
      const zone = source.anchor.timeZone;
      timeZoneVerified = Boolean(zone && calendarZone === zone
        && master.start?.timeZone === zone
        && latest.due?.timezone === zone
        && source.beforeCompletion.due?.timezone === zone
        && source.afterCompletion.due?.timezone === zone);
      if (!timeZoneVerified) return refuse("timezone_not_verified");
    }

    const instances = await providers.calendar.listInstancesInWindow(
      source.masterId, window.from, window.through,
    );
    // Explicit exceptions are inventoried separately, while the bounded
    // instance sequence must be confirmed, ordered and exception-free.
    const result = verifyTodoistPhaseBReadback(source.beforeCompletion, source.anchor, {
      beforeCompletion: source.beforeCompletion,
      afterCompletion: source.afterCompletion,
      calendarMaster: master,
      calendarInstances: instances,
      exceptionInventoryComplete: true,
      timeZoneVerified,
    });
    return { ...result, observations: {
      providerReadback: true, instanceCount: instances.length,
      explicitExceptionCount: 0,
    } };
  } catch {
    // Provider 429/5xx, incomplete pagination, revoked access and timeouts all
    // fail closed; no retry or write is performed inside this collector.
    return refuse("provider_readback_failed");
  }
}
