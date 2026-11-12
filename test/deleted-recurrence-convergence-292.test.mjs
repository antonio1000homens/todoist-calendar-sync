import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand,PutCommand,QueryCommand,ScanCommand,UpdateCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {StateRepository} from "../dist/repository.js";
import {SnapshotReconciler} from "../dist/reconciliation.js";
import {requestDeletedConflictReview} from "../dist/deleted-conflict-recheck.js";

const profile="antonio";
const taskId="6hqp4fFR45WvJ5VV";
const masterId="agejr3i89v5p13lfl95uss11o8";
const activeId=masterId+"_20261116";
const completedId=masterId+"_20261102";
const seriesUid=masterId+String.fromCharCode(64)+"google.com";
const caseId="antonio-todoist_owned_recurrence_task_deleted-1227dad2ad8dd7071bdb";
const k=(pk,sk="STATE")=>pk+"|"+sk;
const clone=v=>v===undefined?undefined:structuredClone(v);

function fixture({masterStatus="cancelled",raceOwner=false,dismissed=false,
  unmapped=false,liveException=false}={}){
  const now="2026-10-25T19:10:24.379Z";
  const recurring={profile,taskId,owner:"todoist",seriesId:taskId,
    eventId:activeId,activeInstanceId:activeId,updatedAt:"2026-10-25T19:09:07.680Z"};
  const initialCase={id:caseId,profile,status:dismissed?"dismissed":"open",
    reason:unmapped?"calendar_snapshot_recurring_identity_conflict"
      :"todoist_owned_recurrence_task_deleted",title:"Legacy deleted recurrence",
    taskId,eventId:activeId,createdAt:now,updatedAt:now,
    lookupPk:"PROFILE#"+profile,
    lookupSk:(dismissed?"REVIEW#CLOSED#":"REVIEW#OPEN#")+now+"#"+caseId,
    decision:unmapped
      ?{type:"todoist_unmapped_conflict",status:dismissed?"resolved":"pending",
        taskId,eventId:activeId,context:{masterEventId:masterId,candidateTaskIds:[taskId]}}
      :{type:"todoist_owned_recurrence_task_deleted",status:dismissed?"resolved":"pending",
        taskId,eventId:activeId,activeInstanceId:activeId,seriesId:taskId,
        mappingSnapshot:{...recurring,recurrenceOwner:"todoist"}}};
  const manual={profile,decisionId:caseId,status:dismissed?"resolved":"pending",
    taskId,eventId:activeId,activeInstanceId:activeId,seriesId:taskId,
    createdAt:now,policyMode:"prompt",lookupPk:"PROFILE#"+profile,
    lookupSk:"MANUAL#PENDING#"+now};
  const history={profile,taskId,eventId:completedId,masterEventId:masterId,
    seriesId:seriesUid,recurrenceOwner:"calendar",completedAt:"2026-10-25T19:09:00.177Z"};
  const rows=new Map([
    [k("REVIEW_CASE#"+caseId),clone(initialCase)],
    [k("MANUAL#"+caseId),clone(manual)],
    ...(!unmapped?[[k("RECURRENCE#"+profile+"#"+taskId),clone(recurring)]]:[]),
    [k("COMPLETED_EVENT#"+profile+"#"+completedId),clone(history)],
    [k("COMPLETED_TASK#"+profile+"#"+taskId,"EVENT#"+completedId),clone(history)],
  ]);
  const audits=[], providerWrites=[], transactions=[];
  let injectRace=raceOwner;
  const master={id:masterId,status:masterStatus,iCalUID:seriesUid,
    recurrence:["RRULE:FREQ=WEEKLY;COUNT=4"],etag:"master-version-a"};
  const active={id:activeId,status:"cancelled",recurringEventId:masterId,
    iCalUID:seriesUid,etag:"active-version-a"};
  const historical={id:completedId,status:"confirmed",recurringEventId:masterId,
    iCalUID:seriesUid,start:{date:"2026-11-02"}};
  const clients={
    todoist:{
      async listTasks(){return []},
      async getTask(id){assert.equal(id,taskId);throw Object.assign(new Error("deleted"),{status:404})},
      async upsertTask(){providerWrites.push("todoist upsert");throw Error("provider mutation forbidden")},
      async deleteTask(){providerWrites.push("todoist delete");throw Error("provider mutation forbidden")},
    },
    calendar:{
      async getEvent(id){
        if(id===masterId)return clone(master);
        if(id===activeId)return clone(active);
        throw Object.assign(new Error("not found"),{status:404});
      },
      async listEventInstances(id){
        assert.equal(id,masterId);
        return [clone(active),clone(historical),
          ...(liveException?[{id:masterId+"_future",status:"confirmed",
            recurringEventId:masterId,iCalUID:seriesUid,start:{date:"2027-11-01"}}]:[])];
      },
      async upsertEvent(){providerWrites.push("calendar upsert");throw Error("provider mutation forbidden")},
      async deleteEvent(){providerWrites.push("calendar delete");throw Error("provider mutation forbidden")},
    },
  };
  // A deliberately small in-memory DynamoDB adapter. All mutation writes
  // are applied AFTER validating every transaction condition; an injected
  // competing owner cancels the entire transaction, just as DynamoDB does.
  const send=async command=>{
    if(command instanceof GetCommand) {
      return {Item:clone(rows.get(k(command.input.Key.pk,command.input.Key.sk)))};
    }
    if(command instanceof QueryCommand){
      const params=command.input.ExpressionAttributeValues;
      const prefix=params[":prefix"];
      const selected=params[":pk"];
      const items=command.input.IndexName==="ProfileLookupIndex"
        ? [...rows.values()].filter(row=>row.lookupPk===selected
          && row.lookupSk?.startsWith(prefix))
        : [...rows.entries()].filter(([key])=>key.startsWith(selected+"|")
          && key.split("|")[1].startsWith(prefix)).map(([,row])=>row);
      return {Items:clone(items)};
    }
    if(command instanceof ScanCommand)return {Items:[]};
    if(command instanceof PutCommand){
      const row=command.input.Item,key=k(row.pk,row.sk);
      const prior=rows.get(key);
      if(command.input.ConditionExpression&&prior
        && !(Number(prior.expiresAt||0)<Date.now()/1000))
        throw Object.assign(new Error("condition failed"),{name:"ConditionalCheckFailedException"});
      rows.set(key,clone(row));return {};
    }
    if(command instanceof UpdateCommand){
      const key=k(command.input.Key.pk,command.input.Key.sk),current=rows.get(key);
      if(command.input.UpdateExpression.includes("deletion_cleanup_deferred")){
        throw Error("unexpected deferred branch");
      }
      if(command.input.UpdateExpression.includes("SET #result = :message")){
        assert.equal(current.status,"open");
        assert.equal(current.updatedAt,command.input.ExpressionAttributeValues[":version"]);
        rows.set(key,{...current,result:command.input.ExpressionAttributeValues[":message"],
          updatedAt:command.input.ExpressionAttributeValues[":now"]});
        return {};
      }
      throw Error("Unexpected standalone UpdateCommand on "+key);
    }
    if(command instanceof TransactWriteCommand){
      const ops=command.input.TransactItems;
      transactions.push(ops);
      if(injectRace){
        rows.set(k("TASKOWNER#"+taskId,"MAP"),{
          pk:"TASKOWNER#"+taskId,sk:"MAP",profile:"work",taskId,eventId:"new-live-event"
        });
        injectRace=false;
      }
      const cancelled=()=>Object.assign(new Error("conditional owner/version conflict"),{name:"TransactionCanceledException"});
      const seen=new Set();
      for(const op of ops){
        const entry=op.ConditionCheck||op.Delete||op.Update||op.Put;
        const id=k(entry.Key?.pk||entry.Item?.pk,entry.Key?.sk||entry.Item?.sk);
        assert.ok(!seen.has(id),"transaction cannot target same DynamoDB key twice: "+id);
        seen.add(id);
        const current=rows.get(id);
        if(op.ConditionCheck){
          if(id.startsWith("SYNC_CONTROL#")){
            if(current?.activeRepair||current?.excluded)throw cancelled();
          }else if(current)throw cancelled();
        }else if(op.Delete&&entry.ConditionExpression){
          if(!current)throw cancelled();
          const vals=entry.ExpressionAttributeValues||{};
          if(id.startsWith("RECURRENCE#")){
            assert.equal(entry.ConditionExpression.includes("attribute_not_exists(masterEventId)"),true);
            if(current.profile!==vals[":profile"]||current.owner!==vals[":owner"]
              ||current.seriesId!==vals[":series"]||current.taskId!==vals[":task"]
              ||current.eventId!==vals[":event"]||current.updatedAt!==vals[":updated"]
              ||current.activeInstanceId!==vals[":activeInstanceId"]||current.masterEventId)
              throw cancelled();
          } else if (id.startsWith("AUDIT#")&&
            (current.action!==vals[":action"]||current.createdAt!==vals[":createdAt"]))
            throw cancelled();
        }else if(op.Update){
          const vals=entry.ExpressionAttributeValues;
          if(id.startsWith("REVIEW_CASE#")){
            if(!current||current.status!==vals[":old"]
              ||current.updatedAt!==vals[":version"]||current.operationId)throw cancelled();
          }else if(id.startsWith("MANUAL#")){
            if(!current||current.status!==vals[":old"]
              ||current.profile!==vals[":profile"]
              ||current.createdAt!==vals[":createdAt"])throw cancelled();
          }else throw Error("Unexpected update in retirement transaction: "+id);
        }
      }
      for(const op of ops){
        if(op.Delete)rows.delete(k(op.Delete.Key.pk,op.Delete.Key.sk));
        if(op.Update){
          const id=k(op.Update.Key.pk,op.Update.Key.sk);
          const old=rows.get(id);
          if(id.startsWith("REVIEW_CASE#")){
            rows.set(id,{...old,status:"resolved",
              result:"resolved_deleted: both provider objects verified absent; stale conflict retired",
              title:"Verified deletion",reason:"verified_deletion",
              lookupPk:undefined,lookupSk:undefined,decision:undefined,
              taskId:undefined,eventId:undefined,
              updatedAt:op.Update.ExpressionAttributeValues[":now"]});
          }else rows.set(id,{...old,status:"resolved",
            resolution:op.Update.ExpressionAttributeValues[":result"],
            taskId:undefined,eventId:undefined,lookupPk:undefined,lookupSk:undefined});
        }
      }
      return {};
    }
    throw Error("Unexpected DynamoDB command "+command.constructor.name);
  };
  const state=new StateRepository();
  state.getMode=async()=>"aws";
  state.audit=async(p,action,detail)=>audits.push({p,action,detail});
  state.getMappingByTaskAnyProfile=async id=>rows.get(k("TASKOWNER#"+id,"MAP"));
  state.getMappingByEvent=async(p,id)=>rows.get(k("EVENT#"+p+"#"+id,"MAP"));
  state.getRecurrenceLink=async(p,id)=>rows.get(k("RECURRENCE#"+p+"#"+id));
  state.getCompletedCalendarProjectionByEvent=async(p,id)=>rows.get(k("COMPLETED_EVENT#"+p+"#"+id));
  state.syncBlocked=async()=>false;
  const store={async listMappings(){return []},async deleteBaseline(){},async putBaseline(){throw Error("unexpected baseline write")}};
  const reconcile=()=>new SnapshotReconciler(state,async()=>clients,store,
    async()=>{providerWrites.push("repair");throw Error("unexpected repair")},async()=>{});
  return {send,rows,audits,providerWrites,transactions,reconcile,master,active,history};
}

test("#292 exact deleted task + cancelled Calendar master + completed old instance converge in two passes without provider writes",async()=>{
  const f=fixture();
  const original=f.rows.get(k("COMPLETED_EVENT#"+profile+"#"+completedId));
  const previous=f.rows.get(k("COMPLETED_TASK#"+profile+"#"+taskId,"EVENT#"+completedId));
  const old=documentClient.send;documentClient.send=f.send;
  try{
    const first=await f.reconcile().reconcile(profile);
    assert.equal(first.processedCandidates,0);
    assert.equal(f.transactions.length,1);
    assert.equal(f.rows.has(k("RECURRENCE#"+profile+"#"+taskId)),false);
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"resolved");
    assert.match(f.rows.get(k("REVIEW_CASE#"+caseId)).result,/resolved_deleted/);
    assert.equal(f.rows.get(k("MANUAL#"+caseId)).status,"resolved");
    assert.deepEqual(f.rows.get(k("COMPLETED_EVENT#"+profile+"#"+completedId)),original);
    assert.deepEqual(f.rows.get(k("COMPLETED_TASK#"+profile+"#"+taskId,"EVENT#"+completedId)),previous);
    assert.ok(f.transactions[0].some(op=>op.Delete?.Key.pk==="RECURRENCE#"+profile+"#"+taskId));
    assert.ok(f.transactions[0].some(op=>op.ConditionCheck?.Key.pk
      ==="RECURRENCE#work#"+seriesUid));
    assert.equal(f.providerWrites.length,0);
    // A subsequent reconciliation and delayed deletion deliveries must never
    // reopen this deterministic decision, create a counterpart or a new alert.
    const second=await f.reconcile().reconcile(profile);
    assert.equal(second.processedCandidates,0);
    assert.equal(f.transactions.length,1,"already-terminal case must not be rewritten");
    let deliveries=0;
    const enqueue=async()=>{deliveries++};
    assert.equal(await requestDeletedConflictReview(f.reconcile().state||{},profile,
      {taskIds:[taskId]},undefined,enqueue),false);
    assert.equal(await requestDeletedConflictReview(f.reconcile().state||{},profile,
      {eventIds:[masterId,activeId]},undefined,enqueue),false);
    assert.equal(deliveries,0);
    assert.equal(f.providerWrites.length,0);
    assert.deepEqual(f.audits.filter(entry=>entry.action==="verified_deletion_cleanup_completed").length,1);
  }finally{documentClient.send=old;}
});

test("#292 reopened ownership race atomically blocks stale recurrence retirement and leaves history and manual decision intact",async()=>{
  const f=fixture({raceOwner:true});
  const old=documentClient.send;documentClient.send=f.send;
  try{
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,1);
    assert.ok(f.rows.has(k("RECURRENCE#"+profile+"#"+taskId)));
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"open");
    assert.equal(f.rows.get(k("MANUAL#"+caseId)).status,"pending");
    assert.ok(f.rows.has(k("COMPLETED_EVENT#"+profile+"#"+completedId)));
    assert.ok(f.rows.has(k("COMPLETED_TASK#"+profile+"#"+taskId,"EVENT#"+completedId)));
    assert.equal(f.providerWrites.length,0);
    assert.equal(f.audits.some(entry=>entry.action==="verified_deletion_cleanup_deferred"),true);
  }finally{documentClient.send=old;}
});

test("#292 a still-live master never removes stale recurrence, decision, alert or completed historical records",async()=>{
  const f=fixture({masterStatus:"confirmed"});
  const old=documentClient.send;documentClient.send=f.send;
  try{
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,0);
    assert.ok(f.rows.has(k("RECURRENCE#"+profile+"#"+taskId)));
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"open");
    assert.equal(f.rows.get(k("MANUAL#"+caseId)).status,"pending");
    assert.ok(f.rows.has(k("COMPLETED_EVENT#"+profile+"#"+completedId)));
    assert.equal(f.providerWrites.length,0);
  }finally{documentClient.send=old;}
});

test("#292 dismissed legacy alert can retire the exact stale link without reopening the inbox",async()=>{
  const f=fixture({dismissed:true});
  const old=documentClient.send;documentClient.send=f.send;
  try{
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,1);
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"resolved");
    assert.equal(f.rows.get(k("MANUAL#"+caseId)).status,"resolved");
    assert.equal(f.rows.has(k("RECURRENCE#"+profile+"#"+taskId)),false);
    assert.equal(f.providerWrites.length,0);
  }finally{documentClient.send=old;}
});

test("#278 cancelled unmapped series with a surviving future exception never closes its case",async()=>{
  const f=fixture({unmapped:true,liveException:true});
  const old=documentClient.send;documentClient.send=f.send;
  try {
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,0);
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"open");
    assert.equal(f.rows.get(k("MANUAL#"+caseId)).status,"pending");
    assert.ok(f.rows.has(k("COMPLETED_EVENT#"+profile+"#"+completedId)));
    assert.deepEqual(f.providerWrites,[]);
  } finally {documentClient.send=old;}
});

test("#278 fully cancelled unmapped recurring master and occurrence safely close without deleting completed history",async()=>{
  const f=fixture({unmapped:true});
  const original=f.rows.get(k("COMPLETED_EVENT#"+profile+"#"+completedId));
  const old=documentClient.send;documentClient.send=f.send;
  try {
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,1);
    const tx=f.transactions[0];
    assert.ok(tx.some(op=>op.ConditionCheck?.Key.pk==="RECURRENCE#work#"+seriesUid),
      "the independently verified Calendar UID must be fenced in all profiles");
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"resolved");
    assert.equal(f.rows.get(k("MANUAL#"+caseId)).status,"resolved");
    assert.deepEqual(f.rows.get(k("COMPLETED_EVENT#"+profile+"#"+completedId)),original);
    assert.deepEqual(f.providerWrites,[]);
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,1,"repeat reconciliation must not create duplicate cleanup");
  } finally {documentClient.send=old;}
});

test("#278 cancelled unmapped master but a verified historical instance with changed completion metadata fails closed",async()=>{
  const f=fixture({unmapped:true});
  const original=f.rows.get(k("COMPLETED_EVENT#"+profile+"#"+completedId));
  f.rows.set(k("COMPLETED_EVENT#"+profile+"#"+completedId),
    {...original,seriesId:"unrelated-series"});
  const old=documentClient.send;documentClient.send=f.send;
  try {
    await f.reconcile().reconcile(profile);
    assert.equal(f.transactions.length,0);
    assert.equal(f.rows.get(k("REVIEW_CASE#"+caseId)).status,"open");
    assert.deepEqual(f.providerWrites,[]);
  } finally {documentClient.send=old;}
});
