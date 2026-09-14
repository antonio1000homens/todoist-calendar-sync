import { googleCredentials, profiles, todoistToken } from "./config.js";
import { GoogleCalendar, Todoist } from "./providers.js";
import type { Profile } from "./types.js";

export const DEFAULT_RECONCILIATION_MUTATION_LIMIT = 10;

export type ProviderClients = { calendar: GoogleCalendar; todoist: Todoist };
export type ProviderClientFactory = (profile: Profile) => Promise<ProviderClients>;

export class MutationBudgetExhaustedError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
    readonly provider: "calendar" | "todoist",
    readonly operation: string,
    readonly profile: Profile,
    readonly requested = 1,
  ) {
    super(`Reconciliation mutation budget exhausted at ${used}/${limit} before ${provider}.${operation} for ${profile} (requested ${requested})`);
    this.name = "MutationBudgetExhaustedError";
  }
}

export class ReconciliationMutationBudget {
  private mutationCount = 0;
  private readonly operationCounts = new Map<string, number>();

  constructor(readonly limit = DEFAULT_RECONCILIATION_MUTATION_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Mutation budget limit must be a positive integer");
  }

  get used(): number {
    return this.mutationCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.mutationCount);
  }

  get exhausted(): boolean {
    return this.mutationCount >= this.limit;
  }

  consume(provider: "calendar" | "todoist", operation: string, profile: Profile, count = 1): void {
    if (!Number.isInteger(count) || count < 1) throw new Error("Mutation budget consumption must be a positive integer");
    // Reserve the complete worst-case write cost before entering the provider
    // method. A method with an internal fallback must never begin if that
    // fallback could cross the reconciliation-wide ceiling.
    if (this.mutationCount + count > this.limit) {
      throw new MutationBudgetExhaustedError(this.limit, this.used, provider, operation, profile, count);
    }
    this.mutationCount += count;
    const key = `${profile}:${provider}.${operation}`;
    this.operationCounts.set(key, (this.operationCounts.get(key) || 0) + count);
  }

  snapshot(): Record<string, unknown> {
    return {
      limit: this.limit,
      used: this.used,
      remaining: this.remaining,
      exhausted: this.exhausted,
      operations: Object.fromEntries(this.operationCounts),
    };
  }
}

const CALENDAR_MUTATIONS = new Set(["upsertEvent", "deleteEvent"]);
const TODOIST_MUTATIONS = new Set([
  "upsertTask",
  "updateRecurringOccurrence",
  "deleteTask",
  "upsertComment",
  "deleteComment",
]);

function mutationReservation(provider: "calendar" | "todoist", operation: string, args: unknown[]): number {
  // Todoist.upsertComment(existingId) first attempts an update and, when the
  // existing comment is not owned by this token, can fall back to a create.
  // Reserve both possible writes up front. Other exposed mutation methods issue
  // at most one provider write (any additional calls are reads).
  if (provider === "todoist" && operation === "upsertComment" && Boolean(args[2])) return 2;
  return 1;
}

function budgetedProvider<T extends object>(
  target: T,
  provider: "calendar" | "todoist",
  profile: Profile,
  budget: ReconciliationMutationBudget,
  mutatingMethods: Set<string>,
): T {
  return new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (typeof value !== "function") return value;
      const operation = String(property);
      if (!mutatingMethods.has(operation)) return value.bind(current);
      return (...args: unknown[]) => {
        // Count/reserve mutation attempts before the provider boundary. This is
        // intentionally conservative: a failed write or unused fallback can
        // consume budget, which is preferable to exceeding the safety cap.
        budget.consume(provider, operation, profile, mutationReservation(provider, operation, args));
        return Reflect.apply(value, current, args);
      };
    },
  });
}

export const defaultProviderClientFactory: ProviderClientFactory = async (profile) => ({
  calendar: new GoogleCalendar(await googleCredentials(profile), profiles[profile].calendarId),
  todoist: new Todoist(await todoistToken(profile)),
});

export function createBudgetedClientFactory(
  budget: ReconciliationMutationBudget,
  baseFactory: ProviderClientFactory = defaultProviderClientFactory,
): ProviderClientFactory {
  return async (profile) => {
    const clients = await baseFactory(profile);
    return {
      calendar: budgetedProvider(clients.calendar, "calendar", profile, budget, CALENDAR_MUTATIONS),
      todoist: budgetedProvider(clients.todoist, "todoist", profile, budget, TODOIST_MUTATIONS),
    };
  };
}

export function isMutationBudgetExhausted(error: unknown): error is MutationBudgetExhaustedError {
  return error instanceof MutationBudgetExhaustedError
    || (error instanceof Error && error.name === "MutationBudgetExhaustedError");
}
