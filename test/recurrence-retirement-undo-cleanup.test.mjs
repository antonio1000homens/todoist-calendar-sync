import test from "node:test";
import assert from "node:assert/strict";
import { buildUndoTransaction,RetirementUndoService,
  RETIREMENT_UNDO_PHRASE } from "../dist/recurrence-retirement-undo.js";
import { planRetirementIncidentCleanup,buildIncidentCleanupTransaction }
  from "../dist/recurrence-retirement-cleanup.js";

const target={profile:"work",generation:"historical-351",taskId:"task351",
  eventId:"oct-occurrence",seriesId:"series-uid-351"};
const op={
  pk:"RETIREMENT_OPERATION#11111111-1111-4111-8111-111111111111",sk:"STATE",
  operationId:"11111111-1111-4111-8111-111111111111",profile:"work",target,
  actorSubject:"operator-351",status:"retired",createdAt:"2026-11-06T19:00:00Z",
  retiredAt:"2026-11-06T19:15:00Z",confirmationHash:"hash",confirmationExpiresAt:"2026-11-06T19:30:00Z",
  planFingerprint:"p".repeat(64),inspectionFingerprint:"i".repeat(64),
  providerVersions:{masterEventId:"oct-master",masterEtag:"master-etag",
    occurrenceEtag:"occurrence-etag",completedAt:"2026-10-22T19:27:04.647Z",
    rrule:["RRULE:FREQ=DAILY;COUNT=2"]},
  undoConfirmationHash:"undo-hash",undoApprovedFingerprint:"u".repeat(64),
  undoApprovalExpiresAt:"2026-11-07T20:00:00Z",
};
const marker=(kind,id)=>({
  pk:"RETIREMENT#work#"+kind+"#"+id,sk:"STATE",
  profile:"work",status:"retired",operationId:op.operationId,
  taskId:target.taskId,seriesId:target.seriesId,masterEventId:"oct-master",
  createdAt:"2026-11-06T19:15:00Z",
});
const records=()=>[
  marker("TASK",target.taskId),marker("EVENT",target.eventId),
  marker("EVENT","oct-master"),marker("SERIES",target.seriesId),
  {pk:"COMPLETED_EVENT#work#oct-occurrence",sk:"STATE",taskId:target.taskId},
  {pk:"COMPLETED_SERIES#work#"+target.seriesId,sk:"STATE",seriesId:target.seriesId},
  {pk:"ERASURE_REPLAY#work",sk:"TASK#x#digest",createdAt:"2026-10-22"},
  {pk:"AUDIT#work#item-1",sk:"STATE",
    detail:{taskId:target.taskId,eventId:target.eventId},
    action:"todoist_snapshot_reconcile_conflict",createdAt:"2026-10-22T12:00:00Z",expiresAt:9999999999},
  {pk:"AUDIT_REF#work#todoist#"+target.taskId,sk:"AUDIT#item-1",
    auditKey:"AUDIT#work#item-1",profile:"work"},
  {pk:"AUDIT#work#shared",sk:"STATE",
    detail:{taskId:target.taskId,eventId:"foreign"},
    action:"todoist_snapshot_reconcile_conflict",createdAt:"2026-10-22T12:00:00Z",expiresAt:9999999999},
  {pk:"REVIEW_CASE#still-open",sk:"STATE",status:"open",taskId:"other"},
];
const inspection={
  operationId:op.operationId,profile:"work",
  eligible:true,blockers:[],fingerprint:op.undoApprovedFingerprint,
  markerKeys:[
    "RETIREMENT#work#TASK#task351","RETIREMENT#work#EVENT#oct-occurrence",
    "RETIREMENT#work#EVENT#oct-master","RETIREMENT#work#SERIES#series-uid-351",
  ].sort(),
};
test("#351 Undo changes only exact owned exclusions and receipt, never history, mapping, audit or providers",()=>{
  const command=buildUndoTransaction(op,inspection,records(),"2026-11-06T19:30:00Z","table");
  const writes=command.input.TransactItems;
  const deleted=writes.filter(x=>x.Delete).map(x=>x.Delete.Key.pk).sort();
  assert.deepEqual(deleted,inspection.markerKeys);
  assert.ok(writes.some(x=>x.Update?.Key.pk===op.pk));
  assert.ok(writes.some(x=>x.ConditionCheck?.Key.pk==="ERASURE#work"));
  assert.ok(writes.some(x=>x.ConditionCheck?.Key.pk==="TASKOWNER#task351"));
  assert.ok(writes.every(x=>!x.Put));
});
test("#351 Undo cannot remove missing, foreign-owned or active exclusions",()=>{
  const rows=records();
  rows[1]={...rows[1],operationId:"different-operator"};
  assert.throws(()=>buildUndoTransaction(op,inspection,rows,"2026-11-06T19:30:00Z","table"),
    /marker no longer belongs/i);
  assert.throws(()=>buildUndoTransaction(op,{...inspection,eligible:false},records(),
    "2026-11-06T19:30:00Z","table"),/freshly verified/i);
});
test("#351 incident cleanup selects only exactly attributable audits and their reverse pointers",()=>{
  const plan=planRetirementIncidentCleanup(op,records());
  assert.equal(plan.eligible,true);
  assert.deepEqual(plan.safeAuditKeys,["AUDIT#work#item-1"]);
  assert.deepEqual(plan.safeReferenceKeys,[
    {pk:"AUDIT_REF#work#todoist#task351",sk:"AUDIT#item-1"}]);
  const cmd=buildIncidentCleanupTransaction(op,plan,records(),
    "2026-11-06T19:31:00Z","table");
  const deletes=cmd.input.TransactItems.filter(x=>x.Delete).map(x=>x.Delete.Key.pk);
  assert.deepEqual(deletes,["AUDIT#work#item-1","AUDIT_REF#work#todoist#task351"]);
  assert.ok(!deletes.some(x=>/COMPLETED|ERASURE_REPLAY|shared|REVIEW_CASE/.test(x)));
  assert.ok(cmd.input.TransactItems.some(x=>x.Update?.Key.pk===op.pk));
});
test("#351 ambiguous other provider reference prevents deleting audit or foreign reverse index",()=>{
  const rows=records();
  rows.push({pk:"AUDIT_REF#work#calendar#foreign",sk:"AUDIT#foreign",
    auditKey:"AUDIT#work#item-1",profile:"work"});
  const plan=planRetirementIncidentCleanup(op,rows);
  assert.equal(plan.eligible,false);
  assert.deepEqual(plan.safeAuditKeys,[]);
  assert.deepEqual(plan.safeReferenceKeys,[]);
  assert.match(plan.blockedReasons.join(" / "),/foreign provider reverse index/);
});
test("#351 open review owner blocks incident deletion; unrelated audits preserved",()=>{
  const rows=records();
  rows.push({pk:"REVIEW_CASE#open-351",sk:"STATE",status:"open",
    sourceAuditKey:"AUDIT#work#item-1"});
  const plan=planRetirementIncidentCleanup(op,rows);
  assert.equal(plan.eligible,false);
  assert.deepEqual(plan.safeAuditKeys,[]);
  assert.ok(plan.blockedReasons.some(x=>x.includes("open review case")));
});

function fixture(t){
  const originals={table:process.env.STATE_TABLE_NAME,protocol:process.env.ERASURE_PROTOCOL_VERSION,
    version:process.env.RETIREMENT_DISPOSITION_VERSION};
  Object.assign(process.env,{STATE_TABLE_NAME:"table",ERASURE_PROTOCOL_VERSION:"1",
    RETIREMENT_DISPOSITION_VERSION:"1"});
  t.after(()=>{for(const [k,v] of Object.entries({
    STATE_TABLE_NAME:originals.table,ERASURE_PROTOCOL_VERSION:originals.protocol,
    RETIREMENT_DISPOSITION_VERSION:originals.version,
  }))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const rows=records();
  const master={id:"oct-master",etag:"master-etag",
    iCalUID:target.seriesId,status:"confirmed",
    recurrence:["RRULE:FREQ=DAILY;COUNT=2"]};
  const occurrence={id:"oct-occurrence",etag:"occurrence-etag",
    iCalUID:target.seriesId,status:"confirmed",recurringEventId:"oct-master",
    start:{dateTime:"2026-10-21T09:30:00Z"}};
  let stored={...op};let mutations=0;
  const db={async send(command){
    if(command.constructor.name==="GetCommand")return {Item:{...stored}};
    if(command.constructor.name==="UpdateCommand"){
      const data=command.input.ExpressionAttributeValues;
      stored={...stored,undoConfirmationHash:data[":hash"],
        undoApprovedFingerprint:data[":fingerprint"],
        undoApprovalExpiresAt:data[":expiry"]};
      return {};
    }
    if(command.constructor.name==="TransactWriteCommand"){
      mutations++;
      stored={...stored,status:"re_enabled"};
      return {};
    }
    throw Error("Unexpected database command "+command.constructor.name);
  }};
  let fence=null;
  const clients=async()=>({
    todoist:{
      async getTask(){throw Object.assign(new Error("not found"),{status:404});},
      async findCompletedTaskById(){return {id:target.taskId,
        completed_at:op.providerVersions.completedAt,is_deleted:false};},
    },
    calendar:{
      async getEvent(id){return id==="oct-master"?master:occurrence;},
      async listEventInstances(){return [occurrence];},
    },
  });
  const service=new RetirementUndoService({db,clientFactory:clients,
    inventory:async()=>rows,
    beginFence:async(_profile,id)=>{fence={operationId:id};},
    inspectFence:async()=>({fence,leases:[]}),
    finishFence:async()=>{fence=null;},
  });
  return {service,get state(){return stored;},get mutations(){return mutations;},get fence(){return fence;},rows};
}
test("#351 Undo requires direct readback, a separate confirmation and performs no provider writes",async t=>{
  const current=fixture(t);
  const before=await current.service.inspect(op.operationId,"operator-351");
  assert.equal(before.eligible,true);
  const granted=await current.service.approveUndo(op.operationId,before.fingerprint,"operator-351");
  assert.equal(granted.phrase,RETIREMENT_UNDO_PHRASE);
  assert.equal(granted.providerWrites,false);
  await assert.rejects(()=>current.service.applyUndo(op.operationId,"bad-token","operator-351",
    RETIREMENT_UNDO_PHRASE),/token|exact/i);
  const applied=await current.service.applyUndo(op.operationId,granted.confirmationId,
    "operator-351",RETIREMENT_UNDO_PHRASE);
  assert.equal(applied.status,"re_enabled");
  assert.equal(current.mutations,1);
  const again=await current.service.applyUndo(op.operationId,granted.confirmationId,
    "operator-351",RETIREMENT_UNDO_PHRASE);
  assert.equal(again.status,"re_enabled");
  assert.equal(current.mutations,1);
  assert.equal(current.fence,null);
});
test("#351 Undo rejects unknown actor and active/future Calendar occurrence without provider write",async t=>{
  const current=fixture(t);
  await assert.rejects(()=>current.service.inspect(op.operationId,"other-operator"),/operator/i);
  current.rows.push({pk:"TASK#home#task351",sk:"MAP",profile:"home",taskId:target.taskId});
  const inspected=await current.service.inspect(op.operationId,"operator-351");
  assert.equal(inspected.eligible,false);
  assert.match(inspected.blockers.join(" / "),/live or competing mapping/i);
});
