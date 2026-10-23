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

test("future mapping transaction conditionally claims owner, mapping indexes and recurrence link together", async () => {
  const original = documentClient.send;
  let captured;
  documentClient.send = async (command) => { captured = command; return {}; };
  try {
    assert.equal(await new StateRepository().putNewRecurrenceMappingIfUnowned(mapping, link), true);
    assert.equal(captured.constructor.name, "TransactWriteCommand");
    const writes = captured.input.TransactItems;
    const puts = writes.filter((item) => item.Put).map((item) => item.Put);
    const checks = writes.filter((item) => item.ConditionCheck).map((item) => item.ConditionCheck);
    assert.deepEqual(puts.map((item) => item.Item.pk).sort(), [
      "EVENT#antonio#new-series", "RECURRENCE#antonio#smoke-task",
      "TASK#antonio#smoke-task", "TASKOWNER#smoke-task",
    ]);
    assert.ok(puts.every((item) => item.ConditionExpression === "attribute_not_exists(pk)"));
    assert.ok(checks.some((item) => item.Key.pk === "PROJECTION#antonio#TASK#smoke-task"));
    assert.ok(checks.some((item) => item.Key.pk === "COMPLETED_EVENT#antonio#new-series"));
    assert.ok(checks.some((item) => item.Key.pk === "TASK#work#smoke-task"));
    assert.ok(checks.some((item) => item.Key.pk === "PROJECTION#work#TASK#smoke-task"));
    const guard = checks.find((item) => item.Key.pk === "FUTURE_SPLIT#TASK#smoke-task");
    assert.equal(guard.ConditionExpression, "#status = :pending AND profile = :profile AND newMasterId = :master");
    assert.equal(guard.ExpressionAttributeValues[":pending"], "pending");
    assert.equal(guard.ExpressionAttributeValues[":master"], mapping.eventId);
    assert.ok(checks.filter((item) => item !== guard)
      .every((item) => item.ConditionExpression === "attribute_not_exists(pk)"));
  } finally { documentClient.send = original; }
});

test("duplicate consolidation atomically transfers mapping ownership and installs webhook guard", async () => {
  const original = documentClient.send;
  let captured;
  documentClient.send = async (command) => {
    if (command.constructor.name === "GetCommand") return { Item: {
      profile: "antonio", taskId: "smoke-task", oldMasterId: "old-series",
      newMasterId: "new-series", status: "pending",
    } };
    captured = command;
    return {};
  };
  const previousMapping = {
    profile: "antonio", projectId: "home-project", taskId: "duplicate-task",
    eventId: "old-series_20270611", recurrenceOwner: "calendar", seriesId: "old-series",
    masterEventId: "old-series", activeInstanceId: "old-series_20270611",
    activeEffectiveStart: "2027-06-11", updatedAt: "2026-10-19T20:00:00Z",
  };
  const previousLink = {
    profile: "antonio", owner: "calendar", seriesId: "old-series",
    masterEventId: "old-series", activeInstanceId: previousMapping.activeInstanceId,
    taskId: "duplicate-task", eventId: previousMapping.eventId, updatedAt: previousMapping.updatedAt,
  };
  try {
    assert.equal(await new StateRepository().commitRecurrenceConsolidation({
      mapping, link, previousMapping, previousLink,
      discardedTaskId: "duplicate-task", decisionId: "decision-1",
      cancelledEventId: "cancelled-projection",
    }), true);
    assert.equal(captured.constructor.name, "TransactWriteCommand");
    const writes = captured.input.TransactItems;
    const deletes = writes.filter((item) => item.Delete).map((item) => item.Delete);
    assert.deepEqual(deletes.map((item) => item.Key.pk), [
      "EVENT#antonio#old-series_20270611", "TASK#antonio#duplicate-task",
      "TASKOWNER#duplicate-task", "RECURRENCE#antonio#old-series",
    ]);
    const puts = writes.filter((item) => item.Put).map((item) => item.Put);
    assert.ok(puts.some((item) => item.Item.pk === "CONSOLIDATED_TASK#antonio#duplicate-task"
      && item.Item.retainedTaskId === "smoke-task" && item.Item.decisionId === "decision-1"
      && item.Item.cancelledEventId === "cancelled-projection"));
    assert.ok(puts.every((item) => item.ConditionExpression.startsWith("attribute_not_exists(pk)")));
    assert.ok(writes.some((item) => item.ConditionCheck?.Key.pk === "FUTURE_SPLIT#TASK#smoke-task"));
    assert.ok(writes.some((item) => item.ConditionCheck?.Key.pk === "PROJECTION#antonio#TASK#smoke-task"));
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
