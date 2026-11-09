import assert from "node:assert/strict";
import test from "node:test";
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
function setup({exception=false}={}){
  const state=new State(), instances=["2027-01-10","2027-04-10","2027-07-10"].map((d,i)=>eventInstance(`phase-b-instance-${i}`,d));
  const master={id:"phase-b-master",etag:"etag-1",status:"confirmed",summary:task.content,description:task.description,
    start:{date:"2027-01-10"},end:{date:"2027-01-11"},recurrence:["RRULE:FREQ=MONTHLY;INTERVAL=3"],
    extendedProperties:{shared:{taskId:task.id,syncRecurrenceOwner:"todoist",todoistRecurrence:"every quarter",
      todoistAnchorStart:"2027-01-10",todoistAnchorEnd:"2027-01-11",todoistAnchorAllDay:"true",
      todoistAnchorTimeZone:"Europe/London",todoistPhaseBVersion:"1"}}};
  const events=new Map([[master.id,master]]), creates=[], upserts=[], deletes=[];
  const calendar={
    async findByTodoistTaskId(){return undefined;},
    async getTimeZone(){return "Europe/London";},
    async getEvent(id){const e=events.get(id);if(!e){const err=new Error("missing");err.status=404;throw err;}return structuredClone(e);},
    async createTodoistPhaseBNativeMasterOnce(e){creates.push(structuredClone(e));events.set(e.id,{...structuredClone(e),etag:"etag-1",status:"confirmed"});return {event:structuredClone(events.get(e.id)),created:true};},
    async listInstancesInWindow(masterId){return instances.map(x=>({...structuredClone(x),recurringEventId:masterId}));},
    async listInstances(masterId){return instances.map(x=>({...structuredClone(x),recurringEventId:masterId}));},
    async listExplicitSeriesExceptions(){return exception?[{id:"unexpected-exception",recurringEventId:"unused",status:"cancelled"}]:[];},
    async upsertEvent(e){upserts.push(structuredClone(e));return {...structuredClone(e),id:"rolling-event",status:"confirmed"};},
    async deleteEvent(id){deletes.push(id);events.delete(id);},
    async patchEventMetadataIfUnchanged(id,etag,metadata){const saved=events.get(id);assert.equal(etag,saved.etag);Object.assign(saved,metadata);saved.etag="etag-2";return structuredClone(saved);},
  };
  const todoist={async listProjectComments(){return [];},async getTask(){return structuredClone(task);},async getTimeZone(){return "Europe/London";}};
  const sync=new Synchronizer(state,undefined,async()=>({calendar,todoist}));
  const delivery={id:"phase-b-item-added",kind:"todoist",profile:"home",mode:"aws",receivedAt:"2026-11-09T12:00:00Z",
    headers:{},body:JSON.stringify({event_name:"item:added",event_data:task})};
  return {state,calendar,sync,delivery,creates,upserts,deletes,events};
}
function withGate(enabled,fn){const old=process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  if(enabled)process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED="true";else delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  return Promise.resolve().then(fn).finally(()=>{if(old===undefined)delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;else process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED=old;});}

test("verified new all-day quarterly item creates one native master and repeat webhook preserves it",()=>withGate(true,async()=>{
  const f=setup();
  await f.sync.process(f.delivery);
  assert.equal(f.creates.length,1);
  assert.equal(f.upserts.length,0);
  assert.equal(f.state.mapping.recurrenceOwner,"todoist");
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

test("Phase B creation stays OFF without explicit opt-in",()=>withGate(false,async()=>{
  const f=setup();
  await f.sync.process(f.delivery);
  assert.equal(f.creates.length,0);
  assert.equal(f.upserts.length,1);
  assert.equal(f.state.audits.at(-1).action,"todoist_created_calendar");
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
  await f.sync.process({...f.delivery,id:"delete-native-task",body:JSON.stringify({
    event_name:"item:deleted",event_data:task,
  })});
  assert.equal(f.events.has(masterId),false);
  assert.equal(f.state.mapping,undefined);
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
