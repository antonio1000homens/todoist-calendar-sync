import assert from "node:assert/strict";
import test from "node:test";
import { requestDeletedConflictReview } from "../dist/deleted-conflict-recheck.js";

const reviewFor = (items) => ({
  async listCases() { return { items, cursor: undefined }; },
  async indexDeletedConflictCase(item) { assert.equal(item.status, "open"); },
  async markDeletedReviewPendingRefresh(refs) {
    return refs.map(ref=>({...ref,pendingRefreshAt:"fresh-"+ref.id}));
  },
});
function harness() {
  const queued=[], marked=[];
  const state={
    async requestReconciliation(profile,reason,context) {
      assert.equal(reason,"manual");
      assert.equal(context.requester,"verified-deletion-recheck");
      return { created:true,shouldEnqueue:true,state:{
        profile,generation:"deletion-recheck-1",reason,pending:true,
        requestedAt:new Date().toISOString(),lastRequestedAt:new Date().toISOString(),
      }};
    },
    async markReconciliationEnqueued(...args) {marked.push(args);},
  };
  return {state,queued,marked,enqueue:async delivery=>queued.push(delivery)};
}

test("Todoist deletion schedules a fresh recheck for the exact case identity",async()=>{
  const h=harness();
  const cases=[{status:"open",taskId:"6hqpHPG5fPWF33Hj",
    eventId:"ln6kesr1avdg9ob1ptprcsdar0",decision:{context:{}}}];
  assert.equal(await requestDeletedConflictReview(h.state,"home",
    {taskIds:["6hqpHPG5fPWF33Hj"]},reviewFor(cases),h.enqueue),true);
  assert.equal(h.queued.length,1);
  assert.equal(h.queued[0].kind,"reconcile");
  assert.equal(h.queued[0].profile,"home");
  assert.equal(h.queued[0].reconcile.reason,"manual");
  assert.deepEqual(h.marked[0].slice(0,2),["home","deletion-recheck-1"]);
});

test("Calendar master or occurrence cancellation rechecks the exact series case only",async()=>{
  const h=harness();
  const cases=[{status:"open",decision:{
    masterEventId:"series-master",context:{candidateTaskIds:["task-1"]},
  }}];
  assert.equal(await requestDeletedConflictReview(h.state,"home",
    {eventIds:["series-master"]},reviewFor(cases),h.enqueue),true);
  assert.equal(await requestDeletedConflictReview(h.state,"home",
    {eventIds:["unrelated-event"]},reviewFor(cases),h.enqueue),false);
  assert.equal(h.queued.length,1);
});

test("unrelated or already-resolved deleted identities never enqueue reconciliation",async()=>{
  const h=harness();
  const cases=[{status:"resolved",taskId:"gone"},{status:"open",taskId:"another",
    eventId:"unrelated"}];
  assert.equal(await requestDeletedConflictReview(h.state,"home",
    {taskIds:["gone"]},reviewFor(cases),h.enqueue),false);
  assert.equal(h.queued.length,0);
});

test("one cancellation of two case-backed events indexes ALL cases before one queued generation",async()=>{
  const h=harness(),order=[];
  const review={
    async listCases(){return {items:[
      {id:"A",status:"open",taskId:"task-a",eventId:"event-a"},
      {id:"B",status:"open",taskId:"task-b",eventId:"event-b"},
    ]};},
    async indexDeletedConflictCase(item){order.push(item.id);},
    async markDeletedReviewPendingRefresh(refs){
      assert.deepEqual(order,["A","B"]);
      assert.deepEqual(refs.filter(ref=>ref.side==="calendar").map(ref=>ref.id).sort(),["event-a","event-b"]);
      return refs.map(ref=>({...ref,pendingRefreshAt:ref.id}));
    },
  };
  assert.equal(await requestDeletedConflictReview(h.state,"home",
    {eventIds:["event-a","event-b"]},review,h.enqueue),true);
  assert.equal(h.queued.length,1);
});

test("a started reconciliation receives durable follow-up identity markers before coalescing",async()=>{
  const h=harness(),contexts=[];
  h.state.requestReconciliation=async(_profile,_reason,context)=>{
    contexts.push(context);
    return {created:false,shouldEnqueue:false,state:{
      generation:"already-running",pending:true,lastStartedAt:"2026-11-02T19:00:00Z",
    }};
  };
  assert.equal(await requestDeletedConflictReview(h.state,"home",{taskIds:["task-a"]},
    reviewFor([{id:"case-a",status:"open",taskId:"task-a",eventId:"event-a"}]),h.enqueue),true);
  assert.equal(h.queued.length,0);
  assert.equal(contexts[0].pendingRefreshRefs.length,2);
  assert.ok(contexts[0].pendingRefreshRefs.every(ref=>ref.pendingRefreshAt));
});
