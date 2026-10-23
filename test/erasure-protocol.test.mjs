import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { acquireErasureProtocolLease, beginErasureFence, ErasureFenceActiveError } from "../dist/erasure-protocol.js";

test("lease transaction refuses an epoch read before a concurrent fence advance", async (t) => {
  const originalSend = documentClient.send;
  let epoch = 0;
  let fence;
  let pauseAdmission;
  let admissionPaused;
  const paused = new Promise(resolve => { admissionPaused = resolve; });
  const continueAdmission = new Promise(resolve => { pauseAdmission = resolve; });
  documentClient.send = async command => {
    if (command.input?.Key?.sk === "FENCE") return { Item: fence };
    const items = command.input?.TransactItems || [];
    if (items.some(item => item.Put?.Item?.sk === "FENCE")) {
      fence = { operationId: "op-1" };
      epoch += 1;
      return {};
    }
    if (items.some(item => item.Put?.Item?.sk?.startsWith("ADMISSION#"))) {
      admissionPaused();
      await continueAdmission;
      if (epoch !== 0 || fence) {
        const error = new Error("epoch/fence condition failed");
        error.name = "TransactionCanceledException";
        throw error;
      }
      return {};
    }
    return {};
  };
  t.after(() => { documentClient.send = originalSend; });

  const staleAdmission = acquireErasureProtocolLease("home", "admission", "admission-1", 0);
  await paused;
  // Simulate a fence winning between the admission's epoch read and lease txn.
  await beginErasureFence("home", "op-1");
  pauseAdmission();
  await assert.rejects(staleAdmission, ErasureFenceActiveError);
});
