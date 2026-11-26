import type { Handler } from "aws-lambda";
import { enqueueCalendarSync } from "./queue.js";
import { StateRepository } from "./repository.js";
import type { Profile } from "./types.js";

const profiles: Profile[] = ["antonio", "home", "work"];

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-calendar-dispatcher", event, ...detail }));
}

/** Recover dirty Calendar notification generations that have not reached or
 * completed their profile FIFO request. This never scans provider data. */
export const handler: Handler = async () => {
  const state = new StateRepository();
  const report: Record<Profile, "queued" | "coalesced" | "idle" | "failed"> = {
    antonio: "idle", home: "idle", work: "idle",
  };
  for (const profile of profiles) {
    try {
      if (!await state.calendarSyncDispatchDue(profile)) continue;
      report[profile] = await enqueueCalendarSync(state, profile) ? "queued" : "coalesced";
    } catch (error) {
      report[profile] = "failed";
      log("calendar_sync_dispatch_failed", {
        profile, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log("calendar_sync_dispatch_checked", report);
};
