import assert from "node:assert/strict";
import test from "node:test";
import {assessPostWriteRecovery} from "../dist/erasure-postwrite-preview.js";

const enabled="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disabled="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const receipt={operationId:"post-op",phase:"deletionStarted",receiptId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",completedAt:1000};
function fixture() {
  const operation={
    operationId:"post-op",profile:"work",
    target:{taskId:"secret-task-123",eventId:"secret-event-321",deleteCalendar:true},
    selectedActions:{deleteTodoist:true,deleteCalendar:true},
    actionPlan:{todoistTask:{id:"secret-task-123",digest:"a".repeat(64)},
      calendarEvent:{id:"secret-event-321",digest:"b".repeat(64),etag:"etag"},comments:[]},
    lifecycle:{phase:"verify_deletion",mappingIds:[enabled,disabled],enabledMappingIds:[enabled],
      evidence:{deletionStarted:receipt}},
  };
  const preview={
    operationId:"post-op",profile:"work",phase:"verify_deletion",classification:"fully_deleted",
    allowed:false,blockers:["Full deletion needs durable replay/tombstone assurance before restoring admission"],
    mappingStates:[{id:enabled,state:"Enabled",originallyEnabled:true},
      {id:disabled,state:"Disabled",originallyEnabled:false}],
    epoch:4,fenceOwned:true,leaseCount:0,providerItemsAbsent:true,stateRowsAbsent:true,
    operationFingerprint:"123",
  };
  return {operation,preview};
}
test("fully deleted evidence is a candidate only; review cannot release or restore admission",()=>{
  const {operation,preview}=fixture();
  const result=assessPostWriteRecovery(operation,preview);
  assert.equal(result.classification,"fully_deleted_candidate");
  assert.equal(result.releaseAllowed,false);
  assert.equal(result.onlyAvailableAction,"keep_fenced");
  assert.equal(result.potentialDisposition,"independent_full_deletion_verification");
  assert.deepEqual(result.evidence,{
    originalProviderWriteIndicated:true,originalCalendarDeletionSelected:true,
    exactTodoistAndCalendarTargetsRecorded:true,matchingFence:true,epochVerified:true,
    leasesDrained:true,providersAbsent:true,stateRowsAbsent:true,
    mappingStateCount:2,workerMappingsRestored:true,
  });
  const serialized=JSON.stringify(result);
  for(const secret of [operation.target.taskId,operation.target.eventId,enabled,disabled])
    assert.equal(serialized.includes(secret),false,"No erased provider or mapping IDs in the response");
  assert.ok(result.blockers.some(x=>x.includes("old-Lambda")));
});
test("partial deletion always remains fenced for new authorization",()=>{
  for(const change of [
    x=>{x.preview.classification="partial_or_ambiguous";x.preview.providerItemsAbsent=false;},
    x=>{x.preview.stateRowsAbsent=false;},
    x=>{x.preview.classification="partial_or_ambiguous";x.preview.blockers.push("Provider readback mismatch");},
    x=>{x.preview.mappingStates[0].state="Disabled";},
    x=>{x.preview.fenceOwned=false;},
    x=>{x.preview.leaseCount=1;},
    x=>{x.preview.epoch=undefined;},
  ]){
    const input=fixture();change(input);
    const result=assessPostWriteRecovery(input.operation,input.preview);
    assert.equal(result.releaseAllowed,false);
    assert.ok(result.blockers.length);
    if(!input.preview.providerItemsAbsent||!input.preview.stateRowsAbsent
      ||input.preview.classification==="partial_or_ambiguous") {
      assert.equal(result.classification,"partial_or_ambiguous");
      assert.equal(result.potentialDisposition,"new_reviewed_deletion_authorization");
    }
  }
});
test("pre-write or incomplete original authorisation never becomes a full deletion candidate",()=>{
  for(const change of [
    x=>{x.operation.lifecycle.phase="wait_worker_timeout";x.operation.lifecycle.evidence={};},
    x=>{x.operation.selectedActions.deleteCalendar=false;},
    x=>{x.operation.selectedActions.deleteTodoist=false;},
    x=>{x.operation.target.deleteCalendar=false;},
    x=>{delete x.operation.target.eventId;},
    x=>{delete x.operation.actionPlan.todoistTask;},
    x=>{delete x.operation.actionPlan.calendarEvent;},
    x=>{x.operation.actionPlan.calendarEvent.id="different-event";},
  ]){
    const input=fixture();change(input);
    const result=assessPostWriteRecovery(input.operation,input.preview);
    assert.notEqual(result.classification,"fully_deleted_candidate");
    assert.equal(result.releaseAllowed,false);
    assert.ok(result.blockers.length>0);
  }
});
test("original operation/provider IDs are not returned even on failed evidence",()=>{
  const input=fixture();
  input.preview.classification="partial_or_ambiguous";
  input.preview.blockers=["Unrelated validation blocked"];
  const result=assessPostWriteRecovery(input.operation,input.preview);
  const output=JSON.stringify(result);
  assert.equal(output.includes("secret-task"),false);
  assert.equal(output.includes("secret-event"),false);
  assert.equal(output.includes(enabled),false);
});

test("scoped known-identity assessment does not require a signed global Calendar inventory",()=>{
  const {operation,preview}=fixture();
  preview.classification="partial_or_ambiguous";
  preview.providerItemsAbsent=false; // global provenance is unproven
  preview.snapshotSafetyBlockerCount=0;
  preview.knownTargetReadback={todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"};
  const result=assessPostWriteRecovery(operation,preview);
  assert.equal(result.knownIdentity.status,"known_identity_deleted");
  assert.equal(result.knownIdentity.scope,"recorded_original_targets_in_configured_profile");
  assert.equal(result.classification,"partial_or_ambiguous");
  assert.equal(result.knownIdentity.releaseAllowed,false);
  assert.equal(result.releaseAllowed,false);
  assert.equal(result.onlyAvailableAction,"keep_fenced");
  assert.ok(result.blockers.some(x=>x.includes("not proof of global Calendar erasure")));
});
test("scoped absence refuses unknown, surviving, stale or conflicting evidence",()=>{
  const variations=[
    x=>{x.preview.knownTargetReadback.todoist="present";},
    x=>{x.preview.knownTargetReadback.calendar="unknown";},
    x=>{x.preview.knownTargetReadback.configuredCalendarLink="present";},
    x=>{x.preview.snapshotSafetyBlockerCount=1;},
    x=>{x.preview.stateRowsAbsent=false;},
    x=>{x.preview.fenceOwned=false;},
    x=>{x.preview.leaseCount=1;},
    x=>{x.operation.lifecycle.evidence={};},
    x=>{x.operation.actionPlan.calendarEvent.id="other-target";},
  ];
  for(const change of variations){
    const x=fixture();
    x.preview.snapshotSafetyBlockerCount=0;
    x.preview.knownTargetReadback={todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"};
    x.preview.providerItemsAbsent=false;
    change(x);
    const result=assessPostWriteRecovery(x.operation,x.preview);
    assert.equal(result.knownIdentity.status,"partial_or_ambiguous");
    assert.equal(result.releaseAllowed,false);
  }
});
test("optional global Calendar evidence does not change the bounded known-target outcome",()=>{
  const x=fixture();
  x.preview.classification="partial_or_ambiguous";
  x.preview.providerItemsAbsent=false;
  x.preview.snapshotSafetyBlockerCount=0;
  x.preview.knownTargetReadback={todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"};
  x.preview.crossProfileEvidence={profiles:{home:{taskReadsFound:1}},missingProof:["Unrecorded Calendar copies remain outside scope"]};
  const result=assessPostWriteRecovery(x.operation,x.preview);
  assert.equal(result.knownIdentity.status,"known_identity_deleted");
  assert.equal(result.releaseAllowed,false);
  assert.ok(result.blockers.some(item=>item.includes("not proof of global Calendar erasure")));
  assert.ok(!result.blockers.some(item=>item.includes("Unrecorded Calendar copies")));
});
test("scoped outcome is not post-write without an original deletion receipt",()=>{
  const x=fixture();
  x.operation.lifecycle.phase="wait_worker_timeout";
  x.operation.lifecycle.evidence={};
  x.preview.snapshotSafetyBlockerCount=0;
  x.preview.knownTargetReadback={todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"};
  assert.equal(assessPostWriteRecovery(x.operation,x.preview).knownIdentity.status,"not_post_write");
});
