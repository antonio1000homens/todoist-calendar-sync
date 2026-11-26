const mutationCounters = ["todoist_to_calendar", "calendar_to_todoist", "created", "removed", "moved",
  "provider_mutations", "calendar_imported", "calendar_rebound"];

export function isCleanReconciliationPass(pass, passNumber) {
  if (pass.status !== "succeeded" || pass.unresolved !== 0 || !pass.counts) return false;
  const recurrenceOutcomes = ["converged", "repaired", "unsupported", "excluded", "blocked", "stale", "unverified"]
    .map(outcome => Number(pass.counts[`recurrence_${outcome}`] || 0));
  const recurrenceOutcomeCount = recurrenceOutcomes.reduce((total, count) => total + count, 0);
  if (Number(pass.counts.conflict || 0) || Number(pass.counts.blocked || 0)
    || Number(pass.counts.calendar_conflicts || 0) || Number(pass.counts.calendar_blocked || 0)
    || Number(pass.counts.recurrence_blocked || 0) || Number(pass.counts.recurrence_stale || 0)
    || Number(pass.counts.recurrence_unverified || 0)
    || Number(pass.counts.recurrence_reported || 0) !== 1
    || recurrenceOutcomes.some(count => !Number.isInteger(count) || count < 0)
    || Number(pass.counts.recurrence_total || 0) !== recurrenceOutcomeCount) return false;
  return passNumber !== 2 || (mutationCounters.every(key => Number(pass.counts[key] || 0) === 0)
    && Number(pass.counts.recurrence_repaired || 0) === 0);
}
