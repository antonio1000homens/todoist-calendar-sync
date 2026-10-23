import test from "node:test";
import assert from "node:assert/strict";
import { advanceErasureOperation, enterFencedErasure, finishFencedErasure, ErasureOperationStore } from "../dist/erasure-executor.js";

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

test("durable operation store requires exact fingerprint confirmation and conditional transitions",async()=>{
  const calls=[];const db={send:async command=>{calls.push(command);return command.constructor.name.includes("Get")?{Item:operation}:{};}};
  const store=new ErasureOperationStore(db);const old=process.env.STATE_TABLE_NAME;process.env.STATE_TABLE_NAME="test-state";
  try {
    const complete={...operation,confirmationFingerprint:"digest",selectedActions:{deleteTodoist:true,deleteCalendar:false},inventory:[]};
    await store.create(complete);
    await assert.rejects(store.create({...complete,confirmationFingerprint:"stale"}),/Invalid erasure operation preview/);
    assert.equal((await store.get("op")).status,"previewed");
    await store.transition("op","previewed","queued",{requestId:"request"});
    assert.equal(calls.at(-1).input.ConditionExpression,"#status=:expected AND previewFingerprint=:fingerprint");
  } finally { if(old===undefined)delete process.env.STATE_TABLE_NAME;else process.env.STATE_TABLE_NAME=old; }
});
