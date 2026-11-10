import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { serializeMappingComment } from "../dist/mapping-comments.js";
import { executePhaseBNativeMove, inspectPhaseBNativeMove } from "../dist/todoist-phase-b-native-move-executor.js";
import { phaseBNativeMoveStage } from "../dist/todoist-phase-b-move-handoff.js";
import { inspectInterruptedPhaseBNativeMove, completeVerifiedPhaseBNativeMoveStage } from "../dist/todoist-phase-b-native-move-recovery.js";

const home=profiles.home.todoistProjectId,work=profiles.work.todoistProjectId;
const currentDue="2027-04-10",oldStart="2027-01-10";
const firstThree=["2027-04-10","2027-07-10","2027-10-10"];
const tomorrow=(date)=>new Date(Date.parse(date+"T00:00:00Z")+86400000).toISOString().slice(0,10);
const occurrence=(id,masterId,date,title="Native trial",description="Disposable")=>({
  id,recurringEventId:masterId,status:"confirmed",
  originalStartTime:{date},start:{date},end:{date:tomorrow(date)},summary:title,description,
});
function fixture(options={}){
  const task={id:"disposable-phase-b-native",project_id:work,
    content:"Native trial",description:"Disposable",updated_at:"2027-02-15T10:00:00Z",
    due:{date:currentDue,string:"every quarter",is_recurring:true}};
  const sourceMaster={id:"source-master",status:"confirmed",etag:"etag-source-v1",
    summary:task.content,description:task.description,start:{date:oldStart},
    end:{date:tomorrow(oldStart)},recurrence:["RRULE:FREQ=MONTHLY;INTERVAL=3"],
    extendedProperties:{shared:{taskId:task.id,syncRecurrenceOwner:"todoist",
      todoistPhaseBVersion:"1",todoistAnchorStart:oldStart,
      todoistAnchorEnd:tomorrow(oldStart),todoistAnchorTimeZone:"Europe/London",
      todoistRecurrence:"every quarter"}}};
  const mapping={profile:"home",taskId:task.id,projectId:home,eventId:sourceMaster.id,
    masterEventId:sourceMaster.id,seriesId:task.id,recurrenceOwner:"todoist",
    activeInstanceId:"source-apr",originalStart:currentDue,
    activeEffectiveStart:currentDue,todoistPhaseBVersion:1,updatedAt:"2027-02-15T10:01:00Z",
    projectCommentId:"source-comment"};
  const link={profile:"home",taskId:task.id,eventId:sourceMaster.id,
    masterEventId:sourceMaster.id,seriesId:task.id,owner:"todoist",
    activeInstanceId:"source-apr",originalStart:currentDue,
    activeEffectiveStart:currentDue,updatedAt:"2027-02-15T10:02:00Z"};
  const originalHistory=[occurrence("source-jan",sourceMaster.id,oldStart)];
  let sourceVersion=structuredClone(sourceMaster),destinationVersion;
  let sourceComments=[{id:"source-comment",project_id:home,content:serializeMappingComment(mapping,home)}];
  let destinationComments=[];
  const calls=[],audits=[],state={
    stage:false,stagePayload:null,mapping,link,committed:false,approveCommit:false,
    async getPhaseBNativeMoveStage(){return this.stage?this.stagePayload:undefined;},
    async phaseBNativeMoveControlsMatch(stage){
      return this.stage && this.stagePayload?.operationId===stage.operationId && !options.missingControl;
    },
    async getMappingByTaskAnyProfile(){return this.mapping;},
    async getRecurrenceLink(profile){return this.link?.profile===profile?this.link:undefined;},
    async getCalendarProjectionTombstone(){return undefined;},
    async syncBlocked(){return false;},
    async mutationAllowed(){return !options.erasureBlocked;},
    async beginPhaseBNativeMove(input){
      calls.push("stage");
      this.stage=true;
      this.stagePayload=phaseBNativeMoveStage(input);
      if(options.staleAfterStage)sourceVersion.etag="other-etag";
      return "claimed";
    },
    async commitPhaseBNativeMoveIfUnchanged(input){
      calls.push("commit");
      if(options.rejectCommit&&!this.approveCommit)return false;
      this.mapping=input.destinationMapping;this.link=input.destinationLink;
      this.stage=false;this.committed=true;return true;
    },
    async recordMutation(profile){calls.push("budget:"+profile);},
    async audit(profile,action,detail){audits.push({profile,action,detail});},
  };
  const srcTodoist={
    async getTask(){return structuredClone(task);},
    async listProjectComments(){return structuredClone(sourceComments);},
    async deleteComment(id){
      calls.push("delete-source-comment");
      if(options.failSourceComment)throw new Error("Todoist source comment 403");
      sourceComments=sourceComments.filter(c=>c.id!==id);
    },
  };
  const dstTodoist={
    async getTask(){return structuredClone(task);},
    async getTimeZone(){return options.badTimezone?"UTC":"Europe/London";},
    async listProjectComments(){return structuredClone(destinationComments);},
    async upsertComment(taskId,content,id,draft){
      calls.push("destination-comment");
      destinationComments=[{id:"destination-comment",project_id:work,
        content:serializeMappingComment(draft,work)}];
      if(options.duplicateComment)destinationComments.push({...destinationComments[0],id:"duplicate"});
      return {id:"destination-comment"};
    },
  };
  const srcCalendar={
    async getTimeZone(){return "Europe/London";},
    async getEvent(){calls.push("source-get");return structuredClone(sourceVersion);},
    async listInstancesInWindow(id,start,end){
      calls.push("source-history");
      if(start>=currentDue)return sourceVersion.recurrence[0].includes("UNTIL=")
        ? (options.futureNotCapped?[occurrence("future",id,currentDue)]:[])
        : [occurrence("future",id,currentDue)];
      if(options.historyMissingAfterCap&&sourceVersion.recurrence[0].includes("UNTIL="))return [];
      return structuredClone(originalHistory);
    },
    async listExplicitSeriesExceptions(){return options.sourceException
      ?[{id:"cancelled-exception",recurringEventId:sourceMaster.id,status:"cancelled"}]:[];},
    async upsertEventIfUnchanged(event,id,etag){
      calls.push("cap-source");
      if(options.failCap)throw new Error("412 source ETag conflict");
      assert.equal(etag,"etag-source-v1");
      sourceVersion={...structuredClone(event),etag:"source-capped",status:"confirmed"};
      return structuredClone(sourceVersion);
    },
  };
  const dstCalendar={
    async getTimeZone(){return "Europe/London";},
    async findByTodoistTaskId(){return undefined;},
    async createTodoistPhaseBNativeMasterOnce(event){
      calls.push("create-destination");
      if(options.createLostResponse)throw new Error("POST response unknown");
      destinationVersion={...structuredClone(event),etag:"destination-v1",status:"confirmed"};
      if(options.badReadbackMarker)destinationVersion.extendedProperties.shared.todoistPhaseBVersion=undefined;
      return {event:structuredClone(destinationVersion),created:true};
    },
    async getEvent(){calls.push("destination-get");return structuredClone(destinationVersion);},
    async listInstancesInWindow(){
      const seq=options.missingDestinationInstance?firstThree.slice(0,2):firstThree;
      const list=seq.map((date,i)=>occurrence("destination-"+i,destinationVersion.id,date));
      return options.shuffleDestination?list.reverse():list;
    },
    async listExplicitSeriesExceptions(){return options.destinationException?
      [{id:"exception",status:"cancelled",recurringEventId:destinationVersion.id}]:[];},
  };
  return {task,mapping,link,sourceProfile:"home",destinationProfile:"work",
    sourceMapping:mapping,sourceLink:link,source:{calendar:srcCalendar,todoist:srcTodoist},
    destination:{calendar:dstCalendar,todoist:dstTodoist},
    state,now:new Date("2027-02-15T12:00:00Z"),
    async acquireWriterLeases(){
      calls.push("erasure-lease");
      if(options.leaseDenied)throw new Error("Active Work erasure fence");
      return async()=>{calls.push("release-erasure-lease");};
    },
    calls,audits,read:()=>({sourceVersion,destinationVersion,sourceComments,destinationComments})};
}
async function withGate(enabled,fn){
  const before=process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  if(enabled)process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED="true";
  else delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  try{return await fn();}finally{
    if(before===undefined)delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED=before;
  }
}
test("full staged provider cutover preserves history and atomically moves ownership",()=>withGate(true,async()=>{
  const f=fixture();
  const result=await executePhaseBNativeMove(f);
  assert.equal(result.mapping.profile,"work");
  assert.equal(result.mapping.todoistPhaseBVersion,1);
  assert.equal(result.mapping.activeInstanceId,"destination-0");
  assert.equal(f.state.committed,true);
  assert.equal(f.state.stage,false);
  assert.equal(f.read().sourceVersion.recurrence[0],
    "RRULE:FREQ=MONTHLY;INTERVAL=3;UNTIL=20270110");
  assert.equal(f.read().sourceVersion.extendedProperties.shared.syncHistoryOnly,"true");
  assert.equal(f.read().sourceVersion.extendedProperties.shared.taskId,undefined);
  assert.equal(f.read().sourceVersion.start.date,oldStart);
  assert.equal(f.read().destinationVersion.start.date,currentDue);
  assert.equal(f.read().destinationVersion.extendedProperties.shared.todoistPhaseBVersion,"1");
  assert.equal(f.read().destinationVersion.extendedProperties.shared.syncHistoryMasterId,
    "source-master");
  assert.deepEqual(f.read().sourceComments,[]);
  assert.equal(f.read().destinationComments.length,1);
  assert.ok(f.calls.indexOf("erasure-lease")<f.calls.indexOf("stage"));
  assert.ok(f.calls.indexOf("stage")<f.calls.indexOf("create-destination"));
  assert.ok(f.calls.indexOf("create-destination")<f.calls.indexOf("cap-source"));
  assert.ok(f.calls.indexOf("cap-source")<f.calls.indexOf("commit"));
  assert.ok(f.calls.indexOf("delete-source-comment")<f.calls.indexOf("commit"));
  assert.ok(f.calls.indexOf("commit")<f.calls.indexOf("release-erasure-lease"));
  assert.equal(f.audits.at(-1).action,"todoist_phase_b_native_future_only_move_succeeded");
}));
test("out-of-order Calendar instance inventory still selects the exact active occurrence",()=>withGate(true,async()=>{
  const f=fixture({shuffleDestination:true});
  const r=await executePhaseBNativeMove(f);
  assert.equal(r.mapping.originalStart,currentDue);
  assert.equal(r.mapping.activeInstanceId,"destination-0");
  assert.equal(f.state.link.activeInstanceId,"destination-0",
    "recurrence link must use sorted active instance, not provider response order");
  assert.equal(f.state.committed,true);
}));
test("default-off Phase B cannot claim a stage or touch providers",()=>withGate(false,async()=>{
  const f=fixture();
  await assert.rejects(()=>executePhaseBNativeMove(f),/disabled/);
  assert.equal(f.state.stage,false);
  assert.equal(f.calls.includes("create-destination"),false);
}));
test("active erasure fence blocks the native cutover before staging or provider writes",()=>withGate(true,async()=>{
  const f=fixture({leaseDenied:true});
  await assert.rejects(()=>executePhaseBNativeMove(f),/Active Work erasure fence/);
  assert.equal(f.state.stage,false);
  assert.equal(f.calls.includes("create-destination"),false);
}));
test("read-only preflight blocks timezone mismatch and Calendar exceptions before staging",()=>withGate(true,async()=>{
  for(const options of [{badTimezone:true},{sourceException:true}]){
    const f=fixture(options);
    await assert.rejects(()=>inspectPhaseBNativeMove(f));
    assert.equal(f.calls.includes("stage"),false);
    assert.equal(f.calls.includes("create-destination"),false);
  }
}));
test("every ambiguous provider state stays staged, never releases locks or overwrites source",()=>withGate(true,async()=>{
  const scenarios=[
    {staleAfterStage:true},{createLostResponse:true},{badReadbackMarker:true},
    {missingDestinationInstance:true},{destinationException:true},{failCap:true},
    {futureNotCapped:true},{historyMissingAfterCap:true},
    {failSourceComment:true},{duplicateComment:true},{rejectCommit:true},
  ];
  for(const options of scenarios){
    const f=fixture(options);
    await assert.rejects(()=>executePhaseBNativeMove(f),JSON.stringify(options));
    assert.equal(f.state.stage,true,`durable stage must remain: ${JSON.stringify(options)}`);
    assert.equal(f.state.committed,false);
    assert.equal(f.audits.at(-1).action,"todoist_phase_b_native_move_quarantined");
    const count=f.calls.filter(x=>x==="create-destination").length;
    assert.ok(count<=1);
    if(options.staleAfterStage||options.createLostResponse||options.badReadbackMarker
      ||options.missingDestinationInstance||options.destinationException||options.failCap)
      assert.equal(f.calls.includes("delete-source-comment"),false);
    await assert.rejects(()=>executePhaseBNativeMove(f),/stage exists/);
    assert.equal(f.calls.filter(x=>x==="create-destination").length,count,
      "repeated worker delivery must not create/rewrite a second master");
  }
}));

async function withRecoveryApproval(enabled,fn){
  const old=process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED;
  if(enabled)process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED="true";
  else delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED;
  try{return await fn();}finally{
    if(old===undefined)delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED;
    else process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_RECOVERY_APPROVED=old;
  }
}
const recoveryRequest=(f)=>({
  taskId:f.task.id,expectedOperationId:f.state.stagePayload.operationId,
  sourceProfile:f.sourceProfile,destinationProfile:f.destinationProfile,
  state:f.state,source:f.source,destination:f.destination,
  acquireWriterLeases:f.acquireWriterLeases,
});
test("after a lost CAS response, recovery reads exact provider split and commits ONLY the state handoff",
  ()=>withGate(true,()=>withRecoveryApproval(true,async()=>{
    const f=fixture({rejectCommit:true,shuffleDestination:true});
    await assert.rejects(()=>executePhaseBNativeMove(f),/CAS failed/);
    assert.equal(f.state.stage,true);
    assert.equal(f.state.committed,false);
    const before=f.calls.filter(x=>["create-destination","cap-source","destination-comment",
      "delete-source-comment"].includes(x));
    const request=recoveryRequest(f);
    const inspection=await inspectInterruptedPhaseBNativeMove(request);
    assert.equal(inspection.status,"ready_to_commit",inspection.reason);
    assert.equal(f.state.committed,false,"read-only inspection must never change mapping state");
    f.state.approveCommit=true;
    const completed=await completeVerifiedPhaseBNativeMoveStage(request);
    assert.equal(completed.status,"ready_to_commit");
    assert.equal(f.state.committed,true);
    assert.equal(f.state.stage,false);
    assert.equal(f.state.mapping.profile,"work");
    assert.equal(f.state.mapping.activeInstanceId,"destination-0");
    assert.equal(f.state.link.activeInstanceId,"destination-0");
    assert.deepEqual(f.calls.filter(x=>["create-destination","cap-source",
      "destination-comment","delete-source-comment"].includes(x)),before,
      "recovery must never repeat a provider write");
    assert.deepEqual(f.read().sourceComments,[]);
    assert.equal(f.read().destinationComments.length,1);
    assert.equal((await inspectInterruptedPhaseBNativeMove(request)).status,"quarantined",
      "a completed stage must never be implicitly replayed");
  })));
test("recovery remains disabled without explicit operation-specific operator invocation",
  ()=>withGate(true,()=>withRecoveryApproval(false,async()=>{
    const f=fixture({rejectCommit:true});
    await assert.rejects(()=>executePhaseBNativeMove(f),/CAS failed/);
    await assert.rejects(()=>completeVerifiedPhaseBNativeMoveStage(recoveryRequest(f)),/approval/);
    assert.equal(f.state.stage,true);
    assert.equal(f.state.committed,false);
  })));
test("incomplete and ambiguous provider stages never become eligible for recovery",
  ()=>withGate(true,()=>withRecoveryApproval(true,async()=>{
    const scenarios=[
      {createLostResponse:true},{badReadbackMarker:true},{missingDestinationInstance:true},
      {destinationException:true},{failCap:true},{futureNotCapped:true},
      {historyMissingAfterCap:true},{failSourceComment:true},{duplicateComment:true},
      {rejectCommit:true,missingControl:true},{rejectCommit:true,erasureBlocked:true},
    ];
    for(const options of scenarios){
      const f=fixture(options);
      await assert.rejects(()=>executePhaseBNativeMove(f),JSON.stringify(options));
      const request=recoveryRequest(f);
      const before=f.calls.filter(x=>["create-destination","cap-source","destination-comment",
        "delete-source-comment"].includes(x));
      const result=await inspectInterruptedPhaseBNativeMove(request);
      assert.equal(result.status,"quarantined",JSON.stringify(options));
      await assert.rejects(()=>completeVerifiedPhaseBNativeMoveStage(request),/quarantined/);
      assert.equal(f.state.stage,true,JSON.stringify(options));
      assert.equal(f.state.committed,false,JSON.stringify(options));
      assert.deepEqual(f.calls.filter(x=>["create-destination","cap-source",
        "destination-comment","delete-source-comment"].includes(x)),before);
    }
  })));
test("stage fingerprint and mapping/version drift reject recovery even with complete provider split",
  ()=>withGate(true,()=>withRecoveryApproval(true,async()=>{
    for(const change of [
      f=>{f.state.mapping={...f.state.mapping,updatedAt:"unrelated-new-revision"};},
      f=>{f.state.stagePayload={...f.state.stagePayload,destinationStart:"2027-07-10"};},
      f=>{f.state.stagePayload={...f.state.stagePayload,operationId:"other-operation"};},
    ]){
      const f=fixture({rejectCommit:true});
      await assert.rejects(()=>executePhaseBNativeMove(f),/CAS failed/);
      const request=recoveryRequest(f);
      change(f);
      const result=await inspectInterruptedPhaseBNativeMove(request);
      assert.equal(result.status,"quarantined");
      await assert.rejects(()=>completeVerifiedPhaseBNativeMoveStage(request));
      assert.equal(f.state.stage,true);
      assert.equal(f.state.committed,false);
    }
  })));
