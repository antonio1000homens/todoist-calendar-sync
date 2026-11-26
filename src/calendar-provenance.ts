import { ErasureReplayUnavailableError } from "./erasure-replay-barrier.js";
import type { CalendarEvent } from "./types.js";

/** Derive the exact Calendar identities proving which source produced a task. */
export function calendarReplaySourceIds(
  event: Pick<CalendarEvent, "id" | "recurringEventId">,
  ...aliases: (string | undefined)[]
): string[] {
  if (!event || !event.id) throw new ErasureReplayUnavailableError("Calendar provenance is required for task creation");
  const values = [event.id, event.recurringEventId, ...aliases];
  if (values.some(value => value !== undefined && (typeof value !== "string" || !value)))
    throw new ErasureReplayUnavailableError("Malformed Calendar provenance alias");
  const unique = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (unique.length > 32) throw new ErasureReplayUnavailableError("Calendar provenance alias limit exceeded");
  return unique;
}
