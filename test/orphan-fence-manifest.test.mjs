import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {buildOrphanFenceManifest,stageOrphanFenceManifest} from "../dist/orphan-fence-manifest.js";

const id1="11111111-1111-4111-8111-111111111111";
const id2="22222222-2222-4222-8222-222222222222";
const worker="todoist-calendar-sync-worker";
const fnArn="arn:aws:lambda:eu-west-2:123456789012:function:"+worker;
const rows=[
  {id:id2,eventSourceArn:"arn:aws:sqs:eu-west-2:123456789012:sync-work",state:"Enabled",functionArn:fnArn},
  {id:id1,eventSourceArn:"arn:aws:sqs:eu-west-2:123456789012:sync-home",state:"Enabled",functionArn:fnArn},
];
const fingerprint=mappings=>createHash("sha256").update(JSON.stringify([
  worker,135,mappings.map(x=>[x.id,x.eventSourceArn,x.state,x.functionArn]).sort((a,b)=>a[0].localeCompare(b[0])),
])).digest("hex");
function fixture(side="todoist"){
  const now=new Date();
  const confirmedAt=new Date(now.getTime()-30000).toISOString();
  const op={
    id:"orphan-op-287",caseId:"case-287",profile:"home",caseUpdatedAt:"2026-11-03T20:31:00.000Z",
    side,targetId:side==="todoist"?"task-287":"calendar-287",
    providerDigest:"a".repeat(64),...(side==="calendar"?{providerEtag:"etag-1"}:{}),
    actorSubject:"operator-subject",confirmedAt,
    confirmationExpiresAt:new Date(now.getTime()+270000).toISOString(),
    phase:"confirmed",version:0,createdAt:confirmedAt,updatedAt:confirmedAt,
  };
  return {operation:op,now,expectedErasureEpoch:3,mappings:rows,
    targetWorkerFunction:worker,
    mappingInventory:{verified:true,blockers:[],checkedAt:now.toISOString(),
      mappingCount:rows.length,timeoutSeconds:135,fingerprint:fingerprint(rows)}};
}
function gating(){
  const env=[
    "ORPHAN_FENCE_STAGING_ENABLED","ORPHAN_WORKER_INSPECTION_ENABLED",
    "ERASURE_PROTOCOL_VERSION","STATE_TABLE_NAME",
  ];
  const saved=Object.fromEntries(env.map(name=>[name,process.env[name]]));
  for(const name of env)process.env[name]=name==="STATE_TABLE_NAME"?"test-state":"true";
  process.env.ERASURE_PROTOCOL_VERSION="1";
  return ()=>{for(const [name,value] of Object.entries(saved)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }};
}
test("Todoist/Calendar manifest is exact, immutable, sorted, and preserves original enabled mapping IDs",()=>{
  for(const side of ["todoist","calendar"]){
    const req=fixture(side);
    const v=buildOrphanFenceManifest(req);
    assert.deepEqual(v.mappingIds,[id1,id2]);
    assert.deepEqual(v.originallyEnabledIds,[id1,id2]);
    assert.equal(v.operationId,req.operation.id);
    assert.equal(v.caseId,req.operation.caseId);
    assert.equal(v.side,side);
    assert.equal(v.targetId,req.operation.targetId);
    assert.equal(v.status,"staged");
    assert.equal(v.version,0);
    assert.equal(v.timeoutSeconds,135);
    assert.equal(v.epoch,3);
    assert.equal(v.mappingFingerprint,req.mappingInventory.fingerprint);
    assert.deepEqual([v.pk,v.sk],["ORPHAN_FENCE_MANIFEST#"+req.operation.id,"STATE"]);
  }
});
test("no feature flag can bypass the default-disabled state-write boundary",async()=>{
  const names=["ORPHAN_FENCE_STAGING_ENABLED","ORPHAN_WORKER_INSPECTION_ENABLED","ERASURE_PROTOCOL_VERSION"];
  const saved=Object.fromEntries(names.map(x=>[x,process.env[x]]));
  for(const name of names){
    for(const x of names)process.env[x]=x==="ERASURE_PROTOCOL_VERSION"?"1":"true";
    process.env[name]="false";
    let calls=0;
    await assert.rejects(stageOrphanFenceManifest(fixture(),{
      send:async()=>{calls++;return {};}
    }),/disabled/);
    assert.equal(calls,0);
  }
  for(const [name,value] of Object.entries(saved)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
test("staging makes one atomic conditional PUT with exact journal/case/fence/epoch checks",async()=>{
  const restore=gating();
  try{
    const req=fixture("calendar"),commands=[];
    const result=await stageOrphanFenceManifest(req,{
      send:async cmd=>{commands.push(cmd);return {};}
    });
    assert.equal(commands.length,1);
    assert.equal(commands[0].constructor.name,"TransactWriteCommand");
    const tx=commands[0].input.TransactItems;
    assert.equal(tx.length,6);
    const put=tx.find(x=>x.Put);
    assert.equal(put.Put.Item.pk,result.pk);
    assert.equal(put.Put.ConditionExpression,"attribute_not_exists(pk)");
    assert.equal(tx.filter(x=>x.Update||x.Delete).length,0,"staging must never modify existing rows");
    const checks=Object.fromEntries(tx.filter(x=>x.ConditionCheck)
      .map(x=>[x.ConditionCheck.Key.pk+"|"+x.ConditionCheck.Key.sk,x.ConditionCheck]));
    const op=checks["ORPHAN_DELETE#"+req.operation.id+"|STATE"];
    assert.ok(op.ConditionExpression.includes("#phase=:confirmed AND #version=:zero"));
    assert.ok(op.ConditionExpression.includes("providerEtag=:etag"));
    assert.equal(op.ExpressionAttributeValues[":target"],req.operation.targetId);
    assert.equal(op.ExpressionAttributeValues[":actor"],req.operation.actorSubject);
    assert.equal(op.ExpressionAttributeValues[":expiry"],req.operation.confirmationExpiresAt);
    const lock=checks["ORPHAN_CASE_LOCK#"+req.operation.caseId+"|STATE"];
    assert.ok(lock.ConditionExpression.includes("targetId=:target"));
    const review=checks["REVIEW_CASE#"+req.operation.caseId+"|STATE"];
    assert.ok(review.ConditionExpression.includes("attribute_not_exists(operationId)"));
    assert.equal(checks["ERASURE#home|FENCE"].ConditionExpression,"attribute_not_exists(pk)");
    assert.ok(checks["ERASURE#home|EPOCH"].ConditionExpression.includes("#epoch=:epoch"));
    for(const entry of tx){
      const action=entry.Put||entry.ConditionCheck||entry.Update||entry.Delete;
      const exprs=[action.ConditionExpression,action.UpdateExpression].filter(Boolean).join(" ");
      assert.deepEqual(Object.keys(action.ExpressionAttributeValues||{}).sort(),
        [...new Set(exprs.match(/:[A-Za-z][A-Za-z0-9_]*/g)||[])].sort(),
        "every action must use only its own expression values");
    }
  }finally{restore();}
});
test("unsafe mapping/confirmation drift fails before any database write",async()=>{
  const restore=gating();
  try{
    const input=fixture();
    const changed=[
      req=>{req.operation.phase="fenced";},
      req=>{req.operation.version=1;},
      req=>{req.operation.confirmationExpiresAt=new Date(Date.now()-1000).toISOString();},
      req=>{req.operation.providerEtag="foreign-etag";},
      req=>{req.mappingInventory.fingerprint="f".repeat(64);},
      req=>{req.mappingInventory.verified=false;},
      req=>{req.mappingInventory.checkedAt=new Date(Date.now()-150000).toISOString();},
      req=>{req.mappingInventory.mappingCount=1;},
      req=>{req.mappings=[rows[0],rows[0]];},
      req=>{req.mappings=[{...rows[0],state:"Disabled"},rows[1]];},
      req=>{req.mappings=[{...rows[0],eventSourceArn:"arn:aws:kinesis:eu-west-2:123:stream/x"},rows[1]];},
      req=>{req.targetWorkerFunction="another-worker";},
      req=>{req.expectedErasureEpoch=-1;},
      req=>{req.operation.profile="unexpected";},
    ];
    for(const patch of changed){
      const req={...input,operation:{...input.operation},mappingInventory:{...input.mappingInventory},mappings:[...input.mappings]};
      patch(req);
      let calls=0;
      await assert.rejects(stageOrphanFenceManifest(req,{
        send:async()=>{calls++;return {};}
      }));
      assert.equal(calls,0);
    }
  }finally{restore();}
});
test("a timeout or conditional failure is surfaced; caller never blindly retries a side-effect",async()=>{
  const restore=gating();
  try{
    let requests=0;
    await assert.rejects(stageOrphanFenceManifest(fixture(),{
      send:async()=>{requests++;const e=new Error("condition failed");e.name="TransactionCanceledException";throw e;}
    }),/condition failed/);
    assert.equal(requests,1);
  }finally{restore();}
});
