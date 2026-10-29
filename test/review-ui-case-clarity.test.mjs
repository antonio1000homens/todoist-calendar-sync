import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { caseUrl, caseIdentityState, dispositionGuidance, snapshotRelationship, groupAffectedSnapshots } from "../review-ui/case-url.mjs";

test("case URL follows case selection and removes stale case parameters",()=>{
  assert.equal(caseUrl("https://example.test/review/?case=old&tab=history","new").href,
    "https://example.test/review/?case=new&tab=history");
  assert.equal(caseUrl("https://example.test/review/?case=old&tab=history",undefined).href,
    "https://example.test/review/?tab=history");
});

test("review case selection writes deep links and browser back/forward reloads the selected case",async()=>{
  const source=await readFile(new URL("../review-ui/main.tsx",import.meta.url),"utf8");
  assert.match(source,/window\.history\.pushState\(null,"",next\)/);
  assert.match(source,/window\.addEventListener\("popstate",onPopState\)/);
  assert.match(source,/new URLSearchParams\(location\.search\)\.get\("case"\)/);
  assert.match(source,/api\(`cases\/\$\{encodeURIComponent\(caseId\)\}`\)\.then\(data=>/);
});

test("required affected-item disposition is shown only after preview validation requests it",async()=>{
  const source=await readFile(new URL("../review-ui/main.tsx",import.meta.url),"utf8");
  assert.match(source,/requiredDispositionRef===key\?"Required by repair preview validation/);
  assert.match(source,/const missingDisposition=missingDispositionReference\(e\.message\)/);
  assert.match(source,/if\(requestVersion===selectionVersion\.current\)setRequiredDispositionRef\(missingDisposition\)/);
});

test("ID-less recurring case evidence remains candidates until live provider identity is verified",()=>{
  const item={taskId:undefined,eventId:undefined,decision:{masterEventId:"master",context:{seriesId:"series",
    candidateTaskIds:["task-a","task-b"],candidateEventIds:["event-a"]}}};
  const state=caseIdentityState(item,[{ref:{side:"todoist",id:"task-a"},object:{id:"task-a"}}]);
  assert.equal(state.hasAnyRecordedIdentity,true);
  assert.deepEqual(state.taskIds,["task-a","task-b"]);
  assert.deepEqual(state.eventIds,["master","event-a"]);
  assert.deepEqual(state.seriesIds,["series"]);
  assert.deepEqual(state.verifiedTaskIds,["task-a"]);
  assert.deepEqual(state.verifiedEventIds,[]);
});

test("no recorded provider identity remains explicitly unverified",()=>{
  const state=caseIdentityState({decision:{context:{}}},[]);
  assert.equal(state.hasAnyRecordedIdentity,false);
  assert.deepEqual(state.verifiedTaskIds,[]);
});

test("cancelled-item dispositions explain no-op and exact-ID exclusion scope",()=>{
  assert.match(dispositionGuidance("unchanged"),/same conflict can return/);
  assert.match(dispositionGuidance("exclude"),/exact provider ID/);
  assert.match(dispositionGuidance("exclude"),/blocked/);
});

test("affected snapshot without provenance is called unknown rather than inferred",()=>{
  assert.match(snapshotRelationship({includedBy:[]})[0],/relationship as unknown/);
  assert.deepEqual(snapshotRelationship({includedBy:["Series master of occurrence"]}),["Series master of occurrence"]);
});

test("cancelled recurrence master and occurrence are grouped without losing exact identities",()=>{
  const snapshots=[
    {ref:{profile:"work",side:"calendar",id:"master"},object:{id:"master",status:"cancelled",recurrence:["RRULE:FREQ=YEARLY"]}},
    {ref:{profile:"work",side:"calendar",id:"master_20270301"},object:{id:"master_20270301",status:"cancelled",recurringEventId:"master"}},
    {ref:{profile:"work",side:"todoist",id:"task"},object:{id:"task"}},
  ];
  const groups=groupAffectedSnapshots(snapshots);
  const series=groups.find(group=>group.masterId==="master");
  assert.deepEqual(series.items.map(item=>item.ref.id),["master","master_20270301"]);
  assert.equal(groups.length,2);
});
