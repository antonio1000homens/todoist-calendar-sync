import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { acquireMoveWriterLeases } from "../dist/project-sync.js";

async function withLeaseDb(t, send) {
  const originalSend = documentClient.send;
  const previous = process.env.ERASURE_PROTOCOL_VERSION;
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  documentClient.send = send;
  t.after(() => {
    documentClient.send = originalSend;
    if (previous === undefined) delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION = previous;
  });
}

test("cross-profile writer leases are acquired in order and held until release", async t => {
  const acquired = [], released = [];
  await withLeaseDb(t, async command => {
    if (command.constructor.name === "GetCommand") {
      if (command.input.Key.sk === "EPOCH") return { Item: { epoch: 4 } };
      return {};
    }
    if (command.constructor.name === "TransactWriteCommand") {
      const lease = command.input.TransactItems.find(item => item.Put)?.Put?.Item;
      acquired.push(lease);
      return {};
    }
    if (command.constructor.name === "DeleteCommand") {
      released.push(command.input.Key.sk);
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });

  const release = await acquireMoveWriterLeases(["work", "home", "antonio", "work"], "home");
  assert.deepEqual(acquired.map(item => item.pk), ["ERASURE#antonio", "ERASURE#work"]);
  assert.deepEqual(released, [], "leases remain held while the cross-profile work runs");
  await release();
  assert.equal(released.length, 2);
  assert.deepEqual(new Set(released), new Set(acquired.map(item => item.sk)));
});

test("a refused destination lease releases earlier leases and rejects the move", async t => {
  const acquired = [], released = [];
  let writerTransactions = 0;
  await withLeaseDb(t, async command => {
    if (command.constructor.name === "GetCommand") {
      if (command.input.Key.sk === "EPOCH") return { Item: { epoch: 0 } };
      return {};
    }
    if (command.constructor.name === "TransactWriteCommand") {
      const lease = command.input.TransactItems.find(item => item.Put)?.Put?.Item;
      writerTransactions += 1;
      if (writerTransactions === 2) {
        const error = new Error("destination fence won the race");
        error.name = "TransactionCanceledException";
        throw error;
      }
      acquired.push(lease);
      return {};
    }
    if (command.constructor.name === "DeleteCommand") {
      released.push(command.input.Key.sk);
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });

  await assert.rejects(acquireMoveWriterLeases(["work", "antonio"], "home"), /destination fence won the race/);
  assert.equal(acquired.length, 1);
  assert.deepEqual(released, [acquired[0].sk], "partial lease acquisition is rolled back before mutation can start");
});
