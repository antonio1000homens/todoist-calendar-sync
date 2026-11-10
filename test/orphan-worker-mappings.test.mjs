import test from "node:test";
import assert from "node:assert/strict";
import {inspectOrphanWorkerMappings} from "../dist/orphan-worker-mappings.js";
import {createLambdaMappingMock} from "./helpers/lambda-mapping-mock.mjs";

const uuidA="11111111-1111-4111-8111-111111111111";
const uuidB="22222222-2222-4222-8222-222222222222";
const arnA="arn:aws:sqs:eu-west-2:123456789012:sync-home";
const arnB="arn:aws:sqs:eu-west-2:123456789012:sync-work";
const fnArn="arn:aws:lambda:eu-west-2:123456789012:function:sync-worker";
const first={UUID:uuidA,EventSourceArn:arnA,FunctionArn:fnArn,State:"Enabled"};
const second={UUID:uuidB,EventSourceArn:arnB,FunctionArn:fnArn,State:"Enabled"};
function fixture(overrides={}) {
  return createLambdaMappingMock({
    functionArn:fnArn,
    configuration:overrides.config,
    list:input=>input.Marker
      ?{EventSourceMappings:[second],...overrides.secondPage}
      :{EventSourceMappings:[first],NextMarker:"second-page",...overrides.firstPage},
    readback:input=>({
      ...(input.UUID===uuidA?first:second),...(overrides.direct||{}),
    }),
  });
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
test("invalid mapping inventories, direct readback drift and inactive workers all fail closed",async()=>{
  const scenarios=[
    {name:"empty inventory",overrides:{firstPage:{EventSourceMappings:[],NextMarker:undefined}}},
    {name:"invalid mapping UUID",overrides:{firstPage:{EventSourceMappings:[{...first,UUID:"not-a-uuid"}],NextMarker:undefined}}},
    {name:"non-SQS mapping",overrides:{firstPage:{EventSourceMappings:[{...first,EventSourceArn:"arn:aws:kinesis:eu-west-2:123:stream/a"}],NextMarker:undefined}}},
    {name:"duplicate mapping",overrides:{firstPage:{EventSourceMappings:[first,first],NextMarker:undefined}}},
    {name:"disabled mapping",overrides:{firstPage:{EventSourceMappings:[{...first,State:"Disabled"}],NextMarker:undefined}}},
    {name:"transitional listing",overrides:{firstPage:{EventSourceMappings:[{...first,State:"Enabling"}],NextMarker:undefined}}},
    {name:"transitional readback",overrides:{direct:{State:"Disabling"}}},
    {name:"changed queue",overrides:{direct:{EventSourceArn:arnB}}},
    {name:"changed Lambda identity",overrides:{direct:{FunctionArn:fnArn+":stale"}}},
    {name:"repeated pagination cursor",overrides:{firstPage:{NextMarker:"second-page"},secondPage:{NextMarker:"second-page"}}},
    {name:"inactive worker",overrides:{config:{State:"Inactive"}}},
    {name:"worker update in progress",overrides:{config:{LastUpdateStatus:"InProgress"}}},
    {name:"missing worker timeout",overrides:{config:{Timeout:undefined}}},
  ];
  for(const {name,overrides} of scenarios) {
    const f=fixture(overrides);
    const inventory=await inspectOrphanWorkerMappings({lambda:f.lambda,functionName:"sync-worker"});
    assert.equal(inventory.verified,false,name);
    assert.ok(inventory.blockers.length,name+" should report a blocker");
    assert.ok(f.calls.every(call=>[
      "GetFunctionConfigurationCommand",
      "ListEventSourceMappingsCommand",
      "GetEventSourceMappingCommand",
    ].includes(call.kind)),name+" must stay read-only");
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
