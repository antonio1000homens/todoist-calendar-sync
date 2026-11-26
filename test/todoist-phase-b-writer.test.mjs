import assert from "node:assert/strict";
import test from "node:test";
import { MAPPING_COMMENT_MARKER } from "../dist/mapping-comments.js";
import { Synchronizer } from "../dist/sync.js";

const projectId="test-home-project";
const task={id:"phase-b-new-task",content:"Quarterly review",description:"",project_id:projectId,
  updated_at:"2026-11-09T11:59:00Z",due:{date:"2027-01-10",is_recurring:true,string:"every quarter"}};
function eventInstance(id,date,masterId="phase-b-master") {
  const next=new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1);
  return {id,status:"confirmed",summary:task.content,description:task.description,
    recurringEventId:masterId,originalStartTime:{date},start:{date},end:{date:next.toISOString().slice(0,10)},
    extendedProperties:{shared:{taskId:task.id,syncRecurrenceOwner:"todoist"}}};
}
class State {
  constructor(){this.mapping=undefined;this.audits=[];this.mutations=0;this.links=[];this.completed=[];}
  async isRetired(){return false;}
  async getMappingByTaskAnyProfile(){return this.mapping;}
  async getMappingByTask(){return this.mapping;}
  async getCalendarProjectionTombstone(){return undefined;}
  async getCancelledAnnualRecoveryReceipt(){return undefined;}
  async syncBlocked(){return false;}
  async acceptTaskVersion(){return true;}
  async mutationAllowed(){return true;}
  async putMapping(mapping){this.mapping=structuredClone(mapping);}
  async deleteMapping(){this.mapping=undefined;}
  async putRecurrenceLink(link){this.links.push(structuredClone(link));}
  async deleteRecurrenceLink(){}
  async deleteCalendarProjectionTombstone(){}
  async listCompletedCalendarProjectionsByTask(){return [];}
  async putCompletedCalendarProjection(projection){this.completed.push(structuredClone(projection));}
  async getCompletedCalendarProjectionByEvent(_profile,eventId){return this.completed.find(x=>x.eventId===eventId);}
  async recordMutation(){this.mutations++;}
  async recordRecurrence(){}
  async audit(_profile,action,detail){this.audits.push({action,detail});}
}
function setup({exception=false, lookupExisting=false, missingVersion=false,
  changedBeforeRollback=false, rollbackFailure=false, createdConflict=false,
  unconfirmedCreation=false, sourceTask=task}={}){
  const state=new State(), instances=["2027-01-10","2027-04-10","2027-07-10"].map((d,i)=>eventInstance(`phase-b-instance-${i}`,d));
  const projectComments=[];
  const master={id:"phase-b-master",etag:"etag-1",status:"confirmed",summary:task.content,description:task.description,
    start:{date:"2027-01-10"},end:{date:"2027-01-11"},recurrence:["RRULE:FREQ=MONTHLY;INTERVAL=3"],
    extendedProperties:{shared:{taskId:task.id,syncRecurrenceOwner:"todoist",todoistRecurrence:"every quarter",
      todoistAnchorStart:"2027-01-10",todoistAnchorEnd:"2027-01-11",todoistAnchorAllDay:"true",
      todoistAnchorTimeZone:"Europe/London",todoistPhaseBVersion:"1"}}};
  const events=new Map([[master.id,master]]), creates=[], upserts=[], deletes=[];
  let taskExists=true;
  const calendar={
    async findByTodoistTaskId(){return lookupExisting ? [...events.values()].find(
      e=>e.extendedProperties?.shared?.taskId===task.id) : undefined;},
    async getTimeZone(){return "Europe/London";},
    async getEvent(id){const e=events.get(id);if(!e){const err=new Error("missing");err.status=404;throw err;}return structuredClone(e);},
    async createTodoistPhaseBNativeMasterOnce(e){
      creates.push(structuredClone(e));
      if(events.has(e.id)) return {event:structuredClone(events.get(e.id)),created:false};
      events.set(e.id,{...structuredClone(e),etag:"etag-1",status:"confirmed"});
      const creationReadback=structuredClone(events.get(e.id));
      if(missingVersion) delete events.get(e.id).extendedProperties.shared.todoistPhaseBVersion;
      if(unconfirmedCreation) throw new Error("connection dropped after POST");
      return {event:creationReadback,created:!createdConflict};
    },
    async listInstancesInWindow(masterId){return instances.map(x=>({...structuredClone(x),recurringEventId:masterId}));},
    async listInstances(masterId){return instances.map(x=>({...structuredClone(x),recurringEventId:masterId}));},
    async listExplicitSeriesExceptions(){return exception?[{id:"unexpected-exception",recurringEventId:"unused",status:"cancelled"}]:[];},
    async upsertEvent(e){upserts.push(structuredClone(e));return {...structuredClone(e),id:"rolling-event",status:"confirmed"};},
    async deleteEvent(id){deletes.push(id);events.delete(id);},
    async deleteEventIfUnchanged(id,etag){
      const current=events.get(id);
      if(changedBeforeRollback&&current)current.etag="user-edit-etag";
      if(rollbackFailure||!current||current.etag!==etag){
        const e=new Error("Calendar ETag conflict");e.status=412;throw e;
      }
      deletes.push(id);events.delete(id);
    },
    async patchEventMetadataIfUnchanged(id,etag,metadata){const saved=events.get(id);assert.equal(etag,saved.etag);Object.assign(saved,metadata);saved.etag="etag-2";return structuredClone(saved);},
  };
  const todoist={
    async listProjectComments(){return projectComments.map(comment=>structuredClone(comment));},
    async upsertProjectComment(projectId,content,existingId){
      const id=existingId||`mapping-${projectComments.length+1}`;
      const comment={id,project_id:projectId,content};
      const index=projectComments.findIndex(value=>value.id===id);
      if(index<0)projectComments.push(comment);else projectComments[index]=comment;
      const [marker,payload]=content.split("\n");
      if(marker===MAPPING_COMMENT_MARKER)state.mapping=JSON.parse(payload);
      return structuredClone(comment);
    },
    async updateComment(commentId,content){
      const index=projectComments.findIndex(value=>value.id===commentId);
      if(index<0)throw new Error("missing mapping comment");
      projectComments[index]={...projectComments[index],content};
      state.mapping=JSON.parse(content.split("\n")[1]);
      return structuredClone(projectComments[index]);
    },
    async getComment(id){const found=projectComments.find(value=>value.id===id);if(!found)throw Object.assign(new Error("missing"),{status:404});return structuredClone(found);},
    async deleteComment(id){const index=projectComments.findIndex(value=>value.id===id);if(index>=0)projectComments.splice(index,1);},
    async findLegacyTaskComment(){return undefined;},
    async getTask(){if(!taskExists)throw Object.assign(new Error("missing task"),{status:404});return structuredClone(sourceTask);},
    async getTimeZone(){return "Europe/London";},
  };
  const sync=new Synchronizer(state,undefined,async()=>({calendar,todoist}));
  const delivery={id:"phase-b-item-added",kind:"todoist",profile:"home",mode:"aws",receivedAt:"2026-11-09T12:00:00Z",
    headers:{},body:JSON.stringify({event_name:"item:added",event_data:task})};
  return {state,calendar,sync,delivery,creates,upserts,deletes,events,projectComments,
    deleteSourceTask(){taskExists=false;}};
}
function withGate(_enabled,fn){const old=process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  return Promise.resolve().then(fn).finally(()=>{if(old===undefined)delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;else process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED=old;});}

test("verified new all-day quarterly item creates one native master and repeat webhook preserves it",()=>withGate(true,async()=>{
  const f=setup();
  await f.sync.process(f.delivery);
  assert.equal(f.creates.length,1);
  assert.equal(f.upserts.length,0);
  assert.equal(f.state.mapping.recurrenceOwner,undefined);
  assert.equal(f.state.mapping.todoistPhaseBVersion,1);
  assert.equal(f.state.mapping.masterEventId,f.creates[0].id);
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_native_calendar_created");
  await f.sync.process({...f.delivery,id:"replay-item-added"});
  assert.equal(f.creates.length,1,"repeat delivery must not create a second Calendar master");
  assert.equal(f.upserts.length,0,"repeat delivery must not replace the native master with a rolling event");
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_existing_series_preserved");
  task.due={...task.due,date:"2027-04-10"};
  task.updated_at="2027-01-10T09:00:00Z";
  await f.sync.process({...f.delivery,id:"advanced-quarter-item-added"});
  assert.equal(f.creates.length,1,"an advanced due date must keep the original Calendar master");
  assert.equal(f.upserts.length,0);
  assert.equal(f.state.mapping.masterEventId,f.creates[0].id);
  assert.equal(f.state.mapping.activeInstanceId,"phase-b-instance-1");
  assert.deepEqual(f.creates[0].recurrence,["RRULE:FREQ=MONTHLY;INTERVAL=3"]);
  task.due={...task.due,date:"2027-01-10"};
  task.updated_at="2026-11-09T11:59:00Z";
}));

test("supported recurrence uses native Calendar creation without a feature flag",()=>withGate(false,async()=>{
  const f=setup();
  await f.sync.process(f.delivery);
  assert.equal(f.creates.length,1);
  assert.equal(f.upserts.length,0);
  assert.equal(f.state.mapping.recurrenceOwner,undefined);
  assert.equal(f.state.mapping.todoistPhaseBVersion,1);
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_native_calendar_created");
}));

test("recurrence outside the native admission families is not flattened into a one-off Calendar event",()=>withGate(true,async()=>{
  const source={...task,due:{date:"2027-01-10",is_recurring:true,string:"every 2 years"}};
  const f=setup({sourceTask:source});
  await f.sync.process({...f.delivery,id:"unsupported-new-recurrence",body:JSON.stringify({
    event_name:"item:added",event_data:source,
  })});
  assert.equal(f.creates.length,0);
  assert.equal(f.upserts.length,0);
  assert.equal(f.events.size,1,"no standalone or alternate Calendar mirror is created");
  assert.equal(f.state.mapping,undefined);
  assert.ok(f.state.audits.some(x=>x.action==="todoist_recurrence_unsupported_rule"
    && x.detail.outcome==="source_left_unchanged"));
}));

test("provider exception after create deletes only the uncommitted deterministic master",()=>withGate(true,async()=>{
  const f=setup({exception:true});
  await f.sync.process(f.delivery);
  assert.equal(f.creates.length,1);
  assert.deepEqual(f.deletes,[f.creates[0].id]);
  assert.equal(f.events.has(f.creates[0].id),false);
  assert.equal(f.state.mapping,undefined);
  assert.equal(f.state.mutations,2,"both the create and rollback delete are counted");
  assert.equal(f.state.audits.at(-1).detail.reason,"exception_inventory_not_empty");
}));

test("ordinary Todoist deletion still deletes the tagged native Calendar series",()=>withGate(true,async()=>{
  const f=setup();
  await f.sync.process(f.delivery);
  const masterId=f.state.mapping.masterEventId;
  f.deleteSourceTask();
  await f.sync.process({...f.delivery,id:"delete-native-task",body:JSON.stringify({
    event_name:"item:deleted",event_data:task,
  })});
  assert.equal(f.events.has(masterId),false);
  assert.equal(f.projectComments.some(comment=>comment.content.startsWith(MAPPING_COMMENT_MARKER)),false);
  assert.ok(f.state.audits.some(x=>x.action==="todoist_deleted_calendar_recurrence_projection"));
}));

test("Todoist completion retains the finished occurrence and advances within the same native master",()=>withGate(true,async()=>{
  const f=setup();
  await f.sync.process(f.delivery);
  const masterId=f.state.mapping.masterEventId;
  const oldTask=structuredClone(task);
  task.due={...task.due,date:"2027-04-10"};
  task.updated_at="2027-01-10T09:00:00Z";
  const completedTask={...oldTask,is_completed:true,completed_at:"2027-01-10T09:00:00Z"};
  await f.sync.process({...f.delivery,id:"complete-quarter",receivedAt:"2027-01-10T09:00:00Z",
    body:JSON.stringify({event_name:"item:completed",event_data:completedTask,event_data_extra:{old_item:oldTask}})});
  assert.equal(f.state.mapping.masterEventId,masterId);
  assert.equal(f.state.mapping.activeInstanceId,"phase-b-instance-1");
  assert.equal(f.state.completed[0].eventId,"phase-b-instance-0");
  assert.equal(f.state.completed[0].originalStart,"2027-01-10");
  const secondOld=structuredClone(task);
  task.due={...task.due,date:"2027-07-10"};
  task.updated_at="2027-04-10T09:00:00Z";
  await f.sync.process({...f.delivery,id:"complete-quarter-second",receivedAt:"2027-04-10T09:00:00Z",
    body:JSON.stringify({event_name:"item:completed",event_data:{...secondOld,is_completed:true},
      event_data_extra:{old_item:secondOld}})});
  assert.equal(f.state.mapping.masterEventId,masterId);
  assert.equal(f.state.mapping.activeInstanceId,"phase-b-instance-2");
  assert.equal(f.state.completed[1].eventId,"phase-b-instance-1");
  assert.equal(f.state.completed[1].originalStart,"2027-04-10");
  assert.equal(f.creates.length,1);
  assert.equal(f.upserts.length,0);
  assert.deepEqual(f.creates[0].recurrence,["RRULE:FREQ=MONTHLY;INTERVAL=3"]);
  task.due={...task.due,date:"2027-01-10"};
  task.updated_at="2026-11-09T11:59:00Z";
}));

test("mapping loss rediscovers the tagged master and restores exact provider correlation",()=>withGate(true,async()=>{
  const f=setup({lookupExisting:true});
  // Do not rely on a durable mapping: provider master is the independent proof.
  await f.sync.process({...f.delivery,id:"provider-native-recovery",
    body:JSON.stringify({event_name:"item:updated",event_data:task})});
  assert.equal(f.creates.length,0);
  assert.equal(f.upserts.length,0,"never flatten a tagged provider master");
  assert.equal(f.state.mapping?.taskId,task.id);
  assert.equal(f.state.mapping?.seriesId,task.id);
  assert.equal(f.state.mapping?.masterEventId,"phase-b-master");
}));

test("exact Calendar series IDs restore the project mapping without a phase owner marker",()=>withGate(true,async()=>{
  const f=setup({lookupExisting:true});
  const shared=f.events.get("phase-b-master").extendedProperties.shared;
  delete shared.todoistPhaseBVersion;
  shared.syncSchemaVersion="2";
  shared.syncTaskId=task.id;
  shared.syncSeriesId=task.id;
  shared.syncEventId="phase-b-master";
  shared.syncMasterEventId="phase-b-master";
  delete shared.syncRecurrenceOwner;

  await f.sync.process({...f.delivery,id:"phase-owner-marker-lost",body:JSON.stringify({
    event_name:"item:updated",event_data:task,
  })});

  assert.equal(f.creates.length,0);
  assert.equal(f.upserts.length,0);
  assert.equal(f.state.mapping?.taskId,task.id);
  assert.equal(f.state.mapping?.seriesId,task.id);
  assert.equal(f.state.mapping?.masterEventId,"phase-b-master");
  assert.equal(f.projectComments.filter(comment=>comment.content.startsWith(MAPPING_COMMENT_MARKER)).length,1);
  assert.ok(f.state.audits.some(entry=>entry.action==="todoist_calendar_series_correlation_recovered"));
}));

test("initial native readback without version marker never commits a mapping",()=>withGate(true,async()=>{
  const f=setup({missingVersion:true});
  await f.sync.process(f.delivery);
  assert.equal(f.state.mapping,undefined);
  assert.equal(f.upserts.length,0);
  assert.deepEqual(f.deletes,[f.creates[0].id]);
  assert.equal(f.state.audits.at(-1).detail.reason,"master_identity_or_anchor_drift");
}));

test("rollback is ETag conditional and retries a user-edited deterministic master without blocking",()=>withGate(true,async()=>{
  const f=setup({exception:true,changedBeforeRollback:true});
  await f.sync.process(f.delivery);
  assert.deepEqual(f.deletes,[]);
  assert.equal(f.events.has(f.creates[0].id),true);
  assert.equal(f.state.mapping,undefined);
  await f.sync.process({...f.delivery,id:"replayed-after-failed-rollback"});
  assert.equal(f.creates.length,2,"retry reads the same deterministic event ID");
  assert.equal(f.upserts.length,0);
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_native_write_retryable");
  assert.equal(f.events.has(f.creates[0].id),true,"the edited provider object remains intact");
}));

test("failed rollback and uncertain POST remain retryable without adopting a mismatched master",()=>withGate(true,async()=>{
  for(const options of [{exception:true,rollbackFailure:true},{exception:true,createdConflict:true},
    {unconfirmedCreation:true}]){
    const f=setup(options);
    await f.sync.process(f.delivery);
    assert.equal(f.state.mapping,undefined);
    assert.deepEqual(f.deletes,[]);
    assert.ok(f.state.audits.some(x=>x.action==="todoist_phase_b_native_write_retryable"
      || x.action==="todoist_phase_b_native_create_retryable"));
  }
}));

