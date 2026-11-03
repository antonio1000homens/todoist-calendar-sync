import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {inspectOrphanPauseRecovery} from "../dist/orphan-pause-recovery-inspection.js";
import {parseErasureQueueCommand,parseErasureQueueRecord,handler} from "../dist/erasure-worker.js";

const worker="target-worker";
const id="orphan-287";
const workerHash=createHash("sha256").update(worker).digest("hex");
const profileList=["antonio","home","work"];
function fixture(){
  const now=new Date();
  const issued=new Date(now.getTime()-30000).toISOString();
  const operation={
    id,caseId:"case-287",profile:"home",side:"todoist",targetId:"task-private-287",
    providerDigest:"a".repeat(64),caseUpdatedAt:"2026-11-03T22:01:00.000Z",
    phase:"confirmed",version:0,actorSubject:"trusted-operator",
    confirmedAt:issued,confirmationExpiresAt:new Date(now.getTime()+270000).toISOString(),
  };
  const manifest={
    operationId:id,caseId:operation.caseId,profile:operation.profile,side:operation.side,
    targetId:operation.targetId,providerDigest:operation.providerDigest,caseUpdatedAt:operation.caseUpdatedAt,
    status:"staged",version:0,mappingFingerprint:"b".repeat(64),
    targetWorkerFunction:worker,epoch:3,timeoutSeconds:135,
    mappingIds:["11111111-1111-4111-8111-111111111111"],
    originallyEnabledIds:["11111111-1111-4111-8111-111111111111"],
  };
  const receipt={operationId:id,caseId:operation.caseId,profile:"home",
    workerNameDigest:workerHash,mappingFingerprint:manifest.mappingFingerprint,
    phase:"claimed_no_mappings_modified",version:0,mappingsDisabled:false,
    fenceInstalled:false,deletionAuthorized:false};
  const owner={operationId:id,caseId:operation.caseId,profile:"home",
    mappingFingerprint:manifest.mappingFingerprint};
  const lock={operationId:id,caseId:operation.caseId,profile:"home",
    side:"todoist",targetId:operation.targetId,caseUpdatedAt:operation.caseUpdatedAt};
  const review={id:operation.caseId,profile:"home",status:"open",
    updatedAt:operation.caseUpdatedAt};
  const table=new Map([
    ["ORPHAN_MAPPING_PAUSE#"+id+"|STATE",receipt],
    ["ORPHAN_WORKER_PAUSE_OWNER#"+workerHash+"|STATE",owner],
    ["ORPHAN_FENCE_MANIFEST#"+id+"|STATE",manifest],
    ["ORPHAN_DELETE#"+id+"|STATE",operation],
    ["ORPHAN_CASE_LOCK#"+operation.caseId+"|STATE",lock],
    ["REVIEW_CASE#"+operation.caseId+"|STATE",review],
    ...profileList.map(p=>["ERASURE#"+p+"|EPOCH",{epoch:p==="home"?3:0}]),
  ]);
  const seen=[],reads=[];
  const db={send:async command=>{
    assert.equal(command.constructor.name,"GetCommand","recovery never mutates DynamoDB");
    assert.equal(command.input.ConsistentRead,true);
    seen.push(command.input.Key.pk+"|"+command.input.Key.sk);
    return {Item:table.get(command.input.Key.pk+"|"+command.input.Key.sk)};
  }};
  const input={
    db,workerName:worker,now:()=>now,
    mappings:async()=>({verified:true,blockers:[],mappingCount:1,
      fingerprint:manifest.mappingFingerprint,timeoutSeconds:135,checkedAt:now.toISOString()}),
    profile:async profile=>{
      reads.push(profile);
      return {fence:undefined,leases:[]};
    },
  };
  return {now,operation,manifest,receipt,owner,lock,review,table,seen,reads,input};
}
async function gate(fn){
  const keys=["ORPHAN_PAUSE_INSPECTION_ENABLED","ORPHAN_WORKER_INSPECTION_ENABLED",
    "ERASURE_PROTOCOL_VERSION","STATE_TABLE_NAME"];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys)process.env[k]=k==="ERASURE_PROTOCOL_VERSION"?"1":
    k==="STATE_TABLE_NAME"?"test-state":"true";
  try{return await fn();}
  finally {for(const [k,v] of Object.entries(old))
    if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
test("default-deny independent gates reject before any database, Lambda or provider read",async()=>{
  await gate(async()=>{
    for(const flag of ["ORPHAN_PAUSE_INSPECTION_ENABLED",
      "ORPHAN_WORKER_INSPECTION_ENABLED","ERASURE_PROTOCOL_VERSION"]){
      const f=fixture();
      process.env[flag]="false";
      await assert.rejects(()=>inspectOrphanPauseRecovery(id,f.input),/disabled/);
      process.env[flag]=flag==="ERASURE_PROTOCOL_VERSION"?"1":"true";
      assert.deepEqual(f.seen,[]);
      assert.deepEqual(f.reads,[]);
    }
  });
});
test("claimed/no-live-drift recovery remains explicitly blocked on #307 and provider replay proof",async()=>{
  await gate(async()=>{
    const f=fixture();
    const x=await inspectOrphanPauseRecovery(id,f.input);
    assert.deepEqual(x,{
      operationId:id,status:"current_reads_consistent_audit_pending",
      claimPresent:true,ownerMatches:true,checkedAt:f.now.toISOString(),
      blockers:["HISTORIC_QUALIFIED_WRITER_AUDIT_OUTSTANDING",
        "PROVIDER_AND_REPLAY_PROOF_NOT_RECHECKED_UNDER_FENCE"],
      mappingChangesAuthorized:false,fenceAuthorized:false,deletionAuthorized:false,
    });
    assert.deepEqual(f.reads,profileList);
    assert.ok(f.seen.includes("ERASURE#home|EPOCH"));
    assert.ok(f.seen.includes("ORPHAN_DELETE#"+id+"|STATE"));
    assert.ok(f.seen.includes("REVIEW_CASE#case-287|STATE"));
    assert.equal(JSON.stringify(x).includes(f.operation.targetId),false);
    assert.equal(JSON.stringify(x).includes(f.operation.providerDigest),false);
  });
});
test("missing/foreign claims never inspect providers or current worker mappings",async()=>{
  await gate(async()=>{
    const f=fixture();f.table.delete("ORPHAN_MAPPING_PAUSE#"+id+"|STATE");
    let mappingReads=0;
    f.input.mappings=async()=>{mappingReads++;throw Error("should not read");};
    const absent=await inspectOrphanPauseRecovery(id,f.input);
    assert.equal(absent.status,"no_claim");
    assert.deepEqual(absent.blockers,["MISSING_CLAIM"]);
    f.table.set("ORPHAN_MAPPING_PAUSE#"+id+"|STATE",f.receipt);
    f.owner.operationId="foreign";
    const foreign=await inspectOrphanPauseRecovery(id,f.input);
    assert.equal(foreign.status,"review_required");
    assert.ok(foreign.blockers.includes("CLAIM_OWNER_OR_MANIFEST_MISMATCH"));
    assert.equal(mappingReads,0);
  });
});
test("expired, stale journal and review/case drift block before any current mapping read",async()=>{
  await gate(async()=>{
    for(const change of [
      f=>{f.operation.confirmationExpiresAt=new Date(f.now.getTime()-1000).toISOString();},
      f=>{f.operation.phase="delete_started";},
      f=>{f.operation.version=1;},
      f=>{f.operation.providerDigest="bad";},
      f=>{f.manifest.status="unknown";},
      f=>{f.manifest.targetId="a different private target";},
      f=>{f.lock.operationId="foreign";},
      f=>{f.review.status="resolved";},
      f=>{f.review.updatedAt="newer version";},
    ]){
      const f=fixture();change(f);
      let mappingReads=0;
      f.input.mappings=async()=>{mappingReads++;throw Error("unexpected mapping read");};
      const x=await inspectOrphanPauseRecovery(id,f.input);
      assert.equal(x.status,"review_required");
      assert.equal(x.deletionAuthorized,false);
      assert.equal(x.fenceAuthorized,false);
      assert.equal(mappingReads,0);
    }
  });
});
test("current Lambda readback, cross-profile fence/lease and epoch drift are hard blockers",async()=>{
  await gate(async()=>{
    for(const mutate of [
      f=>{f.input.mappings=async()=>({verified:false,blockers:["incomplete"],
        fingerprint:f.manifest.mappingFingerprint,mappingCount:1,timeoutSeconds:135});},
      f=>{f.input.mappings=async()=>({verified:true,blockers:[],
        fingerprint:"c".repeat(64),mappingCount:1,timeoutSeconds:135});},
      f=>{f.input.profile=async p=>({fence:p==="work"?{operationId:"other"}:undefined,leases:[]});},
      f=>{f.input.profile=async p=>({fence:undefined,leases:p==="antonio"?[{kind:"writer"}]:[]});},
      f=>{f.table.get("ERASURE#home|EPOCH").epoch=4;},
    ]){
      const f=fixture();mutate(f);
      const x=await inspectOrphanPauseRecovery(id,f.input);
      assert.equal(x.status,"review_required");
      assert.equal(x.mappingChangesAuthorized,false);
      assert.ok(x.blockers.some(b=>[
        "WORKER_MAPPING_INCOMPLETE_OR_CHANGED","PROFILE_FENCE_OR_LEASE_PRESENT",
        "ERASURE_EPOCH_CHANGED"].includes(b)));
    }
  });
});
test("AWS API failure remains retryable rather than reporting a safe state",async()=>{
  await gate(async()=>{
    const f=fixture();
    f.input.db.send=async()=>{throw Error("DynamoDB 429");};
    await assert.rejects(()=>inspectOrphanPauseRecovery(id,f.input),/DynamoDB 429/);
    const g=fixture();g.input.mappings=async()=>{throw Error("Lambda list mappings 503");};
    await assert.rejects(()=>inspectOrphanPauseRecovery(id,g.input),/503/);
  });
});
test("versioned SQS read-only recovery command rejects extra provider inputs and deletion parser",()=>{
  for(const body of [
    '{"version":1,"orphanPauseRecoveryOperationId":"orphan-287"}',
    '{"orphanPauseRecoveryOperationId":"orphan-287","version":1}',
  ]){
    assert.deepEqual(parseErasureQueueCommand({body}),
      {kind:"orphan_pause_recovery",id:"orphan-287"});
    assert.throws(()=>parseErasureQueueRecord({body}),/not an erasure deletion/);
  }
  for(const body of [
    '{"version":1,"orphanPauseRecoveryOperationId":"orphan-287","targetId":"no"}',
    '{"version":1,"orphanPauseRecoveryOperationId":"orphan-287","operationId":"other"}',
    '{"version":2,"orphanPauseRecoveryOperationId":"orphan-287"}',
  ])assert.throws(()=>parseErasureQueueCommand({body}),/Invalid/);
});
test("disabled recovery command becomes a partial batch retry, never a mapping mutation",async()=>{
  const old=process.env.ORPHAN_PAUSE_INSPECTION_ENABLED;
  delete process.env.ORPHAN_PAUSE_INSPECTION_ENABLED;
  try{
    const result=await handler({Records:[{
      body:'{"version":1,"orphanPauseRecoveryOperationId":"orphan-287"}',
      messageId:"recover",attributes:{},messageAttributes:{},
    }]});
    assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"recover"}]});
  }finally{
    if(old===undefined)delete process.env.ORPHAN_PAUSE_INSPECTION_ENABLED;
    else process.env.ORPHAN_PAUSE_INSPECTION_ENABLED=old;
  }
});
