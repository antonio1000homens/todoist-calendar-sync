import test from "node:test";
import assert from "node:assert/strict";
import { advanceErasureOperation, enterFencedErasure, erasurePreviewFingerprint, finishFencedErasure, ErasureOperationStore } from "../dist/erasure-executor.js";

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
