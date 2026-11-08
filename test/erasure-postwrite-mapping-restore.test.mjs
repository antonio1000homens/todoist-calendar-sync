import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand,UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {GetEventSourceMappingCommand,ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand} from "@aws-sdk/client-lambda";
import {postWriteWorkerMappingManifest} from "../dist/erasure-replay-barrier.js";
import {restorePostWriteWorkerMappings} from "../dist/erasure-postwrite-mapping-restore.js";

const previous={table:process.env.STATE_TABLE_NAME,protocol:process.env.ERASURE_PROTOCOL_VERSION,
  barrier:process.env.ERASURE_REPLAY_BARRIER_VERSION};
process.env.STATE_TABLE_NAME="postwrite-mapping-test";
process.env.ERASURE_PROTOCOL_VERSION="1";
process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
test.after(()=>{
  if(previous.table===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=previous.table;
  if(previous.protocol===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;else process.env.ERASURE_PROTOCOL_VERSION=previous.protocol;
  if(previous.barrier===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;else process.env.ERASURE_REPLAY_BARRIER_VERSION=previous.barrier;
});

const functionName="worker-test";
const functionArn=`arn:aws:lambda:eu-west-2:111111111111:function:${functionName}`;
const mappings=[
  {id:"11111111-1111-4111-8111-111111111111",eventSourceArn:"arn:aws:sqs:eu-west-2:111111111111:home.fifo",functionArn},
  {id:"22222222-2222-4222-8222-222222222222",eventSourceArn:"arn:aws:sqs:eu-west-2:111111111111:work.fifo",functionArn},
];
const operationId="postwrite-restore-test";

function fixture(t,{inventory=mappings,states=new Map([[mappings[0].id,"Disabled"],[mappings[1].id,"Disabled"]]),
  completed=false,failEnable=false}={}) {
  const manifest=postWriteWorkerMappingManifest({mappingIds:mappings.map(item=>item.id),
    enabledMappingIds:[mappings[0].id]});
  let record={pk:`ERASURE_POSTWRITE_RESTORE#${operationId}`,sk:"STATE",schemaVersion:1,
    operationId,profile:"home",epoch:7,state:completed?"complete":"pending",
    mappingIds:manifest.mappingIds,enabledMappingIds:manifest.enabledMappingIds,
    mappingFingerprint:manifest.fingerprint,...(completed?{verifiedAt:"2026-11-08T12:00:00.000Z"}:{})};
  const databaseCommands=[],lambdaCommands=[];
  const db={async send(command) {
    databaseCommands.push(command);
    if(command instanceof GetCommand) {
      if(command.input.Key.pk===`ERASURE_POSTWRITE_RESTORE#${operationId}`)return {Item:{...record}};
      if(command.input.Key.pk==="ERASURE#home"&&command.input.Key.sk==="EPOCH")return {Item:{epoch:7}};
    }
    if(command instanceof UpdateCommand) {
      assert.equal(record.state,"pending");
      record={...record,state:"complete",verifiedAt:command.input.ExpressionAttributeValues[":verifiedAt"]};
      return {};
    }
    throw new Error(`Unexpected database command ${command.constructor.name}`);
  }};
  const lambda={async send(command) {
    lambdaCommands.push(command);
    if(command instanceof ListEventSourceMappingsCommand)
      return {EventSourceMappings:inventory.map(item=>({UUID:item.id,EventSourceArn:item.eventSourceArn,
        FunctionArn:item.functionArn,State:states.get(item.id)}))};
    if(command instanceof GetEventSourceMappingCommand) {
      const item=mappings.find(candidate=>candidate.id===command.input.UUID);
      if(!item)throw new Error("Unknown mapping");
      return {UUID:item.id,EventSourceArn:item.eventSourceArn,FunctionArn:item.functionArn,
        State:states.get(item.id)};
    }
    if(command instanceof UpdateEventSourceMappingCommand) {
      assert.equal(command.input.Enabled,true,"restoration may only enable a mapping");
      if(failEnable)throw new Error("Lambda update unavailable");
      states.set(command.input.UUID,"Enabled");
      return {};
    }
    throw new Error(`Unexpected Lambda command ${command.constructor.name}`);
  }};
  let leaseAcquired=0,leaseReleased=0;
  const sources={db,lambda,functionName,now:()=>new Date("2026-11-08T12:00:00.000Z"),pause:async()=>{},
    acquireWriterLease:async(profile,epoch)=>{
      assert.equal(profile,"home");assert.equal(epoch,7);leaseAcquired++;
      return async()=>{leaseReleased++;};
    }};
  return {sources,states,databaseCommands,lambdaCommands,get record(){return record;},
    get leaseAcquired(){return leaseAcquired;},get leaseReleased(){return leaseReleased;}};
}

test("restoration re-enables only originally enabled mappings and commits after full readback",async t=>{
  const f=fixture(t);
  const result=await restorePostWriteWorkerMappings(operationId,f.sources);
  assert.deepEqual(result,{state:"complete",alreadyComplete:false,mappingCount:2});
  assert.equal(f.states.get(mappings[0].id),"Enabled");
  assert.equal(f.states.get(mappings[1].id),"Disabled");
  assert.equal(f.lambdaCommands.filter(command=>command instanceof UpdateEventSourceMappingCommand).length,1);
  assert.equal(f.record.state,"complete");
  assert.equal(f.record.verifiedAt,"2026-11-08T12:00:00.000Z");
  assert.equal(f.leaseAcquired,1);assert.equal(f.leaseReleased,1);
});

test("an unexpected mapping inventory leaves restoration pending and changes no mapping",async t=>{
  const extra={id:"33333333-3333-4333-8333-333333333333",
    eventSourceArn:"arn:aws:sqs:eu-west-2:111111111111:unexpected.fifo",functionArn};
  const f=fixture(t,{inventory:[...mappings,extra]});
  await assert.rejects(restorePostWriteWorkerMappings(operationId,f.sources),/inventory differs/);
  assert.equal(f.states.get(mappings[0].id),"Disabled");
  assert.equal(f.states.get(mappings[1].id),"Disabled");
  assert.equal(f.lambdaCommands.some(command=>command instanceof UpdateEventSourceMappingCommand),false);
  assert.equal(f.record.state,"pending");
  assert.equal(f.leaseReleased,1);
});

test("a failed mapping enable leaves the durable restore pending for retry",async t=>{
  const f=fixture(t,{failEnable:true});
  await assert.rejects(restorePostWriteWorkerMappings(operationId,f.sources),/Lambda update unavailable/);
  assert.equal(f.states.get(mappings[0].id),"Disabled");
  assert.equal(f.states.get(mappings[1].id),"Disabled");
  assert.equal(f.record.state,"pending");
  assert.equal(f.databaseCommands.some(command=>command instanceof UpdateCommand),false);
  assert.equal(f.leaseReleased,1);
});

test("a completed restoration is idempotent and performs no Lambda operations",async t=>{
  const f=fixture(t,{completed:true});
  const result=await restorePostWriteWorkerMappings(operationId,f.sources);
  assert.deepEqual(result,{state:"complete",alreadyComplete:true,mappingCount:2});
  assert.equal(f.lambdaCommands.length,0);
  assert.equal(f.leaseAcquired,0);assert.equal(f.leaseReleased,0);
});
