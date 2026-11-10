import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  orphanManifestStageEnabled, processOrphanManifestStage, readOrphanManifestWorkerMappings,
} from "../dist/orphan-manifest-stage-worker.js";
import {parseErasureQueueCommand,parseErasureQueueRecord,handler} from "../dist/erasure-worker.js";
import {createLambdaMappingMock} from "./helpers/lambda-mapping-mock.mjs";

const fn="target-worker";
const id="11111111-1111-4111-8111-111111111111";
const arn="arn:aws:sqs:eu-west-2:123456789012:sync-main";
const fa="arn:aws:lambda:eu-west-2:123456789012:function:target-worker";
const rows=[{id,eventSourceArn:arn,functionArn:fa,state:"Enabled"}];
const fp=createHash("sha256").update(JSON.stringify([fn,135,
  [[id,arn,"Enabled",fa]]])).digest("hex");
function op(now=new Date()){
  const t=new Date(now.getTime()-30000).toISOString();
  return {id:"orphan-287",caseId:"case-287",profile:"home",side:"todoist",
    targetId:"task-287",providerDigest:"a".repeat(64),actorSubject:"operator-287",
    caseUpdatedAt:"2026-11-03T21:01:00Z",confirmedAt:t,
    confirmationExpiresAt:new Date(now.getTime()+270000).toISOString(),
    phase:"confirmed",version:0,createdAt:t,updatedAt:t};
}
function fixture(){
  const now=new Date(),operation=op(now);
  const calls={inventory:0,inspect:0,mappings:0,load:0,epoch:0,stage:0};
  const src={
    now:()=>now,functionName:fn,lambda:{send:async()=>{throw new Error("Unexpected Lambda call");}},
    inventory:async()=>{calls.inventory++;return {verified:true,blockers:[],
      checkedAt:now.toISOString(),fingerprint:fp,mappingCount:1,timeoutSeconds:135};},
    inspect:async(id,invent)=>{
      calls.inspect++;assert.equal(id,operation.id);assert.equal(invent.fingerprint,fp);
      return {operationId:id,caseId:operation.caseId,profile:operation.profile,
        status:"inspection_passed_not_authorized",checkedAt:now.toISOString(),
        blockers:[],deletionAuthorized:false,executionQueued:false};
    },
    readMappings:async()=>{calls.mappings++;return rows;},
    getOperation:async id=>{calls.load++;assert.equal(id,operation.id);return operation;},
    epoch:async profile=>{calls.epoch++;assert.equal(profile,operation.profile);return 3;},
    stage:async req=>{
      calls.stage++;
      assert.equal(req.operation,operation);
      assert.equal(req.mappingInventory.fingerprint,fp);
      assert.deepEqual(req.mappings,rows);
      assert.equal(req.expectedErasureEpoch,3);
      assert.equal(req.targetWorkerFunction,fn);
      return {operationId:operation.id,caseId:operation.caseId,profile:operation.profile,
        side:operation.side,status:"staged",version:0,mappingIds:[id],
        originallyEnabledIds:[id],targetId:operation.targetId,
        mappingFingerprint:fp,timeoutSeconds:135,epoch:3};
    },
  };
  return {operation,src,calls};
}
async function withGate(callback){
  const keys=["ORPHAN_FENCE_STAGING_ENABLED","ORPHAN_WORKER_INSPECTION_ENABLED","ERASURE_PROTOCOL_VERSION"];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys)process.env[k]=k==="ERASURE_PROTOCOL_VERSION"?"1":"true";
  try {return await callback();}
  finally{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];}
}
test("manifest staging requires all three exact deployment flags before any AWS/provider read",async()=>{
  const f=fixture();
  for(const which of ["ORPHAN_FENCE_STAGING_ENABLED","ORPHAN_WORKER_INSPECTION_ENABLED","ERASURE_PROTOCOL_VERSION"]){
    await withGate(async()=>{
      process.env[which]="false";
      assert.equal(orphanManifestStageEnabled(),false);
      await assert.rejects(()=>processOrphanManifestStage(f.operation.id,f.src),/disabled/);
    });
  }
  assert.deepEqual(f.calls,{inventory:0,inspect:0,mappings:0,load:0,epoch:0,stage:0});
});
test("staging one durable operation returns no deletion authority or provider IDs",async()=>{
  await withGate(async()=>{
    const f=fixture();
    const result=await processOrphanManifestStage(f.operation.id,f.src);
    assert.deepEqual(result,{operationId:f.operation.id,caseId:f.operation.caseId,
      profile:"home",status:"manifest_staged_no_execution",mappingCount:1,
      deletionAuthorized:false,executionQueued:false});
    assert.deepEqual(f.calls,{inventory:1,inspect:1,mappings:1,load:1,epoch:1,stage:1});
    assert.equal(JSON.stringify(result).includes(f.operation.targetId),false);
    assert.equal(JSON.stringify(result).includes(id),false);
  });
});
test("blocked inspection, invalid evidence or a changed operation cannot stage",async()=>{
  await withGate(async()=>{
    for(const mutate of [
      f=>{f.src.inventory=async()=>({...f.src.inventoryValue,
        verified:false,blockers:["incomplete mapping"],fingerprint:fp});},
      f=>{f.src.inspect=async()=>({operationId:f.operation.id,caseId:f.operation.caseId,
        profile:"home",status:"blocked",blockers:["live counterpart"],deletionAuthorized:false,executionQueued:false});},
      f=>{f.src.inspect=async()=>({operationId:f.operation.id,caseId:f.operation.caseId,
        profile:"home",status:"inspection_passed_not_authorized",blockers:[],deletionAuthorized:true,executionQueued:false});},
      f=>{f.src.getOperation=async()=>({...f.operation,caseId:"other-case"});},
      f=>{f.src.stage=async()=>{throw new Error("DynamoDB conditional transaction failed");};},
    ]){
      const f=fixture();mutate(f);
      await assert.rejects(()=>processOrphanManifestStage(f.operation.id,f.src));
      assert.equal(f.calls.stage,0,"a blocked operation must never call the successful staging adapter");
    }
  });
});
test("malformed SQS staging messages cannot be interpreted as deletion commands",()=>{
  for(const body of [
    '{"version":1,"orphanManifestStageOperationId":"orphan-287"}',
    '{"orphanManifestStageOperationId":"orphan-287","version":1}',
  ]){
    assert.deepEqual(parseErasureQueueCommand({body}),{kind:"orphan_manifest_stage",id:"orphan-287"});
    assert.throws(()=>parseErasureQueueRecord({body}),/not an erasure deletion/);
  }
  for(const body of [
    '{"version":1,"orphanManifestStageOperationId":"orphan-287","side":"todoist"}',
    '{"version":1,"orphanManifestStageOperationId":"orphan-287","operationId":"orphan-287"}',
    '{"version":1,"orphanManifestStageOperationId":"bad op"}',
    '{"version":2,"orphanManifestStageOperationId":"orphan-287"}',
  ])assert.throws(()=>parseErasureQueueCommand({body}),/Invalid/);
});
test("default-disabled SQS staging command becomes a retryable failure, never a provider mutation",async()=>{
  const old=process.env.ORPHAN_FENCE_STAGING_ENABLED;
  delete process.env.ORPHAN_FENCE_STAGING_ENABLED;
  try{
    const result=await handler({Records:[{
      body:'{"version":1,"orphanManifestStageOperationId":"orphan-287"}',
      messageId:"stage-msg",attributes:{},messageAttributes:{},
    }]});
    assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:"stage-msg"}]});
  }finally{old===undefined?delete process.env.ORPHAN_FENCE_STAGING_ENABLED:
    process.env.ORPHAN_FENCE_STAGING_ENABLED=old;}
});
function lambdaFixture(custom={}) {
  return createLambdaMappingMock({
    functionArn:fa,
    recordConfiguration:false,
    list:()=>({
      EventSourceMappings:[{UUID:id,EventSourceArn:arn,FunctionArn:fa,State:"Enabled"}],
      ...custom.list,
    }),
    readback:()=>({
      UUID:id,EventSourceArn:arn,FunctionArn:fa,State:"Enabled",...custom.get,
    }),
  });
}
test("raw mapping capture contains only complete verified exact Enabled SQS rows",async()=>{
  const f=lambdaFixture();
  const result=await readOrphanManifestWorkerMappings(f.lambda,fn);
  assert.deepEqual(result,rows);
  assert.deepEqual(f.calls.map(call=>call.kind),["ListEventSourceMappingsCommand","GetEventSourceMappingCommand"]);
});
test("mapping capture fails closed on unverified, missing, changed or duplicate mapping states",async()=>{
  for(const config of [
    {list:{EventSourceMappings:[]}},
    {list:{EventSourceMappings:[{UUID:id,EventSourceArn:arn,FunctionArn:fa,State:"Disabled"}]}},
    {list:{EventSourceMappings:[
      {UUID:id,EventSourceArn:arn,FunctionArn:fa,State:"Enabled"},
      {UUID:id,EventSourceArn:arn,FunctionArn:fa,State:"Enabled"},
    ]}},
    {list:{NextMarker:"repeated"},get:{State:"Disabling"}},
    {get:{State:"Disabling"}},
    {get:{EventSourceArn:"arn:aws:sqs:eu-west-2:123456789012:changed"}},
    {get:{FunctionArn:fa+":alias"}},
  ]){
    const f=lambdaFixture(config);
    await assert.rejects(()=>readOrphanManifestWorkerMappings(f.lambda,fn));
  }
});
test("remote Lambda errors fail closed and preserve retry semantics",async()=>{
  const lambda={send:async()=>{throw new Error("Lambda API unavailable");}};
  await assert.rejects(()=>readOrphanManifestWorkerMappings(lambda,fn),/Lambda API unavailable/);
});
