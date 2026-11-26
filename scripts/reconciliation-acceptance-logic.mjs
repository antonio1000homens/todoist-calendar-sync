const mutationCounters = ["todoist_to_calendar", "calendar_to_todoist", "created", "removed", "moved",
  "provider_mutations", "calendar_imported", "calendar_rebound"];

export function isCleanReconciliationPass(pass, passNumber) {
  if (pass.status !== "succeeded" || pass.unresolved !== 0 || !pass.counts) return false;
  if (Number(pass.counts.conflict || 0) || Number(pass.counts.blocked || 0)
    || Number(pass.counts.calendar_conflicts || 0) || Number(pass.counts.calendar_blocked || 0)) return false;
  return passNumber !== 2 || mutationCounters.every(key => Number(pass.counts[key] || 0) === 0);
}
