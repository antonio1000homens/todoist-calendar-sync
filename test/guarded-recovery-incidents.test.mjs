import test from "node:test";
import assert from "node:assert/strict";
import { knownPrewriteRecoveryValidationCase,dismissResolvedPrewriteRecoveryIncidents } from "../dist/guarded-recovery-incidents.js";

const failure="Invalid ConditionExpression: Attribute name is a reserved keyword; reserved keyword: token";
const ownCase={
  id:"home-operational_dlq-1",profile:"home",status:"open",reason:"operational_dlq",
  title:"Operational DLQ",taskId:"task-annual",createdAt:"2026-11-07T16:28:51Z",
  updatedAt:"2026-11-07T16:28:51Z",
  decision:{
    type:"operational_dlq",profile:"home",status:"pending",decisionId:"home-operational_dlq-1",
    sourceDeliveryId:"delivery-prewrite-1",
    context:{kind:"todoist",providerTaskId:"task-annual",deliveryId:"delivery-prewrite-1",failure},
  },
};
test("exact recovery-generated pre-write DynamoDB validation alert may be excluded as competing case",()=>{
  assert.equal(knownPrewriteRecoveryValidationCase(ownCase,"home","task-annual"),true);
  const copies=[
    {...ownCase,profile:"work"},
    {...ownCase,taskId:"different-task"},
    {...ownCase,status:"dismissed"},
    {...ownCase,operationId:"another-running-repair"},
    {...ownCase,eventId:"other-event"},
    {...ownCase,reason:"calendar_snapshot_recurring_ambiguous"},
    {...ownCase,decision:{...ownCase.decision,type:"other_alert"}},
    {...ownCase,decision:{...ownCase.decision,status:"resolved"}},
    {...ownCase,decision:{...ownCase.decision,sourceDeliveryId:"different-delivery"}},
    {...ownCase,decision:{...ownCase.decision,context:{...ownCase.decision.context,failure:"Provider POST may have succeeded"}}},
    {...ownCase,decision:{...ownCase.decision,context:{...ownCase.decision.context,failure:"Invalid ConditionExpression: reserved keyword: owner"}}},
    {...ownCase,decision:{...ownCase.decision,context:{...ownCase.decision.context,kind:"calendar"}}},
    {...ownCase,decision:{...ownCase.decision,context:{...ownCase.decision.context,providerTaskId:"another-task"}}},
  ];
  for(const v of copies)assert.equal(knownPrewriteRecoveryValidationCase(v,"home","task-annual"),false);
});

test("settles only the verified recovered task's precise stale DLQ alert using review-store CAS",async()=>{
  const other={...ownCase,id:"home-operational_dlq-2",taskId:"another-task"};
  const unrelated={...ownCase,id:"home-operational_dlq-3",reason:"operational_dlq",
    decision:{...ownCase.decision,context:{...ownCase.decision.context,failure:"provider timeout"}}};
  const calls=[],read=[];
  const review={
    async listCases(profile,cursor,history,limit){
      read.push({profile,cursor,history,limit});
      return {items:[ownCase,other,unrelated],cursor:undefined};
    },
    async dismissCase(id,result){calls.push({id,result});return {...ownCase,status:"dismissed"};},
  };
  const settled=await dismissResolvedPrewriteRecoveryIncidents("home","task-annual",review);
  assert.equal(settled,1);
  assert.equal(read.length,1);
  assert.deepEqual(calls.map(x=>x.id),[ownCase.id]);
  assert.match(calls[0].result,/verified new recurring Calendar projection/);
});

test("incomplete open-case inventory fails closed before dismissing any alert",async()=>{
  const updates=[];
  const review={
    async listCases(){return {items:[ownCase],cursor:{pk:"more"}};},
    async dismissCase(id){updates.push(id);},
  };
  await assert.rejects(dismissResolvedPrewriteRecoveryIncidents("home","task-annual",review),/safe page bound/);
  assert.deepEqual(updates,[]);
});

test("stale concurrent case CAS failure is surfaced, never silently swallowed by the helper",async()=>{
  const review={
    async listCases(){return {items:[ownCase],cursor:undefined};},
    async dismissCase(){throw Object.assign(new Error("Alert changed"),{status:409});},
  };
  await assert.rejects(dismissResolvedPrewriteRecoveryIncidents("home","task-annual",review),/Alert changed/);
});
