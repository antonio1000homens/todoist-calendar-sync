import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { acquireErasureProtocolLease, beginErasureFence, ErasureFenceActiveError } from "../dist/erasure-protocol.js";
import { restoreMappings } from "../scripts/erasure-mappings.mjs";

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

test("partial mapping restoration keeps the original UUID manifest for retry", async () => {
  const mappingIds = ["source-a", "source-b"];
  const journal = { enabledMappings: [...mappingIds] };
  const enabled = new Set();
  let failB = true;
  await assert.rejects(restoreMappings(mappingIds, {
    async update(id) {
      if (id === "source-a") enabled.add(id);
      if (id === "source-b" && failB) throw new Error("temporary Lambda API failure");
      enabled.add(id);
    },
    async get(id) { return { UUID: id, State: enabled.has(id) ? "Enabled" : "Disabled" }; },
    async pause() {},
    timeoutMs: 10,
  }), /temporary Lambda API failure/);
  assert.deepEqual(journal.enabledMappings, ["source-a", "source-b"]);
  failB = false;
  await restoreMappings(journal.enabledMappings, {
    async update(id) { enabled.add(id); },
    async get(id) { return { UUID: id, State: enabled.has(id) ? "Enabled" : "Disabled" }; },
    async pause() {},
    timeoutMs: 10,
  });
  assert.deepEqual([...enabled], journal.enabledMappings);
});

test("lost mapping update acknowledgement is retried and verified before final commit", async () => {
  const mappingIds = ["source-a"];
  const enabled = new Set();
  let lostAcknowledgement = true;
  const order = [];
  const update = async id => {
    enabled.add(id);
    if (lostAcknowledgement) {
      lostAcknowledgement = false;
      throw new Error("response lost after update committed");
    }
  };
  const adapters = {
    update,
    async get(id) { return { UUID: id, State: enabled.has(id) ? "Enabled" : "Disabled" }; },
    async pause() {},
    timeoutMs: 10,
  };
  await assert.rejects(restoreMappings(mappingIds, adapters), /response lost/);
  await restoreMappings(mappingIds, adapters);
  order.push("mappings-verified");
  assert.equal(enabled.has("source-a"), true);
  // The production caller invokes finishErasureProtocol only after this await.
  order.push("finishErasureProtocol");
  assert.deepEqual(order, ["mappings-verified", "finishErasureProtocol"]);
});
