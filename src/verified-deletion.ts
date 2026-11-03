import type { Profile, RecurrenceLink } from "./types.js";

/** A stale index is removable only when its *entire* active identity is in a
 * separately provider-verified deleted pair. Calendar-owned and foreign links
 * are never inferred dead from a Todoist task's 404. */
export function classifyDeletedRecurrenceLinks(
  profile: Profile, taskIds: string[], eventIds: string[], links: RecurrenceLink[],
): { stale: RecurrenceLink[]; blocked: string[] } {
  const tasks = new Set(taskIds), events = new Set(eventIds);
  const stale: RecurrenceLink[] = [], blocked: string[] = [];
  for (const link of links) {
    const touches = tasks.has(link.taskId) || [link.eventId, link.masterEventId, link.activeInstanceId]
      .some(id => Boolean(id && events.has(id)));
    if (!touches) continue;
    if (link.profile === profile && link.owner === "todoist"
      && tasks.has(link.taskId) && link.seriesId === link.taskId
      && events.has(link.eventId)
      && (!link.masterEventId || events.has(link.masterEventId))
      && (!link.activeInstanceId || events.has(link.activeInstanceId))
      && typeof link.updatedAt === "string" && Boolean(link.updatedAt)) {
      stale.push(link);
    } else {
      blocked.push(`${link.profile}/${link.seriesId}: conflicting recurrence ownership or unverified identity`);
    }
  }
  return { stale, blocked };
}
