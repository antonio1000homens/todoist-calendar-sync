import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectRecordedProjectTombstone,inspectRecoveryComparisons,
} from "../dist/erasure-recovery-inspection.js";
import {serializeDeletionTombstoneComment} from "../dist/mapping-comments.js";

const profile="work",projectId="work-project",taskId="private-task",eventId="private-event";
const commentId="private-recorded-comment";
const at=Date.parse("2026-11-10T12:00:00.000Z");
const marker={
  schemaVersion:1,profile,projectId,taskId,eventIds:[eventId],
  createdAt:new Date(at).toISOString(),
  expiresAt:new Date(at+18*24*60*60_000).toISOString(),
};
const expectation={profile,projectId,taskId,commentIds:[commentId],eventIds:[eventId]};
const comment=(payload=marker)=>({
  id:commentId,project_id:projectId,content:serializeDeletionTombstoneComment(payload),
});

test("exact recorded project tombstone is present only when active marker matches all recorded identities",()=>{
  const seen=inspectRecordedProjectTombstone([comment()],expectation,at+5_000);
  assert.equal(seen.status,"present");
  assert.equal(seen.recordedCommentFound,true);
  assert.equal(seen.markerMatchesTaskAndCalendar,true);
  assert.equal(seen.recordedCommentCount,1);
  const text=JSON.stringify(seen);
  for(const secret of [profile,projectId,taskId,eventId,commentId,marker.createdAt,marker.expiresAt])
    assert.ok(!text.includes(secret),"privacy-safe report cannot expose provider identities or timestamps");
});

test("missing exact comment does not accept a different matching marker",()=>{
  const seen=inspectRecordedProjectTombstone([{...comment(),id:"other-comment"}],expectation,at+5_000);
  assert.equal(seen.status,"missing");
  assert.equal(seen.recordedCommentFound,false);
  assert.equal(seen.markerMatchesTaskAndCalendar,null);
});

test("altered, malformed, expired, duplicate and partial comment reads are ambiguous",()=>{
  const changed={...comment(),content:"user changed this comment"};
  const wrongTask=comment({...marker,taskId:"other-task"});
  const wrongEvents=comment({...marker,eventIds:["different-event"]});
  const expired=comment();
  for(const value of [changed,wrongTask,wrongEvents,expired]) {
    const result=inspectRecordedProjectTombstone([value],expectation,
      value===expired?at+18*24*60*60_000+1:at+5_000);
    assert.equal(result.status,"ambiguous");
    assert.equal(result.markerMatchesTaskAndCalendar,false);
  }
  assert.equal(inspectRecordedProjectTombstone([comment(),comment()],expectation,at+5_000).status,"ambiguous");
  assert.equal(inspectRecordedProjectTombstone([comment()],
    {...expectation,commentIds:[commentId,"missing-second"]},at+5_000).status,"ambiguous");
  assert.equal(inspectRecordedProjectTombstone([comment()],
    {...expectation,commentIds:[]},at+5_000).status,"not_checked");
});

function sample(stage="verify") {
  const row={type:"TASK",key:{pk:"TASK#private",sk:"STATE"},digest:"a".repeat(64),
    classification:"selected-only"};
  const actionPlan={
    todoistTask:{id:taskId,digest:"b".repeat(64)},
    calendarEvent:{id:eventId,calendarId:"private-calendar",digest:"c".repeat(64),etag:"v1"},
    comments:[{id:commentId,kind:"project",digest:"d".repeat(64)}],
    projectCommentIds:[commentId],
    knownCalendarAliases:[{profile,calendarId:"private-calendar",eventId}],
    knownCalendarAliasesComplete:true,
  };
  const operation={profile,target:{taskId,eventId,deleteCalendar:true},
    selectedActions:{deleteTodoist:true,deleteCalendar:true},
    actionPlan,inventory:[row],lifecycle:{phase:"delete",deletionProgress:{
      stage,commentIndex:1,stateIndex:1,startedAt:at},evidence:{deletionStarted:{}}}};
  const snapshot={actionPlan:{comments:[],projectCommentIds:[],knownCalendarAliases:[],
      knownCalendarAliasesComplete:true},inventory:[],knownTargetReadback:{
      todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"},
    blockers:[],crossProfileEvidence:{
      allProfilesQueried:true,stateScan:{allPagesReceived:true,stronglyConsistent:true}}};
  return {operation,snapshot};
}

test("durably progressed deletion identifies expected provider, comment, alias, state removals",()=>{
  const {operation,snapshot}=sample();
  const details=inspectRecoveryComparisons(operation,snapshot);
  for(const [key,value] of Object.entries(details)) {
    assert.equal(value.result,"expected_lifecycle_change",key);
    assert.ok(value.expected.length&&value.observed.length&&value.explanation.length,key);
  }
  const serialized=JSON.stringify(details);
  for(const secret of [projectId,taskId,eventId,commentId,"private-calendar","TASK#private","a".repeat(64)])
    assert.ok(!serialized.includes(secret),"comparison summaries cannot include IDs or hashes");
});

test("unproven provider disappearance before deletion checkpoint is not expected",()=>{
  const {operation,snapshot}=sample("comments");
  const details=inspectRecoveryComparisons(operation,snapshot);
  assert.equal(details.todoistTask.result,"unexpected_drift");
  assert.equal(details.calendarEvent.result,"unexpected_drift");
  assert.equal(details.comments.result,"unexpected_drift");
  assert.equal(details.projectCommentIds.result,"unexpected_drift");
  assert.equal(details.stateInventory.result,"unexpected_drift");
});

test("partial provider/state audit never converts alias or state loss into expected deletion",()=>{
  const {operation,snapshot}=sample();
  snapshot.crossProfileEvidence.allProfilesQueried=false;
  snapshot.crossProfileEvidence.stateScan.allPagesReceived=false;
  const details=inspectRecoveryComparisons(operation,snapshot);
  assert.equal(details.calendarAliases.result,"missing_evidence");
  assert.equal(details.stateInventory.result,"missing_evidence");
  delete snapshot.knownTargetReadback;
  const missing=inspectRecoveryComparisons(operation,snapshot);
  assert.equal(missing.todoistTask.result,"missing_evidence");
  assert.equal(missing.calendarEvent.result,"missing_evidence");
});

test("new Calendar aliases and unrelated DynamoDB rows remain unexpected drift after deletion",()=>{
  const {operation,snapshot}=sample();
  snapshot.actionPlan.knownCalendarAliases=[{profile,calendarId:"private-calendar",eventId:"new-unknown"}];
  snapshot.inventory=[{type:"TASK",key:{pk:"TASK#unrelated",sk:"STATE"},
    digest:"f".repeat(64),classification:"selected-only"}];
  const details=inspectRecoveryComparisons(operation,snapshot);
  assert.equal(details.calendarAliases.result,"unexpected_drift");
  assert.equal(details.stateInventory.result,"unexpected_drift");
});

test("unchanged pre-write expectations remain unchanged and cannot imply a tombstone was inspected",()=>{
  const {operation,snapshot}=sample("comments");
  snapshot.actionPlan=structuredClone(operation.actionPlan);
  snapshot.inventory=structuredClone(operation.inventory);
  snapshot.knownTargetReadback={todoist:"present",calendar:"present",configuredCalendarLink:"present"};
  const details=inspectRecoveryComparisons(operation,snapshot);
  for(const value of Object.values(details))assert.equal(value.result,"unchanged");
});
