import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {recordedOrphanIdentities,orphanItemsForCase,chosenOrphan} from "../review-ui/orphan-selection.mjs";

const item={id:"case-287",profile:"home",status:"open",taskId:"task-1",eventId:"event-1",
  decision:{context:{candidateTaskIds:["task-2"],candidateEventIds:["event-2"]}}};
const snap=(side,id,object,more={})=>({ref:{profile:"home",side,id},object,...more});
const task=(id,content="Fix school uniform")=>({id,content,project_id:"project",is_deleted:false,is_completed:false,due:{date:"2026-11-10",is_recurring:false}});
const event=(id,summary="Fix school uniform")=>({id,summary,status:"confirmed",start:{date:"2026-11-10"},end:{date:"2026-11-11"},etag:"etag"});
const entries=snapshots=>orphanItemsForCase({item,snapshots});

test("one selection menu combines both Todoist and Calendar identities from one alert",()=>{
  const candidates=entries([snap("todoist","task-1",task("task-1")),snap("calendar","event-1",event("event-1"))]);
  assert.deepEqual(candidates.map(x=>x.key),["home:calendar:event-1","home:todoist:task-1"]);
  assert.deepEqual(candidates.map(x=>x.label),[
    "Calendar · Fix school uniform · event-1","Todoist · Fix school uniform · task-1"]);
  assert.ok(candidates.every(x=>x.profile==="home"));
  assert.ok(candidates.every(x=>!x.eligible),"UI-only evidence must not authorize irreversible deletion");
});

test("duplicate titles never conflate distinct provider IDs",()=>{
  const candidates=entries([
    snap("todoist","task-1",task("task-1","Same name")),
    snap("todoist","task-2",task("task-2","Same name")),
  ]);
  assert.equal(candidates.length,2);
  assert.notEqual(candidates[0].key,candidates[1].key);
  assert.ok(candidates.every(x=>x.label.includes("Same name")));
  assert.ok(candidates.some(x=>x.label.includes("task-1")));
  assert.ok(candidates.some(x=>x.label.includes("task-2")));
});

test("unknown title uses the exact ID and cannot become eligible",()=>{
  const result=entries([snap("todoist","task-1",{id:"task-1",project_id:"project"})]);
  assert.match(result[0].label,/Todoist · Title unavailable · task-1/);
  assert.equal(result[0].eligible,false);
});

test("missing, cancelled and completed identities remain context, never actionable",()=>{
  const candidates=entries([
    snap("todoist","task-1",null),
    snap("todoist","task-2",{...task("task-2"),is_completed:true}),
    snap("calendar","event-1",{...event("event-1"),status:"cancelled"}),
    snap("calendar","event-2",null),
  ]);
  assert.equal(candidates.length,4);
  assert.ok(candidates.every(x=>!x.live&&!x.eligible));
  assert.equal(candidates.filter(x=>x.status==="missing").length,2);
});

test("linked, recurrent or controlled provider objects show blockers, not a destructive action",()=>{
  const candidates=entries([
    snap("todoist","task-1",task("task-1"),{mapping:{taskId:"task-1",eventId:"event-1",profile:"home"}}),
    snap("todoist","task-2",{...task("task-2"),due:{date:"2026-11-10",is_recurring:true,string:"every week"}}),
    snap("calendar","event-1",{...event("event-1"),extendedProperties:{shared:{taskId:"task-1"}}}),
    snap("calendar","event-2",event("event-2"),{control:{activeRepair:"running"}}),
  ]);
  assert.ok(candidates.every(x=>!x.eligible));
  assert.match(candidates.find(x=>x.id==="task-1").reason,/Linked/);
  assert.match(candidates.find(x=>x.id==="task-2").reason,/Recurring/);
  assert.match(candidates.find(x=>x.id==="event-1").reason,/references a Todoist/);
  assert.match(candidates.find(x=>x.id==="event-2").reason,/controlled|mapping/i);
});

test("an ordinary unmapped task is still blocked without direct counterpart and replay proof",()=>{
  const candidate=entries([snap("todoist","task-1",task("task-1"))])[0];
  assert.equal(candidate.live,true);
  assert.equal(candidate.eligible,false);
  assert.match(candidate.reason,/independent counterpart absence/);
});

test("cross-profile and unrelated search items can never enter the selected alert",()=>{
  const foreign={ref:{profile:"work",side:"todoist",id:"task-1"},object:task("task-1")};
  const unrelated=snap("todoist","unrelated",task("unrelated"));
  const legit=snap("calendar","event-1",event("event-1"));
  assert.deepEqual(entries([foreign,unrelated,legit]).map(x=>x.id),["event-1"]);
  const searchResult=snap("calendar","searched",event("searched"));
  assert.deepEqual(entries([searchResult]),[],"a title match alone is not case membership evidence");
});

test("bounded case evidence lists support both explicitly recorded candidate sides",()=>{
  const ids=recordedOrphanIdentities(item);
  assert.deepEqual(ids.todoist,["task-1","task-2"]);
  assert.deepEqual(ids.calendar,["event-1","event-2"]);
  const blank={id:"blank",profile:"home",status:"open"};
  assert.deepEqual(orphanItemsForCase({item:blank,snapshots:[snap("todoist","task-1",task("task-1"))]}),[]);
});

test("repair-search includedBy does not establish membership in an immutable alert",()=>{
  const unrelated=snap("calendar","search-operator-chose",event("search-operator-chose"),
    {includedBy:["Selected Calendar item for this repair"]});
  const linked=snap("todoist","task-1",task("task-1"),
    {includedBy:["Exact identity recorded on selected review alert"]});
  assert.deepEqual(entries([unrelated,linked]).map(x=>x.id),["task-1"]);
  assert.deepEqual(entries([unrelated]),[], "even a collected search-only item cannot anchor deletion candidates");
});

test("candidate-only IDs are case-scoped and failed provider lookups never count as verified missing",()=>{
  const candidate=snap("todoist","task-2",null,{lookupError:"The direct provider lookup failed"});
  const options=entries([candidate,snap("calendar","event-2",event("event-2"))]);
  assert.deepEqual(options.map(x=>x.id),["event-2","task-2"]);
  const failure=options.find(x=>x.id==="task-2");
  assert.equal(failure.status,"unverified");
  assert.match(failure.reason,/could not be verified/);
  assert.equal(failure.eligible,false);
});

test("a Todoist task with absent completion/deletion fields is not verified live",()=>{
  const incomplete=snap("todoist","task-1",{id:"task-1",content:"Incomplete",project_id:"project"});
  assert.equal(entries([incomplete])[0].live,false);
  assert.match(entries([incomplete])[0].reason,/missing explicit Todoist status fields/);
});

test("terminal alert statuses cannot enable deletion and exact selection is immutable",()=>{
  const closed={...item,status:"resolved"};
  const candidates=orphanItemsForCase({item:closed,snapshots:[snap("todoist","task-1",task("task-1"))]});
  assert.equal(candidates[0].eligible,false);
  assert.match(candidates[0].reason,/Only an open/);
  assert.equal(chosenOrphan(candidates,item,candidates[0].key),undefined);
  assert.equal(chosenOrphan(candidates,{...item,profile:"work"},candidates[0].key),undefined);
});

test("review UI hides no-ID orphan controls and exposes only read-only identity inspection",()=>{
  const panel=readFileSync(new URL("../review-ui/orphan-deletion-panel.tsx",import.meta.url),"utf8");
  const main=readFileSync(new URL("../review-ui/main.tsx",import.meta.url),"utf8");
  const recovery=readFileSync(new URL("../review-ui/erasure-recovery-panel.tsx",import.meta.url),"utf8");
  assert.match(panel,/if\(candidates\.length===0\)return null/);
  assert.match(panel,/Orphan identity inspection \(read-only\)/);
  assert.match(panel,/No deletion is enabled/);
  assert.match(panel,/Inspect deletion readiness \(read-only\)/);
  assert.doesNotMatch(panel,/<select|<label>Item to delete|Request verified deletion preview/);
  assert.match(main,/orphanItemsForCase\(\{item:details\.item,snapshots:details\.snapshots\|\|\[\]\}\)\.length>0/);
  assert.match(main,/<OrphanDeletionPanel key=/);
  assert.match(main,/item=\{details\.item\} snapshots=\{details\.snapshots\|\|\[\]\}/);
  assert.match(main,/<ErasureRecoveryPanel api=\{api\}/);
  assert.doesNotMatch(main,/<ErasurePanel api=/);
  assert.doesNotMatch(recovery,/erasure-previews|Preview exact erasure|<fieldset|Exact Todoist task ID|Start guarded erasure/);
  assert.match(recovery,/erasure-recoveries/);
  assert.match(recovery,/erasure-operations/);
});

test("read-only orphan inspections never offer selection, provider writes or delete previews",()=>{
  const source=readFileSync(new URL("../review-ui/orphan-deletion-panel.tsx",import.meta.url),"utf8");
  assert.match(source,/\/orphan-readiness/);
  assert.match(source,/recheck\(\)/);
  assert.doesNotMatch(source,/method:"POST"|\/orphan-previews|orphan-confirmations|deleteTask\(|deleteEvent\(|executeDeletion/);
});
