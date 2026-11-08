import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotReconciler } from "../dist/reconciliation.js";
import { Synchronizer } from "../dist/sync.js";
import { reconcileUnmappedCalendar } from "../dist/calendar-reconciliation.js";
import { ReconciliationMutationBudget } from "../dist/mutation-budget.js";

const mapping={profile:"work",taskId:"task-351",eventId:"oct-occurrence",
  seriesId:"oct-series",masterEventId:"oct-master",activeInstanceId:"oct-occurrence",
  recurrenceOwner:"calendar",updatedAt:"2026-10-22T00:00:00Z"};
const futureMapping={...mapping,taskId:"future-task",eventId:"dec-occurrence",
  activeInstanceId:"dec-occurrence",seriesId:"dec-series",masterEventId:"dec-master"};
const retired=(identity)=>identity.taskId==="task-351"
  ||identity.eventIds?.some(id=>["oct-master","oct-occurrence"].includes(id))
  ||identity.seriesIds?.includes("oct-series");

test("#351 past mapping is a silent no-op on two successive manual/scheduled reconciliations",async()=>{
  const audits=[],tasks=[];
  const state={
    isRetired:async(identity)=>retired(identity),
    audit:async(_profile,action)=>audits.push(action),
  };
  const clientFactory=async()=>({todoist:{listProjectComments:async()=>[],listTasks:async()=>tasks},calendar:{}});
  const store={
    listMappings:async()=>[mapping],
    getBaseline:async()=>{throw new Error("retired mapping must not read baseline");},
    putBaseline:async()=>{throw new Error("retired mapping must not write baseline");},
    deleteBaseline:async()=>{throw new Error("retired mapping must not delete baseline");},
  };
  const reconciler=new SnapshotReconciler(state,clientFactory,store,async()=>{},async()=>{});
  for(let i=0;i<2;i++){
    const result=await reconciler.reconcile("work");
    assert.equal(result.counts.noop,1);
    assert.equal(result.counts.recurring_deferred,0);
    assert.equal(result.counts.blocked,0);
    assert.equal(result.counts.conflict,0);
  }
  assert.ok(!audits.some(x=>/(?:recurring_deferred|blocked|conflict)/.test(x)));
});

test("#351 retained task with no Dynamo mapping never reimports in two repeated snapshots",async()=>{
  const task={id:"task-351",content:"Already retired",due:{date:"2026-10-21"}};
  const state={isRetired:async identity=>retired(identity),
    audit:async()=>{}};
  const clients=async()=>({todoist:{listProjectComments:async()=>[],listTasks:async()=>[task]},calendar:{
    findByTodoistTaskId:async()=>{throw new Error("retired task must not discover/recreate provider event");},
  }});
  const store={listMappings:async()=>[],getBaseline:async()=>{throw new Error("no baseline");}};
  const reconciler=new SnapshotReconciler(state,clients,store,async()=>{
    throw new Error("No retired task provider write");
  },async()=>{});
  for(let i=0;i<2;i++){
    const result=await reconciler.reconcile("work");
    assert.equal(result.counts.noop,1);
    assert.equal(result.counts.created,0);
    assert.equal(result.counts.blocked,0);
  }
});

test("#351 stale Todoist and Calendar webhook replays never reach provider writes",async()=>{
  const auditActions=[],lookups=[];
  const state={
    async isRetired(identity){lookups.push(identity);return retired(identity);},
    async getSyncToken(){return "current-token";},
    async putSyncToken(){},
    async audit(_profile,action){auditActions.push(action);},
    async beginTodoistCalendarWrite(){throw new Error("retired write-fence claim");},
  };
  let writes=0;
  const factory=async()=>({
    todoist:{async listProjectComments(){return [];},async getTask(){throw new Error("retired task re-read");},
      async upsertTask(){writes++;}},
    calendar:{async listDelta(){return {items:[{
      id:"oct-occurrence",recurringEventId:"oct-master",
      iCalUID:"oct-series",status:"confirmed",
      summary:"Historical meeting",start:{date:"2026-10-21"},
      end:{date:"2026-10-22"},
    }],nextSyncToken:"new-token"};},
    async getEvent(){throw new Error("retired series readback");},
    async deleteEvent(){writes++;}},
  });
  const synchronizer=new Synchronizer(state,undefined,factory);
  const delivery={profile:"work",id:"test-replay",mode:"aws",headers:{},
    receivedAt:"2026-11-06T19:00:00Z"};
  for(let i=0;i<2;i++){
    await synchronizer.process({...delivery,kind:"calendar",body:""});
    await synchronizer.process({...delivery,kind:"todoist",body:JSON.stringify({
      event_name:"item:updated",event_data:{id:"task-351",content:"Historical meeting",
        project_id:"6XFcJ93R35MgJQ97",due:{date:"2026-10-21"}},
    })});
  }
  assert.equal(writes,0);
  assert.ok(lookups.some(x=>x.eventIds?.includes("oct-master")));
  assert.ok(lookups.some(x=>x.taskId==="task-351"));
  assert.ok(!auditActions.some(x=>/(?:conflict|blocked|recurring_deferred)/.test(x)));
});

test("#351 full Calendar recovery silently skips retired finite RRULE but preserves unrelated future master",async()=>{
  const event={id:"oct-master",iCalUID:"oct-series",status:"confirmed",
    summary:"Already retired",recurrence:["RRULE:FREQ=DAILY;COUNT=2"],
    start:{dateTime:"2026-10-20T09:30:00Z"},end:{dateTime:"2026-10-20T17:30:00Z"}};
  const pending={...event,id:"dec-master",iCalUID:"dec-series",
    summary:"Future retained",start:{dateTime:"2026-12-03T10:00:00Z"},
    end:{dateTime:"2026-12-03T11:00:00Z"}};
  let writes=0;
  const state={
    isRetired:async identity=>retired(identity),
    mutationAllowed:async()=>true,
    audit:async()=>{},
    getRecurrenceLink:async()=>undefined,
    getMappingByEvent:async()=>undefined,
  };
  const factory=async()=>({
    todoist:{listProjectComments:async()=>[],listTasks:async()=>[],upsertTask:async()=>{writes++;}},
    calendar:{listDelta:async()=>({items:[event]}),
      listInstances:async()=>{throw new Error("Retired series must not expand");},
      upsertEvent:async()=>{writes++;}},
  });
  for(let i=0;i<2;i++){
    const result=await reconcileUnmappedCalendar("work",state,factory,new ReconciliationMutationBudget());
    assert.equal(result.skipped,1);
    assert.equal(result.conflicts,0);
    assert.equal(result.blocked,0);
    assert.equal(result.providerMutations,0);
  }
  assert.equal(writes,0);
  assert.equal(retired({profile:"work",eventIds:[pending.id],seriesIds:[pending.iCalUID]}),false,
    "Future series must not be included in the exclusion scope");
  assert.notEqual(mapping.taskId,futureMapping.taskId);
});
