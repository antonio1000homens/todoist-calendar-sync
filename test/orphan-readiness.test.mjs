import test from "node:test";
import assert from "node:assert/strict";
import {assessOrphanReadiness} from "../dist/orphan-readiness.js";
import {readFileSync} from "node:fs";

const now="2026-11-03T17:40:00.000Z";
const item={
  id:"case-orphan-proof",profile:"home",status:"open",
  title:"Unmapped item",reason:"unmapped_task",taskId:"task-one",eventId:"event-one",
  createdAt:now,updatedAt:now,
};
const task=(id="task-one")=>({id,content:"Buy new shoes",project_id:"project-home",
  is_deleted:false,is_completed:false,updated_at:"2026-11-03T17:39:59Z",
  due:{is_recurring:false}});
const event=(id="event-one")=>({id,summary:"Buy new shoes",status:"confirmed",etag:"etag-one"});
const s=(side,id,object,extra={})=>({
  ref:{profile:"home",side,id},object,checkedAt:now,...extra,
});
const report=(snapshots,caseItem=item)=>assessOrphanReadiness(caseItem,snapshots,now);
const find=(result,side)=>result.items.find(entry=>entry.side===side);

test("exact one-sided missing evidence is diagnostic only, never permission to erase",()=>{
  const result=report([s("todoist","task-one",task()),s("calendar","event-one",null)]);
  assert.equal(result.caseId,item.id);
  assert.equal(result.profile,"home");
  assert.equal(result.status,"blocked");
  assert.equal(result.canExecute,false);
  assert.equal(find(result,"todoist").state,"live");
  assert.equal(find(result,"calendar").state,"missing");
  assert.equal(find(result,"todoist").canExecute,false);
  assert.match(find(result,"todoist").blockers.join(" "),/Exhaustive cross-provider/);
  assert.match(find(result,"todoist").blockers.join(" "),/replay fence/);
});

test("a live linked pair blocks either side even if an operator asks to delete only one",()=>{
  const result=report([s("todoist","task-one",task()),s("calendar","event-one",event())]);
  for(const entry of result.items){
    assert.equal(entry.canExecute,false);
    assert.match(entry.blockers.join(" "),/live .* counterpart/);
  }
});

test("failed direct reads, stale snapshots and missing timestamps never prove deletion",()=>{
  const failed=report([s("todoist","task-one",task()),
    s("calendar","event-one",null,{lookupError:"provider 429"})]);
  assert.equal(find(failed,"calendar").state,"unverified");
  assert.match(find(failed,"todoist").blockers.join(" "),/lookup is incomplete/);
  const stale=report([s("todoist","task-one",task(),{checkedAt:"2026-10-01T01:00:00Z"}),
    s("calendar","event-one",null,{checkedAt:undefined})]);
  assert.equal(find(stale,"todoist").state,"unverified");
  assert.equal(find(stale,"calendar").state,"unverified");
  assert.match(find(stale,"todoist").blockers.join(" "),/stale/);
});

test("mappings, recurrence, controls and Calendar task metadata remain explicit blockers",()=>{
  const result=report([
    s("todoist","task-one",{...task(),due:{is_recurring:true}},{
      mapping:{taskId:"task-one",eventId:"event-one",profile:"home"},
      control:{activeRepair:"repair-active"}}),
    s("calendar","event-one",{...event(),
      extendedProperties:{shared:{taskId:"task-one"}}}),
  ]);
  assert.match(find(result,"todoist").blockers.join(" "),/mapping exists/);
  assert.match(find(result,"todoist").blockers.join(" "),/Recurring/);
  assert.match(find(result,"todoist").blockers.join(" "),/repair/);
  assert.match(find(result,"calendar").blockers.join(" "),/metadata references/);
});

test("discovered extra objects and foreign-profile reads are not accepted as proof",()=>{
  const result=report([
    s("todoist","task-one",task()),
    s("calendar","event-one",null),
    s("calendar","search-only",event("search-only"),{includedBy:["repair title search"]}),
    {...s("todoist","other",task("other")),ref:{profile:"work",side:"todoist",id:"other"}},
  ]);
  assert.deepEqual(result.items.map(value=>value.id),["task-one","event-one"]);
  assert.match(result.blockers.join(" "),/Additional live/);
  assert.match(result.blockers.join(" "),/another profile/);
  assert.ok(result.items.every(value=>value.canExecute===false));
});

test("terminal or operation-owned cases cannot be inspected into executable deletion",()=>{
  for(const caseItem of [{...item,status:"resolved"},{...item,operationId:"repair-op"}]){
    const result=report([s("todoist","task-one",task()),
      s("calendar","event-one",null)],caseItem);
    assert.equal(result.canExecute,false);
    assert.match(result.blockers.join(" "),/not open or an operation/);
  }
});

test("no counterpart ID, invalid IDs or unknown provider state remain blocked",()=>{
  const noCounterpart={...item,eventId:undefined};
  const result=report([s("todoist","task-one",task())],noCounterpart);
  assert.match(find(result,"todoist").blockers.join(" "),/No exact recorded counterpart/);
  const bad=report([], {...item,taskId:"illegal\nid",eventId:"event-one"});
  assert.match(bad.blockers.join(" "),/invalid/);
});

test("UI readiness remains GET-only; independent POST issues a safety preview but cannot confirm deletion",()=>{
  const panel=readFileSync(new URL("../review-ui/orphan-deletion-panel.tsx",import.meta.url),"utf8");
  assert.match(panel,/\/orphan-readiness/);
  assert.match(panel,/Inspect deletion readiness \(read-only\)/);
  assert.match(panel,/no deletion is enabled/);
  assert.doesNotMatch(panel,/\/orphan-previews/);
  assert.doesNotMatch(panel,/method:"POST"/);
  assert.match(panel,/Orphan identity inspection \(read-only\)/);
  assert.doesNotMatch(panel,/orphan-confirmations|deleteTask\(|deleteEvent\(|startErasure|enqueueErasure/);
});
