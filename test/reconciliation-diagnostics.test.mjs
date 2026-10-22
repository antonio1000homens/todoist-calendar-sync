import assert from "node:assert/strict";
import test from "node:test";
import { ReconciliationItemError, reconciliationFailureDetails } from "../dist/reconciliation-diagnostics.js";
import { sanitizeTelemetryDetail } from "../dist/observability.js";

test("Google 400 for a recurring occurrence reports safe item and reason without pretending it is missing", () => {
  const error = Object.assign(
    new Error("Provider request failed: 400 https://www.googleapis.com/calendar/v3/calendars/private/events/instance"),
    { status: 400, body: JSON.stringify({ error: { code: 400, message: "Invalid recurring instance", errors: [{ reason: "invalid" }] } }) },
  );
  const failure = new ReconciliationItemError(error, {
    stage: "mapped", taskId: "task-123", eventId: "5rio60tp27c1g98p449p5curbl_20261016T152000Z",
  });
  assert.equal(failure.status, 400);
  assert.equal(failure.providerReason, "invalid");
  assert.equal(failure.cause, error);
  assert.match(failure.message, /task task-123.*event 5rio60tp27c1g98p449p5curbl_20261016T152000Z.*HTTP 400 \(invalid\)/);
  assert.doesNotMatch(failure.message, /private|Invalid recurring instance|www.googleapis/);
  assert.deepEqual(sanitizeTelemetryDetail(reconciliationFailureDetails(failure)), {
    stage: "mapped", taskId: "task-123", eventId: "5rio60tp27c1g98p449p5curbl_20261016T152000Z",
    providerStatus: 400, providerReason: "invalid",
  });
});

test("untrusted provider messages and malformed error bodies are not retained in diagnostics", () => {
  const evil = Object.assign(new Error("Secret record title"), {
    status: 400, body: JSON.stringify({ error: { errors: [{ reason: "invalid\nSecret title" }], message: "Private task details" } }),
  });
  const failure = new ReconciliationItemError(evil, { stage: "calendar", eventId: "event-2" });
  assert.equal(failure.providerReason, undefined);
  assert.doesNotMatch(failure.message, /Secret|Private|\n/);
  assert.deepEqual(reconciliationFailureDetails(failure), {
    stage: "calendar", taskId: undefined, eventId: "event-2", seriesId: undefined,
    providerStatus: 400, providerReason: undefined,
  });
  assert.equal(reconciliationFailureDetails(new Error("other")), {});
  const malformed = new ReconciliationItemError(
    Object.assign(new Error("HTTP 400"), { status: 400, body: "<html>wrong</html>" }),
    { stage: "unmapped", taskId: "task-1" },
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.providerReason, undefined);
});
