/**
 * Provider failures must retain the failing reconciliation candidate, without
 * mistaking an opaque Google HTTP 400 for a deleted Calendar occurrence.
 * Keep provider response text out of retained audits and user notifications.
 */
export interface ReconciliationFailureContext {
  stage: "recurrence" | "mapped" | "unmapped" | "calendar";
  taskId?: string;
  eventId?: string;
  seriesId?: string;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : undefined;
}

function providerReason(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { errors?: Array<{ reason?: unknown }>; status?: unknown };
      error_tag?: unknown;
    };
    const reason = parsed.error?.errors?.find((entry) => typeof entry?.reason === "string")?.reason
      || parsed.error?.status || parsed.error_tag;
    return typeof reason === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(reason)
      ? reason : undefined;
  } catch {
    return undefined;
  }
}

export class ReconciliationItemError extends Error {
  readonly stage: ReconciliationFailureContext["stage"];
  readonly taskId?: string;
  readonly eventId?: string;
  readonly seriesId?: string;
  readonly status?: number;
  readonly providerReason?: string;
  readonly body?: string;

  constructor(error: unknown, context: ReconciliationFailureContext) {
    const original = error as { status?: unknown; body?: unknown } | null;
    const status = Number(original?.status);
    const providerStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : undefined;
    const reason = providerReason(original?.body);
    const taskId = safeIdentifier(context.taskId);
    const eventId = safeIdentifier(context.eventId);
    const seriesId = safeIdentifier(context.seriesId);
    const subject = [taskId ? `task ${taskId}` : undefined, eventId ? `event ${eventId}` : undefined,
      seriesId ? `series ${seriesId}` : undefined].filter(Boolean).join(", ") || "candidate";
    const causeName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : "provider error";
    super(`Reconciliation ${context.stage} failed for ${subject}: ${providerStatus ? `HTTP ${providerStatus}` : causeName}${reason ? ` (${reason})` : ""}`, { cause: error });
    this.name = "ReconciliationItemError";
    this.stage = context.stage;
    this.taskId = taskId;
    this.eventId = eventId;
    this.seriesId = seriesId;
    this.status = providerStatus;
    this.providerReason = reason;
    // Preserve the original response for the existing CloudWatch-only worker
    // diagnostic. Never add it to the message or to retained audit details.
    this.body = typeof original?.body === "string" ? original.body : undefined;
  }
}

export function reconciliationFailureDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof ReconciliationItemError)) return {};
  return {
    stage: error.stage,
    taskId: error.taskId,
    eventId: error.eventId,
    seriesId: error.seriesId,
    providerStatus: error.status,
    providerReason: error.providerReason,
  };
}
