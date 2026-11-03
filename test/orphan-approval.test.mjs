import test from "node:test";
import assert from "node:assert/strict";
import { OrphanApprovalService, OrphanApprovalError, ORPHAN_APPROVAL_WINDOW_MS } from "../dist/orphan-approval.js";
import { ORPHAN_REQUIRED_CHECKS } from "../dist/orphan-deletion-executor.js";
import { profiles } from "../dist/config.js";

const actor={subject:"access-user-123",email:"review-owner@example.test"};
const time=()=>new Date();
const caseItem=()=>({id:"review-case-287",profile:"home",title:"Unmapped task",
  reason:"unmapped_task",status:"open",
  taskId:"task-287",createdAt:"2026-11-03T18:00:00.000Z",
  updatedAt:"2026-11-03T18:40:00.000Z"});
const task=()=>({id:"task-287",content:"Task to delete",project_id:profiles.home.todoistProjectId,
  is_deleted:false,is_completed:false,due:{is_recurring:false}});
const event=()=>({id:"calendar-287",summary:"One-time Cubs event",status:"confirmed",etag:"etag-287"});
function fakeDb() {
  const rows=new Map(),writes=[];
  const db={send:async command=>{
    writes.push(command);
    const input=command.input;
    if(command.constructor.name==="PutCommand") {
      rows.set(input.Item.pk,structuredClone(input.Item));return {};
    }
    if(command.constructor.name==="GetCommand") {
      return {Item:structuredClone(rows.get(input.Key.pk))};
    }
    if(command.constructor.name==="TransactWriteCommand") {
      const p=input.TransactItems[1].Update;
      const preview=rows.get(p.Key.pk);
      if(!preview||preview.status!=="issued") {
        const error=new Error("Transaction already consumed");error.name="TransactionCanceledException";throw error;
      }
      const operation=input.TransactItems[2].Put.Item;
      if(rows.has(input.TransactItems[3].Put.Item.pk)){
        const error=new Error("Case already locked");error.name="TransactionCanceledException";throw error;
      }
      rows.set(p.Key.pk,{...preview,status:"consumed",consumedAt:p.ExpressionAttributeValues[":now"]});
      rows.set(operation.pk,structuredClone(operation));
      rows.set(input.TransactItems[3].Put.Item.pk,structuredClone(input.TransactItems[3].Put.Item));
      return {};
    }
    throw new Error("Unexpected DDB operation "+command.constructor.name);
  }};
  return {db,rows,writes};
}
function fixture(side="todoist",override={}) {
  let item={...caseItem(),...(side==="calendar"?{eventId:"calendar-287",taskId:undefined}:{})};
  let object=side==="calendar"?event():task();
  let proofMutator=proof=>proof;
  const {db,rows,writes}=fakeDb();
  let counter=0,reads=0,proofs=0;
  const sources={
    db,cases:{getCase:async id=>id===item.id?structuredClone(item):undefined},
    readTarget:async(profile,readSide,id)=>{
      reads++;assert.equal(profile,item.profile);assert.equal(readSide,side);assert.equal(id,object.id);
      return structuredClone(object);
    },
    collectProof:async op=>{
      proofs++;
      const proof={caseId:op.caseId,profile:op.profile,caseUpdatedAt:op.caseUpdatedAt,
        side:op.side,targetId:op.targetId,checkedAt:time().toISOString(),
        providerDigest:op.providerDigest,
        ...(op.providerEtag?{providerEtag:op.providerEtag}:{}),
        checks:Object.fromEntries(ORPHAN_REQUIRED_CHECKS.map(key=>[key,true])),blockers:[]};
      return proofMutator(proof);
    },
    newId:()=>{
      counter++;return "b2e44444-3333-4222-8111-"+String(counter).padStart(12,"0");
    },
    now:time,...override,
  };
  return {
    service:new OrphanApprovalService(sources),rows,writes,object,
    getItem:()=>item,setItem:value=>{item=value;},
    setObject:value=>{object=value;},
    changeProof:fn=>{proofMutator=fn;},
    get counts(){return {reads,proofs};},
    side,id:object.id,
  };
}
const preview=f=>f.service.issue("review-case-287",f.side,f.id,actor);
const confirm=(f,p,overrides={},who=actor)=>f.service.confirm("review-case-287",{
  previewId:p.previewId,confirmationId:p.confirmationId,
  exactId:p.targetId,phrase:"PERMANENTLY ERASE",...overrides,
},who);

test("Todoist: exact case-bound preview consumes hashed nonce in atomic operation/lock transaction, no provider DELETE",async()=>{
  const f=fixture();
  const p=await preview(f);
  assert.equal(p.side,"todoist");assert.equal(p.targetId,"task-287");
  assert.equal(p.executionQueued,false);assert.equal(p.stateCleanupPlanned,false);
  assert.equal(Date.parse(p.expiresAt)-Date.now()<=ORPHAN_APPROVAL_WINDOW_MS+1000,true);
  assert.equal(f.counts.reads,1);assert.equal(f.counts.proofs,1);
  const saved=f.rows.get("ORPHAN_PREVIEW#"+p.previewId);
  assert.equal(saved.targetId,p.targetId);
  assert.equal(saved.status,"issued");
  assert.equal(saved.nonceDigest.length,64);
  assert.notEqual(saved.nonceDigest,p.confirmationId);
  assert.equal(saved.expiresAt,Math.ceil(saved.expiresAtMs/1000),"Dynamo TTL is epoch seconds");
  assert.equal(JSON.stringify(saved).includes(p.confirmationId),false,"nonce plaintext never persisted");
  const operation=await confirm(f,p);
  assert.equal(operation.status,"confirmed_not_dispatched");
  assert.equal(operation.executionQueued,false);
  assert.equal(f.counts.proofs,2,"fresh confirmation proof, not cached preview");
  const txn=f.writes.find(command=>command.constructor.name==="TransactWriteCommand");
  assert.ok(txn);assert.equal(txn.input.TransactItems.length,4);
  assert.match(txn.input.TransactItems[0].ConditionCheck.ConditionExpression,/attribute_not_exists/);
  assert.match(txn.input.TransactItems[1].Update.ConditionExpression,/#nonce = :nonce/);
  assert.equal(txn.input.TransactItems[2].Put.Item.side,"todoist");
  assert.equal(txn.input.TransactItems[3].Put.Item.targetId,p.targetId);
  assert.equal(f.rows.get("ORPHAN_DELETE#"+operation.operationId).phase,"confirmed");
  await assert.rejects(confirm(f,p),error=>error instanceof OrphanApprovalError&&error.status===403);
  assert.equal(f.counts.proofs,2,"used nonce is rejected before provider scan");
});

test("Calendar: exact ETag and distinct provider side are frozen; no Todoist identity required",async()=>{
  const f=fixture("calendar");
  const p=await preview(f);
  assert.equal(p.side,"calendar");
  assert.equal(p.targetId,"calendar-287");
  const confirmation=await confirm(f,p);
  const op=f.rows.get("ORPHAN_DELETE#"+confirmation.operationId);
  assert.equal(op.side,"calendar");
  assert.equal(op.providerEtag,"etag-287");
  assert.equal(op.targetId,"calendar-287");
  assert.equal(op.caseId,"review-case-287");
});

test("reject arbitrary target, missing case and operational alerts before any mutation",async()=>{
  const f=fixture();
  await assert.rejects(f.service.issue("review-case-287","todoist","other-task",actor),e=>e.status===409);
  await assert.rejects(f.service.issue("not-this-case","todoist","task-287",actor),e=>e.status===404);
  f.setItem({...f.getItem(),status:"resolved"});
  await assert.rejects(preview(f),e=>e.status===409);
  f.setItem({...caseItem(),reason:"operational_dlq"});
  await assert.rejects(preview(f),e=>e.status===409);
  assert.equal(f.writes.length,0);
});

test("provider not-live and recurrence are rejected rather than becoming eligible via a missing mapping",async()=>{
  const f=fixture();
  f.setObject({...f.object,is_completed:true});
  await assert.rejects(preview(f),e=>e.status===409);
  f.setObject({...f.object,is_completed:false,due:{is_recurring:true}});
  await assert.rejects(preview(f),e=>e.status===409);
  assert.equal(f.writes.length,0);
});

test("missing linked-counterpart proof blocks preview, no nonce or confirmed operation created",async()=>{
  const f=fixture();
  f.changeProof(proof=>({...proof,checks:{...proof.checks,no_reverse_provider_links:false},
    blockers:["Another Calendar event references task"]}));
  await assert.rejects(preview(f),e=>e.status===409);
  assert.equal(f.writes.length,0);
});

test("confirmation refuses wrong actor, ID, phrase, nonce, expired preview and case version drift",async()=>{
  const f=fixture();
  const p=await preview(f);
  await assert.rejects(confirm(f,p,{}, {subject:"other-operator",email:"other@example.test"}),e=>e.status===403);
  await assert.rejects(confirm(f,p,{exactId:"different"}),e=>e.status===403);
  await assert.rejects(confirm(f,p,{confirmationId:"invalid"}),e=>e.status===400);
  await assert.rejects(confirm(f,p,{phrase:"DELETE"}),e=>e.status===400);
  assert.equal(f.rows.has("ORPHAN_DELETE#"+p.previewId),false);
  f.setItem({...f.getItem(),updatedAt:"2026-11-03T19:01:00.000Z"});
  await assert.rejects(confirm(f,p),e=>e.status===409);
  f.setItem(caseItem());
  const record=f.rows.get("ORPHAN_PREVIEW#"+p.previewId);
  record.expiresAtMs=Date.now()-5;
  await assert.rejects(confirm(f,p),e=>e.status===409);
  assert.equal(f.writes.filter(cmd=>cmd.constructor.name==="TransactWriteCommand").length,0);
});

test("confirmation detects proof drift after a valid preview and never acquires the deletion case lock",async()=>{
  const f=fixture();
  const p=await preview(f);
  f.changeProof(proof=>({...proof,checks:{...proof.checks,completed_history_safe:false},
    blockers:["Completed history changed"]}));
  await assert.rejects(confirm(f,p),e=>e.status===409);
  assert.equal(f.rows.has("ORPHAN_CASE_LOCK#review-case-287"),false);
  assert.equal(f.rows.get("ORPHAN_PREVIEW#"+p.previewId).status,"issued");
});

test("two separate previews of same case cannot both be confirmed",async()=>{
  const f=fixture();
  const first=await preview(f);
  const second=await preview(f);
  await confirm(f,first);
  await assert.rejects(confirm(f,second),e=>e.status===409);
  assert.equal(f.rows.get("ORPHAN_CASE_LOCK#review-case-287").targetId,"task-287");
  assert.equal(f.rows.get("ORPHAN_PREVIEW#"+second.previewId).status,"issued");
});

test("operator-specific status route refuses a foreign operation and cannot expose other cases",async()=>{
  const f=fixture();
  const p=await preview(f);
  const res=await confirm(f,p);
  const read=await f.service.status("review-case-287",res.operationId,actor);
  assert.equal(read.phase,"confirmed");
  await assert.rejects(f.service.status("other-case",res.operationId,actor),e=>e.status===404);
  await assert.rejects(f.service.status("review-case-287",res.operationId,
    {subject:"foreign",email:"foreign@example.test"}),e=>e.status===403);
});
