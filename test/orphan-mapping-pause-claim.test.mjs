import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  claimOrphanWorkerPause,readOrphanWorkerPauseClaim,
} from "../dist/orphan-mapping-pause-claim.js";

const worker="sync-worker";
const workerDigest=createHash("sha256").update(worker).digest("hex");
const digest="a".repeat(64);
const mappingFingerprint="b".repeat(64);
const ids=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"];
const profiles=["antonio","home","work"];
function fixture(side="todoist"){
  const now=new Date(),confirmedAt=new Date(now.getTime()-30000).toISOString();
  const operation={
    id:"op-phase15",caseId:"case-287",profile:"home",caseUpdatedAt:"2026-11-03T20:00:00.000Z",
    side,targetId:side==="todoist"?"task-287":"event-287",
    providerDigest:digest,...(side==="calendar"?{providerEtag:"etag-1"}:{}),
    actorSubject:"operator",confirmedAt,
    confirmationExpiresAt:new Date(now.getTime()+270000).toISOString(),
    phase:"confirmed",version:0,createdAt:confirmedAt,updatedAt:confirmedAt,
  };
  const manifest={pk:"ORPHAN_FENCE_MANIFEST#"+operation.id,sk:"STATE",
    operationId:operation.id,caseId:operation.caseId,profile:operation.profile,
    caseUpdatedAt:operation.caseUpdatedAt,side:operation.side,targetId:operation.targetId,
    providerDigest:operation.providerDigest,mappingIds:ids,
    originallyEnabledIds:[...ids],mappingFingerprint,targetWorkerFunction:worker,
    timeoutSeconds:135,epoch:2,status:"staged",version:0,createdAt:now.toISOString()};
  const rows=new Map();
  rows.set(manifest.pk+"|STATE",manifest);
  for(const p of profiles)rows.set("ERASURE#"+p+"|EPOCH",{pk:"ERASURE#"+p,sk:"EPOCH",epoch:p==="home"?2:0});
  const calls=[],checks=[];
  const db={send:async cmd=>{
    calls.push(cmd.constructor.name);
    if(cmd.constructor.name==="GetCommand"){
      assert.equal(cmd.input.ConsistentRead,true);
      return {Item:rows.get(cmd.input.Key.pk+"|"+cmd.input.Key.sk)};
    }
    if(cmd.constructor.name==="TransactWriteCommand"){
      const tx=cmd.input.TransactItems;
      checks.push(tx);
      for(const row of tx){
        if(row.Put){
          const pk=row.Put.Item.pk+"|"+row.Put.Item.sk;
          if(rows.has(pk))throw Object.assign(new Error("Duplicate global pause claim"),{name:"TransactionCanceledException"});
        }
      }
      for(const row of tx)if(row.Put)rows.set(row.Put.Item.pk+"|"+row.Put.Item.sk,row.Put.Item);
      return {};
    }
    throw Error("Unexpected mutation "+cmd.constructor.name);
  }};
  const inspections=[];
  const sources={db,now:()=>now,getOperation:async id=>id===operation.id?operation:undefined,
    inventory:async name=>{
      assert.equal(name,worker);
      return {verified:true,checkedAt:now.toISOString(),mappingCount:2,
        timeoutSeconds:135,fingerprint:mappingFingerprint,blockers:[]};
    },
    inspectProfile:async profile=>{
      inspections.push(profile);
      return {fence:undefined,leases:[]};
    },
  };
  return {operation,manifest,now,rows,db,calls,checks,inspections,sources};
}
async function withGate(fn){
  const env=["ORPHAN_PAUSE_CLAIM_ENABLED","ORPHAN_FENCE_STAGING_ENABLED",
    "ORPHAN_WORKER_INSPECTION_ENABLED","ERASURE_PROTOCOL_VERSION",
    "ERASURE_TARGET_WORKER_FUNCTION_NAME","STATE_TABLE_NAME"];
  const before=Object.fromEntries(env.map(k=>[k,process.env[k]]));
  for(const k of env)process.env[k]=k==="ERASURE_PROTOCOL_VERSION"?"1":
    k==="ERASURE_TARGET_WORKER_FUNCTION_NAME"?worker:
    k==="STATE_TABLE_NAME"?"test-state":"true";
  try{return await fn();}
  finally{for(const [k,value] of Object.entries(before)){
    if(value===undefined)delete process.env[k];else process.env[k]=value;
  }}
}
test("all independent pause-claim staging gates must be enabled before any read or write",async()=>{
  for(const flag of ["ORPHAN_PAUSE_CLAIM_ENABLED","ORPHAN_FENCE_STAGING_ENABLED",
    "ORPHAN_WORKER_INSPECTION_ENABLED","ERASURE_PROTOCOL_VERSION"]){
    await withGate(async()=>{
      const f=fixture();
      process.env[flag]="false";
      await assert.rejects(()=>claimOrphanWorkerPause(f.operation.id,f.sources),/disabled/);
      assert.equal(f.calls.length,0);
      assert.equal(f.inspections.length,0);
    });
  }
});
test("Todoist and Calendar pause claim writes one exclusive global owner and recovery receipt, no mapping mutation",async()=>{
  await withGate(async()=>{
    for(const side of ["todoist","calendar"]){
      const f=fixture(side);
      const result=await claimOrphanWorkerPause(f.operation.id,f.sources);
      assert.deepEqual(result,{operationId:f.operation.id,caseId:f.operation.caseId,
        profile:"home",status:"pause_claimed_no_mappings_modified",
        mappingCount:2,mappingChanges:0,fenceInstalled:false,deletionAuthorized:false});
      assert.deepEqual(f.inspections,profiles);
      assert.deepEqual(f.calls.filter(x=>x==="TransactWriteCommand"),["TransactWriteCommand"]);
      assert.equal(f.calls.some(x=>/Update|Delete/.test(x)),false);
      const tx=f.checks[0];
      assert.equal(tx.length,12);
      const puts=tx.filter(row=>row.Put).map(row=>row.Put);
      assert.deepEqual(puts.map(x=>x.Item.pk),[
        "ORPHAN_MAPPING_PAUSE#"+f.operation.id,
        "ORPHAN_WORKER_PAUSE_OWNER#"+workerDigest,
      ]);
      assert.ok(puts.every(x=>x.ConditionExpression==="attribute_not_exists(pk)"));
      assert.ok(puts.every(x=>!x.Item.targetId&&!x.Item.providerDigest),
        "pause receipt and global lock must not duplicate provider identities");
      assert.deepEqual(puts[0].Item,{
        pk:"ORPHAN_MAPPING_PAUSE#"+f.operation.id,sk:"STATE",
        operationId:f.operation.id,caseId:f.operation.caseId,profile:"home",
        mappingFingerprint,workerNameDigest:workerDigest,
        phase:"claimed_no_mappings_modified",version:0,claimedAt:f.now.toISOString(),
        mappingsDisabled:false,fenceInstalled:false,deletionAuthorized:false,
      });
      const checks=tx.filter(row=>row.ConditionCheck).map(row=>row.ConditionCheck);
      const keys=checks.map(x=>x.Key.pk+"|"+x.Key.sk);
      for(const key of [
        "ORPHAN_DELETE#"+f.operation.id+"|STATE",
        "ORPHAN_FENCE_MANIFEST#"+f.operation.id+"|STATE",
        "ORPHAN_CASE_LOCK#"+f.operation.caseId+"|STATE",
        "REVIEW_CASE#"+f.operation.caseId+"|STATE",
        ...profiles.map(p=>"ERASURE#"+p+"|FENCE"),
        ...profiles.map(p=>"ERASURE#"+p+"|EPOCH"),
      ])assert.ok(keys.includes(key),"missing CAS check for "+key);
      const approved=checks.find(x=>x.Key.pk==="ORPHAN_DELETE#"+f.operation.id);
      assert.ok(approved.ConditionExpression.includes("confirmedAt=:confirmedAt"));
      assert.equal(approved.ExpressionAttributeValues[":confirmedAt"],f.operation.confirmedAt);
      assert.equal(approved.ExpressionAttributeValues[":expiry"],f.operation.confirmationExpiresAt);
      if(side==="calendar")assert.ok(approved.ConditionExpression.includes("providerEtag=:etag"));
      else assert.ok(approved.ConditionExpression.includes("attribute_not_exists(providerEtag)"));
      const read=await readOrphanWorkerPauseClaim(f.operation.id,{db:f.db,workerName:worker});
      assert.deepEqual(read,{operationId:f.operation.id,found:true,owned:true,
        phase:"claimed_no_mappings_modified",mappingsDisabled:false,
        fenceInstalled:false,deletionAuthorized:false});
      // A duplicate message cannot replace the immutable claim or global lock.
      await assert.rejects(()=>claimOrphanWorkerPause(f.operation.id,f.sources),/Duplicate/);
      assert.equal(f.rows.size,6);
    }
  });
});
test("tampering, stale confirmation, missing ownership and bad inventories fail without writes",async()=>{
  await withGate(async()=>{
    const mutations=[
      f=>{f.operation.phase="fenced";},
      f=>{f.operation.version=1;},
      f=>{f.operation.confirmationExpiresAt=new Date(f.now.getTime()-1).toISOString();},
      f=>{f.manifest.caseId="foreign-case";},
      f=>{f.manifest.mappingFingerprint="another-hash";},
      f=>{f.manifest.mappingIds=[ids[0],ids[0]];},
      f=>{f.manifest.originallyEnabledIds=[ids[0]];},
      f=>{f.manifest.epoch=99;},
      f=>{f.manifest.status="pausing";},
      f=>{f.manifest.targetWorkerFunction="different-function";},
      f=>{f.rows.get("ERASURE#home|EPOCH").epoch=8;},
      f=>{f.sources.inventory=async()=>({verified:false,blockers:["missing worker"],
        mappingCount:2,timeoutSeconds:135,fingerprint:mappingFingerprint});},
      f=>{f.sources.inventory=async()=>({verified:true,blockers:[],
        mappingCount:2,timeoutSeconds:135,fingerprint:"c".repeat(64)});},
      f=>{f.sources.inspectProfile=async()=>({fence:{operationId:"foreign"},leases:[]});},
      f=>{f.sources.inspectProfile=async()=>({fence:undefined,leases:[{kind:"writer"}]});},
    ];
    for(const patch of mutations){
      const f=fixture();
      patch(f);
      await assert.rejects(()=>claimOrphanWorkerPause(f.operation.id,f.sources));
      assert.equal(f.checks.length,0,"invalid or incomplete proof may not reach the transaction");
    }
  });
});
test("an AWS transaction timeout/condition failure is surfaced, and no replay of a partial pause is scheduled",async()=>{
  await withGate(async()=>{
    const f=fixture();
    let committed=0;
    f.db.send=async command=>{
      if(command.constructor.name==="TransactWriteCommand"){
        committed++;
        throw Object.assign(new Error("DynamoDB response lost"),{name:"InternalServerError"});
      }
      return {Item:f.rows.get(command.input.Key.pk+"|"+command.input.Key.sk)};
    };
    await assert.rejects(()=>claimOrphanWorkerPause(f.operation.id,f.sources),/response lost/);
    assert.equal(committed,1,"caller is never given an automatic retry/restore instruction");
  });
});
test("operator readback fails closed on missing lock, foreign owner, changed manifest and is allowed when flags are off",async()=>{
  await withGate(async()=>{
    const f=fixture();
    const absent=await readOrphanWorkerPauseClaim(f.operation.id,{db:f.db,workerName:worker});
    assert.deepEqual(absent,{operationId:f.operation.id,found:false,owned:false,
      mappingsDisabled:false,fenceInstalled:false,deletionAuthorized:false});
    await claimOrphanWorkerPause(f.operation.id,f.sources);
    process.env.ORPHAN_PAUSE_CLAIM_ENABLED="false";
    f.rows.get("ORPHAN_WORKER_PAUSE_OWNER#"+workerDigest+"|STATE").operationId="another-operation";
    const foreign=await readOrphanWorkerPauseClaim(f.operation.id,{db:f.db,workerName:worker});
    assert.equal(foreign.found,true);assert.equal(foreign.owned,false);
    f.rows.get("ORPHAN_WORKER_PAUSE_OWNER#"+workerDigest+"|STATE").operationId=f.operation.id;
    f.manifest.mappingFingerprint="changed";
    const stale=await readOrphanWorkerPauseClaim(f.operation.id,{db:f.db,workerName:worker});
    assert.equal(stale.owned,false);
    assert.equal(f.calls.some(x=>/UpdateCommand|DeleteCommand/.test(x)),false);
  });
});
