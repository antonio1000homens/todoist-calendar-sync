import test from "node:test";
import assert from "node:assert/strict";
import {redactedFailureCode} from "../scripts/audit-erasure-cross-profile-live.mjs";

test("cross-profile audit classifies oversized Calendar recurrence without exposing input",()=>{
  const secret="Calendar recurring series exceeds replay marker bound: event-secret-123";
  assert.equal(redactedFailureCode(new Error(secret)),"UNCLASSIFIED");
  assert.equal(redactedFailureCode(new Error("Calendar recurring series exceeds replay marker bound")),
    "CALENDAR_RECURRENCE_ALIAS_LIMIT");
});

test("cross-profile audit classifies incomplete inventories with fixed safe codes",()=>{
  assert.equal(redactedFailureCode(new Error("Calendar full inventory exceeded the audit result limit")),
    "CALENDAR_INVENTORY_LIMIT");
  assert.equal(redactedFailureCode(new Error("Todoist task inventory exceeded the audit result limit")),
    "TODOIST_INVENTORY_LIMIT");
  assert.equal(redactedFailureCode(new Error("Strong state inventory repeated a row across pages")),
    "STATE_INVENTORY_INCONSISTENT");
  const deadline=new Error("deadline"); deadline.name="ErasurePreviewDeadlineError";
  assert.equal(redactedFailureCode(deadline),"STATE_INVENTORY_DEADLINE");
});
