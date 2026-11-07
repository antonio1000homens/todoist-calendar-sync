import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand,QueryCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {ReviewStore} from "../dist/review-store.js";
import {requestDeletedConflictReview} from "../dist/deleted-conflict-recheck.js";

const profile="home",taskId="6hqpHPG5fPWF33Hj";
const masterId="ln6kesr1avdg9ob1ptprcsdar0";
const activeId=masterId+"_20271101";
const caseId="home-todoist_unmapped_conflict-b5ddd1bdb8d270d07ce1";
const current={
  id:caseId,profile,status:"open",reason:"calendar_snapshot_recurring_identity_conflict",
  taskId,eventId:activeId,createdAt:"2026-10-25T20:01:31Z",
  updatedAt:"2026-11-06T16:31:11Z",
  decision:{type:"todoist_unmapped_conflict",taskId,eventId:activeId,
    masterEventId:masterId,context:{candidateTaskIds:[taskId]}},
};

test("#278 dismissing a conflict retains bounded exact ID rechecks without blocking sync",async()=>{
  let tx;
  const store=new ReviewStore({send:async command=>{
    if(command instanceof GetCommand)return {Item:command.input.Key.pk==="REVIEW_CASE#"+caseId?current:undefined};
    if(command instanceof TransactWriteCommand){tx=command.input.TransactItems;return {};}
    throw Error("Unexpected query");
  }});
  const result=await store.dismissCase(caseId,"Acknowledged by operator");
  assert.equal(result.status,"dismissed");
  const keys=tx.filter(x=>x.Put).map(x=>x.Put.Item);
  const expected=[
    "DELETION_REVIEW#home#todoist#"+taskId,
    "DELETION_REVIEW#home#calendar#"+masterId,
    "DELETION_REVIEW#home#calendar#"+activeId,
  ];
  assert.deepEqual(keys.map(x=>x.pk).sort(),expected.sort());
  assert.ok(keys.every(x=>x.sk==="CASE#"+caseId&&x.profile===profile
    &&x.expiresAt>Date.now()/1000&&x.expiresAt<Date.now()/1000+91*86400));
  assert.ok(tx.some(x=>x.Update?.Key.pk==="REVIEW_CASE#"+caseId
    &&x.Update.ConditionExpression.includes("updatedAt = :version")));
  // The lookup is scoped to an ID + profile, not a global history scan.
  const pointerStore=new ReviewStore({send:async command=>{
    if(command instanceof QueryCommand)return {Items:keys.filter(row=>
      row.pk===command.input.ExpressionAttributeValues[":pk"])};
    if(command instanceof GetCommand)return {Item:{...current,status:"dismissed"}};
    throw Error("unexpected command");
  }});
  assert.deepEqual(await pointerStore.listDeletedConflictCaseIds(profile,"calendar",masterId),[caseId]);
  assert.equal(await pointerStore.hasActiveDeletionGuard(profile,"calendar",masterId),false,
    "dismissed pointers must not become a permanent provider write barrier");
});

function queue(){
  const deliveries=[],markers=[],events=[];
  const state={
    async requestReconciliation(p,reason,context){
      events.push({p,reason,context});
      return {created:true,shouldEnqueue:true,state:{
        profile:p,generation:"dismissed-recheck",reason,pending:true,
        requestedAt:new Date().toISOString(),lastRequestedAt:new Date().toISOString(),
      }};
    },
    async markReconciliationEnqueued(...args){markers.push(args);},
  };
  return {state,deliveries,markers,events,enqueue:async delivery=>deliveries.push(delivery)};
}

test("#278 deletion triggers one coalesced fresh read of dismissed case, not a reopened write guard",async()=>{
  const q=queue(),calls=[];
  const reviewed={...current,status:"dismissed"};
  const review={
    async listCases(){return {items:[],cursor:undefined};},
    async listDeletedConflictCaseIds(p,side,id){
      calls.push(["lookup",side,id]);
      if(p!==profile)return [];
      return side==="calendar"&&id===masterId?[caseId]:[];
    },
    async getCase(id){calls.push(["case",id]);return id===caseId?reviewed:undefined;},
    async indexDeletedConflictCase(){throw Error("dismissed case cannot install active write guard");},
    async markDeletedReviewPendingRefresh(refs){
      calls.push(["mark",refs]);
      return refs.map(ref=>({...ref,pendingRefreshAt:"refresh-"+ref.id}));
    },
  };
  assert.equal(await requestDeletedConflictReview(q.state,profile,
    {eventIds:[masterId,activeId]},review,q.enqueue),true);
  assert.equal(q.deliveries.length,1);
  assert.equal(q.events.length,1);
  assert.equal(q.deliveries[0].kind,"reconcile");
  assert.deepEqual(calls.filter(x=>x[0]==="case"),[["case",caseId]]);
  const refs=calls.find(x=>x[0]==="mark")[1];
  assert.deepEqual(refs.map(x=>x.id).sort(),[taskId,masterId,activeId].sort());
  assert.ok(!calls.some(x=>x[0]==="index"));
});

test("#278 unrelated, expired and terminal receipts never enqueue a resurrected dismissed case",async()=>{
  for(const status of ["resolved","excluded","repairing"]){
    const q=queue();
    const review={
      async listCases(){return {items:[]};},
      async listDeletedConflictCaseIds(){return [caseId];},
      async getCase(){return {...current,status};},
      async indexDeletedConflictCase(){throw Error("should not index");},
      async markDeletedReviewPendingRefresh(){throw Error("should not mark");},
    };
    assert.equal(await requestDeletedConflictReview(q.state,profile,{taskIds:[taskId]},
      review,q.enqueue),false);
    assert.equal(q.deliveries.length,0);
  }
  const q=queue();
  const review={
    async listCases(){return {items:[]};},
    async listDeletedConflictCaseIds(){return [];},
  };
  assert.equal(await requestDeletedConflictReview(q.state,profile,{eventIds:[masterId]},
    review,q.enqueue),false);
});

test("#278 exact pointer reader excludes expired/foreign/mismatched entries and fails closed on incomplete query",async()=>{
  const now=Math.floor(Date.now()/1000);
  const pk="DELETION_REVIEW#home#calendar#"+masterId;
  const valid={pk,sk:"CASE#"+caseId,caseId,profile,expiresAt:now+100};
  const store=new ReviewStore({send:async command=>{
    assert.ok(command instanceof QueryCommand);
    return {Items:[
      valid,
      {...valid,expiresAt:now-1},
      {...valid,caseId:"other"},
      {...valid,profile:"work"},
      {...valid,sk:"CASE#incorrect"},
    ]};
  }});
  assert.deepEqual(await store.listDeletedConflictCaseIds(profile,"calendar",masterId),[caseId]);
  const crowded=new ReviewStore({send:async()=>({Items:[valid],LastEvaluatedKey:{pk,sk:valid.sk}})});
  await assert.rejects(crowded.listDeletedConflictCaseIds(profile,"calendar",masterId),/safe limit/);
});
