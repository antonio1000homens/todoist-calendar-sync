import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { ReviewEngine } from "../dist/review-engine.js";
import { StateRepository } from "../dist/repository.js";
import { SnapshotReconciler, DynamoReconciliationStore } from "../dist/reconciliation.js";
import { CanonicalIdentityStore } from "../dist/canonical-identity.js";
import { Synchronizer } from "../dist/sync.js";
import { ReviewStore, SyncControls } from "../dist/review-store.js";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { todoistRecurrenceKey, todoistRecurrenceToRrule } from "../dist/todoist-recurrence.js";
import { ManualDecisionStore, ManualInterventionService } from "../dist/manual-intervention.js";
import { SQSClient } from "@aws-sdk/client-sqs";

process.env.STATE_TABLE_NAME ||= "test-state";

const actor = { subject: "owner", email: "owner@example.test" };
const refKey = (ref) => `${ref.profile}:${ref.side}:${ref.id}`;
const clone = (value) => structuredClone(value);
const event = (id = "event", extra = {}) => ({ id, etag: "etag-1", status: "confirmed", summary: "Portugal",
  description: "Plan", start: { date: "2099-12-18" }, end: { date: "2099-12-21" }, ...extra });
const task = (id = "task", extra = {}) => ({ id, project_id: profiles.home.todoistProjectId,
  content: "Portugal", description: "Plan", due: { date: "2099-12-18" }, updated_at: "2026-10-21T12:00:00Z", ...extra });
const intent = (extra = {}) => ({ caseId: "case", profile: "home", action: "link", taskId: "task", eventId: "event",
  winner: "none", scope: "occurrence", leftovers: {}, ...extra });

test("repair queues a pending provider refresh before its final transaction releases the barrier", async (t) => {
  const h=harness(t);
  const order=[];
  const previousQueueUrl=process.env.QUEUE_URL;
  process.env.QUEUE_URL="https://sqs.eu-west-2.amazonaws.com/123/test.fifo";
  t.after(()=>{if(previousQueueUrl===undefined)delete process.env.QUEUE_URL;else process.env.QUEUE_URL=previousQueueUrl;});
  const pendingRefreshRefs=[{profile:"home",side:"todoist",id:"task",pendingRefreshAt:"refresh-version-1"}];
  h.controls.pendingRefreshRefs=async()=>pendingRefreshRefs;
  t.mock.method(StateRepository.prototype,"requestReconciliation",async(profile,reason,_context)=>{
    order.push("record-refresh");
    return {state:{profile,pending:true,generation:"refresh-generation",reason,requestedAt:new Date().toISOString(),lastRequestedAt:new Date().toISOString()},shouldEnqueue:true,created:true};
  });
  t.mock.method(StateRepository.prototype,"markReconciliationEnqueued",async()=>{});
  t.mock.method(SQSClient.prototype,"send",async command=>{
    const message=JSON.parse(command.input.MessageBody);
    assert.equal(message.kind,"reconcile");
    assert.deepEqual(message.reconcile.pendingRefreshRefs,pendingRefreshRefs);
    order.push("enqueue-refresh");
    return {};
  });
  const finalize=h.engine.store.finalizeOperation.bind(h.engine.store);
  h.engine.store.finalizeOperation=async(...args)=>{order.push("finalize-release");return finalize(...args);};

  const result=await h.execute(intent());

  assert.equal(result.status,"succeeded");
  assert.deepEqual(order,["record-refresh","enqueue-refresh","finalize-release"]);
});

test("repair keeps its barrier when a pending provider refresh cannot be queued", async (t) => {
  const h=harness(t);
  const previousQueueUrl=process.env.QUEUE_URL;
  process.env.QUEUE_URL="https://sqs.eu-west-2.amazonaws.com/123/test.fifo";
  t.after(()=>{if(previousQueueUrl===undefined)delete process.env.QUEUE_URL;else process.env.QUEUE_URL=previousQueueUrl;});
  h.controls.pendingRefreshRefs=async()=>[{profile:"home",side:"todoist",id:"task",pendingRefreshAt:"refresh-version-2"}];
  t.mock.method(StateRepository.prototype,"requestReconciliation",async(profile,reason)=>({
    state:{profile,pending:true,generation:"refresh-generation",reason,requestedAt:new Date().toISOString(),lastRequestedAt:new Date().toISOString()},shouldEnqueue:true,created:true,
  }));
  t.mock.method(SQSClient.prototype,"send",async()=>{throw new Error("queue unavailable");});

  const result=await h.execute(intent());

  assert.equal(result.status,"needs_review");
  assert.match(result.error,/reconciliation could not be queued/);
  assert.ok([...h.controlsMap.values()].every(control=>control.activeRepair==="repair"));
});

// Exercise the real preview/execute/provider conversion paths with in-memory
// provider and repository seams. Unexpected external calls fail these tests.
function harness(t, { events = [event()], tasks = [task()], mappings = [], recurrence, decision, caseStatus = "open" } = {}) {
  const eventMap = new Map(events.map(value => [value.id, clone(value)]));
  const taskMap = new Map(tasks.map(value => [value.id, clone(value)]));
  const mappingMap = new Map(mappings.map(value => [value.taskId, clone(value)]));
  const eventMappingMap = new Map(mappings.map(value => [`${value.profile}:${value.eventId}`,clone(value)]));
  const ownerMappingMap = new Map(mappings.map(value => [value.taskId,clone(value)]));
  const recurrences = new Map((Array.isArray(recurrence) ? recurrence : recurrence ? [recurrence] : []).map(value => [value.seriesId, clone(value)]));
  const controlsMap = new Map(), versions = new Map(), operations = new Map(), writes = [], calls = [], baselines = [];
  const taskRequests = new Map(), splits = new Map();
  const get = (map, id) => { if (!map.has(id)) throw Object.assign(new Error("Not found"), { status: 404 }); return clone(map.get(id)); };
  const stateMethods = {
    async assertHistoricalSeriesUnowned() {},
    async getSyncToken() { return "sync-token"; },
    async getCompletedCalendarProjectionByEvent() { return undefined; },
    async listCompletedCalendarProjectionsByTaskAnyProfile() { return []; },
    async getCalendarProjectionTombstone() { return undefined; },
    async getConsolidatedTask() { return undefined; },
    async putCalendarProjectionTombstone(...args) { calls.push(["tombstone",...args]); },
    async getMappingByTaskAnyProfile(id) { return clone(ownerMappingMap.get(id)); },
    async getMappingByTask(profile, id) { const value = mappingMap.get(id); return value?.profile === profile ? clone(value) : undefined; },
    async getMappingByEvent(profile, id) { return clone(eventMappingMap.get(`${profile}:${id}`)||[...mappingMap.values()].find(value=>value.profile===profile&&value.eventId===id)); },
    async getRecurrenceLink(_profile, id) { return clone(recurrences.get(id)); },
    async getRecurrenceLinkByTaskAnyProfile(id) {
      const matches=[...recurrences.values()].filter(value=>value.taskId===id);
      if(matches.length>1)throw new Error(`Todoist task ${id} is claimed by multiple recurrence links`);
      return clone(matches[0]);
    },
    async listRecurrenceLinks(profile) { return clone([...recurrences.values()].filter(value => value.profile === profile)); },
    async getFutureSeriesSplitAnyProfile(taskId) { return clone(splits.get(taskId)); },
    async beginFutureSeriesSplit(profile, taskId, oldMasterId, newMasterId, previousOccurrence) {
      const entry=splits.get(taskId);
      if(entry && (entry.profile!==profile || entry.oldMasterId!==oldMasterId || entry.newMasterId!==newMasterId))throw new Error("Conflicting split");
      if(!entry)splits.set(taskId,{profile,taskId,oldMasterId,newMasterId,previousOccurrence,status:"pending"});
    },
    async completeFutureSeriesSplit(_profile,taskId,masterId) { assert.equal(splits.get(taskId)?.newMasterId,masterId);splits.get(taskId).status="completed"; },
    async putNewRecurrenceMappingIfUnowned(mapping,link) {
      if(mappingMap.has(mapping.taskId)||recurrences.has(link.seriesId))return false;
      mappingMap.set(mapping.taskId,clone(mapping));recurrences.set(link.seriesId,clone(link));return true;
    },
    async putRecurrenceLink(value) { recurrences.set(value.seriesId, clone(value)); },
    async transferCalendarSeriesMapping({previous,replaced,replacedLink,expectedLink,mapping,link}) {
      const target=mappingMap.get(mapping.taskId), liveLink=recurrences.get(link.seriesId);
      if(!replaced&&target?.eventId===mapping.eventId&&target?.recurrenceOwner==="calendar"&&liveLink?.taskId===mapping.taskId)return true;
      if((replaced&&(target?.updatedAt!==replaced.updatedAt||target?.eventId!==replaced.eventId
          ||recurrences.get(replacedLink?.seriesId)?.updatedAt!==replacedLink?.updatedAt))
        ||(!replaced&&target) || (previous && (mappingMap.get(previous.taskId)?.updatedAt!==previous.updatedAt
        || mappingMap.get(previous.taskId)?.eventId!==previous.eventId))
        || (expectedLink && (liveLink?.taskId!==expectedLink.taskId||liveLink?.updatedAt!==expectedLink.updatedAt))) return false;
      if(previous){mappingMap.delete(previous.taskId);eventMappingMap.delete(`${previous.profile}:${previous.eventId}`);ownerMappingMap.delete(previous.taskId);}
      if(replaced){eventMappingMap.delete(`${replaced.profile}:${replaced.eventId}`);recurrences.delete(replacedLink.seriesId);}
      mappingMap.set(mapping.taskId,clone(mapping));
      eventMappingMap.set(`${mapping.profile}:${mapping.eventId}`,clone(mapping));ownerMappingMap.set(mapping.taskId,clone(mapping));
      recurrences.set(link.seriesId,clone(link));
      return true;
    },
    async commitFlattenMapping({mapping,previous,links}) {
      for (const m of previous) { mappingMap.delete(m.taskId); eventMappingMap.delete(`${m.profile}:${m.eventId}`); ownerMappingMap.delete(m.taskId); }
      for (const l of links) recurrences.delete(l.seriesId);
      mappingMap.set(mapping.taskId,clone(mapping)); eventMappingMap.set(`${mapping.profile}:${mapping.eventId}`,clone(mapping)); ownerMappingMap.set(mapping.taskId,clone(mapping));
      return true;
    },
    async deleteRecurrenceLink(_profile, id) { recurrences.delete(id); },
    async putMapping(value) { mappingMap.set(value.taskId, clone(value)); eventMappingMap.set(`${value.profile}:${value.eventId}`,clone(value)); ownerMappingMap.set(value.taskId,clone(value)); },
    async deleteMapping(value) { mappingMap.delete(value.taskId); eventMappingMap.delete(`${value.profile}:${value.eventId}`); ownerMappingMap.delete(value.taskId); },
    async commitElapsedCalendarHistoryDetach({profile,eventId,taskId,eventMapping,taskMapping,retainedEventMappings=[]}) {
      const currentEvent=eventMappingMap.get(`${profile}:${eventId}`);
      if(JSON.stringify(currentEvent||null)!==JSON.stringify(eventMapping||null))return false;
      if(JSON.stringify(mappingMap.get(taskId)||null)!==JSON.stringify(taskMapping||null)
        ||JSON.stringify(ownerMappingMap.get(taskId)||null)!==JSON.stringify(taskMapping||null))return false;
      for(const mapping of retainedEventMappings) if(JSON.stringify(eventMappingMap.get(`${profile}:${mapping.eventId}`)||null)!==JSON.stringify(mapping))return false;
      eventMappingMap.delete(`${profile}:${eventId}`);
      if(taskMapping?.eventId===eventId){mappingMap.delete(taskId);ownerMappingMap.delete(taskId);}
      return true;
    },
    async mutationAllowed() { return true; },
    async recordMutation() {},
    async deleteCalendarProjectionTombstone() {},
    async resolveConflictAudits() {},
    async syncBlocked() { return false; },
    async audit(_profile, action) { calls.push(["audit", action]); },
    async acceptTaskVersion(_profile, id, version) {
      calls.push(["version", id, version]);
      if (versions.has(id) && versions.get(id) >= version) return false;
      versions.set(id, version); return true;
    },
  };
  for (const [name, method] of Object.entries(stateMethods)) t.mock.method(StateRepository.prototype, name, method);
  t.mock.method(DynamoReconciliationStore.prototype, "putBaseline", async (...args) => { baselines.push(clone(args)); });
  t.mock.method(DynamoReconciliationStore.prototype, "deleteBaseline", async () => {});
  t.mock.method(CanonicalIdentityStore.prototype, "put", async () => {});
  const controls = {
    async control(ref) { return clone(controlsMap.get(refKey(ref))); },
    async pendingRefreshRefs() { return []; },
    async pendingRefreshRefs() { return []; },
    async claim(refs, id) { calls.push(["claim", clone(refs)]); for (const ref of refs) controlsMap.set(refKey(ref), { ...controlsMap.get(refKey(ref)), activeRepair: id }); },
    rejected: new Set(),
    async reject(profile, taskId, eventId) { this.rejected.add(`${profile}:${taskId}:${eventId}`); },
    async allow(profile, taskId, eventId) { this.rejected.delete(`${profile}:${taskId}:${eventId}`); },
    async exclude(ref, excluded) { controlsMap.set(refKey(ref), { ...controlsMap.get(refKey(ref)), excluded }); },
    async release(ref) { calls.push(["release", clone(ref)]); const value = controlsMap.get(refKey(ref)); delete value.activeRepair; },
    async releaseUnapplied(refs, id) { calls.push(["release-unapplied", clone(refs)]); for (const ref of refs) { assert.equal(controlsMap.get(refKey(ref))?.activeRepair,id); const old=controlsMap.get(refKey(ref)); controlsMap.set(refKey(ref),{...old,activeRepair:undefined,fencedAt:"2099-01-01T00:00:00Z"}); } },
  };
  const clients = {
    calendar: {
      async getEvent(id) { return get(eventMap, id); },
      async findByTodoistTaskId(taskId) { return clone([...eventMap.values()].find(value=>value.extendedProperties?.shared?.taskId===taskId)); },
      async listDelta() { return { items: clone([...eventMap.values()]) }; },
      async listExplicitSeriesExceptions() { return []; },
      async listInstances(id) { return clone([...eventMap.values()].filter(value => value.recurringEventId === id)); },
      async getTimeZone() { return "Europe/London"; },
      async listOccurrencesInWindow(from,to) {
        return clone([...eventMap.values()].filter(value => value.status !== "cancelled"
          && (value.start?.date || "") >= from.slice(0,10) && (value.start?.date || "") < to.slice(0,10)));
      },
      async listInstancesInWindow(id,from,to) {
        return clone([...eventMap.values()].filter(value => value.recurringEventId === id
          && (value.start?.date || "") >= from.slice(0,10) && (value.start?.date || "") < to.slice(0,10)));
      },
      async createFutureMasterOnce(value,historyId) {
        if(eventMap.has(value.id))return get(eventMap,value.id);
        assert.equal(value.extendedProperties.shared.syncHistoryMasterId,historyId);
        const master={...clone(value),etag:"created-etag",status:"confirmed"};
        eventMap.set(master.id,master);
        const occurrence={...clone(master),id:master.id+"_instance",recurrence:undefined,
          recurringEventId:master.id,originalStartTime:{date:master.start.date},etag:"instance-etag"};
        eventMap.set(occurrence.id,occurrence);
        writes.push(["create-future-master",master.id]);
        return clone(master);
      },
      async upsertEventIfUnchanged(value, id, etag) {
        assert.equal(eventMap.get(id)?.etag, etag);
        const next = { ...clone(value), id, etag: `etag-repair-${writes.length}` }; eventMap.set(id, next); writes.push(["event", id]);
        if(!eventMap.get(id+"_instance") && next.recurrence?.length) {
          eventMap.set(id+"_instance",{...clone(next),id:id+"_instance",recurrence:undefined,etag:"instance-etag",
            recurringEventId:id,originalStartTime:{date:next.start.date}});
        }
        return clone(next);
      },
      async updateSharedEventPropertiesIfUnchanged(id, etag, updates) {
        const current=eventMap.get(id);
        assert.equal(current?.etag,etag);
        const shared={...(current.extendedProperties?.shared||{})};
        for(const [name,value] of Object.entries(updates)) {
          if(value===null)delete shared[name];else shared[name]=value;
        }
        const next={...clone(current),etag:`etag-metadata-${writes.length}`,
          extendedProperties:{...(current.extendedProperties||{}),shared}};
        eventMap.set(id,next);writes.push(["instance-metadata",id]);return clone(next);
      },
      async createRepairEventOnce(value,operationId) {
        if(eventMap.has(value.id))return get(eventMap,value.id);
        const next={...clone(value),status:"confirmed",etag:"created-etag",extendedProperties:{...value.extendedProperties,shared:{...value.extendedProperties?.shared,syncRepairId:operationId}}};
        eventMap.set(value.id,next); writes.push(["create-event", value.id]); return clone(next);
      },
      async deleteEventIfUnchanged(id,etag) {
        assert.equal(eventMap.get(id)?.etag,etag,"Calendar deletion uses the exact previewed ETag");
        eventMap.delete(id); writes.push(["delete-event",id]);
      },
      async upsertEvent() { assert.fail("Unexpected anonymous Calendar write"); },
    },
    todoist: {
      async getTimeZone() { return "Europe/London"; },
      async getTask(id) { return get(taskMap, id); },
      async listTasks() { return clone([...taskMap.values()]); },
      async upsertTask(value, id) {
        id ||= "created-task"; const next = { project_id:profiles.home.todoistProjectId, ...taskMap.get(id), ...clone(value), id, updated_at: "2026-10-21T14:00:00Z" };
        taskMap.set(id, next); writes.push(["task", id]); return clone(next);
      },
      async createTaskOnce(value,key) {
        if(taskRequests.has(key))return get(taskMap,taskRequests.get(key));
        const next = task(taskRequests.size ? `created-task-${taskRequests.size+1}` : "created-task", value);
        taskRequests.set(key,next.id);taskMap.set(next.id, next); writes.push(["create-task", next.id]); return clone(next);
      },
      async findComment() { return undefined; },
      async upsertComment() { return { id:"comment" }; },
      async listProjectComments() { return []; },
      async upsertProjectComment(_project, content) { writes.push(["comment"]); return { id: "comment", content }; },
    },
  };
  const store = {
    async getCase() { return { id: "case", profile: "home", status:caseStatus, decision }; },
    async putPreview() {},
    async getOperation(id) { return operations.get(id); },
    async saveOperation(operation) { operations.set(operation.id, clone(operation)); },
    async finalizeOperation(operation, releases) {
      // Model the all-or-nothing control/result transaction at its boundary.
      for (const item of releases) assert.equal(controlsMap.get(refKey(item.ref))?.activeRepair, operation.id);
      const completed = { ...operation, status:"succeeded", notificationPending:true };
      for (const item of releases) {
        if (item.clearExclusion) await controls.exclude(item.ref, false);
        await controls.release(item.ref);
        if (!item.preserveControlState) controlsMap.get(refKey(item.ref)).fencedAt = "2099-01-01T00:00:00Z";
      }
      operations.set(operation.id, clone(completed));
      return completed;
    },
    async updateCase() {},
  };
  const engine = new ReviewEngine(store, new StateRepository(), async () => clients, controls);
  const execute = async (input) => {
    const preview = await engine.preview(actor, input);
    operations.set("repair", { id: "repair", status: "queued", steps: {}, preview });
    return engine.execute("repair");
  };
  return { engine, execute, clients, eventMap, taskMap, mappingMap, eventMappingMap, ownerMappingMap, recurrences, controls, controlsMap, versions, operations, writes, calls, baselines };
}

function moveHarness(t,{existing=true}={}) {
  const h=harness(t,{events:[event("event",{extendedProperties:{shared:{taskId:"task"}}})],mappings:[{profile:"home",taskId:"task",eventId:"event"}]});
  const destinationEvents=new Map(existing?[["destination",event("destination",{summary:"Old destination",extendedProperties:{shared:{taskId:"task"}}})]]:[]);
  const get=async id=>{if(!destinationEvents.has(id))throw Object.assign(new Error("Not found"),{status:404});return clone(destinationEvents.get(id));};
  const write=async(value,id)=>{
    const next={...clone(value),id,status:"confirmed",etag:`destination-${h.writes.length}`};destinationEvents.set(id,next);h.writes.push(["destination-event",id]);return clone(next);
  };
  const destination={todoist:h.clients.todoist,calendar:{
    getEvent:get,
    async findByTodoistTaskId(taskId){const matches=[...destinationEvents.values()].filter(e=>e.extendedProperties?.shared?.taskId===taskId);assert.ok(matches.length<=1);return clone(matches[0]);},
    async listDelta(){return {items:clone([...destinationEvents.values()])};},async listInstances(){return [];},
    async upsertEvent(value,id){assert.ok(id);return write(value,id);},
    async upsertEventIfUnchanged(value,id,etag){assert.equal(destinationEvents.get(id).etag,etag);return write(value,id);},
    async createRepairEventOnce(value,operationId){
      if(destinationEvents.has(value.id))return get(value.id);
      return write({...value,extendedProperties:{...value.extendedProperties,shared:{...value.extendedProperties?.shared,syncRepairId:operationId}}},value.id);
    },
  }};
  h.clients.calendar.deleteEvent=async id=>{h.writes.push(["delete-source",id]);h.eventMap.delete(id);};
  h.clients.todoist.moveTask=async(id,projectId)=>{Object.assign(h.taskMap.get(id),{project_id:projectId,updated_at:"2026-10-22T00:00:00Z"});h.writes.push(["move-task",id]);};
  h.clients.todoist.findComment=async()=>undefined;
  h.clients.todoist.upsertComment=async()=>({id:"projection-comment"});
  const engine=new ReviewEngine(h.engine.store,new StateRepository(),async profile=>profile==="home"?h.clients:destination,h.controls);
  const input=intent({action:"move",targetProfile:"work"});
  const execute=async()=>{const preview=await engine.preview(actor,input);h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});return engine.execute("repair");};
  return {...h,engine,execute,input,destination,destinationEvents};
}

test("elapsed Calendar history repair removes only the old event link and preserves the future task indexes",async t=>{
  const oldMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z"};
  const futureMapping={profile:"home",taskId:"task",eventId:"future",updatedAt:"2026-10-02T00:00:00Z"};
  const oldEvent=event("elapsed",{summary:"Vehicle tax",start:{date:"2025-05-02"},end:{date:"2025-05-03"},
    extendedProperties:{shared:{taskId:"task",taskUrl:"https://todoist.example/task",syncSource:"todoist-calendar-sync",custom:"keep"}}});
  const future=event("future",{summary:"Vehicle tax",start:{date:"2099-05-02"},end:{date:"2099-05-03"},
    extendedProperties:{shared:{taskId:"task",taskUrl:"https://todoist.example/task",syncSource:"todoist-calendar-sync"}}});
  const h=harness(t,{events:[oldEvent,future],tasks:[task("task",{content:"Vehicle tax",due:{date:"2099-05-02"}})],mappings:[oldMapping,futureMapping]});
  const input=intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed",scope:"future"});
  const preview=await h.engine.preview(actor,input);
  assert.equal(preview.elapsedCalendarHistoryPlan.eventId,"elapsed");
  assert.equal(preview.elapsedCalendarHistoryPlan.retainedTaskMapping.eventId,"future");
  assert.ok(preview.changes.some(change=>change.includes("Retain exact current/future mapping")&&change.includes("future")));
  assert.ok(preview.itemPlan.find(item=>item.ref.id==="future").result.includes("unchanged"));

  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  assert.equal(h.eventMap.get("elapsed").status,"confirmed");
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.syncHistoryOnly,"true");
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.taskId,undefined);
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.taskUrl,undefined);
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.custom,"keep");
  assert.equal(h.eventMappingMap.has("home:elapsed"),false);
  assert.equal(h.eventMappingMap.get("home:future").eventId,"future");
  assert.equal(h.mappingMap.get("task").eventId,"future");
  assert.equal(h.ownerMappingMap.get("task").eventId,"future");
  assert.deepEqual(h.writes,[ ["event","elapsed"] ]);
});

test("elapsed occurrence in a Calendar-owned series becomes history without changing its master or future mapping",async t=>{
  const mapping={profile:"home",taskId:"task",eventId:"active",recurrenceOwner:"calendar",seriesId:"calendar-series",
    masterEventId:"master",activeInstanceId:"active",calendarProgressVersion:1,updatedAt:"2026-10-02T00:00:00Z"};
  const shared={taskId:"task",taskUrl:"https://todoist.example/task",syncSource:"todoist-calendar-sync",
    syncRecurrenceOwner:"calendar",custom:"keep"};
  const master=event("master",{iCalUID:"calendar-series",recurrence:["RRULE:FREQ=WEEKLY"],start:{date:"2025-01-01"},end:{date:"2025-01-02"},
    extendedProperties:{shared:{...shared}}});
  const elapsed=event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},recurringEventId:"master",
    originalStartTime:{date:"2025-05-02"},extendedProperties:{shared:{...shared}}});
  const active=event("active",{start:{date:"2099-12-18"},end:{date:"2099-12-21"},recurringEventId:"master",
    originalStartTime:{date:"2099-12-18"},extendedProperties:{shared:{...shared}}});
  const link={...mapping,owner:"calendar",updatedAt:"2026-10-04T00:00:00Z"};
  const h=harness(t,{events:[master,elapsed,active],tasks:[task("task")],mappings:[mapping],recurrence:link});
  const masterBefore=clone(h.eventMap.get("master")),activeBefore=clone(h.eventMap.get("active"));
  const mappingBefore=clone(h.mappingMap.get("task")),linkBefore=clone(h.recurrences.get("calendar-series"));
  const input=intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed",scope:"occurrence"});
  const preview=await h.engine.preview(actor,input);
  assert.equal(preview.elapsedCalendarHistoryPlan.recurringMasterId,"master");
  assert.ok(preview.changes.some(change=>change.includes("Keep Calendar master master and its RRULE unchanged")));

  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.eventMap.get("elapsed").status,"confirmed");
  assert.equal(h.eventMap.get("elapsed").recurringEventId,"master");
  assert.deepEqual(h.eventMap.get("elapsed").originalStartTime,{date:"2025-05-02"});
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.syncHistoryOnly,"true");
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.taskId,undefined);
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.syncRecurrenceOwner,undefined);
  assert.equal(h.eventMap.get("elapsed").extendedProperties.shared.custom,"keep");
  assert.deepEqual(h.eventMap.get("master"),masterBefore);
  assert.deepEqual(h.eventMap.get("active"),activeBefore);
  assert.deepEqual(h.mappingMap.get("task"),mappingBefore);
  assert.deepEqual(h.eventMappingMap.get("home:active"),mappingBefore);
  assert.deepEqual(h.ownerMappingMap.get("task"),mappingBefore);
  assert.deepEqual(h.recurrences.get("calendar-series"),linkBefore);
  assert.deepEqual(h.writes,[["instance-metadata","elapsed"]]);
});

test("elapsed recurring occurrence refuses a conflicting event mapping before provider writes",async t=>{
  const mapping={profile:"home",taskId:"task",eventId:"active",recurrenceOwner:"calendar",seriesId:"calendar-series",
    masterEventId:"master",activeInstanceId:"active",calendarProgressVersion:1,updatedAt:"2026-10-02T00:00:00Z"};
  const shared={taskId:"task",syncRecurrenceOwner:"calendar"};
  const master=event("master",{iCalUID:"calendar-series",recurrence:["RRULE:FREQ=WEEKLY"],extendedProperties:{shared:{...shared}}});
  const elapsed=event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},recurringEventId:"master",
    originalStartTime:{date:"2025-05-02"},extendedProperties:{shared:{...shared}}});
  const active=event("active",{start:{date:"2099-12-18"},end:{date:"2099-12-21"},recurringEventId:"master",
    originalStartTime:{date:"2099-12-18"},extendedProperties:{shared:{...shared}}});
  const h=harness(t,{events:[master,elapsed,active],tasks:[task("task")],mappings:[mapping],recurrence:{...mapping,owner:"calendar"}});
  h.eventMappingMap.set("home:elapsed",{...mapping,eventId:"elapsed",activeInstanceId:"active",updatedAt:"2026-10-03T00:00:00Z"});
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/own event mapping/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed recurring occurrence refuses a conflicting master event mapping before provider writes",async t=>{
  const mapping={profile:"home",taskId:"task",eventId:"active",recurrenceOwner:"calendar",seriesId:"calendar-series",
    masterEventId:"master",activeInstanceId:"active",calendarProgressVersion:1,updatedAt:"2026-10-02T00:00:00Z"};
  const shared={taskId:"task",syncRecurrenceOwner:"calendar"};
  const master=event("master",{iCalUID:"calendar-series",recurrence:["RRULE:FREQ=WEEKLY"],extendedProperties:{shared:{...shared}}});
  const elapsed=event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},recurringEventId:"master",
    originalStartTime:{date:"2025-05-02"},extendedProperties:{shared:{...shared}}});
  const active=event("active",{start:{date:"2099-12-18"},end:{date:"2099-12-21"},recurringEventId:"master",
    originalStartTime:{date:"2099-12-18"},extendedProperties:{shared:{...shared}}});
  const h=harness(t,{events:[master,elapsed,active],tasks:[task("task")],mappings:[mapping],recurrence:{...mapping,owner:"calendar"}});
  h.eventMappingMap.set("home:master",{profile:"home",taskId:"other-task",eventId:"master",updatedAt:"2026-10-03T00:00:00Z"});
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/verified Calendar-owned master/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed recurring occurrence refuses a duplicate cross-profile recurrence link before provider writes",async t=>{
  const mapping={profile:"home",taskId:"task",eventId:"active",recurrenceOwner:"calendar",seriesId:"calendar-series",
    masterEventId:"master",activeInstanceId:"active",calendarProgressVersion:1,updatedAt:"2026-10-02T00:00:00Z"};
  const shared={taskId:"task",syncRecurrenceOwner:"calendar"};
  const master=event("master",{iCalUID:"calendar-series",recurrence:["RRULE:FREQ=WEEKLY"],extendedProperties:{shared:{...shared}}});
  const elapsed=event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},recurringEventId:"master",
    originalStartTime:{date:"2025-05-02"},extendedProperties:{shared:{...shared}}});
  const active=event("active",{start:{date:"2099-12-18"},end:{date:"2099-12-21"},recurringEventId:"master",
    originalStartTime:{date:"2099-12-18"},extendedProperties:{shared:{...shared}}});
  const h=harness(t,{events:[master,elapsed,active],tasks:[task("task")],mappings:[mapping],recurrence:{...mapping,owner:"calendar"}});
  h.recurrences.set("other-profile-series",{...mapping,profile:"work",seriesId:"other-profile-series",updatedAt:"2026-10-03T00:00:00Z"});
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/multiple recurrence links across profiles/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed recurring occurrence refuses recurrenceId on its task-side mapping before provider writes",async t=>{
  const mapping={profile:"home",taskId:"task",eventId:"active",recurrenceOwner:"calendar",seriesId:"calendar-series",
    masterEventId:"master",activeInstanceId:"active",calendarProgressVersion:1,updatedAt:"2026-10-02T00:00:00Z"};
  const shared={taskId:"task",syncRecurrenceOwner:"calendar"};
  const master=event("master",{iCalUID:"calendar-series",recurrence:["RRULE:FREQ=WEEKLY"],extendedProperties:{shared:{...shared}}});
  const elapsed=event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},recurringEventId:"master",
    originalStartTime:{date:"2025-05-02"},extendedProperties:{shared:{...shared}}});
  const active=event("active",{start:{date:"2099-12-18"},end:{date:"2099-12-21"},recurringEventId:"master",
    originalStartTime:{date:"2099-12-18"},extendedProperties:{shared:{...shared}}});
  const taskMapping={...mapping,recurrenceId:"unexpected-series"};
  const h=harness(t,{events:[master,elapsed,active],tasks:[task("task")],mappings:[taskMapping],recurrence:{...mapping,owner:"calendar"}});
  h.eventMappingMap.set("home:active",mapping);
  h.ownerMappingMap.set("task",taskMapping);
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/verified Calendar-owned master/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed Calendar history preview fails closed when task and owner indexes disagree",async t=>{
  const oldMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z"};
  const futureMapping={profile:"home",taskId:"task",eventId:"future",updatedAt:"2026-10-02T00:00:00Z"};
  const h=harness(t,{events:[event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},extendedProperties:{shared:{taskId:"task"}}}),
      event("future",{start:{date:"2099-05-02"},end:{date:"2099-05-03"},extendedProperties:{shared:{taskId:"task"}}})],
    tasks:[task("task")],mappings:[oldMapping,futureMapping]});
  h.ownerMappingMap.set("task",{...futureMapping,updatedAt:"2026-10-03T00:00:00Z"});
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/mapping indexes disagree/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed Calendar history rejects recurrence metadata on matching task-side indexes",async t=>{
  const oldEventMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z"};
  const recurringTaskMapping={...oldEventMapping,recurrenceOwner:"todoist",seriesId:"series",masterEventId:"master",activeInstanceId:"elapsed"};
  const h=harness(t,{events:[event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},extendedProperties:{shared:{taskId:"task"}}})],
    tasks:[task("task")],mappings:[recurringTaskMapping]});
  h.eventMappingMap.set("home:elapsed",oldEventMapping);
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/recurring task mapping/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed Calendar history rejects recurrenceId on the selected event mapping",async t=>{
  const eventMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z",recurrenceId:"series"};
  const plainTaskMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z"};
  const h=harness(t,{events:[event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},extendedProperties:{shared:{taskId:"task"}}})],
    tasks:[task("task")],mappings:[plainTaskMapping]});
  h.eventMappingMap.set("home:elapsed",eventMapping);
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/recurrence-owned/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed Calendar history rejects recurrenceId on matching task-side mappings",async t=>{
  const eventMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z"};
  const taskMapping={...eventMapping,recurrenceId:"series"};
  const h=harness(t,{events:[event("elapsed",{start:{date:"2025-05-02"},end:{date:"2025-05-03"},extendedProperties:{shared:{taskId:"task"}}})],
    tasks:[task("task")],mappings:[taskMapping]});
  h.eventMappingMap.set("home:elapsed",eventMapping);
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/recurring task mapping/);
  assert.deepEqual(h.writes,[]);
});

test("elapsed Calendar history classifies all-day retained counterparts in the Calendar timezone",async t=>{
  const oldMapping={profile:"home",taskId:"task",eventId:"elapsed",updatedAt:"2026-10-01T00:00:00Z"};
  const staleCounterpartMapping={profile:"home",taskId:"task",eventId:"old-all-day",updatedAt:"2026-10-02T00:00:00Z"};
  const h=harness(t,{events:[
    event("elapsed",{start:{dateTime:"2025-05-02T12:00:00Z"},end:{dateTime:"2025-05-02T13:00:00Z"},extendedProperties:{shared:{taskId:"task"}}}),
    event("old-all-day",{start:{date:"2020-05-02"},end:{date:"2020-05-03"},extendedProperties:{shared:{taskId:"task"}}}),
  ],tasks:[task("task")],mappings:[oldMapping,staleCounterpartMapping]});
  await assert.rejects(h.engine.preview(actor,intent({action:"calendar-history-only",taskId:"task",eventId:"elapsed"})),/no verified live Calendar counterpart/);
  assert.deepEqual(h.writes,[]);
});

test("a move previews, claims, and verifies its existing destination Calendar projection",async t=>{
  const h=moveHarness(t),preview=await h.engine.preview(actor,h.input);
  assert.ok(preview.snapshots.some(s=>s.ref.profile==="work"&&s.ref.id==="destination"));
  assert.deepEqual(preview.snapshots.find(s=>s.ref.side==="todoist").destination,{profile:"work",eventId:"destination"});
  const result=await h.execute();assert.equal(result.status,"succeeded",result.error);
  assert.ok(h.calls.find(c=>c[0]==="claim")[1].some(ref=>ref.profile==="work"&&ref.id==="destination"));
  assert.equal(h.destinationEvents.get("destination").summary,"Portugal");
  assert.equal(h.mappingMap.get("task").profile,"work");assert.ok(!h.eventMap.has("event"));
});

test("a confirmed multi-day Calendar event and matching Todoist task produce a preview or an actionable validation",async t=>{
  const h=harness(t,{
    tasks:[task("6hQ4jRqcGPVgFwVj",{content:"Antonio on-call",due:{date:"2026-11-23"}})],
    events:[event("7jlq4bim3a0t8inv8kgu1pnp1g",{summary:"Antonio on-call",start:{date:"2026-11-23"},end:{date:"2026-11-30"}})],
  });
  const base={...intent(),taskId:"6hQ4jRqcGPVgFwVj",eventId:"7jlq4bim3a0t8inv8kgu1pnp1g"};
  const keepFieldsPreview=await h.engine.preview(actor,base);
  assert.equal(keepFieldsPreview.intent.winner,"none");
  const preview=await h.engine.preview(actor,{...base,winner:"calendar"});
  assert.equal(preview.intent.winner,"calendar");
  assert.ok(preview.changes.some(change=>change.includes("Link Todoist task")&&change.includes("use calendar fields")));
  assert.equal(preview.snapshots.find(snapshot=>snapshot.ref.side==="calendar").object.status,"confirmed");
});

for(const change of ["edit","new projection"]) test(`a destination ${change} after validation stops a move before source mutations`,async t=>{
  const h=moveHarness(t,{existing:change==="edit"}),save=h.engine.store.saveOperation;
  h.engine.store.saveOperation=async operation=>{
    await save(operation);
    if(operation.steps.validated?.status==="done"){
      if(change==="edit")h.destinationEvents.get("destination").summary="Unapproved edit";
      else h.destinationEvents.set("new",event("new",{extendedProperties:{shared:{taskId:"task"}}}));
    }
  };
  const result=await h.execute();assert.notEqual(result.status,"succeeded");assert.match(result.error,/destination.*changed/i);
  assert.equal(h.taskMap.get("task").project_id,profiles.home.todoistProjectId);
  assert.ok(h.eventMap.has("event"));assert.deepEqual(h.writes,[]);
});

test("an unpreviewed destination discovered after task movement cannot delete the source projection",async t=>{
  const h=moveHarness(t,{existing:false}),move=h.clients.todoist.moveTask;
  h.clients.todoist.moveTask=async(...args)=>{await move(...args);h.destinationEvents.set("new",event("new",{extendedProperties:{shared:{taskId:"task"}}}));};
  const result=await h.execute();assert.equal(result.status,"needs_review");assert.match(result.error,/destination projection changed/);
  assert.ok(h.eventMap.has("event"));assert.ok(!h.writes.some(w=>w[0]==="delete-source"));
});

function seriesFixture() {
  const master = event("master", { iCalUID: "calendar-series", recurrence: ["RRULE:FREQ=WEEKLY"] });
  const active = event("active", { recurringEventId: master.id, originalStartTime: { date: "2099-12-18" } });
  const mapping = { profile: "home", taskId: "task", eventId: active.id, recurrenceOwner: "calendar",
    masterEventId: master.id, seriesId: master.iCalUID, activeInstanceId: active.id, calendarProgressVersion: 1,
    originalStart: "2099-12-18", completedThroughOriginalStart: "2099-12-11" };
  return { events: [master, active], mappings: [mapping], recurrence: { ...mapping, owner: "calendar" } };
}

function birthdayTransferFixture() {
  const title="Michelles/Mae Birthday", due={date:"2027-07-17",is_recurring:true,string:"every year"};
  const annual=task("annual-task",{content:title,description:"Birthday reminder",due});
  const displaced=task("old-oneoff",{content:title,description:"Birthday reminder",due:{date:"2027-07-17"}});
  const master=event("birthday-master",{iCalUID:"birthday-series",summary:title,description:"Birthday reminder",
    start:{date:"2023-07-17"},end:{date:"2023-07-18"},recurrence:[todoistRecurrenceToRrule(annual)],
    extendedProperties:{shared:{taskId:displaced.id,syncRecurrenceOwner:"calendar"}}});
  const active=event("birthday-2027",{summary:title,description:"Birthday reminder",start:{date:"2027-07-17"},end:{date:"2027-07-18"},
    recurringEventId:master.id,originalStartTime:{date:"2027-07-17"},extendedProperties:{shared:{taskId:displaced.id,syncRecurrenceOwner:"calendar"}}});
  const standalone=event("birthday-standalone",{summary:title,description:"Birthday reminder",start:{date:"2027-07-17"},end:{date:"2027-07-18"}});
  const mapping={profile:"home",taskId:displaced.id,eventId:active.id,projectId:profiles.home.todoistProjectId,
    recurrenceOwner:"calendar",seriesId:master.iCalUID,masterEventId:master.id,activeInstanceId:active.id,
    originalStart:"2027-07-17",activeEffectiveStart:"2027-07-17",calendarProgressVersion:1,
    completedThroughOriginalStart:"2026-07-17",updatedAt:"2026-10-22T12:00:00.000Z"};
  const recurrence={...mapping,owner:"calendar"};
  return {annual,displaced,master,active,standalone,mapping,recurrence};
}

const transferIntent=(fixture, leftovers={})=>intent({action:"transfer",taskId:fixture.annual.id,eventId:fixture.master.id,
  winner:"none",owner:"calendar",scope:"future",leftovers});

test("Calendar-owned series transfer preserves the recurring birthday task and atomically reassigns all mapping indexes",async t=>{
  const f=birthdayTransferFixture(),h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  assert.equal(f.master.start.date,"2023-07-17","the series master starts before the selected occurrence year");
  assert.equal(f.active.start.date,f.annual.due.date,"the next selected annual occurrence matches the Todoist due date");
  const input=transferIntent(f,{"home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged"});
  const preview=await h.engine.preview(actor,input);
  assert.deepEqual(preview.snapshots.map(s=>refKey(s.ref)),[
    "home:calendar:birthday-2027","home:calendar:birthday-master","home:calendar:birthday-standalone",
    "home:todoist:annual-task","home:todoist:old-oneoff",
  ]);
  assert.ok(preview.itemPlan.some(row=>row.ref.id==="old-oneoff"&&row.operation==="Retain provider item and detach its old mapping"));
  assert.ok(preview.itemPlan.some(row=>row.ref.id==="birthday-standalone"&&row.operation==="Leave unchanged"));
  const originalDue=clone(h.taskMap.get(f.annual.id).due),originalRule=clone(h.eventMap.get(f.master.id).recurrence);
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);
  assert.deepEqual(h.taskMap.get(f.annual.id).due,originalDue);
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,originalRule);
  assert.equal(h.mappingMap.has(f.displaced.id),false);
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.mappingMap.get(f.annual.id).masterEventId,f.master.id);
  assert.equal(h.eventMappingMap.get(`home:${f.active.id}`).taskId,f.annual.id);
  assert.equal(h.ownerMappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.recurrences.get(f.master.iCalUID).taskId,f.annual.id);
  assert.equal(h.recurrences.get(f.master.iCalUID).completedThroughOriginalStart,"2026-07-17");
  assert.equal(h.taskMap.get(f.displaced.id).content,f.displaced.content);
  assert.deepEqual(h.eventMap.get(f.standalone.id),f.standalone);
  assert.ok(result.outcomes.some(row=>row.entity==="home:todoist:old-oneoff"&&row.outcome==="retained-unlinked"));
  assert.equal(h.controlsMap.get("home:todoist:old-oneoff")?.excluded,true,"retained task must have a durable task-level reprojection fence");
  assert.ok(result.outcomes.some(row=>row.entity==="home:calendar:birthday-standalone"&&row.outcome==="unchanged"));
  assert.equal(h.writes.some(row=>row[0]==="task"||row[0]==="create-task"||row[0]==="create-event"),false);
  const writes=h.writes.length;
  assert.equal((await h.engine.execute("repair")).status,"succeeded");
  assert.equal(h.writes.length,writes,"repeated delivery does not create another counterpart or rewrite recurrence");
});

test("series transfer treats explicit INTERVAL=1 as equivalent to Todoist every year",async t=>{
  const f=birthdayTransferFixture();
  f.master={...f.master,recurrence:["RRULE:FREQ=YEARLY;INTERVAL=1"]};
  const h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const preview=await h.engine.preview(actor,transferIntent(f,{
    "home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged",
  }));
  assert.ok(preview.changes.some(change=>change.includes("transfer the Calendar-owned series association")));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  assert.equal((await h.engine.execute("repair")).status,"succeeded");
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,["RRULE:FREQ=YEARLY;INTERVAL=1"]);
});

test("series transfer accepts Todoist every November 1 against the matching annual Calendar occurrence",async t=>{
  const f=birthdayTransferFixture();
  f.annual={...f.annual,due:{date:"2027-11-01",is_recurring:true,string:"every November 1"}};
  f.displaced={...f.displaced,due:{date:"2027-11-01"}};
  f.master={...f.master,start:{date:"2023-11-01"},end:{date:"2023-11-02"},recurrence:["RRULE:FREQ=YEARLY;INTERVAL=1"]};
  f.active={...f.active,start:{date:"2027-11-01"},end:{date:"2027-11-02"},originalStartTime:{date:"2027-11-01"}};
  f.standalone={...f.standalone,start:{date:"2027-11-01"},end:{date:"2027-11-02"}};
  f.standalone={...f.standalone,start:{date:"2027-11-01"},end:{date:"2027-11-02"}};
  f.mapping={...f.mapping,originalStart:"2027-11-01",activeEffectiveStart:"2027-11-01",completedThroughOriginalStart:"2026-11-01"};
  f.recurrence={...f.mapping,owner:"calendar"};
  const h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const input=transferIntent(f,{"home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged"});
  const preview=await h.engine.preview(actor,input);
  assert.ok(preview.changes.some(change=>change.includes("transfer the Calendar-owned series association")));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.mappingMap.get(f.annual.id).masterEventId,f.master.id);
  assert.equal(h.eventMappingMap.get(`home:${f.active.id}`).taskId,f.annual.id);
  assert.equal(h.ownerMappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.recurrences.get(f.master.iCalUID).taskId,f.annual.id);
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,["RRULE:FREQ=YEARLY;INTERVAL=1"]);
  assert.deepEqual(h.eventMap.get(f.standalone.id),f.standalone);
});

function mappedTodoistOwnedSource(f) {
  const sourceMaster=event("old-todoist-master",{iCalUID:"old-todoist-ical",summary:f.annual.content,description:f.annual.description,
    start:{date:"2023-11-01"},end:{date:"2023-11-02"},recurrence:[todoistRecurrenceToRrule(f.annual)],
    extendedProperties:{shared:{taskId:f.annual.id,syncRecurrenceOwner:"todoist",todoistRecurrence:todoistRecurrenceKey(f.annual),
      todoistAnchorStart:"2023-11-01",todoistAnchorEnd:"2023-11-02"}}});
  const sourceOccurrence=event("old-todoist-occurrence",{summary:f.annual.content,description:f.annual.description,
    start:{date:f.annual.due.date},end:{date:"2027-11-02"},recurringEventId:sourceMaster.id,
    originalStartTime:{date:f.annual.due.date},extendedProperties:{shared:{taskId:f.annual.id,syncRecurrenceOwner:"todoist"}}});
  const sourceMapping={profile:"home",taskId:f.annual.id,eventId:sourceMaster.id,projectId:profiles.home.todoistProjectId,
    recurrenceOwner:"todoist",seriesId:f.annual.id,masterEventId:sourceMaster.id,activeInstanceId:sourceOccurrence.id,
    updatedAt:"2026-10-24T12:00:00.000Z"};
  const sourceLink={profile:"home",owner:"todoist",seriesId:f.annual.id,taskId:f.annual.id,eventId:sourceMaster.id,
    masterEventId:sourceMaster.id,activeInstanceId:sourceOccurrence.id,updatedAt:"2026-10-24T12:00:01.000Z"};
  return {sourceMaster,sourceOccurrence,sourceMapping,sourceLink};
}

test("transfer replaces a mapped Todoist-owned series with a verified Calendar-owned series without flattening",async t=>{
  const f=birthdayTransferFixture();
  f.annual={...f.annual,due:{date:"2027-11-01",is_recurring:true,string:"every November 1"}};
  f.displaced={...f.displaced,due:{date:"2027-11-01"}};
  f.master={...f.master,start:{date:"2023-11-01"},end:{date:"2023-11-02"},recurrence:["RRULE:FREQ=YEARLY;INTERVAL=1"]};
  f.active={...f.active,start:{date:"2027-11-01"},end:{date:"2027-11-02"},originalStartTime:{date:"2027-11-01"}};
  f.standalone={...f.standalone,start:{date:"2027-11-01"},end:{date:"2027-11-02"}};
  f.mapping={...f.mapping,originalStart:"2027-11-01",activeEffectiveStart:"2027-11-01",completedThroughOriginalStart:"2026-11-01"};
  f.recurrence={...f.mapping,owner:"calendar"};
  const old=mappedTodoistOwnedSource(f), input=transferIntent(f,{
    "home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged",
    "home:calendar:old-todoist-master":"exclude","home:calendar:old-todoist-occurrence":"exclude",
  });
  assert.equal(old.sourceMapping.eventId,old.sourceMaster.id,"the EVENT mapping points to the recurring master");
  assert.equal(old.sourceMapping.activeInstanceId,old.sourceOccurrence.id,"the active occurrence is stored separately");
  assert.equal(old.sourceLink.eventId,old.sourceMaster.id,"the recurrence link retains the master as its event ID");
  const h=harness(t,{events:[f.master,f.active,f.standalone,old.sourceMaster,old.sourceOccurrence],
    tasks:[f.annual,f.displaced],mappings:[f.mapping,old.sourceMapping],recurrence:[f.recurrence,old.sourceLink]});
  const preview=await h.engine.preview(actor,input);
  assert.ok(preview.itemPlan.some(row=>row.ref.id===old.sourceMaster.id&&row.operation==="Detach and exclude the old Todoist-owned series item"));
  assert.ok(preview.itemPlan.some(row=>row.ref.id===old.sourceOccurrence.id&&row.operation==="Detach and exclude the old Todoist-owned series item"));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  assert.deepEqual(h.taskMap.get(f.annual.id).due,f.annual.due,"the Todoist recurrence remains intact");
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,["RRULE:FREQ=YEARLY;INTERVAL=1"]);
  assert.deepEqual(h.eventMap.get(old.sourceMaster.id).recurrence,old.sourceMaster.recurrence,"the old series rule is not flattened");
  assert.deepEqual(h.eventMap.get(old.sourceOccurrence.id).start,old.sourceOccurrence.start);
  assert.equal(h.eventMap.get(old.sourceMaster.id).extendedProperties.shared.taskId,undefined);
  assert.equal(h.eventMap.get(old.sourceOccurrence.id).extendedProperties.shared.taskId,undefined);
  assert.equal(h.recurrences.has(old.sourceLink.seriesId),false,"the stale Todoist-owned recurrence link is removed");
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.eventMappingMap.has(`home:${old.sourceMaster.id}`),false);
  assert.equal(h.ownerMappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.recurrences.get(f.master.iCalUID).taskId,f.annual.id);
  assert.equal(h.controlsMap.get(`home:calendar:${old.sourceMaster.id}`)?.excluded,true);
  assert.equal(h.controlsMap.get(`home:calendar:${old.sourceOccurrence.id}`)?.excluded,true);
  assert.equal(h.writes.some(write=>write[0]==="create-event"||write[0]==="create-task"||write[0]==="flatten"),false);
});

test("mapped series transfer resumes cleanup after the old master is detached but its occurrence write fails",async t=>{
  const f=birthdayTransferFixture();
  f.annual={...f.annual,due:{date:"2027-11-01",is_recurring:true,string:"every November 1"}};
  f.displaced={...f.displaced,due:{date:"2027-11-01"}};
  f.master={...f.master,start:{date:"2023-11-01"},end:{date:"2023-11-02"},recurrence:["RRULE:FREQ=YEARLY;INTERVAL=1"]};
  f.active={...f.active,start:{date:"2027-11-01"},end:{date:"2027-11-02"},originalStartTime:{date:"2027-11-01"}};
  f.standalone={...f.standalone,start:{date:"2027-11-01"},end:{date:"2027-11-02"}};
  f.mapping={...f.mapping,originalStart:"2027-11-01",activeEffectiveStart:"2027-11-01",completedThroughOriginalStart:"2026-11-01"};
  f.recurrence={...f.mapping,owner:"calendar"};
  const old=mappedTodoistOwnedSource(f),input=transferIntent(f,{
    "home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged",
    "home:calendar:old-todoist-master":"exclude","home:calendar:old-todoist-occurrence":"exclude",
  });
  const h=harness(t,{events:[f.master,f.active,f.standalone,old.sourceMaster,old.sourceOccurrence],
    tasks:[f.annual,f.displaced],mappings:[f.mapping,old.sourceMapping],recurrence:[f.recurrence,old.sourceLink]});
  const preview=await h.engine.preview(actor,input);
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const transfer=StateRepository.prototype.transferCalendarSeriesMapping;
  let transferCalls=0,failOldOccurrence=true;
  StateRepository.prototype.transferCalendarSeriesMapping=async function(...args){transferCalls++;return transfer.call(this,...args);};
  t.after(()=>{StateRepository.prototype.transferCalendarSeriesMapping=transfer;});
  const write=h.clients.calendar.upsertEventIfUnchanged;
  h.clients.calendar.upsertEventIfUnchanged=async(value,eventId,...args)=>{
    if(eventId===old.sourceOccurrence.id&&failOldOccurrence){
      failOldOccurrence=false;
      throw new Error("Old Calendar occurrence write failed after master detach");
    }
    return write(value,eventId,...args);
  };

  const first=await h.engine.execute("repair");
  assert.equal(first.status,"needs_review");
  assert.equal(first.steps[`transfer-mapping:${f.master.iCalUID}`]?.status,"done","the atomic mapping commit checkpoint is durable");
  assert.equal(first.steps[`transfer-unlink-old-todoist-series:${old.sourceMaster.id}`]?.status,"running");
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.eventMappingMap.has(`home:${old.sourceMaster.id}`),false);
  assert.equal(h.recurrences.has(old.sourceLink.seriesId),false);
  assert.equal(h.eventMap.get(old.sourceMaster.id).extendedProperties.shared.taskId,undefined);
  assert.equal(h.eventMap.get(old.sourceOccurrence.id).extendedProperties.shared.taskId,f.annual.id);
  assert.equal(h.controlsMap.get(`home:calendar:${old.sourceMaster.id}`)?.excluded,undefined);
  assert.ok(h.controlsMap.get("home:todoist:annual-task").activeRepair,"the failed cross-provider operation remains resumable");
  const retry=await h.engine.execute("repair");
  assert.equal(retry.status,"succeeded",retry.error);
  assert.equal(transferCalls,1,"resume trusts the saved mapping-step receipt and does not reinstall the transfer");
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.eventMappingMap.get(`home:${f.active.id}`).taskId,f.annual.id);
  assert.equal(h.eventMappingMap.has(`home:${old.sourceMaster.id}`),false);
  assert.equal(h.ownerMappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal([...h.eventMappingMap.values()].filter(mapping=>mapping.taskId===f.annual.id).length,1,"no duplicate target mapping is created");
  assert.equal(h.recurrences.has(old.sourceLink.seriesId),false,"the retired Todoist recurrence link stays deleted");
  assert.equal(h.eventMap.get(old.sourceMaster.id).extendedProperties.shared.taskId,undefined);
  assert.equal(h.eventMap.get(old.sourceOccurrence.id).extendedProperties.shared.taskId,undefined);
  assert.deepEqual(h.eventMap.get(old.sourceMaster.id).recurrence,old.sourceMaster.recurrence,"the old RRULE is preserved");
  assert.ok(h.controlsMap.get(`home:calendar:${old.sourceMaster.id}`).excluded);
  assert.ok(h.controlsMap.get(`home:calendar:${old.sourceOccurrence.id}`).excluded);
  assert.ok([...h.controlsMap.values()].every(control=>!control.activeRepair));
});

test("mapped recurring transfer requires complete, matching source mapping indexes and explicit old-series exclusions",async t=>{
  const f=birthdayTransferFixture();
  f.annual={...f.annual,due:{date:"2027-11-01",is_recurring:true,string:"every November 1"}};
  f.master={...f.master,start:{date:"2023-11-01"},end:{date:"2023-11-02"},recurrence:["RRULE:FREQ=YEARLY;INTERVAL=1"]};
  f.active={...f.active,start:{date:"2027-11-01"},end:{date:"2027-11-02"},originalStartTime:{date:"2027-11-01"}};
  f.mapping={...f.mapping,originalStart:"2027-11-01",activeEffectiveStart:"2027-11-01"};
  f.recurrence={...f.mapping,owner:"calendar"};
  const old=mappedTodoistOwnedSource(f),base=transferIntent(f);
  const makeHarness=(sourceMapping=old.sourceMapping,sourceLink=old.sourceLink)=>harness(t,{events:[f.master,f.active,old.sourceMaster,old.sourceOccurrence],
    tasks:[f.annual,f.displaced],mappings:[f.mapping,sourceMapping],recurrence:[f.recurrence,sourceLink]});
  await assert.rejects(makeHarness({...old.sourceMapping,eventId:"wrong-event"}).engine.preview(actor,base),/non-equivalent or incomplete existing association/);
  await assert.rejects(makeHarness(old.sourceMapping,{...old.sourceLink,eventId:"stale-occurrence"}).engine.preview(actor,base),/incomplete, stale, or inconsistent/);
  const partial=makeHarness();
  partial.eventMappingMap.set(`home:${old.sourceOccurrence.id}`,{...old.sourceMapping,updatedAt:"split-event-index-version"});
  await assert.rejects(partial.engine.preview(actor,base),/incomplete, stale, or inconsistent/);
  const h=makeHarness();
  await assert.rejects(h.engine.preview(actor,base),/Choose Exclude from syncing for the exact old Todoist-owned series item/);
  assert.deepEqual(h.writes,[]);
});

test("task-only review detail hydrates its existing recurrence owner and active Calendar occurrence", async t => {
  const f = birthdayTransferFixture();
  const link = { ...f.recurrence, taskId: f.annual.id };
  const cancelled = { ...f.standalone, status: "cancelled" };
  const h = harness(t, { events: [f.master, f.active, cancelled], tasks: [f.annual], recurrence: link });
  const decision = {
    decisionId: "cancelled-projection", profile: "home", status: "pending", type: "todoist_cancelled_projection_blocked",
    taskId: f.annual.id, eventId: cancelled.id,
    permittedActions: [{ id: "acknowledge", label: "Keep Calendar deleted" }],
  };

  const snapshots = await h.engine.collect({
    caseId: decision.decisionId, profile: "home", action: "decision", taskId: decision.taskId, eventId: decision.eventId,
    winner: "none", scope: "occurrence", leftovers: {}, decisionAction: "acknowledge",
  }, decision);
  const taskSnapshot = snapshots.find(snapshot => snapshot.ref.side === "todoist" && snapshot.ref.id === f.annual.id);

  assert.equal(taskSnapshot.mapping, undefined, "no direct MAP row exists");
  assert.equal(taskSnapshot.recurrence.taskId, f.annual.id);
  assert.equal(taskSnapshot.recurrence.owner, "calendar");
  assert.ok(snapshots.some(snapshot => snapshot.ref.side === "calendar" && snapshot.ref.id === f.master.id));
  const activeSnapshot = snapshots.find(snapshot => snapshot.ref.side === "calendar" && snapshot.ref.id === f.active.id);
  assert.ok(activeSnapshot);
  assert.equal(activeSnapshot.recurrence.taskId, f.annual.id);
  assert.deepEqual(h.writes, [], "hydration performs reads only");
});

test("series transfer repairs missing mapping indexes when Calendar ownership already names the selected task", async t => {
  const f = birthdayTransferFixture();
  f.master = { ...f.master, recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1"],
    extendedProperties:{shared:{taskId:f.annual.id,syncRecurrenceOwner:"calendar"}} };
  f.active = { ...f.active, extendedProperties:{shared:{taskId:f.annual.id,syncRecurrenceOwner:"calendar"}} };
  const link = { ...f.recurrence, taskId: f.annual.id, activeInstanceId: f.active.id, eventId: f.active.id };
  const h = harness(t, { events: [f.master, f.active], tasks: [f.annual], recurrence: link });

  const preview = await h.engine.preview(actor, transferIntent(f));
  assert.ok(preview.changes.some(change => change.includes("reconstruct missing mapping indexes")));
  assert.ok(preview.itemPlan.some(row => row.ref.id === f.annual.id
    && row.operation === "Rebuild missing indexes for the existing Calendar series association"));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const result = await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.mappingMap.get(f.annual.id).masterEventId,f.master.id);
  assert.equal(h.eventMappingMap.get(`home:${f.active.id}`).taskId,f.annual.id);
  assert.equal(h.ownerMappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.recurrences.get(f.master.iCalUID).taskId,f.annual.id);
  assert.deepEqual(h.taskMap.get(f.annual.id).due,f.annual.due);
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,f.master.recurrence);
  assert.equal(h.writes.some(row=>row[0]==="create-task"||row[0]==="create-event"),false);
});

test("series transfer fails closed when an already-owned recurrence has partial mapping indexes", async t => {
  const f = birthdayTransferFixture();
  f.master = { ...f.master, recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1"],
    extendedProperties:{shared:{taskId:f.annual.id,syncRecurrenceOwner:"calendar"}} };
  f.active = { ...f.active, extendedProperties:{shared:{taskId:f.annual.id,syncRecurrenceOwner:"calendar"}} };
  const link = { ...f.recurrence, taskId: f.annual.id, activeInstanceId: f.active.id, eventId: f.active.id };
  const h = harness(t, { events: [f.master, f.active], tasks: [f.annual], recurrence: link });
  h.eventMappingMap.set(`home:${f.active.id}`, {
    profile:"home",taskId:f.annual.id,eventId:f.active.id,recurrenceOwner:"calendar",seriesId:f.master.iCalUID,
    masterEventId:f.master.id,activeInstanceId:f.active.id,updatedAt:"partial-index-version",
  });

  await assert.rejects(h.engine.preview(actor, transferIntent(f)),/mapping indexes are partially present/);
  assert.deepEqual(h.writes,[]);
});

test("series transfer refuses an unowned Calendar recurrence without a recurrence link or ownership metadata",async t=>{
  const f=birthdayTransferFixture();
  f.master={...f.master,extendedProperties:{shared:{taskId:f.displaced.id}}};
  f.active={...f.active,extendedProperties:{shared:{taskId:f.displaced.id}}};
  const h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping]});
  await assert.rejects(h.engine.preview(actor,transferIntent(f,{
    "home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged",
  })),/verified Calendar ownership signal/);
  assert.deepEqual(h.writes,[]);
});

test("series transfer rejects an unchanged disposition for its displaced mapping during preview",async t=>{
  const f=birthdayTransferFixture(),h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  await assert.rejects(h.engine.preview(actor,transferIntent(f,{
    "home:todoist:old-oneoff":"unchanged","home:calendar:birthday-standalone":"unchanged",
  })),/explicit disposition for the exact displaced Todoist task/);
  assert.deepEqual(h.writes,[]);
});

test("link preview rejects leaving a displaced one-off association unchanged",async t=>{
  const current=task("yearly-task"), oldEvent=event("old-2025-event",{start:{date:"2025-05-02"},end:{date:"2025-05-03"}});
  const selectedEvent=event("selected-2027-event"), oldMapping={profile:"home",taskId:current.id,eventId:oldEvent.id,updatedAt:"old-version"};
  const selectedMapping={profile:"home",taskId:current.id,eventId:selectedEvent.id,updatedAt:"selected-version"};
  const h=harness(t,{events:[oldEvent,selectedEvent],tasks:[current]});
  const snapshots=[
    {ref:{profile:"home",side:"todoist",id:current.id},object:current,mapping:oldMapping},
    {ref:{profile:"home",side:"calendar",id:oldEvent.id},object:oldEvent,mapping:oldMapping},
    {ref:{profile:"home",side:"calendar",id:selectedEvent.id},object:selectedEvent,mapping:selectedMapping},
  ];
  h.engine.collect=async()=>snapshots.map(clone);
  const unchanged={
    caseId:"case",profile:"home",action:"link",taskId:current.id,eventId:selectedEvent.id,
    winner:"none",scope:"occurrence",leftovers:{[refKey(snapshots[1].ref)]:"unchanged"},
  };
  await assert.rejects(h.engine.preview(actor,unchanged),/Cannot leave the currently mapped Calendar event old-2025-event.*choose Exclude to retain the old event while detaching its obsolete mapping/);
  assert.deepEqual(h.writes,[]);

  const safe=await h.engine.preview(actor,{...unchanged,leftovers:{[refKey(snapshots[1].ref)]:"exclude"}});
  const oldPlan=safe.itemPlan.find(item=>refKey(item.ref)===refKey(snapshots[1].ref));
  assert.equal(oldPlan.operation,"Exclude from syncing");
  assert.equal(oldPlan.result,"Remove any displaced mapping and mark this provider object excluded");
  assert.ok(safe.changes.includes(`Exclude calendar item ${oldEvent.id} from future syncing`));
});

test("link preview fails closed when TASK and EVENT mapping indexes disagree",async t=>{
  const current=task("yearly-task"), oldEvent=event("old-2025-event"), selectedEvent=event("selected-2027-event");
  const taskMapping={profile:"home",taskId:current.id,eventId:oldEvent.id,updatedAt:"task-index-version"};
  const selectedMapping={profile:"home",taskId:current.id,eventId:selectedEvent.id,updatedAt:"selected-version"};
  for (const eventMapping of [undefined,{...taskMapping,eventId:"different-event"},{...taskMapping,updatedAt:"event-index-version"}]) {
    const h=harness(t,{events:[oldEvent,selectedEvent],tasks:[current]});
    const snapshots=[
      {ref:{profile:"home",side:"todoist",id:current.id},object:current,mapping:taskMapping},
      {ref:{profile:"home",side:"calendar",id:oldEvent.id},object:oldEvent,...(eventMapping?{mapping:eventMapping}:{})},
      {ref:{profile:"home",side:"calendar",id:selectedEvent.id},object:selectedEvent,mapping:selectedMapping},
    ];
    h.engine.collect=async()=>snapshots.map(clone);
    const input={caseId:"case",profile:"home",action:"link",taskId:current.id,eventId:selectedEvent.id,
      winner:"none",scope:"occurrence",leftovers:{[refKey(snapshots[1].ref)]:"unchanged"}};
    await assert.rejects(h.engine.preview(actor,input),/mapping index is missing or disagrees.*choose Exclude/);
    assert.deepEqual(h.writes,[]);

    const excluded=await h.engine.preview(actor,{...input,leftovers:{[refKey(snapshots[1].ref)]:"exclude"}});
    assert.equal(excluded.itemPlan.find(row=>refKey(row.ref)===refKey(snapshots[1].ref)).operation,"Exclude from syncing");
  }
});

test("series transfer discovers same-date standalone duplicates from other years",async t=>{
  const f=birthdayTransferFixture(),prior=event("birthday-standalone-2026",{summary:f.annual.content,
    start:{date:"2026-07-17"},end:{date:"2026-07-18"}});
  const h=harness(t,{events:[f.master,f.active,prior],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const snapshots=await h.engine.collect(transferIntent(f,{}),undefined);
  assert.ok(snapshots.some(snapshot=>snapshot.ref.side==="calendar"&&snapshot.ref.id===prior.id));
});

test("series transfer rejects stale or competing recurrence ownership before provider writes",async t=>{
  const f=birthdayTransferFixture(),h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const preview=await h.engine.preview(actor,transferIntent(f,{"home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged"}));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  h.recurrences.set(f.master.iCalUID,{...f.recurrence,owner:"todoist",taskId:"competitor",updatedAt:"2026-10-23T12:00:00.000Z"});
  const result=await h.engine.execute("repair");
  assert.notEqual(result.status,"succeeded");
  assert.match(result.error,/changed after preview/);
  assert.deepEqual(h.writes,[]);
  assert.equal(h.mappingMap.get(f.displaced.id).eventId,f.active.id);
  assert.equal(h.mappingMap.has(f.annual.id),false);
});

test("series transfer resumes a committed mapping after a lost transaction acknowledgement",async t=>{
  const f=birthdayTransferFixture(),h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const input=transferIntent(f,{"home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged"});
  const preview=await h.engine.preview(actor,input);
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const commit=StateRepository.prototype.transferCalendarSeriesMapping;
  let loseAck=true;
  StateRepository.prototype.transferCalendarSeriesMapping=async function(args){
    const result=await commit.call(this,args);
    if(loseAck){loseAck=false;throw new Error("transaction acknowledgement lost");}
    return result;
  };
  t.after(()=>{StateRepository.prototype.transferCalendarSeriesMapping=commit;});
  const first=await h.engine.execute("repair");
  assert.equal(first.status,"needs_review");
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  const retry=await h.engine.execute("repair");
  assert.equal(retry.status,"succeeded",retry.error);
  assert.equal(h.mappingMap.has(f.displaced.id),false);
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.taskMap.get(f.annual.id).due.is_recurring,true);
});

test("series transfer resumes safely after one Calendar metadata write fails",async t=>{
  const f=birthdayTransferFixture(),h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const input=transferIntent(f,{"home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged"});
  const preview=await h.engine.preview(actor,input);
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const write=h.clients.calendar.upsertEventIfUnchanged;let failActive=true;
  h.clients.calendar.upsertEventIfUnchanged=async(value,eventId,...args)=>{
    if(eventId===f.active.id&&failActive){failActive=false;throw new Error("Calendar occurrence write failed");}
    return write(value,eventId,...args);
  };
  const first=await h.engine.execute("repair");
  assert.equal(first.status,"needs_review");
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.ok(h.controlsMap.get("home:todoist:annual-task").activeRepair);
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,f.master.recurrence);
  assert.equal(h.taskMap.get(f.annual.id).due.is_recurring,true);
  const retry=await h.engine.execute("repair");
  assert.equal(retry.status,"succeeded",retry.error);
  assert.equal(h.eventMap.get(f.active.id).extendedProperties.shared.taskId,f.annual.id);
  assert.equal(h.taskMap.get(f.annual.id).due.string,"every year");
});

test("series transfer keeps its barrier when the conditional mapping transaction loses ownership",async t=>{
  const f=birthdayTransferFixture(),h=harness(t,{events:[f.master,f.active,f.standalone],tasks:[f.annual,f.displaced],mappings:[f.mapping],recurrence:f.recurrence});
  const input=transferIntent(f,{"home:todoist:old-oneoff":"retain-unlinked","home:calendar:birthday-standalone":"unchanged"});
  const preview=await h.engine.preview(actor,input);
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const commit=StateRepository.prototype.transferCalendarSeriesMapping;
  StateRepository.prototype.transferCalendarSeriesMapping=async()=>false;
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"failed");
  assert.match(result.error,/mapping or Todoist ownership changed/);
  assert.equal(h.mappingMap.has(f.annual.id),false);
  assert.equal(h.mappingMap.get(f.displaced.id).eventId,f.active.id);
  assert.ok(!h.controlsMap.get("home:todoist:annual-task").activeRepair);
  assert.deepEqual(h.writes,[]);
  assert.deepEqual(h.eventMap.get(f.master.id).recurrence,f.master.recurrence);
  assert.equal(h.taskMap.get(f.annual.id).due.is_recurring,true);
  StateRepository.prototype.transferCalendarSeriesMapping=commit;
  const fresh=await h.execute(input);
  assert.equal(fresh.status,"succeeded",fresh.error);
  assert.equal(h.mappingMap.get(f.annual.id).eventId,f.active.id);
  assert.equal(h.mappingMap.has(f.displaced.id),false);
  t.after(()=>{StateRepository.prototype.transferCalendarSeriesMapping=commit;});
});

function todoistSeriesFixture({moved=false}={}) {
  const add=(date,days)=>new Date(Date.parse(`${date}T12:00:00Z`)+days*86400000).toISOString().slice(0,10);
  const fixture=seriesFixture(),due="2026-09-14",effective=moved?add(due,2):due;
  const liveTask=task("task",{due:{date:due,is_recurring:true,string:"every week"}});
  const shared={taskId:"task",syncRecurrenceOwner:"todoist",todoistRecurrence:todoistRecurrenceKey(liveTask),todoistAnchorStart:due,todoistAnchorEnd:add(due,3),todoistAnchorAllDay:"true"};
  fixture.events[0]={...fixture.events[0],start:{date:due},end:{date:add(due,3)},recurrence:[todoistRecurrenceToRrule(liveTask)],extendedProperties:{shared}};
  fixture.events[1]={...fixture.events[1],start:{date:effective},end:{date:add(effective,3)},originalStartTime:{date:due},extendedProperties:{shared:{...shared,unrelated:"retained"},private:{note:"retained"}}};
  fixture.events.push(event("future",{recurringEventId:"master",start:{date:"2026-12-01"},end:{date:"2026-12-04"},originalStartTime:{date:"2026-12-01"}}));
  fixture.mappings[0]={...fixture.mappings[0],recurrenceOwner:"todoist",eventId:"master",seriesId:"task",originalStart:due,activeEffectiveStart:effective};
  fixture.recurrence={...fixture.mappings[0],owner:"todoist"};
  return {...fixture,tasks:[liveTask]};
}

test("Verify preview is a no-op for an already reciprocal association", async t => {
  const mapping = { profile: "home", taskId: "task", eventId: "event" };
  const mappingWrites = [];
  t.mock.method(StateRepository.prototype, "putMapping", async value => mappingWrites.push(clone(value)));
  const h = harness(t, {
    events: [event("event", { extendedProperties: { shared: { taskId: "task" } } })],
    mappings: [mapping],
  });

  const preview = await h.engine.preview(actor, intent({ action: "verify" }));

  assert.ok(preview.changes.some(change => change.startsWith("Verify the existing association")));
  assert.ok(preview.changes.every(change => !change.startsWith("Replace existing association")));
  assert.equal(preview.itemPlan.length, 2);
  assert.ok(preview.itemPlan.every(item => item.operation === "Verify existing association"));
  assert.ok(preview.itemPlan.every(item => item.result === "Retain verified mapping; no provider fields changed"));

  h.operations.set("repair", { id: "repair", status: "queued", steps: {}, preview });
  const result = await h.engine.execute("repair");
  assert.equal(result.status, "succeeded", result.error);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(mappingWrites, []);
  assert.deepEqual(h.mappingMap.get("task"), mapping);
});

test("Verify rejects an inconsistent mapping instead of planning a repair", async t => {
  const h = harness(t, {
    events: [event("event", { extendedProperties: { shared: { taskId: "task" } } })],
    mappings: [{ profile: "home", taskId: "task", eventId: "another-event" }],
  });

  await assert.rejects(
    h.engine.preview(actor, intent({ action: "verify" })),
    /Selected pair does not match the current mapping/,
  );
  assert.deepEqual(h.writes, []);
});

test("Todoist-owned snapshots and Verify retain the overdue mapped occurrence instead of a future iteration",async t=>{
  const h=harness(t,todoistSeriesFixture());
  const preview=await h.engine.preview(actor,intent({action:"verify",eventId:"master",owner:"todoist",scope:"series"}));
  const master=preview.snapshots.find(s=>s.ref.id==="master");
  assert.equal(master.recurrence.seriesId,"task");assert.equal(master.calendarProjectionId,"active");
  assert.ok(!preview.snapshots.some(s=>s.ref.id==="future"));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);assert.ok([...h.controlsMap.values()].every(c=>!c.activeRepair));
});

test("Todoist-wins repairs an owned occurrence without sending an RRULE or altering its parent rule",async t=>{
  const fixture=todoistSeriesFixture({moved:true}),h=harness(t,fixture);
  const upsert=h.clients.calendar.upsertEventIfUnchanged;
  h.clients.calendar.upsertEventIfUnchanged=async(value,id,etag)=>{
    if(id==="active"){
      assert.equal(value.recurrence,undefined);
      assert.equal(value.extendedProperties.private.note,"retained");
      assert.equal(value.extendedProperties.shared.unrelated,"retained");
    }
    return upsert(value,id,etag);
  };
  const result=await h.execute(intent({eventId:"active",owner:"todoist",winner:"todoist"}));
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.eventMap.get("active").start.date,"2026-09-14");
  assert.deepEqual(h.eventMap.get("master").recurrence,fixture.events[0].recurrence);
  assert.equal(h.eventMap.get("master").extendedProperties.shared.todoistAnchorStart,"2026-09-14");
});

test("excluding a mapped Calendar occurrence accepts only its own recorded recurrence detachment",async t=>{
  const h=harness(t,seriesFixture());
  h.eventMap.set("earlier",event("earlier",{recurringEventId:"master",start:{date:"2099-12-10"},originalStartTime:{date:"2099-12-10"}}));
  const result=await h.execute(intent({action:"exclude",taskId:undefined,eventId:"active",leftovers:{"home:todoist:task":"exclude"}}));
  assert.equal(result.status,"succeeded",result.error);assert.equal(h.recurrences.size,0);
  assert.ok(h.controlsMap.get("home:calendar:active").excluded);assert.ok(h.controlsMap.get("home:todoist:task").excluded);
  assert.ok([...h.controlsMap.values()].every(c=>!c.activeRepair));
});

for(const boundary of ["outcomes","release"]) test(`occurrence exclusion rejects an unexpected recurrence owner at ${boundary}`,async t=>{
  const h=harness(t,seriesFixture()),save=h.engine.store.saveOperation;
  h.engine.store.saveOperation=async operation=>{
    await save(operation);
    if(operation.steps["detach:home:task"]?.status==="done"&&(boundary==="outcomes"||operation.outcomes))h.recurrences.set("calendar-series",{...seriesFixture().recurrence,taskId:"unexpected-owner"});
  };
  const result=await h.execute(intent({action:"exclude",taskId:undefined,eventId:"active",leftovers:{"home:todoist:task":"exclude"}}));
  assert.equal(result.status,"needs_review");assert.match(result.error,/Context master|Retained history/);
  assert.ok(h.controlsMap.get("home:calendar:master").activeRepair);
});

test("selecting a Calendar master previews its existing task and active instance before replacement", async (t) => {
  const h = harness(t, seriesFixture());
  const input = intent({ action: "create", taskId: undefined, eventId: "master", owner: "calendar", scope: "series" });
  const snapshots = await h.engine.collect(input);
  assert.deepEqual(snapshots.map(value => refKey(value.ref)), ["home:calendar:active", "home:calendar:master", "home:todoist:task"]);
  await assert.rejects(h.engine.preview(actor, input), /Choose Create counterpart, Exclude, Leave unchanged, or Retain unlinked for home:todoist:task/);
  assert.deepEqual(h.writes, []);
  const result = await h.execute({ ...input, leftovers: { "home:todoist:task": "exclude" } });
  assert.equal(result.status, "succeeded", result.error);
  assert.deepEqual(result.verified, [{ profile: "home", taskId: "created-task", eventId: "active" }]);
  assert.equal(h.mappingMap.get("created-task").completedThroughOriginalStart, "2099-12-11");
  assert.equal(h.recurrences.get("calendar-series").taskId, "created-task");
  assert.ok(h.controlsMap.get("home:todoist:task").excluded);
  assert.ok(!h.controlsMap.get("home:calendar:active").activeRepair);
  assert.deepEqual(h.eventMap.get("master"), seriesFixture().events[0]);
  assert.equal(h.baselines[0][3].id, "active");
});

test("Leave unchanged retains an affected provider object and verifies its exact state before release", async t => {
  const secondary=event("secondary",{extendedProperties:{shared:{taskId:"event"}}});
  const h=harness(t,{events:[event("event",{extendedProperties:{shared:{taskId:"task"}}}),secondary]});
  const input=intent({leftovers:{"home:calendar:secondary":"unchanged"}});
  h.engine.collect=async()=>[
    {ref:{profile:"home",side:"todoist",id:"task"},object:clone(h.taskMap.get("task"))},
    {ref:{profile:"home",side:"calendar",id:"event"},object:clone(h.eventMap.get("event"))},
    {ref:{profile:"home",side:"calendar",id:"secondary"},object:clone(h.eventMap.get("secondary"))},
  ];
  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",result.error);
  assert.ok(result.outcomes.some(value=>value.entity==="home:calendar:secondary"&&value.outcome==="unchanged"));
  assert.deepEqual(h.eventMap.get("secondary"),secondary);
  assert.equal(h.controlsMap.get("home:calendar:secondary").excluded,undefined);
  assert.ok(!h.writes.some(write=>write[1]==="secondary"));
});

test("production Gabriel and Lennox series repair leaves the one-off event unchanged across worker replay", async t => {
  const taskId="6grcrccwr2xcWFgC", masterId="5esubqbi6ahen8uaaplgk5us19", oneOffId="5hn12gif091r5dqusim31a5v1q";
  const recurringTask=task(taskId,{content:"Write letter for Gabriel and Lennox",
    due:{date:"2027-03-01",is_recurring:true,string:"every year"}});
  const recurrenceMapping={profile:"home",taskId,eventId:masterId,recurrenceOwner:"todoist",seriesId:taskId,
    masterEventId:masterId,activeInstanceId:`${masterId}_20270301`,originalStart:"2027-03-01",activeEffectiveStart:"2027-03-01"};
  const master=event(masterId,{iCalUID:"gabriel-lennox-yearly",summary:recurringTask.content,
    start:{date:"2027-03-01"},end:{date:"2027-03-08"},recurrence:["RRULE:FREQ=YEARLY"],
    extendedProperties:{shared:{taskId,syncRecurrenceOwner:"todoist",todoistRecurrence:todoistRecurrenceKey(recurringTask)}}});
  const active=event(`${masterId}_20270301`,{summary:recurringTask.content,start:{date:"2027-03-01"},end:{date:"2027-03-08"},
    recurringEventId:masterId,originalStartTime:{date:"2027-03-01"},extendedProperties:{shared:master.extendedProperties.shared}});
  const oneOff=event(oneOffId,{summary:recurringTask.content,start:{date:"2026-03-01"},end:{date:"2026-03-08"}});
  const targetTask=task("repair-task",{content:"Repair another item",due:{date:"2026-11-01"}});
  const targetEvent=event("repair-event",{summary:"Repair another item",start:{date:"2026-11-01"},end:{date:"2026-11-02"}});
  const h=harness(t,{events:[master,active,oneOff,targetEvent],tasks:[recurringTask,targetTask],
    mappings:[recurrenceMapping],recurrence:{...recurrenceMapping,owner:"todoist"}});
  h.controlsMap.set(`home:calendar:${oneOffId}`,{excluded:false,fencedAt:"preserve-this-fence",providerUpdatedAt:"preserve-this-version"});
  const refs=[{profile:"home",side:"todoist",id:targetTask.id},{profile:"home",side:"calendar",id:targetEvent.id},
    {profile:"home",side:"todoist",id:taskId},{profile:"home",side:"calendar",id:masterId},
    {profile:"home",side:"calendar",id:active.id},{profile:"home",side:"calendar",id:oneOffId}];
  h.engine.collect=async()=>Promise.all(refs.map(ref=>h.engine.snapshot(ref)));
  const unchanged={
    [`home:todoist:${taskId}`]:"unchanged",[`home:calendar:${masterId}`]:"unchanged",
    [`home:calendar:${active.id}`]:"unchanged",[`home:calendar:${oneOffId}`]:"unchanged",
  };
  const input=intent({taskId:targetTask.id,eventId:targetEvent.id,winner:"none",scope:"occurrence",leftovers:unchanged});
  const preview=await h.engine.preview(actor,input);
  for(const id of [taskId,masterId,active.id,oneOffId]) {
    const key=`home:${id===taskId?"todoist":"calendar"}:${id}`;
    const unchangedPlan=preview.itemPlan.find(item=>refKey(item.ref)===key);
    assert.equal(unchangedPlan.operation,"Leave unchanged",key);
    assert.equal(unchangedPlan.result,"Retain provider object, mapping, and sync control without changes",key);
  }
  assert.deepEqual(preview.changes.filter(change=>change.startsWith("Replace existing association")), [],
    "the overall preview must not claim that an unchanged mapping will be replaced");
  const unchangedSnapshot=preview.snapshots.find(item=>refKey(item.ref)===`home:calendar:${oneOffId}`);
  assert.equal(unchangedSnapshot.object.id,oneOffId);
  assert.equal(unchangedSnapshot.object.status,"confirmed");
  assert.deepEqual(unchangedSnapshot.object.start,{date:"2026-03-01"});
  assert.deepEqual(unchangedSnapshot.object.end,{date:"2026-03-08"});

  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);
  assert.deepEqual(h.mappingMap.get(taskId),recurrenceMapping);
  assert.deepEqual(h.recurrences.get(taskId),{...recurrenceMapping,owner:"todoist"});
  assert.equal(h.taskMap.get(taskId).due.is_recurring,true);
  assert.deepEqual(h.eventMap.get(masterId).recurrence,["RRULE:FREQ=YEARLY"]);
  assert.deepEqual(h.eventMap.get(oneOffId),oneOff);
  assert.equal(h.controlsMap.get(`home:calendar:${oneOffId}`)?.excluded,false);
  assert.equal(h.controlsMap.get(`home:calendar:${oneOffId}`)?.fencedAt,"preserve-this-fence");
  assert.equal(h.controlsMap.get(`home:calendar:${oneOffId}`)?.providerUpdatedAt,"preserve-this-version");
  assert.ok(result.outcomes.some(value=>value.entity===`home:calendar:${masterId}`&&value.outcome==="unchanged"));
  assert.ok(result.outcomes.some(value=>value.entity===`home:calendar:${oneOffId}`&&value.outcome==="unchanged"));
  assert.ok(!h.calls.some(call=>call[0]==="tombstone"));
  assert.ok(!h.writes.some(write=>write.some(value=>[taskId,masterId,active.id,oneOffId].includes(value))));
  assert.ok(!h.writes.some(write=>write.includes(oneOffId)));

  const writeCount=h.writes.length;
  const replay=await h.engine.execute("repair");
  assert.equal(replay.status,"succeeded");
  assert.equal(h.writes.length,writeCount,"redelivery of the completed worker operation must not repeat writes");
  assert.equal(h.taskMap.get(taskId).due.is_recurring,true);
  assert.deepEqual(h.eventMap.get(masterId).recurrence,["RRULE:FREQ=YEARLY"]);
  assert.deepEqual(h.mappingMap.get(taskId),recurrenceMapping);
  assert.deepEqual(h.eventMap.get(oneOffId),oneOff);
});

test("Leave unchanged retains the repair barrier if its sync control changes before release", async t => {
  const h=harness(t,{events:[event("event",{extendedProperties:{shared:{taskId:"task"}}}),
    event("secondary",{extendedProperties:{shared:{taskId:"event"}}})]});
  h.engine.collect=async()=>[
    {ref:{profile:"home",side:"todoist",id:"task"},object:clone(h.taskMap.get("task"))},
    {ref:{profile:"home",side:"calendar",id:"event"},object:clone(h.eventMap.get("event"))},
    {ref:{profile:"home",side:"calendar",id:"secondary"},object:clone(h.eventMap.get("secondary"))},
  ];
  const snapshot=h.engine.snapshot.bind(h.engine);
  let secondaryReads=0;
  h.engine.snapshot=async ref=>{
    if(ref.side==="calendar"&&ref.id==="secondary"&&++secondaryReads===2){
      h.controlsMap.set("home:calendar:secondary",{...h.controlsMap.get("home:calendar:secondary"),excluded:true});
    }
    return snapshot(ref);
  };
  const result=await h.execute(intent({leftovers:{"home:calendar:secondary":"unchanged"}}));
  assert.equal(result.status,"needs_review");
  assert.match(result.error,/Leave unchanged state for home:calendar:secondary changed before release/);
  assert.ok(h.controlsMap.get("home:calendar:secondary").activeRepair,"barrier must remain held after exact-state verification fails");
});

test("rebinding a Calendar master clears rejection of the persisted task/instance pair", async (t) => {
  const h = harness(t, seriesFixture());
  const result = await h.execute(intent({ eventId: "master", owner: "calendar", winner: "calendar", scope: "series" }));
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(h.controls.rejected.has("home:task:active"), false);
  assert.deepEqual(result.verified, [{ profile: "home", taskId: "task", eventId: "active" }]);
});

test("preview blocks linking a yearly Todoist task to a Calendar-owned yearly occurrence", async (t) => {
  const fixture = seriesFixture();
  fixture.events[0] = { ...fixture.events[0], recurrence: ["RRULE:FREQ=YEARLY"], start: { date: "2027-05-02" } };
  fixture.events[1] = { ...fixture.events[1], start: { date: "2027-05-02" },
    originalStartTime: { date: "2027-05-02" } };
  const yearlyTask = task("task", { due: { date: "2027-05-02", string: "every year", is_recurring: true } });
  const h = harness(t, { events: fixture.events, tasks: [yearlyTask] });
  const input = intent({ eventId: "active", owner: "calendar", winner: "todoist", scope: "occurrence" });
  await assert.rejects(h.engine.preview(actor, input), /replace its recurrence with a one-off due date/);
  assert.deepEqual(h.writes, []);
});

test("counterpart creation from the active occurrence preserves Calendar ownership and its master", async (t) => {
  const fixture = seriesFixture();
  const h = harness(t, { events: fixture.events, tasks: [] });
  const result = await h.execute(intent({ action: "create", taskId: undefined, eventId: "active", owner: "calendar" }));
  assert.equal(result.status, "succeeded", result.error);
  const mapping = h.mappingMap.get("created-task");
  assert.equal(mapping.recurrenceOwner, "calendar");
  assert.equal(mapping.seriesId, "calendar-series");
  assert.equal(mapping.activeInstanceId, "active");
  assert.deepEqual(h.eventMap.get("master"), fixture.events[0]);
  assert.ok(result.outcomes.some(value => value.entity === "home:calendar:master" && value.outcome === "history"));
});

test("occurrence previews reject another active binding or an ownership change before task creation", async (t) => {
  const h = harness(t, { events: seriesFixture().events, tasks: [] });
  h.eventMap.set("later", event("later", { recurringEventId: "master", start: { date: "2099-12-25" }, originalStartTime: { date: "2099-12-25" } }));
  await assert.rejects(h.engine.preview(actor, intent({ action: "create", taskId: undefined, eventId: "later", owner: "calendar" })), /Choose the active Calendar occurrence/);
  h.eventMap.get("master").extendedProperties = { shared: { syncRecurrenceOwner: "todoist" } };
  await assert.rejects(h.engine.preview(actor, intent({ action: "create", taskId: undefined, eventId: "active", owner: "calendar" })), /master-level recurrence repair/);
  assert.deepEqual(h.writes, []);
});

test("external changes to a retained Calendar master prevent repair success", async (t) => {
  const h = harness(t, { events: seriesFixture().events, tasks: [] });
  const create = h.clients.todoist.createTaskOnce;
  h.clients.todoist.createTaskOnce = async (...args) => {
    const created = await create(...args); h.eventMap.get("master").summary = "Externally changed"; return created;
  };
  const result = await h.execute(intent({ action: "create", taskId: undefined, eventId: "active", owner: "calendar" }));
  assert.equal(result.status, "needs_review");
  assert.match(result.error, /master.*changed/);
  assert.ok(h.controlsMap.get("home:calendar:master").activeRepair);
});

async function prepareSplitResume(t) {
  const h = harness(t, seriesFixture());
  const input = intent({ eventId: "master", owner: "todoist", scope: "future" });
  const snapshots = await h.engine.collect(input);
  const liveTask = task("task", { due: { date: "2099-12-18", is_recurring: true, string: "every year" } });
  const splitPlan = { oldMasterId:"master",newMasterId:"new-master",originalRule:"RRULE:FREQ=YEARLY;INTERVAL=1",truncatedRule:"RRULE:FREQ=YEARLY;INTERVAL=1;UNTIL=20251218",previousOccurrence:"2025-12-18" };
  h.taskMap.set(liveTask.id, liveTask);
  h.eventMap.get("master").recurrence = [splitPlan.truncatedRule];
  h.eventMap.get("master").extendedProperties = { shared: { syncHistoryOnly:"true",syncHistoryTaskId:"task",syncHistorySuccessorId:"new-master",syncHistoryOriginalRule:splitPlan.originalRule,syncHistoryCutoff:splitPlan.previousOccurrence } };
  h.eventMap.delete("active");
  h.recurrences.clear();
  h.eventMap.set("new-master", event("new-master", {
    recurrence: [todoistRecurrenceToRrule(liveTask)],
    extendedProperties: { shared: { syncRecurrenceOwner: "todoist", todoistRecurrence: todoistRecurrenceKey(liveTask),
      todoistAnchorStart: "2099-12-18", todoistAnchorEnd: "2099-12-21" } },
  }));
  h.eventMap.set("new-active", event("new-active", { recurringEventId: "new-master", originalStartTime: { date: "2099-12-18" } }));
  const expectedProviders = Object.fromEntries(snapshots.map(s => [refKey(s.ref), clone(s.ref.side === "todoist" ? h.taskMap.get(s.ref.id) : h.eventMap.get(s.ref.id)) || null]));
  h.operations.set("repair", { id: "repair", status: "needs_review", expectedProviders, preview: { intent: input, snapshots, case: {}, splitPlan },
    steps: { validated: { id: "validated", status: "done" }, "future-split": { id: "future-split", status: "done", result: { mapping: { masterEventId: "new-master" } } } } });
  return h;
}

test("resuming a completed future split verifies the capped master and its retired active occurrence", async (t) => {
  const h = await prepareSplitResume(t);
  const result = await h.engine.execute("repair");
  assert.equal(result.status, "succeeded", result.error);
  assert.ok(result.outcomes.some(value => value.entity === "home:calendar:active" && value.outcome === "history"));
  assert.ok(result.outcomes.some(value => value.entity === "home:calendar:master" && value.outcome === "history"));
  assert.equal(h.mappingMap.get("task").activeInstanceId, "new-active");
  assert.ok([...h.controlsMap.values()].every(value => !value.activeRepair));
});

test("decision previews derive the executor's targets and reject unrelated selections", async (t) => {
  const decision = { profile: "home", taskId: "task", eventId: "event", permittedActions: [{ id: "calendar_wins" }] };
  const h = harness(t, { decision });
  const input = intent({ action: "decision", taskId: undefined, eventId: undefined, decisionAction: "calendar_wins" });
  const preview = await h.engine.preview(actor, input);
  assert.equal(preview.intent.taskId, "task");
  assert.equal(preview.intent.eventId, "event");
  assert.deepEqual(preview.snapshots.map(value => refKey(value.ref)), ["home:calendar:event", "home:todoist:task"]);
  await assert.rejects(h.engine.preview(actor, { ...input, taskId: "unrelated" }), /do not match the decision/);
  await assert.rejects(h.engine.preview(actor, { ...input, eventId: "unrelated" }), /do not match the decision/);
  h.operations.set("repair", { id: "repair", status: "queued", steps: {}, preview });
  h.taskMap.get("task").content = "Changed after preview";
  const result = await h.engine.execute("repair");
  assert.equal(result.status, "failed", result.error);
  assert.match(result.error, /changed after preview/);
  assert.deepEqual(h.calls[0][1], preview.snapshots.map(value => value.ref));
  assert.deepEqual(h.writes, []);
});

test("a post-validation failure with no repair writes releases ownership and permits a new preview", async t => {
  const h=harness(t);
  const preview=await h.engine.preview(actor,intent());
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  h.engine.store.updateCase=async (_caseId,status)=>{if(status==="repairing")throw new Error("Read-only post-validation failure");};
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"failed",result.error);
  assert.equal(result.abandoned,true);
  assert.ok(result.steps.validated);
  assert.deepEqual(h.writes,[]);
  assert.ok([...h.controlsMap.values()].every(control=>!control.activeRepair));
  assert.equal(h.calls.filter(c=>c[0]==="release-unapplied").length,1);
  const redelivered=await h.engine.execute("repair");
  assert.equal(redelivered.abandoned,true);
  assert.equal(redelivered.status,"failed");
  assert.equal(h.calls.filter(c=>c[0]==="release-unapplied").length,1);
  const next=await h.engine.preview(actor,intent());
  assert.ok(next.id);
});

test("fresh preview supersedes a failed selected-pair mismatch only when validated is the sole checkpoint", async t => {
  const h=harness(t,{events:[event("event"),event("current")]});
  const staleIntent=intent({eventId:"event"});
  const oldPreview=await h.engine.preview(actor,staleIntent);
  const oldOperation={id:"stale-repair",actor, status:"failed",attempt:2,steps:{validated:{id:"validated",status:"done"}},
    error:"Selected pair does not match the current mapping; expected Calendar event old-event",
    preview:oldPreview,notificationPending:false};
  h.operations.set(oldOperation.id,clone(oldOperation));
  const currentMapping={profile:"home",taskId:"task",eventId:"current"};
  h.mappingMap.set("task",currentMapping);h.ownerMappingMap.set("task",currentMapping);h.eventMappingMap.set("home:current",currentMapping);
  for(const snapshot of oldPreview.snapshots)h.controlsMap.set(refKey(snapshot.ref),{...snapshot.control,activeRepair:oldOperation.id});

  const fresh=await h.engine.preview(actor,intent({eventId:"current"}));

  assert.ok(fresh.id);
  assert.equal(fresh.snapshots.find(snapshot=>snapshot.ref.side==="todoist").mapping.eventId,"current");
  assert.ok(fresh.snapshots.every(snapshot=>snapshot.control?.activeRepair===undefined));
  assert.equal(h.calls.filter(call=>call[0]==="release-unapplied").length,1);
  assert.deepEqual(h.operations.get(oldOperation.id).preview.intent,oldPreview.intent,
    "supersession must preserve the failed operation's selected-pair audit record");
  assert.equal(h.operations.get(oldOperation.id).steps.validated.status,"done");
  assert.deepEqual(h.writes,[]);
});

test("another actor cannot supersede a failed no-write repair", async t => {
  const h=harness(t),preview=await h.engine.preview(actor,intent());
  const oldOperation={id:"stale-repair",actor,status:"failed",attempt:2,
    steps:{validated:{id:"validated",status:"done"}},preview,error:"Selected pair mismatch",notificationPending:false};
  h.operations.set(oldOperation.id,clone(oldOperation));
  for(const snapshot of preview.snapshots)h.controlsMap.set(refKey(snapshot.ref),{...snapshot.control,activeRepair:oldOperation.id});

  await assert.rejects(h.engine.preview({subject:"other-operator",email:"other@example.test"},intent()),
    /incomplete repair owns an affected item; resume that operation first/);

  assert.equal(h.calls.filter(call=>call[0]==="release-unapplied").length,0);
  assert.ok(preview.snapshots.every(snapshot=>h.controlsMap.get(refKey(snapshot.ref)).activeRepair===oldOperation.id));
  assert.equal(h.operations.get(oldOperation.id).abandoned,undefined);
  assert.deepEqual(h.writes,[]);
});

test("fresh preview refuses a partial-write failure and preserves its resume barrier", async t => {
  const h=harness(t),preview=await h.engine.preview(actor,intent());
  const eventSnapshot=preview.snapshots.find(snapshot=>snapshot.ref.side==="calendar");
  const partial={id:"partial-repair",status:"failed",attempt:1,
    steps:{validated:{id:"validated",status:"done"}},
    expectedProviders:{[refKey(eventSnapshot.ref)]:{...eventSnapshot.object,summary:"written before the later failure"}},
    preview,error:"Todoist update failed after Calendar write",notificationPending:false};
  h.operations.set(partial.id,partial);
  for(const snapshot of preview.snapshots)h.controlsMap.set(refKey(snapshot.ref),{...snapshot.control,activeRepair:partial.id});

  await assert.rejects(h.engine.preview(actor,intent()),/incomplete repair owns an affected item; resume that operation first/);

  assert.equal(h.calls.filter(call=>call[0]==="release-unapplied").length,0);
  assert.ok(preview.snapshots.every(snapshot=>h.controlsMap.get(refKey(snapshot.ref)).activeRepair===partial.id));
  assert.equal(h.operations.get(partial.id).steps.validated.status,"done");
  assert.equal(h.operations.get(partial.id).expectedProviders[refKey(eventSnapshot.ref)].summary,"written before the later failure");
});

test("superseded preview rereads current provider versions and the new operation rejects a later edit", async t => {
  const h=harness(t),oldPreview=await h.engine.preview(actor,intent());
  const oldOperation={id:"stale-repair",actor,status:"failed",attempt:2,
    steps:{validated:{id:"validated",status:"done"}},preview:oldPreview,error:"Selected pair mismatch",notificationPending:false};
  h.operations.set(oldOperation.id,oldOperation);
  for(const snapshot of oldPreview.snapshots)h.controlsMap.set(refKey(snapshot.ref),{...snapshot.control,activeRepair:oldOperation.id});
  h.taskMap.get("task").content="Changed before fresh preview";

  const fresh=await h.engine.preview(actor,intent({winner:"todoist"}));

  assert.equal(fresh.snapshots.find(snapshot=>snapshot.ref.side==="todoist").object.content,"Changed before fresh preview");
  h.operations.set("fresh-repair",{id:"fresh-repair",status:"queued",steps:{},preview:fresh});
  h.taskMap.get("task").content="Changed after fresh preview";
  const result=await h.engine.execute("fresh-repair");
  assert.equal(result.status,"failed");
  assert.match(result.error,/Provider state or ownership changed after preview/);
  assert.deepEqual(h.writes,[]);
});

test("a stale sync-control version prevents superseding a no-write operation", async t => {
  const h=harness(t),preview=await h.engine.preview(actor,intent());
  const old={id:"stale-repair",actor,status:"failed",attempt:2,
    steps:{validated:{id:"validated",status:"done"}},preview,error:"Selected pair mismatch",notificationPending:false};
  h.operations.set(old.id,old);
  for(const snapshot of preview.snapshots)h.controlsMap.set(refKey(snapshot.ref),{
    ...snapshot.control,activeRepair:old.id,providerUpdatedAt:"version-after-preview"});
  h.controls.releaseUnapplied=async(refs,id,snapshots)=>{
    assert.equal(id,old.id);
    assert.ok(refs.every(ref=>snapshots.find(snapshot=>refKey(snapshot.ref)===refKey(ref))));
    assert.ok(snapshots.some(snapshot=>snapshot.control?.providerUpdatedAt!==h.controlsMap.get(refKey(snapshot.ref))?.providerUpdatedAt));
    throw new Error("ConditionalCheckFailedException: provider control version changed");
  };

  await assert.rejects(h.engine.preview(actor,intent()),/could not be safely superseded/);

  assert.ok(preview.snapshots.every(snapshot=>h.controlsMap.get(refKey(snapshot.ref)).activeRepair===old.id));
  assert.deepEqual(h.writes,[]);
});

for (const action of ["exclude","separate","move"]) test(`read-only ${action} validation failure releases every claimed lock`,async t=>{
  const h=action==="move"?moveHarness(t):harness(t);
  const selected=action==="move"?h.input:action==="separate"
    ? intent({action,leftovers:{"home:todoist:task":"exclude","home:calendar:event":"exclude"}})
    : intent({action});
  const preview=await h.engine.preview(actor,selected);
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  h.engine.store.updateCase=async (_case,status)=>{if(status==="repairing")throw new Error("Failure before writes");};
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"failed",result.error);
  assert.equal(result.abandoned,true);
  assert.deepEqual(h.writes,[]);
  assert.ok([...h.controlsMap.values()].every(control=>!control.activeRepair));
  if(action==="move"){
    assert.equal(result.claimSnapshots.length,1);
    assert.equal(result.claimSnapshots[0].ref.profile,"work");
    assert.ok(h.controlsMap.has("work:todoist:task"));
  }
});

test("a started exclusion step retains barriers if its Dynamo write response fails",async t=>{
  const h=harness(t),write=h.controls.exclude;
  h.controls.exclude=async(...args)=>{await write(...args);throw new Error("Exclusion write acknowledgement lost");};
  const result=await h.execute(intent({action:"exclude"}));
  assert.equal(result.status,"needs_review");
  assert.equal(result.abandoned,undefined);
  assert.match(result.error,/Exclusion write acknowledgement lost/);
  assert.ok(Object.keys(result.steps).some(step=>step.startsWith("exclude:")));
  assert.ok([...h.controlsMap.values()].some(control=>control.activeRepair==="repair"));
});

test("failed case-status cleanup does not erase the atomic abandoned outcome",async t=>{
  const h=harness(t);
  const preview=await h.engine.preview(actor,intent());
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  h.engine.store.updateCase=async (_case,status)=>{throw new Error(`Case ${status} write failed`);};
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"failed");
  assert.equal(result.abandoned,true);
  assert.match(result.error,/Case repairing write failed/);
  assert.match(result.error,/case status could not be updated/);
  assert.equal(h.operations.get("repair").abandoned,true);
  assert.ok([...h.controlsMap.values()].every(control=>!control.activeRepair));
});
test("an uncertain release retains the barrier and marks the failed repair for review", async t => {
  const h=harness(t);
  const preview=await h.engine.preview(actor,intent());
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  h.engine.store.updateCase=async (_caseId,status)=>{if(status==="repairing")throw new Error("Read-only failure");};
  h.controls.releaseUnapplied=async()=>{throw new Error("Dynamo transaction rejected");};
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"needs_review");
  assert.equal(result.abandoned,undefined);
  assert.match(result.error,/Dynamo transaction rejected/);
  assert.ok([...h.controlsMap.values()].every(control=>control.activeRepair==="repair"));
});
test("replacement of a deleted counterpart accepts only the expected completed detachment", async (t) => {
  const mapping = { profile: "home", taskId: "task", eventId: "deleted-event" };
  const h = harness(t, { events: [], mappings: [mapping] });
  const result = await h.execute(intent({ action: "create", eventId: undefined }));
  assert.equal(result.status, "succeeded", result.error);
  assert.notEqual(h.mappingMap.get("task").eventId, "deleted-event");
  assert.ok(result.outcomes.some(value => value.entity === "home:calendar:deleted-event" && value.outcome === "missing"));
  assert.ok([...h.controlsMap.values()].every(value => !value.activeRepair));
  const writes = h.writes.length;
  await h.engine.execute("repair");
  assert.equal(h.writes.length, writes);
});

test("a deleted counterpart reappearing after replacement prevents barrier release", async (t) => {
  const h = harness(t, { events: [], mappings: [{ profile: "home", taskId: "task", eventId: "deleted-event" }] });
  const create = h.clients.calendar.createRepairEventOnce;
  h.clients.calendar.createRepairEventOnce = async (...args) => {
    const created = await create(...args); h.eventMap.set("deleted-event", event("deleted-event")); return created;
  };
  const result = await h.execute(intent({ action: "create", eventId: undefined }));
  assert.equal(result.status, "needs_review");
  assert.match(result.error, /Missing item.*changed during repair/);
  assert.ok(h.controlsMap.get("home:todoist:task").activeRepair);
});

test("a missing counterpart is rechecked again immediately before releasing barriers", async (t) => {
  const h = harness(t, { events: [], mappings: [{ profile: "home", taskId: "task", eventId: "deleted-event" }] });
  const save = h.engine.store.saveOperation;
  h.engine.store.saveOperation = async operation => {
    await save(operation);
    if (operation.outcomes?.some(value => value.outcome === "missing")) h.eventMap.set("deleted-event", event("deleted-event"));
  };
  const result = await h.execute(intent({ action: "create", eventId: undefined }));
  assert.equal(result.status, "needs_review");
  assert.match(result.error, /Missing item.*changed before release/);
  assert.ok(h.controlsMap.get("home:todoist:task").activeRepair);
});

test("unexpected remapping of a missing counterpart is not mistaken for planned detachment", async (t) => {
  const h = harness(t, { events: [], mappings: [{ profile: "home", taskId: "task", eventId: "deleted-event" }] });
  const create = h.clients.calendar.createRepairEventOnce;
  h.clients.calendar.createRepairEventOnce = async (...args) => {
    const created = await create(...args);
    h.mappingMap.set("unexpected-task", { profile: "home", taskId: "unexpected-task", eventId: "deleted-event" });
    return created;
  };
  const result = await h.execute(intent({ action: "create", eventId: undefined }));
  assert.equal(result.status, "needs_review");
  assert.match(result.error, /Missing item.*changed during repair/);
  assert.ok(h.controlsMap.get("home:todoist:task").activeRepair);
});

test("Calendar-wins repair fences delayed Todoist payloads before releasing its barriers", async (t) => {
  const h = harness(t, { tasks: [task("task", { content: "Old title" })] });
  const result = await h.execute(intent({ winner: "calendar" }));
  assert.equal(result.status, "succeeded", result.error);
  const fence = h.calls.findIndex(value => value[0] === "version");
  const release = h.calls.findIndex(value => value[0] === "release");
  assert.ok(fence >= 0 && fence < release);
  assert.equal(h.versions.get("task"), "2026-10-21T14:00:00Z");
  const writes = h.writes.length;
  await new Synchronizer(new StateRepository(), undefined, async () => h.clients).process({
    id: "delayed", kind: "todoist", profile: "home", mode: "aws", headers: {},
    body: JSON.stringify({ event_name: "item:updated", event_data: task("task", { content: "Delayed stale title", updated_at: "2026-10-21T13:00:00Z" }) }),
  });
  assert.equal(h.writes.length, writes);
  assert.equal(h.eventMap.get("event").summary, "Portugal");
  assert.ok(h.calls.some(value => value[0] === "audit" && value[1] === "todoist_stale_version_suppressed"));
});

for (const reason of ["excluded", "activeRepair", "rejectedPair"]) {
  for (const changedDescription of [false, true]) {
    test(`Calendar candidate selection respects ${reason} before ${changedDescription ? "updating the task" : "restoring a canonical mapping"}`, async (t) => {
      const h = harness(t, { tasks: [task("task", { description: changedDescription ? "Old description" : "Plan" })] });
      const controls = new SyncControls();
      controls.control = async ref => ref.side === "todoist" ? { [reason]: reason === "activeRepair" ? "other-repair" : true } : undefined;
      controls.rejected = async (_profile, taskId, eventId) => reason === "rejectedPair" && taskId === "task" && eventId === "event";
      t.mock.method(documentClient, "send", async () => ({}));
      t.mock.method(ReviewStore.prototype, "get", async pk => pk.startsWith("REJECTED_PAIR#") && reason === "rejectedPair"
        ? { operationId:"someone-else" } : undefined);
      t.mock.method(StateRepository.prototype, "syncBlocked", (profile, ids) => controls.blocked(profile, ids));
      await new Synchronizer(new StateRepository(), undefined, async () => h.clients).process({
        id: "calendar-change", kind: "calendar", profile: "home", mode: "aws", headers: {}, body: "",
      });
      assert.equal(h.mappingMap.size, 0);
      assert.deepEqual(h.writes, []);
      assert.ok(h.calls.some(value => value[0] === "audit" && value[1] === "calendar_event_sync_control_blocked"));
    });
  }
}

for (const winner of ["todoist","calendar"]) test(`occurrence ownership transfer to Todoist is rejected before ${winner}-wins repair writes`, async t => {
  const h = harness(t, { ...seriesFixture(), tasks:[task("task", { due:{date:"2099-12-18",is_recurring:true,string:"every week"} })] });
  await assert.rejects(h.engine.preview(actor, intent({eventId:"active",owner:"todoist",winner})), /master.*future-only/);
  assert.deepEqual(h.writes, []);
  assert.equal(h.controlsMap.size, 0);
});

for (const source of ["selected link","selected create","leftover create"]) {
  test(`cancelled Calendar ${source} is rejected during preview`, async t => {
    const h = harness(t, {events:[event("event", {status:"cancelled"})]});
    const input = source === "selected link" ? intent({winner:"calendar"}) : source === "selected create"
      ? intent({action:"create",taskId:undefined}) : intent({action:"separate",leftovers:{"home:calendar:event":"create","home:todoist:task":"exclude"}});
    await assert.rejects(h.engine.preview(actor,input), /must be confirmed/);
    assert.deepEqual(h.writes, []); assert.equal(h.controlsMap.size, 0);
  });
  test(`undated Todoist ${source} is rejected during preview`, async t => {
    const h = harness(t, {tasks:[task("task", {due:undefined})]});
    const input = source === "selected link" ? intent({winner:"todoist"}) : source === "selected create"
      ? intent({action:"create",eventId:undefined}) : intent({action:"separate",leftovers:{"home:todoist:task":"create","home:calendar:event":"exclude"}});
    await assert.rejects(h.engine.preview(actor,input), /undated Todoist task/);
    assert.deepEqual(h.writes, []); assert.equal(h.controlsMap.size, 0);
  });
}

for (const winner of ["todoist","calendar"]) test(`${winner}-wins repair preserves an external destination edit made during detachment`, async t => {
  const mapping = {profile:"home",taskId:"task",eventId:"event"};
  const h = harness(t, {mappings:[mapping],events:[event("event",{extendedProperties:{shared:{taskId:"task"}}})]});
  const reject = h.controls.reject.bind(h.controls);
  h.controls.reject = async (...args) => {
    await reject(...args);
    if (winner === "todoist") h.eventMap.get("event").summary = "Unapproved Calendar edit";
    else h.taskMap.get("task").content = "Unapproved Todoist edit";
  };
  const result = await h.execute(intent({winner}));
  assert.equal(result.status,"needs_review"); assert.match(result.error,/changed after preview/);
  assert.equal(winner === "todoist" ? h.eventMap.get("event").summary : h.taskMap.get("task").content, winner === "todoist" ? "Unapproved Calendar edit" : "Unapproved Todoist edit");
  assert.ok(h.controlsMap.get("home:todoist:task").activeRepair);
});

test("retry accepts the repair's recorded metadata version before completing field alignment", async t => {
  const h = harness(t, {mappings:[{profile:"home",taskId:"task",eventId:"event"}],events:[event("event",{summary:"Old title",extendedProperties:{shared:{taskId:"task"}}})]});
  const upsert = h.clients.calendar.upsertEventIfUnchanged;
  let alignFailed = false;
  h.clients.calendar.upsertEventIfUnchanged = async (...args) => {
    if (args[0].summary === "Portugal" && !alignFailed) { alignFailed = true; throw new Error("Temporary provider failure"); }
    return upsert(...args);
  };
  const first = await h.execute(intent({winner:"todoist"}));
  assert.equal(first.status,"needs_review");
  assert.equal(first.steps["unlink-metadata:event"].status,"done");
  assert.equal(first.expectedProviders["home:calendar:event"].etag, h.eventMap.get("event").etag);
  const second = await h.engine.execute("repair");
  assert.equal(second.status,"succeeded",second.error);
  assert.equal(h.eventMap.get("event").summary,"Portugal");
  assert.equal(h.eventMap.get("event").end.date,"2099-12-21");
});

for (const boundary of ["outcome verification","pre-release verification"]) test(`resumed split rejects an uncapped old rule at ${boundary}`, async t => {
  const h = await prepareSplitResume(t);
  const uncap = () => { h.eventMap.get("master").recurrence = [h.operations.get("repair").preview.splitPlan.originalRule]; };
  if (boundary === "outcome verification") uncap();
  else {
    const save = h.engine.store.saveOperation;
    h.engine.store.saveOperation = async operation => { await save(operation); if (operation.outcomes) uncap(); };
  }
  const result = await h.engine.execute("repair");
  assert.equal(result.status,"needs_review"); assert.match(result.error,/history cap|master.*changed/);
  assert.ok(h.controlsMap.get("home:calendar:master").activeRepair);
});

test("atomic finalization failure leaves every original fence unchanged and can resume", async t => {
  const h = harness(t, {events:[],mappings:[{profile:"home",taskId:"task",eventId:"missing"}]});
  const finalize = h.engine.store.finalizeOperation;
  let failed = false;
  h.engine.store.finalizeOperation = async (...args) => {
    if (!failed) { failed = true; throw new Error("Temporary transaction failure"); }
    return finalize(...args);
  };
  await assert.rejects(h.execute(intent({action:"create",eventId:undefined})), /transaction failure/);
  assert.ok([...h.controlsMap.values()].every(value => value.activeRepair === "repair" && !value.fencedAt));
  const writes = h.writes.length;
  const result = await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.writes.length,writes);
  assert.ok([...h.controlsMap.values()].every(value => !value.activeRepair && value.fencedAt));
});

for (const replaceDeleted of [false,true]) test(`delegated task ${replaceDeleted ? "replacement" : "creation"} verifies and version-fences the mapping found through its event`,async t=>{
  const action=replaceDeleted?"calendar_wins":"create_new_task";
  const decision={decisionId:"original",profile:"home",type:replaceDeleted?"both_sides_changed":"calendar_snapshot_unmapped_ambiguous",taskId:replaceDeleted?"deleted-task":undefined,eventId:"event",context:{},permittedActions:[{id:action}]};
  const h=harness(t,{tasks:[],decision,mappings:replaceDeleted?[{profile:"home",taskId:"deleted-task",eventId:"event"}]:[]}); const decisions=new Map();
  t.mock.method(ManualDecisionStore.prototype,"putPending",async input=>{
    const saved={...input,status:"pending",decisionDeadline:"2099-12-31T00:00:00Z"};decisions.set(input.decisionId,saved);return {decision:saved};
  });
  t.mock.method(ManualDecisionStore.prototype,"get",async id=>decisions.get(id));
  t.mock.method(ManualDecisionStore.prototype,"finish",async(id,status)=>{decisions.get(id).status=status;});
  t.mock.method(ManualInterventionService.prototype,"finishReconciliationDecision",async()=>{});
  const result=await h.execute(intent({action:"decision",taskId:undefined,eventId:undefined,decisionAction:action}));
  assert.equal(result.status,"succeeded",result.error);
  assert.deepEqual(result.verified,[{profile:"home",taskId:"created-task",eventId:"event"}]);
  assert.equal(h.versions.get("created-task"),h.taskMap.get("created-task").updated_at);
  assert.equal(h.baselines[0][2].id,"created-task");
});

test("Verify accounts for the mapped active instance of a Todoist-owned master",async t=>{
  const fixture=seriesFixture(), liveTask=task("task",{due:{date:"2099-12-18",is_recurring:true,string:"every week"}});
  fixture.events[0].recurrence=[todoistRecurrenceToRrule(liveTask)];
  fixture.events[0].extendedProperties={shared:{syncRecurrenceOwner:"todoist",todoistRecurrence:todoistRecurrenceKey(liveTask),todoistAnchorStart:"2099-12-18",todoistAnchorEnd:"2099-12-21"}};
  fixture.mappings[0]={...fixture.mappings[0],recurrenceOwner:"todoist",eventId:"master",seriesId:"task"};
  fixture.recurrence={...fixture.mappings[0],owner:"todoist"};
  const h=harness(t,{...fixture,tasks:[liveTask]});
  const result=await h.execute(intent({action:"verify",eventId:"master",owner:"todoist",scope:"series"}));
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(result.recurrenceBindings[0].activeInstanceId,"active");
  assert.ok([...h.controlsMap.values()].every(value=>!value.activeRepair));
});

test("creating a counterpart for a displaced Calendar master verifies its entire resulting recurrence",async t=>{
  const fixture=seriesFixture();
  const h=harness(t,{...fixture,events:[...fixture.events,event()]});
  const result=await h.execute(intent({leftovers:{"home:calendar:master":"create"}}));
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.mappingMap.get("task").eventId,"event");
  assert.equal(h.mappingMap.get("created-task").eventId,"active");
  assert.equal(result.recurrenceBindings[0].masterEventId,"master");
  assert.ok(result.outcomes.some(value=>value.entity==="home:calendar:master"&&value.outcome==="history"));
});

test("unrelated recurring occurrences cannot borrow another verified binding's outcome",async t=>{
  const fixture=seriesFixture();
  fixture.events.push(event("unrelated",{recurringEventId:"master",extendedProperties:{shared:{taskId:"task"}}}));
  const h=harness(t,fixture);
  const result=await h.execute(intent({action:"verify",eventId:"master",owner:"calendar",scope:"series"}));
  assert.notEqual(result.status,"succeeded");
  assert.match(result.error,/Unverified leftover home:calendar:unrelated/);
});

test("series verification accepts its recorded metadata cleanup while preserving unrelated fields",async t=>{
  const fixture=seriesFixture();
  fixture.events[0].extendedProperties={shared:{taskId:"task",syncRecurrenceOwner:"calendar",unrelated:"retained"}};
  const h=harness(t,fixture);
  const result=await h.execute(intent({eventId:"master",owner:"calendar",winner:"calendar",scope:"series"}));
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.eventMap.get("master").extendedProperties.shared.unrelated,"retained");
  assert.equal(h.eventMap.get("active").extendedProperties.shared.taskId,"task");
});

test("an unpreviewed active occurrence cannot become the target during a series repair",async t=>{
  const h=harness(t,seriesFixture());
  const reject=h.controls.reject.bind(h.controls);
  h.controls.reject=async(...args)=>{
    await reject(...args);
    h.eventMap.set("unapproved-active",event("unapproved-active",{recurringEventId:"master",start:{date:"2099-12-15"},originalStartTime:{date:"2099-12-15"}}));
  };
  const result=await h.execute(intent({eventId:"master",owner:"calendar",winner:"calendar",scope:"series"}));
  assert.equal(result.status,"needs_review");assert.match(result.error,/active occurrence changed after preview/);
  assert.ok(!h.writes.some(value=>value[0]==="task"));
  assert.ok(h.controlsMap.get("home:calendar:master").activeRepair);
});

for (const kind of ["snapshot-task","replacement-task","replacement-event"]) {
  for (const committed of [false,true]) test(`delegated ${kind} recovers a ${committed ? "committed" : "rejected"} mapping write without duplicate creation`, async t => {
    const snapshot=kind==="snapshot-task", calendarCreation=kind==="replacement-event";
    const action=snapshot?"create_new_task":calendarCreation?"todoist_wins":"calendar_wins";
    const mapping={profile:"home",taskId:calendarCreation?"task":"deleted-task",eventId:calendarCreation?"deleted-event":"event"};
    const decision={decisionId:"original",profile:"home",type:snapshot?"calendar_snapshot_unmapped_ambiguous":"both_sides_changed",taskId:snapshot?undefined:mapping.taskId,eventId:mapping.eventId,mappingSnapshot:snapshot?undefined:mapping,context:{},permittedActions:[{id:action}]};
    const h=harness(t,{tasks:calendarCreation?[task()]:[],events:calendarCreation?[]:[event()],mappings:snapshot?[]:[mapping],decision});
    const decisions=new Map();
    t.mock.method(ManualDecisionStore.prototype,"putPending",async input=>{
      if(decisions.has(input.decisionId))return {decision:decisions.get(input.decisionId)};
      const saved={...input,status:"pending",decisionDeadline:"2099-12-31T00:00:00Z"};decisions.set(input.decisionId,saved);return {decision:saved};
    });
    t.mock.method(ManualDecisionStore.prototype,"get",async id=>decisions.get(id));
    t.mock.method(ManualDecisionStore.prototype,"finish",async(id,status)=>{if(decisions.has(id))decisions.get(id).status=status;});
    t.mock.method(ManualInterventionService.prototype,"finishReconciliationDecision",async id=>{if(decisions.has(id))decisions.get(id).status="resolved";});
    const putMapping=StateRepository.prototype.putMapping;
    let failed=false;
    t.mock.method(StateRepository.prototype,"putMapping",async function(value){
      if(!failed){failed=true;if(committed)await putMapping.call(this,value);throw new Error("Mapping response interrupted");}
      return putMapping.call(this,value);
    });
    const first=await h.execute(intent({action:"decision",taskId:undefined,eventId:undefined,decisionAction:action}));
    assert.equal(first.status,"needs_review",first.error);
    assert.match(first.error,/Mapping response interrupted/);
    assert.equal(Object.values(first.creations).filter(c=>c.result).length,1);
    const second=await h.engine.execute("repair");
    assert.equal(second.status,"succeeded",second.error);
    assert.equal(h.writes.filter(w=>w[0]===(calendarCreation?"create-event":"create-task")).length,1);
    assert.equal(h.mappingMap.size,1);
    assert.equal(second.verified.length,1);
    assert.equal(decisions.get("review-repair").status,"resolved");
    assert.ok([...h.controlsMap.values()].every(v=>!v.activeRepair));
  });
}

test("a move into an empty destination creates and verifies exactly one approved projection",async t=>{
  const h=moveHarness(t,{existing:false});
  const result=await h.execute();assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.destinationEvents.size,1);assert.equal(h.mappingMap.get("task").profile,"work");
  assert.ok(!h.eventMap.has("event"));
  const second=await h.engine.execute("repair");assert.equal(second.status,"succeeded");
  assert.equal(h.destinationEvents.size,1);
});

test("review preview displays exact expired-rule preservation and new future series", async t => {
  const master = event("old-expired", {
    summary:"Portugal", description:"Plan",
    start:{date:"2025-05-02"},end:{date:"2025-05-03"},
    recurrence:["RRULE:FREQ=YEARLY;UNTIL=20231231"],
    extendedProperties:{shared:{taskId:"task"}},
  });
  const recurring = task("task", {
    due:{date:"2027-05-02",is_recurring:true,string:"every year"},
  });
  const h = harness(t,{events:[master],tasks:[recurring]});
  h.clients.calendar.getTimeZone = async () => "Europe/London";
  const p = await h.engine.preview(actor, intent({
    eventId:master.id, winner:"todoist", owner:"todoist", scope:"future",
  }));
  assert.equal(p.splitPlan.expiredUntil,"2023-12-31");
  assert.equal(p.splitPlan.truncatedRule,master.recurrence[0]);
  assert.ok(p.changes.some(value=>value.includes("2027-05-02")&&value.includes("RRULE:FREQ=YEARLY")));
  assert.ok(p.changes.some(value=>value.includes("2023-12-31")&&value.includes("unchanged")));
  assert.deepEqual(h.writes,[]);
});

test("unsupported Calendar recurrence returns an actionable preview validation error", async t => {
  const master = event("old-expired", {
    start:{date:"2025-05-02"},end:{date:"2025-05-03"},
    recurrence:["RRULE:FREQ=YEARLY;UNTIL=20231231;COUNT=3"],
    extendedProperties:{shared:{taskId:"task"}},
  });
  const h = harness(t,{events:[master],tasks:[task("task",{due:{date:"2027-05-02",is_recurring:true,string:"every year"}})]});
  h.clients.calendar.getTimeZone = async () => "Europe/London";
  await assert.rejects(h.engine.preview(actor, intent({
    eventId:master.id,winner:"todoist",owner:"todoist",scope:"future",
  })), error=>error.status===400 && /COUNT.*manual review/.test(error.message));
  assert.deepEqual(h.writes,[]);
});

test("yearly IFTTT standalone is preserved and a separate deterministic 2027 master is mapped without a new task", async t => {
  const taskId="task", sourceId="event";
  const h=harness(t,{events:[event(sourceId,{summary:"Portugal",description:"Plan",
    start:{date:"2026-03-15"},end:{date:"2026-03-16"},extendedProperties:{shared:{taskId}}})],
    tasks:[task(taskId,{due:{date:"2027-03-15",is_recurring:true,string:"every year"}})]});
  const input=intent({owner:"todoist",winner:"todoist",scope:"future"});
  const preview=await h.engine.preview(actor,input);
  assert.equal(preview.annualPlan.mode,"keep-history");
  assert.equal(preview.annualPlan.start,"2027-03-15");
  assert.match(preview.changes.join(" "),/RRULE:FREQ=YEARLY/);
  assert.notEqual(preview.annualPlan.masterId,sourceId);
  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.eventMap.get(sourceId).start.date,"2026-03-15");
  assert.equal(h.eventMap.get(sourceId).recurrence,undefined);
  assert.equal(h.eventMap.get(sourceId).extendedProperties.shared.syncHistoryOnly,"true");
  assert.ok(!h.eventMap.get(sourceId).extendedProperties.shared.taskId);
  const mapping=h.mappingMap.get(taskId);
  assert.equal(mapping.eventId,preview.annualPlan.masterId);
  assert.equal(mapping.activeInstanceId,preview.annualPlan.masterId+"_instance");
  assert.deepEqual(h.eventMap.get(mapping.masterEventId).recurrence,["RRULE:FREQ=YEARLY"]);
  assert.equal(h.taskMap.size,1);
  assert.ok(!h.writes.some(w=>w[0]==="create-task"));
});

test("same-date yearly standalone becomes its existing master rather than a second Calendar event",async t=>{
  const h=harness(t,{events:[event("event",{end:{date:"2099-12-21"}})],
    tasks:[task("task",{due:{date:"2099-12-18",is_recurring:true,string:"every year"}})]});
  const input=intent({owner:"todoist",scope:"future",winner:"todoist"});
  const preview=await h.engine.preview(actor,input);
  assert.equal(preview.annualPlan.mode,"annualize-in-place");
  assert.equal(preview.annualPlan.end,"2099-12-21");
  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.eventMap.get("event").start.date,"2099-12-18");
  assert.equal(h.eventMap.get("event").end.date,"2099-12-21");
  assert.deepEqual(h.eventMap.get("event").recurrence,["RRULE:FREQ=YEARLY"]);
  assert.equal(h.mappingMap.get("task").masterEventId,"event");
  assert.ok(!h.writes.some(w=>w[0]==="create-task" || w[0]==="create-future-master"));
});

test("car MOT annualization preview shows an exact 2027 RRULE and links the existing task",async t=>{
  const taskId="68mWcM4gfvVM4fC3", eventId="brhi6mp7np0blm2cmcb3spl8b0";
  const h=harness(t,{
    events:[event(eventId,{summary:"car Mot Expiry",description:"Annual vehicle test",
      start:{date:"2027-02-25"},end:{date:"2027-02-26"}})],
    tasks:[task(taskId,{content:"car Mot Expiry",description:"Annual vehicle test",
      due:{date:"2027-02-25",is_recurring:true,string:"every year"}})],
  });
  h.clients.calendar.getTimeZone=async()=>"Europe/London";
  const input=intent({taskId,eventId,owner:"todoist",winner:"todoist",scope:"future"});
  const preview=await h.engine.preview(actor,input);

  assert.equal(preview.annualPlan.mode,"annualize-in-place");
  assert.equal(preview.annualPlan.masterId,eventId);
  assert.equal(preview.annualPlan.start,"2027-02-25");
  assert.equal(preview.annualPlan.end,"2027-02-26");
  assert.equal(preview.annualPlan.timeZone,"Europe/London");
  assert.equal(preview.annualPlan.rule,"RRULE:FREQ=YEARLY");
  assert.ok(preview.changes.some(change=>change.includes("DTSTART 2027-02-25")
    && change.includes("RRULE:FREQ=YEARLY") && change.includes("timezone Europe/London")
    && change.includes(`master ID ${eventId}`)));
  assert.ok(preview.changes.some(change=>change.includes(`map existing Todoist task ${taskId}`)));
  assert.deepEqual(h.writes,[]);

  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",result.error);
  assert.deepEqual(h.eventMap.get(eventId).recurrence,["RRULE:FREQ=YEARLY"]);
  assert.equal(h.mappingMap.get(taskId).masterEventId,eventId);
  assert.equal(h.mappingMap.get(taskId).eventId,eventId);
  assert.equal(h.mappingMap.get(taskId).activeInstanceId,`${eventId}_instance`);
  assert.equal(h.taskMap.size,1);
  assert.ok(!h.writes.some(write=>write[0]==="create-task" || write[0]==="create-future-master"));
});

test("yearly standalone refuses duplicate mirrors, existing series, unsupported rules and already owned histories before writes",async t=>{
  const due={date:"2099-12-18",is_recurring:true,string:"every year"};
  for(const option of ["duplicate","series","unsupported","mapped","scope"]) {
    const tsk=task("task",{due:option==="unsupported"?{...due,string:"every! year"}:due});
    const moreTasks=option==="duplicate"?[task("other",{due:{date:"2099-12-18"}})]:[];
    const moreEvents=option==="series"?[event("existing-master",{start:{date:"2098-12-18"},recurrence:["RRULE:FREQ=YEARLY"]}),
      event("occurrence",{recurringEventId:"existing-master"})]:[];
    const mappings=option==="mapped"?[{profile:"home",taskId:"task",eventId:"event"}]:[];
    const h=harness(t,{events:[event(),...moreEvents],tasks:[tsk,...moreTasks],mappings});
    await assert.rejects(h.engine.preview(actor,intent({owner:"todoist",winner:"todoist",scope:option==="scope"?"occurrence":"future"})),
      option==="duplicate"?/Another active Todoist/:
      option==="series"?/Existing Calendar recurrence/:
      option==="unsupported"?/not an unambiguous YEARLY/:
      option==="mapped"?/already has a mapping/:
      /Future occurrences/);
    assert.deepEqual(h.writes,[]);
  }
});

test("yearly standalone reuses the exact active occurrence of an already Todoist-owned annual master",async t=>{
  const recurring=task("task",{due:{date:"2099-12-18",is_recurring:true,string:"every year"}});
  const key=todoistRecurrenceKey(recurring);
  const master=event("existing-master",{start:{date:"2026-12-18"},end:{date:"2026-12-21"},
    recurrence:[todoistRecurrenceToRrule(recurring)],extendedProperties:{shared:{taskId:"task",syncRecurrenceOwner:"todoist",
      todoistRecurrence:key,todoistAnchorStart:"2026-12-18",todoistAnchorEnd:"2026-12-21",todoistAnchorAllDay:"true",
      todoistAnchorTimeZone:"Europe/London"}}});
  const active=event("existing-active",{start:{date:"2099-12-18"},end:{date:"2099-12-21"},recurrence:undefined,
    recurringEventId:master.id,originalStartTime:{date:"2099-12-18"},extendedProperties:master.extendedProperties});
  const source=event("event",{start:{date:"2098-12-18"},end:{date:"2098-12-21"},extendedProperties:{shared:{taskId:"task"}}});
  const h=harness(t,{events:[source,master,active],tasks:[recurring]});
  const input=intent({owner:"todoist",winner:"todoist",scope:"future"});
  const preview=await h.engine.preview(actor,input);
  assert.equal(preview.annualPlan.mode,"reuse-existing");
  assert.equal(preview.annualPlan.masterId,"existing-master");
  assert.equal(preview.annualPlan.activeInstanceId,"existing-active");
  const result=await h.execute(input);
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.mappingMap.get("task").masterEventId,"existing-master");
  assert.equal(h.eventMap.get("event").extendedProperties.shared.syncHistorySuccessorId,"existing-master");
  assert.ok(!h.writes.some(write=>write[0]==="create-future-master"));
  assert.equal(h.taskMap.size,1);
});

test("stale annual preview cannot write to a modified standalone event", async t=>{
  const h=harness(t,{tasks:[task("task",{due:{date:"2099-12-18",is_recurring:true,string:"yearly"}})]});
  const preview=await h.engine.preview(actor,intent({owner:"todoist",winner:"todoist",scope:"future"}));
  h.operations.set("repair",{id:"repair",status:"queued",steps:{},preview});
  h.eventMap.get("event").summary="Changed externally";
  const result=await h.engine.execute("repair");
  assert.notEqual(result.status,"succeeded");
  assert.match(result.error,/changed after preview|Provider state or ownership changed/);
  assert.deepEqual(h.writes,[]);
});

test("yearly historical event survives a lost future-master acknowledgement and resumes without duplicates",async t=>{
  const h=harness(t,{events:[event("event",{start:{date:"2026-03-15"},end:{date:"2026-03-16"},
    extendedProperties:{shared:{taskId:"task"}}})],
    tasks:[task("task",{due:{date:"2027-03-15",is_recurring:true,string:"yearly"}})]});
  const original=h.clients.calendar.createFutureMasterOnce;
  let calls=0;
  h.clients.calendar.createFutureMasterOnce=async (...args)=>{
    if(++calls===1)throw new Error("Transient Calendar POST error");
    return original(...args);
  };
  const input=intent({owner:"todoist",winner:"todoist",scope:"future"});
  const first=await h.execute(input);
  assert.equal(first.status,"needs_review");
  assert.equal(h.eventMap.get("event").start.date,"2026-03-15");
  assert.equal(h.eventMap.get("event").extendedProperties.shared.syncHistoryOnly,"true");
  assert.equal(h.mappingMap.size,0);
  const resumed=await h.engine.execute("repair");
  assert.equal(resumed.status,"succeeded",resumed.error);
  assert.equal(h.taskMap.size,1);
  assert.equal(h.mappingMap.get("task").recurrenceOwner,"todoist");
  assert.equal(h.eventMap.get("event").recurrence,undefined);
  assert.equal(h.writes.filter(w=>w[0]==="create-future-master").length,1);
});

test("same-date annualizing can resume after the Calendar update but before reading its occurrence",async t=>{
  const h=harness(t,{events:[event("event",{extendedProperties:{shared:{syncHistoryMasterId:"stale-master",
    syncSplitVersion:"stale-version",
    syncRecurrenceOwner:"todoist",todoistRecurrence:"stale-rule",todoistAnchorStart:"2098-12-18",
    todoistAnchorEnd:"2098-12-21"}}})],
    tasks:[task("task",{due:{date:"2099-12-18",is_recurring:true,string:"every year"}})]});
  const read=h.clients.calendar.listInstancesInWindow;
  let calls=0;
  h.clients.calendar.listInstancesInWindow=async(...args)=>{
    if(++calls===1)throw new Error("Transient Calendar instances read failed");
    return read(...args);
  };
  const first=await h.execute(intent({owner:"todoist",winner:"todoist",scope:"future"}));
  assert.equal(first.status,"needs_review");
  assert.deepEqual(h.eventMap.get("event").recurrence,["RRULE:FREQ=YEARLY"]);
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",result.error);
  assert.equal(h.mappingMap.get("task").masterEventId,"event");
  const shared=h.eventMap.get("event").extendedProperties.shared;
  assert.equal(shared.syncRecurrenceOwner,"todoist");
  assert.equal(shared.todoistRecurrence,todoistRecurrenceKey(task("task",{due:{date:"2099-12-18",is_recurring:true,string:"every year"}})));
  assert.ok(!shared.syncHistoryOnly && !shared.syncHistoryMasterId);
  assert.equal(h.writes.filter(w=>w[0]==="event" && w[1]==="event").length,2); // annualization + metadata link
  assert.equal(h.taskMap.size,1);
});

function flattenFixture() {
  const master = event("flatten-master",{summary:"Birthday",description:"",start:{date:"2026-08-16"},end:{date:"2026-08-17"},recurrence:["RRULE:FREQ=YEARLY"]});
  const occurrence = event("flatten-instance",{summary:"Birthday",description:"",start:{date:"2027-08-16"},end:{date:"2027-08-17"},recurringEventId:master.id,originalStartTime:{date:"2027-08-16"}});
  const recurring = task("task",{content:"Birthday",description:"",due:{date:"2027-08-16",is_recurring:true,string:"every year"}});
  return {master,occurrence,recurring,input:intent({action:"flatten",eventId:occurrence.id,scope:"future"})};
}
test("explicit flatten keeps the selected yearly occurrence and caps historical master",async t=>{
  const f=flattenFixture(), h=harness(t,{events:[f.master,f.occurrence],tasks:[f.recurring]});
  const result=await h.execute(f.input);
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  assert.equal(h.taskMap.get("task").due.is_recurring,undefined);
  const mapping=h.mappingMap.get("task"), standalone=h.eventMap.get(mapping.eventId);
  assert.equal(standalone.start.date,"2027-08-16");
  assert.equal(standalone.recurrence,undefined);
  assert.equal(standalone.recurringEventId,undefined);
  assert.equal(h.eventMap.get(f.master.id).recurrence[0],"RRULE:FREQ=YEARLY;UNTIL=20270815");
  assert.equal(h.eventMap.get(f.master.id).extendedProperties.shared.syncHistoryOnly,"true");
  assert.equal(h.recurrences.size,0);
  assert.equal(h.ownerMappingMap.get("task").eventId,mapping.eventId);
});

for (const boundary of ["master","standalone","task","mapping"]) test(`flatten resumes a lost ${boundary} acknowledgement without duplicates`,async t=>{
  const f=flattenFixture(), h=harness(t,{events:[f.master,f.occurrence],tasks:[f.recurring]});
  const provider=boundary==="task"?h.clients.todoist:boundary==="mapping"?StateRepository.prototype:h.clients.calendar;
  const method=boundary==="master"?"upsertEventIfUnchanged":boundary==="standalone"?"createRepairEventOnce":boundary==="task"?"upsertTask":"commitFlattenMapping";
  const original=provider[method];let lost=false;
  provider[method]=async function(...args){const result=await original.apply(this,args);if(!lost){lost=true;throw new Error("Lost acknowledgement");}return result;};
  t.after(()=>{provider[method]=original;});
  const first=await h.execute(f.input);
  assert.equal(first.status,"needs_review",JSON.stringify(first));
  const result=await h.engine.execute("repair");
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  assert.equal(h.writes.filter(w=>w[0]==="create-event").length,1);
  assert.equal(h.writes.filter(w=>w[0]==="task").length,1);
  assert.equal(h.mappingMap.size,1);
});

test("flatten transfers a deleted mirror mapping and preserves unrelated historical standalone",async t=>{
  const f=flattenFixture(), history=event("unrelated-history",{start:{date:"2026-08-16"},end:{date:"2026-08-17"}});
  const previous={profile:"home",taskId:"deleted-mirror",eventId:f.occurrence.id,recurrenceOwner:"calendar",seriesId:"series",masterEventId:f.master.id,activeInstanceId:f.occurrence.id,updatedAt:"version-1"};
  const h=harness(t,{events:[{...f.master,iCalUID:"series"},f.occurrence,history],tasks:[{...f.recurring,due:{date:"2027-08-16"}}],mappings:[previous],recurrence:{...previous,owner:"calendar"}});
  const result=await h.execute(f.input);
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  assert.equal(h.mappingMap.has("deleted-mirror"),false);
  assert.equal(h.ownerMappingMap.has("deleted-mirror"),false);
  assert.equal(h.recurrences.size,0);
  assert.deepEqual(h.eventMap.get(history.id),history);
});

test("flatten refuses unsupported rules, overridden occurrences and resolved cases",async t=>{
  const f=flattenFixture(), h=harness(t,{events:[{...f.master,recurrence:["RRULE:FREQ=YEARLY;COUNT=4"]},f.occurrence],tasks:[f.recurring]});
  await assert.rejects(()=>h.engine.preview(actor,f.input),/YEARLY|COUNT/);
  h.eventMap.set(f.master.id,f.master);
  h.clients.calendar.listExplicitSeriesExceptions=async()=>[{...f.occurrence,summary:"Exception"}];
  await assert.rejects(()=>h.engine.preview(actor,f.input),/exceptions/);
  h.clients.calendar.listExplicitSeriesExceptions=async()=>[];
  h.engine.store.getCase=async()=>({id:"case",profile:"home",status:"resolved"});
  await assert.rejects(()=>h.engine.preview(actor,f.input),/unresolved/);
  assert.deepEqual(h.writes,[]);
});

test("flatten first occurrence removes recurrence in place and preserves unrelated metadata",async t=>{
  const f=flattenFixture();f.master.start={date:"2027-08-16"};f.master.end={date:"2027-08-17"};
  f.master.extendedProperties={private:{other:"private"},shared:{custom:"retained",syncAnotherApp:"retained",taskId:"task",syncRecurrenceOwner:"todoist"}};
  const h=harness(t,{events:[f.master,f.occurrence],tasks:[f.recurring]});
  const result=await h.execute(f.input);
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  const stored=h.eventMap.get(f.master.id);
  assert.deepEqual(stored.recurrence,[]);
  assert.equal(stored.extendedProperties.private.other,"private");
  assert.equal(stored.extendedProperties.shared.syncAnotherApp,"retained");
  assert.equal(h.mappingMap.get("task").eventId,f.master.id);
  assert.equal(h.writes.filter(w=>w[0]==="create-event").length,0);
});

test("flatten detaches a stale cancelled standalone mapping without changing that provider object",async t=>{
  const f=flattenFixture(), cancelled=event("cancelled-old",{status:"cancelled"});
  const old={profile:"home",taskId:"task",eventId:cancelled.id,updatedAt:"old-version"};
  const h=harness(t,{events:[f.master,f.occurrence,cancelled],tasks:[f.recurring],mappings:[old]});
  const result=await h.execute(f.input);
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  assert.deepEqual(h.eventMap.get(cancelled.id),cancelled);
  assert.equal(h.eventMappingMap.has(`home:${cancelled.id}`),false);
  assert.notEqual(h.mappingMap.get("task").eventId,cancelled.id);
});

test("flatten refuses provider edits after cap and retains its recovery barriers",async t=>{
  const f=flattenFixture(),h=harness(t,{events:[f.master,f.occurrence],tasks:[f.recurring]});
  const write=h.clients.calendar.upsertEventIfUnchanged;
  h.clients.calendar.upsertEventIfUnchanged=async(...args)=>{await write(...args);h.eventMap.get(f.master.id).summary="External edit";throw new Error("Lost response");};
  assert.equal((await h.execute(f.input)).status,"needs_review");
  const resumed=await h.engine.execute("repair");
  assert.equal(resumed.status,"needs_review");
  assert.equal(h.eventMap.get(f.master.id).summary,"External edit");
  assert.equal(h.controlsMap.get("home:todoist:task").activeRepair,"repair");
  assert.equal(h.writes.filter(w=>w[0]==="create-event").length,0);
});

for (const firstOccurrence of [false,true]) test(`flatten remains stable across delayed Calendar instance and Todoist notifications (in-place: ${firstOccurrence})`,async t=>{
  const f=flattenFixture();if(firstOccurrence){f.master.start={date:"2027-08-16"};f.master.end={date:"2027-08-17"};}
  const h=harness(t,{events:[f.master,f.occurrence],tasks:[f.recurring]});
  assert.equal((await h.execute(f.input)).status,"succeeded");
  const mapped=clone(h.mappingMap.get("task")), before=h.writes.length;
  h.clients.calendar.listDelta=async()=>({items:[f.occurrence]});
  await new Synchronizer(new StateRepository(),undefined,async()=>h.clients).process({id:"delayed-calendar",kind:"calendar",profile:"home",mode:"aws",receivedAt:"2026-10-23T14:00:00Z",headers:{},body:""});
  await new Synchronizer(new StateRepository(),undefined,async()=>h.clients).process({id:"delayed-task",kind:"todoist",profile:"home",mode:"aws",headers:{},body:JSON.stringify({event_name:"item:updated",event_data:f.recurring})});
  assert.deepEqual(h.mappingMap.get("task"),mapped);
  assert.equal(h.writes.length,before);
});

test("flatten keeps an explicitly unchanged historical one-off byte-for-byte and fences its stale shared task link",async t=>{
  const f=flattenFixture(),history=event("linked-history",{summary:"Birthday",description:"",start:{date:"2026-08-16"},end:{date:"2026-08-17"},extendedProperties:{shared:{taskId:"task"}}});
  const h=harness(t,{events:[f.master,f.occurrence,history],tasks:[f.recurring]});
  const result=await h.execute({...f.input,leftovers:{"home:calendar:linked-history":"unchanged"}});
  assert.equal(result.status,"succeeded",JSON.stringify(result));
  const mapped=clone(h.mappingMap.get("task")), before=h.writes.length;
  h.clients.calendar.listDelta=async()=>({items:[history]});
  await new Synchronizer(new StateRepository(),undefined,async()=>h.clients).process({id:"history-delta",kind:"calendar",profile:"home",mode:"aws",headers:{},body:""});
  assert.deepEqual(h.eventMap.get(history.id),history);
  assert.deepEqual(h.mappingMap.get("task"),mapped);
  assert.equal(h.writes.length,before);
});

test("flatten blocks another live task named by the series even without a mapping",async t=>{
  const f=flattenFixture();f.master.extendedProperties={shared:{taskId:"another-live-task"}};
  const h=harness(t,{events:[f.master,f.occurrence],tasks:[f.recurring,task("another-live-task")]});
  await assert.rejects(()=>h.engine.preview(actor,f.input),/another live Todoist task/);
  assert.deepEqual(h.writes,[]);
});

test("an explicit Todoist-only disposition survives repeat snapshot and webhook projection and a cancelled stray counterpart",async t=>{
  const h=harness(t,{events:[event("history",{start:{date:"2026-03-01"},end:{date:"2026-03-08"}})],tasks:[task("current",{due:{date:"2027-03-01"}})]});
  const before=clone(h.eventMap.get("history"));
  const result=await h.execute(intent({action:"exclude",taskId:"current",eventId:undefined,leftovers:{}}));
  assert.equal(result.status,"succeeded");
  assert.equal(h.controlsMap.get("home:todoist:current").excluded,true);
  const controls=new SyncControls();
  controls.control=async ref=>h.controlsMap.get(refKey(ref));
  t.mock.method(ReviewStore.prototype,"get",async()=>undefined);
  t.mock.method(StateRepository.prototype,"syncBlocked",(profile,ids)=>controls.blocked(profile,ids));
  const state=new StateRepository(), reconciler=new SnapshotReconciler(state,async()=>h.clients);
  const synchronizer=new Synchronizer(state,undefined,async()=>h.clients);
  for(let run=0;run<3;run++) {
    assert.equal(await reconciler.reconcileUnmappedTask("home",h.taskMap.get("current"),h.clients),"blocked");
    await synchronizer.process({id:`repeat-${run}`,kind:"todoist",profile:"home",mode:"aws",headers:{},body:JSON.stringify({event_name:"item:updated",event_data:h.taskMap.get("current")})});
  }
  h.mappingMap.set("current",{profile:"home",taskId:"current",eventId:"stray"});
  h.eventMappingMap.set("home:stray",{profile:"home",taskId:"current",eventId:"stray"});
  h.clients.calendar.listDelta=async()=>({items:[event("stray",{status:"cancelled",extendedProperties:{shared:{taskId:"current"}}})]});
  await synchronizer.process({id:"delete-stray",kind:"calendar",profile:"home",mode:"aws",headers:{},body:""});
  assert.deepEqual(h.taskMap.get("current"),task("current",{due:{date:"2027-03-01"}}));
  assert.deepEqual(h.eventMap.get("history"),before);
  assert.deepEqual(h.writes,[]);
  assert.ok(h.calls.some(call=>call[1]==="calendar_event_sync_control_blocked"));
});

test("Todoist-only flatten keeps the selected due date, excludes projection, and preserves historical Calendar bytes",async t=>{
  const annual=task("annual-task",{content:"Write letter for Gabriel and Lennox",due:{date:"2027-03-01",is_recurring:true,string:"every year"}});
  const history=event("history-event",{summary:"Gabriel and Lennox letter",description:"Historical note",start:{date:"2026-03-01"},end:{date:"2026-03-09"}});
  const h=harness(t,{events:[history],tasks:[annual]}),before=clone(h.eventMap.get(history.id));
  const result=await h.execute(intent({action:"todoist-only",taskId:annual.id,eventId:history.id,winner:"none",scope:"future"}));
  assert.equal(result.status,"succeeded",result.error);
  assert.deepEqual(h.taskMap.get(annual.id).due,{date:"2027-03-01"});
  assert.equal(h.controlsMap.get(`home:todoist:${annual.id}`).excluded,true);
  assert.equal(h.controlsMap.get(`home:calendar:${history.id}`).excluded,true);
  assert.equal(h.mappingMap.size,0);
  assert.deepEqual(h.eventMap.get(history.id),before,"the historical Calendar item remains byte-for-byte unchanged");
  assert.deepEqual(h.writes,[ ["task",annual.id] ],"no Calendar counterpart or metadata write is made");

  const controls=new SyncControls();
  controls.control=async ref=>h.controlsMap.get(refKey(ref));
  t.mock.method(ReviewStore.prototype,"get",async()=>undefined);
  t.mock.method(StateRepository.prototype,"syncBlocked",(profile,ids)=>controls.blocked(profile,ids));
  const state=new StateRepository(),reconciler=new SnapshotReconciler(state,async()=>h.clients);
  const synchronizer=new Synchronizer(state,undefined,async()=>h.clients);
  for(let run=0;run<3;run++) {
    assert.equal(await reconciler.reconcileUnmappedTask("home",h.taskMap.get(annual.id),h.clients),"blocked");
    await synchronizer.process({id:`todoist-only-${run}`,kind:"todoist",profile:"home",mode:"aws",headers:{},body:JSON.stringify({event_name:"item:updated",event_data:h.taskMap.get(annual.id)})});
    assert.equal(h.writes.length,1,"Todoist updates stay excluded from projection");
    await synchronizer.process({id:`history-${run}`,kind:"calendar",profile:"home",mode:"aws",headers:{},body:""});
    assert.equal(h.writes.length,1,"the standalone Calendar history does not import a new Todoist task");
  }
  assert.deepEqual(h.taskMap.get(annual.id).due,{date:"2027-03-01"});
  assert.deepEqual(h.eventMap.get(history.id),before);
  assert.deepEqual(h.writes,[ ["task",annual.id] ],"repeat reconciliation and provider notifications create no counterpart");
});

test("Todoist-only flatten rejects stale links or recurrence ownership before writes",async t=>{
  const annual=task("annual-task",{due:{date:"2027-03-01",is_recurring:true,string:"every year"}});
  const history=event("history-event",{start:{date:"2026-03-01"},end:{date:"2026-03-09"},extendedProperties:{shared:{taskId:annual.id}}});
  const h=harness(t,{events:[history],tasks:[annual]});
  await assert.rejects(h.engine.preview(actor,intent({action:"todoist-only",taskId:annual.id,eventId:history.id,scope:"future"})),/no mapping, recurrence ownership, or stale Calendar task identity/);
  assert.deepEqual(h.writes,[]);
});

test("explicit Calendar projection deletion retains the exact Todoist task and fences webhook/reconciliation recreation",async t=>{
  const current=task("keep-task"), projection=event("projection",{extendedProperties:{shared:{taskId:current.id}}});
  const mapping={profile:"home",taskId:current.id,eventId:projection.id};
  const h=harness(t,{events:[projection],tasks:[current],mappings:[mapping]});
  const before=clone(h.taskMap.get(current.id));
  const result=await h.execute(intent({action:"todoist-only-delete-calendar",taskId:current.id,eventId:projection.id,scope:"occurrence"}));
  assert.equal(result.status,"succeeded",result.error);
  assert.deepEqual(h.taskMap.get(current.id),before,"the exact Todoist item is retained without a provider write");
  assert.equal(h.eventMap.has(projection.id),false);
  assert.equal(h.mappingMap.size,0);
  assert.equal(h.controlsMap.get(`home:todoist:${current.id}`).excluded,true);
  assert.equal(h.controlsMap.get(`home:calendar:${projection.id}`).excluded,true);
  assert.equal(h.controls.rejected.has(`home:${current.id}:${projection.id}`),true);
  assert.deepEqual(h.writes,[["delete-event",projection.id]]);

  const controls=new SyncControls();
  controls.control=async ref=>h.controlsMap.get(refKey(ref));
  t.mock.method(ReviewStore.prototype,"get",async()=>undefined);
  t.mock.method(StateRepository.prototype,"syncBlocked",(profile,ids)=>controls.blocked(profile,ids));
  const state=new StateRepository(),reconciler=new SnapshotReconciler(state,async()=>h.clients);
  const synchronizer=new Synchronizer(state,undefined,async()=>h.clients);
  h.clients.calendar.listDelta=async()=>({items:[{...projection,status:"cancelled"}]});
  for(let run=0;run<3;run++) {
    assert.equal(await reconciler.reconcileUnmappedTask("home",h.taskMap.get(current.id),h.clients),"blocked");
    await synchronizer.process({id:`calendar-delete-repeat-${run}`,kind:"calendar",profile:"home",mode:"aws",headers:{},body:""});
    await synchronizer.process({id:`todoist-update-repeat-${run}`,kind:"todoist",profile:"home",mode:"aws",headers:{},body:JSON.stringify({event_name:"item:updated",event_data:h.taskMap.get(current.id)})});
  }
  assert.deepEqual(h.taskMap.get(current.id),before);
  assert.equal(h.eventMap.has(projection.id),false);
  assert.deepEqual(h.writes,[["delete-event",projection.id]],"repeat webhook and snapshot paths never recreate the Calendar projection");
});

test("closed case fresh preview rejects stale Calendar IDs and accepts the current exact mapping",async t=>{
  const current=task("keep-task"), projection=event("current-projection"), stale=event("stale-projection");
  const h=harness(t,{events:[projection],tasks:[current],mappings:[{profile:"home",taskId:current.id,eventId:projection.id}],caseStatus:"resolved"});
  h.engine.store.getCase=async()=>({id:"case",profile:"home",status:"resolved"});
  await assert.rejects(h.engine.preview(actor,intent({action:"todoist-only-delete-calendar",taskId:current.id,eventId:stale.id})),/exact current standalone mapping/);
  const fresh=await h.engine.preview(actor,intent({action:"todoist-only-delete-calendar",taskId:current.id,eventId:projection.id}));
  assert.deepEqual(fresh.intent.eventId,projection.id);
  h.operations.set("fresh-exact-preview",{id:"fresh-exact-preview",status:"queued",steps:{},preview:fresh});
  const applied=await h.engine.execute("fresh-exact-preview");
  assert.equal(applied.status,"succeeded",applied.error);
  assert.deepEqual(h.writes,[["delete-event",projection.id]]);
});

test("conditional Calendar deletion failure retains Todoist and does not detach its exact mapping",async t=>{
  const current=task("keep-task"),projection=event("projection");
  const mapping={profile:"home",taskId:current.id,eventId:projection.id};
  const h=harness(t,{events:[projection],tasks:[current],mappings:[mapping]});
  const beforeTask=clone(h.taskMap.get(current.id)),beforeEvent=clone(h.eventMap.get(projection.id));
  const preview=await h.engine.preview(actor,intent({action:"todoist-only-delete-calendar",taskId:current.id,eventId:projection.id}));
  h.operations.set("conditional-failure",{id:"conditional-failure",status:"queued",steps:{},preview});
  h.clients.calendar.deleteEventIfUnchanged=async()=>{throw Object.assign(new Error("Precondition failed"),{status:412});};
  const result=await h.engine.execute("conditional-failure");
  assert.notEqual(result.status,"succeeded");
  assert.deepEqual(h.taskMap.get(current.id),beforeTask);
  assert.deepEqual(h.eventMap.get(projection.id),beforeEvent);
  assert.deepEqual(h.mappingMap.get(current.id),mapping,"conditional mismatch does not detach the still-live mapping");
  assert.deepEqual(h.writes,[]);
});

test("lost conditional-delete acknowledgement resumes from exact absence without deleting Todoist",async t=>{
  const current=task("keep-task"),projection=event("projection");
  const mapping={profile:"home",taskId:current.id,eventId:projection.id};
  const h=harness(t,{events:[projection],tasks:[current],mappings:[mapping]});
  const beforeTask=clone(h.taskMap.get(current.id));
  const preview=await h.engine.preview(actor,intent({action:"todoist-only-delete-calendar",taskId:current.id,eventId:projection.id}));
  h.operations.set("lost-delete-ack",{id:"lost-delete-ack",status:"queued",steps:{},preview});
  let first=true;
  h.clients.calendar.deleteEventIfUnchanged=async(id,etag)=>{
    assert.equal(h.eventMap.get(id)?.etag,etag);
    h.eventMap.delete(id);
    if(first){first=false;throw new Error("Calendar committed deletion but response was lost");}
  };
  const failed=await h.engine.execute("lost-delete-ack");
  assert.notEqual(failed.status,"succeeded");
  assert.equal(h.operations.get("lost-delete-ack").steps[`delete-calendar-projection:${projection.id}`].status,"running");
  const resumed=await h.engine.execute("lost-delete-ack");
  assert.equal(resumed.status,"succeeded",resumed.error);
  assert.deepEqual(h.taskMap.get(current.id),beforeTask);
  assert.equal(h.eventMap.has(projection.id),false);
  assert.equal(h.mappingMap.size,0);
});

test("completed Calendar deletion resumes after later mapping cleanup failure",async t=>{
  const current=task("keep-task"),projection=event("projection");
  const mapping={profile:"home",taskId:current.id,eventId:projection.id};
  const h=harness(t,{events:[projection],tasks:[current],mappings:[mapping]});
  const preview=await h.engine.preview(actor,intent({action:"todoist-only-delete-calendar",taskId:current.id,eventId:projection.id}));
  h.operations.set("cleanup-after-delete",{id:"cleanup-after-delete",status:"queued",steps:{},preview});
  const originalDeleteMapping=StateRepository.prototype.deleteMapping;
  let failCleanup=true;
  StateRepository.prototype.deleteMapping=async function(value) {
    if(failCleanup){failCleanup=false;throw new Error("temporary mapping cleanup failure");}
    return originalDeleteMapping.call(this,value);
  };
  t.after(()=>{StateRepository.prototype.deleteMapping=originalDeleteMapping;});
  const failed=await h.engine.execute("cleanup-after-delete");
  assert.notEqual(failed.status,"succeeded");
  assert.equal(h.eventMap.has(projection.id),false);
  assert.equal(h.operations.get("cleanup-after-delete").steps[`delete-calendar-projection:${projection.id}`].status,"done");
  assert.deepEqual(h.mappingMap.get(current.id),mapping);
  const resumed=await h.engine.execute("cleanup-after-delete");
  assert.equal(resumed.status,"succeeded",resumed.error);
  assert.equal(h.mappingMap.size,0);
  assert.deepEqual(h.writes,[["delete-event",projection.id]],"resume trusts the recorded exact deletion and does not repeat it");
});
