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
