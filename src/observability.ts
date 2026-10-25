const SAFE_STRING_KEYS = new Set([
  "profile", "taskId", "eventId", "seriesId", "masterEventId", "activeInstanceId", "accessMethod",
  "deliveryId", "sourceDeliveryId", "messageId", "messageGroupId", "decisionId",
  "targetId", "targetType", "slackUserId", "commentId", "projectId", "oldProjectId",
  "newProjectId", "calendarStatus", "mode", "reason", "type", "action", "event",
  "eventName", "kind", "stage", "operation", "status", "code", "generation",
  "handlingMode", "defaultAction", "source", "auditClass", "updatedAt", "createdAt", "providerReason",
  "sourceUpdatedAt", "taskUpdatedAt", "awsRequestId", "fromProfile", "toProfile",
]);

const SAFE_NUMBER_KEYS = new Set([
  "count", "scannedCount", "evaluatedCount", "returnedCount", "pages", "consumedCapacityUnits", "durationMs",
  "pacedDelayMs", "pacingDelayMs", "receiveCount", "bodyBytes", "mutationCount", "limit",
  "used", "scanned", "skipped", "conflicts", "blocked", "imported", "rebound", "providerMutations", "providerStatus",
]);

const SAFE_BOOLEAN_KEYS = new Set([
  "mutationCapReached", "projectionSuppressed", "visuallyRejoinedSeries", "created", "coalesced",
  "continued", "pending", "success", "exhausted",
]);

const SAFE_ARRAY_KEY_RE = /^(?:candidateEventIds|candidateTaskIds|eligibleCandidateTaskIds|mappedCandidateTaskIds|reservedCandidateTaskIds|mismatchCategories)$|(?:^|_)(?:changedFields|fields)$/;
const SAFE_RECURRENCE_EXPECTED_KEYS = new Set(["frequency", "weekday", "time", "startDate", "endDate"]);
const SAFE_RECURRENCE_OBSERVED_KEYS = new Set([
  "recurring", "dueDate", "recurrenceParsed", "frequency", "weekday", "time", "startDate", "endDate",
  "startYearOmitted", "endYearOmitted", "phraseKind", "weekdayRecognized", "startDateParsed", "endDateParsed",
  "timePresent", "timeParsed",
]);
const SAFE_RECURRENCE_PHRASE_KINDS = new Set(["starting_ending", "from_until", "starting_only", "ending_only", "other"]);
const SAFE_WEEKDAYS = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200 || /[\r\n]/.test(value) || /https?:\/\//i.test(value)) return undefined;
  return value;
}

function safeRecurrenceDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1] || "2000");
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return value;
}

function safeRecurrenceDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    return safeRecurrenceDate(value);
  }
  const date = safeRecurrenceDate(value.slice(0, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = value.length > 16 && value[16] === ":" ? Number(value.slice(17, 19)) : 0;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  const offsetValid = !offset || (Number(offset[2]) <= 23 && Number(offset[3]) <= 59);
  return date && hour <= 23 && minute <= 59 && second <= 59 && offsetValid ? value : undefined;
}

function sanitizeRecurrenceDiagnostic(value: unknown, observed: boolean): Record<string, string | boolean> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowedKeys = observed ? SAFE_RECURRENCE_OBSERVED_KEYS : SAFE_RECURRENCE_EXPECTED_KEYS;
  const safe: Record<string, string | boolean> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!allowedKeys.has(key)) continue;
    if (key === "frequency") {
      if (field === "weekly") safe[key] = field;
    } else if (key === "weekday") {
      if (typeof field === "string" && SAFE_WEEKDAYS.has(field)) safe[key] = field;
    } else if (key === "time") {
      if (typeof field === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(field)) safe[key] = field;
    } else if (key === "startDate" || key === "endDate") {
      const date = safeRecurrenceDate(field);
      if (date) safe[key] = date;
    } else if (key === "dueDate") {
      const date = safeRecurrenceDateTime(field);
      if (date) safe[key] = date;
    } else if (key === "phraseKind") {
      if (typeof field === "string" && SAFE_RECURRENCE_PHRASE_KINDS.has(field)) safe[key] = field;
    } else if (["recurring", "recurrenceParsed", "startYearOmitted", "endYearOmitted"].includes(key)
      && typeof field === "boolean") {
      safe[key] = field;
    } else if (["weekdayRecognized", "startDateParsed", "endDateParsed", "timePresent", "timeParsed"].includes(key)
      && typeof field === "boolean") {
      safe[key] = field;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
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
    } else if (key === "expected" || key === "observed") {
      const recurrence = sanitizeRecurrenceDiagnostic(value, key === "observed");
      if (recurrence) safe[key] = recurrence;
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
