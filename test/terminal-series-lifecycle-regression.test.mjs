import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

// repository.ts captures the table name at module import; configure before
// loading the production repository and cleanup implementations.
const priorTable=process.env.STATE_TABLE_NAME;
process.env.STATE_TABLE_NAME="terminal-lifecycle-test";
const {documentClient}=await import("../dist/dynamodb-capacity.js");
const {StateRepository}=await import("../dist/repository.js");
const {runCompletedHistoryCleanup}=await import("../dist/completed-history-cleanup.js");
const {SnapshotReconciler}=await import("../dist/reconciliation.js");

const completedAt="2026-10-22T12:00:00.000Z";
const at=(days,extra=0)=>Date.parse(completedAt)+days*86_400_000+extra;
const storageKey=({pk,sk="STATE"})=>pk+"|"+sk;
const providerMutation=()=>{throw new Error("No Todoist or Google Calendar mutation is permitted");};

function failedCondition(){
  const error=new Error("conditional item changed; no transaction applied");
  error.name="TransactionCanceledException";
  error.CancellationReasons=[{Code:"ConditionalCheckFailed"}];
  return error;
}

/** Minimal version-aware in-memory DynamoDB boundary for real repository and cleanup calls.
 * A failed condition aborts the entire transaction before writing any item.
 */
async function memory(t,seed=[]){
  const previousSend=documentClient.send;
  const rows=new Map(seed.map(item=>[storageKey(item),structuredClone(item)]));
  const transactions=[];
  let writes=0;
  t.after(()=>{
    documentClient.send=previousSend;
    if(priorTable===undefined)delete process.env.STATE_TABLE_NAME;
    else process.env.STATE_TABLE_NAME=priorTable;
  });
  documentClient.send=async command=>{
    const req=command.input;
    if(command instanceof GetCommand){
      assert.equal(req.ConsistentRead,true,"critical lookup must be consistent");
      return {Item:structuredClone(rows.get(storageKey(req.Key)))};
    }
    if(command instanceof QueryCommand){
      assert.equal(req.ConsistentRead,true,"terminal history cannot read stale task entries");
      const pk=req.ExpressionAttributeValues[":pk"];
      const prefix=req.ExpressionAttributeValues[":event"];
      const matches=[...rows.values()].filter(row=>row.pk===pk && row.sk.startsWith(prefix))
        .sort((a,b)=>a.sk.localeCompare(b.sk));
      const items=matches.slice(0,req.Limit);
      return {Items:items.map(structuredClone),
        ...(matches.length>req.Limit?{LastEvaluatedKey:{pk,sk:items.at(-1).sk}}:{})};
    }
    if(command instanceof ScanCommand){
      const all=[...rows.values()].filter(x=>x.pk.startsWith("COMPLETED_TASK#"));
      return {Items:all.slice(0,1).map(structuredClone),ScannedCount:all.length};
    }
    if(command instanceof TransactWriteCommand){
      transactions.push(req.TransactItems);
      // Preflight all constraints. No partial writes even if the last
      // mapping, link, task history, or owner changed under the writer.
      for(const item of req.TransactItems){
        const op=item.ConditionCheck||item.Put||item.Update||item.Delete;
        const existing=rows.get(storageKey(op.Key||op.Item));
        const expr=op.ConditionExpression||"";
        if(expr.includes("attribute_not_exists(pk)") && existing)throw failedCondition();
        if(item.Update && !existing)throw failedCondition();
        if(item.Delete && !existing)throw failedCondition();
        if(expr.includes("terminalCompletedAt = :time") &&
          existing?.terminalCompletedAt!==op.ExpressionAttributeValues[":time"])throw failedCondition();
        if(expr.includes("updatedAt = :updated") && existing &&
          existing.updatedAt!==op.ExpressionAttributeValues[":updated"])throw failedCondition();
        if(expr.includes("completedAt = :completed") && existing &&
          existing.completedAt!==op.ExpressionAttributeValues[":completed"])throw failedCondition();
        if(expr.includes("taskId = :task") && existing &&
          existing.taskId!==op.ExpressionAttributeValues[":task"])throw failedCondition();
      }
      for(const item of req.TransactItems){
        if(item.Put)rows.set(storageKey(item.Put.Item),structuredClone(item.Put.Item));
        if(item.Delete)rows.delete(storageKey(item.Delete.Key));
        if(item.Update){
          const key=storageKey(item.Update.Key);
          rows.set(key,{...rows.get(key),
            ...(item.Update.UpdateExpression.includes("terminalVerified")?{terminalVerified:true}:{})});
        }
      }
      writes++;
      return {};
    }
    if(command instanceof PutCommand){
      rows.set(storageKey(req.Item),structuredClone(req.Item));
      writes++;
      return {};
    }
    throw new Error("Unexpected command "+command.constructor.name);
  };
  return {rows,transactions,get writes(){return writes;}};
}

const completed=(owner,profile="home",taskId="finite-task",eventId="occurrence-final")=>({
  profile,taskId,eventId,completedAt,
  recurrenceOwner:owner,seriesId:"series-finite",masterEventId:"master-finite",
  originalStart:"2026-10-22T09:00:00Z",
});

test("#358 Todoist-owned final iteration writes terminal certificate with immutable event and task history",async t=>{
  const db=await memory(t);
  const repo=new StateRepository();
  const projection={...completed("todoist"),terminalVerified:true};
  await repo.putCompletedCalendarProjection(projection);
  const taskKey="COMPLETED_TASK#home#finite-task|EVENT#occurrence-final";
  const eventKey="COMPLETED_EVENT#home#occurrence-final|STATE";
  const seriesKey="COMPLETED_SERIES#home#series-finite|STATE";
  assert.equal(db.rows.get(eventKey).terminalVerified,true);
  assert.equal(db.rows.get(taskKey).terminalVerified,true);
  assert.deepEqual(
    [db.rows.get(seriesKey).recurrenceOwner,db.rows.get(seriesKey).masterEventId,
      db.rows.get(seriesKey).terminalCompletedAt],
    ["todoist","master-finite",completedAt]
  );
  assert.equal(db.transactions[0].filter(op=>op.Put).length,3,
    "event, task, and series evidence commit in the same transaction");
  const before=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(7,-1)});
  assert.equal(before.too_recent,1);
  assert.ok(db.rows.has(taskKey));
  assert.ok(db.rows.has(eventKey));
  const after=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(7)});
  assert.equal(after.retired,1);
  assert.equal(db.rows.has(taskKey),false,"task-facing history retired at exact 7-day boundary");
  assert.equal(db.rows.has(eventKey),true,"Calendar event replay guard remains immutable");
  assert.equal(db.rows.has(seriesKey),true,"terminal series evidence remains");
  const repeated=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(8)});
  assert.equal(repeated.retired,0,"next scan cannot re-retire or resurrect completed task");
  assert.equal(db.rows.has(eventKey),true);
});

test("#358 an earlier recurring completion must not manufacture terminal proof or expire by age",async t=>{
  const db=await memory(t);
  const repo=new StateRepository();
  const projection=completed("todoist");
  await repo.putCompletedCalendarProjection(projection);
  const key="COMPLETED_TASK#home#finite-task|EVENT#occurrence-final";
  assert.equal(db.rows.has("COMPLETED_SERIES#home#series-finite|STATE"),false);
  assert.equal(db.rows.get("COMPLETED_EVENT#home#occurrence-final|STATE").terminalVerified,undefined);
  const later=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(40)});
  assert.equal(later.skipped_ambiguous,1);
  assert.equal(db.rows.has(key),true);
  assert.equal(db.rows.has("COMPLETED_EVENT#home#occurrence-final|STATE"),true);
});

test("#358 Calendar-owned final iteration certifies only after conditionally retiring the exact link",async t=>{
  const link={pk:"RECURRENCE#work#series-finite",sk:"STATE",
    profile:"work",owner:"calendar",taskId:"finite-task",eventId:"occurrence-final",
    seriesId:"series-finite",masterEventId:"master-finite",activeInstanceId:"occurrence-final",
    updatedAt:"2026-10-22T11:00:00Z"};
  const db=await memory(t,[link]);
  const repo=new StateRepository();
  const projection=completed("calendar","work");
  await repo.putCompletedCalendarProjection(projection);
  assert.equal(db.rows.has("COMPLETED_SERIES#work#series-finite|STATE"),false);
  assert.equal(await repo.verifyTerminalCompletedCalendarProjection(projection,link),true);
  assert.equal(db.rows.has(storageKey(link)),false);
  assert.equal(db.rows.get("COMPLETED_EVENT#work#occurrence-final|STATE").terminalVerified,true);
  assert.equal(db.rows.get("COMPLETED_TASK#work#finite-task|EVENT#occurrence-final").terminalVerified,true);
  assert.equal(db.rows.get("COMPLETED_SERIES#work#series-finite|STATE").recurrenceOwner,"calendar");
  assert.ok(db.transactions.at(-1).some(x=>x.Delete?.Key.pk===link.pk));
  assert.ok(db.transactions.at(-1).some(x=>x.ConditionCheck?.Key.pk==="TASKOWNER#finite-task"));
  const before=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(7,-1)});
  assert.equal(before.too_recent,1);
  const after=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(7)});
  assert.equal(after.retired,1);
  assert.equal(db.rows.has("COMPLETED_TASK#work#finite-task|EVENT#occurrence-final"),false);
  assert.equal(db.rows.has("COMPLETED_EVENT#work#occurrence-final|STATE"),true);
});

test("#358 competing or future mapping blocks terminal certification and leaves all records intact",async t=>{
  const link={pk:"RECURRENCE#work#series-finite",sk:"STATE",
    profile:"work",owner:"calendar",taskId:"finite-task",eventId:"occurrence-final",
    seriesId:"series-finite",masterEventId:"master-finite",activeInstanceId:"occurrence-final",
    updatedAt:"2026-10-22T11:00:00Z"};
  const futureMapping={pk:"TASKOWNER#finite-task",sk:"MAP",
    profile:"work",taskId:"finite-task",eventId:"future-occurrence",
    recurrenceOwner:"calendar",seriesId:"future-series"};
  const db=await memory(t,[link,futureMapping]);
  const repo=new StateRepository();
  const projection=completed("calendar","work");
  await repo.putCompletedCalendarProjection(projection);
  assert.equal(await repo.verifyTerminalCompletedCalendarProjection(projection,link),false);
  assert.equal(db.rows.has(storageKey(link)),true);
  assert.equal(db.rows.has(storageKey(futureMapping)),true);
  assert.equal(db.rows.has("COMPLETED_SERIES#work#series-finite|STATE"),false);
  const cleanup=await runCompletedHistoryCleanup({apply:true,maxPages:1,nowMs:at(30)});
  assert.equal(cleanup.skipped_ambiguous,1,"elapsed time must not invent missing terminal evidence");
});

test("#358 retired associations are ignored on repeated snapshot reconciliation without touching providers",async()=>{
  const target={profile:"work",taskId:"historic-task",eventId:"historic-occurrence",
    recurrenceOwner:"calendar",seriesId:"historic-series",masterEventId:"historic-master",
    activeInstanceId:"historic-occurrence",updatedAt:completedAt};
  const future={...target,taskId:"future-task",eventId:"future-occurrence",
    seriesId:"future-series",masterEventId:"future-master"};
  const activeIndexes=new Map([[target.taskId,target],[future.taskId,future]]);
  const checked=[];
  const state={
    async isRetired(identity){
      checked.push(identity);
      return identity.taskId===target.taskId;
    },
    async audit(){throw new Error("A retired identity must not emit recurring_deferred");},
    async syncBlocked(){throw new Error("Retired identity must not enter sync controls");},
  };
  const clients={calendar:{getEvent:providerMutation,listEventInstances:providerMutation},
    todoist:{getTask:providerMutation}};
  const reconciler=new SnapshotReconciler(state);
  const first=await reconciler.reconcileMapping("work",target,undefined,clients);
  const second=await reconciler.reconcileMapping("work",target,undefined,clients);
  assert.equal(first,"noop");
  assert.equal(second,"noop");
  assert.equal(checked.length,2);
  assert.ok(checked.every(i=>i.seriesIds.includes("historic-series")));
  assert.deepEqual(activeIndexes.get(future.taskId),future,"unrelated future series remains mapped");
});
