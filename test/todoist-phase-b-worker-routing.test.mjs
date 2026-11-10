import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { OrphanRecoveringSynchronizer } from "../dist/orphan-recovery.js";

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
function setup(family, {currentDue, oldProjectId, flag=true}={}) {
  const task={id:`worker-route-${family.name.replaceAll(" ","-")}`,
    content:`Verify ${family.name}`,description:"",project_id:projectId,
    updated_at:updatedAt,due:{date:family.due,string:family.phrase,is_recurring:true}};
  const current=structuredClone(task);
  if(currentDue)current.due.date=currentDue;
  const events=new Map(),writes=[],normal=[],reads=[],state=new State();
  const instances=family.dates.map((date,index)=>{
    const end=new Date(date+"T00:00:00Z");end.setUTCDate(end.getUTCDate()+1);
    return {id:`instance-${index}`,status:"confirmed",recurringEventId:"",
      originalStartTime:{date},start:{date},end:{date:end.toISOString().slice(0,10)}};
  });
  const calendar={
    async findByTodoistTaskId(id){return [...events.values()].find(e=>e.extendedProperties?.shared?.taskId===id);},
    async getTimeZone(){return "Europe/London";},
    async getEvent(id){const found=events.get(id);if(found)return structuredClone(found);const e=new Error("not found");e.status=404;throw e;},
    async createTodoistPhaseBNativeMasterOnce(e){
      writes.push(structuredClone(e));
      const created={...structuredClone(e),etag:"phase-b-etag",status:"confirmed"};
      events.set(e.id,created);
      return {event:structuredClone(created),created:true};
    },
    async listInstancesInWindow(id){return instances.map(x=>({...structuredClone(x),recurringEventId:id}));},
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
    async listProjectComments(){return [];},
    async findComment(){return undefined;},
    async upsertComment(){return {id:"project-comment"};},
  };
  const identities={async put(){},async get(){return undefined;}};
  const clients=async()=>({calendar,todoist});
  const sync=new OrphanRecoveringSynchronizer(state,undefined,clients,identities);
  const delivery={kind:"todoist",profile:"home",mode:"aws",id:"worker-item-added",
    receivedAt,headers:{},body:JSON.stringify({
      event_name:"item:added",event_data:task,
      ...(oldProjectId?{event_data_extra:{old_item:{...task,project_id:oldProjectId}}}:{}),
    })};
  return {sync,task,current,events,writes,normal,reads,state,delivery};
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
for(const family of fixtures){
  test(`actual worker chain creates one Phase B native master for ${family.name}`,()=>withGate(true,async()=>{
    const f=setup(family);
    await f.sync.process(f.delivery);
    assert.equal(f.writes.length,1,"new task must reach guarded native writer");
    assert.equal(f.normal.length,0,"ordinary project writer must not consume native candidate");
    assert.deepEqual(f.writes[0].recurrence,[family.rrule]);
    assert.equal(f.state.mapping.todoistPhaseBVersion,1);
    assert.equal(f.state.mapping.recurrenceOwner,"todoist");
    assert.equal(f.state.mapping.originalStart,family.due);
    assert.equal(f.state.audits.at(-1).action,"todoist_phase_b_native_calendar_created");
    assert.equal(f.state.versions.length,1,"the project layer must not consume the task version before native admission");
    assert.ok(f.reads.length>=2,"outer orphan preflight and final native writer must each GET Todoist");
    await f.sync.process({...f.delivery,id:"duplicate-item-added"});
    assert.equal(f.writes.length,1,"repeat delivery cannot create a second master");
    assert.equal(f.normal.length,0);
  }));
}
test("disabled production flag retains ordinary project creation",()=>withGate(false,async()=>{
  const f=setup(fixtures[2]);
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,1);
}));
test("initial item:added signature and fresh GET remain independent: a changed due must roll",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{currentDue:"2027-04-10"});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0,"stale original due cannot be silently reanchored as a native master");
  assert.equal(f.normal.length,1);
  assert.equal(f.state.mapping?.todoistPhaseBVersion,undefined);
  assert.ok(f.state.audits.some(x=>x.action==="todoist_phase_b_native_admission_rejected"
    && x.detail.reason==="todoist_source_rule_or_due_changed"));
}));
test("actual project re-entry never promotes a historic rolling mapping",()=>withGate(true,async()=>{
  const f=setup(fixtures[2],{oldProjectId:"unmapped-inbox-project"});
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,1);
}));
test("month-end provider divergence never enters native writer",()=>withGate(true,async()=>{
  const family={name:"quarterly-month-end",phrase:"every quarter",due:"2027-01-31",
    dates:["2027-01-31","2027-04-30","2027-07-30"],rrule:""};
  const f=setup(family);
  await f.sync.process(f.delivery);
  assert.equal(f.writes.length,0);
  assert.equal(f.normal.length,1);
}));
