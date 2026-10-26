import test from "node:test";
import assert from "node:assert/strict";
import {
  backupNotice, erasureCanStart, erasureConfirmationReady,
  erasurePreviewMatchesSelection, profileOptions,
} from "../review-ui/erasure-policy.mjs";

const selection={profile:"work",taskId:"12345",eventId:"evt-123",deleteCalendar:true};
const preview={
  operationId:"sample-operation", profile:"work", target:{taskId:"12345",eventId:"evt-123"},
  selectedActions:{deleteTodoist:true,deleteCalendar:true},
  blockers:[],executionEnabled:true,
  confirmation:{confirmationId:"single-use",expiresAt:Date.now()+120_000},
};
const typed={phrase:"PERMANENTLY ERASE",taskId:"12345",eventId:"evt-123"};

test("erasure UI explicitly supports work profile and discloses backup retention",()=>{
  assert.ok(profileOptions.includes("work"));
  assert.match(backupNotice,/35 days/);
});

test("exact preview identity binds profile, provider IDs and separately selected Calendar action",()=>{
  assert.equal(erasurePreviewMatchesSelection(preview,selection),true);
  for(const changed of [
    {profile:"home"},{profile:"antonio"},{taskId:"12346"},
    {eventId:"evt-124"},{deleteCalendar:false},
  ]){
    assert.equal(erasurePreviewMatchesSelection(preview,{...selection,...changed}),false);
  }
  assert.equal(erasurePreviewMatchesSelection({...preview,selectedActions:{deleteTodoist:false,deleteCalendar:true}},selection),false);
});

test("erasure confirmation is exact, fresh, explicitly typed, and disabled on blockers or deployment off",()=>{
  assert.equal(erasureConfirmationReady(preview,selection,typed),true);
  for(const change of [{phrase:"erase"},{taskId:"12346"},{eventId:"evt-124"}])
    assert.equal(erasureConfirmationReady(preview,selection,{...typed,...change}),false);
  assert.equal(erasureConfirmationReady({...preview,blockers:["shared mapping"]},selection,typed),false);
  assert.equal(erasureConfirmationReady({...preview,executionEnabled:false},selection,typed),false);
  assert.equal(erasureConfirmationReady({...preview,confirmation:{...preview.confirmation,expiresAt:Date.now()-1}},selection,typed),false);
  assert.equal(erasureConfirmationReady({...preview,confirmation:undefined},selection,typed),false);
});

test("the UI starts only a prepared operation with persisted readiness and queue permission",()=>{
  assert.equal(erasureCanStart({status:"previewed",providerDeletionReady:true,queueReady:true}),true);
  for(const op of [
    {status:"previewed",providerDeletionReady:false,queueReady:true},
    {status:"previewed",providerDeletionReady:true,queueReady:false},
    {status:"queued",providerDeletionReady:true,queueReady:true},
    {status:"review_required",providerDeletionReady:true,queueReady:true},
  ])assert.equal(erasureCanStart(op),false);
});
