import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { Synchronizer } from "../dist/sync.js";
import { calendarOwnedTodoistRecurrence } from "../dist/calendar-owned-todoist-recurrence.js";
import { parseMappingComment, mappingFromProjectMappingComment, serializeMappingComment } from "../dist/mapping-comments.js";

const profile = "home";
const { calendarId, todoistProjectId: projectId } = profiles[profile];
const taskId = "school-swim-task", oldId = "old-weekly-master", masterId = oldId + "_R20261117";
const activeId = oldId + "_20261201";
function fixture() {
  const old = { id: oldId, status: "confirmed", etag: "old-1", summary: "School swimming", description: "",
    start: {date:"2026-11-10"}, end:{date:"2026-11-11"},
    recurrence:["RRULE:FREQ=WEEKLY;UNTIL=20261116;BYDAY=TU"],
    extendedProperties:{shared:{taskId,syncTaskId:taskId,syncMasterEventId:oldId,humanKey:"preserve"}} };
  const master = { ...structuredClone(old), id: masterId, etag:"new-1", iCalUID:masterId+"@google.com",
    start:{date:"2026-11-17"},end:{date:"2026-11-18"},
    recurrence:["RRULE:FREQ=WEEKLY;BYDAY=TU"],description:"Weekly school swimming lesson" };
  const active = {id:activeId,etag:"active-1",status:"confirmed",recurringEventId:masterId,
    summary:master.summary,description:master.description,originalStartTime:{date:"2026-12-01"},
    start:{date:"2026-12-01"},end:{date:"2026-12-02"}};
  const stale = {profile,calendarId,projectId,taskId,eventId:oldId,masterEventId:oldId,seriesId:taskId,
    originalStart:"2026-11-24",activeEffectiveStart:"2026-11-24",syncedTitle:old.summary,syncedDue:"2026-11-10",
    mappingRevision:21,projectCommentId:"mapping-comment",updatedAt:"2026-11-26T09:09:07.553Z"};
  const f = {events:new Map([[oldId,old],[masterId,master],[activeId,active]]),
    task:{id:taskId,project_id:projectId,content:old.summary,description:"",due:{date:"2026-12-01",is_recurring:true,string:"every Tue"}},
    comments:[{id:stale.projectCommentId,project_id:projectId,content:serializeMappingComment(stale,projectId)}],
    writes:[],audits:[],exceptions:[],future:[],extraAliases:[],failAt:undefined,blocked:false};
  const state={async mutationAllowed(){return true},async syncBlocked(){return f.blocked},
    async getCompletedCalendarProjectionByEvent(){return undefined},async recordMutation(){},
    async audit(_p,action,detail){f.audits.push({action,detail})}};
  const calendar={
    async getEvent(id){return structuredClone(f.events.get(id))},
    async listLinkedEventsByTodoistTaskId(){return [...f.events.values()].filter(e=>e.extendedProperties?.shared?.taskId===taskId).concat(f.extraAliases).map(e=>structuredClone(e))},
    async listInstancesInWindow(id){return structuredClone(id===oldId?f.future:[f.events.get(activeId)])},
    async listExplicitSeriesExceptions(id){return structuredClone(id===oldId?f.exceptions:[])},
    async updateSharedEventPropertiesIfUnchanged(id,etag,changes){
      const e=f.events.get(id);assert.equal(e.etag,etag);
      if(f.failAt===id)throw new Error("simulated provider failure");
      const shared={...e.extendedProperties?.shared};
      for(const [key,value] of Object.entries(changes)){if(value===null)delete shared[key];else shared[key]=value;}
      const next={...e,etag:e.etag+"-next",extendedProperties:{...e.extendedProperties,shared}};
      f.events.set(id,next);f.writes.push(id);return structuredClone(next);
    }
  };
  const todoist={
    async getTask(){return structuredClone(f.task)},
    async listProjectComments(){return structuredClone(f.comments)},
    async updateTaskMetadata(id,metadata){assert.equal(id,taskId);f.task={...f.task,...metadata};f.writes.push("task");return structuredClone(f.task)},
    async updateComment(id,content){assert.equal(id,stale.projectCommentId);if(f.failAt==="comment")throw new Error("simulated provider failure");
      f.comments[0]={...f.comments[0],content};f.writes.push("comment");return structuredClone(f.comments[0]);}
  };
  const sync=new Synchronizer(state,undefined,async()=>({calendar,todoist}));
  const mapped=()=>mappingFromProjectMappingComment(parseMappingComment(f.comments[0]));
  sync.providerMappingByTaskAnyProfile=async()=>mapped();
  sync.providerMappingsForCalendarIdentity=async()=>[mapped()];
  const delivery={id:"test-split",kind:"calendar",profile,mode:"aws",receivedAt:"2026-11-26T20:47:31Z",headers:{},body:""};
  f.run=async()=> {
    const next=await calendar.getEvent(masterId),instance=await calendar.getEvent(activeId);
    const recurrence=calendarOwnedTodoistRecurrence(next,[instance],"Europe/London");
    assert.ok(recurrence);
    return sync.repairStaleWeeklySplit(delivery,stale,next,instance,await todoist.getTask(taskId),recurrence,"Europe/London",calendar,todoist);
  };
  f.mapped=mapped;
  f.sync=sync;
  return f;
}
test("verified Google weekly split repairs the same comment and recurring task without changing history or dates",async()=>{
  const f=fixture(),old=structuredClone(f.events.get(oldId)),due=structuredClone(f.task.due);
  assert.equal(await f.run(),true);
  assert.deepEqual(f.writes,[masterId,oldId,"task","comment"]);
  assert.equal(f.task.id,taskId);
  assert.deepEqual(f.task.due,due);
  assert.equal(f.task.description,"Weekly school swimming lesson");
  assert.equal(f.events.get(oldId).extendedProperties.shared.syncHistoryOnly,"true");
  assert.equal(f.events.get(oldId).extendedProperties.shared.taskId,undefined);
  assert.equal(f.events.get(oldId).extendedProperties.shared.humanKey,"preserve");
  assert.deepEqual(f.events.get(oldId).recurrence,old.recurrence);
  assert.deepEqual(f.events.get(oldId).start,old.start);
  assert.deepEqual(f.events.get(oldId).end,old.end);
  assert.equal(f.events.get(masterId).extendedProperties.shared.syncHistoryMasterId,oldId);
  assert.equal(f.mapped().masterEventId,masterId);
  assert.equal(f.mapped().activeInstanceId,activeId);
  assert.equal(f.mapped().mappingRevision,22);
  assert.equal(f.comments.length,1);
  assert.equal(f.audits.at(-1).action,"calendar_split_mapping_repaired");
});
test("partial successor patch and lost comment write can resume without repeating successful writes",async()=>{
  const f=fixture();
  f.failAt=oldId;
  await assert.rejects(f.run(),/simulated provider failure/);
  assert.deepEqual(f.writes,[masterId]);
  f.failAt="comment";
  await assert.rejects(f.run(),/simulated provider failure/);
  assert.deepEqual(f.writes,[masterId,oldId,"task"]);
  f.failAt=undefined;
  assert.equal(await f.run(),true);
  assert.deepEqual(f.writes,[masterId,oldId,"task","comment"]);
  assert.equal(f.comments.length,1);
  assert.equal(f.mapped().masterEventId,masterId);
});
for(const [label,change] of [
  ["no independent split identity",f=>{delete f.events.get(masterId).extendedProperties.shared.taskId;delete f.events.get(masterId).extendedProperties.shared.syncTaskId;}],
  ["overlapping old recurrence",f=>{f.events.get(oldId).recurrence=["RRULE:FREQ=WEEKLY;UNTIL=20261201;BYDAY=TU"];}],
  ["foreign task link",f=>{f.events.get(masterId).extendedProperties.shared.syncTaskId="another-task";}],
  ["conflicting alias",f=>{f.extraAliases.push({id:"unrelated-master",status:"confirmed"});}],
  ["duplicate project mapping",f=>{f.comments.push({...f.comments[0],id:"another-comment"});}],
  ["mapping revision changed",f=>{const m=f.mapped();f.comments[0].content=serializeMappingComment({...m,mappingRevision:22},projectId);}],
  ["concurrent Todoist description edit",f=>{f.task.description="Independent Todoist edit";}],
  ["sync control",f=>{f.blocked=true;}],
  ["old future exception",f=>{f.exceptions.push({id:"late-old-instance",status:"confirmed",recurringEventId:oldId,originalStartTime:{date:"2026-11-10"},start:{date:"2026-12-01"}});}],
]){
  test("weekly split repair refuses "+label,async()=>{const f=fixture();change(f);assert.equal(await f.run(),false);assert.deepEqual(f.writes,[]);});
}
