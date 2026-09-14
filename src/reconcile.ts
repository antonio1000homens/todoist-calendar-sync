import type { Handler } from "aws-lambda";
import { requestReconciliation } from "./queue.js";
import { StateRepository } from "./repository.js";
import type { Profile } from "./types.js";

const profileList: Profile[] = ["home", "antonio", "work"];

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-reconciler", event, ...detail }));
}

/**
 * Hourly safety net. Each profile gets its own durable reconciliation request
 * and FIFO lane so one broken provider/profile cannot prevent the remaining
 * profiles from being assessed. Existing pending work is coalesced/recovered.
 */
export const handler: Handler = async (_event, context) => {
  const state = new StateRepository();
  log("scheduled_reconciliation_tick", { awsRequestId: context.awsRequestId, profiles: profileList });

  for (const profile of profileList) {
    try {
      const result = await requestReconciliation(state, profile, "scheduled");
      if (result.enqueueError) {
        console.error(JSON.stringify({
          service: "todoist-calendar-sync-reconciler",
          event: "scheduled_reconciliation_enqueue_deferred",
          awsRequestId: context.awsRequestId,
          profile,
          result,
          note: "Pending DynamoDB state is retained and will be retried by the next webhook or scheduled tick.",
        }));
      } else {
        log(result.coalesced ? "scheduled_reconciliation_coalesced" : "scheduled_reconciliation_requested", {
          awsRequestId: context.awsRequestId,
          profile,
          result,
        });
      }
    } catch (error) {
      console.error(JSON.stringify({
        service: "todoist-calendar-sync-reconciler",
        event: "scheduled_reconciliation_profile_failed",
        awsRequestId: context.awsRequestId,
        profile,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      }));
    }
  }
};
