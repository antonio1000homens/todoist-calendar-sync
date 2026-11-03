import test from "node:test";
import assert from "node:assert/strict";
import { ORPHAN_REQUIRED_CHECKS } from "../dist/orphan-deletion-executor.js";
import { inspectConfirmedOrphanOperation } from "../dist/orphan-worker-inspection.js";
import { handler, parseErasureQueueCommand, parseErasureQueueRecord } from "../dist/erasure-worker.js";

function fixture(side="todoist") {
  const now=new Date(),begin=new Date(now.getTime()-30000);
  const op={
    id:"op-287",caseId:"case-287",profile:"home",caseUpdatedAt:"2026-11-03T19:00:00.000Z",
    side,targetId:side==="todoist"?"task-id":"event-id",providerDigest:"a".repeat(64),
    ...(side==="calendar"?{providerEtag:"etag-1"}:{}),
    actorSubject:"operator-287",version:0,phase:"confirmed",
    confirmedAt:begin.toISOString(),
    confirmationExpiresAt:new Date(begin.getTime()+300000).toISOString(),
    createdAt:begin.toISOString(),updatedAt:begin.toISOString(),
  };
  const lock={operationId:op.id,caseId:op.caseId,profile:op.profile,
    side:op.side,targetId:op.targetId,caseUpdatedAt:op.caseUpdatedAt};
  const calls={journal:0,db:0,fence:0,mappings:0,proof:0,writes:0};
  const sources={
    now:()=>now,
    journal:{get:async id=>{calls.journal++;assert.equal(id,op.id);return op;}},
    db:{send:async cmd=>{
      calls.db++;
      assert.equal(cmd.constructor.name,"GetCommand","no mutations are allowed");
      assert.equal(cmd.input.ConsistentRead,true);
      assert.deepEqual(cmd.input.Key,{pk:"ORPHAN_CASE_LOCK#case-287",sk:"STATE"});
      return {Item:lock};
    }},
    inspectFence:async profile=>{
      calls.fence++;
      assert.equal(profile,op.profile);
      return {fence:undefined,leases:[]};
    },
    inspectMappings:async()=>{
      calls.mappings++;
      return {verified:true,mappingCount:1,timeoutSeconds:135,
        fingerprint:"f".repeat(64),blockers:[],checkedAt:now.toISOString()};
    },
    collectProof:async operation=>{
      calls.proof++;
      assert.deepEqual(operation,op);
      return {caseId:op.caseId,profile:op.profile,caseUpdatedAt:op.caseUpdatedAt,
        side:op.side,targetId:op.targetId,checkedAt:now.toISOString(),
        providerDigest:op.providerDigest,providerEtag:op.providerEtag,
        checks:Object.fromEntries(ORPHAN_REQUIRED_CHECKS.map(key=>[key,true])),
        blockers:[]};
    },
  };
  return {op,lock,calls,sources,now};
}
async function enabledTest(fn){
  const old=process.env.ORPHAN_WORKER_INSPECTION_ENABLED;
  process.env.ORPHAN_WORKER_INSPECTION_ENABLED="true";
  try {return await fn();}
  finally {
    if(old===undefined)delete process.env.ORPHAN_WORKER_INSPECTION_ENABLED;
    else process.env.ORPHAN_WORKER_INSPECTION_ENABLED=old;
  }
}
test("confirmed singleton Todoist and Calendar operations are inspected without a provider or DynamoDB write",async()=>{
  await enabledTest(async()=>{
    for(const side of ["todoist","calendar"]){
      const f=fixture(side);
      const x=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
      assert.equal(x.status,"inspection_passed_not_authorized");
      assert.equal(x.deletionAuthorized,false);
      assert.equal(x.executionQueued,false);
      assert.deepEqual(x.blockers,[]);
      assert.deepEqual(f.calls,{journal:1,db:1,fence:1,mappings:1,proof:1,writes:0});
      assert.equal(JSON.stringify(x).includes(f.op.targetId),false);
      assert.equal(JSON.stringify(x).includes(f.op.providerDigest),false);
    }
  });
});
test("expired or post-confirmation operations fail before any provider or lock read",async()=>{
  await enabledTest(async()=>{
    for(const mutate of [
      op=>{op.phase="delete_started";},
      op=>{op.version=1;},
      op=>{op.confirmationExpiresAt=new Date(Date.now()-1000).toISOString();},
      op=>{op.providerDigest="bad-hash";},
      op=>{op.profile="foreign";},
      op=>{op.providerEtag="unexpected";},
    ]){
      const f=fixture();
      mutate(f.op);
      const x=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
      assert.equal(x.status,"blocked");
      assert.equal(f.calls.db,0);
      assert.equal(f.calls.fence,0);
      assert.equal(f.calls.proof,0);
    }
  });
});
test("foreign case locks and active fences fail closed, without provider reads",async()=>{
  await enabledTest(async()=>{
    const f=fixture();
    f.lock.operationId="another-op";
    let x=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
    assert.equal(x.status,"blocked");
    assert.equal(f.calls.proof,0);
    assert.equal(f.calls.fence,0);
    f.lock.operationId=f.op.id;
    f.sources.inspectFence=async()=>({fence:{operationId:"another-op"},leases:[]});
    x=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
    assert.equal(x.status,"blocked");
    assert.equal(f.calls.proof,0);
    f.sources.inspectFence=async()=>({fence:undefined,leases:[{sk:"WRITER#unacknowledged"}]});
    x=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
    assert.equal(x.status,"blocked");
    assert.equal(f.calls.proof,0);
  });
});
test("proof drift blocks inspection and provider failures propagate for SQS retry",async()=>{
  await enabledTest(async()=>{
    const f=fixture();
    const fresh=f.sources.collectProof;
    f.sources.collectProof=async op=>({...await fresh(op),blockers:["live counterpart"]});
    const blocked=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
    assert.equal(blocked.status,"blocked");
    assert.equal(blocked.deletionAuthorized,false);
    f.sources.collectProof=async()=>{throw Object.assign(new Error("provider 429"),{status:429});};
    await assert.rejects(()=>inspectConfirmedOrphanOperation(f.op.id,f.sources),/provider 429/);
    assert.equal(f.calls.writes,0);
  });
});
test("inspection is default-deny and cannot become a deletion queue command",async()=>{
  const old=process.env.ORPHAN_WORKER_INSPECTION_ENABLED;
  delete process.env.ORPHAN_WORKER_INSPECTION_ENABLED;
  try {
    await assert.rejects(()=>inspectConfirmedOrphanOperation("op-287",fixture().sources),/disabled/);
    for(const payload of [
      '{"version":1,"orphanInspectionOperationId":"op-287"}',
      '{"orphanInspectionOperationId":"op-287","version":1}',
    ]){
      assert.deepEqual(parseErasureQueueCommand({body:payload}),
        {kind:"orphan_inspection",id:"op-287"});
      assert.throws(()=>parseErasureQueueRecord({body:payload}),/not an erasure deletion/);
    }
    for(const body of [
      '{"version":1,"orphanInspectionOperationId":"op","targetId":"delete-me"}',
      '{"version":1,"orphanInspectionOperationId":"op","operationId":"op"}',
      '{"version":1,"orphanInspectionOperationId":"bad id"}',
      '{"version":2,"orphanInspectionOperationId":"op"}',
    ])assert.throws(()=>parseErasureQueueCommand({body}),/Invalid/);
    // The actual deployed worker handler cannot process this message with
    // inspection unset; it acknowledges no destructive steps.
    const result=await handler({Records:[{body:'{"version":1,"orphanInspectionOperationId":"op-287"}',
      messageId:"inspection-message",attributes:{},messageAttributes:{}}]});
    assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"inspection-message"}]});
  } finally {
    if(old===undefined)delete process.env.ORPHAN_WORKER_INSPECTION_ENABLED;
    else process.env.ORPHAN_WORKER_INSPECTION_ENABLED=old;
  }
});

test("unsafe or incomplete mapping inventory blocks before any provider enumeration",async()=>{
  await enabledTest(async()=>{
    for(const snapshot of [
      {verified:false,mappingCount:1,timeoutSeconds:135,fingerprint:"f".repeat(64),blockers:["Disabled"]},
      {verified:true,mappingCount:0,timeoutSeconds:135,fingerprint:"f".repeat(64),blockers:[]},
      {verified:true,mappingCount:1,timeoutSeconds:undefined,fingerprint:"f".repeat(64),blockers:[]},
      {verified:true,mappingCount:1,timeoutSeconds:135,fingerprint:"invalid",blockers:[]},
    ]){
      const f=fixture();
      f.sources.inspectMappings=async()=>snapshot;
      const result=await inspectConfirmedOrphanOperation(f.op.id,f.sources);
      assert.equal(result.status,"blocked");
      assert.equal(result.deletionAuthorized,false);
      assert.equal(f.calls.proof,0);
    }
  });
});
test("mapping API outages propagate to retryable inspection failures, not success",async()=>{
  await enabledTest(async()=>{
    const f=fixture();
    f.sources.inspectMappings=async()=>{throw Object.assign(new Error("mapping inventory 429"),{status:429});};
    await assert.rejects(()=>inspectConfirmedOrphanOperation(f.op.id,f.sources),/mapping inventory 429/);
    assert.equal(f.calls.proof,0);
    assert.equal(f.calls.writes,0);
  });
});
