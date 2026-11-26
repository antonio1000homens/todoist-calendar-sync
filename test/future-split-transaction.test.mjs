import assert from "node:assert/strict";
import test from "node:test";
process.env.STATE_TABLE_NAME ||= "test-future-split-state";
const { documentClient } = await import("../dist/dynamodb-capacity.js");
const { StateRepository } = await import("../dist/repository.js");
const mapping = {
  profile: "antonio", projectId: "home-project", taskId: "smoke-task",
  eventId: "new-series", recurrenceOwner: "todoist", seriesId: "smoke-task",
  masterEventId: "new-series", activeInstanceId: "new-series_20270701",
  updatedAt: "2026-10-19T21:00:00Z",
};
const link = {
  profile: "antonio", owner: "todoist", seriesId: "smoke-task",
  masterEventId: "new-series", activeInstanceId: "new-series_20270701",
  taskId: "smoke-task", eventId: "new-series", updatedAt: mapping.updatedAt,
};

test("expired-UNTIL split completion sends only expression values used by its expressions", async () => {
  const original = documentClient.send;
  let captured;
  documentClient.send = async (command) => { captured = command; return {}; };
  try {
    await new StateRepository().completeFutureSeriesSplit("antonio", "smoke-task", "new-series");
    assert.equal(captured.constructor.name, "UpdateCommand");
    const input = captured.input;
    const used = new Set((input.UpdateExpression + " " + input.ConditionExpression).match(/:[A-Za-z]+\b/g) || []);
    const values = input.ExpressionAttributeValues;
    for (const placeholder of used) assert.ok(Object.hasOwn(values, placeholder), `missing expression value ${placeholder}`);
    assert.deepEqual(Object.keys(values).sort(), [...used].sort());
    assert.equal(input.ExpressionAttributeValues[":done"], "completed");
  } finally { documentClient.send = original; }
});

test("an abandoned pending split lease expires and is removed from automatic processing", async () => {
  const original = documentClient.send;
  const commands = [];
  documentClient.send = async (command) => {
    commands.push(command);
    if (command.constructor.name === "GetCommand") return { Item: {
      profile: "antonio", taskId: "smoke-task", oldMasterId: "old-series",
      newMasterId: "new-series", status: "pending", startedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: 1,
    } };
    return {};
  };
  try {
    assert.equal(await new StateRepository().getFutureSeriesSplitAnyProfile("smoke-task"), undefined);
    const deletion = commands.find((command) => command.constructor.name === "DeleteCommand");
    assert.ok(deletion);
    assert.match(deletion.input.ConditionExpression, /#status = :pending/);
    assert.equal(deletion.input.ExpressionAttributeValues[":pending"], "pending");
    assert.ok(commands.some((command) => command.constructor.name === "PutCommand"),
      "expiry should leave an operational audit rather than a permanent fence");
  } finally { documentClient.send = original; }
});

test("split transaction treats concurrent ownership race as refusal, not a success", async () => {
  const original = documentClient.send;
  documentClient.send = async () => {
    throw Object.assign(new Error("race"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
  };
  try {
    assert.equal(await new StateRepository().putNewRecurrenceMappingIfUnowned(mapping, link), false);
  } finally { documentClient.send = original; }
});

test("non-conditional transaction failures propagate for operator recovery", async () => {
  const original = documentClient.send;
  documentClient.send = async () => {
    throw Object.assign(new Error("throughput"), { name: "ProvisionedThroughputExceededException" });
  };
  try {
    await assert.rejects(
      new StateRepository().putNewRecurrenceMappingIfUnowned(mapping, link), /throughput/,
    );
  } finally { documentClient.send = original; }
});

test("existing master/instance mappings and completed history are examined before any Calendar cap", async () => {
  const original = documentClient.send;
  let queries = 0;
  documentClient.send = async (cmd) => {
    const pk = cmd.input?.Key?.pk;
    if (cmd.constructor.name === "GetCommand") return {};
    if (cmd.constructor.name === "ScanCommand") return { Items: [], ScannedCount: 1 };
    if (cmd.constructor.name === "QueryCommand") {
      queries += 1;
      if (cmd.input.ExpressionAttributeValues[":lookupSk"] === "MAPPING#TASK#"
        && cmd.input.ExpressionAttributeValues[":lookupPk"] === "PROFILE#work") {
        return { Items: [{
          profile: "work", taskId: "different-task",
          eventId: "old-instance", masterEventId: "old-master",
        }] };
      }
      return { Items: [] };
    }
    throw new Error("Unexpected query");
  };
  try {
    await assert.rejects(
      new StateRepository().assertHistoricalSeriesUnowned("old-master", ["old-instance"]),
      /mapping still owns/,
    );
    assert.ok(queries > 0);
  } finally { documentClient.send = original; }
});

test("completed instance history in another profile blocks historical master reuse", async () => {
  const original = documentClient.send;
  documentClient.send = async (cmd) => {
    const pk = cmd.input?.Key?.pk;
    if (cmd.constructor.name === "GetCommand") {
      if (pk === "COMPLETED_EVENT#work#old-instance") {
        return { Item: { completedAt: "2026-01-01", taskId: "other-task" } };
      }
      return {};
    }
    if (cmd.constructor.name === "QueryCommand") return { Items: [] };
    if (cmd.constructor.name === "ScanCommand") return { Items: [], ScannedCount: 1 };
    throw new Error("Unexpected query");
  };
  try {
    await assert.rejects(
      new StateRepository().assertHistoricalSeriesUnowned("old-master", ["old-instance"]),
      /completed task history/,
    );
  } finally { documentClient.send = original; }
});

test("flatten transaction conditionally retires recurrence and all previous indexes alongside a receipt", async () => {
  const original = documentClient.send; const calls=[];
  documentClient.send=async command=>{calls.push(command);return {};};
  try {
    const next={profile:"antonio",taskId:"retained",eventId:"standalone",updatedAt:"approved-version"};
    const previous={...mapping,taskId:"deleted-mirror",eventId:"old-occurrence",recurrenceOwner:"calendar",seriesId:"old-series"};
    const previousLink={...link,owner:"calendar",taskId:previous.taskId,eventId:previous.eventId,seriesId:previous.seriesId};
    assert.equal(await new StateRepository().commitFlattenMapping({operationId:"flatten-test",mapping:next,previous:[previous],links:[previousLink]}),true);
    const transaction=calls.find(c=>c.constructor.name==="TransactWriteCommand").input.TransactItems;
    const puts=transaction.filter(x=>x.Put).map(x=>x.Put);
    const deletes=transaction.filter(x=>x.Delete).map(x=>x.Delete);
    assert.deepEqual(puts.map(x=>x.Item.pk).sort(),["EVENT#antonio#standalone","FLATTEN_REPAIR#flatten-test","TASK#antonio#retained","TASKOWNER#retained"]);
    assert.deepEqual(deletes.map(x=>x.Key.pk).sort(),["EVENT#antonio#old-occurrence","RECURRENCE#antonio#old-series","TASK#antonio#deleted-mirror","TASKOWNER#deleted-mirror"]);
    assert.ok(puts.every(x=>x.ConditionExpression==="attribute_not_exists(pk)"));
    assert.ok(deletes.every(x=>x.ConditionExpression.includes("updatedAt = :v")));
    for (const item of [...puts,...deletes]) {
      const used=[...new Set(item.ConditionExpression.match(/:[a-z]+/g)||[])].sort();
      assert.deepEqual(Object.keys(item.ExpressionAttributeValues||{}).sort(),used);
    }
  } finally {documentClient.send=original;}
});

test("flatten refuses transaction races and validates every mapping index after a committed receipt", async () => {
  const original=documentClient.send;
  const next={profile:"antonio",taskId:"retained",eventId:"standalone",updatedAt:"approved-version"};
  try {
    documentClient.send=async command=>{if(command.constructor.name==="TransactWriteCommand")throw Object.assign(new Error("race"),{name:"TransactionCanceledException",CancellationReasons:[{Code:"ConditionalCheckFailed"}]});return {};};
    assert.equal(await new StateRepository().commitFlattenMapping({operationId:"flatten-test",mapping:next,previous:[],links:[]}),false);
    documentClient.send=async command=>({Item:command.input.Key.pk.startsWith("FLATTEN_REPAIR#")?next:command.input.Key.pk.startsWith("TASK#")?{...next,eventId:"changed"}:next});
    assert.equal(await new StateRepository().commitFlattenMapping({operationId:"flatten-test",mapping:next,previous:[],links:[]}),false);
  } finally {documentClient.send=original;}
});
