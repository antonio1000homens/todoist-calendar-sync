import test from "node:test";
import assert from "node:assert/strict";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { guardReplayProviderClients } from "../dist/erasure-replay-providers.js";
import { assertReplayAdmissionIfEnabled } from "../dist/erasure-replay-barrier.js";
import {
  retirementDispositionKeys,
  retirementDispositionEnabled,
  isRetiredIdentity,
  assertRetirementAdmissionIfEnabled,
  RetirementDispositionBlockedError,
  RetirementDispositionUnavailableError,
} from "../dist/recurrence-retirement-disposition.js";

const ids={profile:"work",taskId:"task351",
  eventIds:["occurrence-351","master-351"],seriesIds:["series-uid-351"]};
const retired={profile:"work",operationId:"retire-351",status:"retired",taskId:ids.taskId,
  seriesId:ids.seriesIds[0],masterEventId:"master-351",createdAt:"2026-11-06T19:00:00Z"};
function enable(t){
  const original={version:process.env.RETIREMENT_DISPOSITION_VERSION,table:process.env.STATE_TABLE_NAME};
  process.env.RETIREMENT_DISPOSITION_VERSION="1";
  process.env.STATE_TABLE_NAME="test-retirement-table";
  t.after(()=>{
    if(original.version===undefined)delete process.env.RETIREMENT_DISPOSITION_VERSION;
    else process.env.RETIREMENT_DISPOSITION_VERSION=original.version;
    if(original.table===undefined)delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME=original.table;
  });
}
test("#351 retirement keys are exact, typed and profile-scoped",()=>{
  assert.deepEqual(retirementDispositionKeys(ids).map(x=>x.pk),[
    "RETIREMENT#work#TASK#task351",
    "RETIREMENT#work#EVENT#occurrence-351",
    "RETIREMENT#work#EVENT#master-351",
    "RETIREMENT#work#SERIES#series-uid-351",
  ]);
  assert.notDeepEqual(retirementDispositionKeys({...ids,profile:"home"}),
    retirementDispositionKeys(ids));
  assert.throws(()=>retirementDispositionKeys({profile:"work"}),RetirementDispositionUnavailableError);
  assert.throws(()=>retirementDispositionKeys({...ids,eventIds:["master-351","master-351"]}),
    RetirementDispositionUnavailableError);
});
test("#351 only current operation's own exact marker blocks identity; others remain writable",async t=>{
  enable(t);
  const keys=[];
  t.mock.method(documentClient,"send",async cmd=>{
    assert.equal(cmd.constructor.name,"GetCommand");
    assert.equal(cmd.input.ConsistentRead,true);
    keys.push(cmd.input.Key);
    return {Item:cmd.input.Key.pk==="RETIREMENT#work#EVENT#master-351"?retired:undefined};
  });
  assert.equal(await isRetiredIdentity(ids),true);
  await assert.rejects(()=>assertRetirementAdmissionIfEnabled(ids),RetirementDispositionBlockedError);
  assert.equal(await isRetiredIdentity({profile:"home",taskId:ids.taskId}),false);
  assert.equal(await isRetiredIdentity({profile:"work",taskId:"future-task"}),false);
  assert.ok(keys.some(x=>x.pk==="RETIREMENT#work#EVENT#master-351"));
  assert.ok(keys.every(x=>x.sk==="STATE"));
});
test("#351 a preparing or releasing marker already fences stale workers",async t=>{
  enable(t);
  let status="preparing";
  t.mock.method(documentClient,"send",async()=>({Item:{...retired,status}}));
  await assert.rejects(()=>assertRetirementAdmissionIfEnabled({profile:"work",taskId:"task351"}),RetirementDispositionBlockedError);
  status="releasing";
  await assert.rejects(()=>assertRetirementAdmissionIfEnabled({profile:"work",taskId:"task351"}),RetirementDispositionBlockedError);
  status="unknown";
  await assert.rejects(()=>assertRetirementAdmissionIfEnabled({profile:"work",taskId:"task351"}),RetirementDispositionUnavailableError);
});
test("#351 provider/read admission fails closed on AWS outage or missing table",async t=>{
  enable(t);
  t.mock.method(documentClient,"send",async()=>{throw new Error("Dynamo outage");});
  await assert.rejects(()=>isRetiredIdentity(ids),RetirementDispositionUnavailableError);
  await assert.rejects(()=>assertRetirementAdmissionIfEnabled(ids),RetirementDispositionUnavailableError);
  delete process.env.STATE_TABLE_NAME;
  await assert.rejects(()=>isRetiredIdentity(ids),RetirementDispositionUnavailableError);
});
test("#351 standalone provider write wrapper refuses retired task and Calendar master before writes",async t=>{
  enable(t);
  let writes=0;
  const clients=guardReplayProviderClients("work",{
    calendar:{async deleteEvent(){writes++;},async upsertEvent(){writes++;}},
    todoist:{async upsertTask(){writes++;},async updateTaskMetadata(){writes++;}},
  });
  t.mock.method(documentClient,"send",async cmd=>({Item:[
    "RETIREMENT#work#EVENT#master-351","RETIREMENT#work#TASK#task351"
  ].includes(cmd.input.Key.pk)?retired:undefined}));
  await assert.rejects(()=>clients.calendar.deleteEvent("master-351"),RetirementDispositionBlockedError);
  await assert.rejects(()=>clients.todoist.updateTaskMetadata("task351",{content:"Change"}),RetirementDispositionBlockedError);
  await assert.rejects(()=>clients.todoist.upsertTask({content:"should not change"},"task351"),RetirementDispositionBlockedError);
  assert.equal(writes,0);
});
test("#351 state write admission enforces retirement even when erasure barrier is OFF",async t=>{
  enable(t);
  const old=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  t.after(()=>{if(old===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=old;});
  t.mock.method(documentClient,"send",async cmd=>({Item:cmd.input.Key.pk==="RETIREMENT#work#TASK#task351"?retired:undefined}));
  await assert.rejects(()=>assertReplayAdmissionIfEnabled({profile:"work",taskId:"task351"}),
    RetirementDispositionBlockedError);
});
test("#351 guard rollout remains explicitly staged and unknown version fails closed",t=>{
  const old=process.env.RETIREMENT_DISPOSITION_VERSION;
  t.after(()=>{if(old===undefined)delete process.env.RETIREMENT_DISPOSITION_VERSION;
    else process.env.RETIREMENT_DISPOSITION_VERSION=old;});
  process.env.RETIREMENT_DISPOSITION_VERSION="0";
  assert.equal(retirementDispositionEnabled(),false);
  process.env.RETIREMENT_DISPOSITION_VERSION="2";
  assert.throws(()=>retirementDispositionEnabled(),RetirementDispositionUnavailableError);
});
