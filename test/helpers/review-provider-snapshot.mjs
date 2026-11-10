// One canonical provider snapshot fixture for review-page identity regressions.
// The ref is the recorded identity; the object may be missing, cancelled or stale.
export function calendarReviewSnapshot(id, start, extra={}) {
  return {
    ref: { profile: "home", side: "calendar", id },
    object: {
      id,
      summary: "Write letter for Gabriel and Lennox",
      status: "confirmed",
      start: { date: start },
      end: { date: start.slice(0,8) + "08" },
      ...extra,
    },
  };
}
