import assert from "node:assert/strict";
import test from "node:test";
import { emptyRepairSelection, reconcileRepairSelection, editRepairSelection, repairPreviewAllowed, missingDispositionReference, repairRecurrenceOwnerRequirement, repairValidationField } from "../review-ui/repair-selection.mjs";

const caseFor = (id, profile, taskId, eventId) =>
  ({ id, profile, taskId, eventId, decision:{context:{}}, status:"open" });
const live = (profile, side, id, extra = {}) =>
  ({ref:{profile,side,id},object:{id,...extra}});
const detailsFor = (item, snapshots) => ({item,snapshots});
const first = caseFor("one","home","task-old","event-old");
const second = caseFor("two","home","task-new","event-new");
const secondSnapshots = [live("home","todoist","task-new"),live("home","calendar","event-new")];

test("switching conflicts cannot retain verified IDs from the preceding case", () => {
  const old = reconcileRepairSelection(first, [live("home","todoist","task-old"),live("home","calendar","event-old")], emptyRepairSelection(first));
  assert.equal(repairPreviewAllowed(old,first,detailsFor(first,[]),"link"),true);
  const cleared=emptyRepairSelection(second);
  assert.deepEqual([cleared.taskId,cleared.eventId],["",""]);
  assert.equal(repairPreviewAllowed(old,second,detailsFor(second,secondSnapshots),"link"),false);
  assert.equal(repairPreviewAllowed(cleared,second,detailsFor(second,secondSnapshots),"link"),false);
  const updated=reconcileRepairSelection(second,secondSnapshots,old);
  assert.deepEqual([updated.taskId,updated.eventId],["task-new","event-new"]);
  assert.equal(repairPreviewAllowed(updated,second,detailsFor(second,secondSnapshots),"link"),true);
  assert.equal(repairPreviewAllowed(updated,first,detailsFor(first,[]),"link"),false);
});

test("unique current provider items replace unresolved historical case hints", () => {
  const item=caseFor("case","antonio","stale-task","stale-event");
  const snapshots=[live("antonio","todoist","current-task"),live("antonio","calendar","current-event")];
  const form=reconcileRepairSelection(item,snapshots,emptyRepairSelection(item));
  assert.deepEqual([form.taskId,form.eventId],["current-task","current-event"]);
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"verify"),true);
});

test("ambiguous or missing live IDs fail closed instead of choosing a random linked item", () => {
  const item=caseFor("case","work",undefined,undefined);
  const snapshots=[live("work","todoist","a"),live("work","todoist","b"),live("work","calendar","c")];
  const form=reconcileRepairSelection(item,snapshots,emptyRepairSelection(item));
  assert.deepEqual([form.taskId,form.eventId],["","c"]);
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link"),false);
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"create"),true);
  assert.equal(repairPreviewAllowed(form,item,undefined,"create"),false);
});

test("cancelled Calendar objects and cross-profile snapshots are not auto-confirmed", () => {
  const item=caseFor("case","home",undefined,undefined);
  const form=reconcileRepairSelection(item,[live("antonio","todoist","wrong"),live("home","calendar","cancelled",{status:"cancelled"})],emptyRepairSelection(item));
  assert.deepEqual([form.taskId,form.eventId],["",""]);
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,[]),"exclude"),false);
});

test("manual typed IDs stay unverified until they appear in a subsequent live refresh", () => {
  const item=caseFor("case","home","task","event");
  const base=reconcileRepairSelection(item,[live("home","todoist","task"),live("home","calendar","event")],emptyRepairSelection(item));
  const typed=editRepairSelection(base,"todoist","replacement");
  assert.equal(repairPreviewAllowed(typed,item,detailsFor(item,[]),"link"),false);
  const checked=reconcileRepairSelection(item,[live("home","todoist","replacement"),live("home","calendar","event")],typed);
  assert.equal(checked.verifiedTaskId,"replacement");
  assert.equal(repairPreviewAllowed(checked,item,detailsFor(item,[]),"link"),true);
  const gone=reconcileRepairSelection(item,[live("home","calendar","event")],checked);
  assert.equal(gone.verifiedTaskId,"");
  assert.equal(gone.taskId,"");
  assert.equal(repairPreviewAllowed(gone,item,detailsFor(item,[]),"link"),false);
});

test("explicit clearing for one-sided Create survives refresh and other actions need verified IDs", () => {
  const item=caseFor("case","home","task","event");
  const base=reconcileRepairSelection(item,[live("home","todoist","task"),live("home","calendar","event")],emptyRepairSelection(item));
  const create=editRepairSelection(base,"calendar","");
  const refreshed=reconcileRepairSelection(item,[live("home","todoist","task"),live("home","calendar","event")],create);
  assert.equal(refreshed.eventId,"");
  assert.equal(repairPreviewAllowed(refreshed,item,detailsFor(item,[]),"create"),true);
  assert.equal(repairPreviewAllowed(refreshed,item,detailsFor(item,[]),"link"),false);
  assert.equal(repairPreviewAllowed(refreshed,item,detailsFor(item,[]),"decision",""),false);
  assert.equal(repairPreviewAllowed(base,item,detailsFor(item,[]),"create"),false);
});

test("search selection is confirmed explicitly but only for the current case", () => {
  const item=caseFor("case","work",undefined,undefined);
  const base=emptyRepairSelection(item);
  const selected=editRepairSelection(base,"todoist","search-result",true);
  assert.equal(repairPreviewAllowed(selected,item,detailsFor(item,[]),"move"),true);
  assert.equal(repairPreviewAllowed(selected,caseFor("other","work"),detailsFor(item,[]),"move"),false);
  const refreshed=reconcileRepairSelection(item,[live("work","todoist","search-result")],selected);
  assert.equal(refreshed.verifiedTaskId,"search-result");
});

test("a missing Todoist or Calendar disposition triggers an affected-items refresh", () => {
  assert.equal(missingDispositionReference("Choose Create counterpart or Exclude for home:todoist:duplicate"),"home:todoist:duplicate");
  assert.equal(missingDispositionReference("Choose Create counterpart or Exclude for work:calendar:master_20270301"),"work:calendar:master_20270301");
  assert.equal(missingDispositionReference("Mapping does not match the selected pair"),undefined);
  assert.equal(missingDispositionReference("Choose Create counterpart or Exclude for home:calendar:"),undefined);
});


test("recurring Calendar occurrence requires an explicit owner for link preview", () => {
  const item=caseFor("recurring-case","work","task","occurrence");
  const snapshots=[live("work","todoist","task"),live("work","calendar","occurrence",{recurringEventId:"series-master"})];
  const form=reconcileRepairSelection(item,snapshots,emptyRepairSelection(item));
  for(const scope of ["occurrence","series"]) {
    // The form gate is also enforced when scope is changed; the API validates
    // whether the chosen occurrence can be used for that scope.
    assert.equal(repairRecurrenceOwnerRequirement(form,detailsFor(item,snapshots),"link"),"calendar-occurrence");
    assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link",undefined,""),false,scope);
    for(const owner of ["todoist","calendar"])
      assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link",undefined,owner),true,`${scope} / ${owner}`);
  }
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"verify",undefined,""),true);
});

test("recurring Calendar series and counterpart creation require Calendar owner selection", () => {
  const item=caseFor("series-case","home","task","series-master");
  const snapshots=[live("home","todoist","task"),live("home","calendar","series-master",{recurrence:["RRULE:FREQ=WEEKLY"]})];
  const form=reconcileRepairSelection(item,snapshots,emptyRepairSelection(item));
  assert.equal(repairRecurrenceOwnerRequirement(form,detailsFor(item,snapshots),"link"),"calendar-series");
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link",undefined,""),false);
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link",undefined,"calendar"),true);
  const fromCalendar=editRepairSelection(form,"todoist","");
  assert.equal(repairRecurrenceOwnerRequirement(fromCalendar,detailsFor(item,snapshots),"create"),"calendar-series");
  assert.equal(repairPreviewAllowed(fromCalendar,item,detailsFor(item,snapshots),"create",undefined,""),false);
  assert.equal(repairPreviewAllowed(fromCalendar,item,detailsFor(item,snapshots),"create",undefined,"calendar"),true);
  assert.equal(repairRecurrenceOwnerRequirement(form,detailsFor(item,snapshots),"create"),undefined);
});

test("recurring Todoist task requires an owner for linking, but unrelated cases are unaffected", () => {
  const item=caseFor("task-repeats","antonio","task","standalone");
  const snapshots=[live("antonio","todoist","task",{due:{is_recurring:true,string:"every week"}}),live("antonio","calendar","standalone")];
  const form=reconcileRepairSelection(item,snapshots,emptyRepairSelection(item));
  assert.equal(repairRecurrenceOwnerRequirement(form,detailsFor(item,snapshots),"link"),"todoist-task");
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link",undefined,""),false);
  assert.equal(repairPreviewAllowed(form,item,detailsFor(item,snapshots),"link",undefined,"todoist"),true);
  const unrelated=caseFor("unrelated","antonio","task","standalone");
  assert.equal(repairRecurrenceOwnerRequirement(form,detailsFor(unrelated,snapshots),"link"),undefined);
  assert.equal(repairPreviewAllowed(form,unrelated,detailsFor(unrelated,snapshots),"link",undefined,"todoist"),false);
});

test("recurrence validation errors are routed to nearby controls", () => {
  assert.equal(repairValidationField("Choose which provider owns the recurrence for this Calendar occurrence"),"owner");
  assert.equal(repairValidationField("Creating a counterpart for a Calendar series requires Calendar recurrence ownership"),"owner");
  assert.equal(repairValidationField("Changing a Calendar series to Todoist ownership requires a future-only preview"),"scope");
  assert.equal(repairValidationField("Fields differ: choose Todoist or Calendar as the source"),"winner");
  assert.equal(repairValidationField("Calendar repair sources must be confirmed; choose a live event"),"eventId");
  assert.equal(repairValidationField("Unexpected failure"),undefined);
});
