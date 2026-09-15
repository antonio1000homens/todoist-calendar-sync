const SAFE_STRING_KEYS = new Set([
  "profile", "taskId", "eventId", "seriesId", "masterEventId", "activeInstanceId",
  "deliveryId", "sourceDeliveryId", "messageId", "messageGroupId", "decisionId",
  "targetId", "targetType", "slackUserId", "commentId", "projectId", "oldProjectId",
  "newProjectId", "calendarStatus", "mode", "reason", "type", "action", "event",
  "eventName", "kind", "stage", "operation", "status", "code", "generation",
  "handlingMode", "defaultAction", "source", "auditClass", "updatedAt", "createdAt",
  "sourceUpdatedAt", "taskUpdatedAt", "awsRequestId", "fromProfile", "toProfile",
]);

const SAFE_NUMBER_KEYS = new Set([
  "count", "scannedCount", "returnedCount", "pages", "consumedCapacityUnits", "durationMs",
  "pacedDelayMs", "pacingDelayMs", "receiveCount", "bodyBytes", "mutationCount", "limit",
  "used", "scanned", "skipped", "conflicts", "blocked", "imported", "rebound", "providerMutations",
]);

const SAFE_BOOLEAN_KEYS = new Set([
  "mutationCapReached", "projectionSuppressed", "visuallyRejoinedSeries", "created", "coalesced",
  "continued", "pending", "success", "exhausted",
]);

const SAFE_ARRAY_KEY_RE = /(?:^|_)(?:changedFields|fields)$/;

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200 || /[\r\n]/.test(value) || /https?:\/\//i.test(value)) return undefined;
  return value;
}

/**
 * Keep telemetry useful for correlation while dropping provider payloads,
 * user content, errors and arbitrary nested objects before they reach either
 * CloudWatch or the retained DynamoDB audit item.
 */
export function sanitizeTelemetryDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SAFE_STRING_KEYS.has(key)) {
      const stringValue = safeString(value);
      if (stringValue !== undefined) safe[key] = stringValue;
    } else if (SAFE_NUMBER_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (SAFE_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      safe[key] = value;
    } else if (SAFE_ARRAY_KEY_RE.test(key) && Array.isArray(value)) {
      const fields = value.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(item));
      if (fields.length) safe[key] = fields;
    } else if ((key === "summary" || key === "mutationBudget") && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = sanitizeTelemetryDetail(value as Record<string, unknown>);
      if (Object.keys(nested).length) safe[key] = nested;
    }
  }
  return safe;
}

export function logEvent(
  event: string,
  detail: Record<string, unknown> = {},
  component = "todoist-calendar-sync",
): void {
  console.log(JSON.stringify({
    level: "info",
    event,
    component,
    ...sanitizeTelemetryDetail(detail),
  }));
}
