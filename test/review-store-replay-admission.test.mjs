import assert from "node:assert/strict";
import test from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureReplayBlockedError } from "../dist/erasure-replay-barrier.js";
import { assertManualDecisionReplayAdmission, assertRepairPreviewReplayAdmission, ReviewStore, reviewHash, SyncControls } from "../dist/review-store.js";
import { serializeDeletionTombstoneComment } from "../dist/mapping-comments.js";
import { profiles } from "../dist/config.js";
import { Todoist } from "../dist/providers.js";

function enableBarrier(t) {
  const names=["ERASURE_REPLAY_BARRIER_VERSION","ERASURE_PROTOCOL_VERSION",
    "RETIREMENT_DISPOSITION_VERSION","STATE_TABLE_NAME"];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  process.env.ERASURE_PROTOCOL_VERSION="1";
  process.env.RETIREMENT_DISPOSITION_VERSION="0";
  process.env.STATE_TABLE_NAME="review-replay-admission-test";
  t.mock.method(SSMClient.prototype,"send",async()=>({Parameter:{Value:"test-todoist-token"}}));
  const projectId=profiles.home.todoistProjectId;
  const createdAt=new Date().toISOString();
  const expiresAt=new Date(Date.parse(createdAt)+18*24*60*60*1000).toISOString();
  // Retired HMAC markers are not part of the current release contract.
  // Each historical regression identity is represented by a bounded,
  // exact existing-project tombstone rather than an imaginary DynamoDB row.
  const erasedIds=[
    "erased-context-task","erased-candidate-object","erased-master-alias",
    "erased-embedded-master","erased-history-master","erased-candidate-task",
    "erased-dismiss-task","erased-update-event","erased-cleanup-master",
    "erased-closure-task","erased-case-task","erased-control-task",
  ];
  const comments=erasedIds.map((id,index)=>({
    id:"erased-project-comment-"+index,project_id:projectId,
    content:serializeDeletionTombstoneComment({
      schemaVersion:1,profile:"home",projectId,taskId:id,
      eventIds:[id],createdAt,expiresAt,
    }),
  }));
  const projectCommentReader=t.mock.method(Todoist.prototype,"listProjectComments",async()=>comments);
  t.after(()=>{for(const [name,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }});
  return projectCommentReader;
}
function decision(overrides = {}) {
  return {
    decisionId: "decision-1", profile: "home", type: "todoist_unmapped_conflict",
    severity: "warning", status: "pending", createdAt: new Date().toISOString(),
    decisionDeadline: new Date(Date.now() + 60_000).toISOString(), context: {},
    fingerprint: "decision-fingerprint", permittedActions: [], ...overrides,
  };
}

test("manual and repair review admissions consult bounded project-comment tombstones", async t => {
  const projectCommentReader = enableBarrier(t);
  const stateWrites = [];
  t.mock.method(documentClient, "send", async command => { stateWrites.push(command); return {}; });
  const projectId = profiles.home.todoistProjectId;
  const createdAt = new Date().toISOString();
  const comment = {
    id: "project-tombstone", project_id: projectId,
    content: serializeDeletionTombstoneComment({
      schemaVersion: 1, profile: "home", projectId, taskId: "erased-review-task",
      eventIds: ["erased-review-event"], createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 18 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  };
  const reads = [];
  const clientFactory = async profile => ({todoist:{
    async listProjectComments(id, refresh) {
      reads.push({profile,id,refresh});
      return [comment];
    },
  }});

  await assert.rejects(assertManualDecisionReplayAdmission(
    decision({taskId:"erased-review-task"}), clientFactory), ErasureReplayBlockedError);
  await assert.rejects(assertRepairPreviewReplayAdmission({
    intent:{profile:"home",action:"link",taskId:"safe-task",eventId:"erased-review-event"},
    snapshots:[],itemPlan:[],
  }, clientFactory), ErasureReplayBlockedError);
  assert.deepEqual(reads,[
    {profile:"home",id:projectId,refresh:true},
    {profile:"home",id:projectId,refresh:true},
  ]);

  projectCommentReader.mock.mockImplementation(async () => [comment]);
  await assert.rejects(new ReviewStore().observeDecision(decision({taskId:"erased-review-task"})), ErasureReplayBlockedError);
  assert.equal(stateWrites.some(command => ["PutCommand","UpdateCommand","DeleteCommand","TransactWriteCommand"]
    .includes(command.constructor.name)), false, "a tombstoned manual decision is rejected before any DynamoDB write");
});

test("review admission fails closed when project-comment tombstone reads are unavailable", async t => {
  enableBarrier(t);
  t.mock.method(documentClient, "send", async () => ({}));
  await assert.rejects(assertManualDecisionReplayAdmission(
    decision({taskId:"possibly-erased-task"}),
    async () => ({todoist:{async listProjectComments(){throw new Error("Todoist unavailable");}}}),
  ), /Todoist unavailable/);
});

test("decision context provider IDs are checked before a review case can be seeded", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(new ReviewStore().observeDecision(decision({context: {providerTaskId: "erased-context-task"}})), ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("manual decision candidate object IDs are checked before review seeding", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(new ReviewStore().observeDecision(decision({context:{candidates:[
    {id:"erased-candidate-object",content:"opaque fixture",due:""},
  ]}})),ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("mapping snapshot recurrence aliases are checked before a decision is persisted", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  const mapping = {profile:"home",taskId:"safe-task",eventId:"safe-occurrence",masterEventId:"erased-master-alias",
    activeInstanceId:"safe-occurrence",seriesId:"erased-master-alias",updatedAt:new Date().toISOString()};
  await assert.rejects(new ReviewStore().observeDecision(decision({mappingSnapshot:mapping})), ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("queued repair admission walks embedded decision and review aliases", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  const preview = {
    intent: {profile:"home",action:"link",taskId:"safe-task",eventId:"safe-event"},
    snapshots: [], itemPlan: [],
    case: {decision:{profile:"home",mappingSnapshot:{profile:"home",taskId:"safe-task",eventId:"safe-event",
      masterEventId:"erased-embedded-master"}}},
  };
  await assert.rejects(assertRepairPreviewReplayAdmission(preview), ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

for (const [field, erasedId] of [
  ["calendarProjectionId", "erased-calendar-projection"],
  ["syncHistoryMasterId", "erased-sync-history-master"],
]) test(`queued repair admission checks nested ${field}`, async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  const preview = {
    intent: {profile:"home",action:"link",taskId:"safe-task",eventId:"safe-event"},
    snapshots: [{ref:{profile:"home",side:"todoist",id:"safe-task"},[field]:erasedId}], itemPlan: [],
  };
  await assert.rejects(assertRepairPreviewReplayAdmission(preview), ErasureReplayBlockedError);
  assert.equal(calls.length,0,"nested aliases are rejected by the project-comment tombstone");
});

test("review admission checks recurring master aliases carried by history plans", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  const preview = {intent:{profile:"home",action:"link",taskId:"safe-task",eventId:"safe-event"},snapshots:[],itemPlan:[],
    case:{decision:{profile:"home",elapsedCalendarHistoryPlan:{taskId:"safe-task",eventId:"safe-event",
      recurringMasterId:"erased-history-master"}}}};
  await assert.rejects(assertRepairPreviewReplayAdmission(preview),ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("candidate IDs in conflict audit arrays are checked before an incident case is seeded", async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  const audit = { pk: "AUDIT#conflict", action: "todoist_snapshot_reconcile_unmapped_conflict",
    detail: { candidateTaskIds: ["erased-candidate-task"] }, createdAt: new Date().toISOString() };
  await assert.rejects(new ReviewStore().observeConflictIncident("home", "fingerprint", "incident", audit), ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("dismissal refuses to mutate a review case that references an erased identity", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",taskId:"erased-dismiss-task",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(store.dismissCase("case-1","acknowledged"),ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("case status transitions refuse to mutate a case that references an erased identity", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",eventId:"erased-update-event",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(store.updateCase("case-1","dismissed","acknowledged"),ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("deferred deletion cleanup refuses to update a case that references an erased identity", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",masterEventId:"erased-cleanup-master",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(store.noteVerifiedDeletionCleanupDeferred("case-1",new Date().toISOString()),ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("verified-deleted case closure refuses an erased identity before cleanup reads", async t => {
  enableBarrier(t);
  const store = new ReviewStore();
  store.getCase = async () => ({id:"case-1",profile:"home",status:"open",taskId:"erased-closure-task",
    eventId:"safe-event",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(store.resolveVerifiedDeletedCase("case-1",{profile:"home",taskIds:["erased-closure-task"],eventIds:["safe-event"]}),ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});

test("coalescing refuses to close an open case that references an erased candidate", async t => {
  enableBarrier(t);
  const conflictKey = reviewHash("conflict");
  const keeper = { id: "decision-1", profile: "home", status: "open", conflictKey,
    taskId: "safe-task", createdAt: "2026-11-04T12:00:00.000Z", updatedAt: "2026-11-04T12:00:00.000Z" };
  const candidate = { id: "incident-old", profile: "home", status: "open", conflictKey,
    taskId: "erased-case-task", eventId: "safe-event", createdAt: "2026-11-04T11:00:00.000Z" };
  const store = new ReviewStore();
  store.getCase = async id => id === keeper.id ? keeper : id === candidate.id ? candidate : undefined;
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    if (command.constructor.name === "QueryCommand" && command.input.KeyConditionExpression.startsWith("pk ="))
      return { Items: [{ incidentId: candidate.id }] };
    return {};
  });
  await assert.rejects(store.observeDecision(decision({
    context: { conflictKey }, taskId: "safe-task",
  })), ErasureReplayBlockedError);
  assert.equal(calls.some(command => command.constructor.name === "UpdateCommand"), false,
    "the conflict case must remain open when its erased identity is encountered");
});

const syncControlWrites = [
  ["pair rejection", controls => controls.reject("home", "erased-control-task", "safe-event", "repair-1")],
  ["pair allowance", controls => controls.allow("home", "erased-control-task", "safe-event")],
  ["repair claim", controls => controls.claim([{profile:"home",side:"todoist",id:"erased-control-task"}], "repair-1")],
  ["unapplied release", controls => controls.releaseUnapplied([{profile:"home",side:"todoist",id:"erased-control-task"}], "repair-1",
    [{ref:{profile:"home",side:"todoist",id:"erased-control-task"},control:{}}], {error:"failed",nextAction:"refresh"})],
  ["exclusion update", controls => controls.exclude({profile:"home",side:"todoist",id:"erased-control-task"}, true, "repair-1")],
  ["repair release", controls => controls.release({profile:"home",side:"todoist",id:"erased-control-task"}, "repair-1")],
  ["pending refresh clear", controls => controls.clearPendingRefresh([{profile:"home",side:"todoist",id:"erased-control-task",pendingRefreshAt:"token"}])],
  ["blocked control update", controls => controls.blocked("home", {taskId:"erased-control-task"})],
];
for (const [name, invoke] of syncControlWrites) test(`SyncControls refuses ${name} for an erased identity`, async t => {
  enableBarrier(t);
  const calls = [];
  t.mock.method(documentClient, "send", async command => {
    calls.push(command);
    return {};
  });
  await assert.rejects(invoke(new SyncControls()), ErasureReplayBlockedError);
  assert.equal(calls.length,0,"bounded project-comment tombstone blocks before any DynamoDB access");
});
