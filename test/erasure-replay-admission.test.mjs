import assert from "node:assert/strict";
import test from "node:test";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {StateRepository} from "../dist/repository.js";
import {
  assertReplayAdmissionIfEnabled, mappingReplayIdentity, ErasureReplayBlockedError,
  ErasureReplayUnavailableError, replayAdmissionEnabled,
} from "../dist/erasure-replay-barrier.js";

const before={
  version:process.env.ERASURE_REPLAY_BARRIER_VERSION,
  keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
  current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY,
};
process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({v1:Buffer.alloc(32,3).toString("base64")});
process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="v1";
test.after(()=>{
  for(const [key,value] of [
    ["ERASURE_REPLAY_BARRIER_VERSION",before.version],
    ["ERASURE_REPLAY_HMAC_KEYS",before.keys],
    ["ERASURE_REPLAY_HMAC_CURRENT_KEY",before.current],
  ]) if(value===undefined)delete process.env[key];else process.env[key]=value;
});

const mapping={
  profile:"work",taskId:"task-203",eventId:"event-203",
  masterEventId:"master-203",activeInstanceId:"instance-203",
  updatedAt:"2026-10-29T14:30:00.000Z",
};
const link={profile:"work",taskId:mapping.taskId,eventId:mapping.eventId,
  masterEventId:mapping.masterEventId,seriesId:mapping.taskId,owner:"todoist",updatedAt:mapping.updatedAt};

test("mapping identity protects task and every resolved master/instance alias",()=>{
  assert.deepEqual(mappingReplayIdentity(mapping),{profile:"work",taskId:"task-203",
    eventIds:["event-203","master-203","instance-203"]});
});

test("mapping, flatten, recurrence and metadata entrypoints share a fail-closed barrier",async t=>{
  let reads=0,writes=0;
  t.mock.method(documentClient,"send",async command=>{
    if(command.constructor.name==="GetCommand"&&String(command.input.Key?.pk).startsWith("ERASURE_REPLAY#")){
      assert.equal(command.input.ConsistentRead,true);
      reads++;
      return {Item:{markerVersion:1}};
    }
    writes++;
    throw new Error("Unauthorized state write");
  });
  const store=new StateRepository();
  const invocations=[
    ()=>store.putMapping(mapping),
    ()=>store.putRecurrenceLink(link),
    ()=>store.putNewRecurrenceMappingIfUnowned({...mapping,recurrenceOwner:"todoist",seriesId:mapping.taskId,masterEventId:mapping.eventId},
      {...link,masterEventId:mapping.eventId}),
    ()=>store.commitFlattenMapping({operationId:"op-203",mapping:{...mapping,masterEventId:undefined,activeInstanceId:undefined},
      previous:[],links:[]}),
    ()=>store.updateCalendarOwnedMetadataIfUnchanged(
      {...mapping,recurrenceOwner:"calendar",seriesId:"series-203"},
      {...link,owner:"calendar",seriesId:"series-203"},
      {...mapping,recurrenceOwner:"calendar",seriesId:"series-203"}),
    ()=>store.advanceCalendarSeriesMapping({previous:mapping,mapping,expectedLink:link,link}),
    ()=>store.transferCalendarSeriesMapping({mapping,link}),
    ()=>store.beginFutureSeriesSplit("work",mapping.taskId,"master-old","master-new"),
    ()=>store.putConsolidationGuard("work","task-discarded",mapping.taskId,"decision-1","event-203",mapping),
    ()=>store.commitRecurrenceConsolidation({mapping,link,previousMapping:mapping,previousLink:link,discardedTaskId:"task-discarded",decisionId:"decision-1"}),
    ()=>store.restoreMappingIndexesIfOwned(mapping,link),
    ()=>store.putCompletedCalendarProjection({profile:"work",taskId:mapping.taskId,eventId:mapping.eventId,completedAt:"2026-10-01T00:00:00Z"}),
    ()=>store.recordRecurrence("work",mapping.eventId,["RRULE:FREQ=DAILY"]),
  ];
  for(const invoke of invocations)await assert.rejects(invoke(),ErasureReplayBlockedError);
  assert.equal(reads,invocations.length);
  assert.equal(writes,0,"no provider/state mutation may occur after marker discovery");
});

test("barrier read errors deny mapping writes, not silently fall back to a stale mapping",async t=>{
  let writes=0;
  t.mock.method(documentClient,"send",async command=>{
    if(command.constructor.name==="GetCommand")throw new Error("DynamoDB unavailable");
    writes++;return {};
  });
  await assert.rejects(new StateRepository().putMapping(mapping),ErasureReplayUnavailableError);
  assert.equal(writes,0);
});

test("rollout is explicitly gated and a bad version fails closed",async t=>{
  const old=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  t.after(()=>{process.env.ERASURE_REPLAY_BARRIER_VERSION=old;});
  process.env.ERASURE_REPLAY_BARRIER_VERSION="0";
  assert.equal(replayAdmissionEnabled(),false);
  await assertReplayAdmissionIfEnabled({profile:"work",taskId:"task-203"},{
    async send(){throw new Error("disabled gate must not attempt a lookup");},
  });
  process.env.ERASURE_REPLAY_BARRIER_VERSION="unrecognised";
  assert.throws(()=>replayAdmissionEnabled(),ErasureReplayUnavailableError);
  await assert.rejects(assertReplayAdmissionIfEnabled({profile:"work",taskId:"task-203"}),ErasureReplayUnavailableError);
});
