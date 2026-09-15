import type { Handler } from "aws-lambda";
import { configuredProfiles, googleCredentials, profiles, calendarWatchToken } from "./config.js";
import { GoogleCalendar } from "./providers.js";
import { StateRepository } from "./repository.js";
import type { CalendarWatchState, Profile } from "./types.js";

const CALLBACK_URL = process.env.CALENDAR_WATCH_CALLBACK_URL || "https://calendar-sync.alf-broadcast.co.uk/calendar";
const RENEW_BEFORE_MS = 48 * 60 * 60_000;
const PROFILE_CHANNEL_BASE: Record<Profile, string> = {
  home: "home1000homens-calendar-sync",
  antonio: "antonio1000homens-calendar-sync",
  work: "work1000homens-calendar-sync",
};

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-watch", event, ...detail }));
}

function channelId(profile: Profile): string {
  return `${PROFILE_CHANNEL_BASE[profile]}-v3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function expirationIso(value: string): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric).toISOString() : new Date(value).toISOString();
}

async function ensureProfile(profile: Profile, state: StateRepository, token: string): Promise<void> {
  const current = await state.getCalendarWatch(profile);
  const expiration = current ? Date.parse(current.expiration) : NaN;
  if (!current) log("watch_missing", { profile, expiresWithin48h: true, expiresWithin24h: true });
  else if (!Number.isFinite(expiration) || expiration - Date.now() <= 24 * 60 * 60_000) {
    log("watch_expires_within24h", { profile, generation: current.generation, expiration: current.expiration, expiresWithin24h: true, expiresWithin48h: true });
  } else if (expiration - Date.now() <= RENEW_BEFORE_MS) {
    log("watch_expires_within48h", { profile, generation: current.generation, expiration: current.expiration, expiresWithin24h: false, expiresWithin48h: true });
  }
  if (current?.status === "active" && Number.isFinite(expiration) && expiration - Date.now() > RENEW_BEFORE_MS) {
    log("watch_healthy", { profile, generation: current.generation, expiration: current.expiration, expiresWithin48h: false });
    return;
  }

  const nextChannel = channelId(profile);
  const calendar = new GoogleCalendar(await googleCredentials(profile), profiles[profile].calendarId);
  const attemptedAt = new Date().toISOString();
  try {
    const created = await calendar.watch(nextChannel, CALLBACK_URL, token);
    const next: CalendarWatchState = {
      profile,
      channelId: nextChannel,
      resourceId: created.resourceId,
      expiration: expirationIso(created.expiration),
      callbackUrl: CALLBACK_URL,
      generation: "v3",
      createdAt: current?.createdAt || attemptedAt,
      renewedAt: attemptedAt,
      status: "active",
    };
    try {
      await state.putCalendarWatch(next);
    } catch (error) {
      try { await calendar.stopWatch(next.channelId, next.resourceId); }
      catch (stopError) { log("replacement_cleanup_failed", { profile, channelId: next.channelId, error: stopError instanceof Error ? stopError.message : String(stopError) }); }
      throw error;
    }
    if (current) {
      try {
        await calendar.stopWatch(current.channelId, current.resourceId);
        await state.deleteCalendarWatchChannel(current.channelId);
      } catch (error) {
        log("old_watch_stop_failed", { profile, channelGeneration: current.generation, oldWatchRetained: true, error: error instanceof Error ? error.message : String(error) });
      }
    }
    log(current ? "watch_renewed" : "watch_created", { profile, channelId: next.channelId, generation: next.generation, expiration: next.expiration, expiresWithin48h: false });
  } catch (error) {
    log("watch_renewal_failed", {
      profile,
      hadValidOldWatch: Boolean(current && Number.isFinite(expiration) && expiration > Date.now()),
      replacementFailedOldWatchPreserved: Boolean(current && Number.isFinite(expiration) && expiration > Date.now()),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export const handler: Handler = async () => {
  const state = new StateRepository();
  const token = await calendarWatchToken();
  const failures: string[] = [];
  for (const profile of configuredProfiles()) {
    try { await ensureProfile(profile, state, token); }
    catch (error) { failures.push(profile); log("watch_profile_failed", { profile, error: error instanceof Error ? error.message : String(error) }); }
  }
  if (failures.length) throw new Error(`Calendar watch profiles failed: ${failures.join(", ")}`);
};
