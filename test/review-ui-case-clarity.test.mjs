import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { providerLink } from "../review-ui/item-identity.mjs";
import { claimHistoricalCleanup, cleanupSelectionIsCurrent } from "../review-ui/historical-cleanup-flow.mjs";
import { calendarReviewSnapshot } from "./helpers/review-provider-snapshot.mjs";
import { caseUrl, caseIdentityState, recordedProviderState, dispositionGuidance, snapshotRelationship, groupAffectedSnapshots, providerSnapshotLink } from "../review-ui/case-url.mjs";

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

test("historical cleanup fence result says no cleanup started and deep-links to the exact erasure operation",async()=>{
  const source=await readFile(new URL("../review-ui/main.tsx",import.meta.url),"utf8");
  const recovery=await readFile(new URL("../review-ui/erasure-recovery-panel.tsx",import.meta.url),"utf8");
  assert.match(source,/No Todoist, Calendar, or DynamoDB cleanup was performed by this attempt/);
  assert.match(source,/Blocked — cleanup not started/);
  assert.match(source,/Open erasure operation and recovery status/);
  assert.match(recovery,/get\("erasureOperation"\)/);
  assert.match(recovery,/lookup\(\)/);
  assert.match(recovery,/initialOperationId===id&&!result\.operation\?\.postWriteCompletion/);
  assert.match(recovery,/Automatic post-write completion is eligible/);
  assert.match(recovery,/does not confirm a worker is currently running/);
  assert.match(recovery,/active fence by itself does not establish eligibility/);
  assert.match(recovery,/Automatic post-write completion is blocked/);
});

test("historical cleanup suppresses duplicate clicks and stale selection responses",()=>{
  const locks=new Set();
  assert.equal(claimHistoricalCleanup(locks,"historic-cleanup:work:case-1"),true);
  assert.equal(claimHistoricalCleanup(locks,"historic-cleanup:work:case-1"),false);
  assert.equal(cleanupSelectionIsCurrent(7,7),true);
  assert.equal(cleanupSelectionIsCurrent(7,8),false);
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

test("review Calendar evidence distinguishes confirmed, cancelled, missing and unverified snapshots", async () => {
  const eventId = "4qqousburkrnq07abcq9chu8dg";
  const item = { eventId };
  const live = calendarReviewSnapshot(eventId, "2027-03-01", {
    htmlLink: "https://calendar.google.com/calendar/event?eid=obsolete",
  });
  const cases = [
    {
      name: "confirmed",
      snapshots: [live],
      state: "verified live",
      verifiedIds: [eventId],
    },
    {
      name: "cancelled",
      snapshots: [{ ...live, object: { ...live.object, status: "cancelled" } }],
      state: "cancelled / deleted in Google Calendar",
      verifiedIds: [],
    },
    {
      name: "missing",
      snapshots: [{ ...live, object: null }],
      state: "missing (404/410)",
      verifiedIds: [],
    },
    {
      name: "unknown",
      snapshots: [],
      state: "candidate / unverified",
      verifiedIds: [],
    },
    {
      name: "mismatched identity",
      snapshots: [{ ...live, object: { ...live.object, id: "another-id" } }],
      state: "identity mismatch / unverified",
      verifiedIds: [],
    },
  ];
  for (const { name, snapshots, state, verifiedIds } of cases) {
    assert.deepEqual(caseIdentityState(item, snapshots).verifiedEventIds, verifiedIds, name);
    assert.equal(recordedProviderState("calendar", eventId, snapshots, "home"), state, name);
  }

  // case-url deliberately re-exports the same policy tested with statuses,
  // deleted Todoist objects and unsafe URLs in review-ui-identity.test.mjs.
  // Do not duplicate its full URL matrix here.
  assert.strictEqual(providerSnapshotLink, providerLink);

  // Keep one review-page wiring/copy guard: a cancelled event must not be
  // displayed as an active Google Calendar event or linked unconditionally.
  const source = await readFile(new URL("../review-ui/main.tsx", import.meta.url), "utf8");
  assert.match(source, /Cancelled \/ deleted in Google Calendar/);
  assert.match(source, /providerLink\(item,sideName\)/);
});
