import test from "node:test";
import assert from "node:assert/strict";
import { planRecurrenceRetirement } from "../dist/recurrence-retirement-preview.js";
import { buildRetirementTransaction, RetirementOperationService,
  RETIREMENT_APPROVAL_PHRASE } from "../dist/recurrence-retirement-apply.js";

const target={profile:"work",generation:"1793982837494-t1u4ucsa",
  taskId:"task351",eventId:"occ_20261021",seriesId:"series-uid-351"};
const mapping={profile:"work",taskId:target.taskId,eventId:target.eventId,
  recurrenceOwner:"calendar",seriesId:target.seriesId,
  masterEventId:"master351",activeInstanceId:target.eventId,
  updatedAt:"2026-10-22T12:00:00Z"};
const link={profile:"work",taskId:target.taskId,eventId:target.eventId,
  owner:"calendar",seriesId:target.seriesId,masterEventId:"master351",
  activeInstanceId:target.eventId,updatedAt:mapping.updatedAt};
const inspection={target,checkedAt:"2026-11-06T19:00:00Z",
  previewFingerprint:"f".repeat(64),mapping,recurrenceLink:link,
  calendar:{},completionHistory:[],otherProfileReferences:[],blockers:[],
  eligibleForFutureApproval:true};
function records(){
  const r=(pk,sk,value={})=>({pk,sk,...value});
  return [
    r("TASK#work#"+target.taskId,"MAP",mapping),
    r("EVENT#work#"+target.eventId,"MAP",mapping),
    r("TASKOWNER#"+target.taskId,"MAP",mapping),
    r("RECURRENCE#work#"+target.seriesId,"STATE",link),
    r("BASELINE#work#TASK#"+target.taskId,"RECONCILE",{
      updatedAt:"2026-10-22T12:00:00Z",baseline:{todoist:{},calendar:{}}}),
    r("CANONICAL#work#todoist#"+target.taskId,"STATE",{
      profile:"work",side:"todoist",providerId:target.taskId,
      updatedAt:"2026-10-22",identity:{title:"Historical"}}),
    r("CANONICAL#work#calendar#"+target.eventId,"STATE",{
      profile:"work",side:"calendar",providerId:target.eventId,
      updatedAt:"2026-10-22",identity:{title:"Historical"}}),
    r("COMPLETED_EVENT#work#"+target.eventId,"STATE",{
      taskId:target.taskId,completedAt:"2026-10-22T19:27:00Z"}),
    r("COMPLETED_SERIES#work#"+target.seriesId,"STATE",{
      seriesId:target.seriesId,terminalCompletedAt:"2026-10-22T19:27:00Z"}),
    r("AUDIT#work#unrelated","STATE",{detail:{taskId:"other"}}),
    r("AUDIT#work#historical","STATE",{detail:{taskId:target.taskId,eventId:target.eventId}}),
  ];
}
function planned(){
  const rows=records();
  return {rows,preview:planRecurrenceRetirement(inspection,rows)};
}
function operation(preview){
  return {operationId:"11111111-1111-4111-8111-111111111111",
    pk:"RETIREMENT_OPERATION#11111111-1111-4111-8111-111111111111",
    sk:"STATE",profile:"work",target,actorSubject:"test-operator",
    status:"previewed",planFingerprint:preview.planFingerprint,
    inspectionFingerprint:preview.inspectionFingerprint,
    confirmationHash:"f".repeat(64),
    confirmationExpiresAt:"2027-01-01T00:00:00Z",
    createdAt:"2026-11-06T19:00:00Z"};
}
test("#351 conditional transaction replaces exact mapped association with permanent markers, never touches history or providers",()=>{
  const {rows,preview}=planned();
  assert.equal(preview.status,"reviewable");
  const cmd=buildRetirementTransaction(operation(preview),preview,rows,
    "2026-11-06T19:10:00Z","test-state-table");
  assert.equal(cmd.constructor.name,"TransactWriteCommand");
  const items=cmd.input.TransactItems;
  const deletes=items.filter(item=>item.Delete).map(item=>item.Delete.Key.pk);
  const puts=items.filter(item=>item.Put).map(item=>item.Put.Item.pk);
  assert.equal(deletes.length,7);
  for(const pk of [
    "TASK#work#task351","TASKOWNER#task351","EVENT#work#occ_20261021",
    "RECURRENCE#work#series-uid-351",
    "BASELINE#work#TASK#task351","CANONICAL#work#todoist#task351",
    "CANONICAL#work#calendar#occ_20261021",
  ])assert.ok(deletes.includes(pk),pk);
  assert.ok(!deletes.some(pk=>/COMPLETED|AUDIT#|REVIEW_CASE|ERASURE_REPLAY/.test(pk)));
  assert.deepEqual(puts.sort(),[
    "RETIREMENT#work#EVENT#master351","RETIREMENT#work#EVENT#occ_20261021",
    "RETIREMENT#work#SERIES#series-uid-351","RETIREMENT#work#TASK#task351",
  ]);
  assert.ok(items.every(item=>!item.Delete||item.Delete.ConditionExpression.includes("attribute_exists(pk)")));
  assert.ok(items.some(item=>item.ConditionCheck?.Key?.pk==="ERASURE#work"));
  assert.ok(items.some(item=>item.ConditionCheck?.Key?.pk==="TASK#home#task351"));
  assert.ok(items.some(item=>item.Update?.Key?.pk.startsWith("RETIREMENT_OPERATION#")));
});
test("#351 revised mapped item after preview cannot pass a stale version-bound transaction",()=>{
  const {rows,preview}=planned();
  rows.find(x=>x.pk==="EVENT#work#"+target.eventId).updatedAt="2026-11-06T20:00:00Z";
  assert.throws(()=>buildRetirementTransaction(operation(preview),preview,rows,
    "2026-11-06T19:10:00Z","test-state-table"),/changed after preview/i);
});
test("#351 malicious/extraneous removal candidate is never accepted",()=>{
  const {rows,preview}=planned();
  const injected={...preview,conditionalCleanupCandidates:[
    ...preview.conditionalCleanupCandidates,
    {pk:"COMPLETED_EVENT#work#"+target.eventId,sk:"STATE",
      recordFingerprint:"a".repeat(64),rationale:"delete history"},
  ]};
  assert.throws(()=>buildRetirementTransaction(operation(injected),injected,rows,
    "2026-11-06T19:10:00Z","test-state-table"),/non-attributable cleanup|changed after preview/i);
});
test("#351 only exact whole-series mapping/link keys may be removed",()=>{
  const {rows,preview}=planned();
  const without={...preview,indexRemovalCandidates:preview.indexRemovalCandidates.slice(0,3)};
  assert.throws(()=>buildRetirementTransaction(operation(without),without,rows,
    "2026-11-06T19:10:00Z","test-state-table"),/four stable mapping\/index keys/i);
});
function harness(t,changes={}) {
  const saved={operation:null,commits:[],writes:0,profileFence:null,leases:0};
  const row=planned();
  const original={
    state:process.env.STATE_TABLE_NAME,protocol:process.env.ERASURE_PROTOCOL_VERSION,
    version:process.env.RETIREMENT_DISPOSITION_VERSION,
  };
  Object.assign(process.env,{STATE_TABLE_NAME:"test-state-table",ERASURE_PROTOCOL_VERSION:"1",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  t.after(()=>{for(const [key,value] of Object.entries({
    STATE_TABLE_NAME:original.state,ERASURE_PROTOCOL_VERSION:original.protocol,
    RETIREMENT_DISPOSITION_VERSION:original.version,
  }))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  let fingerprint=row.preview.planFingerprint;
  const preview=async (_target,dependencies={})=>{
    dependencies.onInventory?.(row.rows);
    return {inspection:{...inspection,eligibleForFutureApproval:true},preview:{
      ...row.preview,planFingerprint:fingerprint,
    }};
  };
  const db={async send(cmd){
    switch(cmd.constructor.name){
      case "PutCommand":
        saved.writes++;
        saved.operation={...cmd.input.Item};
        return {};
      case "GetCommand":
        return {Item:saved.operation?{...saved.operation}:undefined};
      case "UpdateCommand":
        saved.operation={...saved.operation,status:cmd.input.ExpressionAttributeValues[":review"]||"fencing"};
        return {};
      case "TransactWriteCommand":
        saved.writes++;
        saved.commits.push(cmd);
        if(changes.rejectTransaction)
          throw Object.assign(new Error("CAS conflict"),{name:"TransactionCanceledException"});
        saved.operation={...saved.operation,status:"retired",retiredAt:"2026-11-06T19:15:00Z",
          cleanupStatus:"pending",retainedEvidenceCount:1};
        return {};
      default:throw new Error("Unexpected AWS operation "+cmd.constructor.name);
    }
  }};
  const service=new RetirementOperationService({db,preview,
    beginFence:async(_profile,id)=>{saved.profileFence={operationId:id};},
    inspectFence:async()=>({fence:saved.profileFence,leases:Array.from({length:saved.leases},(_,i)=>({id:i}))}),
    finishFence:async()=>{saved.profileFence=null;},
  });
  return {saved,row,service,setFingerprint:value=>{fingerprint=value}};
}
test("#351 operator-bound approval and Apply are two separate actions with idempotent receipt",async t=>{
  const {saved,row,service}=harness(t);
  const issued=await service.issue(target,row.preview.planFingerprint,"operator-351");
  assert.equal(issued.operation.status,"previewed");
  assert.equal(issued.providerWrites,false);
  assert.equal(issued.phrase,RETIREMENT_APPROVAL_PHRASE);
  assert.equal(saved.commits.length,0,"preview approval must not delete mapping");
  await assert.rejects(()=>service.apply(issued.operation.operationId,"bad-token","work",
    "operator-351",RETIREMENT_APPROVAL_PHRASE),/token|exact operation/i);
  await assert.rejects(()=>service.apply(issued.operation.operationId,issued.confirmationId,
    "home","operator-351",RETIREMENT_APPROVAL_PHRASE),/operator and profile/i);
  const first=await service.apply(issued.operation.operationId,issued.confirmationId,
    "work","operator-351",RETIREMENT_APPROVAL_PHRASE);
  assert.equal(first.status,"retired");
  assert.equal(saved.commits.length,1);
  assert.equal(saved.profileFence,null);
  const repeat=await service.apply(issued.operation.operationId,issued.confirmationId,
    "work","operator-351",RETIREMENT_APPROVAL_PHRASE);
  assert.equal(repeat.status,"retired");
  assert.equal(saved.commits.length,1,"duplicate apply must never write again");
});
test("#351 outstanding provider writer leases suspend Apply instead of mutating",async t=>{
  const {saved,row,service}=harness(t);
  const issued=await service.issue(target,row.preview.planFingerprint,"operator-351");
  saved.leases=2;
  const inFlight=await service.apply(issued.operation.operationId,issued.confirmationId,
    "work","operator-351",RETIREMENT_APPROVAL_PHRASE);
  assert.equal(inFlight.status,"fencing");
  assert.equal(saved.commits.length,0);
  assert.ok(saved.profileFence);
  saved.leases=0;
  const recovered=await service.apply(issued.operation.operationId,issued.confirmationId,
    "work","operator-351",RETIREMENT_APPROVAL_PHRASE);
  assert.equal(recovered.status,"retired");
  assert.equal(saved.commits.length,1);
});
test("#351 stale approved fingerprint releases exclusive profile fence with no partial deletion",async t=>{
  const {saved,row,service,setFingerprint}=harness(t);
  const issued=await service.issue(target,row.preview.planFingerprint,"operator-351");
  setFingerprint("b".repeat(64));
  await assert.rejects(()=>service.apply(issued.operation.operationId,issued.confirmationId,
    "work","operator-351",RETIREMENT_APPROVAL_PHRASE),/evidence changed|changed after approval|Retirement changed/i);
  assert.equal(saved.commits.length,0);
  assert.equal(saved.profileFence,null,"no transaction was sent; profile must be available for re-approval");
});
test("#351 refused Dynamo CAS never claims successful Apply",async t=>{
  const {saved,row,service}=harness(t,{rejectTransaction:true});
  const issued=await service.issue(target,row.preview.planFingerprint,"operator-351");
  await assert.rejects(()=>service.apply(issued.operation.operationId,issued.confirmationId,
    "work","operator-351",RETIREMENT_APPROVAL_PHRASE),/mapping, repair or owner changed/i);
  assert.equal(saved.commits.length,1);
  assert.equal(saved.operation.status,"needs_review");
  assert.equal(saved.profileFence,null,"a rejected atomic transaction cannot hold the entire profile");
});
