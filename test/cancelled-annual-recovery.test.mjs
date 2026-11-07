import test from "node:test";
import assert from "node:assert/strict";
import {GetCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {annualRecoveryCandidate,attemptCancelledAnnualRecovery} from "../dist/cancelled-annual-recovery.js";

const now="2026-11-07T17:00:00.000Z", profile="home";
const task={id:"task-annual",project_id:"home-project",content:"Annual event",
  updated_at:now,is_deleted:false,is_completed:false,
  due:{date:"2027-08-16",is_recurring:true,string:"every year"}};
const originalTask={...task,updated_at:"2026-10-02T09:00:00Z",
  due:{date:"2027-08-16",is_recurring:false,string:"2027-08-16"}};
const mapping={profile,eventId:"event-mapped",taskId:task.id,updatedAt:"2026-10-23T10:35:00Z"};
const refs=[
  {profile,side:"calendar",id:"event-historical"},
  {profile,side:"todoist",id:task.id},
];
const oldCalendar={id:"event-historical",status:"confirmed",start:{date:"2027-08-16"},
  end:{date:"2027-08-17"},extendedProperties:{shared:{taskId:task.id}}};
const deletedCalendar=(id)=>({id,status:"cancelled",start:{date:"2027-08-16"},
  end:{date:"2027-08-17"}});
const reviewCase={id:"case-annual",profile,status:"dismissed",operationId:"repair-annual",updatedAt:"2026-11-01T15:00:00Z"};
const operation={
  id:"repair-annual",status:"failed",attempt:2,updatedAt:"2026-10-26T11:00:00Z",
  steps:{validated:{status:"done"}},creations:{},notificationPending:false,
  actor:{subject:"actor"},preview:{
    id:"preview-annual",intent:{profile,caseId:reviewCase.id,taskId:task.id,
      eventId:"event-historical",action:"verify",scope:"series"},
    case:{id:reviewCase.id,status:"open"},
    snapshots:[
      {ref:refs[0],object:oldCalendar},
      {ref:refs[1],object:originalTask},
    ],
  },
};

test("only an already-annual, newer live task and failed validation-only dismissed repair qualify",()=>{
  assert.equal(annualRecoveryCandidate(profile,task,mapping,operation,reviewCase),true);
  assert.equal(annualRecoveryCandidate(profile,{...task,due:{...task.due,is_recurring:false}},mapping,operation,reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,{...task,updated_at:"2026-10-01T00:00:00Z"},mapping,operation,reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,{...task,is_completed:true},mapping,operation,reviewCase),false);
  assert.equal(annualRecoveryCandidate("work",task,mapping,operation,reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,task,{...mapping,recurrenceOwner:"calendar"},operation,reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,task,mapping,{...operation,status:"succeeded"},reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,task,mapping,{...operation,steps:{
    validated:{status:"done"},"provider-call":{status:"running"},
  }},reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,task,mapping,{...operation,writeStarted:true},reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,task,mapping,{...operation,creations:{x:{result:{id:"created"}}}},reviewCase),false);
  assert.equal(annualRecoveryCandidate(profile,task,mapping,operation,{...reviewCase,status:"open"}),false);
});

function harness(overrides={}){
  const rows=new Map();
  const entry=(pk,sk="STATE",v={})=>rows.set(pk+"|"+sk,{pk,sk,...v});
  for(const pk of ["TASK#home#task-annual","TASKOWNER#task-annual","EVENT#home#event-mapped"])
    entry(pk,"MAP",mapping);
  entry("BASELINE#home#TASK#task-annual","RECONCILE",{updatedAt:"2026-10-02T10:00:00Z"});
  for(const ref of refs)entry("SYNC_CONTROL#"+ref.profile+":"+ref.side+":"+ref.id,"STATE",{activeRepair:operation.id});
  const transactions=[];
  const db={async send(command){
    if(command instanceof GetCommand){
      const {pk,sk}=command.input.Key;
      assert.equal(command.input.ConsistentRead,true);
      return {Item:rows.get(pk+"|"+sk)};
    }
    if(command instanceof TransactWriteCommand){
      transactions.push(command.input);
      return {};
    }
    throw new Error("Unexpected DynamoDB write/read");
  }};
  const review={
    async getOperation(){return overrides.operation??operation;},
    async getCase(){return overrides.reviewCase??reviewCase;},
    async hasActiveDeletionGuard(){return overrides.deletionGuard??false;},
    async listCases(){return {items:overrides.openCases??[],cursor:undefined};},
  };
  const state={
    async isRetired(){return false;},
    async getCalendarProjectionTombstone(){return undefined;},
    async getRecurrenceLinkByTaskAnyProfile(){return overrides.recurrence??undefined;},
    async listCompletedCalendarProjectionsByTaskAnyProfile(){return overrides.completed??[];},
    async getMappingByTask(p,id){return p==="home"?overrides.mapping??mapping:undefined;},
    async getCompletedCalendarProjectionByEvent(){return undefined;},
  };
  const calendar={
    async listLinkedEventsByTodoistTaskId(){
      return overrides.linked??[deletedCalendar("event-mapped"),deletedCalendar("event-historical")];
    },
    async getEvent(id){return overrides.liveCalendar?.(id)??deletedCalendar(id);},
    async listExplicitSeriesExceptions(){return overrides.exceptions??[];},
  };
  const todoist={async getTask(){return overrides.current??task;}};
  return {rows,transactions,db,review,state,calendar,todoist};
}
async function run(h,source=task){
  const prev=process.env.STATE_TABLE_NAME;
  process.env.STATE_TABLE_NAME="test-state";
  try {
    return await attemptCancelledAnnualRecovery({profile,task:source,mapping,
      operationId:operation.id,writeToken:"writer-token",state:h.state,
      calendar:h.calendar,todoist:h.todoist},
      {db:h.db,review:h.review,now:()=>new Date(now)});
  }finally{
    if(prev===undefined)delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME=prev;
  }
}

test("creates exactly one guarded transaction, preserves repair, original task and auditable history",async()=>{
  const h=harness();
  assert.equal(await run(h),true);
  assert.equal(h.transactions.length,1);
  const items=h.transactions[0].TransactItems;
  assert.equal(items.filter(x=>x.Delete).length,4,"only 3 mapping views and old baseline are deleted");
  assert.equal(items.filter(x=>x.Update).length,3,"repair plus 2 owned control references");
  assert.equal(items.filter(x=>x.Put).length,1,"only one pending replay-safe reset receipt");
  assert.ok(items.some(x=>x.Put?.Item?.pk==="ANNUAL_RECOVERY#home#task-annual"));
  assert.ok(items.some(x=>x.ConditionCheck?.Key?.pk==="CALENDAR_WRITE#task-annual"));
  assert.ok(items.some(x=>x.ConditionCheck?.Key?.pk==="REVIEW_CASE#case-annual"));
  assert.ok(items.some(x=>x.Update?.Key?.pk==="REPAIR#repair-annual"));
  assert.ok(items.some(x=>x.Update?.Key?.pk==="SYNC_CONTROL#home:todoist:task-annual"));
  assert.ok(items.some(x=>x.Update?.Key?.pk==="SYNC_CONTROL#home:calendar:event-historical"));
  assert.ok(items.every(x=>!x.Delete?.Key?.pk?.startsWith("AUDIT#")));
  assert.ok(items.every(x=>!x.Delete?.Key?.pk?.startsWith("COMPLETED")));
  assert.ok(items.every(x=>!x.Delete?.Key?.pk?.startsWith("REPAIR#")));
});

test("fails closed on a confirmed or ambiguous provider-linked counterpart",async()=>{
  const h=harness({linked:[deletedCalendar("event-historical"),{
    id:"active-elsewhere",status:"confirmed",start:{date:"2027-08-16"},
  }]});
  assert.equal(await run(h),false);
  assert.equal(h.transactions.length,0);
});

test("fails closed on wrong current Todoist version and on active completed markers",async()=>{
  const h=harness({current:{...task,updated_at:"2026-11-07T18:00:00Z"}});
  assert.equal(await run(h),false);
  assert.equal(h.transactions.length,0);
  const h2=harness({completed:[{eventId:"protected"}]});
  assert.equal(await run(h2),false);
  assert.equal(h2.transactions.length,0);
});

test("any prior write-started operation or foreign recurrence aborts without DynamoDB mutation",async()=>{
  const h=harness({operation:{...operation,steps:{validated:{status:"done"},provider:{status:"running"}}}});
  assert.equal(await run(h),false);
  assert.equal(h.transactions.length,0);
  const h2=harness({recurrence:{taskId:task.id,seriesId:"foreign"}});
  assert.equal(await run(h2),false);
  assert.equal(h2.transactions.length,0);
});

test("changed/missing guarded mapping aborts before any DynamoDB transaction",async()=>{
  const h=harness();
  h.rows.delete("TASKOWNER#task-annual|MAP");
  assert.equal(await run(h),false);
  assert.equal(h.transactions.length,0);
});

test("lost transaction acknowledgement or conditional race never triggers a best-effort delete",async()=>{
  const h=harness();
  h.db.send=async(command)=>{
    if(command instanceof GetCommand)return {Item:h.rows.get(command.input.Key.pk+"|"+command.input.Key.sk)};
    if(command instanceof TransactWriteCommand) {
      const error=new Error("Conditional mapping changed");error.name="TransactionCanceledException";throw error;
    }
    throw new Error("Unexpected command");
  };
  assert.equal(await run(h),false);
  assert.equal(h.transactions.length,0);
});

test("open competing case blocks recovery without modifying any provider or state",async()=>{
  const h=harness({openCases:[{id:"unrelated",profile:"home",status:"open",taskId:task.id}]});
  assert.equal(await run(h),false);
  assert.equal(h.transactions.length,0);
});
