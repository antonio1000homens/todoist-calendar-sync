import assert from "node:assert/strict";
import test from "node:test";
import {assessPostWriteRecovery} from "../dist/erasure-postwrite-preview.js";

const enabled="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disabled="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const receipt={operationId:"post-op",phase:"deletionStarted",
  receiptId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",completedAt:1000};

function fixture() {
  const operation={
    operationId:"post-op",profile:"work",
    target:{taskId:"secret-task-123",eventId:"secret-event-321",deleteCalendar:true},
    selectedActions:{deleteTodoist:true,deleteCalendar:true},
    providerSnapshotFingerprint:"1".repeat(64),inventory:[],
    actionPlan:{
      todoistTask:{id:"secret-task-123",digest:"a".repeat(64)},
      calendarEvent:{id:"secret-event-321",calendarId:"work-calendar",digest:"b".repeat(64),etag:"etag"},
      knownCalendarAliases:[{profile:"work",calendarId:"work-calendar",eventId:"secret-event-321"}],
      knownCalendarAliasesComplete:true,
      projectCommentIds:["project-comment-1"],
      comments:[{id:"project-comment-1",kind:"project",digest:"c".repeat(64)}],
    },
    providerDeletionReady:true,
    lifecycle:{phase:"verify_deletion",mappingIds:[enabled,disabled],enabledMappingIds:[enabled],
      timeoutSeconds:30,pollMs:5000,nextRunAt:0,
      evidence:{deletionStarted:receipt},
      deletionProgress:{stage:"verify",commentIndex:1,stateIndex:0,startedAt:1000}},
  };
  const preview={
    operationId:"post-op",profile:"work",phase:"verify_deletion",classification:"fully_deleted",
    allowed:false,blockers:["Full deletion needs durable replay/tombstone assurance before restoring admission"],
    mappingStates:[{id:enabled,state:"Disabled",originallyEnabled:true},
      {id:disabled,state:"Disabled",originallyEnabled:false}],
    epoch:4,fenceOwned:true,leaseCount:0,providerItemsAbsent:true,stateRowsAbsent:true,
    snapshotSafetyBlockerCount:0,
    knownTargetReadback:{todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"},
    evidenceChecks:{knownCalendarAliasesMatch:true},
    projectTombstone:{status:"present",recordedCommentFound:true,markerMatchesTaskAndCalendar:true,
      recordedCommentCount:1,foundCommentCount:1},
    operationFingerprint:"123",
  };
  return {operation,preview};
}

test("exact known-target absence plus the active tombstone is an automatic completion candidate",()=>{
  const {operation,preview}=fixture();
  const result=assessPostWriteRecovery(operation,preview);
  assert.equal(result.classification,"fully_deleted_candidate");
  assert.equal(result.releaseAllowed,false,"read-only inspection never releases the fence");
  assert.equal(result.completionEligible,true);
  assert.equal(result.onlyAvailableAction,"automatic_completion_pending");
  assert.equal(result.potentialDisposition,"automatic_known_identity_completion");
  assert.deepEqual(result.blockers,[]);
  assert.equal(result.completion.status,"pending");
  assert.equal(result.completion.automatic,true);
  assert.equal(result.completion.tombstoneRetained,true);
  assert.equal(result.completion.providerDeletesReplayed,false);
  assert.deepEqual(result.evidence,{
    originalProviderWriteIndicated:true,originalCalendarDeletionSelected:true,
    exactTodoistAndCalendarTargetsRecorded:true,matchingFence:true,epochVerified:true,
    leasesDrained:true,providersAbsent:true,stateRowsAbsent:true,mappingStateCount:2,
    workerMappingsRestored:false,deletionCheckpointComplete:true,projectTombstonePresent:true,
    knownCalendarAliasesComplete:true,
  });
  const serialized=JSON.stringify(result);
  for(const secret of [operation.target.taskId,operation.target.eventId,enabled,disabled])
    assert.equal(serialized.includes(secret),false,"No erased provider or mapping IDs leave the assessment");
  assert.equal(preview.crossProfileEvidence,undefined,
    "a global Calendar provenance scan is not required for exact recorded targets");
});

test("partial, ambiguous, stale or conflicting evidence remains fenced",()=>{
  const changes=[
    x=>{x.preview.classification="partial_or_ambiguous";x.preview.providerItemsAbsent=false;},
    x=>{x.preview.stateRowsAbsent=false;},
    x=>{x.preview.snapshotSafetyBlockerCount=1;},
    x=>{x.preview.mappingStates[1].state="Enabled";},
    x=>{x.preview.fenceOwned=false;},
    x=>{x.preview.leaseCount=1;},
    x=>{x.preview.epoch=undefined;},
    x=>{x.preview.knownTargetReadback.calendar="present";},
    x=>{x.preview.knownTargetReadback.todoist="unknown";},
    x=>{x.preview.projectTombstone.status="missing";},
    x=>{x.preview.projectTombstone.markerMatchesTaskAndCalendar=false;},
    x=>{x.operation.lifecycle.deletionProgress.stage="todoist";},
    x=>{x.operation.lifecycle.deletionProgress.attempt={startedAt:1000};},
    x=>{x.operation.lifecycle.deletionProgress.commentIndex=0;},
    x=>{x.operation.actionPlan.knownCalendarAliasesComplete=false;},
    x=>{x.operation.actionPlan.projectCommentIds=[];},
  ];
  for(const change of changes){
    const input=fixture();change(input);
    const result=assessPostWriteRecovery(input.operation,input.preview);
    assert.equal(result.releaseAllowed,false);
    assert.equal(result.completionEligible,false);
    assert.ok(result.completionBlockers.length>0);
    assert.equal(result.onlyAvailableAction,"keep_fenced");
  }
});

test("pre-write or incomplete original authorisation never becomes a post-write candidate",()=>{
  const changes=[
    x=>{x.operation.lifecycle.phase="wait_worker_timeout";x.operation.lifecycle.evidence={};x.operation.lifecycle.deletionProgress=undefined;},
    x=>{x.operation.selectedActions.deleteCalendar=false;},
    x=>{x.operation.selectedActions.deleteTodoist=false;},
    x=>{x.operation.target.deleteCalendar=false;},
    x=>{delete x.operation.target.eventId;},
    x=>{delete x.operation.actionPlan.todoistTask;},
    x=>{delete x.operation.actionPlan.calendarEvent;},
    x=>{x.operation.actionPlan.calendarEvent.id="different-event";},
    x=>{x.operation.lifecycle.evidence.deletionStarted.operationId="other-operation";},
  ];
  for(const change of changes){
    const input=fixture();change(input);
    const result=assessPostWriteRecovery(input.operation,input.preview);
    assert.notEqual(result.classification,"fully_deleted_candidate");
    assert.equal(result.releaseAllowed,false);
    assert.ok(result.blockers.length>0);
  }
});

test("known-identity assessment requires the exact project-comment inventory and active tombstone",()=>{
  const input=fixture();
  input.operation.actionPlan.comments=[];
  const result=assessPostWriteRecovery(input.operation,input.preview);
  assert.equal(result.classification,"partial_or_ambiguous");
  assert.equal(result.evidence.projectTombstonePresent,true);
  assert.ok(result.completionBlockers.some(item=>item.includes("project-comment inventory")));
});

test("the scoped candidate does not claim global Calendar erasure",()=>{
  const {operation,preview}=fixture();
  preview.crossProfileEvidence={profiles:{home:{taskReadsFound:1}},
    missingProof:["Unrecorded Calendar copies remain outside scope"]};
  const result=assessPostWriteRecovery(operation,preview);
  assert.equal(result.classification,"fully_deleted_candidate");
  assert.equal(result.completionEligible,true);
  assert.ok(!result.blockers.some(item=>item.includes("Unrecorded Calendar copies")));
});
