import test from "node:test";
import assert from "node:assert/strict";
import { advanceErasureOperation, enterFencedErasure, erasurePreviewFingerprint,
  finishFencedErasure, ErasureOperationStore } from "../dist/erasure-executor.js";

const operation={operationId:"op",profile:"home",target:{taskId:"task",deleteCalendar:false},previewFingerprint:"digest",
  status:"previewed",createdAt:"2026-10-23T00:00:00Z",updatedAt:"2026-10-23T00:00:00Z"};
const preview={profile:"home",target:{taskId:"task",deleteCalendar:false},
  selectedActions:{deleteTodoist:true,deleteCalendar:false},providerSnapshotFingerprint:"a".repeat(64),
  actionPlan:{todoistTask:{id:"task",digest:"b".repeat(64)},projectCommentIds:["project-comment-1"],comments:[]},
  inventory:[{type:"TASK",key:{pk:"TASK#task",sk:"META"},digest:"row-v1",classification:"selected"}]};
const oldTable=process.env.STATE_TABLE_NAME;
function memoryDb(seed){
  let item=seed;
  const markers=new Set();
  const calls=[];
  return {calls,get item(){return item;},set item(value){item=value;},markers,async send(command){
    calls.push(command);
    if(command.constructor.name.includes("Get")){
      const key=command.input.Key;
      if(key.sk==="EPOCH")return {Item:{epoch:7}};
      if(key.pk.startsWith("ERASURE_REPLAY#"))return {Item:markers.has(`${key.pk}\0${key.sk}`)?{markerVersion:1}:undefined};
      if(key.pk.startsWith("ERASURE_OPERATION#"))return {Item:item};
      return {Item:undefined};
    }
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      if(values[":attempt"]){
        if(item.lifecycle.deletionProgress.attempt)
          throw Object.assign(new Error("conditional check failed"),{name:"ConditionalCheckFailedException"});
        item={...item,lifecycle:{...item.lifecycle,deletionProgress:{...item.lifecycle.deletionProgress,
          attempt:values[":attempt"]}},updatedAt:values[":updatedAt"]};
        return {};
      }
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
  return {...preview,operationId:"op",previewFingerprint:digest,confirmationFingerprint:digest,confirmationId:"11111111-1111-4111-8111-111111111111",
    providerDeletionReady:true,status:"queued",createdAt:"now",updatedAt:"now"};
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
    assert.match(item.error,/break-glass recovery is required/);
    assert.match(item.error,/Preserve any protections that remain/);
    assert.match(item.error,/inspect the actual profile fence and worker mapping state/i);
    assert.match(item.error,/escalate if either is missing, changed, or cannot be verified/i);
    assert.doesNotMatch(item.error,/keep the profile fence and worker mappings in place/i);
    assert.equal(item.lifecycle.lastError,item.error);
    await assert.rejects(store.markReviewRequired("op"),/no longer at the deletion review gate/);
    assert.equal(calls.filter(command=>command.constructor.name.includes("Update")).length,1);
  }finally{if(old===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=old;}
});

test("queued replay-readiness failure records review without creating a lifecycle or fence",async()=>{
  const prior=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  const item={...storedQueuedOperation()},calls=[];
  const db={async send(command){calls.push(command);
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      assert.match(command.input.ConditionExpression,/attribute_not_exists\(lifecycle\)/);
      const values=command.input.ExpressionAttributeValues;
      item.status=values[":reviewRequired"];item.error=values[":error"];
      return {};
    }
    throw new Error("Unexpected database command");
  }};
  try{
    await new ErasureOperationStore(db).markQueuedReplayBlocked("op");
    assert.equal(item.status,"review_required");assert.equal(item.lifecycle,undefined);
    assert.equal(calls.filter(command=>command.constructor.name.includes("Update")).length,1);
  }finally{if(prior===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=prior;}
});

test("revoked readiness stops active lifecycle work and retains its fence for break-glass review",async()=>{
  const item={...storedQueuedOperation(),providerDeletionReady:false,status:"deleting",
    lifecycle:{phase:"delete",mappingIds:["worker"],enabledMappingIds:["worker"],timeoutSeconds:30,
      pollMs:5000,nextRunAt:0,evidence:{fenceInstalled:{operationId:"op",phase:"fenceInstalled",receiptId:"123e4567-e89b-12d3-a456-426614174000",completedAt:1}}}};
  const db={async send(command){
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      assert.equal(values[":observedReady"],false);
      assert.match(command.input.ConditionExpression,/providerDeletionReady=:observedReady/);
      item.status=values[":reviewRequired"];item.lifecycle.lastError=values[":error"];
      return {};
    }
    throw new Error("Unexpected database command");
  }};
  const store=new ErasureOperationStore(db);
  await assert.rejects(store.advanceFencedLifecycle("op"),/executor is disabled/);
  await store.markExecutionDisabledReviewRequired("op");
  assert.equal(item.status,"review_required");
  assert.equal(item.lifecycle.phase,"delete");
  assert.match(item.lifecycle.lastError,/break-glass recovery is required/);
});

test("deployment revocation freezes a provider-ready lifecycle using the real store and CAS",async()=>{
  const previous={enabled:process.env.ERASURE_EXECUTION_ENABLED,version:process.env.ERASURE_PROTOCOL_VERSION,
    table:process.env.STATE_TABLE_NAME};
  process.env.ERASURE_EXECUTION_ENABLED="false";process.env.ERASURE_PROTOCOL_VERSION="1";
  process.env.STATE_TABLE_NAME="test-state";
  const item={...storedQueuedOperation(),providerDeletionReady:true,status:"deleting",
    lifecycle:{phase:"delete",mappingIds:["worker"],enabledMappingIds:["worker"],timeoutSeconds:30,
      pollMs:5000,nextRunAt:0,evidence:{}}};
  const commands=[];
  const db={async send(command){
    commands.push(command);
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      const input=command.input,values=input.ExpressionAttributeValues;
      assert.match(input.ConditionExpression,/providerDeletionReady=:observedReady/);
      assert.equal(values[":observedReady"],true);
      assert.equal(values[":status"],"deleting");
      assert.equal(values[":phase"],"delete");
      assert.equal(values[":fingerprint"],item.previewFingerprint);
      item.status=values[":reviewRequired"];
      item.lifecycle.lastError=values[":error"];
      return {};
    }
    throw new Error("Unexpected database command");
  }};
  try {
    const store=new ErasureOperationStore(db);
    await store.markExecutionDisabledReviewRequired("op");
    assert.equal(item.status,"review_required");
    assert.equal(item.lifecycle.phase,"delete");
    assert.match(item.lifecycle.lastError,/break-glass recovery is required/);
    assert.equal(commands.filter(x=>x.constructor.name.includes("Update")).length,1);
    await assert.rejects(store.markExecutionDisabledReviewRequired("op"),/not an active execution/);
  }finally{
    for(const [key,value] of Object.entries({ERASURE_EXECUTION_ENABLED:previous.enabled,
      ERASURE_PROTOCOL_VERSION:previous.version,STATE_TABLE_NAME:previous.table}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});

test("gate drift during release-fence verification persists review-required without clearing the fence",async()=>{
  const item={...storedQueuedOperation(),providerDeletionReady:true,status:"verifying",
    lifecycle:{phase:"release_fence",mappingIds:["worker"],enabledMappingIds:["worker"],timeoutSeconds:30,
      pollMs:5000,nextRunAt:0,evidence:{mappingsRestored:{operationId:"op",phase:"mappingsRestored",
        receiptId:"123e4567-e89b-12d3-a456-426614174000",completedAt:1}}}};
  const db=memoryDb(item),events=[],fence={operationId:"op"};
  const adapters={
    listWorkerMappings:async()=>[],disableMappings:async()=>{},mappingStates:async ids=>ids.map(id=>({id,state:"Enabled"})),
    inspectFence:async()=>{events.push("inspect");return {fence,leases:[]};},
    beginFence:async()=>{},restoreMappings:async()=>{},finishFence:async()=>{events.push("finishFence");},
    verifyDeletion:async()=>{events.push("verifyDeletion");return {providersAbsent:false,stateAbsent:true};},
    readFreshSnapshot:async()=>({}),readMappingStates:async()=>[],
  };
  const store=new ErasureOperationStore(db,()=>"unused",adapters);
  const result=await store.advanceFencedLifecycle("op");
  assert.equal(result.status,"review_required");
  assert.equal(result.phase,"release_fence");
  assert.equal(db.item.status,"review_required");
  assert.equal(db.item.lifecycle.phase,"release_fence");
  assert.match(db.item.lifecycle.lastError,/break-glass recovery is required/);
  assert.deepEqual(events,["inspect","verifyDeletion"],"gate drift must stop before fence release or cleanup");
  assert.deepEqual(fence,{operationId:"op"});
  assert.equal(db.calls.some(command=>command.constructor.name.includes("TransactWrite")
    ||command.constructor.name.includes("Delete")),false,"operation and fence cleanup must not run");
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
  const prior={barrier:process.env.ERASURE_REPLAY_BARRIER_VERSION,protocol:process.env.ERASURE_PROTOCOL_VERSION,
    keys:process.env.ERASURE_REPLAY_HMAC_KEYS,current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY};
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";process.env.ERASURE_PROTOCOL_VERSION="1";
  process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="current";
  process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({current:Buffer.alloc(32,1).toString("base64")});
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
    readFreshSnapshot:async()=>snapshotOverride??({profile:db.item.profile,target:db.item.target,selectedActions:db.item.selectedActions,
      providerSnapshotFingerprint:db.item.providerSnapshotFingerprint,inventory:db.item.inventory,actionPlan:db.item.actionPlan}),
    verifyDeletion:async()=>deletionReadback,
    executeDeletionStep:async(_operation,progress)=>({complete:true,progress:{...progress,stage:"state",stateIndex:0}}),
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

    snapshotOverride={profile:db.item.profile,target:db.item.target,selectedActions:db.item.selectedActions,actionPlan:db.item.actionPlan,
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
    await store.beginDeletion("op");
    assert.equal(db.item.lifecycle.phase,"delete");
    deletionReadback={providersAbsent:true,stateAbsent:true};
    result=await store.advanceFencedLifecycle("op",attacker);
    assert.equal(result.phase,"verify_deletion");
    await store.advanceFencedLifecycle("op",attacker);
    assert.equal(db.item.lifecycle.phase,"restore_mappings");assert.equal(db.item.status,"verifying");
    assert.equal(db.item.lifecycle.evidence.providerDeletionVerified.operationId,"op");

    result=await store.advanceFencedLifecycle("op",attacker);assert.equal(result.phase,"restore_mappings");
    assert.match(db.item.lifecycle.lastError,/transient restore failure/);
    now=db.item.lifecycle.nextRunAt;assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"confirm_restored");
    assert.equal((await store.advanceFencedLifecycle("op",attacker)).phase,"release_fence");
    db.send=async command=>{
      if(command.constructor.name.includes("Get")){
        const key=command.input.Key;
        if(key.sk==="EPOCH")return {Item:{epoch:7}};
        if(key.pk.startsWith("ERASURE_REPLAY#"))return {Item:db.markers.has(`${key.pk}\0${key.sk}`)?{markerVersion:1}:undefined};
        if(key.pk.startsWith("ERASURE_OPERATION#"))return {Item:db.item};
        return {Item:undefined};
      }
      if(command.constructor.name.includes("TransactWrite")&&failSaveAfterRelease){
        failSaveAfterRelease=false;
        for(const item of command.input.TransactItems)if(item.Put?.Item?.pk.startsWith("ERASURE_REPLAY#"))
          db.markers.add(`${item.Put.Item.pk}\0${item.Put.Item.sk}`);
        db.item=undefined;
        throw new Error("simulated lost acknowledgement after atomic commit");
      }
      if(command.constructor.name.includes("Update")){
        const values=command.input.ExpressionAttributeValues;
        Object.assign(db.item,{status:values[":next"]??db.item.status,lifecycle:values[":lifecycle"]??db.item.lifecycle,updatedAt:values[":updatedAt"]??db.item.updatedAt});return {};
      }
      return {};
    };
    result=await store.advanceFencedLifecycle("op",attacker);
    assert.equal(result.phase,"complete");assert.equal(result.status,"succeeded");
    assert.equal(db.markers.size,0,"the lost transaction acknowledgement is resolved from state readback; no DynamoDB task marker is stored");
    assert.equal(events.filter(event=>event[0]==="finish").length,0,"the fence is removed atomically with operation cleanup");
    assert.ok(!events.some(event=>event[0]==="delete"),"provider deletion is delegated to the bound deletion adapter");
  }finally{Date.now=realNow;if(oldTable===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=oldTable;
    for(const [key,value] of Object.entries({ERASURE_REPLAY_BARRIER_VERSION:prior.barrier,ERASURE_PROTOCOL_VERSION:prior.protocol,
      ERASURE_REPLAY_HMAC_KEYS:prior.keys,ERASURE_REPLAY_HMAC_CURRENT_KEY:prior.current}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;}
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
      selectedActions:operation.selectedActions,providerSnapshotFingerprint:operation.providerSnapshotFingerprint,inventory:operation.inventory};}
    async readMappingStates(ids){return ids.map(id=>({id,state:this.mappingInventory.find(item=>item.id===id)?.state}));}
  }
  const adapters=new StatefulWorkerAdapters();
  const store=new ErasureOperationStore(db,()=>"unused",adapters);
  const old={table:process.env.STATE_TABLE_NAME,barrier:process.env.ERASURE_REPLAY_BARRIER_VERSION,
    protocol:process.env.ERASURE_PROTOCOL_VERSION,keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
    current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY};
  process.env.STATE_TABLE_NAME="test-state";process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  process.env.ERASURE_PROTOCOL_VERSION="1";process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="current";
  process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({current:Buffer.alloc(32,1).toString("base64")});
  try{
    await store.startFencedLifecycle("op",30);
    assert.equal(adapters.listCalls,1,"the original class instance supplies its own state");
    assert.deepEqual(db.item.lifecycle.mappingIds,["worker-uuid"]);
  }finally{
    for(const [key,value] of Object.entries({STATE_TABLE_NAME:old.table,ERASURE_REPLAY_BARRIER_VERSION:old.barrier,
      ERASURE_PROTOCOL_VERSION:old.protocol,ERASURE_REPLAY_HMAC_KEYS:old.keys,ERASURE_REPLAY_HMAC_CURRENT_KEY:old.current}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
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
    const complete={operationId:"op",...preview,...issued,confirmationFingerprint:issued.previewFingerprint,providerDeletionReady:true,status:"previewed",createdAt:"now",updatedAt:"now"};
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
    const complete={...source,...issued,confirmationFingerprint:issued.previewFingerprint,providerDeletionReady:true,status:"previewed",createdAt:"now",updatedAt:"now"};
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

test("Calendar deletion confirmation requires a complete, exact profile/Calendar/event alias manifest",async()=>{
  const before=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  const previewWithAliases={...preview,target:{...preview.target,eventId:"event-123",deleteCalendar:true},
    selectedActions:{deleteTodoist:true,deleteCalendar:true},
    actionPlan:{todoistTask:{id:"task",digest:"b".repeat(64)},
      calendarEvent:{id:"event-123",calendarId:"home@example.test",digest:"c".repeat(64),etag:"etag"},
      knownCalendarAliases:[{profile:"home",calendarId:"home@example.test",eventId:"event-123"}],
      knownCalendarAliasesComplete:true,comments:[]}};
  const db={async send(){throw new Error("invalid manifests must be refused before writing a confirmation");}};
  const store=new ErasureOperationStore(db);
  try {
    for(const patch of [
      {actionPlan:{...previewWithAliases.actionPlan,knownCalendarAliasesComplete:false}},
      {actionPlan:{...previewWithAliases.actionPlan,knownCalendarAliases:[]}},
      {actionPlan:{...previewWithAliases.actionPlan,knownCalendarAliases:[
        {profile:"home",calendarId:"home@example.test",eventId:"other-event"}]}},
      {actionPlan:{...previewWithAliases.actionPlan,knownCalendarAliases:[
        ...previewWithAliases.actionPlan.knownCalendarAliases,
        {profile:"home",calendarId:"home@example.test",eventId:"event-123"}]}},
    ]) await assert.rejects(store.issueConfirmation({operationId:"op-calendar",...previewWithAliases,...patch}),
      /Invalid erasure operation preview/);
    await assert.rejects(store.issueConfirmation({operationId:"op-calendar",...previewWithAliases}),
      /invalid manifests must be refused/);
  } finally {if(before===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=before;}
});

test("confirmation persists the readiness at issuance, not the later deployment state",async t=>{
  const before={table:process.env.STATE_TABLE_NAME,enabled:process.env.ERASURE_EXECUTION_ENABLED,
    protocol:process.env.ERASURE_PROTOCOL_VERSION};
  t.after(()=>{for(const [key,value] of Object.entries({STATE_TABLE_NAME:before.table,
    ERASURE_EXECUTION_ENABLED:before.enabled,ERASURE_PROTOCOL_VERSION:before.protocol})) {
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  process.env.STATE_TABLE_NAME="test-state";
  process.env.ERASURE_PROTOCOL_VERSION="1";
  const writes=[];
  const db={send:async cmd=>{writes.push(cmd.input);return {};}};
  const store=new ErasureOperationStore(db,()=> "one-time-token");
  process.env.ERASURE_EXECUTION_ENABLED="false";
  await store.issueConfirmation({...preview,operationId:"issued-disabled"});
  assert.equal(writes[0].TransactItems[0].Put.Item.executionReadyAtIssue,false);
  process.env.ERASURE_EXECUTION_ENABLED="true";
  await store.issueConfirmation({...preview,operationId:"issued-enabled"});
  assert.equal(writes[1].TransactItems[0].Put.Item.executionReadyAtIssue,true);
});

test("ambiguous provider deletion and verification failures quarantine durably without automatic replay",async()=>{
  const failures=[
    {name:"network timeout",error:new Error("provider timeout after an unknown write")},
    {name:"401",error:Object.assign(new Error("unauthorized"),{status:401})},
    {name:"403",error:Object.assign(new Error("forbidden"),{status:403})},
    {name:"429",error:Object.assign(new Error("rate limited"),{status:429})},
    {name:"5xx",error:Object.assign(new Error("provider unavailable"),{status:503})},
  ];
  for(const phase of ["delete","verify_deletion"]){
    for(const failure of failures){
      const operation={...storedQueuedOperation(),status:"deleting",providerDeletionReady:true,
        lifecycle:{phase,mappingIds:["worker"],enabledMappingIds:["worker"],timeoutSeconds:30,
          pollMs:5000,nextRunAt:0,evidence:{},
          deletionProgress:{stage:"todoist",commentIndex:0,stateIndex:0,startedAt:1}}};
      const db=memoryDb(operation);
      let providerAttempts=0, restored=0, released=0;
      const fail=async()=>{providerAttempts++;throw failure.error;};
      const adapters={
        listWorkerMappings:async()=>[],disableMappings:async()=>{},mappingStates:async()=>[],
        inspectFence:async()=>({fence:{operationId:"op"},leases:[]}),
        beginFence:async()=>{},restoreMappings:async()=>{restored++;},
        finishFence:async()=>{released++;},
        readFreshSnapshot:async()=>({}),readMappingStates:async()=>[],
        executeDeletionStep:fail,verifyDeletion:fail,
      };
      const store=new ErasureOperationStore(db,()=>"unused",adapters);
      const result=await store.advanceFencedLifecycle("op");
      assert.equal(result.status,"review_required",`${phase}: ${failure.name}`);
      assert.equal(result.phase,phase,`${phase}: preserve the failed checkpoint`);
      assert.match(db.item.lifecycle.lastError,/break-glass recovery is required/);
      assert.doesNotMatch(db.item.lifecycle.lastError,/timeout|unauthorized|forbidden|rate limited|unavailable/);
      assert.equal(providerAttempts,1);
      assert.equal(restored,0,"do not restore writers while the provider outcome is uncertain");
      assert.equal(released,0,"do not release the fence while the provider outcome is uncertain");
      assert.equal(db.calls.some(x=>x.constructor.name==="TransactWriteCommand"),false);
      await assert.rejects(store.advanceFencedLifecycle("op"),/not in a resumable fenced lifecycle/);
      assert.equal(providerAttempts,1,"a repeated delivery cannot re-execute an uncertain delete");
    }
  }
});

test("a lost deletion checkpoint acknowledgement leaves a durable claim and never repeats the provider step",async t=>{
  const originalNow=Date.now;
  let now=1_800_000_000_000;
  Date.now=()=>now;
  t.after(()=>{Date.now=originalNow;});
  const operation={...storedQueuedOperation(),status:"deleting",providerDeletionReady:true,
    lifecycle:{phase:"delete",mappingIds:["worker"],enabledMappingIds:["worker"],timeoutSeconds:30,
      pollMs:5000,nextRunAt:0,evidence:{},
      deletionProgress:{stage:"comments",commentIndex:0,stateIndex:0,startedAt:now}}};
  let item=operation,providerAttempts=0,failedCheckpoint=false;
  const db={async send(command){
    if(command.constructor.name.includes("Get"))return {Item:item};
    if(command.constructor.name.includes("Update")){
      const values=command.input.ExpressionAttributeValues;
      if(values[":attempt"]){
        item={...item,lifecycle:{...item.lifecycle,deletionProgress:{...item.lifecycle.deletionProgress,
          attempt:values[":attempt"]}},updatedAt:values[":updatedAt"]};
        return {};
      }
      if(!failedCheckpoint&&values[":lifecycle"]?.phase==="delete"
        &&!values[":lifecycle"]?.deletionProgress?.attempt){
        failedCheckpoint=true;
        throw new Error("simulated lost checkpoint acknowledgement");
      }
      item={...item,status:values[":next"],lifecycle:values[":lifecycle"],updatedAt:values[":updatedAt"]};
      return {};
    }
    throw new Error("Unexpected command");
  }};
  const adapters={listWorkerMappings:async()=>[],disableMappings:async()=>{},mappingStates:async()=>[],
    inspectFence:async()=>({fence:{operationId:"op"},leases:[]}),beginFence:async()=>{},
    restoreMappings:async()=>{},finishFence:async()=>{},verifyDeletion:async()=>({providersAbsent:false,stateAbsent:false}),
    readFreshSnapshot:async()=>({}),readMappingStates:async()=>[],executeDeletionStep:async(_op,progress)=>{
    providerAttempts++;
    const {attempt:_attempt,...nextProgress}=progress;
    return {complete:false,progress:{...nextProgress,stage:"todoist"}};
  }};
  const store=new ErasureOperationStore(db,()=>"unused",adapters);
  await assert.rejects(store.advanceFencedLifecycle("op"),/lost checkpoint acknowledgement/);
  assert.equal(providerAttempts,1);
  assert.ok(item.lifecycle.deletionProgress.attempt,"the write-ahead claim survives the failed checkpoint");

  now+=40_000;
  const retry=await store.advanceFencedLifecycle("op");
  assert.equal(retry.status,"review_required");
  assert.equal(item.status,"review_required");
  assert.equal(item.lifecycle.phase,"delete");
  assert.equal(providerAttempts,1,"the claimed provider step is never repeated after the ACK is lost");
});
