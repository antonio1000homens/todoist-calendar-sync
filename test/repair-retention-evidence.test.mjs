import test from "node:test";
import assert from "node:assert/strict";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { assessRepairRetention, parseRepairRetentionArgs } from "../scripts/repair-retention-evidence.mjs";
import { scanRepairEvidence } from "../scripts/inspect-repair-retention.mjs";

const NOW = Date.parse("2026-11-07T16:00:00Z");
const op = (id,status="failed",extra={}) => ({
  pk:"REPAIR#"+id,sk:"STATE",id,status,updatedAt:"2026-10-28T16:00:00Z",
  notificationPending:false,preview:{id:"preview-"+id,intent:{caseId:"case-"+id,profile:"home"},
    snapshots:[]},steps:{},...extra,
});
const testRows = [
  op("queued","queued"),
  op("notified","failed",{notificationPending:true,abandoned:true}),
  op("written","succeeded",{writeStarted:true}),
  op("stuck","failed",{steps:{validated:{status:"done"},provider:{status:"running"}}}),
  op("unreferenced","failed",{abandoned:true}),
  {pk:"REVIEW_CASE#case-written",sk:"STATE",status:"resolved",operationId:"written"},
  {pk:"SYNC_CONTROL#home:todoist:id-one",sk:"STATE",activeRepair:"stuck"},
  {pk:"SYNC_CONTROL#home:calendar:id-two",sk:"STATE",activeRepair:"stuck"},
  {pk:"REVIEW_CASE#case-stuck",sk:"STATE",status:"dismissed",operationId:"stuck"},
  {pk:"REPAIR_PREVIEW#preview-written",sk:"STATE",submittedOperation:"written"},
];

test("CLI requires an explicit profile and has no deletion mode",()=>{
  assert.throws(()=>parseRepairRetentionArgs(["--apply","--profile=all"]),/Unknown option/);
  assert.throws(()=>parseRepairRetentionArgs([]),/Explicit --profile/);
  assert.throws(()=>parseRepairRetentionArgs(["--profile=all","--max-pages=101"]),/max-pages/);
  assert.deepEqual(parseRepairRetentionArgs(["--profile=home","--max-pages=5"]),
    {profile:"home",maxPages:5});
});

test("classifies blockers and never declares old failed/succeeded records purgeable",()=>{
  const summary=assessRepairRetention(testRows,{profile:"home",nowMs:NOW});
  assert.equal(summary.operationCount,5);
  assert.equal(summary.byStatus.failed,3);
  assert.equal(summary.byStatus.succeeded,1);
  assert.equal(summary.byStatus.queued,1);
  assert.equal(summary.pendingNotification,1);
  assert.equal(summary.recordedWriteEvidence,2);
  assert.equal(summary.activeRepairControlReferences,2);
  assert.equal(summary.currentCaseOwner,2);
  assert.equal(summary.originalPreviewPresent,1);
  assert.equal(summary.originalPreviewExpiredOrMissing,4);
  assert.equal(summary.qualifiedForAutomaticDelete,0);
  assert.equal(summary.unsupportedForDelete,5);
  assert.equal(summary.byReason.failed_may_resume,1);
  assert.equal(summary.byReason.current_case_reference,2);
  assert.equal(summary.byReason.active_repair_control_reference,1);
  assert.equal(summary.byReason.idempotency_and_replay_retention,5);
});

test("only exact typed references count; titles, provider identifiers and foreign profiles are excluded",()=>{
  const rows=[op("a"),{pk:"REVIEW_CASE#case-a",sk:"STATE",title:"a",description:"a"},
    {pk:"SYNC_CONTROL#home:todoist:some-id",sk:"STATE",activeRepair:"different"}];
  const report=assessRepairRetention(rows,{profile:"home",nowMs:NOW});
  assert.equal(report.currentCaseOwner,0);
  assert.equal(report.activeRepairControlReferences,0);
  assert.equal(report.noKnownDbBacklink,1);
  assert.equal(report.qualifiedForAutomaticDelete,0);
  assert.ok(!JSON.stringify(report).includes("some-id"));
  assert.equal(assessRepairRetention(rows,{profile:"work"}).operationCount,0);
});

test("malformed repair records fail conservative classification",()=>{
  const row={pk:"REPAIR#orphan",sk:"STATE",id:"orphan",status:"succeeded",
    updatedAt:"2026-05-01",notificationPending:false,preview:{intent:{profile:"home",caseId:"lost"}}};
  const summary=assessRepairRetention([row],{profile:"home",nowMs:NOW});
  assert.equal(summary.ambiguousOrMalformed,1);
  assert.equal(summary.missingCase,1);
  assert.equal(summary.qualifiedForAutomaticDelete,0);
});

test("bounded scan refuses to classify references if a page remains",async()=>{
  const calls=[];
  const client={async send(command){
    calls.push(command);
    return {Items:testRows.slice(0,3),ScannedCount:100,LastEvaluatedKey:{pk:"more",sk:"STATE"}};
  }};
  const output=await scanRepairEvidence({client,table:"state",options:{profile:"home",maxPages:1},delay:async()=>{}});
  assert.equal(output.scanComplete,false);
  assert.equal(output.operationCount,undefined);
  assert.equal(output.status,"INCOMPLETE_REFERENCE_INVENTORY");
  assert.equal(calls.length,1);
  assert.ok(calls[0] instanceof ScanCommand);
  assert.equal(calls[0].input.ConsistentRead,true);
  assert.equal(calls[0].input.Limit,100);
});

test("complete scan reports redacted aggregate metrics and never issues write commands",async()=>{
  let pages=0;
  const client={async send(command){
    assert.ok(command instanceof ScanCommand);
    pages++;
    return pages===1 ? {Items:testRows.slice(0,6),ScannedCount:100,LastEvaluatedKey:{pk:"more",sk:"STATE"}}
      : {Items:testRows.slice(6),ScannedCount:4};
  }};
  const output=await scanRepairEvidence({client,table:"state",
    options:{profile:"home",maxPages:2},delay:async()=>{},now:()=>NOW});
  assert.equal(output.scanComplete,true);
  assert.equal(output.operationCount,5);
  assert.equal(output.pageCount,2);
  assert.equal(output.qualifiedForAutomaticDelete,0);
  assert.equal(pages,2);
  const serialized=JSON.stringify(output);
  assert.ok(!serialized.includes("id-one"));
  assert.ok(!serialized.includes("case-written"));
});

test("operator evidence output never logs raw provider IDs or attempted deletes",()=>{
  const input=[op("safe-id","succeeded",{preview:{id:"preview-safe-id",intent:{
    profile:"home",caseId:"case-safe-id",taskId:"secret-task-id",eventId:"secret-calendar-id"},snapshots:[]}})];
  const output=assessRepairRetention(input,{profile:"all",nowMs:NOW});
  const json=JSON.stringify(output);
  assert.ok(!json.includes("secret-task-id"));
  assert.ok(!json.includes("secret-calendar-id"));
  assert.equal(output.unsupportedForDelete,1);
});
