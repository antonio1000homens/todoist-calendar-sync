import test from "node:test";
import assert from "node:assert/strict";
import {hasGuardedRecoveryDispatchCandidate} from "../dist/guarded-recovery-dispatch.js";
import {OrphanRecoveringSynchronizer} from "../dist/orphan-recovery.js";
import {ProjectAwareSynchronizer} from "../dist/project-sync.js";
import {profiles} from "../dist/config.js";

const task={id:"source-locked",content:"Annual item",description:"",
  project_id:profiles.home.todoistProjectId,updated_at:"2026-11-07T16:14:00Z",
  due:{date:"2027-08-16",string:"every August 16",is_recurring:true},
  is_completed:false,is_deleted:false};
const mapping={profile:"home",taskId:task.id,eventId:"old-cancelled",updatedAt:"2026-10-23T10:35:00Z"};
const webhook={
  id:"blocked-upsert",kind:"todoist",profile:"home",mode:"aws",headers:{},
  receivedAt:"2026-11-07T16:14:01Z",
  body:JSON.stringify({event_name:"item:updated",event_data:task}),
};
const request=(change={})=>({
  profile:"home",mapping,sourceTask:task,action:"upsert",
  getExactRepairLock:async()=>"failed-only-validation",
  ...change,
});

test("common dispatcher routes an exact held repair, not arbitrary blocked tasks",async()=>{
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request()),true);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({action:"delete_projection"})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({sourceTask:{...task,is_completed:true}})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({sourceTask:{...task,is_deleted:true}})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({profile:"work"})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({mapping:{...mapping,profile:"work"}})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({mapping:undefined})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({sourceTask:{...task,id:"other-task"}})),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({
    sourceTask:{...task,project_id:profiles.work.todoistProjectId},
  })),false);
  assert.equal(await hasGuardedRecoveryDispatchCandidate(request({
    getExactRepairLock:async()=>undefined,
  })),false);
});

function harness({hasRepair=true,source=task}={}) {
  const audits=[],reads=[],writes=[];
  const state={
    async getMappingByTaskAnyProfile(){return mapping;},
    async getConsolidatedTask(){return undefined;},
    async getCancelledAnnualRecoveryLock(profile,id){
      reads.push(["lock",profile,id]);return hasRepair?"failed-only-validation":undefined;
    },
    async syncBlocked(){return true;},
    async isRetired(){return false;},
    async audit(profile,action,details){audits.push({profile,action,details});},
  };
  const calendar={async upsertEvent(...args){writes.push(["calendar",args]);throw Error("unexpected provider write");}};
  const todoist={
    async getTask(id){reads.push(["provider",id]);return {...source};},
    async deleteTask(){writes.push(["todoist_delete"]);throw Error("unexpected provider write");},
  };
  const clients=async()=>({todoist,calendar});
  return {state,audits,reads,writes,clients};
}

test("orphan + project wrappers route a mapped same-profile blocked edit through final guard",async()=>{
  const h=harness();
  const sync=new OrphanRecoveringSynchronizer(h.state,undefined,h.clients);
  await sync.process(webhook);
  assert.deepEqual(h.audits.map(x=>x.action),[
    "todoist_preflight_guarded_recovery_routed",
    "todoist_project_guarded_recovery_routed",
    "todoist_task_sync_control_blocked",
  ]);
  assert.equal(h.reads.filter(x=>x[0]==="lock").length,2);
  assert.equal(h.reads.filter(x=>x[0]==="provider").length,1,
    "inner handler re-reads Todoist before accepting any update");
  assert.deepEqual(h.writes,[],"no unsafe provider mutation when final guard remains blocked");
});

test("project wrapper can route same verified-lock candidate directly",async()=>{
  const h=harness();
  const sync=new ProjectAwareSynchronizer(h.state,undefined,h.clients);
  await sync.process(webhook);
  assert.deepEqual(h.audits.map(x=>x.action),[
    "todoist_project_guarded_recovery_routed",
    "todoist_task_sync_control_blocked",
  ]);
  assert.deepEqual(h.writes,[]);
});

test("unrecoverable lock remains blocked with an explicit diagnostic, never silently ACKed",async()=>{
  const h=harness({hasRepair:false});
  const sync=new OrphanRecoveringSynchronizer(h.state,undefined,h.clients);
  await sync.process(webhook);
  assert.deepEqual(h.audits.map(x=>x.action),["todoist_preflight_sync_control_blocked"]);
  assert.equal(h.reads.some(x=>x[0]==="provider"),false);
  assert.deepEqual(h.writes,[]);
});

test("cross-profile source never bypasses the original guard",async()=>{
  const shifted={...task,project_id:profiles.work.todoistProjectId};
  const h=harness({source:shifted});
  const sync=new OrphanRecoveringSynchronizer(h.state,undefined,h.clients);
  await sync.process({...webhook,body:JSON.stringify({event_name:"item:updated",event_data:shifted})});
  assert.deepEqual(h.audits.map(x=>x.action),["todoist_preflight_sync_control_blocked"]);
  assert.deepEqual(h.writes,[]);
});

test("failed or unavailable lock read is not misreported as safe to bypass",async()=>{
  const h=harness();
  h.state.getCancelledAnnualRecoveryLock=async()=>{throw new Error("DynamoDB unavailable");};
  const sync=new OrphanRecoveringSynchronizer(h.state,undefined,h.clients);
  await assert.rejects(sync.process(webhook),/DynamoDB unavailable/);
  assert.deepEqual(h.writes,[]);
});
