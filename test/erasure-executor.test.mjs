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

test("store alone creates lifecycle receipts after real adapter actions and gates delete on trusted time",async()=>{
  let now=10_000,leases=[{id:"writer"}],fence,failDisable=true,failRestore=true,failSaveAfterRelease=true;
  const states=new Map([["uuid-enabled","Enabled"],["uuid-disabled","Enabled"]]),events=[];
  const db=memoryDb(storedQueuedOperation());
  const store=new ErasureOperationStore(db,()=>"unused-confirmation",()=>now);
  const adapters={
    disableMappings:async ids=>{events.push(["disable",ids]);if(failDisable){failDisable=false;throw new Error("transient disable failure");}
      for(const id of ids)states.set(id,"Disabled");},
    mappingStates:async ids=>ids.map(id=>({id,state:states.get(id)})),
    inspectFence:async()=>({fence,leases}),
    beginFence:async(profile,id)=>{events.push(["fence",profile,id]);fence={operationId:id};},
    restoreMappings:async ids=>{events.push(["restore",ids]);if(failRestore){failRestore=false;throw new Error("transient restore failure");}
      for(const id of ids)states.set(id,"Enabled");},
    finishFence:async(profile,id)=>{events.push(["finish",profile,id]);fence=undefined;},
  };
  try{
    assert.equal(store.saveLifecycle,undefined,"no public method can write arbitrary phase/evidence");
    await store.startFencedLifecycle("op",30,async()=>[
      {id:"uuid-enabled",state:"Enabled",eventSourceArn:"arn:aws:sqs:eu-west-2:123:worker"},
      {id:"uuid-disabled",state:"Disabled",eventSourceArn:"arn:aws:sqs:eu-west-2:123:worker"},
    ]);
    assert.equal(db.item.status,"fencing");
    assert.deepEqual(db.item.lifecycle.enabledMappingIds,["uuid-enabled"]);
    assert.match(db.calls.at(-1).input.ConditionExpression,/attribute_not_exists\(lifecycle\)/);

    let result=await store.advanceFencedLifecycle("op",adapters,{phase:"ready_for_delete",now:0,evidence:{forged:true}});
    assert.equal(result.phase,"disable_mappings");
    assert.match(db.item.lifecycle.lastError,/transient disable failure/);
    assert.equal(db.item.lifecycle.evidence.mappingsDisabled,undefined);
    now=db.item.lifecycle.nextRunAt;
    assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"confirm_disabled");
    const receipt=db.item.lifecycle.evidence.mappingsDisableRequested;
    assert.equal(receipt.operationId,"op");assert.equal(receipt.phase,"mappingsDisableRequested");

    assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"drain_before_fence");
    result=await store.advanceFencedLifecycle("op",adapters);assert.equal(result.phase,"drain_before_fence");assert.equal(result.waiting,true);
    const pollAt=db.item.lifecycle.nextRunAt;
    const beforeWait=events.length;
    // Extra caller parameters cannot supply a clock or skip the durable deadline.
    assert.equal((await store.advanceFencedLifecycle("op",adapters,0)).waiting,true);assert.equal(events.length,beforeWait);
    now=pollAt;leases=[];assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"install_fence");
    assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"wait_worker_timeout");
    const deadline=db.item.lifecycle.nextRunAt;
    now=deadline-1;assert.equal((await store.advanceFencedLifecycle("op",adapters)).waiting,true);
    now=deadline;assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"drain_after_timeout");
    leases=[{id:"late-writer"}];result=await store.advanceFencedLifecycle("op",adapters);assert.equal(result.phase,"drain_after_timeout");
    now=db.item.lifecycle.nextRunAt;leases=[];result=await store.advanceFencedLifecycle("op",adapters);
    assert.equal(result.phase,"ready_for_delete");assert.equal(db.item.status,"deleting");

    const fresh={profile:db.item.profile,target:db.item.target,selectedActions:db.item.selectedActions,inventory:db.item.inventory};
    await assert.rejects(store.assertReadyForDelete("op",{readFreshSnapshot:async()=>({...fresh,inventory:[{...fresh.inventory[0],digest:"changed"}]})}),/not ready/);
    await store.assertReadyForDelete("op",{readFreshSnapshot:async()=>fresh});
    assert.equal(db.item.lifecycle.evidence.providerDeletionVerified,undefined);
    await assert.rejects(store.transition("op","deleting","verifying"),/Fenced lifecycle status transitions/);
    await assert.rejects(store.markDeletionVerified("op",{verifyDeletion:async()=>({providersAbsent:false,stateAbsent:true})}),/readback is not clear/);
    assert.equal(db.item.lifecycle.phase,"ready_for_delete");
    await store.markDeletionVerified("op",{verifyDeletion:async()=>({providersAbsent:true,stateAbsent:true})});
    assert.equal(db.item.lifecycle.phase,"restore_mappings");assert.equal(db.item.status,"verifying");
    assert.equal(db.item.lifecycle.evidence.providerDeletionVerified.operationId,"op");

    result=await store.advanceFencedLifecycle("op",adapters);assert.equal(result.phase,"restore_mappings");
    assert.match(db.item.lifecycle.lastError,/transient restore failure/);
    now=db.item.lifecycle.nextRunAt;assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"confirm_restored");
    assert.equal((await store.advanceFencedLifecycle("op",adapters)).phase,"release_fence");
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
    await assert.rejects(store.advanceFencedLifecycle("op",adapters),/simulated process crash/);
    assert.equal(db.item.lifecycle.phase,"release_fence","failed persistence leaves durable phase unchanged");
    now=db.item.lifecycle.nextRunAt;result=await store.advanceFencedLifecycle("op",adapters);
    assert.equal(result.phase,"complete");assert.equal(db.item.status,"succeeded");
    assert.equal(events.filter(event=>event[0]==="finish").length,1,"retry accepts an already-released fence");
    assert.ok(!events.some(event=>event[0]==="delete"),"lifecycle does not perform provider deletion");
  }finally{if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;}
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
  const store=new ErasureOperationStore(db,()=>"one-time-token",()=>now);
  try{
    const issued=await store.issueConfirmation({operationId:"op",...preview},5000);
    const complete={operationId:"op",...preview,...issued,confirmationFingerprint:issued.previewFingerprint,status:"previewed",createdAt:"now",updatedAt:"now"};
    assert.equal(confirmations.get("ERASURE_CONFIRMATION#op").createdAt,new Date(now).toISOString());
    now=7000;
    await assert.rejects(store.create(complete,1),/transaction condition failed/);
    assert.equal(operations.size,0,"extra forged timestamp argument has no effect");
  }finally{if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;}
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
  const store=new ErasureOperationStore(db,()=>"one-time-token",()=>now);
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
  }finally{if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;}
});
