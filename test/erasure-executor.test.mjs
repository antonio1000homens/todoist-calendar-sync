import test from "node:test";
import assert from "node:assert/strict";
import { advanceErasureOperation, enterFencedErasure, erasurePreviewFingerprint,
  finishFencedErasure, ErasureOperationStore } from "../dist/erasure-executor.js";

const operation={operationId:"op",profile:"home",target:{taskId:"task",deleteCalendar:false},previewFingerprint:"digest",
  status:"previewed",createdAt:"2026-10-23T00:00:00Z",updatedAt:"2026-10-23T00:00:00Z"};
const preview={profile:"home",target:{taskId:"task",deleteCalendar:false},
  selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[{type:"TASK",key:{pk:"TASK#task",sk:"META"},digest:"row-v1",classification:"selected"}]};
const oldTable=process.env.STATE_TABLE_NAME;
function memoryDb(seed){
  let item=seed;
  const calls=[];
  return {calls,get item(){return item;},async send(command){
    calls.push(command);
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      const nextStatus=values[":next"]??values[":fencing"];
      item={...item,status:nextStatus,lifecycle:values[":lifecycle"]??item.lifecycle,
        updatedAt:values[":updatedAt"]??item.updatedAt};
      return {};
    }
    return {};
  }};
}
function storedQueuedOperation(){
  const digest=erasurePreviewFingerprint(preview);
  return {...preview,operationId:"op",previewFingerprint:digest,confirmationFingerprint:digest,confirmationId:"one-time",
    status:"queued",createdAt:"now",updatedAt:"now"};
}

 test("erasure operation contract permits only the resumable forward lifecycle",()=>{
  assert.equal(advanceErasureOperation(operation,"queued").status,"queued");
  assert.throws(()=>advanceErasureOperation(operation,"deleting"),/Invalid erasure operation transition/);
  const partial=advanceErasureOperation({...operation,status:"queued"},"partial_failure",{error:"lease timeout"});
  assert.equal(advanceErasureOperation(partial,"queued").status,"queued");
  assert.throws(()=>advanceErasureOperation({...operation,status:"succeeded"},"queued"),/Invalid/);
});

test("deletion gate drift is persisted as review-required with a CAS and cannot be restarted",async()=>{
  const old=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  const item={...storedQueuedOperation(),status:"deleting",previewFingerprint:"fingerprint",
    lifecycle:{phase:"ready_for_delete",mappingIds:["worker"],enabledMappingIds:["worker"],timeoutSeconds:30,
      pollMs:5000,nextRunAt:1,evidence:{}}};
  const calls=[];
  const db={async send(command){calls.push(command);
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      const input=command.input,values=input.ExpressionAttributeValues;
      assert.equal(input.ConditionExpression,"#status=:deleting AND lifecycle.#phase=:ready AND previewFingerprint=:fingerprint");
      assert.equal(values[":deleting"],"deleting");assert.equal(values[":ready"],"ready_for_delete");
      assert.equal(values[":fingerprint"],"fingerprint");
      item.status=values[":reviewRequired"];item.error=values[":error"];item.lifecycle.lastError=values[":error"];
      return {};
    }
    throw new Error("Unexpected database command");
  }};
  try{
    const store=new ErasureOperationStore(db);
    await store.markReviewRequired("op");
    assert.equal(item.status,"review_required");
    assert.match(item.error,/fresh preview and confirmation/);
    assert.equal(item.lifecycle.lastError,item.error);
    await assert.rejects(store.markReviewRequired("op"),/no longer at the deletion review gate/);
    assert.equal(calls.filter(command=>command.constructor.name.includes("Update")).length,1);
  }finally{if(old===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=old;}
});

test("fenced executor disables admission, drains, fences, waits out old workers, then drains again",async()=>{
  const events=[];
  await enterFencedErasure({profile:"home",operationId:"op",mappings:["uuid"],timeoutSeconds:30,
    disableMappings:async ids=>events.push(["disable",ids]),waitForLeaseDrain:async()=>events.push(["drain"]),
    beginFence:async(profile,id)=>events.push(["fence",profile,id]),pause:async ms=>events.push(["pause",ms])});
  assert.deepEqual(events,[["disable",["uuid"]],["drain"],["fence","home","op"],["pause",32000],["drain"]]);
});

test("fence and journal are retained until mapping restoration completes",async()=>{
  const events=[];
  await assert.rejects(finishFencedErasure({enabledMappingIds:["uuid"],
    restoreMappings:async()=>{events.push("restore");throw new Error("restore failed")},
    finishFence:async()=>events.push("finish fence")}));
  assert.deepEqual(events,["restore"]);
});

test("worker adapters are bound at construction and request arguments cannot replace lifecycle evidence",async()=>{
  let now=10_000,leases=[{id:"writer"}],fence,failDisable=true,failRestore=true,failSaveAfterRelease=true;
  const states=new Map([["uuid-enabled","Enabled"],["uuid-disabled","Enabled"]]),events=[];
  const db=memoryDb(storedQueuedOperation());
  const realNow=Date.now;Date.now=()=>now;
  let deletionReadback={providersAbsent:false,stateAbsent:true},snapshotOverride;
  const adapters={
    listWorkerMappings:async()=>[
      {id:"uuid-enabled",state:"Enabled",eventSourceArn:"arn:aws:sqs:eu-west-2:123:worker"},
      {id:"uuid-disabled",state:"Disabled",eventSourceArn:"arn:aws:sqs:eu-west-2:123:worker"},
    ],
    disableMappings:async ids=>{events.push(["disable",ids]);if(failDisable){failDisable=false;throw new Error("transient disable failure");}
      for(const id of ids)states.set(id,"Disabled");},
    mappingStates:async ids=>ids.map(id=>({id,state:states.get(id)})),
    inspectFence:async()=>({fence,leases}),
    readMappingStates:async ids=>ids.map(id=>({id,state:states.get(id)})),
    readFreshSnapshot:async()=>snapshotOverride??({profile:db.item.profile,target:db.item.target,selectedActions:db.item.selectedActions,inventory:db.item.inventory}),
    verifyDeletion:async()=>deletionReadback,
    beginFence:async(profile,id)=>{events.push(["fence",profile,id]);fence={operationId:id};},
    restoreMappings:async ids=>{events.push(["restore",ids]);if(failRestore){failRestore=false;throw new Error("transient restore failure");}
      for(const id of ids)states.set(id,"Enabled");},
    finishFence:async(profile,id)=>{events.push(["finish",profile,id]);fence=undefined;},
  };
  const store=new ErasureOperationStore(db,()=>"unused-confirmation",adapters);
  adapters.disableMappings=async()=>events.push("mutated adapter after construction");
  try{
    assert.equal(store.saveLifecycle,undefined,"no public method can write arbitrary phase/evidence");
    const attacker={listWorkerMappings:async()=>[],disableMappings:async()=>events.push("attacker adapter")};
    await store.startFencedLifecycle("op",30,attacker);
    assert.equal(db.item.status,"fencing");
    assert.deepEqual(db.item.lifecycle.enabledMappingIds,["uuid-enabled"]);
    assert.match(db.calls.at(-1).input.ConditionExpression,/attribute_not_exists\(lifecycle\)/);

    let result=await store.advanceFencedLifecycle("op",attacker,{phase:"ready_for_delete",now:0,evidence:{forged:true}});
    assert.equal(result.phase,"disable_mappings");
    assert.match(db.item.lifecycle.lastError,/transient disable failure/);
    assert.equal(db.item.lifecycle.evidence.mappingsDisabled,undefined);
    now=db.item.lifecycle.nextRunAt;
    assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"confirm_disabled");
    const receipt=db.item.lifecycle.evidence.mappingsDisableRequested;
    assert.equal(receipt.operationId,"op");assert.equal(receipt.phase,"mappingsDisableRequested");

    assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"drain_before_fence");
    result=await store.advanceFencedLifecycle("op",attacker);assert.equal(result.phase,"drain_before_fence");assert.equal(result.waiting,true);
    const pollAt=db.item.lifecycle.nextRunAt;
    const beforeWait=events.length;
    // Extra caller parameters cannot supply a clock or skip the durable deadline.
    assert.equal((await store.advanceFencedLifecycle("op",attacker,0)).waiting,true);assert.equal(events.length,beforeWait);
    now=pollAt;leases=[];assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"install_fence");
    assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"wait_worker_timeout");
    const deadline=db.item.lifecycle.nextRunAt;
    now=deadline-1;assert.equal((await store.advanceFencedLifecycle("op",attacker)).waiting,true);
    now=deadline;assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"drain_after_timeout");
    fence=undefined;
    result=await store.advanceFencedLifecycle("op",attacker);
    assert.equal(result.phase,"drain_after_timeout");assert.match(db.item.lifecycle.lastError,/fence is missing/);
    assert.equal(db.item.lifecycle.evidence.postTimeoutDrain,undefined);
    now=db.item.lifecycle.nextRunAt;fence={operationId:"different-operation"};
    result=await store.advanceFencedLifecycle("op",attacker);
    assert.equal(result.phase,"drain_after_timeout");assert.match(db.item.lifecycle.lastError,/different erasure operation/);
    now=db.item.lifecycle.nextRunAt;fence={operationId:"op"};
    leases=[{id:"late-writer"}];result=await store.advanceFencedLifecycle("op",attacker);assert.equal(result.phase,"drain_after_timeout");
    now=db.item.lifecycle.nextRunAt;leases=[];result=await store.advanceFencedLifecycle("op",attacker);
    assert.equal(result.phase,"ready_for_delete");assert.equal(db.item.status,"deleting");

    snapshotOverride={profile:db.item.profile,target:db.item.target,selectedActions:db.item.selectedActions,
      inventory:[{...db.item.inventory[0],digest:"changed"}]};
    await assert.rejects(store.assertReadyForDelete("op",attacker),/not ready/);
    snapshotOverride=undefined;
    states.set("uuid-enabled","Enabled");
    await assert.rejects(store.assertReadyForDelete("op",attacker),/not ready/);
    states.set("uuid-enabled","Disabled");
    fence={operationId:"different-operation"};
    await assert.rejects(store.assertReadyForDelete("op",attacker),/not ready/);
    fence={operationId:"op"};
    leases=[{id:"new-writer"}];
    await assert.rejects(store.assertReadyForDelete("op",attacker),/not ready/);
    leases=[];
    await store.assertReadyForDelete("op",attacker);
    assert.equal(db.item.lifecycle.evidence.providerDeletionVerified,undefined);
    await assert.rejects(store.transition("op","deleting","verifying"),/Fenced lifecycle status transitions/);
    await assert.rejects(store.markDeletionVerified("op",attacker),/readback is not clear/);
    assert.equal(db.item.lifecycle.phase,"ready_for_delete");
    deletionReadback={providersAbsent:true,stateAbsent:true};
    await store.markDeletionVerified("op",attacker);
    assert.equal(db.item.lifecycle.phase,"restore_mappings");assert.equal(db.item.status,"verifying");
    assert.equal(db.item.lifecycle.evidence.providerDeletionVerified.operationId,"op");

    result=await store.advanceFencedLifecycle("op",attacker);assert.equal(result.phase,"restore_mappings");
    assert.match(db.item.lifecycle.lastError,/transient restore failure/);
    now=db.item.lifecycle.nextRunAt;assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"confirm_restored");
    assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"release_fence");
    db.send=async command=>{
      if(command.constructor.name.includes("Get"))return {Item:db.item};
      if(command.constructor.name.includes("Update")&&failSaveAfterRelease&&command.input.ExpressionAttributeValues[":lifecycle"]?.phase==="complete"){
        failSaveAfterRelease=false;throw new Error("simulated process crash after fence release");
      }
      if(command.constructor.name.includes("Update")){
        const values=command.input.ExpressionAttributeValues;
        Object.assign(db.item,{status:values[":next"]??db.item.status,lifecycle:values[":lifecycle"]??db.item.lifecycle,updatedAt:values[":updatedAt"]??db.item.updatedAt});return {};
      }
      return {};
    };
    await assert.rejects(store.advanceFencedLifecycle("op",attacker),/simulated process crash/);
    assert.equal(db.item.lifecycle.phase,"release_fence","failed persistence leaves durable phase unchanged");
    now=db.item.lifecycle.nextRunAt;result=await store.advanceFencedLifecycle("op",attacker);
    assert.equal(result.phase,"complete");assert.equal(db.item.status,"succeeded");
    assert.equal(events.filter(event=>event[0]==="finish").length,1,"retry accepts an already-released fence");
    assert.ok(!events.some(event=>event[0]==="delete"),"lifecycle does not perform provider deletion");
  }finally{Date.now=realNow;if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;}
});

test("trusted class-based worker adapters retain their instance state after binding",async()=>{
  const db=memoryDb(storedQueuedOperation());
  class StatefulWorkerAdapters {
    constructor(){this.listCalls=0;this.mappingInventory=[
      {id:"worker-uuid",state:"Enabled",eventSourceArn:"arn:aws:sqs:eu-west-2:123:worker"},
    ];}
    async listWorkerMappings(){this.listCalls++;return this.mappingInventory;}
    async disableMappings(){}
    async mappingStates(ids){return ids.map(id=>({id,state:this.mappingInventory.find(item=>item.id===id)?.state}));}
    async inspectFence(){return {leases:[]};}
    async beginFence(){}
    async restoreMappings(){}
    async finishFence(){}
    async verifyDeletion(){return {providersAbsent:true,stateAbsent:true};}
    async readFreshSnapshot(operation){return {profile:operation.profile,target:operation.target,
      selectedActions:operation.selectedActions,inventory:operation.inventory};}
    async readMappingStates(ids){return ids.map(id=>({id,state:this.mappingInventory.find(item=>item.id===id)?.state}));}
  }
  const adapters=new StatefulWorkerAdapters();
  const store=new ErasureOperationStore(db,()=>"unused",adapters);
  const old=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  try{
    await store.startFencedLifecycle("op",30);
    assert.equal(adapters.listCalls,1,"the original class instance supplies its own state");
    assert.deepEqual(db.item.lifecycle.mappingIds,["worker-uuid"]);
  }finally{if(old===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=old;}
});

test("trusted clock controls confirmation issue and consume; caller timestamps cannot replay expiration",async()=>{
  let now=1_000;const confirmations=new Map(),operations=new Map(),calls=[];
  const db={async send(command){calls.push(command);
    if(command.constructor.name.includes("TransactWrite")){
      const entries=command.input.TransactItems;
      const put=entries.find(item=>item.Put?.Item?.pk.startsWith("ERASURE_OPERATION#"))?.Put;
      const issued=entries.find(item=>item.Put?.Item?.pk.startsWith("ERASURE_CONFIRMATION#"))?.Put;
      const consume=entries.find(item=>item.Update?.Key?.pk.startsWith("ERASURE_CONFIRMATION#"))?.Update;
      if(issued){confirmations.set(issued.Item.pk,{...issued.Item});return {};}
      const confirmation=confirmations.get(consume.Key.pk),values=consume.ExpressionAttributeValues;
      if(confirmation?.status!==values[":issued"]||confirmation.expiresAt<=values[":now"])throw new Error("transaction condition failed");
      operations.set(put.Item.pk,{...put.Item});confirmations.set(consume.Key.pk,{...confirmation,status:values[":consumed"]});return {};
    }
    if(command.constructor.name.includes("Get"))return {Item:operations.get(command.input.Key.pk)};
    return {};
  }};
  const realNow=Date.now;Date.now=()=>now;
  const store=new ErasureOperationStore(db,()=>"one-time-token");
  try{
    const issued=await store.issueConfirmation({operationId:"op",...preview},5000);
    const complete={operationId:"op",...preview,...issued,confirmationFingerprint:issued.previewFingerprint,status:"previewed",createdAt:"now",updatedAt:"now"};
    assert.equal(confirmations.get("ERASURE_CONFIRMATION#op").createdAt,new Date(now).toISOString());
    now=7000;
    await assert.rejects(store.create(complete,1),/transaction condition failed/);
    assert.equal(operations.size,0,"extra forged timestamp argument has no effect");
  }finally{Date.now=realNow;if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;}
});

test("durable operation store digests immutable preview content and atomically consumes confirmation once",async()=>{
  let now=1000;const calls=[],operations=new Map(),confirmations=new Map();
  const db={async send(command){calls.push(command);
    if(command.constructor.name.includes("TransactWrite")){
      const items=command.input.TransactItems;
      const put=items.find(item=>item.Put?.Item?.pk.startsWith("ERASURE_OPERATION#"))?.Put;
      const issued=items.find(item=>item.Put?.Item?.pk.startsWith("ERASURE_CONFIRMATION#"))?.Put;
      const consume=items.find(item=>item.Update?.Key?.pk.startsWith("ERASURE_CONFIRMATION#"))?.Update;
      if(issued){if(confirmations.has(issued.Item.pk))throw new Error("preview already issued");confirmations.set(issued.Item.pk,{...issued.Item});return {};}
      if(put){const confirmation=confirmations.get(consume.Key.pk),values=consume.ExpressionAttributeValues;
        if(operations.has(put.Item.pk)||confirmation?.status!==values[":issued"]||confirmation.confirmationId!==values[":confirmationId"]
          ||confirmation.previewFingerprint!==values[":fingerprint"]||confirmation.expiresAt<=values[":now"])throw new Error("transaction condition failed");
        operations.set(put.Item.pk,{...put.Item});confirmations.set(consume.Key.pk,{...confirmation,status:values[":consumed"],consumedBy:values[":operationId"]});return {};}
    }
    if(command.constructor.name.includes("Get"))return {Item:operations.get(command.input.Key.pk)};
    return {};
  }};
  const realNow=Date.now;Date.now=()=>now;
  const store=new ErasureOperationStore(db,()=>"one-time-token");
  try{
    const source={operationId:"op",...preview};const issued=await store.issueConfirmation(source);
    const complete={...source,...issued,confirmationFingerprint:issued.previewFingerprint,status:"previewed",createdAt:"now",updatedAt:"now"};
    assert.equal(issued.previewFingerprint,erasurePreviewFingerprint(source));
    await assert.rejects(store.create({...complete,target:{...complete.target,taskId:"other-task"}}),/Invalid erasure operation preview/);
    await assert.rejects(store.create({...complete,inventory:[{...complete.inventory[0],digest:"row-v2"}]}),/Invalid erasure operation preview/);
    assert.equal(operations.size,0);
    await store.create(complete);assert.equal((await store.get("op")).status,"previewed");
    await assert.rejects(store.create({...complete,operationId:"op-replay"}),/transaction condition failed/);
    assert.equal(confirmations.get("ERASURE_CONFIRMATION#op").status,"consumed");
    await store.transition("op","previewed","queued",{requestId:"request"});
    assert.equal(calls.at(-1).input.ConditionExpression,"#status=:expected AND previewFingerprint=:fingerprint");
  }finally{Date.now=realNow;if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;}
});
