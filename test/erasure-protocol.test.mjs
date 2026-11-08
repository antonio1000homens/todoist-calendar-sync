import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { acquireErasureProtocolLease, beginErasureFence, ErasureFenceActiveError, ErasureLeaseAlreadyHeldError, inspectErasureFence } from "../dist/erasure-protocol.js";
import { restoreMappings } from "../scripts/erasure-mappings.mjs";
import { StateRepository } from "../dist/repository.js";
import { handler } from "../dist/worker.js";
import { OrphanRecoveringSynchronizer } from "../dist/orphan-recovery.js";
import { ManualInterventionService } from "../dist/manual-intervention.js";
import { Todoist } from "../dist/providers.js";
import { profiles } from "../dist/config.js";
import { projectDeletionTombstoneExpiry, serializeDeletionTombstoneComment } from "../dist/mapping-comments.js";
import { SSMClient } from "@aws-sdk/client-ssm";

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

test("stable lease-key collision is distinct from epoch mismatch", async (t) => {
  const originalSend = documentClient.send;
  documentClient.send = async command => {
    if (command.constructor.name === "TransactWriteCommand") {
      const error = new Error("conditional cancellation");
      error.name = "TransactionCanceledException";
      throw error;
    }
    if (command.constructor.name === "GetCommand" && command.input.Key.sk === "EPOCH") return { Item: { epoch: 0 } };
    if (command.constructor.name === "GetCommand" && command.input.Key.sk.startsWith("WRITER#")) return { Item: { owner: "fixed-owner" } };
    return {};
  };
  t.after(() => { documentClient.send = originalSend; });
  await assert.rejects(
    acquireErasureProtocolLease("home", "writer", "fixed-owner", 0),
    ErasureLeaseAlreadyHeldError,
  );
});

test("unrelated transaction cancellation is propagated instead of mislabeled as an epoch retry", async (t) => {
  const originalSend = documentClient.send;
  let transactions = 0;
  documentClient.send = async command => {
    if (command.constructor.name === "TransactWriteCommand") {
      transactions++;
      const error = new Error("transaction conflict");
      error.name = "TransactionCanceledException";
      throw error;
    }
    if (command.constructor.name === "GetCommand" && command.input.Key.sk === "EPOCH") return { Item: { epoch: 0 } };
    return {};
  };
  t.after(() => { documentClient.send = originalSend; });
  await assert.rejects(
    acquireErasureProtocolLease("home", "writer", "owner-1", 0),
    error => error.name === "TransactionCanceledException" && /transaction conflict/.test(error.message),
  );
  assert.equal(transactions, 1);
});

test("fence inspection paginates every lease row before reporting a drained profile", async (t) => {
  const originalSend = documentClient.send;
  let pages = 0;
  documentClient.send = async command => {
    assert.equal(command.constructor.name, "QueryCommand");
    assert.equal(command.input.ConsistentRead, true);
    pages++;
    if (pages === 1) return { Items: [{ pk: "ERASURE#home", sk: "FENCE", operationId: "op" }, { pk: "ERASURE#home", sk: "WRITER#a" }], LastEvaluatedKey: { pk: "ERASURE#home", sk: "WRITER#a" } };
    return { Items: [{ pk: "ERASURE#home", sk: "ADMISSION#b" }] };
  };
  t.after(() => { documentClient.send = originalSend; });
  const state = await inspectErasureFence("home");
  assert.equal(pages, 2);
  assert.equal(state.fence.operationId, "op");
  assert.deepEqual(state.leases.map(item => item.sk), ["WRITER#a", "ADMISSION#b"]);
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

test("fence-denied reconcile delivery cannot write failure state without a writer lease", async (t) => {
  const originalSend = documentClient.send;
  const previousVersion = process.env.ERASURE_PROTOCOL_VERSION;
  const previousTable = process.env.STATE_TABLE_NAME;
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  process.env.STATE_TABLE_NAME = "test-state";
  let failureWrites = 0;
  const method = t.mock.method(StateRepository.prototype, "recordReconciliationFailure", async () => { failureWrites++; });
  const audit = t.mock.method(StateRepository.prototype, "audit", async () => {});
  const complete = t.mock.method(StateRepository.prototype, "markDeliveryCompleted", async () => {});
  documentClient.send = async command => {
    if (command.constructor.name === "GetCommand" && command.input.Key.sk === "EPOCH") return { Item: { epoch: 1 } };
    if (command.constructor.name === "GetCommand" && command.input.Key.sk === "FENCE") return { Item: { operationId: "op-active" } };
    if (command.constructor.name === "TransactWriteCommand") {
      const error = new Error("fence condition failed");
      error.name = "TransactionCanceledException";
      throw error;
    }
    return {};
  };
  t.after(() => {
    documentClient.send = originalSend;
    if (previousVersion === undefined) delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION = previousVersion;
    if (previousTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = previousTable;
  });
  const delivery = {
    id: "reconcile:home:generation-1", kind: "reconcile", profile: "home", mode: "aws",
    receivedAt: new Date().toISOString(), headers: {}, body: "", erasureEpoch: 1,
    reconcile: { generation: "generation-1", reason: "manual" },
  };
  const result = await handler({ Records: [{ messageId: "message-1", body: JSON.stringify(delivery), attributes: {}, messageAttributes: {} }] }, { awsRequestId: "request-1" });
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "message-1" }]);
  assert.equal(method.mock.callCount(), 0);
  assert.equal(failureWrites, 0);
  for (const kind of ["todoist", "calendar"]) {
    const providerDelivery = { ...delivery, id: `fenced-${kind}`, kind };
    const providerResult = await handler({ Records: [{ messageId: `message-${kind}`, body: JSON.stringify(providerDelivery), attributes: {}, messageAttributes: {} }] }, { awsRequestId: `request-${kind}` });
    assert.deepEqual(providerResult.batchItemFailures, [{ itemIdentifier: `message-${kind}` }]);
  }
  assert.equal(audit.mock.callCount(), 0);
  assert.equal(complete.mock.callCount(), 0);
});

test("erased-item webhook replay writes no identity-bearing completion receipt", async (t) => {
  const originalSend = documentClient.send;
  const previousVersion = process.env.ERASURE_PROTOCOL_VERSION;
  const previousTable = process.env.STATE_TABLE_NAME;
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  process.env.STATE_TABLE_NAME = "test-state";
  documentClient.send = async command => {
    if (command.constructor.name === "GetCommand" && command.input.Key.sk === "EPOCH") return { Item: { epoch: 1 } };
    return {};
  };
  const audit = t.mock.method(StateRepository.prototype, "audit", async () => {});
  const completed = t.mock.method(StateRepository.prototype, "markDeliveryCompleted", async () => {});
  t.mock.method(OrphanRecoveringSynchronizer.prototype, "process", async function (delivery) {
    const action=delivery.id.includes("project-comment")
      ?"erasure_project_comment_replay_suppressed":"todoist_erased_item_replay_suppressed";
    await this.state.audit(delivery.profile, action, {});
  });
  t.after(() => {
    documentClient.send = originalSend;
    if (previousVersion === undefined) delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION = previousVersion;
    if (previousTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = previousTable;
  });
  const delivery = {
    id: "todoist-webhook-id", kind: "todoist", profile: "home", mode: "aws",
    receivedAt: new Date().toISOString(), headers: {}, erasureEpoch: 1,
    body: JSON.stringify({ event_name: "item:updated", event_data: { id: "erased-task-id" } }),
  };
  const projectCommentDelivery={...delivery,id:"todoist-webhook-project-comment"};
  const result = await handler({ Records: [
    { messageId: "message-erased", body: JSON.stringify(delivery), attributes: {}, messageAttributes: {} },
    { messageId: "message-project-comment", body: JSON.stringify(projectCommentDelivery), attributes: {}, messageAttributes: {} },
  ] }, { awsRequestId: "request-erased" });
  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(audit.mock.callCount(), 2);
  assert.deepEqual(audit.mock.calls.map(call=>call.arguments[2]), [{},{}]);
  assert.equal(completed.mock.callCount(), 0);
});

test("failed erased-item suppression audit cannot create an identity-bearing incident", async (t) => {
  const originalSend = documentClient.send;
  const previousVersion = process.env.ERASURE_PROTOCOL_VERSION;
  const previousTable = process.env.STATE_TABLE_NAME;
  process.env.ERASURE_PROTOCOL_VERSION = "1";
  process.env.STATE_TABLE_NAME = "test-state";
  documentClient.send = async command => {
    if (command.constructor.name === "GetCommand" && command.input.Key.sk === "EPOCH") return { Item: { epoch: 1 } };
    return {};
  };
  t.mock.method(StateRepository.prototype, "audit", async () => { throw new Error("audit write unavailable"); });
  const completed = t.mock.method(StateRepository.prototype, "markDeliveryCompleted", async () => {});
  const failureReports = t.mock.method(ManualInterventionService.prototype, "reportDeliveryFailure", async () => {});
  t.mock.method(OrphanRecoveringSynchronizer.prototype, "process", async function (delivery) {
    await this.state.audit(delivery.profile, "todoist_erased_item_replay_suppressed", {});
  });
  t.after(() => {
    documentClient.send = originalSend;
    if (previousVersion === undefined) delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION = previousVersion;
    if (previousTable === undefined) delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME = previousTable;
  });
  const delivery = {
    id: "todoist-webhook-id", kind: "todoist", profile: "home", mode: "aws",
    receivedAt: new Date().toISOString(), headers: {}, erasureEpoch: 1,
    body: JSON.stringify({ event_name: "item:updated", event_data: { id: "erased-task-id" } }),
  };
  const result = await handler({ Records: [{ messageId: "message-erased", body: JSON.stringify(delivery), attributes: {}, messageAttributes: {} }] }, { awsRequestId: "request-erased-audit-failure" });
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "message-erased" }]);
  assert.equal(completed.mock.callCount(), 0);
  assert.equal(failureReports.mock.callCount(), 0);
});

test("project-comment tombstone suppresses deleted Todoist webhooks before manual review or DynamoDB writes",async t=>{
  const previous={protocol:process.env.ERASURE_PROTOCOL_VERSION,barrier:process.env.ERASURE_REPLAY_BARRIER_VERSION,
    googlePrefix:process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX,todoistPrefix:process.env.TODOIST_TOKEN_PARAMETER_PREFIX};
  process.env.ERASURE_PROTOCOL_VERSION="0";process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX="/test/tombstone-google";
  process.env.TODOIST_TOKEN_PARAMETER_PREFIX="/test/tombstone-todoist";
  t.mock.method(SSMClient.prototype,"send",async command=>{
    if(command.input.Name==="/test/tombstone-google/home")
      return {Parameter:{Value:JSON.stringify({client_id:"test",client_secret:"test",refresh_token:"test"})}};
    if(command.input.Name==="/test/tombstone-todoist/home")return {Parameter:{Value:"test-token"}};
    throw new Error("unexpected secure parameter read in tombstone test");
  });
  const projectId=profiles.home.todoistProjectId;
  const createdAt=new Date().toISOString();
  const content=serializeDeletionTombstoneComment({schemaVersion:1,profile:"home",projectId,
    taskId:"erased-task-id",eventIds:["erased-event-id"],createdAt,
    expiresAt:projectDeletionTombstoneExpiry(createdAt)});
  t.mock.method(Todoist.prototype,"listProjectComments",async()=>[
    {id:"tombstone-comment",project_id:projectId,content},
  ]);
  const audits=t.mock.method(StateRepository.prototype,"audit",async()=>{});
  const completed=t.mock.method(StateRepository.prototype,"markDeliveryCompleted",async()=>{});
  const manual=t.mock.method(ManualInterventionService.prototype,"interceptTodoistDeletion",async()=>{
    throw new Error("manual interception must not run before tombstone admission");
  });
  const syncProcess=t.mock.method(OrphanRecoveringSynchronizer.prototype,"process",async()=>{
    throw new Error("synchronizer must not run for an active tombstone");
  });
  t.after(()=>{
    if(previous.protocol===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;else process.env.ERASURE_PROTOCOL_VERSION=previous.protocol;
    if(previous.barrier===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous.barrier;
    if(previous.googlePrefix===undefined)delete process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX;else process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX=previous.googlePrefix;
    if(previous.todoistPrefix===undefined)delete process.env.TODOIST_TOKEN_PARAMETER_PREFIX;else process.env.TODOIST_TOKEN_PARAMETER_PREFIX=previous.todoistPrefix;
  });
  const delivery={id:"stale-deleted-task",kind:"todoist",profile:"home",mode:"aws",
    receivedAt:new Date().toISOString(),headers:{},body:JSON.stringify({event_name:"item:deleted",
      event_data:{id:"erased-task-id",is_deleted:true}})};
  const result=await handler({Records:[{messageId:"stale-delete-message",body:JSON.stringify(delivery),attributes:{},messageAttributes:{}}]},
    {awsRequestId:"tombstone-delete-request"});
  assert.deepEqual(result.batchItemFailures,[]);
  assert.equal(audits.mock.callCount(),1);
  assert.deepEqual(audits.mock.calls[0].arguments.slice(1),["erasure_project_comment_replay_suppressed",{side:"todoist"}]);
  assert.equal(completed.mock.callCount(),0);
  assert.equal(manual.mock.callCount(),0);
  assert.equal(syncProcess.mock.callCount(),0);
});

test("tombstone lookup failure retries without writing task identity or review state",async t=>{
  const previous={protocol:process.env.ERASURE_PROTOCOL_VERSION,barrier:process.env.ERASURE_REPLAY_BARRIER_VERSION};
  process.env.ERASURE_PROTOCOL_VERSION="0";process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  t.mock.method(Todoist.prototype,"listProjectComments",async()=>{throw new Error("Todoist unavailable");});
  const audit=t.mock.method(StateRepository.prototype,"audit",async()=>{});
  const completed=t.mock.method(StateRepository.prototype,"markDeliveryCompleted",async()=>{});
  const report=t.mock.method(ManualInterventionService.prototype,"reportDeliveryFailure",async()=>{});
  t.after(()=>{
    if(previous.protocol===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;else process.env.ERASURE_PROTOCOL_VERSION=previous.protocol;
    if(previous.barrier===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous.barrier;
  });
  const delivery={id:"stale-deleted-task",kind:"todoist",profile:"home",mode:"aws",
    receivedAt:new Date().toISOString(),headers:{},body:JSON.stringify({event_name:"item:deleted",
      event_data:{id:"erased-task-id",is_deleted:true}})};
  const result=await handler({Records:[{messageId:"lookup-failure-message",body:JSON.stringify(delivery),attributes:{},messageAttributes:{}}]},
    {awsRequestId:"tombstone-lookup-failure"});
  assert.deepEqual(result.batchItemFailures,[{itemIdentifier:"lookup-failure-message"}]);
  assert.equal(audit.mock.callCount(),0);
  assert.equal(completed.mock.callCount(),0);
  assert.equal(report.mock.callCount(),0);
});

test("worker rejects replay barrier without lease protocol before any DynamoDB write",async t=>{
  const previous={protocol:process.env.ERASURE_PROTOCOL_VERSION,barrier:process.env.ERASURE_REPLAY_BARRIER_VERSION};
  process.env.ERASURE_PROTOCOL_VERSION="0";
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  let calls=0;
  t.mock.method(documentClient,"send",async()=>{calls++;throw new Error("worker must not touch state");});
  t.after(()=>{
    if(previous.protocol===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;
    else process.env.ERASURE_PROTOCOL_VERSION=previous.protocol;
    if(previous.barrier===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous.barrier;
  });
  const delivery={id:"calendar-replay-config-mismatch",kind:"calendar",profile:"work",mode:"aws",
    receivedAt:"2026-11-04T00:00:00.000Z",headers:{},body:""};
  const result=await handler({Records:[{messageId:"mismatch-message",body:JSON.stringify(delivery),attributes:{},messageAttributes:{}}]},
    {awsRequestId:"mismatch-request"});
  assert.deepEqual(result.batchItemFailures,[{itemIdentifier:"mismatch-message"}]);
  assert.equal(calls,0);
});
