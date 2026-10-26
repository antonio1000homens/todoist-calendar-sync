import test from "node:test";
import assert from "node:assert/strict";
import {parseErasureQueueCommand,parseErasureQueueRecord} from "../dist/erasure-worker.js";
import {canApplyRecovery,recoveryNeedsDispatch} from "../review-ui/erasure-recovery-policy.mjs";

test("recovery command is disjoint from erasure deletion, rejects extra fields and invalid identity",()=>{
  assert.deepEqual(parseErasureQueueCommand({body:JSON.stringify({version:1,recoveryOperationId:"safe-op"})}),
    {kind:"recovery",id:"safe-op"});
  assert.deepEqual(parseErasureQueueCommand({body:JSON.stringify({version:1,operationId:"safe-op"})}),
    {kind:"erasure",id:"safe-op"});
  assert.throws(()=>parseErasureQueueRecord({body:JSON.stringify({version:1,recoveryOperationId:"safe-op"})}),
    /not an erasure deletion/);
  for(const payload of [
    {version:1,recoveryOperationId:"safe-op",operationId:"safe-op"},
    {version:1,recoveryOperationId:""},
    {version:2,recoveryOperationId:"safe-op"},
    {version:1,recoveryOperationId:"safe-op",taskId:"victim"},
  ])assert.throws(()=>parseErasureQueueCommand({body:JSON.stringify(payload)}),/Invalid/);
});
test("recovery UI refuses blocked, stale, changed or untyped actions",()=>{
  const op={operationId:"op",profile:"work"};
  const preview={operationId:"op",profile:"work",classification:"pre_write",allowed:true};
  const confirm={confirmationId:"token",expiresAt:Date.now()+30000};
  const typed={phrase:"RESTORE SYNC",operationId:"op",profile:"work"};
  assert.equal(canApplyRecovery(preview,confirm,typed,op),true);
  assert.equal(canApplyRecovery({...preview,allowed:false},confirm,typed,op),false);
  assert.equal(canApplyRecovery({...preview,classification:"fully_deleted"},confirm,typed,op),false);
  assert.equal(canApplyRecovery({...preview,profile:"home"},confirm,typed,op),false);
  assert.equal(canApplyRecovery(preview,{...confirm,expiresAt:Date.now()-1},typed,op),false);
  assert.equal(canApplyRecovery(preview,confirm,{...typed,phrase:"FORCE RESTORE"},op),false);
  assert.equal(canApplyRecovery(preview,confirm,{...typed,operationId:"other"},op),false);
  assert.equal(canApplyRecovery(preview,confirm,{...typed,profile:"home"},op),false);
  assert.equal(recoveryNeedsDispatch("queued"),true);
  assert.equal(recoveryNeedsDispatch("completed"),false);
  assert.equal(recoveryNeedsDispatch("blocked"),false);
});
