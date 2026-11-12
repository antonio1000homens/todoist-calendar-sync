import test from "node:test";
import assert from "node:assert/strict";
import { cleanVerifiedDeletedCase } from "../dist/historical-cleanup.js";
import { ReviewStore, assertManualDecisionReplayAdmission, assertRepairPreviewReplayAdmission } from "../dist/review-store.js";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { erasurePreviewFingerprint } from "../dist/erasure-executor.js";
import { projectDeletionTombstoneExpiry, serializeDeletionTombstoneComment } from "../dist/mapping-comments.js";

const taskId="historical-task",eventId="historical-event",projectId="test-work-project";
const item={id:"work-standalone_todoist_task_deleted-fixture",profile:"work",title:"Deleted pair",reason:"deleted",status:"open",taskId,eventId,
  decision:{type:"standalone_todoist_task_deleted",taskId,eventId},createdAt:"2026-11-12T00:00:00.000Z",updatedAt:"v1"};
const ownedComment=()=>({id:"comment-1",project_id:projectId,content:`todoist-calendar-sync:mapping:v1\n${JSON.stringify({schemaVersion:1,profile:"work",projectId,taskId,eventId,mappingRevision:1,updatedAt:"2026-11-11T00:00:00.000Z"})}`});
function harness({event={id:eventId,status:"cancelled",htmlLink:"https://calendar.test/event"},calendarEvents,instances=[],recurrenceLink,
  caseItem=item,comments=[ownedComment()],taskExists=false,changedComment=false,reviewStore}={}){
  const calendarState=new Map(calendarEvents||[[eventId,event]]);
  let currentComments=[...comments],calendarUpdates=0,taskDeletes=0,eventDeletes=0,creations=0,closed=0;
  let commentReadChanged=changedComment;
  const todoist={
    listProjectComments:async()=>currentComments.map(x=>({...x})),
    getComment:async id=>{const found=currentComments.find(x=>x.id===id);if(!found)throw Object.assign(new Error("gone"),{status:404});return commentReadChanged?{...found,content:"user changed this"}:{...found};},
    deleteComment:async id=>{currentComments=currentComments.filter(x=>x.id!==id);},
    findLegacyTaskComment:async()=>undefined,
    deleteTask:async()=>{taskDeletes++;},createTask:async()=>{creations++;},
  };
  const calendar={getEvent:async id=>{const value=calendarState.get(id);if(!value)throw Object.assign(new Error("gone"),{status:404});return {...value,extendedProperties:structuredClone(value.extendedProperties||{})};},
    listEventInstances:async()=>instances,
    updateSharedEventPropertiesIfUnchanged:async(id,etag,patch)=>{calendarUpdates++;const value=calendarState.get(id);for(const key of Object.keys(patch))delete value.extendedProperties.shared[key];value.etag="etag-2";},
    deleteEvent:async()=>{eventDeletes++;},createEvent:async()=>{creations++;}};
  let checkpoint,lastExpected,resolvedCase,recurrenceRemoved=false;
  const store=reviewStore||{
    inventoryVerifiedDeletedMappings:async()=>[],
    getCase:async()=>resolvedCase||caseItem,
    prepareHistoricalCaseRetirement:async(_case,expected)=>{
      lastExpected=expected;
      assert.deepEqual(expected.taskIds,[taskId]);
      assert.ok(expected.eventIds.includes(eventId));
      return {resourceKeys:[],commit:async authorize=>{
        await authorize();
        closed++;
        recurrenceRemoved=true;
        resolvedCase={...caseItem,status:"resolved",result:"resolved_deleted: both provider objects verified absent; stale conflict retired",taskId:undefined,eventId:undefined,decision:undefined};
        return true;
      }};
    },
  };
  store.getHistoricalCleanupCheckpoint=async()=>checkpoint;
  store.saveHistoricalCleanupCheckpoint=async input=>{
    checkpoint={...(checkpoint||{}),...input.patch,fingerprint:input.fingerprint,leaseOwner:input.owner};
    if(input.release)checkpoint.leaseUntil=0;
    return true;
  };
  const engine={snapshot:async ref=>({object:ref.side==="todoist"?(taskExists?{id:taskId}:null):calendarState.get(ref.id)}),clients:async()=>({todoist,calendar}),state:{
    getMappingByTask:async()=>undefined,getMappingByTaskAnyProfile:async()=>undefined,getMappingByEvent:async()=>undefined,
    getRecurrenceLink:async(profile,seriesId)=>!recurrenceRemoved&&recurrenceLink?.profile===profile&&recurrenceLink.seriesId===seriesId?recurrenceLink:undefined,
    getCompletedCalendarProjectionByEvent:async()=>undefined,
  }};
  return {input:{item:caseItem,store,engine},setComments:value=>{currentComments=value;},setCommentReadChanged:value=>{commentReadChanged=value;},get state(){return{currentComments,calendarUpdates,taskDeletes,eventDeletes,creations,closed,calendarState,lastExpected,checkpoint};}};
}

test("offline Work deleted-pair fixture clears exact comment and retires case without provider task/event deletion",async()=>{
  const f=harness();
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.equal(result.deletedComments,1);
  assert.equal(f.state.currentComments.length,0);
  assert.equal(f.state.calendarUpdates,0,"cancelled events are never patched");
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
  assert.equal(f.state.closed,1);
});

test("a foreign user comment is preserved while the exact app mapping is removed",async()=>{
  const foreign={id:"user-note",project_id:projectId,content:"My note about this task"};
  const f=harness({comments:[ownedComment(),foreign]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.deepEqual(f.state.currentComments,[foreign]);
});

test("changed app comment blocks closure and leaves the case open",async()=>{
  const f=harness({changedComment:true});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"blocked");
  assert.equal(result.blocker,"todoist_mapping_comment_changed");
  assert.equal(f.state.closed,0);
});

test("a blocked attempt releases its exact checkpoint for a safe retry",async()=>{
  const f=harness({changedComment:true});
  const first=await cleanVerifiedDeletedCase(f.input);
  assert.equal(first.status,"blocked");
  assert.equal(first.blocker,"todoist_mapping_comment_changed");
  assert.equal(f.state.checkpoint.status,"retryable");
  assert.equal(f.state.currentComments.length,1);
  f.setCommentReadChanged(false);
  const retry=await cleanVerifiedDeletedCase(f.input);
  assert.equal(retry.status,"complete");
  assert.equal(retry.deletedComments,1);
  assert.equal(f.state.currentComments.length,0);
  assert.equal(f.state.closed,1);
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
});

test("unrelated case types cannot use historical cleanup even when provider IDs are present",async()=>{
  const f=harness({caseItem:{...item,decision:{type:"calendar_owned_task_deleted",taskId,eventId}}});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"blocked");
  assert.equal(result.blocker,"case_type_not_eligible_for_historical_cleanup");
  assert.equal(f.state.currentComments.length,1);
  assert.equal(f.state.closed,0);
});

test("retained live one-off event loses only task link properties with ETag readback",async()=>{
  const event={id:eventId,status:"confirmed",etag:"etag-1",summary:"Keep this event",description:"User content",
    extendedProperties:{shared:{taskId,taskUrl:"https://todoist.test/task",originalSummary:"Old summary",syncMarker:"owned",userField:"keep"},private:{userPrivate:"keep"}}};
  const f=harness({event,comments:[]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.equal(f.state.calendarUpdates,1);
  assert.equal(event.summary,"Keep this event");
  assert.deepEqual(event.extendedProperties.shared,{userField:"keep"});
  assert.deepEqual(event.extendedProperties.private,{userPrivate:"keep"});
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
});

test("a live event with foreign task ownership is a hard blocker",async()=>{
  const f=harness({event:{id:eventId,status:"confirmed",etag:"etag-1",extendedProperties:{shared:{taskId:"other-task"}}},comments:[]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"blocked");
  assert.equal(result.blocker,"calendar_link_provenance_ambiguous");
  assert.equal(f.state.closed,0);
});

test("verified cancelled recurrence retires only the exact Todoist-owned link after full instance inventory",async()=>{
  const masterId="master-1",seriesId="ical-series-1";
  const master={id:masterId,status:"cancelled",etag:"master-etag",iCalUID:seriesId,recurrence:["RRULE:FREQ=WEEKLY;COUNT=2"]};
  const active={id:eventId,status:"cancelled",etag:"active-etag",recurringEventId:masterId,iCalUID:seriesId};
  const recurrenceLink={profile:"work",owner:"todoist",seriesId:taskId,taskId,eventId,masterEventId:masterId,activeInstanceId:eventId,updatedAt:"2026-11-11T00:00:00.000Z"};
  const recurrenceCase={...item,eventId:undefined,decision:{type:"todoist_owned_recurrence_task_deleted",taskId,eventId,
    masterEventId:masterId,activeInstanceId:eventId,seriesId:taskId,mappingSnapshot:{profile:"work",taskId,eventId,
      masterEventId:masterId,activeInstanceId:eventId,seriesId:taskId}}};
  const f=harness({caseItem:recurrenceCase,calendarEvents:[[masterId,master],[eventId,active]],instances:[active],recurrenceLink,comments:[]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete");
  assert.equal(f.state.lastExpected.staleLinks.length,1);
  assert.equal(f.state.lastExpected.staleLinks[0].seriesId,taskId);
  assert.deepEqual(f.state.lastExpected.seriesKeys.sort(),[taskId,eventId,masterId,seriesId].sort());
  assert.equal(f.state.calendarUpdates,0);
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations,0);
});


function deletionMarker(overrides={}) {
  const createdAt=new Date(Date.now()-60_000).toISOString();
  return {id:"retained-marker",project_id:projectId,content:serializeDeletionTombstoneComment({
    schemaVersion:1,profile:"work",projectId,taskId,eventIds:[eventId],
    createdAt,expiresAt:projectDeletionTombstoneExpiry(createdAt),...overrides,
  })};
}

function erasureOperation({aliases=[], projectCommentIds=["active-erasure-comment"], inventory=[]}={}) {
  const erasureEvent="independent-event",calendarId="work@example.test";
  const operation={
    operationId:"independent-erasure",profile:"work",status:"review_required",updatedAt:"fixture-revision",
    target:{taskId:"independent-task",eventId:erasureEvent,deleteCalendar:true},
    selectedActions:{deleteTodoist:true,deleteCalendar:true},inventory,
    providerSnapshotFingerprint:"fixture-provider-state",
    lifecycle:{evidence:{fenceInstalled:{completedAt:1}}},
    actionPlan:{
      calendarEvent:{id:erasureEvent,calendarId,digest:"a".repeat(64),etag:"fixture-etag"},
      knownCalendarAliases:[{profile:"work",eventId:erasureEvent,calendarId},...aliases],
      knownCalendarAliasesComplete:true,projectCommentIds,comments:[],
    },
  };
  const fingerprint=erasurePreviewFingerprint(operation);
  return {...operation,previewFingerprint:fingerprint,confirmationFingerprint:fingerprint};
}

function fencedFixture(t,{operation=erasureOperation(), marker=deletionMarker(), caseItem=item,
  currentCase=caseItem, stateRows=[], partialInventory=false, loseAcknowledgment=false, failCondition}={}) {
  t.mock.method(documentClient,"send",async command=>{
    assert.equal(command.input.Key.sk,"EPOCH");
    return {Item:{epoch:7}};
  });
  const storedCaseKey=`REVIEW_CASE#${caseItem.id}`;
  const transactions=[];
  let storedCase={...currentCase,pk:storedCaseKey,sk:"STATE"};
  const keyOf=({pk,sk})=>pk+"|"+sk;
  const rows=new Map(stateRows.map(row=>[keyOf(row),row]));
  const store=new ReviewStore({async send(command){
    const {input}=command;
    switch(command.constructor.name){
      case "GetCommand":
        return {Item:structuredClone(input.Key.pk===storedCaseKey?storedCase:rows.get(keyOf(input.Key)))};
      case "QueryCommand":
        return {Items:[]};
      case "ScanCommand":
        if(partialInventory)return {Items:[],LastEvaluatedKey:{pk:"more",sk:"rows"}};
        return {Items:structuredClone([storedCase,...rows.values()])};
      case "TransactWriteCommand": {
        transactions.push(input.TransactItems);
        const failed=input.TransactItems.findIndex(operation=>
          (operation.ConditionCheck?.Key.sk||operation.Update?.Key.pk)===failCondition);
        if(failCondition&&failed>=0){
          const error=new Error("synthetic conditional failure");
          error.name="TransactionCanceledException";
          error.CancellationReasons=input.TransactItems.map((_,index)=>({Code:index===failed?"ConditionalCheckFailed":"None"}));
          throw error;
        }
        const update=input.TransactItems.find(operation=>operation.Update?.Key.pk===storedCaseKey).Update;
        assert.equal(update.ExpressionAttributeValues[":version"],storedCase.updatedAt);
        storedCase={...storedCase,status:"resolved",result:update.ExpressionAttributeValues[":result"],
          taskId:undefined,eventId:undefined,decision:undefined};
        for (const operation of input.TransactItems) if (operation.Delete) rows.delete(keyOf(operation.Delete.Key));
        if(loseAcknowledgment)throw new Error("lost terminal acknowledgement");
        return {};
      }
      default:
        throw new Error("Unexpected offline database call "+command.constructor.name);
    }
  }});
  const f=harness({caseItem,reviewStore:store,comments:[ownedComment(),marker]});
  const scopes=[];
  f.input.fencedErasure=operation;
  f.input.acquireScopedAdmission=async request=>{
    assert.equal(request.epoch,7);
    assert.equal(transactions.length,0,"preflight never commits");
    assert.equal(f.state.checkpoint,undefined,"preflight never starts cleanup");
    scopes.push(request.scope);
    return {owner:"scoped-owner",fingerprint:request.scope.fingerprint,
      assertActive:async()=>4, release:async()=>{}};
  };
  return {f,rows,transactions,scopes};
}

test("a disjoint fenced cleanup retires the selected case and preserves the exact replay tombstone",async t=>{
  const previous=process.env.ERASURE_PROTOCOL_VERSION;
  process.env.ERASURE_PROTOCOL_VERSION="1";
  t.after(()=>{if(previous===undefined)delete process.env.ERASURE_PROTOCOL_VERSION;else process.env.ERASURE_PROTOCOL_VERSION=previous;});
  const marker=deletionMarker();
  const sourceAuditKey="AUDIT#work#historical-source";
  const unrelatedAuditKey="AUDIT#work#unrelated-source";
  const mappingKey=`TASK#work#${taskId}|MAP`;
  const {f,rows,scopes,transactions}=fencedFixture(t,{marker,caseItem:{...item,sourceAuditKey},stateRows:[
    {pk:sourceAuditKey,sk:"STATE",action:"deletion_review",createdAt:"fixture-revision",detail:{taskId,eventId}},
    {pk:unrelatedAuditKey,sk:"STATE",action:"deletion_review",createdAt:"fixture-revision",detail:{taskId:"unrelated-task"}},
    {pk:`TASK#work#${taskId}`,sk:"MAP",profile:"work",taskId,eventId,updatedAt:"fixture-revision"},
  ]});
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.status,"complete",result.blocker);
  assert.equal(result.deletedComments,1);
  assert.deepEqual(f.state.currentComments,[marker]);
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations+f.state.calendarUpdates,0);
  assert.ok(scopes[0].projectCommentIds.includes(marker.id));
  assert.ok(scopes[0].resourceKeys.includes(`REVIEW_CASE#${item.id}|STATE`));
  assert.ok(scopes[0].resourceKeys.includes(mappingKey));
  assert.ok(scopes[0].resourceKeys.includes(sourceAuditKey+"|STATE"));
  assert.deepEqual([...rows.keys()],[unrelatedAuditKey+"|STATE"]);
  assert.equal(transactions.length,1);
  const checks=transactions[0].flatMap(operation=>operation.ConditionCheck?[operation.ConditionCheck]:[]);
  assert.equal(checks.find(check=>check.Key.sk==="EPOCH").ExpressionAttributeValues[":epoch"],7);
  assert.equal(checks.find(check=>check.Key.sk==="FENCE").ExpressionAttributeValues[":operationId"],"independent-erasure");
  assert.equal(checks.find(check=>check.Key.sk==="SCOPED_ADMISSION").ExpressionAttributeValues[":version"],4);
  assert.equal(checks.find(check=>check.Key.sk==="OP").ExpressionAttributeValues[":owner"],f.state.checkpoint.leaseOwner);

  const clientFactory=async()=>({todoist:{listProjectComments:async()=>f.state.currentComments}});
  await assert.rejects(assertManualDecisionReplayAdmission({profile:"work",taskId},clientFactory),{name:"ErasureReplayBlockedError"});
  await assert.rejects(assertRepairPreviewReplayAdmission({intent:{profile:"work",eventId},snapshots:[],itemPlan:[]},clientFactory),
    {name:"ErasureReplayBlockedError"});
});

test("the fence's tombstone, a cross-profile alias, a shared comment and a planned state key each block before writes",async t=>{
  const fixtures=[
    [erasureOperation({projectCommentIds:["retained-marker"]}),"protected_erasure_tombstone"],
    [erasureOperation({aliases:[{profile:"home",calendarId:"home@example.test",eventId}]}),"shared_erasure_identity"],
    [erasureOperation({projectCommentIds:["comment-1"]}),"shared_project_comment"],
    [erasureOperation({inventory:[{type:"REVIEW_CASE",key:{pk:`REVIEW_CASE#${item.id}`,sk:"STATE"},
      digest:"fixture-digest",classification:"shared with protected state"}]}),"shared_audit_record"],
  ];
  for(const [operation,blocker] of fixtures){
    await t.test(blocker,async subtest=>{
      const {f,scopes,transactions}=fencedFixture(subtest,{operation});
      const result=await cleanVerifiedDeletedCase(f.input);
      assert.equal(result.blocker,blocker);
      assert.equal(result.cleanupStarted,false);
      assert.equal(scopes.length+transactions.length,0);
      assert.equal(f.state.checkpoint,undefined);
      assert.deepEqual(f.state.currentComments.map(comment=>comment.id),["comment-1","retained-marker"]);
    });
  }
});

test("partial inventories, stale selections and unverified nested aliases fail before scoped admission",async t=>{
  const nestedCase={...item,decision:{...item.decision,context:{previousEventId:"unverified-calendar-alias"}}};
  for(const [options,blocker] of [
    [{partialInventory:true},"delivery_receipt_inventory_over_limit"],
    [{currentCase:{...item,updatedAt:"new-revision"}},"case_status_revision_or_operation_changed"],
    [{caseItem:nestedCase},"nested_case_identity_unverified"],
    [{marker:deletionMarker({eventIds:[eventId,"unverified-marker-alias"]})},"protected_erasure_tombstone"],
  ]){
    await t.test(blocker,async subtest=>{
      const {f,scopes,transactions}=fencedFixture(subtest,options);
      const result=await cleanVerifiedDeletedCase(f.input);
      assert.equal(result.blocker,blocker);
      assert.equal(result.cleanupStarted,false);
      assert.equal(scopes.length+transactions.length,0);
      assert.equal(f.state.currentComments.length,2);
    });
  }
});

test("marker inventory changes between read-only planning and scoped writes fail closed",async t=>{
  const marker=deletionMarker();
  const {f,transactions}=fencedFixture(t,{marker});
  const acquire=f.input.acquireScopedAdmission;
  f.input.acquireScopedAdmission=async input=>{
    const scope=await acquire(input);
    f.setComments([ownedComment()]);
    return scope;
  };
  const result=await cleanVerifiedDeletedCase(f.input);
  assert.equal(result.blocker,"erasure_tombstone_inventory_changed");
  assert.equal(result.cleanupStarted,false);
  assert.equal(transactions.length,0);
  assert.equal(f.state.checkpoint,undefined);
  assert.deepEqual(f.state.currentComments,[ownedComment()]);
});

test("case revision and epoch drift at the terminal CAS leave the selected case open",async t=>{
  for(const [failCondition,blocker] of [
    [`REVIEW_CASE#${item.id}`,"case_revision_or_status_changed_retry_required"],
    ["EPOCH","fence_or_scoped_admission_changed_retry_required"],
  ]){
    await t.test(blocker,async subtest=>{
      const marker=deletionMarker();
      const {f,transactions}=fencedFixture(subtest,{marker,failCondition});
      const result=await cleanVerifiedDeletedCase(f.input);
      assert.equal(result.blocker,blocker);
      assert.equal(transactions.length,1);
      assert.equal((await f.input.store.getCase(item.id)).status,"open");
      assert.deepEqual(f.state.currentComments,[marker]);
    });
  }
});

test("a lost terminal acknowledgement can retry the resolved case without replaying provider writes",async t=>{
  const marker=deletionMarker();
  const {f,transactions}=fencedFixture(t,{marker,loseAcknowledgment:true});
  const first=await cleanVerifiedDeletedCase(f.input);
  assert.equal(first.status,"blocked");
  assert.equal(first.deletedComments,1);
  const latest=await f.input.store.getCase(item.id);
  assert.equal(latest.status,"resolved");
  const retry=await cleanVerifiedDeletedCase({...f.input,item:latest});
  assert.equal(retry.status,"complete");
  assert.equal(transactions.length,1);
  assert.deepEqual(f.state.currentComments,[marker]);
  assert.equal(f.state.taskDeletes+f.state.eventDeletes+f.state.creations+f.state.calendarUpdates,0);
});
