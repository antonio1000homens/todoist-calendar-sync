import test from "node:test";
import assert from "node:assert/strict";
import {erasurePreviewFingerprint} from "../dist/erasure-executor.js";
import {ErasureRecoveryService} from "../dist/erasure-recovery.js";

const enabledId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disabledId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const receiptId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
process.env.STATE_TABLE_NAME="test-state";

function fixture(options={}) {
  const base={profile:"work",target:{taskId:"disposable-1",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},
    providerSnapshotFingerprint:"1".repeat(64),inventory:[],
    actionPlan:{todoistTask:{id:"disposable-1",digest:"2".repeat(64)},comments:[]}};
  const digest=erasurePreviewFingerprint(base);
  const operation={...base,operationId:"op-recovery",previewFingerprint:digest,confirmationFingerprint:digest,
    confirmationId:"erasure-confirm",providerDeletionReady:true,status:"review_required",
    createdAt:"2026-10-26T10:00:00Z",updatedAt:"2026-10-26T10:00:01Z",
    lifecycle:{phase:"wait_worker_timeout",mappingIds:[enabledId,disabledId],
      enabledMappingIds:[enabledId],timeoutSeconds:30,pollMs:5000,nextRunAt:0,
      evidence:{fenceInstalled:{operationId:"op-recovery",phase:"fenceInstalled",receiptId,completedAt:1000}}}};
  const control=[
    {pk:"ERASURE#work",sk:"FENCE",operationId:"op-recovery",state:"active"},
    {pk:"ERASURE#work",sk:"EPOCH",epoch:7},
    {pk:"ERASURE#work",sk:"JOURNAL",operationId:"op-recovery"},
  ];
  const state=new Map([[enabledId,"Disabled"],[disabledId,"Disabled"]]);
  const external={snapshot:{...base,operationId:"op-recovery",previewFingerprint:digest,blockers:[]},
    mappingInventory:[enabledId,disabledId],mappingStates:state,control,providerCalls:0,restored:[],writes:[]};
  Object.assign(operation,options.operation||{});
  Object.assign(external,options.external||{});
  const opKey="ERASURE_OPERATION#op-recovery";
  let confirmation;
  const db={
    async send(command) {
      const kind=command.constructor.name;
      const input=command.input;
      if(kind==="GetCommand") {
        if(input.Key.pk===opKey)return {Item:operation};
        if(input.Key.pk==="ERASURE_RECOVERY_CONFIRMATION#op-recovery")return {Item:confirmation};
        return {Item:undefined};
      }
      if(kind==="QueryCommand") {
        if(options.paginated && !input.ExclusiveStartKey)
          return {Items:external.control.slice(0,2),LastEvaluatedKey:{pk:"ERASURE#work",sk:"EPOCH"}};
        return {Items:options.paginated?external.control.slice(2):external.control};
      }
      if(kind==="PutCommand") {
        external.writes.push(input);
        confirmation={...input.Item};
        return {};
      }
      if(kind==="UpdateCommand") {
        external.writes.push(input);
        assert.equal(operation.recovery.status,input.ExpressionAttributeValues[":expected"]);
        operation.recovery.status=input.ExpressionAttributeValues[":next"];
        if(input.ExpressionAttributeValues[":error"])
          operation.recovery.lastError=input.ExpressionAttributeValues[":error"];
        return {};
      }
      if(kind==="TransactWriteCommand") {
        external.writes.push(input);
        if(input.TransactItems.some(x=>x.Update?.UpdateExpression?.startsWith("SET recovery=:recovery"))) {
          assert.equal(operation.status,"review_required");
          assert.equal(operation.recovery,undefined,"confirmation must not be reused");
          assert.equal(confirmation.status,"issued");
          operation.recovery=input.TransactItems[0].Update.ExpressionAttributeValues[":recovery"];
          confirmation.status="consumed";
          return {};
        }
        if(input.TransactItems.some(x=>x.Update?.UpdateExpression?.includes("completedAt"))) {
          if(options.failRelease)throw Object.assign(new Error("Transaction race"),{name:"TransactionCanceledException"});
          assert.equal(operation.recovery.status,"verifying");
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.sk==="FENCE"));
          assert.ok(input.TransactItems.some(x=>x.ConditionCheck?.Key?.sk==="EPOCH"));
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.sk==="JOURNAL"));
          operation.recovery.status="completed";
          external.control=external.control.filter(x=>!["FENCE","JOURNAL"].includes(x.sk));
          return {};
        }
        throw new Error("Unrecognised recovery transaction");
      }
      throw new Error("Unexpected database command: "+kind);
    },
  };
  const adapters={
    async listWorkerMappings() {
      return external.mappingInventory.map(id=>({id,state:external.mappingStates.get(id)||"Unknown",
        eventSourceArn:"arn:aws:sqs:eu-west-2:111111111111:sync-queue"}));
    },
    async mappingStates(ids) {return ids.map(id=>({id,state:external.mappingStates.get(id)||"Unknown"}));},
    async restoreMappings(ids) {
      external.restored.push(...ids);
      for(const id of ids)external.mappingStates.set(id,options.enabling?"Enabling":"Enabled");
    },
    async readSnapshot(){external.providerCalls++;return external.snapshot;},
  };
  const store={async get(id){return id==="op-recovery"?operation:undefined;}};
  const service=new ErasureRecoveryService(adapters,db,store,()=>"fresh-recovery-token");
  return {service,operation,external,db,get confirmation(){return confirmation;}};
}

test("read-only preview paginates controls and checks original mappings and immutable provider inventory",async()=>{
  const {service,external}=fixture({paginated:true});
  const a=await service.inspect("op-recovery");
  assert.equal(a.preview.allowed,true);
  assert.equal(a.preview.classification,"pre_write");
  assert.equal(a.preview.epoch,7);
  assert.equal(a.preview.leaseCount,0);
  assert.deepEqual(a.preview.mappingStates.map(x=>x.originallyEnabled),[true,false]);
  assert.equal(external.writes.length,0);
});

test("distinct single-use confirmation and CAS restore only the originally enabled mapping",async()=>{
  const {service,operation,external}=fixture();
  const issued=await service.issueConfirmation("op-recovery","operator-1");
  assert.equal(issued.confirmationId,"fresh-recovery-token");
  assert.equal(issued.preview.allowed,true);
  await assert.rejects(service.apply("op-recovery",issued.confirmationId,"other-operator"),/expired, changed, or consumed/);
  await service.apply("op-recovery",issued.confirmationId,"operator-1");
  await assert.rejects(service.apply("op-recovery",issued.confirmationId,"operator-1"),/consumed/);
  assert.equal((await service.process("op-recovery")).status,"restoring");
  const restored=await service.process("op-recovery");
  assert.equal(restored.retry,true);
  assert.deepEqual(external.restored,[enabledId]);
  assert.equal(external.mappingStates.get(disabledId),"Disabled");
  assert.equal((await service.process("op-recovery")).status,"verifying");
  const completed=await service.process("op-recovery");
  assert.deepEqual(completed,{status:"completed",retry:false});
  assert.equal(operation.status,"review_required","original erasure remains immutable review evidence");
  assert.equal(operation.recovery.status,"completed");
  assert.equal(external.control.some(x=>x.sk==="FENCE"),false);
  assert.equal(external.control.find(x=>x.sk==="EPOCH").epoch,7,"monotonic epoch cannot be decremented");
  assert.equal((await service.process("op-recovery")).status,"completed","queue replay is an identity-free no-op");
});

test("missing fence, changed fence owner, leases, missing epoch and changed UUID inventory refuse confirmation without writes",async()=>{
  for(const alter of [
    f=>f.external.control.splice(0,1),
    f=>{f.external.control[0].operationId="different-owner";},
    f=>f.external.control.push({pk:"ERASURE#work",sk:"WRITER#late",owner:"late"}),
    f=>f.external.control.splice(1,1),
    f=>{f.external.mappingInventory=[enabledId];},
    f=>f.external.mappingStates.set(disabledId,"Enabled"),
    f=>{f.operation.lifecycle.evidence.fenceInstalled.operationId="wrong";},
  ]) {
    const f=fixture();alter(f);
    const preview=await f.service.inspect("op-recovery");
    assert.equal(preview.preview.allowed,false,JSON.stringify(preview.preview.blockers));
    assert.ok(preview.preview.blockers.length);
    await assert.rejects(f.service.issueConfirmation("op-recovery","operator"),/blocked/);
    assert.equal(f.external.writes.length,0);
  }
});

test("partial deletion, changed snapshot, and completed provider deletion remain fenced",async()=>{
  for(const mutate of [
    f=>f.external.snapshot.previewFingerprint="f".repeat(64),
    f=>f.external.snapshot.blockers=["linked recurrence"],
    f=>{f.operation.lifecycle.phase="delete";f.operation.lifecycle.deletionProgress={stage:"todoist",commentIndex:0,stateIndex:0,startedAt:5};},
    f=>{f.external.snapshot.actionPlan={comments:[]};f.external.snapshot.inventory=[];},
  ]) {
    const f=fixture();mutate(f);
    const preview=await f.service.inspect("op-recovery");
    assert.equal(preview.preview.allowed,false);
    assert.equal(f.external.writes.length,0);
    assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
  }
});

test("issued token is invalid when epoch or provider inventory changes before action-time CAS",async()=>{
  const f=fixture();
  const confirmed=await f.service.issueConfirmation("op-recovery","operator");
  f.external.control.find(x=>x.sk==="EPOCH").epoch=8;
  await assert.rejects(f.service.apply("op-recovery",confirmed.confirmationId,"operator"),/drifted/);
  assert.equal(f.operation.recovery,undefined);
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
});

test("lease arrival, state drift and conflicting release transaction never remove the profile fence",async()=>{
  for(const alter of [
    f=>f.external.control.push({pk:"ERASURE#work",sk:"ADMISSION#late",owner:"late"}),
    f=>f.external.snapshot.providerSnapshotFingerprint="bad",
    f=>f.external.mappingInventory=[],
  ]) {
    const f=fixture();
    const confirmed=await f.service.issueConfirmation("op-recovery","operator");
    await f.service.apply("op-recovery",confirmed.confirmationId,"operator");
    alter(f);
    const result=await f.service.process("op-recovery");
    assert.equal(result.status,"blocked");
    assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
    assert.equal(f.operation.recovery.status,"blocked");
  }
  const f=fixture({failRelease:true});
  const confirmed=await f.service.issueConfirmation("op-recovery","operator");
  await f.service.apply("op-recovery",confirmed.confirmationId,"operator");
  await f.service.process("op-recovery");
  await f.service.process("op-recovery");
  await f.service.process("op-recovery");
  await assert.rejects(f.service.process("op-recovery"),/Transaction race/);
  assert.equal(f.operation.recovery.status,"verifying");
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
});

test("mapping enablement can remain transitional without prematurely releasing the fence",async()=>{
  const f=fixture({enabling:true});
  const issued=await f.service.issueConfirmation("op-recovery","operator");
  await f.service.apply("op-recovery",issued.confirmationId,"operator");
  await f.service.process("op-recovery");
  await f.service.process("op-recovery");
  assert.deepEqual(await f.service.process("op-recovery"),{status:"restoring",retry:true});
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
  f.external.mappingStates.set(enabledId,"Enabled");
  assert.equal((await f.service.process("op-recovery")).status,"verifying");
  assert.equal((await f.service.process("op-recovery")).status,"completed");
});
