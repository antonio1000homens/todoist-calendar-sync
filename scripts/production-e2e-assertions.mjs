/** Return the single active machine mapping for this project/task pair.
 * Live acceptance must fail on stale or duplicate mappings instead of
 * accepting whichever entry happens to appear first in provider pagination. */
export function uniqueProjectTaskMapping(index, projectId, taskId) {
  const entries = [...new Map((index?.parsed || [])
    .filter((entry) => entry.payload.projectId === projectId && entry.payload.taskId === taskId)
    .map((entry) => [entry.comment.id, entry])).values()];
  if (entries.length > 1) {
    throw new Error(`Expected one active mapping comment for task ${taskId}; found ${entries.length}`);
  }
  return entries[0];
}

export function uniqueProjectTaskMappingForEvent(index, projectId, eventId, taskId) {
  const entry = uniqueProjectTaskMapping(index, projectId, taskId);
  if (!entry) return undefined;
  return entry.payload.eventId === eventId || entry.payload.masterEventId === eventId
    ? entry : undefined;
}

export function uniqueProjectEventMapping(index, projectId, eventId) {
  const entries = [...new Map((index?.parsed || [])
    .filter((entry) => entry.payload.projectId === projectId
      && (entry.payload.eventId === eventId || entry.payload.masterEventId === eventId))
    .map((entry) => [entry.comment.id, entry])).values()];
  if (entries.length > 1) {
    throw new Error(`Expected at most one active mapping comment for event ${eventId}; found ${entries.length}`);
  }
  return entries[0];
}

export function unsupportedCalendarRecurrencePreserved({
  readback,
  expectedEventId,
  expectedRule,
  tasks,
  fixtureTitle,
  mapping,
}) {
  return Boolean(readback?.id && readback.id === expectedEventId && readback.status === "confirmed"
    && Array.isArray(expectedRule) && expectedRule.length > 0
    && Array.isArray(readback.recurrence)
    && JSON.stringify(readback.recurrence) === JSON.stringify(expectedRule)
    && !tasks.some((task) => task.content === fixtureTitle)
    && !mapping);
}
