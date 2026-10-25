import { configuredProfiles, profiles } from "./config.js";
import type { CalendarEvent, Profile } from "./types.js";

function normalizedCalendarEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  // Calendar aliases such as `primary` cannot be compared safely with the
  // organizer email. In that case keep the existing per-profile behavior.
  return normalized && /^[^@\s]+@[^@\s]+$/.test(normalized) ? normalized : undefined;
}

export function calendarOrganizerProfile(event: Pick<CalendarEvent, "organizer">): Profile | undefined {
  const organizerEmail = normalizedCalendarEmail(event.organizer?.email);
  if (!organizerEmail) return undefined;

  const matches = configuredProfiles().filter((profile) =>
    normalizedCalendarEmail(profiles[profile].calendarId) === organizerEmail);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Returns the canonical profile when this event is a copy owned by another configured calendar. */
export function otherProfileCalendarOrganizer(
  currentProfile: Profile,
  event: Pick<CalendarEvent, "organizer">,
): Profile | undefined {
  const organizerProfile = calendarOrganizerProfile(event);
  return organizerProfile && organizerProfile !== currentProfile ? organizerProfile : undefined;
}
