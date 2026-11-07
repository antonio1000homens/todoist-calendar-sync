import type { CalendarEvent, Profile, RecurrenceLink } from "./types.js";

const profiles: readonly Profile[] = ["home", "antonio", "work"];

/** Legacy decisions may omit masterEventId. Recover it ONLY from a direct
 * cancelled occurrence read, never by stripping an ID suffix or trusting an
 * old mapping/comment. The caller must then independently verify the master. */
export function cancelledOccurrenceMasterId(
  activeInstanceId: string | undefined, occurrence: CalendarEvent | undefined,
): string | undefined {
  if (!activeInstanceId || !occurrence || occurrence.id !== activeInstanceId
    || occurrence.status !== "cancelled" || !occurrence.recurringEventId
    || occurrence.recurringEventId === activeInstanceId) return undefined;
  return occurrence.recurringEventId;
}

/** Provider reads, not a date/title or a cancelled occurrence alone, must
 * establish the exact master and active occurrence. Missing master metadata
 * cannot establish Calendar-owned iCalUID key absence and fails closed. */
export function verifyCancelledSeries(
  masterId: string | undefined, activeInstanceId: string | undefined,
  eventIds: string[], events: Map<string, CalendarEvent | undefined>,
): { valid: boolean; masterSeriesId?: string; reason?: string } {
  if (!masterId || !activeInstanceId || masterId === activeInstanceId
    || !eventIds.includes(masterId) || !eventIds.includes(activeInstanceId))
    return { valid: false, reason: "Missing or inconsistent recurring master/active-instance identities" };
  const master = events.get(masterId);
  if (!master || master.id !== masterId || master.status !== "cancelled"
    || master.recurringEventId || !master.recurrence?.some(rule => rule.startsWith("RRULE:"))
    || !master.iCalUID)
    return { valid: false, reason: "Cancelled recurring master or its iCalUID cannot be independently verified" };
  for (const id of eventIds) {
    if (id === masterId) continue;
    const occurrence = events.get(id);
    if (!occurrence || occurrence.id !== id || occurrence.status !== "cancelled"
      || occurrence.recurringEventId !== masterId || occurrence.recurrence?.length
      || occurrence.iCalUID && occurrence.iCalUID !== master.iCalUID)
      return { valid: false, reason: "Recorded occurrence is absent, live or not linked to the exact recurring master" };
  }
  return { valid: true, masterSeriesId: master.iCalUID };
}

/** All supported recurrence keys are task IDs (Todoist-owned) or the
 * Calendar master's iCalUID / ID (Calendar-owned); include recorded older
 * series keys and instance IDs to fence legacy ownership too. */
export function deletedSeriesKeys(taskIds: string[], eventIds: string[], masterSeriesId: string,
  recordedSeriesIds: Array<string | undefined> = []): string[] {
  return [...new Set([...taskIds, ...eventIds, masterSeriesId, ...recordedSeriesIds]
    .filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Strongly consistent base-table GetItem per *known key* and profile. GSI
 * listings are eventually consistent and MUST NOT authorize retirement.
 * Unknown/oversize inventories fail closed rather than silently truncate. */
export async function readExactRecurrenceLinks(
  keys: string[],
  getLink: (profile: Profile, seriesId: string) => Promise<RecurrenceLink | undefined>,
): Promise<RecurrenceLink[]> {
  if (!keys.length || keys.length > 20) throw new Error("Incomplete or excessive exact recurrence key inventory");
  const entries = await Promise.all(profiles.flatMap(profile => keys.map(async seriesId => {
    const link = await getLink(profile, seriesId);
    if (link && (link.profile !== profile || link.seriesId !== seriesId))
      throw new Error("Recurrence record key and stored identity disagree");
    return link;
  })));
  return entries.filter((link): link is RecurrenceLink => Boolean(link));
}

/** Every link found at a guarded exact series key is ownership evidence.
 * Incomplete Todoist links and every Calendar-owned/foreign link are blockers,
 * including those with an unexpected task/event reference. */
export function classifyDeletedRecurrenceLinks(
  profile: Profile, taskIds: string[], eventIds: string[], links: RecurrenceLink[],
  seriesKeys: string[] = [...taskIds, ...eventIds],
  identity?: { masterId: string; activeInstanceId: string; legacyMasterVerified?: boolean },
): { stale: RecurrenceLink[]; blocked: string[] } {
  const tasks = new Set(taskIds), events = new Set(eventIds), keys = new Set(seriesKeys);
  const stale: RecurrenceLink[] = [], blocked: string[] = [];
  for (const link of links) {
    const touches = keys.has(link.seriesId) || tasks.has(link.taskId)
      || [link.eventId, link.masterEventId, link.activeInstanceId]
        .some(id => Boolean(id && events.has(id)));
    if (!touches) continue;
    if (link.profile === profile && link.owner === "todoist"
      && tasks.has(link.taskId) && link.seriesId === link.taskId
      && events.has(link.eventId)
      && (Boolean(link.masterEventId && events.has(link.masterEventId))
        || Boolean(identity?.legacyMasterVerified && !link.masterEventId
          && link.eventId === identity.activeInstanceId
          && events.has(identity.masterId)))
      && Boolean(link.activeInstanceId && events.has(link.activeInstanceId))
      && link.activeInstanceId !== link.masterEventId
      && (!identity || (link.masterEventId === identity.masterId
          || identity.legacyMasterVerified && !link.masterEventId
            && link.eventId === identity.activeInstanceId)
        && link.activeInstanceId === identity.activeInstanceId)
      && typeof link.updatedAt === "string" && Boolean(link.updatedAt)) {
      stale.push(link);
    } else {
      blocked.push(`${link.profile}/${link.seriesId}: conflicting, foreign or incomplete recurrence ownership`);
    }
  }
  return { stale, blocked };
}
