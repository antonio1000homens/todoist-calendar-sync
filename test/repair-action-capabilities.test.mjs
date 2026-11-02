import assert from "node:assert/strict";
import test from "node:test";
import {availableRepairActions,actionFormFields,REPAIR_ACTION_IDS} from "../review-ui/repair-action-capabilities.mjs";
import {providerIdentity} from "../review-ui/item-identity.mjs";
import {revalidateRepairAction} from "../review-ui/repair-selection.mjs";

const profile="home";
const item=(status="open")=>({id:"case-284",profile,status,title:"Review example",reason:"mapping_conflict"});
const select=(taskId="task",eventId="event")=>({caseId:"case-284",profile,
  taskId,eventId,verifiedTaskId:taskId,verifiedEventId:eventId});
const task=(additional={})=>({id:"task",content:"Test",due:{date:"2027-02-01",is_recurring:false},...additional});
const event=(additional={})=>({id:"event",summary:"Test",status:"confirmed",
  start:{date:"2027-02-01"},end:{date:"2027-02-02"},etag:"etag-1",...additional});
const snapshot=(side,object,more={})=>({ref:{side,profile,id:object.id},object,...more});
const taskSnap=(extra={},more={})=>snapshot("todoist",task(extra),more);
const eventSnap=(extra={},more={})=>snapshot("calendar",event(extra),more);
const assess=(snapshots,selection=select(),caseItem=item(),extras={})=>availableRepairActions({caseItem,snapshots,selection,...extras});
const ids=answer=>answer.actions.map(a=>a.id);
const allowed=(answer,id)=>ids(answer).includes(id);
const no=(answer,...actions)=>actions.forEach(id=>assert.equal(allowed(answer,id),false,id));
const yes=(answer,...actions)=>actions.forEach(id=>assert.equal(allowed(answer,id),true,id));
const mapping={profile,taskId:"task",eventId:"event",updatedAt:"2026-11-01T00:00:00Z"};

test("all twelve action identifiers are evaluated once with explicit reasons and no hidden default",()=>{
  const answer=assess([]);
  const all=[...answer.actions,...answer.unavailable];
  assert.deepEqual(new Set(all.map(a=>a.id)),new Set(REPAIR_ACTION_IDS));
  assert.equal(all.length,12);
  assert.ok(all.every(a=>a.label&&a.explanation&&typeof a.eligible==="boolean"));
  assert.ok(answer.actions.length===0);
  assert.ok(answer.unavailable.every(a=>a.reason));
});

test("ordinary unmapped one-off pair can link but not flatten, transfer, or choose recurrence controls",()=>{
  const result=assess([taskSnap(),eventSnap()]);
  yes(result,"link","exclude","move");
  no(result,"verify","create","flatten","transfer","todoist-only","calendar-history-only","decision");
  assert.equal(result.summary.taskRole,"standalone");
  assert.equal(result.summary.eventRole,"standalone");
  assert.deepEqual(actionFormFields("link",{hasRecurrence:false}),{
    winner:true,owner:false,scope:false,destination:false,decision:false,occurrence:false,
    dispositions:true,sourceChoice:false,counterpartSearch:true,
  });
  assert.equal(actionFormFields("verify",{hasRecurrence:false}).scope,false);
});

test("exact mapped one-off pair exposes verify and guarded standalone deletion, not recurrence repairs",()=>{
  const r=assess([taskSnap({},{mapping}),eventSnap({},{mapping})]);
  yes(r,"verify","link","separate","exclude","todoist-only-delete-calendar");
  no(r,"flatten","transfer","todoist-only","create");
  assert.equal(r.summary.mapping,"mapped");
});

test("recurring Todoist task and current Calendar occurrence can expose flatten with master evidence",()=>{
  const t=taskSnap({due:{date:"2027-02-01",is_recurring:true,string:"every year"}});
  const master=eventSnap({id:"master",recurrence:["RRULE:FREQ=YEARLY"]});
  master.ref.id="master";
  const current=eventSnap({recurringEventId:"master"});
  const r=assess([t,master,current]);
  yes(r,"flatten","link");
  no(r,"transfer","todoist-only-delete-calendar");
  assert.equal(r.summary.eventRole,"occurrence");
  assert.equal(actionFormFields("flatten",{hasRecurrence:true}).scope,true);
  assert.equal(actionFormFields("flatten",{hasRecurrence:true}).occurrence,true);
});

test("recurring Todoist and Calendar master with selected current occurrence may offer guarded transfer",()=>{
  const t=taskSnap({due:{date:"2027-02-01",is_recurring:true,string:"every year"}});
  const m=eventSnap({recurrence:["RRULE:FREQ=YEARLY"]},{calendarProjectionId:"occ"});
  const occ=eventSnap({id:"occ",recurringEventId:"event"});
  occ.ref.id="occ";
  const r=assess([t,m,occ]);
  yes(r,"transfer","link");
  no(r,"flatten","todoist-only-delete-calendar");
  assert.equal(r.summary.eventRole,"master");
  assert.equal(actionFormFields("transfer",{hasRecurrence:true}).owner,true);
});

test("one-off Todoist plus recurring Calendar occurrence can show flatten (not Todoist-only)",()=>{
  const t=taskSnap();
  const master=eventSnap({id:"master",recurrence:["RRULE:FREQ=YEARLY"]});
  master.ref.id="master";
  const current=eventSnap({recurringEventId:"master"});
  const r=assess([t,master,current]);
  yes(r,"flatten");
  no(r,"todoist-only","todoist-only-delete-calendar","transfer");
});

test("historical standalone Calendar context plus recurring Todoist qualifies for specialist task-only",()=>{
  const t=taskSnap({due:{date:"2027-02-01",is_recurring:true,string:"every year"}});
  const e=eventSnap({start:{date:"2025-01-01"},end:{date:"2025-01-02"}});
  const r=assess([t,e]);
  yes(r,"todoist-only");
  no(r,"flatten","transfer","todoist-only-delete-calendar");
});

test("elapsed standalone Calendar item with verified Todoist identity can detach history",()=>{
  const e=eventSnap({start:{date:"2024-02-01"},end:{date:"2024-02-02"},
    extendedProperties:{shared:{taskId:"historical-task"}}});
  const r=assess([e],select("","event"));
  yes(r,"calendar-history-only","create","exclude");
  assert.equal(actionFormFields("calendar-history-only").scope,false);
  no(assess([eventSnap({start:{date:"2028-02-01"},end:{date:"2028-02-02"},
    extendedProperties:{shared:{taskId:"historical-task"}}})],select("","event")),"calendar-history-only");
});

test("verified single-sided Todoist source can create; discovered counterpart or stale mapping revokes it",()=>{
  const source=taskSnap();
  yes(assess([source],select("task","")),"create","move","exclude");
  no(assess([source,eventSnap()],select("task","")),"create");
  no(assess([taskSnap({},{mapping})],select("task","")),"create");
  no(assess([taskSnap({},{destination:{profile:"work"}})],select("task","")),"create");
});

test("missing, cancelled and unverified identities are not inferred as one-off or repairable",()=>{
  const missing={ref:{profile,side:"todoist",id:"task"},object:null};
  const cancelled=eventSnap({status:"cancelled"});
  const r=assess([missing,cancelled]);
  assert.equal(r.actions.length,0);
  assert.match(r.summary.reason,/No verified live item/);
  assert.match(providerIdentity(missing).recurrence,/unknown/i);
  assert.match(providerIdentity(cancelled).recurrence,/unknown/i);
  assert.equal(allowed(assess([taskSnap(),cancelled]),"create"),true);
  no(assess([taskSnap({is_completed:true}),eventSnap()]),"link","verify");
  yes(assess([taskSnap({is_completed:true}),eventSnap()]),"exclude"); // Calendar remains live
});

test("multiple live candidates do not silently authorize counterpart creation or auto-select an identity",()=>{
  const other=eventSnap({id:"other"});
  other.ref.id="other";
  const r=assess([taskSnap(),other],select("task",""));
  no(r,"create");
  assert.equal(r.summary.verifiedEventId,"");
  const unselected=assess([taskSnap(),other],select("",""));
  assert.equal(unselected.actions.length,0);
});

test("cross-profile IDs, changed active repair and competing owner mappings are fail closed",()=>{
  const foreign=taskSnap();
  foreign.ref.profile="work";
  no(assess([foreign,eventSnap()]),"link","verify","flatten","create");
  const controlled=taskSnap({},{control:{activeRepair:"running"}});
  no(assess([controlled,eventSnap()]),"link","exclude","move");
  const wrongMapping={...mapping,taskId:"other"};
  no(assess([taskSnap({},{mapping:wrongMapping}),eventSnap()]),"link","verify","create");
});

test("only a genuinely pending Slack/manual decision with a verified target is eligible",()=>{
  const current=item();
  current.decision={status:"pending",permittedActions:[{id:"bind_task:task",label:"Bind"}]};
  yes(assess([taskSnap()],select("task",""),current),"decision");
  const closed=item();
  closed.decision={status:"resolved",permittedActions:[{id:"bind_task:task"}]};
  no(assess([taskSnap()],select("task",""),closed),"decision");
});

test("closed, dismissed or repairing cases have no actionable mutations, even with verified items",()=>{
  for(const status of ["dismissed","resolved","excluded","repairing"])
    assert.equal(assess([taskSnap(),eventSnap()],select(),item(status)).actions.length,0,status);
  const r=assess([taskSnap(),eventSnap()],select(),item(),{operation:{status:"running"}});
  assert.equal(r.actions.length,0);
});

test("changed evidence revokes action, preview and mutation state without substituting another action",()=>{
  const good=assess([taskSnap(),eventSnap()]);
  assert.deepEqual(revalidateRepairAction("link",good),{action:"link",revoked:false});
  const changed=assess([taskSnap(),eventSnap({status:"cancelled"})]);
  assert.deepEqual(revalidateRepairAction("link",changed),{action:"",revoked:true});
  assert.deepEqual(revalidateRepairAction("transfer",good),{action:"",revoked:true});
  assert.deepEqual(revalidateRepairAction("",good),{action:"",revoked:false});
});

test("action-specific fields never expose recurrence options on ordinary one-off links",()=>{
  const common=["verify","move","todoist-only-delete-calendar","calendar-history-only","decision"];
  for(const action of common){
    const fields=actionFormFields(action,{hasRecurrence:false});
    assert.equal(fields.scope,false,action);
    assert.equal(fields.owner,false,action);
  }
  assert.equal(actionFormFields("create",{hasRecurrence:false}).scope,false);
  assert.equal(actionFormFields("link",{hasRecurrence:true}).scope,true);
  assert.equal(actionFormFields("move").destination,true);
  assert.equal(actionFormFields("decision").decision,true);
  assert.equal(actionFormFields("create").sourceChoice,false);
});

test("case summary preserves observed deleted, completed and cancelled statuses without enabling repairs",()=>{
  const missingTask={ref:{profile,side:"todoist",id:"task"},object:null};
  const cancelledEvent=eventSnap({status:"cancelled"});
  const absent=assess([missingTask,cancelledEvent]);
  assert.equal(absent.summary.task,"missing (404/410)");
  assert.equal(absent.summary.event,"cancelled / deleted");
  assert.equal(absent.summary.recurrence,"Unknown / unverifiable");
  assert.equal(absent.actions.length,0);
  const done=assess([taskSnap({is_completed:true}),eventSnap({status:"cancelled"})]);
  assert.equal(done.summary.task,"completed in Todoist");
  assert.equal(done.summary.event,"cancelled / deleted");
  assert.equal(done.actions.length,0);
});

test("all twelve repair operations fail closed for unverified or cross-profile evidence",()=>{
  const foreignTask=taskSnap();foreignTask.ref.profile="work";
  const foreignEvent=eventSnap();foreignEvent.ref.profile="work";
  for(const scenario of [[],[foreignTask,foreignEvent],
    [{ref:{side:"todoist",profile,id:"task"},object:null},
      {ref:{side:"calendar",profile,id:"event"},object:null}]]){
    const result=assess(scenario);
    for(const id of REPAIR_ACTION_IDS)
      assert.equal(allowed(result,id),false,`${id} should not appear for unverified evidence`);
  }
});

test("one-sided creation requires a verifiable due date and is revoked by later discoveries",()=>{
  no(assess([taskSnap({due:null})],select("task","")),"create");
  yes(assess([taskSnap()],select("task","")),"create");
  const before=assess([taskSnap()],select("task",""));
  const after=assess([taskSnap({},{mapping})],select("task",""));
  assert.equal(revalidateRepairAction("create",before).revoked,false);
  assert.equal(revalidateRepairAction("create",after).revoked,true);
});

test("Calendar search result with incomplete series metadata is not treated as standalone",()=>{
  const selection={...select("","searched"),verifiedEventId:"searched",
    searchedEvent:{id:"searched",caseId:"case-284",profile,status:"confirmed",
      start:{date:"2026-01-01"},end:{date:"2026-01-02"},etag:"etag"}};
  const r=assess([],selection);
  assert.equal(r.summary.eventRole,"unknown");
  no(r,"create","calendar-history-only","todoist-only-delete-calendar","transfer");
  const identity=providerIdentity({_profile:profile,_side:"calendar",id:"searched",_caseId:"case-284",
    status:"confirmed",start:{date:"2026-01-01"},end:{date:"2026-01-02"}});
  assert.match(identity.recurrence,/unknown/i);
});

test("terminal cases preserve only explicitly supported fresh exact-pair previews",()=>{
  for(const status of ["dismissed","resolved","excluded"]){
    const r=assess([taskSnap({},{mapping}),eventSnap({},{mapping})],select(),item(status));
    yes(r,"verify","todoist-only-delete-calendar");
    no(r,"link","create","move","flatten","transfer","exclude","separate","decision");
  }
  const withoutMapping=assess([taskSnap(),eventSnap()],select(),item("dismissed"));
  assert.equal(withoutMapping.actions.length,0);
});
