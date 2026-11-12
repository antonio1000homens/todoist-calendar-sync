import assert from "node:assert/strict";
import test from "node:test";
import {acquireErasureExclusiveAdmission,acquireHistoricalCleanupScope,erasureAdmissionFingerprint,makeHistoricalCleanupScope,scopeConflict}
  from "../dist/scoped-erasure-admission.js";

const profile="work",operationId="erasure-1",epoch=7;
const fenceFingerprint=erasureAdmissionFingerprint({operationId,profile,status:"review_required",
  updatedAt:"2026-11-12T00:00:00.000Z",previewFingerprint:"fingerprint",target:{},selectedActions:{},inventory:[],actionPlan:{}});
function makeScope(caseId,taskId,eventId,resources=[`REVIEW_CASE#${caseId}|STATE`],scopeProfile=profile){
  return makeHistoricalCleanupScope({profile:scopeProfile,caseId,fenceFingerprint,
    entities:[profile+":todoist:"+taskId,profile+":calendar:"+eventId],taskIds:[taskId],eventIds:[eventId],
    resourceKeys:resources,projectCommentIds:["comment-"+caseId],
    writeClasses:["todoist_project_comment_delete","calendar_shared_link_patch","dynamodb_review_state_cleanup"]});
}
function fakeDatabase(){
  const rows=new Map([
    [`ERASURE#${profile}|FENCE`,{pk:`ERASURE#${profile}`,sk:"FENCE",operationId,state:"active"}],
    [`ERASURE#${profile}|EPOCH`,{pk:`ERASURE#${profile}`,sk:"EPOCH",epoch}],
    [`ERASURE_OPERATION#${operationId}|STATE`,{pk:`ERASURE_OPERATION#${operationId}`,sk:"STATE",
      operationId,profile,status:"review_required",updatedAt:"2026-11-12T00:00:00.000Z",
      previewFingerprint:"fingerprint",confirmationFingerprint:"fingerprint",target:{},selectedActions:{},
      inventory:[],actionPlan:{}}],
  ]);
  const keyOf=key=>key.pk+"|"+key.sk;
  let serialized=Promise.resolve();
  const db={async send(command){
    const {constructor:{name},input}=command;
    if(name==="GetCommand")return {Item:rows.get(keyOf(input.Key))&&structuredClone(rows.get(keyOf(input.Key)))};
    if(name==="TransactWriteCommand"){
      const work=serialized.then(()=>{
        for(const action of input.TransactItems){
          const put=action.Put,update=action.Update;
          if(put?.Item?.sk==="SCOPED_ADMISSION"){
            const key=keyOf(put.Item);if(rows.has(key))throw Object.assign(new Error("duplicate gate"),{name:"TransactionCanceledException"});
            rows.set(key,structuredClone(put.Item));
          }
          if(update?.Key?.sk==="SCOPED_ADMISSION"){
            const key=keyOf(update.Key),old=rows.get(key),values=update.ExpressionAttributeValues;
            if(update.ConditionExpression.startsWith("#version=:version")
              &&(!old||old.version!==values[":version"]||old.exclusiveUntil>values[":now"]))
              throw Object.assign(new Error("gate version changed"),{name:"TransactionCanceledException"});
            if(update.ConditionExpression.includes("attribute_not_exists(pk)")&&old)
              throw Object.assign(new Error("gate exists"),{name:"TransactionCanceledException"});
            rows.set(key,{...(old||update.Key),grants:values[":grants"],owners:values[":owners"],
              leaseUntilByOwner:values[":leaseMap"],version:values[":nextVersion"]});
          }
        }
        return {};
      });
      serialized=work.catch(()=>{});return work;
    }
    if(name==="UpdateCommand"){
      const old=rows.get(keyOf(input.Key)),values=input.ExpressionAttributeValues;
      if(!old||old.version!==values[":version"]
        ||input.ConditionExpression.includes("AND exclusiveOwner=:owner")&&old.exclusiveOwner!==values[":owner"])
        throw Object.assign(new Error("gate version changed"),{name:"TransactionCanceledException"});
      const next={...old,grants:values[":grants"],owners:values[":owners"],
        leaseUntilByOwner:values[":leaseMap"],version:values[":nextVersion"]};
      if(input.UpdateExpression.includes("exclusiveOwner=:owner")){
        next.exclusiveOwner=values[":owner"];next.exclusiveUntil=values[":until"];
      }else if(input.UpdateExpression.includes("REMOVE exclusiveOwner")){
        delete next.exclusiveOwner;delete next.exclusiveUntil;
      }
      rows.set(keyOf(input.Key),next);return {};
    }
    throw new Error("Unexpected synthetic DB command: "+name);
  }};
  return {db,rows};
}

test("disjoint historical scopes coexist and serialize against the erasure recovery gate",async()=>{
  process.env.ERASURE_PROTOCOL_VERSION="1";
  const {db,rows}=fakeDatabase();
  const firstScope=makeScope("case-a","task-a","event-a");
  const secondScope=makeScope("case-b","task-b","event-b");
  const [first,second]=await Promise.all([
    acquireHistoricalCleanupScope({profile,fenceOperationId:operationId,epoch,scope:firstScope,owner:"owner-a",db}),
    acquireHistoricalCleanupScope({profile,fenceOperationId:operationId,epoch,scope:secondScope,owner:"owner-b",db}),
  ]);
  assert.equal(rows.get(`ERASURE#${profile}|SCOPED_ADMISSION`).grants.length,2);
  await first.assertActive();
  await assert.rejects(acquireHistoricalCleanupScope({profile,fenceOperationId:operationId,epoch,
    scope:makeScope("case-overlap","task-a","event-other"),owner:"owner-overlap",db}),
    error=>error.blocker==="scoped_admission_overlap");
  await assert.rejects(acquireErasureExclusiveAdmission(profile,operationId,db),error=>error.blocker==="scoped_admission_overlap");
  await first.release();
  await assert.equal(rows.get(`ERASURE#${profile}|SCOPED_ADMISSION`).grants.length,1);
  await second.release();
  const releaseExclusive=await acquireErasureExclusiveAdmission(profile,operationId,db);
  assert.equal(rows.get(`ERASURE#${profile}|SCOPED_ADMISSION`).exclusiveOwner,operationId);
  await assert.rejects(acquireHistoricalCleanupScope({profile,fenceOperationId:operationId,epoch,scope:makeScope("case-c","task-c","event-c"),db}),
    error=>error.blocker==="writer_not_protocol_aware");
  await releaseExclusive();
});

test("overlapping identities and shared state rows are incompatible across profiles",()=>{
  assert.equal(scopeConflict(makeScope("case-a","same-task","event-a"),makeScope("case-b","same-task","event-b")),
    "scoped_admission_overlap");
  assert.equal(scopeConflict(makeScope("case-a","task-a","event-a"),
    makeScope("case-b","task-a","event-b",undefined,"antonio")),"scoped_admission_overlap");
  assert.equal(scopeConflict(makeScope("case-a","task-a","event-a",["AUDIT#work#shared|STATE"]),
    makeScope("case-b","task-b","event-b",["AUDIT#work#shared|STATE"])),"shared_audit_record");
});

test("changed fence epochs fail before creating a scoped lease",async()=>{
  process.env.ERASURE_PROTOCOL_VERSION="1";
  const {db,rows}=fakeDatabase();
  rows.set(`ERASURE#${profile}|EPOCH`,{pk:`ERASURE#${profile}`,sk:"EPOCH",epoch:epoch+1});
  await assert.rejects(acquireHistoricalCleanupScope({profile,fenceOperationId:operationId,epoch,
    scope:makeScope("case-a","task-a","event-a"),db}),error=>error.blocker==="fence_epoch_changed");
  assert.equal(rows.has(`ERASURE#${profile}|SCOPED_ADMISSION`),false);
});
