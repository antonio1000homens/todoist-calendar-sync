import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { MAPPING_COMMENT_MARKER } from "../dist/mapping-comments.js";
import { OrphanRecoveringSynchronizer } from "../dist/orphan-recovery.js";
import { todoistPhaseBCandidate } from "../dist/todoist-calendar-phase-b.js";

const projectId = profiles.home.todoistProjectId;
const receivedAt = "2026-11-10T13:56:00Z";
const updatedAt = "2026-11-10T13:55:30Z";
const fixtures = [
  { name: "monthly day list", phrase: "every 2, 15, 27", due: "2027-01-02",
    rrule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27",
    dates: ["2027-01-02", "2027-01-15", "2027-01-27"] },
  { name: "alternate Friday", phrase: "every other Friday", due: "2027-01-08",
    rrule: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
    dates: ["2027-01-08", "2027-01-22", "2027-02-05"] },
  { name: "quarterly", phrase: "every quarter", due: "2027-01-10",
    rrule: "RRULE:FREQ=MONTHLY;INTERVAL=3",
    dates: ["2027-01-10", "2027-04-10", "2027-07-10"] },
];

class State {
  constructor() { this.mapping=undefined;this.audits=[];this.versions=[];this.links=[];this.mutations=0; }
  async getMappingByTaskAnyProfile(){return this.mapping;}
  async getMappingByTask(){return this.mapping;}
  async getCalendarProjectionTombstone(){return undefined;}
  async getCompletedCalendarProjectionByEvent(){return undefined;}
  async syncBlocked(){return false;}
  async isRetired(){return false;}
  async mutationAllowed(){return true;}
  async acceptTaskVersion(...args){this.versions.push(args);return true;}
  async putMapping(mapping){this.mapping=structuredClone(mapping);}
  async putRecurrenceLink(link){this.links.push(structuredClone(link));}
  async recordMutation(){this.mutations++;}
  async recordRecurrence(){}
  async audit(profile,action,detail){this.audits.push({profile,action,detail});}
}
function setup(family, {currentDue, oldProjectId, flag=true, eventName="item:added", incompleteInventory=false,
  conflictingMaster=false,delayFirstInstances=false,failFirstCommentWrite=false}={}) {
  const task={id:`worker-route-${family.name.replaceAll(" ","-")}`,
    content:`Verify ${family.name}`,description:"",project_id:projectId,
    updated_at:updatedAt,due:{date:family.due,string:family.phrase,is_recurring:true}};
  const current=structuredClone(task);
  if(currentDue)current.due.date=currentDue;
  const events=new Map(),writes=[],normal=[],reads=[],state=new State();
  if(conflictingMaster)events.set("conflicting-calendar-series",{
    id:"conflicting-calendar-series",status:"confirmed",summary:task.content,description:task.description,
    start:{date:family.due},end:{date:family.due},recurrence:["RRULE:FREQ=DAILY"],
  });
  if(conflictingMaster)events.set("instance-0",{
    id:"instance-0",status:"confirmed",summary:task.content,description:task.description,
    recurringEventId:"conflicting-calendar-series",originalStartTime:{date:family.due},
    start:{date:family.due},end:{date:family.due},
  });
  const projectComments=[];
  let instanceReadCount=0,commentWriteCount=0;
  const instances=family.dates.map((date,index)=>{
    const end=new Date(date+"T00:00:00Z");end.setUTCDate(end.getUTCDate()+1);
    return {id:`instance-${index}`,status:"confirmed",recurringEventId:"",
      originalStartTime:{date},start:{date},end:{date:end.toISOString().slice(0,10)}};
  });
  const calendar={
    ...(incompleteInventory?{}:{async listDelta(){return {items:[...events.values()]};}}),
    async findByTodoistTaskId(id){return [...events.values()].find(e=>e.extendedProperties?.shared?.taskId===id);},
    async getTimeZone(){return "Europe/London";},
    async getEvent(id){const found=events.get(id);if(found)return structuredClone(found);const e=new Error("not found");e.status=404;throw e;},
    async ensureTaskCorrelation(eventId,taskId,_expectedTaskId,mapping){
      const found=events.get(eventId);
      const shared={...(found.extendedProperties?.shared||{}),taskId,syncSchemaVersion:"2",
        syncProfile:"home",syncCalendarId:profiles.home.calendarId,syncTaskId:taskId,syncEventId:eventId,
        syncSeriesId:mapping.seriesId,syncMasterEventId:mapping.masterEventId,
        syncActiveInstanceId:mapping.activeInstanceId,syncOriginalStart:mapping.originalStart,
        syncActiveEffectiveStart:mapping.activeEffectiveStart,syncProgressVersion:"1"};
      const stored={...found,extendedProperties:{...found.extendedProperties,shared}};
      events.set(eventId,stored);return structuredClone(stored);
    },
    async createTodoistPhaseBNativeMasterOnce(e){
      writes.push(structuredClone(e));
      const created={...structuredClone(e),etag:"phase-b-etag",status:"confirmed"};
      events.set(e.id,created);
      return {event:structuredClone(created),created:true};
    },
    async listInstancesInWindow(id){
      instanceReadCount++;
      if(delayFirstInstances&&instanceReadCount===1)return [];
      return instances.map(x=>({...structuredClone(x),recurringEventId:id}));
    },
    async listExplicitSeriesExceptions(){return [];},
    async upsertEvent(e,existingId){
      normal.push(structuredClone(e));
      const id=existingId||"ordinary-event";const stored={...structuredClone(e),id,status:"confirmed"};
      events.set(id,stored);return stored;
    },
  };
  const todoist={
    async getTask(id){reads.push(id);return structuredClone(current);},
    async getTimeZone(){return "Europe/London";},
    async listProjectComments(){return projectComments.map(comment=>structuredClone(comment));},
    async upsertProjectComment(projectId,content,existingId){
      commentWriteCount++;
      if(failFirstCommentWrite&&commentWriteCount===1)throw new Error("Todoist comment write temporarily failed");
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
      const payload=content.split("\n")[1];state.mapping=JSON.parse(payload);
      return structuredClone(projectComments[index]);
    },
    async findComment(){return undefined;},
    async upsertComment(){return {id:"project-comment"};},
  };
  const identities={async put(){},async get(){return undefined;}};
  const clients=async()=>({calendar,todoist});
  const sync=new OrphanRecoveringSynchronizer(state,undefined,clients,identities);
  const delivery={kind:"todoist",profile:"home",mode:"aws",id:"worker-item-added",
    receivedAt,headers:{},body:JSON.stringify({
    event_name:eventName,event_data:task,
      ...(oldProjectId?{event_data_extra:{old_item:{...task,project_id:oldProjectId}}}:{}),
    })};
  return {sync,task,current,events,writes,normal,reads,state,delivery,projectComments};
}
async function withGate(_enabled,fn){
  const before=process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
  try{return await fn();}finally{
    if(before===undefined)delete process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_PHASE_B_NATIVE_ENABLED=before;
  }
}
for(const family of fixtures){
  test(`actual worker chain creates one Phase B native master for ${family.name}`,()=>withGate(true,async()=>{
    const f=setup(family);
    await f.sync.process(f.delivery);
    assert.equal(f.writes.length,1,"new task must reach guarded native writer");
    assert.equal(f.normal.length,0,"ordinary project writer must not consume native candidate");
    assert.deepEqual(f.writes[0].recurrence,[family.rrule]);
    assert.equal(f.state.mapping.todoistPhaseBVersion,1);
    assert.equal(f.state.mapping.recurrenceOwner,undefined);
    assert.equal(f.state.mapping.todoistPhaseBVersion,1);
    assert.equal(f.state.mapping.originalStart,family.due);
    assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_native_calendar_created");
    assert.equal(f.state.versions.length,1,"the project layer must not consume the task version before native admission");
    assert.ok(f.reads.length>=2,"outer orphan preflight and final native writer must each GET Todoist");
    await f.sync.process({...f.delivery,id:"duplicate-item-added"});
    assert.equal(f.writes.length,1,"repeat delivery cannot create a second master");
    assert.equal(f.normal.length,0);
  }));
}
test("supported new recurrence is admitted without a deployment feature flag",()=>withGate(false,async()=>{
  const f=setup(fixtures[2]);
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,1);
  assert.equal(f.normal.length,0);
  assert.equal(f.state.mapping.todoistPhaseBVersion,1);
}));
test("normal reconciliation repairs an existing supported recurring Todoist task",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{eventName:"item:updated"});
  f.delivery.headers={"x-todoist-calendar-sync-reconcile":"true"};
  f.delivery.body=JSON.stringify({event_name:"item:updated",event_data:f.task,
    event_data_extra:{old_item:structuredClone(f.task)}});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].recurrence[0],fixtures[2].rrule);
  assert.equal(f.state.mapping.taskId,f.task.id);
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_native_calendar_created");
  await f.sync.process({...f.delivery,id:"second-reconciliation-pass"});
  assert.equal(f.writes.length,1,"second reconciliation must converge without another master");
}));
test("reconciliation repairs a fixed annual task after unsupported creation syntax is corrected",()=>withGate(true,async()=>{
  const annual={name:"fixed June 11 annual",phrase:"every June 11",due:"2027-06-11",
    rrule:"RRULE:FREQ=YEARLY;BYMONTHDAY=11;BYMONTH=6",
    dates:["2027-06-11","2028-06-11","2029-06-11"]};
  const unsupported={...annual,phrase:"every June 11 starting 2027-06-11"};
  const f=setup(unsupported,{eventName:"item:added"});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0,"unsupported initial syntax must remain unprojected");
  f.current.due.string=annual.phrase;
  f.delivery.id="corrected-item-updated";
  f.delivery.body=JSON.stringify({event_name:"item:updated",event_data:f.current,
    event_data_extra:{old_item:structuredClone(f.task)}});
  f.delivery.headers={"x-todoist-calendar-sync-reconcile":"true"};
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].recurrence[0],annual.rrule);
  assert.equal(f.state.mapping.taskId,f.task.id);
  assert.equal(f.state.mapping.originalStart,annual.due);
  await f.sync.process({...f.delivery,id:"annual-reconciliation-replay"});
  assert.equal(f.writes.length,1);
}));
for (const phrase of ["every 6 June", "every June 6", "every 6 Jun", "every Jun 6", "every 6th June", "every June 6th"]) {
  test(`fresh item:added creates one verified native annual Calendar series for ${phrase}`,()=>withGate(true,async()=>{
    const annual={name:"fixed June 6 annual",phrase,due:"2027-06-06",
      rrule:"RRULE:FREQ=YEARLY;BYMONTHDAY=6;BYMONTH=6",
      dates:["2027-06-06","2028-06-06","2029-06-06"]};
    const f=setup(annual,{eventName:"item:added"});
    assert.equal(todoistPhaseBCandidate(f.task,{start:annual.due,source:"verified_original_schedule"}).candidateRrule,annual.rrule);
    await f.sync.process(f.delivery);
    assert.equal(f.writes.length,1);
    assert.equal(f.normal.length,0);
    assert.equal(f.writes[0].start.date,annual.due);
    assert.deepEqual(f.writes[0].recurrence,[annual.rrule]);
    assert.equal(f.state.mapping.taskId,f.task.id);
    assert.equal(f.state.mapping.todoistPhaseBVersion,1);
    assert.equal(f.projectComments.length,1);
    await f.sync.process({...f.delivery,id:`replay-${phrase.replaceAll(" ","-")}`});
    assert.equal(f.writes.length,1,"replayed item:added must not create another master");
    assert.equal(f.projectComments.length,1);
  }));
}
test("delayed Calendar instances leave the deterministic master intact and retry until correlation commits",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{eventName:"item:updated",delayFirstInstances:true});
  f.delivery.body=JSON.stringify({event_name:"item:updated",event_data:f.task,
    event_data_extra:{old_item:structuredClone(f.task)}});
  await assert.rejects(f.sync.process(f.delivery),/Calendar native write needs retry/);
  assert.equal(f.writes.length,1);
  const master=[...f.events.values()][0];
  assert.equal(master.status,"confirmed","a delayed instance listing must not roll back a valid master");
  assert.equal(f.state.mapping,undefined,"the delivery is not acknowledged as linked before mapping persistence");
  assert.equal(f.state.audits.at(-1).detail.rollback,"preserved_for_retry");

  await f.sync.process({...f.delivery,id:"retry-after-instance-visibility"});
  assert.equal(f.writes.length,1,"retry discovers the existing deterministic master instead of creating another");
  assert.equal(f.state.mapping.taskId,f.task.id);
  assert.equal(f.state.mapping.eventId,master.id);
  assert.equal(f.projectComments.length,1);
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_existing_series_preserved");
}));
test("failed project comment persistence retries against the existing Calendar master",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{eventName:"item:updated",failFirstCommentWrite:true});
  f.delivery.body=JSON.stringify({event_name:"item:updated",event_data:f.task,
    event_data_extra:{old_item:structuredClone(f.task)}});
  await assert.rejects(f.sync.process(f.delivery),/mapping readback needs retry/);
  assert.equal(f.writes.length,1);
  assert.equal(f.projectComments.length,0);
  const master=[...f.events.values()][0];
  assert.equal(master.extendedProperties.shared.taskId,f.task.id);

  await f.sync.process({...f.delivery,id:"retry-after-comment-failure"});
  assert.equal(f.writes.length,1);
  assert.equal(f.projectComments.length,1);
  assert.equal(f.state.mapping.eventId,master.id);
  assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_existing_series_preserved");
}));
test("update repair does not create when complete Calendar inventory is unavailable",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{eventName:"item:updated",incompleteInventory:true});
  f.delivery.body=JSON.stringify({event_name:"item:updated",event_data:f.task,
    event_data_extra:{old_item:structuredClone(f.task)}});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,0);
}));
test("update repair refuses an incompatible series already occupying the current occurrence",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{eventName:"item:updated",conflictingMaster:true});
  f.delivery.body=JSON.stringify({event_name:"item:updated",event_data:f.task,
    event_data_extra:{old_item:structuredClone(f.task)}});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,0);
  assert.equal(f.state.audits.at(-1).action,"todoist_provider_pair_conflict");
}));
test("initial item:added signature and fresh GET remain independent: changed due stays unmirrored",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{currentDue:"2027-04-10"});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0,"stale original due cannot be silently reanchored as a native master");
  assert.equal(f.normal.length,0,"changed due cannot fall back to a rolling mirror");
  assert.equal(f.state.mapping?.todoistPhaseBVersion,undefined);
  assert.ok(f.state.audits.length>0,"unsupported recurrence is diagnosed");
  assert.equal(f.state.audits.at(-1).detail.outcome,"source_left_unchanged");
}));
test("actual project re-entry never creates a flattened recurring mirror",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{oldProjectId:"unmapped-inbox-project"});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,0);
  assert.equal(f.state.mapping?.todoistPhaseBVersion,undefined);
  assert.ok(f.state.audits.some(x=>x.action==="todoist_project_recurrence_unsupported"
    || x.action==="todoist_recurrence_unsupported_rule"));
}));
test("month-end provider divergence remains unmirrored instead of flattening recurrence",()=>withGate(true,async()=>{
  const family={name:"quarterly-month-end",phrase:"every quarter",due:"2027-01-31",
    dates:["2027-01-31","2027-04-30","2027-07-30"],rrule:""};
  const f=setup(family);
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,0);
  assert.equal(f.state.mapping?.todoistPhaseBVersion,undefined);
  assert.ok(f.state.audits.length>0,"unsupported recurrence is diagnosed");
  assert.equal(f.state.audits.at(-1).detail.outcome,"source_left_unchanged");
}));
