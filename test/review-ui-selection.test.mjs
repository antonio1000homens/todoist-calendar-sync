import assert from "node:assert/strict";
import test from "node:test";
import { emptyRepairSelection, reconcileRepairSelection, editRepairSelection, repairPreviewAllowed } from "../review-ui/repair-selection.mjs";

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
