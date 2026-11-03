import type { ReviewCase } from "./review-types.js";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** Only recorded exact provider IDs; never infer ownership from title or due date. */
export function reviewCaseEvidenceIds(item: ReviewCase): { taskIds: string[]; eventIds: string[] } {
  const context = item.decision?.context || {};
  const candidates = Array.isArray(context.candidates)
    ? context.candidates.map(entry => (entry as { id?: unknown } | null)?.id) : [];
  const mapping = item.decision?.mappingSnapshot;
  const tasks = [item.taskId, item.decision?.taskId, mapping?.taskId, context.providerTaskId, context.taskId,
    context.masterTaskId, ...strings(context.candidateTaskIds), ...candidates];
  const events = [item.eventId, item.decision?.eventId, mapping?.eventId, mapping?.masterEventId, mapping?.activeInstanceId, item.decision?.masterEventId,
    item.decision?.activeInstanceId, context.providerEventId, context.eventId,
    context.masterEventId, context.activeInstanceId, ...strings(context.candidateEventIds)];
  return {
    taskIds: [...new Set(tasks.filter((id): id is string => typeof id === "string" && id.length > 0))],
    eventIds: [...new Set(events.filter((id): id is string => typeof id === "string" && id.length > 0))],
  };
}
