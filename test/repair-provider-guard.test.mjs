import assert from "node:assert/strict";
import test from "node:test";
import { guardRepairProviders } from "../dist/repair-provider-guard.js";

const clone=value=>structuredClone(value);
function fixture(side,{loseResponse=false}={}) {
  const objects=new Map(),requests=[];let created=0,saved,lose=loseResponse;
  const payload=side==="todoist"?{content:"Repair",description:"",due:{date:"2099-12-18"}}
    :{id:"",summary:"Repair",description:"",start:{date:"2099-12-18"},end:{date:"2099-12-20"}};
  const create=async(value,requestId)=>{
    requests.push(requestId);
    const id=side==="todoist"?`task-${requestId}`:value.id;
    if(!objects.has(id)){
      created++;
      objects.set(id,{...clone(value),id,...(side==="calendar"?{status:"confirmed",extendedProperties:{shared:{syncRepairId:"repair"}}}:{updated_at:"2026-10-22T00:00:00Z"})});
    }
    if(lose){lose=false;throw new Error("Creation response lost");}
    return clone(objects.get(id));
  };
  const get=async id=>{if(!objects.has(id))throw Object.assign(new Error("Not found"),{status:404});return clone(objects.get(id));};
  const raw={todoist:{getTask:get,createTaskOnce:create,upsertTask:async()=>assert.fail("Anonymous Todoist create")},
    calendar:{getEvent:get,createRepairEventOnce:async(value)=>create(value,value.id),upsertEvent:async()=>assert.fail("Anonymous Calendar create")}};
  const operation={id:"repair",preview:{intent:{action:"decision"},snapshots:[]}};
  const save=async()=>{saved=clone(operation);};
  const invoke=async()=>{const clients=await guardRepairProviders(operation,async()=>raw,save)("home");return side==="todoist"?clients.todoist.upsertTask(payload):clients.calendar.upsertEvent(payload);};
  return {operation,payload,objects,requests,invoke,get created(){return created;},get saved(){return saved;}};
}

for(const side of ["todoist","calendar"]){
  test(`delegated ${side} creation recovers its recorded result without another create`,async()=>{
    const f=fixture(side);const first=await f.invoke(),second=await f.invoke();
    assert.equal(first.id,second.id);assert.equal(f.created,1);assert.equal(f.requests.length,1);
    assert.equal(Object.values(f.saved.creations)[0].result.id,first.id);
    assert.ok(f.saved.expectedProviders[`home:${side}:${first.id}`]);
  });
  test(`delegated ${side} creation retries a lost response under the same provider identity`,async()=>{
    const f=fixture(side,{loseResponse:true});await assert.rejects(f.invoke(),/response lost/);
    assert.equal(Object.values(f.saved.creations)[0].result,undefined);
    await f.invoke();assert.equal(f.created,1);assert.equal(f.requests.length,2);assert.equal(f.requests[0],f.requests[1]);
  });
  test(`delegated ${side} creation rejects changed inputs and edits to its created item`,async()=>{
    const f=fixture(side),first=await f.invoke();
    const field=side==="todoist"?"content":"summary";
    f.objects.get(first.id)[field]="External edit";
    await assert.rejects(f.invoke(),/previously created counterpart changed/);
    f.payload[field]="Another input";
    await assert.rejects(f.invoke(),/creation input changed/);
    assert.equal(f.created,1);
  });
}

test("uncertain delegated Todoist creation cannot replay after its idempotency window",async()=>{
  const f=fixture("todoist",{loseResponse:true});await assert.rejects(f.invoke(),/response lost/);
  Object.values(f.operation.creations)[0].startedAt=new Date(Date.now()-24*3600000).toISOString();
  await assert.rejects(f.invoke(),/idempotency window expired/);
  assert.equal(f.requests.length,1);assert.equal(f.created,1);
});
