import assert from "node:assert/strict";
import test from "node:test";
import {SSMClient} from "@aws-sdk/client-ssm";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {ErasureReplayBlockedError} from "../dist/erasure-replay-barrier.js";
import {ManualDecisionStore} from "../dist/manual-intervention.js";
import {Todoist} from "../dist/providers.js";
import {profiles} from "../dist/config.js";
import {serializeDeletionTombstoneComment} from "../dist/mapping-comments.js";

function enableCurrentTombstoneAdmission(t) {
  const keys=["ERASURE_REPLAY_BARRIER_VERSION","RETIREMENT_DISPOSITION_VERSION","ERASURE_PROTOCOL_VERSION"];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  process.env.RETIREMENT_DISPOSITION_VERSION="0";
  process.env.ERASURE_PROTOCOL_VERSION="1";
  t.mock.method(SSMClient.prototype,"send",async()=>({Parameter:{Value:"test-todoist-token"}}));
  t.after(()=>{for(const [key,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
}

function storedDecision(overrides={}) {
  return {
    decisionId:"decision-1",profile:"home",type:"todoist_unmapped_conflict",
    severity:"warning",status:"pending",createdAt:"2026-11-04T12:00:00.000Z",
    decisionDeadline:"2026-11-11T12:00:00.000Z",context:{},
    fingerprint:"decision-fingerprint",permittedActions:[],...overrides,
  };
}

function stubStoreReads(t,{current,erasedId}){
  const calls=[],projectReads=[];
  const projectId=profiles.home.todoistProjectId;
  const createdAt=new Date().toISOString();
  const content=serializeDeletionTombstoneComment({
    schemaVersion:1,profile:"home",projectId,taskId:erasedId,eventIds:[erasedId],
    createdAt,expiresAt:new Date(Date.parse(createdAt)+18*86400_000).toISOString(),
  });
  t.mock.method(Todoist.prototype,"listProjectComments",async(...args)=>{
    projectReads.push(args);
    return [{id:"existing-project-comment",project_id:projectId,content}];
  });
  t.mock.method(documentClient,"send",async command=>{
    calls.push(command);
    if(command.constructor.name!=="GetCommand")
      throw Error("A tombstoned decision must not write DynamoDB");
    if(command.input.Key?.pk==="MANUAL#decision-1")return {Item:current};
    return {};
  });
  return {calls,projectReads};
}
function assertNoWrites(result){
  assert.ok(result.projectReads.length>0,"the exact project-comment tombstone was read");
  assert.equal(result.calls.some(command=>["PutCommand","UpdateCommand","DeleteCommand","TransactWriteCommand"]
    .includes(command.constructor.name)),false,"a tombstone hit must prevent every state write");
}

test("putPending rejects the bounded project tombstone before decision creation",async t=>{
  enableCurrentTombstoneAdmission(t);
  const f=stubStoreReads(t,{erasedId:"erased-new-task"});
  await assert.rejects(new ManualDecisionStore().putPending({
    decisionId:"decision-1",profile:"home",type:"todoist_unmapped_conflict",
    severity:"warning",taskId:"erased-new-task",context:{},fingerprint:"new",permittedActions:[],
  }),ErasureReplayBlockedError);
  assertNoWrites(f);
});

const updates=[
  ["replacement context", 
    {current:storedDecision({context:{providerTaskId:"safe-existing-task"}}),erasedId:"erased-replacement-event"},
    store=>store.refreshPendingContext("decision-1",{providerEventId:"erased-replacement-event"})],
  ["stored context", 
    {current:storedDecision({context:{providerTaskId:"erased-existing-task"}}),erasedId:"erased-existing-task"},
    store=>store.refreshPendingContext("decision-1",{providerTaskId:"safe-replacement-task"})],
  ["Slack location", 
    {current:storedDecision({context:{providerTaskId:"erased-slack-task"}}),erasedId:"erased-slack-task"},
    store=>store.setSlackLocation("decision-1","C123","1712345678.000001")],
  ["terminal decision", 
    {current:storedDecision({context:{providerTaskId:"erased-finish-task"}}),erasedId:"erased-finish-task"},
    store=>store.finish("decision-1","resolved","acknowledged")],
];
for(const [name,config,invoke] of updates) test(
  "manual decision "+name+" respects active project tombstones before state update",async t=>{
    enableCurrentTombstoneAdmission(t);
    const f=stubStoreReads(t,config);
    await assert.rejects(invoke(new ManualDecisionStore()),ErasureReplayBlockedError);
    assertNoWrites(f);
  });
