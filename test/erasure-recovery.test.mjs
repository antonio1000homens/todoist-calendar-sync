import test from "node:test";
import assert from "node:assert/strict";
import {erasurePreviewFingerprint} from "../dist/erasure-executor.js";
import {ErasureRecoveryService} from "../dist/erasure-recovery.js";

const enabledId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disabledId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const receiptId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
process.env.STATE_TABLE_NAME="test-state";
process.env.ERASURE_PROTOCOL_VERSION="1";
process.env.ERASURE_EXECUTION_ENABLED="true";

function fixture(options={}) {
  const base={profile:"work",target:{taskId:"disposable-1",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},
    providerSnapshotFingerprint:"1".repeat(64),inventory:[],
    actionPlan:{todoistTask:{id:"disposable-1",digest:"2".repeat(64)},comments:[]}};
  const digest=erasurePreviewFingerprint(base);
  const operation={...base,operationId:"op-recovery",previewFingerprint:digest,confirmationFingerprint:digest,
    confirmationId:"erasure-confirm",providerDeletionReady:true,status:"review_required",
    createdAt:"2026-10-26T10:00:00Z",updatedAt:"2026-10-26T10:00:01Z",
    lifecycle:{phase:"wait_worker_timeout",mappingIds:[enabledId,disabledId],
      enabledMappingIds:[enabledId],timeoutSeconds:30,pollMs:5000,nextRunAt:0,
      evidence:{fenceInstalled:{operationId:"op-recovery",phase:"fenceInstalled",receiptId,completedAt:1000}}}};
  const control=[
    {pk:"ERASURE#work",sk:"FENCE",operationId:"op-recovery",state:"active"},
    {pk:"ERASURE#work",sk:"EPOCH",epoch:7},
    {pk:"ERASURE#work",sk:"JOURNAL",operationId:"op-recovery"},
  ];
  const state=new Map([[enabledId,"Disabled"],[disabledId,"Disabled"]]);
  const external={snapshot:{...base,operationId:"op-recovery",previewFingerprint:digest,blockers:[]},
    mappingInventory:[enabledId,disabledId],mappingStates:state,control,providerCalls:0,restored:[],writes:[]};
  Object.assign(operation,options.operation||{});
  Object.assign(external,options.external||{});
  const opKey="ERASURE_OPERATION#op-recovery";
  let confirmation,postwriteToken,erasureConfirmation;
  const db={
    async send(command) {
      const kind=command.constructor.name;
      const input=command.input;
      if(kind==="GetCommand") {
        if(input.Key.pk===opKey)return {Item:operation};
        if(input.Key.pk==="ERASURE_CONFIRMATION#op-recovery")return {Item:erasureConfirmation};
        if(input.Key.pk==="ERASURE_RECOVERY_CONFIRMATION#op-recovery")return {Item:confirmation};
        if(input.Key.pk==="ERASURE_POSTWRITE_CONFIRMATION#op-recovery")return {Item:postwriteToken};
        if(input.Key.pk==="ERASURE_POSTWRITE_CONFIRMATION#op-recovery")return {Item:postwriteToken};
        return {Item:undefined};
      }
      if(kind==="QueryCommand") {
        if(options.paginated && !input.ExclusiveStartKey)
          return {Items:external.control.slice(0,2),LastEvaluatedKey:{pk:"ERASURE#work",sk:"EPOCH"}};
        return {Items:options.paginated?external.control.slice(2):external.control};
      }
      if(kind==="PutCommand") {
        external.writes.push(input);
        if(input.Item.pk==="ERASURE_POSTWRITE_CONFIRMATION#op-recovery"){
          if(postwriteToken&&postwriteToken.status==="consumed")throw new Error("Reviewed token is already consumed");
          postwriteToken={...input.Item};return {};
        }
        confirmation={...input.Item};
        return {};
      }
      if(kind==="UpdateCommand") {
        external.writes.push(input);
        assert.equal(operation.recovery.status,input.ExpressionAttributeValues[":expected"]);
        operation.recovery.status=input.ExpressionAttributeValues[":next"];
        if(input.ExpressionAttributeValues[":error"])
          operation.recovery.lastError=input.ExpressionAttributeValues[":error"];
        return {};
      }
      if(kind==="TransactWriteCommand") {
        external.writes.push(input);
        if(input.TransactItems.some(x=>x.Update?.UpdateExpression?.includes("postWriteCompletion=:completion"))) {
          if(options.failPostwriteCompletion)
            throw Object.assign(new Error("Completion transaction conflict"),{name:"TransactionCanceledException"});
          const update=input.TransactItems.find(x=>x.Update?.UpdateExpression?.includes("postWriteCompletion=:completion")).Update;
          assert.match(update.UpdateExpression,/REMOVE #target/);
          assert.match(update.ConditionExpression,/attribute_not_exists\(lifecycle\.#progress\.#attempt\)/);
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.pk==="ERASURE_CONFIRMATION#op-recovery"));
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.pk==="ERASURE_RECOVERY_CONFIRMATION#op-recovery"));
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.pk==="ERASURE_POSTWRITE_CONFIRMATION#op-recovery"));
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.sk==="FENCE"));
          assert.ok(input.TransactItems.some(x=>x.ConditionCheck?.Key?.sk==="EPOCH"));
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.sk==="JOURNAL"));
          const receipt=update.ExpressionAttributeValues[":completion"];
          operation.status="succeeded";
          operation.postWriteCompletion=receipt;
          operation.updatedAt=receipt.completedAt;
          for(const key of ["target","selectedActions","previewFingerprint","providerSnapshotFingerprint",
            "confirmationFingerprint","confirmationId","providerDeletionReady","inventory","actionPlan",
            "lifecycle","recovery","postwriteReview","requestId","result","error"])delete operation[key];
          erasureConfirmation=undefined;confirmation=undefined;postwriteToken=undefined;
          external.control=external.control.filter(x=>!["FENCE","JOURNAL"].includes(x.sk));
          if(options.losePostwriteCompletionAck)throw new Error("Lost completion acknowledgement");
          return {};
        }
        if(input.TransactItems.some(x=>x.Update?.UpdateExpression?.startsWith("SET postwriteReview=:review"))){
          if(options.failPostwriteTransaction)throw Object.assign(new Error("Transaction conflict"),{name:"TransactionCanceledException"});
          assert.equal(operation.postwriteReview,undefined);
          assert.equal(operation.recovery,undefined);
          assert.equal(postwriteToken.status,"issued");
          assert.equal(input.TransactItems.filter(x=>x.Delete||x.Put).length,0,
            "post-write acknowledgement cannot delete or write any provider/replay/fence item");
          assert.ok(input.TransactItems.some(x=>x.ConditionCheck?.Key?.sk==="FENCE"));
          assert.ok(input.TransactItems.some(x=>x.ConditionCheck?.Key?.sk==="EPOCH"));
          operation.postwriteReview=input.TransactItems[0].Update.ExpressionAttributeValues[":review"];
          postwriteToken.status="consumed";
          delete postwriteToken.operator;
          delete postwriteToken.expiresAt;
          delete postwriteToken.expiresAtMs;
          return {};
        }
        if(input.TransactItems.some(x=>x.Update?.UpdateExpression?.startsWith("SET recovery=:recovery"))) {
          const confirmationUpdate=input.TransactItems.find(x=>x.Update?.Key?.pk==="ERASURE_RECOVERY_CONFIRMATION#op-recovery").Update;
          assert.match(confirmationUpdate.ConditionExpression,/#operator=:operator/);
          assert.equal(confirmationUpdate.ExpressionAttributeNames["#operator"],"operator");
          assert.equal(operation.status,"review_required");
          assert.equal(operation.recovery,undefined,"confirmation must not be reused");
          assert.equal(confirmation.status,"issued");
          operation.recovery=input.TransactItems[0].Update.ExpressionAttributeValues[":recovery"];
          confirmation.status="consumed";
          return {};
        }
        if(input.TransactItems.some(x=>x.Update?.UpdateExpression?.includes("completedAt"))) {
          if(options.failRelease)throw Object.assign(new Error("Transaction race"),{name:"TransactionCanceledException"});
          assert.equal(operation.recovery.status,"verifying");
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.sk==="FENCE"));
          assert.ok(input.TransactItems.some(x=>x.ConditionCheck?.Key?.sk==="EPOCH"));
          assert.ok(input.TransactItems.some(x=>x.Delete?.Key?.sk==="JOURNAL"));
          operation.recovery.status="completed";
          external.control=external.control.filter(x=>!["FENCE","JOURNAL"].includes(x.sk));
          return {};
        }
        throw new Error("Unrecognised recovery transaction");
      }
      throw new Error("Unexpected database command: "+kind);
    },
  };
  const adapters={
    async listWorkerMappings() {
      return external.mappingInventory.map(id=>({id,state:external.mappingStates.get(id)||"Unknown",
        eventSourceArn:"arn:aws:sqs:eu-west-2:111111111111:sync-queue"}));
    },
    async mappingStates(ids) {return ids.map(id=>({id,state:external.mappingStates.get(id)||"Unknown"}));},
    async restoreMappings(ids) {
      external.restored.push(...ids);
      for(const id of ids)external.mappingStates.set(id,options.enabling?"Enabling":"Enabled");
    },
    async readSnapshot(){external.providerCalls++;return external.snapshot;},
    async readKnownTargetSnapshot(){external.knownTargetCalls=(external.knownTargetCalls||0)+1;
      return external.knownTargetSnapshot||external.snapshot;},
  };
  const store={async get(id){return id==="op-recovery"?operation:undefined;}};
  const service=new ErasureRecoveryService(adapters,db,store,()=>options.token||"fresh-recovery-token");
  return {service,operation,external,db,
    get postwriteToken(){return postwriteToken;},
    set postwriteToken(value){postwriteToken=value;},
    get confirmation(){return confirmation;},
    set confirmation(value){confirmation=value;},
    get erasureConfirmation(){return erasureConfirmation;},
    set erasureConfirmation(value){erasureConfirmation=value;}};
}

function postWriteCompletionFixture(options={}) {
  const f=fixture(options);
  const projectCommentId="project-comment-1";
  f.operation.target={taskId:"disposable-1",eventId:"disposable-event",deleteCalendar:true};
  f.operation.selectedActions={deleteTodoist:true,deleteCalendar:true};
  f.operation.actionPlan={
    todoistTask:{id:"disposable-1",digest:"2".repeat(64)},
    calendarEvent:{id:"disposable-event",calendarId:"work-calendar",digest:"3".repeat(64),etag:"original-etag"},
    knownCalendarAliases:[{profile:"work",calendarId:"work-calendar",eventId:"disposable-event"}],
    knownCalendarAliasesComplete:true,
    projectCommentIds:[projectCommentId],
    comments:[{id:projectCommentId,kind:"project",digest:"4".repeat(64)}],
  };
  f.operation.inventory=[];
  f.operation.providerSnapshotFingerprint="1".repeat(64);
  f.operation.previewFingerprint=erasurePreviewFingerprint(f.operation);
  f.operation.confirmationFingerprint=f.operation.previewFingerprint;
  f.operation.confirmationId="erasure-confirm";
  f.operation.providerDeletionReady=true;
  f.operation.status="review_required";
  const startedAt=Date.now()-60_000;
  f.operation.lifecycle={
    phase:"verify_deletion",mappingIds:[enabledId,disabledId],enabledMappingIds:[enabledId],
    timeoutSeconds:30,pollMs:5000,nextRunAt:0,
    evidence:{
      fenceInstalled:{operationId:"op-recovery",phase:"fenceInstalled",receiptId,completedAt:startedAt-40_000},
      deletionStarted:{operationId:"op-recovery",phase:"deletionStarted",
        receiptId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",completedAt:startedAt-10_000},
    },
    deletionProgress:{stage:"verify",commentIndex:1,stateIndex:0,startedAt},
  };
  f.operation.updatedAt="2026-11-11T20:00:00.000Z";
  f.erasureConfirmation={pk:"ERASURE_CONFIRMATION#op-recovery",sk:"STATE",
    status:"consumed",operationId:"op-recovery",confirmationId:"erasure-confirm",
    consumedBy:"op-recovery",previewFingerprint:f.operation.previewFingerprint};
  f.confirmation={pk:"ERASURE_RECOVERY_CONFIRMATION#op-recovery",sk:"STATE",
    status:"issued",operationId:"op-recovery",inspectedFingerprint:"old-recovery-token"};
  f.postwriteToken={pk:"ERASURE_POSTWRITE_CONFIRMATION#op-recovery",sk:"STATE",
    status:"issued",operationId:"op-recovery",postflightFingerprint:"old-postwrite-token"};
  const snapshot={
    operationId:"op-recovery",profile:"work",target:f.operation.target,
    selectedActions:f.operation.selectedActions,inventory:[],
    actionPlan:{comments:[],projectCommentIds:[],knownCalendarAliases:f.operation.actionPlan.knownCalendarAliases,
      knownCalendarAliasesComplete:true},providerSnapshotFingerprint:"9".repeat(64),blockers:[],
    knownTargetReadback:{todoist:"absent",calendar:"absent",configuredCalendarLink:"not_found"},
    projectTombstone:{status:"present",recordedCommentFound:true,markerMatchesTaskAndCalendar:true,
      recordedCommentCount:1,foundCommentCount:1},
  };
  snapshot.previewFingerprint=erasurePreviewFingerprint(snapshot);
  f.external.snapshot=snapshot;
  f.external.knownTargetSnapshot=snapshot;
  Object.assign(f.operation,options.operation||{});
  Object.assign(f.external,options.external||{});
  return f;
}

function postWriteStateCleanupFixture() {
  const f=postWriteCompletionFixture();
  const row={type:"DELIVERY",key:{pk:"DELIVERY#original",sk:"STATE"},
    digest:"e".repeat(64),classification:"attributable",
    receiptCleanup:"scrub_identity_refs",scrubbedDigest:"f".repeat(64)};
  f.operation.inventory=[row];
  f.operation.previewFingerprint=erasurePreviewFingerprint(f.operation);
  f.operation.confirmationFingerprint=f.operation.previewFingerprint;
  f.operation.lifecycle.phase="delete";
  f.operation.lifecycle.deletionProgress={stage:"state",commentIndex:1,stateIndex:0,startedAt:Date.now()-60_000};
  f.erasureConfirmation.previewFingerprint=f.operation.previewFingerprint;
  f.external.knownTargetSnapshot.inventory=[row];
  f.external.knownTargetSnapshot.previewFingerprint=erasurePreviewFingerprint(f.external.knownTargetSnapshot);
  f.external.snapshot=f.external.knownTargetSnapshot;
  let advances=0;
  f.service.erasures.advanceFencedLifecycle=async()=>{
    advances++;
    if(advances===1) {
      f.operation.lifecycle.deletionProgress={...f.operation.lifecycle.deletionProgress,stateIndex:1};
      f.operation.updatedAt="2026-11-11T20:01:00.000Z";
      f.external.knownTargetSnapshot.inventory=[];
      f.external.knownTargetSnapshot.previewFingerprint=erasurePreviewFingerprint(f.external.knownTargetSnapshot);
      return {phase:"delete",nextRunAt:0,status:"review_required",waiting:false};
    }
    if(advances===2) {
      f.operation.lifecycle.deletionProgress={...f.operation.lifecycle.deletionProgress,stage:"verify"};
      f.operation.updatedAt="2026-11-11T20:02:00.000Z";
      return {phase:"delete",nextRunAt:0,status:"review_required",waiting:false};
    }
    f.operation.lifecycle.phase="verify_deletion";
    f.operation.updatedAt="2026-11-11T20:03:00.000Z";
    return {phase:"verify_deletion",nextRunAt:0,status:"review_required",waiting:false};
  };
  return Object.assign(f,{get advances(){return advances;}});
}

function timedOutProjectCommentFixture({ageMs=60_000,stage="comments"}={}) {
  const f=fixture();
  const attemptId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const startedAt=Date.now()-ageMs;
  const projectComment={id:"project-comment-1",kind:"project",digest:"3".repeat(64)};
  const base={...f.operation,actionPlan:{...f.operation.actionPlan,
    comments:[projectComment],projectCommentIds:[projectComment.id]}};
  const fingerprint=erasurePreviewFingerprint(base);
  f.operation.actionPlan=base.actionPlan;
  f.operation.previewFingerprint=fingerprint;
  f.operation.confirmationFingerprint=fingerprint;
  f.operation.lifecycle={...f.operation.lifecycle,phase:"delete",nextRunAt:0,
    evidence:{...f.operation.lifecycle.evidence,
      deletionStarted:{operationId:"op-recovery",phase:"deletionStarted",receiptId,completedAt:startedAt-1000}},
    deletionProgress:{stage,commentIndex:0,stateIndex:0,startedAt,
      attempt:{id:attemptId,startedAt}}};
  f.operation.updatedAt=new Date().toISOString();
  f.external.snapshot={...base,operationId:"op-recovery",previewFingerprint:fingerprint,blockers:[]};
  return f;
}

function calendarDriftFixture(){
  const f=fixture();
  const {operation,external}=f;
  const eventId="disposable-event-1";
  const originalCalendar={id:eventId,calendarId:"work-calendar",digest:"3".repeat(64),etag:"etag-before"};
  operation.target={taskId:"disposable-1",eventId,deleteCalendar:true};
  operation.selectedActions={deleteTodoist:true,deleteCalendar:true};
  operation.actionPlan={
    todoistTask:{id:"disposable-1",digest:"2".repeat(64)},
    calendarEvent:originalCalendar,
    comments:[],
    projectCommentIds:["comment-id-1"],
    knownCalendarAliases:[{profile:"work",calendarId:"work-calendar",eventId}],
    knownCalendarAliasesComplete:true,
  };
  operation.previewFingerprint=erasurePreviewFingerprint(operation);
  operation.confirmationFingerprint=operation.previewFingerprint;
  const snap={...external.snapshot,
    target:{...operation.target},selectedActions:{...operation.selectedActions},
    actionPlan:{...operation.actionPlan,todoistTask:{...operation.actionPlan.todoistTask},calendarEvent:{...originalCalendar,
      digest:"4".repeat(64),etag:"etag-after"}},
    providerSnapshotFingerprint:"5".repeat(64),
    primaryProviderSnapshotFingerprint:"6".repeat(64),
    knownTargetReadback:{todoist:"present",calendar:"present",configuredCalendarLink:"found"},
    crossProfileEvidence:{allProfilesQueried:true,closureComplete:true,
      stateScan:{allPagesReceived:true,stronglyConsistent:true}},
  };
  snap.previewFingerprint=erasurePreviewFingerprint(snap);
  external.snapshot=snap;
  return f;
}

test("Calendar revision-only drift is reviewable but never automatically recoverable",async()=>{
  const f=calendarDriftFixture();
  const inspection=await f.service.inspect("op-recovery");
  assert.equal(inspection.preview.classification,"partial_or_ambiguous");
  assert.equal(inspection.preview.allowed,false);
  assert.equal(inspection.preview.calendarDriftReview.candidateForSeparateApproval,true);
  assert.equal(inspection.preview.calendarDriftReview.releaseAllowed,false);
  await assert.rejects(()=>f.service.issueConfirmation("op-recovery","operator"),/Recovery is blocked/);
  const watchdog=await f.service.startAutomaticPreWriteRecovery("op-recovery");
  assert.equal(watchdog.queued,false);
  assert.equal(f.external.writes.length,0);
});

test("explicit Calendar-drift cancellation rechecks and restores only the original mapping, keeping both providers",async()=>{
  const f=calendarDriftFixture();
  const issued=await f.service.issueConfirmation("op-recovery","operator","calendar_drift_cancel");
  assert.equal(issued.mode,"calendar_drift_cancel");
  assert.equal(f.confirmation.mode,"calendar_drift_cancel");
  await assert.rejects(
    ()=>f.service.apply("op-recovery",issued.confirmationId,"operator"),
    /expired, changed, or consumed/);
  await f.service.apply("op-recovery",issued.confirmationId,"operator","calendar_drift_cancel");
  assert.equal(f.operation.recovery.mode,"calendar_drift_cancel");
  assert.equal(f.operation.recovery.calendarDigest,"4".repeat(64));
  assert.equal(f.operation.recovery.calendarEtag,"etag-after");
  assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
  assert.deepEqual(f.external.restored,[]);
  assert.equal((await f.service.process("op-recovery")).status,"restoring");
  assert.equal((await f.service.process("op-recovery")).status,"restoring");
  assert.deepEqual(f.external.restored,[enabledId]);
  assert.equal((await f.service.process("op-recovery")).status,"verifying");
  assert.equal((await f.service.process("op-recovery")).status,"completed");
  assert.ok(!f.external.control.some(row=>row.sk==="FENCE"));
  assert.equal(f.operation.recovery.status,"completed");
});

test("Calendar-drift cancellation rejects altered provider revisions and preserves the original fence",async()=>{
  const f=calendarDriftFixture();
  const issued=await f.service.issueConfirmation("op-recovery","operator","calendar_drift_cancel");
  f.external.snapshot.actionPlan.calendarEvent={
    ...f.external.snapshot.actionPlan.calendarEvent,digest:"7".repeat(64),etag:"etag-next"};
  f.external.snapshot.previewFingerprint=erasurePreviewFingerprint(f.external.snapshot);
  await assert.rejects(
    ()=>f.service.apply("op-recovery",issued.confirmationId,"operator","calendar_drift_cancel"),
    /Safety evidence drifted/);
  assert.equal(f.operation.recovery,undefined);
  assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
});

test("Calendar-drift worker fails closed if the Calendar revision changes after acceptance",async()=>{
  const f=calendarDriftFixture();
  const issued=await f.service.issueConfirmation("op-recovery","operator","calendar_drift_cancel");
  await f.service.apply("op-recovery",issued.confirmationId,"operator","calendar_drift_cancel");
  f.external.snapshot.actionPlan.calendarEvent={
    ...f.external.snapshot.actionPlan.calendarEvent,digest:"7".repeat(64)};
  f.external.snapshot.previewFingerprint=erasurePreviewFingerprint(f.external.snapshot);
  const outcome=await f.service.process("op-recovery");
  assert.equal(outcome.status,"blocked");
  assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
  assert.deepEqual(f.external.restored,[]);
});

test("Calendar-drift cancellation is refused when any independent pre-write evidence is unsafe",async()=>{
  const mutations=[
    f=>{f.external.snapshot.actionPlan.todoistTask.digest="9".repeat(64);},
    f=>{f.external.snapshot.inventory=[{type:"TASK",key:{pk:"unrelated",sk:"x"},digest:"0".repeat(64)}];},
    f=>{f.external.snapshot.crossProfileEvidence.allProfilesQueried=false;},
    f=>{f.external.snapshot.crossProfileEvidence.stateScan.allPagesReceived=false;},
    f=>{f.external.snapshot.actionPlan.calendarEvent=undefined;},
    f=>{f.external.snapshot.blockers.push("conflicting provider identity");},
    f=>{f.external.control.push({pk:"ERASURE#work",sk:"WRITER#other",operationId:"other"});},
    f=>{f.external.mappingStates.set(enabledId,"Enabled");},
    f=>{f.operation.lifecycle.evidence.deletionStarted={operationId:"op-recovery",phase:"deletionStarted",receiptId,completedAt:1000};},
  ];
  for(const alter of mutations){
    const f=calendarDriftFixture();
    alter(f);
    f.external.snapshot.previewFingerprint=erasurePreviewFingerprint(f.external.snapshot);
    const inspection=await f.service.inspect("op-recovery");
    assert.notEqual(inspection.preview.calendarDriftReview?.candidateForSeparateApproval,true);
    await assert.rejects(
      ()=>f.service.issueConfirmation("op-recovery","operator","calendar_drift_cancel"),
      /Recovery is blocked/);
    assert.equal(f.operation.recovery,undefined);
    assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
    assert.equal(f.external.restored.length,0);
  }
});

test("read-only preview paginates controls and checks original mappings and immutable provider inventory",async()=>{
  const {service,external}=fixture({paginated:true});
  const a=await service.inspect("op-recovery");
  assert.equal(a.preview.allowed,true);
  assert.equal(a.preview.classification,"pre_write");
  assert.equal(a.preview.epoch,7);
  assert.equal(a.preview.leaseCount,0);
  assert.deepEqual(a.preview.mappingStates.map(x=>x.originallyEnabled),[true,false]);
  assert.equal(external.writes.length,0);
});

test("pre-write recovery accepts a fully read cross-profile audit without confusing its digest with the original target confirmation",async()=>{
  const {service,external}=fixture();
  const primary=external.snapshot.providerSnapshotFingerprint;
  const withAudit={
    ...external.snapshot,
    // The cross-profile evidence digest intentionally differs from the
    // immutable original, as it covers more provider data.
    providerSnapshotFingerprint:"a".repeat(64),
    primaryProviderSnapshotFingerprint:primary,
    crossProfileEvidence:{allProfilesQueried:true,
      stateScan:{allPagesReceived:true,stronglyConsistent:true}},
  };
  withAudit.previewFingerprint=erasurePreviewFingerprint(withAudit);
  external.snapshot=withAudit;
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.classification,"pre_write");
  assert.equal(inspected.preview.allowed,true);
  assert.equal(external.writes.length,0);
});

test("cross-profile audit cannot hide changed primary provider data",async()=>{
  const {service,external}=fixture();
  const withAudit={...external.snapshot,
    providerSnapshotFingerprint:"a".repeat(64),
    primaryProviderSnapshotFingerprint:"b".repeat(64),
    crossProfileEvidence:{allProfilesQueried:true,
      stateScan:{allPagesReceived:true,stronglyConsistent:true}}};
  withAudit.previewFingerprint=erasurePreviewFingerprint(withAudit);
  external.snapshot=withAudit;
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.allowed,false);
  assert.equal(inspected.preview.classification,"partial_or_ambiguous");
  assert.equal(external.writes.length,0);
});

test("cross-profile audit must be complete and strongly consistent before pre-write admission",async()=>{
  for(const scan of [{allPagesReceived:false,stronglyConsistent:true},
                     {allPagesReceived:true,stronglyConsistent:false}]) {
    const {service,external}=fixture();
    const withAudit={...external.snapshot,
      providerSnapshotFingerprint:"a".repeat(64),
      primaryProviderSnapshotFingerprint:external.snapshot.providerSnapshotFingerprint,
      crossProfileEvidence:{allProfilesQueried:true,stateScan:scan}};
    withAudit.previewFingerprint=erasurePreviewFingerprint(withAudit);
    external.snapshot=withAudit;
    const inspected=await service.inspect("op-recovery");
    assert.equal(inspected.preview.allowed,false);
    assert.equal(external.writes.length,0);
  }
});

test("pre-write recovery rejects an incomplete or missing target-only audit baseline",async()=>{
  for(const {allProfilesQueried,primaryProviderSnapshotFingerprint} of [
    {allProfilesQueried:false,primaryProviderSnapshotFingerprint:"1".repeat(64)},
    {allProfilesQueried:true,primaryProviderSnapshotFingerprint:undefined},
  ]) {
    const {service,external}=fixture();
    const snapshot={...external.snapshot,providerSnapshotFingerprint:"a".repeat(64),
      ...(primaryProviderSnapshotFingerprint?{primaryProviderSnapshotFingerprint}:{}),
      crossProfileEvidence:{allProfilesQueried,
        stateScan:{allPagesReceived:true,stronglyConsistent:true}}};
    snapshot.previewFingerprint=erasurePreviewFingerprint(snapshot);
    external.snapshot=snapshot;
    const result=await service.inspect("op-recovery");
    assert.equal(result.preview.allowed,false);
    assert.equal(result.preview.classification,"partial_or_ambiguous");
    assert.equal(external.writes.length,0);
  }
});

test("read-only recovery diagnostics report exact unchanged pre-write evidence",async()=>{
  const {service,external}=fixture();
  const inspection=await service.inspect("op-recovery");
  assert.equal(inspection.preview.allowed,true);
  const checks=inspection.preview.evidenceChecks;
  assert.ok(checks);
  assert.deepEqual(Object.entries(checks).filter(([key,value])=>key!=="providerSafetyBlockerCount"&&value!==true),[]);
  assert.equal(checks.providerSafetyBlockerCount,0);
  assert.equal(external.writes.length,0);
});

test("read-only recovery diagnostics isolate task snapshot drift without authorizing release",async()=>{
  const {service,external}=fixture();
  external.snapshot={...external.snapshot,actionPlan:{...external.snapshot.actionPlan,
    todoistTask:{id:"disposable-1",digest:"9".repeat(64)}}};
  external.snapshot.previewFingerprint=erasurePreviewFingerprint(external.snapshot);
  const inspection=await service.inspect("op-recovery");
  assert.equal(inspection.preview.allowed,false);
  assert.equal(inspection.preview.classification,"partial_or_ambiguous");
  assert.equal(inspection.preview.evidenceChecks.todoistTaskMatches,false);
  assert.equal(inspection.preview.evidenceChecks.calendarEventMatches,true);
  assert.equal(inspection.preview.evidenceChecks.stateInventoryMatches,true);
  assert.equal(inspection.preview.evidenceChecks.originalPreviewMatches,false);
  assert.equal(external.writes.length,0);
});

test("read-only recovery diagnostics isolate DynamoDB inventory drift",async()=>{
  const {service,external}=fixture();
  external.snapshot={...external.snapshot,inventory:[{
    type:"TASK",key:{pk:"TASK#disposable-1",sk:"STATE"},
    digest:"0".repeat(64),classification:"selected-only"}]};
  external.snapshot.previewFingerprint=erasurePreviewFingerprint(external.snapshot);
  const inspection=await service.inspect("op-recovery");
  assert.equal(inspection.preview.allowed,false);
  assert.equal(inspection.preview.evidenceChecks.stateInventoryMatches,false);
  assert.equal(inspection.preview.evidenceChecks.todoistTaskMatches,true);
  assert.equal(external.writes.length,0);
});


function calendarOnlyDriftFixture() {
  const f=fixture();
  const original={id:"event-1",calendarId:"work-calendar",digest:"a".repeat(64),etag:"v1"};
  f.operation.target={profile:"work",taskId:"disposable-1",eventId:"event-1",deleteCalendar:true};
  f.operation.selectedActions={deleteTodoist:true,deleteCalendar:true};
  f.operation.actionPlan={...f.operation.actionPlan,calendarEvent:original};
  f.operation.previewFingerprint=erasurePreviewFingerprint(f.operation);
  f.operation.confirmationFingerprint=f.operation.previewFingerprint;
  const snapshot={...f.external.snapshot,
    profile:"work",target:{...f.operation.target},selectedActions:{...f.operation.selectedActions},
    actionPlan:{...f.operation.actionPlan,calendarEvent:{...original,digest:"b".repeat(64),etag:"v2"}},
    providerSnapshotFingerprint:"c".repeat(64),primaryProviderSnapshotFingerprint:"d".repeat(64),
    crossProfileEvidence:{allProfilesQueried:true,
      stateScan:{allPagesReceived:true,stronglyConsistent:true}},
    knownTargetReadback:{todoist:"present",calendar:"present",configuredCalendarLink:"present"},
    blockers:[],inventory:[],
  };
  snapshot.previewFingerprint=erasurePreviewFingerprint(snapshot);
  f.external.snapshot=snapshot;
  return f;
}

function firstCommentTargetOnlyCalendarDriftFixture() {
  const f=timedOutProjectCommentFixture();
  const {operation,external}=f;
  const eventId="event-first-comment-drift";
  const original={id:eventId,calendarId:"work-calendar",digest:"a".repeat(64),etag:"etag-before"};
  operation.target={profile:"work",taskId:"disposable-1",eventId,deleteCalendar:true};
  operation.selectedActions={deleteTodoist:true,deleteCalendar:true};
  operation.actionPlan={...operation.actionPlan,
    todoistTask:{id:"disposable-1",digest:"2".repeat(64)},
    calendarEvent:original,
    knownCalendarAliases:[{profile:"work",calendarId:"work-calendar",eventId}],
    knownCalendarAliasesComplete:true};
  operation.providerSnapshotFingerprint="1".repeat(64);
  operation.previewFingerprint=erasurePreviewFingerprint(operation);
  operation.confirmationFingerprint=operation.previewFingerprint;
  const snapshot={...operation,
    actionPlan:{...operation.actionPlan,calendarEvent:{...original,digest:"b".repeat(64),etag:"etag-after"}},
    providerSnapshotFingerprint:"5".repeat(64),
    knownTargetReadback:{todoist:"present",calendar:"present",configuredCalendarLink:"present"},
    blockers:[]};
  delete snapshot.crossProfileEvidence;
  snapshot.previewFingerprint=erasurePreviewFingerprint(snapshot);
  external.snapshot=snapshot;
  external.knownTargetSnapshot=snapshot;
  return f;
}

test("Calendar-only provider revision is triaged read-only, not admitted for recovery",async()=>{
  const f=calendarOnlyDriftFixture();
  const result=await f.service.inspect("op-recovery");
  assert.equal(result.preview.classification,"partial_or_ambiguous");
  assert.equal(result.preview.allowed,false);
  assert.deepEqual(result.preview.calendarDriftReview,
    {candidateForSeparateApproval:true,releaseAllowed:false});
  assert.equal(result.preview.evidenceChecks.calendarEventMatches,false);
  assert.equal(result.preview.evidenceChecks.todoistTaskMatches,true);
  await assert.rejects(f.service.issueConfirmation("op-recovery","operator"),
    /Recovery is blocked/);
  assert.deepEqual(f.external.writes,[]);
  assert.deepEqual(f.external.restored,[]);
  assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
});

test("Calendar drift triage rejects other identity/state drift, incomplete audits and live writers",async()=>{
  for(const mutate of [
    f=>{f.external.snapshot.actionPlan.todoistTask.digest="9".repeat(64);},
    f=>{f.external.snapshot.inventory=[{type:"TASK",key:{pk:"TASK#other",sk:"STATE"},digest:"0".repeat(64)}];},
    f=>{f.external.snapshot.crossProfileEvidence.stateScan.allPagesReceived=false;},
    f=>{f.external.snapshot.actionPlan.calendarEvent.id="different-event";},
    f=>{f.external.snapshot.knownTargetReadback.calendar="absent";},
    f=>{f.external.snapshot.blockers=["Provider identity mismatch"];},
    f=>{f.external.control.push({pk:"ERASURE#work",sk:"WRITER#active",operationId:"other"});},
    f=>{f.external.mappingStates.set(enabledId,"Enabled");},
    f=>{f.operation.lifecycle.evidence.deletionStarted={operationId:"op-recovery",phase:"deletionStarted",receiptId,completedAt:1000};},
  ]) {
    const f=calendarOnlyDriftFixture();
    mutate(f);
    f.external.snapshot.previewFingerprint=erasurePreviewFingerprint(f.external.snapshot);
    const result=await f.service.inspect("op-recovery");
    assert.equal(result.preview.calendarDriftReview.candidateForSeparateApproval,false);
    assert.equal(result.preview.allowed,false);
    assert.deepEqual(f.external.writes,[]);
    assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
  }
});

test("first-comment Calendar drift cancellation uses exact target proof and never starts a full cross-profile audit",async()=>{
  const {service,operation,external}=firstCommentTargetOnlyCalendarDriftFixture();
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.calendarDriftReview.candidateForSeparateApproval,true);
  assert.equal(inspected.preview.allowed,false);
  assert.equal(inspected.preview.evidenceChecks.originalPreWritePhase,true);
  assert.equal(external.knownTargetCalls,1);
  assert.equal(external.providerCalls,0);

  const issued=await service.issueConfirmation("op-recovery","operator","calendar_drift_cancel");
  await service.apply("op-recovery",issued.confirmationId,"operator","calendar_drift_cancel");
  assert.equal(operation.recovery.mode,"calendar_drift_cancel");
  assert.equal(operation.recovery.calendarDigest,"b".repeat(64));
  assert.equal(operation.recovery.calendarEtag,"etag-after");
  assert.ok(external.control.some(row=>row.sk==="FENCE"));
  assert.deepEqual(external.restored,[]);
  assert.equal((await service.process("op-recovery")).status,"restoring");
  assert.deepEqual(external.restored,[]);
  assert.equal((await service.process("op-recovery")).status,"restoring");
  assert.deepEqual(external.restored,[enabledId]);
  assert.equal((await service.process("op-recovery")).status,"verifying");
  assert.equal((await service.process("op-recovery")).status,"completed");
  assert.ok(!external.control.some(row=>row.sk==="FENCE"));
  assert.equal(external.providerCalls,0,"cancellation must not wait on unrelated full provider inventories");
  assert.ok(external.knownTargetCalls>=5,"inspection, confirmation, apply and worker steps recheck the exact target");
});

test("first-comment target-only Calendar cancellation rejects any non-Calendar drift",async()=>{
  for(const mutate of [
    f=>{f.external.knownTargetSnapshot.actionPlan.todoistTask.digest="9".repeat(64);},
    f=>{f.external.knownTargetSnapshot.inventory=[{type:"TASK",key:{pk:"unrelated",sk:"x"},digest:"0".repeat(64)}];},
    f=>{f.external.knownTargetSnapshot.actionPlan.comments[0].digest="8".repeat(64);},
    f=>{f.external.knownTargetSnapshot.actionPlan.knownCalendarAliasesComplete=false;},
    f=>{f.external.knownTargetSnapshot.knownTargetReadback.calendar="absent";},
    f=>{f.external.knownTargetSnapshot.blockers.push("conflicting provider identity");},
  ]) {
    const f=firstCommentTargetOnlyCalendarDriftFixture();
    mutate(f);
    f.external.knownTargetSnapshot.previewFingerprint=erasurePreviewFingerprint(f.external.knownTargetSnapshot);
    f.external.snapshot=f.external.knownTargetSnapshot;
    const result=await f.service.inspect("op-recovery");
    assert.equal(result.preview.calendarDriftReview.candidateForSeparateApproval,false);
    await assert.rejects(()=>f.service.issueConfirmation("op-recovery","operator","calendar_drift_cancel"),
      /Recovery is blocked/);
    assert.equal(f.operation.recovery,undefined);
    assert.deepEqual(f.external.writes,[]);
    assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
    assert.deepEqual(f.external.restored,[]);
  }
});

test("automatic pre-write recovery uses the same single-use confirmation and guarded transaction",async()=>{
  const {service,operation,external}=fixture();
  const started=await service.startAutomaticPreWriteRecovery("op-recovery");
  assert.deepEqual(started,{queued:true,blockerCount:0});
  assert.equal(operation.status,"review_required");
  assert.equal(operation.recovery.status,"queued");
  assert.ok(external.control.some(row=>row.sk==="FENCE"),
    "automatic recovery must not release a fence directly");
  assert.deepEqual(external.restored,[],
    "mapping restore must wait for the independently guarded recovery worker");
  assert.ok(external.providerCalls>=2,
    "confirmation issuance and apply each independently reread provider evidence");
});

test("timed-out first project-comment attempt is proof of no deletion when every original identity still matches",async()=>{
  const {service,operation,external}=timedOutProjectCommentFixture();
  const inspection=await service.inspect("op-recovery");
  assert.equal(inspection.preview.classification,"pre_write");
  assert.equal(inspection.preview.allowed,true);
  assert.equal(inspection.preview.evidenceChecks.originalPreWritePhase,true);
  assert.equal(external.knownTargetCalls,1,
    "the exact first-comment attempt uses the target snapshot already bound to the original confirmation");
  assert.equal(external.providerCalls,0,
    "pre-write recovery does not wait on unrelated full cross-profile task inventories");
  const recovery=await service.startAutomaticPreWriteRecovery("op-recovery");
  assert.deepEqual(recovery,{queued:true,blockerCount:0});
  assert.equal(external.knownTargetCalls,3,
    "confirmation and apply each repeat the exact target-only proof");
  assert.equal(external.providerCalls,0);
  assert.equal(operation.recovery.mode,"strict_pre_write");
  assert.equal(operation.recovery.status,"queued");
  assert.ok(external.control.some(row=>row.sk==="FENCE"),"sync restoration worker owns fence release");
  assert.deepEqual(external.restored,[],"inspection and scheduling do not restore mappings synchronously");
});

test("initial-comment recovery refuses recent claims, later stages, and any changed confirmed snapshot",async()=>{
  const recent=timedOutProjectCommentFixture({ageMs:1000});
  assert.equal((await recent.service.inspect("op-recovery")).preview.allowed,false);
  assert.equal((await recent.service.startAutomaticPreWriteRecovery("op-recovery")).queued,false);

  const later=timedOutProjectCommentFixture({stage:"todoist"});
  assert.equal((await later.service.inspect("op-recovery")).preview.allowed,false);
  assert.equal((await later.service.startAutomaticPreWriteRecovery("op-recovery")).queued,false);
  assert.equal(later.external.knownTargetCalls||0,0,
    "later deletion stages cannot use the target-only pre-write recovery path");
  assert.equal(later.external.providerCalls,2,
    "later stages repeat the complete cross-profile audit for inspection and confirmation");

  const drift=timedOutProjectCommentFixture();
  drift.external.snapshot.actionPlan={...drift.external.snapshot.actionPlan,
    todoistTask:{...drift.external.snapshot.actionPlan.todoistTask,digest:"9".repeat(64)}};
  drift.external.snapshot.previewFingerprint=erasurePreviewFingerprint(drift.external.snapshot);
  assert.equal((await drift.service.inspect("op-recovery")).preview.allowed,false);
  assert.equal((await drift.service.startAutomaticPreWriteRecovery("op-recovery")).queued,false);
});

test("automatic recovery refuses a drifted provider snapshot without writes",async()=>{
  const {service,external}=fixture();
  external.snapshot={...external.snapshot,previewFingerprint:"0".repeat(64)};
  const outcome=await service.startAutomaticPreWriteRecovery("op-recovery");
  assert.equal(outcome.queued,false);
  assert.ok(outcome.blockerCount>0);
  assert.equal(external.writes.length,0);
});

test("automatic recovery never starts after provider deletion began",async()=>{
  const {service,operation,external}=fixture();
  operation.lifecycle.phase="verify_deletion";
  operation.lifecycle.evidence.deletionStarted={operationId:"op-recovery",
    phase:"deletionStarted",receiptId,completedAt:2000};
  const outcome=await service.startAutomaticPreWriteRecovery("op-recovery");
  assert.equal(outcome.queued,false);
  assert.ok(external.control.some(row=>row.sk==="FENCE"));
  assert.equal(external.writes.length,0);
});

test("automatic recovery refuses an active writer lease",async()=>{
  const {service,external}=fixture();
  external.control.push({pk:"ERASURE#work",sk:"WRITER#ongoing",operationId:"other"});
  const outcome=await service.startAutomaticPreWriteRecovery("op-recovery");
  assert.equal(outcome.queued,false);
  assert.equal(external.writes.length,0);
});

test("independent post-write preview never issues a confirmation, writes state, or releases a fence",async()=>{
  const {service,external}=fixture({paginated:true});
  const assessment=await service.inspectPostWrite("op-recovery");
  assert.equal(assessment.classification,"not_post_write");
  assert.equal(assessment.releaseAllowed,false);
  assert.equal(assessment.onlyAvailableAction,"keep_fenced");
  assert.equal(assessment.evidence.originalProviderWriteIndicated,false);
  assert.equal(assessment.evidence.matchingFence,true);
  assert.equal(external.knownTargetCalls,1,"post-write inspection uses the bounded known-target snapshot");
  assert.equal(external.providerCalls,0,"post-write inspection does not run the all-profile provenance observer");
  assert.equal(external.writes.length,0);
  assert.ok(external.control.some(row=>row.sk==="FENCE"));
});

test("strong exact postflight is a read-only candidate only with complete deletion checkpoints and its active tombstone",async()=>{
  const f=postWriteCompletionFixture();
  const assessment=await f.service.inspectPostWrite("op-recovery");
  assert.equal(assessment.classification,"fully_deleted_candidate");
  assert.equal(assessment.releaseAllowed,false);
  assert.equal(assessment.completionEligible,true);
  assert.equal(assessment.onlyAvailableAction,"automatic_completion_pending");
  assert.equal(assessment.evidence.matchingFence,true);
  assert.equal(assessment.evidence.deletionCheckpointComplete,true);
  assert.equal(assessment.evidence.projectTombstonePresent,true);
  assert.equal(assessment.evidence.knownCalendarAliasesComplete,true);
  assert.equal(f.external.writes.length,0);
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
  assert.equal(f.external.knownTargetCalls,1);
  // A stale or malformed fingerprint must not count as fully verified absence.
  f.external.knownTargetSnapshot.previewFingerprint="0".repeat(64);
  const unsafe=await f.service.inspectPostWrite("op-recovery");
  assert.equal(unsafe.classification,"partial_or_ambiguous");
  assert.equal(unsafe.completionEligible,false);
  assert.equal(f.external.writes.length,0);
});

test("automatic post-write completion restores only recorded mappings and atomically retires identities",async()=>{
  const f=postWriteCompletionFixture();
  const result=await f.service.completePostWriteIfSafe("op-recovery");
  assert.equal(result.status,"completed");
  assert.deepEqual(f.external.restored,[enabledId]);
  assert.equal(f.external.mappingStates.get(enabledId),"Enabled");
  assert.equal(f.external.mappingStates.get(disabledId),"Disabled");
  assert.equal(f.operation.status,"succeeded");
  assert.equal(f.operation.postWriteCompletion.providerDeletesReplayed,false);
  assert.equal(f.operation.postWriteCompletion.tombstoneRetained,true);
  assert.equal(f.operation.postWriteCompletion.originalMappingCount,2);
  assert.equal(f.operation.postWriteCompletion.restoredMappingCount,1);
  assert.equal(f.operation.target,undefined);
  assert.equal(f.operation.actionPlan,undefined);
  assert.equal(f.operation.inventory,undefined);
  assert.equal(f.operation.previewFingerprint,undefined);
  assert.equal(JSON.stringify(f.operation).includes("disposable-1"),false);
  assert.equal(JSON.stringify(f.operation).includes("disposable-event"),false);
  assert.equal(f.erasureConfirmation,undefined);
  assert.equal(f.confirmation,undefined,"any old pre-write recovery confirmation is invalidated");
  assert.equal(f.postwriteToken,undefined,"any legacy post-write token is invalidated");
  assert.equal(f.external.control.some(row=>row.sk==="FENCE"),false);
  assert.equal(f.external.control.some(row=>row.sk==="JOURNAL"),false);
  assert.equal(f.external.control.find(row=>row.sk==="EPOCH").epoch,7);
  assert.equal(f.external.knownTargetCalls,1);
  assert.equal(f.external.providerCalls,0);
  assert.equal(f.external.snapshot.projectTombstone.status,"present",
    "the original project-comment tombstone is not removed by completion");
  assert.equal(f.external.writes.length,1,"only the atomic completion transaction is written");
  assert.equal((await f.service.inspectPostWrite("op-recovery")).classification,"completed");
  assert.equal((await f.service.completePostWriteIfSafe("op-recovery")).status,"completed",
    "repeated completion is a terminal no-op");
  assert.deepEqual(f.external.restored,[enabledId]);
  assert.equal(f.external.writes.length,1);
});

test("post-write finalizer resumes only the original state checkpoint and scrubs eligible delivery receipts",async()=>{
  const f=postWriteStateCleanupFixture();
  const result=await f.service.completePostWriteIfSafe("op-recovery");
  assert.equal(result.status,"completed");
  assert.equal(f.advances,3,"one state-row step, one empty-state checkpoint, then the verify checkpoint");
  assert.deepEqual(f.external.restored,[enabledId]);
  assert.equal(f.external.mappingStates.get(enabledId),"Enabled");
  assert.equal(f.external.mappingStates.get(disabledId),"Disabled");
  assert.equal(f.external.providerCalls,0,"no Todoist or Calendar delete is replayed");
  assert.equal(f.operation.status,"succeeded");
  assert.equal(f.operation.postWriteCompletion.providerDeletesReplayed,false);
  assert.equal(f.operation.postWriteCompletion.tombstoneRetained,true);
  assert.equal(f.external.snapshot.inventory.length,0);
  assert.equal(f.external.control.some(row=>row.sk==="FENCE"),false);
  assert.equal(f.external.writes.length,1,"only the final atomic completion transaction is written by the recovery service");
});

test("post-write completion resolves a lost transaction acknowledgement by terminal readback",async()=>{
  const f=postWriteCompletionFixture({losePostwriteCompletionAck:true});
  const result=await f.service.completePostWriteIfSafe("op-recovery");
  assert.equal(result.status,"completed");
  assert.equal(f.operation.status,"succeeded");
  assert.equal(f.external.control.some(row=>row.sk==="FENCE"),false);
  assert.equal(f.external.writes.length,1);
});

test("post-write completion fails closed for incomplete or ambiguous evidence",async()=>{
  const cases=[
    ["write-ahead attempt",f=>{f.operation.lifecycle.deletionProgress.attempt={startedAt:Date.now()};}],
    ["incomplete checkpoint",f=>{f.operation.lifecycle.deletionProgress.stage="todoist";}],
    ["missing tombstone",f=>{f.external.knownTargetSnapshot.projectTombstone.status="missing";
      f.external.knownTargetSnapshot.previewFingerprint=erasurePreviewFingerprint(f.external.knownTargetSnapshot);}],
    ["provider still present",f=>{f.external.knownTargetSnapshot.knownTargetReadback.calendar="present";
      f.external.knownTargetSnapshot.previewFingerprint=erasurePreviewFingerprint(f.external.knownTargetSnapshot);}],
    ["active writer lease",f=>{f.external.control.push({pk:"ERASURE#work",sk:"WRITER#active",operationId:"other"});}],
    ["wrong fence owner",f=>{f.external.control.find(row=>row.sk==="FENCE").operationId="other";}],
    ["originally disabled mapping enabled",f=>{f.external.mappingStates.set(disabledId,"Enabled");}],
    ["missing original mapping",f=>{f.external.mappingInventory=[enabledId];}],
    ["provider deletion approval missing",f=>{f.operation.providerDeletionReady=false;}],
    ["recovery already recorded",f=>{f.operation.recovery={status:"queued"};}],
  ];
  for(const [name,mutate] of cases) {
    const f=postWriteCompletionFixture();
    mutate(f);
    const result=await f.service.completePostWriteIfSafe("op-recovery");
    assert.equal(result.status,"blocked",name);
    assert.ok(result.blockers.length>0,name);
    assert.ok(f.external.control.some(row=>row.sk==="FENCE"),name);
    assert.equal(f.operation.status,"review_required",name);
    assert.equal(f.external.restored.length,0,name);
    assert.equal(f.external.writes.length,0,name);
  }
});

test("post-write completion honours the existing deployment gate without a new per-operation signoff",async()=>{
  const old=process.env.ERASURE_EXECUTION_ENABLED;
  process.env.ERASURE_EXECUTION_ENABLED="false";
  try {
    const f=postWriteCompletionFixture();
    const assessment=await f.service.inspectPostWrite("op-recovery");
    assert.equal(assessment.classification,"fully_deleted_candidate");
    assert.equal(assessment.completionEligible,false);
    assert.ok(assessment.completionBlockers.some(item=>item.includes("existing erasure execution gate")));
    const result=await f.service.completePostWriteIfSafe("op-recovery");
    assert.equal(result.status,"blocked");
    assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
    assert.equal(f.external.restored.length,0);
    assert.equal(f.external.writes.length,0);
  } finally {
    if(old===undefined)delete process.env.ERASURE_EXECUTION_ENABLED;
    else process.env.ERASURE_EXECUTION_ENABLED=old;
  }
});

test("post-write completion stays fenced when the atomic release transaction conflicts",async()=>{
  const f=postWriteCompletionFixture({failPostwriteCompletion:true});
  const result=await f.service.completePostWriteIfSafe("op-recovery");
  assert.equal(result.status,"blocked");
  assert.ok(f.external.control.some(row=>row.sk==="FENCE"));
  assert.equal(f.operation.status,"review_required");
  assert.deepEqual(f.external.restored,[enabledId],
    "only the originally enabled mapping may be restored before the conditional release");
  assert.equal(f.operation.target.eventId,"disposable-event");
});

test("post-write inspection with an active lease exposes a blocker but never changes controls",async()=>{
  const {service,external}=fixture();
  external.control.push({pk:"ERASURE#work",sk:"ADMISSION#stale",owner:"stale"});
  const assessment=await service.inspectPostWrite("op-recovery");
  assert.equal(assessment.releaseAllowed,false);
  assert.equal(assessment.evidence.leasesDrained,false);
  assert.equal(assessment.evidence.matchingFence,true);
  assert.equal(external.writes.length,0);
});

test("distinct single-use confirmation and CAS restore only the originally enabled mapping",async()=>{
  const {service,operation,external}=fixture();
  const issued=await service.issueConfirmation("op-recovery","operator-1");
  assert.equal(issued.confirmationId,"fresh-recovery-token");
  assert.equal(issued.preview.allowed,true);
  await assert.rejects(service.apply("op-recovery",issued.confirmationId,"other-operator"),/expired, changed, or consumed/);
  await service.apply("op-recovery",issued.confirmationId,"operator-1");
  await assert.rejects(service.apply("op-recovery",issued.confirmationId,"operator-1"),/consumed/);
  assert.equal((await service.process("op-recovery")).status,"restoring");
  const restored=await service.process("op-recovery");
  assert.equal(restored.retry,true);
  assert.deepEqual(external.restored,[enabledId]);
  assert.equal(external.mappingStates.get(disabledId),"Disabled");
  assert.equal((await service.process("op-recovery")).status,"verifying");
  const completed=await service.process("op-recovery");
  assert.deepEqual(completed,{status:"completed",retry:false});
  assert.equal(operation.status,"review_required","original erasure remains immutable review evidence");
  assert.equal(operation.recovery.status,"completed");
  assert.equal(external.control.some(x=>x.sk==="FENCE"),false);
  assert.equal(external.control.find(x=>x.sk==="EPOCH").epoch,7,"monotonic epoch cannot be decremented");
  assert.equal((await service.process("op-recovery")).status,"completed","queue replay is an identity-free no-op");
});

test("missing fence, changed fence owner, leases, missing epoch and changed UUID inventory refuse confirmation without writes",async()=>{
  for(const alter of [
    f=>f.external.control.splice(0,1),
    f=>{f.external.control[0].operationId="different-owner";},
    f=>f.external.control.push({pk:"ERASURE#work",sk:"WRITER#late",owner:"late"}),
    f=>f.external.control.splice(1,1),
    f=>{f.external.mappingInventory=[enabledId];},
    f=>f.external.mappingStates.set(disabledId,"Enabled"),
    f=>{f.operation.lifecycle.evidence.fenceInstalled.operationId="wrong";},
  ]) {
    const f=fixture();alter(f);
    const preview=await f.service.inspect("op-recovery");
    assert.equal(preview.preview.allowed,false,JSON.stringify(preview.preview.blockers));
    assert.ok(preview.preview.blockers.length);
    await assert.rejects(f.service.issueConfirmation("op-recovery","operator"),/blocked/);
    assert.equal(f.external.writes.length,0);
  }
});

test("partial deletion, changed snapshot, and completed provider deletion remain fenced",async()=>{
  for(const mutate of [
    f=>f.external.snapshot.previewFingerprint="f".repeat(64),
    f=>f.external.snapshot.blockers=["linked recurrence"],
    f=>{f.operation.lifecycle.phase="delete";f.operation.lifecycle.deletionProgress={stage:"todoist",commentIndex:0,stateIndex:0,startedAt:5};},
    f=>{f.external.snapshot.actionPlan={comments:[]};f.external.snapshot.inventory=[];},
  ]) {
    const f=fixture();mutate(f);
    const preview=await f.service.inspect("op-recovery");
    assert.equal(preview.preview.allowed,false);
    assert.equal(f.external.writes.length,0);
    assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
  }
});

test("issued token is invalid when epoch or provider inventory changes before action-time CAS",async()=>{
  const f=fixture();
  const confirmed=await f.service.issueConfirmation("op-recovery","operator");
  f.external.control.find(x=>x.sk==="EPOCH").epoch=8;
  await assert.rejects(f.service.apply("op-recovery",confirmed.confirmationId,"operator"),/drifted/);
  assert.equal(f.operation.recovery,undefined);
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
});

test("lease arrival, state drift and conflicting release transaction never remove the profile fence",async()=>{
  for(const alter of [
    f=>f.external.control.push({pk:"ERASURE#work",sk:"ADMISSION#late",owner:"late"}),
    f=>f.external.snapshot.providerSnapshotFingerprint="bad",
    f=>f.external.mappingInventory=[],
  ]) {
    const f=fixture();
    const confirmed=await f.service.issueConfirmation("op-recovery","operator");
    await f.service.apply("op-recovery",confirmed.confirmationId,"operator");
    alter(f);
    const result=await f.service.process("op-recovery");
    assert.equal(result.status,"blocked");
    assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
    assert.equal(f.operation.recovery.status,"blocked");
  }
  const f=fixture({failRelease:true});
  const confirmed=await f.service.issueConfirmation("op-recovery","operator");
  await f.service.apply("op-recovery",confirmed.confirmationId,"operator");
  await f.service.process("op-recovery");
  await f.service.process("op-recovery");
  await f.service.process("op-recovery");
  await assert.rejects(f.service.process("op-recovery"),/Transaction race/);
  assert.equal(f.operation.recovery.status,"verifying");
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
});

test("mapping enablement can remain transitional without prematurely releasing the fence",async()=>{
  const f=fixture({enabling:true});
  const issued=await f.service.issueConfirmation("op-recovery","operator");
  await f.service.apply("op-recovery",issued.confirmationId,"operator");
  await f.service.process("op-recovery");
  await f.service.process("op-recovery");
  assert.deepEqual(await f.service.process("op-recovery"),{status:"restoring",retry:true});
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
  f.external.mappingStates.set(enabledId,"Enabled");
  assert.equal((await f.service.process("op-recovery")).status,"verifying");
  assert.equal((await f.service.process("op-recovery")).status,"completed");
});


test("recovery eligibility is phase-specific and never resumes already begun provider deletion",async()=>{
  const phases=[
    ["disable_mappings",false],["confirm_disabled",false],["drain_before_fence",false],
    ["install_fence",false],["wait_worker_timeout",true],["drain_after_timeout",true],
    ["ready_for_delete",true],["delete",false],["verify_deletion",false],
    ["restore_mappings",false],["confirm_restored",false],["release_fence",false],
  ];
  for(const [phase,allowed] of phases){
    const f=fixture();
    f.operation.lifecycle.phase=phase;
    if(["drain_after_timeout","ready_for_delete"].includes(phase))
      f.operation.lifecycle.evidence.workerTimeoutElapsed={
        operationId:"op-recovery",phase:"workerTimeoutElapsed",
        receiptId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",completedAt:2000};
    if(phase==="ready_for_delete")
      f.operation.lifecycle.evidence.postTimeoutDrain={
        operationId:"op-recovery",phase:"postTimeoutDrain",
        receiptId:"ffffffff-ffff-4fff-8fff-ffffffffffff",completedAt:3000};
    if(["delete","verify_deletion","restore_mappings","confirm_restored","release_fence"].includes(phase))
      f.operation.lifecycle.evidence.deletionStarted={
        operationId:"op-recovery",phase:"deletionStarted",
        receiptId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",completedAt:2000};
    const inspection=await f.service.inspect("op-recovery");
    assert.equal(inspection.preview.allowed,allowed,"phase "+phase);
    assert.equal(f.external.writes.length,0,"read-only for phase "+phase);
  }
});

test("transport read failures, stale confirmations and missing operation never turn into permission to unlock",async()=>{
  const f=fixture();
  f.external.snapshot.blockers=["Calendar ETag mismatch"];
  const preview=await f.service.inspect("op-recovery");
  assert.equal(preview.preview.allowed,false);
  assert.ok(f.external.control.some(x=>x.sk==="FENCE"));
  const missing=fixture();
  await assert.rejects(missing.service.inspect("not-our-operation"),/not found/);
  const stale=fixture();
  const issued=await stale.service.issueConfirmation("op-recovery","operator");
  stale.confirmation.expiresAtMs=Date.now()-1000;
  await assert.rejects(stale.service.apply("op-recovery",issued.confirmationId,"operator"),/expired/);
  assert.equal(stale.operation.recovery,undefined);
});


test("recovery cannot restore mappings until the original worker timeout has elapsed",async()=>{
  const f=fixture();
  f.operation.lifecycle.evidence.fenceInstalled.completedAt=Date.now()-5_000;
  const inspection=await f.service.inspect("op-recovery");
  assert.equal(inspection.preview.allowed,false);
  assert.match(inspection.preview.blockers.join(" "),/worker timeout/i);
  assert.equal(f.external.writes.length,0);
});

test("phase escalation cannot bypass durable timeout and lease-drain receipts",async()=>{
  for(const phase of ["drain_after_timeout","ready_for_delete"]){
    const f=fixture();
    f.operation.lifecycle.phase=phase;
    const inspected=await f.service.inspect("op-recovery");
    assert.equal(inspected.preview.allowed,false);
    assert.match(inspected.preview.blockers.join(" "),/durable receipt/i);
    assert.equal(f.external.writes.length,0);
  }
});

test("read-only structured diagnostics verify every pre-write condition without issuing writes",async()=>{
  const {service,external}=fixture();
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.classification,"pre_write");
  assert.ok(Object.values(inspected.preview.diagnostics).every(value=>value==="verified"));
  assert.equal(external.writes.length,0);
});

test("ready-for-delete without deletion can still be blocked solely by provider snapshot drift",async()=>{
  const {service,operation,external}=fixture();
  const receipt=phase=>({operationId:"op-recovery",phase,receiptId,completedAt:2000});
  operation.lifecycle.phase="ready_for_delete";
  operation.lifecycle.evidence.workerTimeoutElapsed=receipt("workerTimeoutElapsed");
  operation.lifecycle.evidence.postTimeoutDrain=receipt("postTimeoutDrain");
  external.snapshot={...external.snapshot,providerSnapshotFingerprint:"9".repeat(64)};
  external.snapshot.previewFingerprint=erasurePreviewFingerprint(external.snapshot);
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.allowed,false);
  assert.equal(inspected.preview.classification,"partial_or_ambiguous");
  assert.equal(inspected.preview.diagnostics.lifecycle,"verified","no deletion was started");
  assert.equal(inspected.preview.diagnostics.originalProviderSnapshot,"mismatched");
  assert.equal(inspected.preview.diagnostics.operationFingerprint,"mismatched");
  assert.equal(external.writes.length,0);
});

test("missing fence, epoch and live mapping drift are classified independently",async()=>{
  const {service,external}=fixture();
  external.control=external.control.filter(row=>!["FENCE","EPOCH"].includes(row.sk));
  external.mappingInventory=[enabledId];
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.allowed,false);
  assert.equal(inspected.preview.diagnostics.fence,"missing");
  assert.equal(inspected.preview.diagnostics.epoch,"missing");
  assert.equal(inspected.preview.diagnostics.mappingInventory,"mismatched");
  assert.equal(inspected.preview.diagnostics.workerLeases,"verified");
  assert.equal(external.writes.length,0);
});

test("active leases are independently marked mismatched and block admission",async()=>{
  const {service,external}=fixture();
  external.control.push({pk:"ERASURE#work",sk:"ADMISSION#ongoing",operationId:"another"});
  const inspected=await service.inspect("op-recovery");
  assert.equal(inspected.preview.diagnostics.workerLeases,"mismatched");
  assert.equal(inspected.preview.allowed,false);
  assert.equal(external.writes.length,0);
});

test("provider authentication failure never generates a diagnostic success or write",async()=>{
  const {service,external}=fixture();
  service.adapters.readSnapshot=async()=>{
    throw Object.assign(new Error("Provider request failed: 401 https://api.todoist.com/"),{status:401});
  };
  await assert.rejects(service.inspect("op-recovery"),/401/);
  assert.equal(external.writes.length,0);
});


test("read-only inspection exposes exact tombstone and checkpoint comparisons without issuing tokens or releasing fence",async()=>{
  const f=timedOutProjectCommentFixture();
  f.external.snapshot.projectTombstone={
    status:"present",recordedCommentFound:true,markerMatchesTaskAndCalendar:true,
    recordedCommentCount:1,foundCommentCount:1,explanation:"Exact bounded marker matches"};
  const inspection=await f.service.inspect("op-recovery");
  assert.equal(inspection.preview.projectTombstone.status,"present");
  assert.ok(inspection.preview.comparisonDetails.comments);
  assert.ok(inspection.preview.comparisonDetails.projectCommentIds);
  assert.ok(inspection.preview.comparisonDetails.stateInventory);
  assert.equal(f.external.writes.length,0);
  assert.equal(f.external.restored.length,0);
  assert.ok(f.external.control.some(item=>item.sk==="FENCE"),"the profile fence is untouched");
  assert.equal(f.confirmation,undefined);
});
