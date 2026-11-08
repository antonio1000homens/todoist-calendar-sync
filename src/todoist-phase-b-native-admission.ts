/**
 * #290 Phase B: independent admission for NEW Todoist-owned recurrence masters.
 *
 * This function is deliberately pure and read-only. It builds an admission
 * plan for the guarded provider writer, NOT permission to upgrade historical
 * rolling mappings or an existing Calendar series. The reconciler must never
 * invent the initial DTSTART from an already advanced Todoist due date.
 */
import {
  todoistPhaseBCandidate, type TodoistPhaseBFamily,
  type TodoistPhaseBAnchor,
} from "./todoist-calendar-phase-b.js";
import { classifyCalendarRule, compareOccurrenceSemantics } from "./recurrence-semantics.js";
import { todoistRecurrenceKey } from "./todoist-recurrence.js";
import type { TodoistTask } from "./types.js";

export interface TodoistPhaseBInitialEvidence {
  /** Current authenticated Todoist task after webhook admission. */
  source: TodoistTask;
  /** A separately GET-fetched, current version of that exact task. */
  providerReadback: TodoistTask;
  eventName: string;
  /** Original signed item:added ingress receipt. */
  receivedAt: string;
  /** Exact configured Todoist project in the current sync profile. */
  projectId: string;
  calendarTimeZone: string;
  todoistTimeZone: string;
  /** True when a mapping already exists, including rolling history. */
  hasMapping: boolean;
  /** True when a Calendar provider alias for this task already exists. */
  hasCalendarAlias: boolean;
  /** Fail closed for pending replacement/recovery/series split. */
  hasPendingRecovery: boolean;
}

export type TodoistPhaseBAdmission =
  | { admitted: false; reason: string; family?: TodoistPhaseBFamily }
  | { admitted: true; reason: "new_task_anchor_verified"; family: TodoistPhaseBFamily;
      rule: string; anchor: TodoistPhaseBAnchor };

function observedDue(task: TodoistTask): string | undefined {
  return task.due?.datetime || task.due?.date;
}

/**
 * The only safe automatic anchor evidence for initial opt-in is a genuinely
 * recent item:added, with no counterpart and a fresh independent Todoist GET.
 * Historical data repair, imports, edits and advanced recurrences stay rolling.
 */
export function admitNewTodoistPhaseBNative(
  e: TodoistPhaseBInitialEvidence,
): TodoistPhaseBAdmission {
  const reject = (reason: string): TodoistPhaseBAdmission => ({ admitted: false, reason });
  const task = e.source;
  const current = e.providerReadback;
  if (e.eventName !== "item:added" || e.hasMapping || e.hasCalendarAlias
    || e.hasPendingRecovery)
    return reject("only_new_unmapped_item_added");
  if (!task.id || task.id !== current.id
    || !e.projectId || task.project_id !== e.projectId
    || current.project_id !== e.projectId
    || task.is_deleted || current.is_deleted || task.is_completed || current.is_completed
    || task.completed_at || current.completed_at)
    return reject("source_identity_or_profile_not_verified");
  if (!e.calendarTimeZone || e.calendarTimeZone !== e.todoistTimeZone)
    return reject("timezone_not_verified");
  // The original item-added occurrence is independently supported by its
  // fresh Todoist updated_at, rather than falsely adopting an old due date.
  const observedAt = Date.parse(e.receivedAt);
  const createdAt = Date.parse(task.updated_at || "");
  const currentAt = Date.parse(current.updated_at || "");
  if (![observedAt, createdAt, currentAt].every(Number.isFinite)
    || createdAt > observedAt + 30_000 || observedAt - createdAt > 120_000
    || currentAt < createdAt || currentAt > observedAt + 30_000)
    return reject("fresh_creation_provenance_missing");
  const due = observedDue(task);
  const liveDue = observedDue(current);
  if (!due || due !== liveDue || !task.due?.is_recurring || !current.due?.is_recurring
    || !todoistRecurrenceKey(task) || todoistRecurrenceKey(task) !== todoistRecurrenceKey(current))
    return reject("todoist_source_rule_or_due_changed");
  // Initial native admission is deliberately all-day only. Timed Phase B
  // requires independent timezone and DST provider evidence in the writer.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due))
    return reject("timed_phase_b_not_enabled");
  if (due < e.receivedAt.slice(0, 10))
    return reject("overdue_original_anchor_not_verified");
  const anchor: TodoistPhaseBAnchor = {
    start: due, source: "verified_original_schedule", timeZone: e.calendarTimeZone,
  };
  const candidate = todoistPhaseBCandidate(current, anchor);
  if (!candidate.family || !candidate.semantic || !candidate.candidateRrule
    || candidate.reason !== "provider_readback_required")
    return { admitted: false, reason: candidate.reason, ...(candidate.family ? {family:candidate.family} : {}) };

  // An anchored Todoist candidate and its canonical Google rule must be
  // equivalent in a bounded series, not just have matching RRULE strings.
  const reverse = classifyCalendarRule(candidate.candidateRrule, {
    start: due, timeZone: e.calendarTimeZone,
  });
  if (!reverse.semantic || !compareOccurrenceSemantics(
    candidate.semantic, reverse.semantic,
  ).equivalent) return { admitted: false, reason: "roundtrip_semantics_mismatch", family: candidate.family };

  return { admitted: true, reason: "new_task_anchor_verified",
    family: candidate.family, rule: candidate.candidateRrule, anchor };
}
