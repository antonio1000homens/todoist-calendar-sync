import test from "node:test";
import assert from "node:assert/strict";
import {inspectOrphanWorkerMappings} from "../dist/orphan-worker-mappings.js";

const uuidA="11111111-1111-4111-8111-111111111111";
const uuidB="22222222-2222-4222-8222-222222222222";
const arnA="arn:aws:sqs:eu-west-2:123456789012:sync-home";
const arnB="arn:aws:sqs:eu-west-2:123456789012:sync-work";
const fnArn="arn:aws:lambda:eu-west-2:123456789012:function:sync-worker";
const first={UUID:uuidA,EventSourceArn:arnA,FunctionArn:fnArn,State:"Enabled"};
const second={UUID:uuidB,EventSourceArn:arnB,FunctionArn:fnArn,State:"Enabled"};
function fixture(overrides={}){
  const calls=[];
  const lambda={send:async command=>{
    const kind=command.constructor.name;
    calls.push({kind,input:command.input});
    if(kind==="GetFunctionConfigurationCommand")return {
      FunctionArn:fnArn,Timeout:135,State:"Active",LastUpdateStatus:"Successful",
      ...overrides.config};
    if(kind==="ListEventSourceMappingsCommand")
      return command.input.Marker?{
        EventSourceMappings:[second],...overrides.secondPage,
      }:{
        EventSourceMappings:[first],NextMarker:"second-page",
        ...overrides.firstPage};
    if(kind==="GetEventSourceMappingCommand"){
      const value=command.input.UUID===uuidA?first:second;
      return {...value,...(overrides.direct||{})};
    }
    throw Error("Unexpected or mutating Lambda API "+kind);
  }};
  return {lambda,calls};
}
test("worker inventory fully paginates, re-reads mapping UUIDs and computes a stable non-identity digest",async()=>{
  const f=fixture();
  const a=await inspectOrphanWorkerMappings({lambda:f.lambda,functionName:"sync-worker"});
  assert.equal(a.verified,true,JSON.stringify(a.blockers));
  assert.equal(a.mappingCount,2);
  assert.equal(a.timeoutSeconds,135);
  assert.match(a.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(f.calls.filter(c=>c.kind==="ListEventSourceMappingsCommand").length,2);
  assert.equal(f.calls.filter(c=>c.kind==="GetEventSourceMappingCommand").length,2);
  assert.equal(f.calls.filter(c=>c.kind==="GetFunctionConfigurationCommand").length,1);
  assert.equal(JSON.stringify(a).includes(uuidA),false);
  assert.equal(JSON.stringify(a).includes(arnA),false);
  const b=await inspectOrphanWorkerMappings({lambda:fixture().lambda,functionName:"sync-worker"});
  assert.equal(a.fingerprint,b.fingerprint);
});
test("empty, malformed, duplicate and unsupported mapping lists fail closed",async()=>{
  for(const overrides of [
    {firstPage:{EventSourceMappings:[],NextMarker:undefined}},
    {firstPage:{EventSourceMappings:[{...first,UUID:"not-a-uuid"}],NextMarker:undefined}},
    {firstPage:{EventSourceMappings:[{...first,EventSourceArn:"arn:aws:kinesis:eu-west-2:123:stream/a"}],NextMarker:undefined}},
    {firstPage:{EventSourceMappings:[first,first],NextMarker:undefined}},
    {firstPage:{EventSourceMappings:[{...first,State:"Disabled"}],NextMarker:undefined}},
    {firstPage:{EventSourceMappings:[{...first,State:"Enabling"}],NextMarker:undefined}},
  ]){
    const f=fixture(overrides);
    const a=await inspectOrphanWorkerMappings({lambda:f.lambda,functionName:"sync-worker"});
    assert.equal(a.verified,false,JSON.stringify(overrides));
    assert.ok(a.blockers.length);
  }
});
test("changed direct readbacks, partial pagination and inactive Lambda are blocked",async()=>{
  for(const overrides of [
    {direct:{State:"Disabling"}},
    {direct:{EventSourceArn:arnB}},
    {direct:{FunctionArn:fnArn+":stale"}},
    {firstPage:{NextMarker:"second-page"},secondPage:{NextMarker:"second-page"}},
    {config:{State:"Inactive"}},
    {config:{LastUpdateStatus:"InProgress"}},
    {config:{Timeout:undefined}},
  ]){
    const f=fixture(overrides);
    const a=await inspectOrphanWorkerMappings({lambda:f.lambda,functionName:"sync-worker"});
    assert.equal(a.verified,false,JSON.stringify(overrides));
  }
});
test("missing target configuration never calls Lambda; API failures cannot become false-positive inventories",async()=>{
  const f=fixture();
  const a=await inspectOrphanWorkerMappings({lambda:f.lambda,functionName:""});
  assert.equal(a.verified,false);
  assert.equal(f.calls.length,0);
  await assert.rejects(()=>inspectOrphanWorkerMappings({
    lambda:{send:async()=>{throw Error("AWS API temporarily unavailable");}},
    functionName:"sync-worker",
  }),/AWS API temporarily unavailable/);
});
