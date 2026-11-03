import test from "node:test";
import assert from "node:assert/strict";
import {evaluateOrphanEvidence} from "../dist/orphan-proof-reader.js";
import {reviewHash} from "../dist/review-store.js";
import {profiles} from "../dist/config.js";
import {ORPHAN_REQUIRED_CHECKS} from "../dist/orphan-deletion-executor.js";

const now=new Date().toISOString();
const calendar={id:"cal-1",summary:"Independent one-off",status:"confirmed",etag:"etag-1",
  start:{date:"2026-11-14"},end:{date:"2026-11-15"}};
const todoist={id:"task-1",content:"Independent Todoist",project_id:profiles.home.todoistProjectId,
  is_deleted:false,is_completed:false,due:{is_recurring:false}};
const caseItem=(side="calendar")=>({id:"alert-287",profile:"home",status:"open",title:"Orphan",reason:"unmapped",
  ...(side==="calendar"?{eventId:"cal-1"}:{taskId:"task-1"}),
  createdAt:now,updatedAt:now});
const operation=(side="calendar")=>({id:"op-287",caseId:"alert-287",profile:"home",caseUpdatedAt:now,
  side,targetId:side==="calendar"?"cal-1":"task-1",
  providerDigest:reviewHash(side==="calendar"?calendar:todoist),
  ...(side==="calendar"?{providerEtag:"etag-1"}:{}),
  actorSubject:"actor",confirmedAt:now,confirmationExpiresAt:new Date(Date.now()+60000).toISOString(),
  phase:"confirmed",version:0,createdAt:now,updatedAt:now});
function inventory(side="calendar") {
  return {
    item:caseItem(side),
    target:{side,item:side==="calendar"?calendar:todoist},
    counterparts:[],
    providers:["home","antonio","work"].map(profile=>({
      profile,tasks:[],events:[],comments:[],
    })),
    stateRows:[{pk:"REVIEW_CASE#alert-287",sk:"STATE",eventId:"cal-1",taskId:"task-1"}],
  };
}
function proof(side="calendar",changes=()=>{}) {
  const op=operation(side), data=inventory(side);
  changes(data,op);
  return evaluateOrphanEvidence(op,data,now);
}
const problems=p=>Object.entries(p.checks).filter(([,value])=>!value).map(([name])=>name);

test("complete unlinked one-off Calendar and Todoist inventories can prove orphan absence",()=>{
  for(const side of ["calendar","todoist"]){
    const p=proof(side);
    assert.deepEqual(problems(p),[]);
    assert.equal(p.blockers.length,0);
    assert.deepEqual(Object.keys(p.checks).sort(),[...ORPHAN_REQUIRED_CHECKS].sort());
  }
});

test("a directly absent recorded counterpart can be accepted only with exact readback",()=>{
  const p=proof("todoist",data=>{
    data.item={...data.item,eventId:"missing-calendar-id"};
    data.counterparts=[{side:"calendar",id:"missing-calendar-id",object:null}];
  });
  assert.equal(p.checks.all_recorded_counterparts_absent,true);
  const notVerified=proof("todoist",data=>{
    data.item={...data.item,eventId:"missing-calendar-id"};
    data.counterparts=[];
  });
  assert.equal(notVerified.checks.all_recorded_counterparts_absent,false);
});

test("title matches and explicit provider links block side-specific deletion",()=>{
  const p=proof("todoist",data=>{
    data.providers[0].events.push({id:"linked-calendar",summary:"Independent Todoist",status:"confirmed",
      extendedProperties:{shared:{taskId:"task-1"}}});
  });
  assert.equal(p.checks.no_reverse_provider_links,false);
  assert.match(p.blockers.join(" "),/linked-calendar/);
  const calendarCase=proof("calendar",data=>{
    data.providers[0].tasks.push({id:"linked-task",content:"Independent one-off",
      project_id:profiles.home.todoistProjectId,is_completed:false,is_deleted:false});
  });
  assert.equal(calendarCase.checks.no_reverse_provider_links,false);
});

test("other-profile ownership, history, mappings and recurrence references fail closed",()=>{
  const p=proof("calendar",data=>{
    data.providers[1].events.push({...calendar,id:"cal-1"});
    data.stateRows.push(
      {pk:"EVENT#work#cal-1",sk:"MAP",eventId:"cal-1",taskId:"foreign-task"},
      {pk:"RECURRENCE#home#series",sk:"STATE",eventId:"cal-1"},
      {pk:"COMPLETED_EVENT#home#cal-1",sk:"STATE"},
    );
  });
  assert.equal(p.checks.cross_profile_mapping_indexes_clear,false);
  assert.equal(p.checks.recurrence_ownership_clear,false);
  assert.equal(p.checks.completed_history_safe,false);
  assert.equal(p.checks.no_reverse_provider_links,false);
});

test("project/task comments and unknown canonical state block destructive proof",()=>{
  const p=proof("todoist",data=>{
    data.providers[0].comments.push({id:"comment-1",content:"legacy calendar link task-1"});
    data.stateRows.push({pk:"CANONICAL#home#task-1",sk:"STATE",taskId:"task-1"});
  });
  assert.equal(p.checks.project_and_task_comments_clear,false);
  assert.equal(p.checks.canonical_records_clear,false);
  assert.match(p.blockers.join(" "),/manual review/);
});

test("unrelated audit and conflict pointers are not silently discarded",()=>{
  const otherAudit=proof("calendar",data=>{
    data.stateRows.push({pk:"AUDIT#home#historical",sk:"STATE",eventId:"cal-1"});
  });
  assert.equal(otherAudit.checks.canonical_records_clear,false);
  const otherConflict=proof("todoist",data=>{
    data.stateRows.push({pk:"REVIEW_CONFLICT#home#other",sk:"INCIDENT#other",incidentId:"other",taskId:"task-1"});
  });
  assert.equal(otherConflict.checks.canonical_records_clear,false);
  const ownPointer=proof("todoist",data=>{
    data.stateRows.push({pk:"REVIEW_CONFLICT#home#own",sk:"INCIDENT#alert-287",incidentId:"alert-287",taskId:"task-1"});
  });
  assert.equal(ownPointer.checks.canonical_records_clear,true);
});

test("own short-lived case preview does not poison fresh proof, foreign approval still blocks",()=>{
  const own=proof("todoist",data=>{
    data.stateRows.push({pk:"ORPHAN_PREVIEW#preview",sk:"STATE",caseId:"alert-287",
      profile:"home",side:"todoist",targetId:"task-1",actorSubject:"actor",operationId:"op-287"});
  });
  assert.equal(own.checks.canonical_records_clear,true);
  const foreign=proof("todoist",data=>{
    data.stateRows.push({pk:"ORPHAN_PREVIEW#foreign",sk:"STATE",caseId:"alert-287",
      profile:"home",side:"todoist",targetId:"task-1",actorSubject:"other-operator",operationId:"another"});
  });
  assert.equal(foreign.checks.canonical_records_clear,false);
  const differentTarget=proof("todoist",data=>{
    data.stateRows.push({pk:"ORPHAN_PREVIEW#other-target",sk:"STATE",caseId:"alert-287",
      profile:"home",side:"calendar",targetId:"task-1",actorSubject:"actor",operationId:"another"});
  });
  assert.equal(differentTarget.checks.canonical_records_clear,false);
});

test("active repairs/fences block, own durable fence permitted only for this operation",()=>{
  const p=proof("calendar",data=>{
    data.stateRows.push({pk:"ERASURE#home",sk:"FENCE",operationId:"different-operation"});
  });
  assert.equal(p.checks.no_active_repair_or_erasure,false);
  const own=proof("calendar",data=>{
    data.stateRows.push({pk:"ERASURE#home",sk:"FENCE",operationId:"op-287"});
  });
  assert.equal(own.checks.no_active_repair_or_erasure,true);
  const control=proof("calendar",data=>{
    data.stateRows.push({pk:"SYNC_CONTROL#home:calendar:cal-1",sk:"STATE",activeRepair:"repair123"});
  });
  assert.equal(control.checks.sync_controls_clear,false);
});

test("missing, completed, changed or recurring targets never establish proof",()=>{
  const missing=proof("calendar",data=>{data.target=null;});
  assert.equal(missing.checks.exact_target_live,false);
  const changed=proof("calendar",data=>{data.target.item={...calendar,etag:"different"};});
  assert.equal(changed.checks.exact_target_live,false);
  const recurring=proof("todoist",data=>{data.target.item={...todoist,due:{is_recurring:true}};});
  assert.equal(recurring.checks.scope_standalone,false);
  const completed=proof("todoist",data=>{data.target.item={...todoist,is_completed:true};});
  assert.equal(completed.checks.exact_target_live,false);
});

test("partial project enumeration, malformed state and terminal alert cannot prove eligibility",()=>{
  const partial=proof("calendar",data=>{data.providers.pop();});
  assert.equal(partial.checks.complete_provider_enumeration,false);
  assert.equal(partial.checks.no_reverse_provider_links,false);
  const invalid=proof("calendar",data=>{data.stateRows.push({sk:"STATE",eventId:"cal-1"});});
  assert.equal(invalid.checks.canonical_records_clear,false);
  const closed=proof("calendar",data=>{data.item.status="resolved";});
  assert.equal(closed.checks.case_open_unchanged,false);
});
