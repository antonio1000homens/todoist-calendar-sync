import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotReconciler } from "../dist/reconciliation.js";
import { Synchronizer } from "../dist/sync.js";
import { reconcileUnmappedCalendar } from "../dist/calendar-reconciliation.js";
import { ReconciliationMutationBudget } from "../dist/mutation-budget.js";
import { profiles } from "../dist/config.js";
import { serializeMappingComment } from "../dist/mapping-comments.js";

const mapping={profile:"work",taskId:"task-351",eventId:"oct-occurrence",
  seriesId:"oct-series",masterEventId:"oct-master",activeInstanceId:"oct-occurrence",
  recurrenceOwner:"calendar",updatedAt:"2026-10-22T00:00:00Z"};
const futureMapping={...mapping,taskId:"future-task",eventId:"dec-occurrence",
  activeInstanceId:"dec-occurrence",seriesId:"dec-series",masterEventId:"dec-master"};
const retired=(identity)=>identity.taskId==="task-351"
  ||identity.eventIds?.some(id=>["oct-master","oct-occurrence"].includes(id))
  ||identity.seriesIds?.includes("oct-series");
const mappingComments=(mappings,profile="work")=>mappings.map((value,index)=>({id:`mapping-${index}`,
  project_id:profiles[profile].todoistProjectId,content:serializeMappingComment(value,profiles[profile].todoistProjectId)}));

test("#351 past mapping is a silent no-op on two successive manual/scheduled reconciliations",async()=>{
  const audits=[],tasks=[];
  const state={
    isRetired:async(identity)=>retired(identity),
    audit:async(_profile,action)=>audits.push(action),
  };
  const clientFactory=async()=>({todoist:{listProjectComments:async()=>mappingComments([mapping]),listTasks:async()=>tasks},calendar:{}});
  const store={
    getBaseline:async()=>{throw new Error("retired mapping must not read baseline");},
    putBaseline:async()=>{throw new Error("retired mapping must not write baseline");},
    deleteBaseline:async()=>{throw new Error("retired mapping must not delete baseline");},
  };
  const reconciler=new SnapshotReconciler(state,clientFactory,store,async()=>{},async()=>{});
  for(let i=0;i<2;i++){
    const result=await reconciler.reconcile("work");
    assert.equal(result.counts.noop,1);
    assert.equal(result.counts.blocked,0);
    assert.equal(result.counts.conflict,0);
  }
  assert.ok(!audits.some(x=>/(?:recurring_deferred|blocked|conflict)/.test(x)));
});

test("a live recurring mapping is handled by the recurrence pass, not deferred by the snapshot pass",async()=>{
  const calls=[];
  const liveMapping={...mapping,taskId:"live-task",eventId:"live-occurrence",seriesId:"live-series",
    masterEventId:"live-master",activeInstanceId:"live-occurrence"};
  const state={syncBlocked:async()=>false,audit:async(_profile,action)=>calls.push(`audit:${action}`)};
  const clients=async()=>({todoist:{listProjectComments:async()=>mappingComments([liveMapping]),listTasks:async()=>[],
    getTask:async()=>({id:"live-task",project_id:"work-project"})},calendar:{}});
  const store={getBaseline:async()=>{throw new Error("recurrence must not use standalone baseline");}};
  const reconciler=new SnapshotReconciler(state,clients,store,async()=>{throw new Error("recurrence must not use standalone repair");},
    async(profile)=>calls.push(`recurrence:${profile}`));
  const result=await reconciler.reconcile("work");
  assert.equal(result.counts.noop,1);
  assert.equal(result.counts.conflict,0);
  assert.equal(result.counts.blocked,0);
  assert.equal(calls[0],"recurrence:work");
  assert.ok(!calls.includes("audit:todoist_snapshot_reconcile_recurring_deferred"));
});

test("#351 retained task with no Dynamo mapping never reimports in two repeated snapshots",async()=>{
  const task={id:"task-351",content:"Already retired",due:{date:"2026-10-21"},is_deleted:true};
  const state={audit:async()=>{}};
  const clients=async()=>({todoist:{listProjectComments:async()=>[],listTasks:async()=>[task]},calendar:{
    findByTodoistTaskId:async()=>{throw new Error("retired task must not discover/recreate provider event");},
  }});
  const store={getBaseline:async()=>{throw new Error("no baseline");}};
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
