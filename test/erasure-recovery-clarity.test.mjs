import test from "node:test";
import assert from "node:assert/strict";
import {
  recoveryClassificationExplanation,recoveryDiagnosticRows,recoveryExecutionSummary,
  workerMappingSummary,originalInventoryExplanation,
  recoveryComparisonRows,recoveryTombstoneStatus,recoveryIndependentGuard,recoveryNextSafeAction,
} from "../review-ui/erasure-recovery-explanations.mjs";

const allVerified=Object.fromEntries([
  "lifecycle","originalConfirmation","audit","freshPreview","originalProviderSnapshot",
  "operationFingerprint","snapshotBlockers","todoistTask","calendarEvent","comments",
  "projectCommentIds","calendarAliases","stateInventory","fence","epoch",
  "mappingInventory","mappingStates","workerLeases",
].map(key=>[key,"verified"]));

test("eligible pre-write inspection labels mappings and does not imply execution",()=>{
  const preview={allowed:true,classification:"pre_write",diagnostics:allVerified,
    mappingStates:[{state:"Disabled"},{state:"Disabled"}]};
  assert.match(recoveryClassificationExplanation(preview),/Verified pre-write/);
  assert.equal(workerMappingSummary(preview),"disabled");
  assert.equal(recoveryExecutionSummary(undefined,true),"not started (per operation record)");
  assert.equal(recoveryDiagnosticRows(preview).length,18);
  assert.ok(recoveryDiagnosticRows(preview).every(check=>check.status==="verified"));
});

test("blocked pre-write snapshot drift explicitly does not prove deletion",()=>{
  const preview={allowed:false,classification:"partial_or_ambiguous",
    diagnostics:{...allVerified,originalProviderSnapshot:"mismatched",
      operationFingerprint:"mismatched",todoistTask:"mismatched"},
    providerItemsAbsent:false,stateRowsAbsent:false};
  assert.match(recoveryClassificationExplanation(preview),/does not prove deletion occurred/);
  const mismatches=recoveryDiagnosticRows(preview).filter(check=>check.status==="mismatched");
  assert.deepEqual(mismatches.map(check=>check.key),
    ["originalProviderSnapshot","operationFingerprint","todoistTask"]);
  assert.match(originalInventoryExplanation,/normal before deletion/);
  assert.match(originalInventoryExplanation,/not a standalone pre-write blocker/);
});

test("missing fence, epoch or mapping data are not silently marked as mismatched",()=>{
  const preview={diagnostics:{...allVerified,fence:"missing",epoch:"missing",
    mappingInventory:"missing",workerLeases:"verified"},mappingStates:[]};
  const diagnostics=Object.fromEntries(recoveryDiagnosticRows(preview).map(item=>[item.key,item.status]));
  assert.equal(diagnostics.fence,"missing");
  assert.equal(diagnostics.epoch,"missing");
  assert.equal(diagnostics.mappingInventory,"missing");
  assert.equal(diagnostics.workerLeases,"verified");
  assert.match(workerMappingSummary(preview),/unknown/);
  assert.equal(workerMappingSummary(undefined),"unknown (not inspected)");
});

test("genuine post-write ambiguity must not be described as a safe pre-write recovery",()=>{
  const preview={allowed:false,classification:"partial_or_ambiguous",
    diagnostics:{...allVerified,lifecycle:"mismatched"}};
  assert.doesNotMatch(recoveryClassificationExplanation(preview),/Verified pre-write/);
  assert.match(recoveryClassificationExplanation(preview),/fail-closed/);
  assert.equal(recoveryExecutionSummary("verifying",true),"verifying");
  assert.match(recoveryExecutionSummary("review_required",true),/review required/);
});

test("older API responses display unavailable rather than inventing diagnostic outcomes",()=>{
  assert.equal(recoveryDiagnosticRows({}).length,18);
  assert.ok(recoveryDiagnosticRows({}).every(item=>item.status==="unavailable"));
  assert.match(recoveryClassificationExplanation({allowed:false,classification:"fully_deleted"}),/does not authorise sync restoration/);
});


test("UI separates checkpoint-consistent removal from real drift and shows safe next action",()=>{
  const preview={allowed:false,classification:"partial_or_ambiguous",
    diagnostics:{...allVerified,comments:"mismatched",projectCommentIds:"mismatched",
      stateInventory:"mismatched",calendarAliases:"mismatched"},
    comparisonDetails:{
      comments:{expected:"1 comment",observed:"0 mapping comments",
        result:"expected_lifecycle_change",explanation:"Converted after checkpoint"},
      projectCommentIds:{expected:"1 mapping",observed:"0 mappings",
        result:"expected_lifecycle_change",explanation:"Original comment retained as tombstone"},
      stateInventory:{expected:"1 state row",observed:"2 state rows",
        result:"unexpected_drift",explanation:"Unrelated row appeared"},
      calendarAliases:{expected:"1 alias",observed:"unknown",
        result:"missing_evidence",explanation:"Partial provider audit"},
    },
    projectTombstone:{status:"ambiguous",recordedCommentFound:true,
      markerMatchesTaskAndCalendar:false,
      explanation:"Recorded comment was altered"},
  };
  const rows=recoveryDiagnosticRows(preview);
  assert.equal(rows.find(item=>item.key==="comments").status,"expected_lifecycle_change");
  assert.equal(rows.find(item=>item.key==="stateInventory").status,"unexpected_drift");
  assert.equal(recoveryComparisonRows(preview).length,4);
  assert.equal(recoveryTombstoneStatus(preview).status,"ambiguous");
  assert.match(recoveryNextSafeAction(preview),/Keep the fence/);
  assert.match(recoveryIndependentGuard(preview),/Strict recovery is blocked/);
});

test("UI identifies unverified fence independent of a matching tombstone",()=>{
  const preview={allowed:false,classification:"pre_write",
    diagnostics:{...allVerified,fence:"missing"},projectTombstone:{status:"present",
      recordedCommentFound:true,markerMatchesTaskAndCalendar:true,
      explanation:"Exact 18-day marker found"}};
  assert.match(recoveryIndependentGuard(preview),/fence is not verified/);
  assert.equal(recoveryTombstoneStatus(preview).status,"present");
  assert.equal(recoveryTombstoneStatus({}).status,"not_checked");
  assert.match(recoveryNextSafeAction(preview),/Do not release the fence/);
});
