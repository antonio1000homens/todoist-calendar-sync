import test from "node:test";
import assert from "node:assert/strict";
import { advanceErasureOperation, advanceFencedLifecycle, assertErasureReadyForDelete, beginFencedRestoreLifecycle,
  enterFencedErasure, erasurePreviewFingerprint, finishFencedErasure, initialFencedLifecycle, ErasureOperationStore } from "../dist/erasure-executor.js";

const operation={operationId:"op",profile:"home",target:{taskId:"task",deleteCalendar:false},previewFingerprint:"digest",
  status:"previewed",createdAt:"2026-10-23T00:00:00Z",updatedAt:"2026-10-23T00:00:00Z"};

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

test("fenced lifecycle advances one durable phase per invocation and honors next-run time",async()=>{
  let now=10_000,leases=[{id:"writer"}],fence,failDisable=true,failRestore=true,failSaveAfterRelease=true;
  const states=new Map([["uuid-enabled","Enabled"],["uuid-disabled","Enabled"]]);
  const events=[];
  const preview={profile:"home",target:{taskId:"task",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[{type:"TASK",key:{pk:"TASK#task",sk:"META"},digest:"row",classification:"selected"}]};
  const digest=erasurePreviewFingerprint(preview);
  const operation={operationId:"op",...preview,previewFingerprint:digest,confirmationFingerprint:digest,confirmationId:"confirm",
    status:"fencing",createdAt:"now",updatedAt:"now",lifecycle:initialFencedLifecycle({
      mappingIds:["uuid-enabled","uuid-disabled"],enabledMappingIds:["uuid-enabled"],timeoutSeconds:30,
    },now)};
  const dep={now:()=>now,
    disableMappings:async ids=>{events.push(["disable",ids]);if(failDisable){failDisable=false;throw new Error("transient disable failure");}
      for(const id of ids)states.set(id,"Disabled");},
    mappingStates:async ids=>ids.map(id=>({id,state:states.get(id)})),
    inspectFence:async()=>({fence,leases}),
    beginFence:async(profile,id)=>{events.push(["fence",profile,id]);fence={operationId:id};},
    restoreMappings:async ids=>{events.push(["restore",ids]);if(failRestore){failRestore=false;throw new Error("transient restore failure");}
      for(const id of ids)states.set(id,"Enabled");},
    finishFence:async(profile,id)=>{events.push(["finish",profile,id]);fence=undefined;},
    save:async(_expectedStatus,expectedPhase,next,nextStatus)=>{
      assert.equal(operation.lifecycle.phase,expectedPhase);
      if(failSaveAfterRelease&&expectedPhase==="release_fence"&&next.phase==="complete"){
        failSaveAfterRelease=false;throw new Error("simulated process crash after fence release");
      }
      operation.lifecycle=next;if(nextStatus)operation.status=nextStatus;
    }};
  const step=()=>advanceFencedLifecycle({operation,dependencies:dep});

  let result=await step();
  assert.equal(result.phase,"disable_mappings");assert.match(operation.lifecycle.lastError,/transient/);
  const retryAt=operation.lifecycle.nextRunAt;now=retryAt;
  assert.equal((await step()).phase,"confirm_disabled");
  assert.equal((await step()).phase,"drain_before_fence");
  result=await step();assert.equal(result.phase,"drain_before_fence");assert.equal(result.waiting,true);
  const pollAt=operation.lifecycle.nextRunAt;
  now=pollAt-1;const beforeWait=events.length;assert.equal((await step()).waiting,true);assert.equal(events.length,beforeWait);
  now=pollAt;leases=[];assert.equal((await step()).phase,"install_fence");
  assert.equal((await step()).phase,"wait_worker_timeout");
  const workerDeadline=operation.lifecycle.nextRunAt;
  now=workerDeadline-1;assert.equal((await step()).waiting,true);
  now=workerDeadline;assert.equal((await step()).phase,"drain_after_timeout");
  leases=[{id:"late-writer"}];result=await step();assert.equal(result.phase,"drain_after_timeout");
  now=operation.lifecycle.nextRunAt;leases=[];result=await step();
  assert.equal(result.phase,"ready_for_delete");assert.equal(operation.status,"deleting");
  const freshSnapshot={profile:operation.profile,target:operation.target,selectedActions:operation.selectedActions,inventory:operation.inventory};
  assert.doesNotThrow(()=>assertErasureReadyForDelete(operation,freshSnapshot));
  assert.throws(()=>assertErasureReadyForDelete(operation,{...freshSnapshot,inventory:[{...freshSnapshot.inventory[0],digest:"changed"}]}),
    /confirmation, inventory, or fenced lifecycle changed/);
  assert.ok(!events.some(event=>event[0]==="delete"),"fencing lifecycle never performs provider deletion");

  operation.status="verifying";
  operation.lifecycle=beginFencedRestoreLifecycle(operation.lifecycle,now);
  result=await step();assert.equal(result.phase,"restore_mappings");assert.match(operation.lifecycle.lastError,/transient restore failure/);
  now=operation.lifecycle.nextRunAt;assert.equal((await step()).phase,"confirm_restored");
  assert.equal((await step()).phase,"release_fence");
  await assert.rejects(step(),/simulated process crash/);
  assert.equal(operation.lifecycle.phase,"release_fence","failed persistence leaves the durable phase unchanged");
  now=operation.lifecycle.nextRunAt;result=await step();
  assert.equal(result.phase,"complete");assert.equal(operation.status,"succeeded");
  assert.equal(events.filter(event=>event[0]==="finish").length,1,"retry after release must accept an already-released fence");
});

test("delete readiness requires the stored preview digest and completed fence",()=>{
  const preview={profile:"home",target:{taskId:"task",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[]};
  const digest=erasurePreviewFingerprint(preview);
  const ready={...preview,operationId:"op",previewFingerprint:digest,confirmationFingerprint:digest,confirmationId:"once",
    status:"deleting",createdAt:"now",updatedAt:"now",lifecycle:initialFencedLifecycle({mappingIds:["uuid"],enabledMappingIds:[],timeoutSeconds:30})};
  ready.lifecycle.phase="ready_for_delete";
  ready.lifecycle.evidence={mappingsDisableRequestedAt:1000,mappingsDisabledAt:1000,preFenceDrainAt:1000,
    fenceInstalledAt:1000,workerTimeoutElapsedAt:33000,postTimeoutDrainAt:33000};
  const fresh={profile:ready.profile,target:ready.target,selectedActions:ready.selectedActions,inventory:ready.inventory};
  assert.doesNotThrow(()=>assertErasureReadyForDelete(ready,fresh));
  assert.throws(()=>assertErasureReadyForDelete({...ready,target:{...ready.target,taskId:"changed"}},fresh),/confirmation, inventory, or fenced lifecycle changed/);
  assert.throws(()=>assertErasureReadyForDelete(ready,{...fresh,inventory:[{type:"changed"}]}),/confirmation, inventory, or fenced lifecycle changed/);
  assert.throws(()=>assertErasureReadyForDelete({...ready,lifecycle:{...ready.lifecycle,phase:"wait_worker_timeout"}},fresh),/confirmation, inventory, or fenced lifecycle changed/);
  assert.throws(()=>assertErasureReadyForDelete({...ready,lifecycle:{...ready.lifecycle,evidence:{}}},fresh),/confirmation, inventory, or fenced lifecycle changed/);
});

test("operation store atomically starts and advances the durable fence phase",async()=>{
  const calls=[];
  const preview={profile:"home",target:{taskId:"task",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[]};
  const digest=erasurePreviewFingerprint(preview);
  let item={...preview,operationId:"op",status:"queued",previewFingerprint:digest,confirmationFingerprint:digest,
    confirmationId:"one-time",createdAt:"now",updatedAt:"now"};
  const db={send:async command=>{
    calls.push(command);
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      item={...item,status:values[":next"]??values[":fencing"],lifecycle:values[":lifecycle"]};return {};
    }
    return {};
  }};
  const store=new ErasureOperationStore(db),old=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  try {
    const lifecycle=initialFencedLifecycle({mappingIds:["uuid"],enabledMappingIds:["uuid"],timeoutSeconds:30},123);
    await store.startFencedLifecycle("op",lifecycle,123);
    assert.equal(item.status,"fencing");assert.equal(item.lifecycle.phase,"disable_mappings");
    assert.match(calls.at(-1).input.ConditionExpression,/attribute_not_exists\(lifecycle\)/);
    const skipped={...lifecycle,phase:"ready_for_delete",nextRunAt:124,evidence:{mappingsDisableRequestedAt:123,
      mappingsDisabledAt:123,preFenceDrainAt:123,fenceInstalledAt:123,workerTimeoutElapsedAt:33123,postTimeoutDrainAt:33123}};
    await assert.rejects(store.saveLifecycle("op","fencing","disable_mappings",skipped,"deleting",33123),/Invalid fenced lifecycle phase/);
    const changedIdentity={...lifecycle,phase:"confirm_disabled",mappingIds:["attacker"],enabledMappingIds:["attacker"],
      nextRunAt:124,evidence:{mappingsDisableRequestedAt:123}};
    await assert.rejects(store.saveLifecycle("op","fencing","disable_mappings",changedIdentity,"fencing",124),/identity and timeout are immutable/);
    const next={...lifecycle,phase:"confirm_disabled",nextRunAt:124};
    next.evidence={mappingsDisableRequestedAt:123};
    await store.saveLifecycle("op","fencing","disable_mappings",next,"fencing",124);
    assert.equal(item.lifecycle.phase,"confirm_disabled");
    assert.match(calls.at(-1).input.ConditionExpression,/lifecycle.#phase=:phase/);
    assert.equal(calls.at(-1).input.ExpressionAttributeValues[":phase"],"disable_mappings");
  } finally {if(old===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=old;}
});

test("durable operation store digests immutable preview content and atomically consumes confirmation once",async()=>{
  const calls=[];const operations=new Map(),confirmations=new Map();
  const db={send:async command=>{
    calls.push(command);
    if(command.constructor.name.includes("TransactWrite")){
      const items=command.input.TransactItems;
      const put=items.find(item=>item.Put?.Item?.pk.startsWith("ERASURE_OPERATION#"))?.Put;
      const issued=items.find(item=>item.Put?.Item?.pk.startsWith("ERASURE_CONFIRMATION#"))?.Put;
      const consume=items.find(item=>item.Update?.Key?.pk.startsWith("ERASURE_CONFIRMATION#"))?.Update;
      if(issued){
        if(confirmations.has(issued.Item.pk))throw new Error("preview already issued");
        confirmations.set(issued.Item.pk,{...issued.Item});return {};
      }
      if(put){
        const confirmation=confirmations.get(consume.Key.pk),values=consume.ExpressionAttributeValues;
        if(operations.has(put.Item.pk)||confirmation?.status!==values[":issued"]
          ||confirmation.confirmationId!==values[":confirmationId"]
          ||confirmation.previewFingerprint!==values[":fingerprint"]||confirmation.expiresAt<=values[":now"])
          throw new Error("transaction condition failed");
        operations.set(put.Item.pk,{...put.Item});
        confirmations.set(consume.Key.pk,{...confirmation,status:values[":consumed"],consumedBy:values[":operationId"]});
        return {};
      }
    }
    if(command.constructor.name.includes("Get"))return {Item:operations.get(command.input.Key.pk)};
    return {};
  }};
  const store=new ErasureOperationStore(db,()=>"one-time-token");const old=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  try {
    const preview={operationId:"op",profile:"home",target:{taskId:"task",deleteCalendar:false},
      selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[{type:"TASK",key:{pk:"TASK#task",sk:"META"},digest:"row-v1",classification:"selected"}]};
    const issued=await store.issueConfirmation(preview,1000,5000);
    const complete={...preview,...issued,confirmationFingerprint:issued.previewFingerprint,status:"previewed",
      createdAt:"2026-10-23T00:00:00Z",updatedAt:"2026-10-23T00:00:00Z"};
    assert.equal(issued.previewFingerprint,erasurePreviewFingerprint(preview));

    await assert.rejects(store.create({...complete,target:{...complete.target,taskId:"other-task"}},1001),/Invalid erasure operation preview/);
    await assert.rejects(store.create({...complete,inventory:[{...complete.inventory[0],digest:"row-v2"}]},1001),/Invalid erasure operation preview/);
    assert.equal(operations.size,0);

    await store.create(complete,1001);
    assert.equal((await store.get("op")).status,"previewed");
    await assert.rejects(store.create({...complete,operationId:"op-replay"},1002),/transaction condition failed/);
    assert.equal(confirmations.get("ERASURE_CONFIRMATION#op").status,"consumed");
    await store.transition("op","previewed","queued",{requestId:"request"});
    assert.equal(calls.at(-1).input.ConditionExpression,"#status=:expected AND previewFingerprint=:fingerprint");
    const transaction=calls.find(command=>command.constructor.name.includes("TransactWrite")
      &&command.input.TransactItems.some(item=>item.Update?.Key?.pk==="ERASURE_CONFIRMATION#op"));
    const consume=transaction.input.TransactItems.find(item=>item.Update)?.Update;
    assert.match(consume.ConditionExpression,/confirmationId=:confirmationId AND previewFingerprint=:fingerprint AND expiresAt>:now/);
  } finally { if(old===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=old; }
});
