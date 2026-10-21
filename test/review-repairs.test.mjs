import assert from "node:assert/strict";
import test from "node:test";
import { profiles } from "../dist/config.js";
import { ReviewEngine } from "../dist/review-engine.js";
import { StateRepository } from "../dist/repository.js";
import { DynamoReconciliationStore } from "../dist/reconciliation.js";
import { CanonicalIdentityStore } from "../dist/canonical-identity.js";
import { Synchronizer } from "../dist/sync.js";
import { ReviewStore, SyncControls } from "../dist/review-store.js";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { todoistRecurrenceKey, todoistRecurrenceToRrule } from "../dist/todoist-recurrence.js";
import { ManualDecisionStore, ManualInterventionService } from "../dist/manual-intervention.js";

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

// Exercise the real preview/execute/provider conversion paths with in-memory
// provider and repository seams. Unexpected external calls fail these tests.
function harness(t, { events = [event()], tasks = [task()], mappings = [], recurrence, decision } = {}) {
  const eventMap = new Map(events.map(value => [value.id, clone(value)]));
  const taskMap = new Map(tasks.map(value => [value.id, clone(value)]));
  const mappingMap = new Map(mappings.map(value => [value.taskId, clone(value)]));
  const recurrences = new Map(recurrence ? [[recurrence.seriesId, clone(recurrence)]] : []);
  const controlsMap = new Map(), versions = new Map(), operations = new Map(), writes = [], calls = [], baselines = [];
  const taskRequests = new Map();
  const get = (map, id) => { if (!map.has(id)) throw Object.assign(new Error("Not found"), { status: 404 }); return clone(map.get(id)); };
  const stateMethods = {
    async getSyncToken() { return "sync-token"; },
    async getCompletedCalendarProjectionByEvent() { return undefined; },
    async getCalendarProjectionTombstone() { return undefined; },
    async putCalendarProjectionTombstone(...args) { calls.push(["tombstone",...args]); },
    async getMappingByTaskAnyProfile(id) { return clone(mappingMap.get(id)); },
    async getMappingByTask(profile, id) { const value = mappingMap.get(id); return value?.profile === profile ? clone(value) : undefined; },
    async getMappingByEvent(profile, id) { return clone([...mappingMap.values()].find(value => value.profile === profile && value.eventId === id)); },
    async getRecurrenceLink(_profile, id) { return clone(recurrences.get(id)); },
    async putRecurrenceLink(value) { recurrences.set(value.seriesId, clone(value)); },
    async deleteRecurrenceLink(_profile, id) { recurrences.delete(id); },
    async putMapping(value) { mappingMap.set(value.taskId, clone(value)); },
    async deleteMapping(value) { mappingMap.delete(value.taskId); },
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
    async claim(refs, id) { calls.push(["claim", clone(refs)]); for (const ref of refs) controlsMap.set(refKey(ref), { ...controlsMap.get(refKey(ref)), activeRepair: id }); },
    rejected: new Set(),
    async reject(profile, taskId, eventId) { this.rejected.add(`${profile}:${taskId}:${eventId}`); },
    async allow(profile, taskId, eventId) { this.rejected.delete(`${profile}:${taskId}:${eventId}`); },
    async exclude(ref, excluded) { controlsMap.set(refKey(ref), { ...controlsMap.get(refKey(ref)), excluded }); },
    async release(ref) { calls.push(["release", clone(ref)]); const value = controlsMap.get(refKey(ref)); delete value.activeRepair; },
  };
  const clients = {
    calendar: {
      async getEvent(id) { return get(eventMap, id); },
      async findByTodoistTaskId(taskId) { return clone([...eventMap.values()].find(value=>value.extendedProperties?.shared?.taskId===taskId)); },
      async listDelta() { return { items: clone([...eventMap.values()]) }; },
      async listInstances(id) { return clone([...eventMap.values()].filter(value => value.recurringEventId === id)); },
      async upsertEventIfUnchanged(value, id, etag) {
        assert.equal(eventMap.get(id)?.etag, etag);
        const next = { ...clone(value), id, etag: `etag-repair-${writes.length}` }; eventMap.set(id, next); writes.push(["event", id]); return clone(next);
      },
      async createRepairEventOnce(value,operationId) {
        if(eventMap.has(value.id))return get(eventMap,value.id);
        const next={...clone(value),status:"confirmed",etag:"created-etag",extendedProperties:{...value.extendedProperties,shared:{...value.extendedProperties?.shared,syncRepairId:operationId}}};
        eventMap.set(value.id,next); writes.push(["create-event", value.id]); return clone(next);
      },
      async upsertEvent() { assert.fail("Unexpected anonymous Calendar write"); },
    },
    todoist: {
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
    async getCase() { return { id: "case", profile: "home", decision }; },
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
        controlsMap.get(refKey(item.ref)).fencedAt = "2099-01-01T00:00:00Z";
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
  return { engine, execute, clients, eventMap, taskMap, mappingMap, recurrences, controls, controlsMap, versions, operations, writes, calls, baselines };
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

test("a move previews, claims, and verifies its existing destination Calendar projection",async t=>{
  const h=moveHarness(t),preview=await h.engine.preview(actor,h.input);
  assert.ok(preview.snapshots.some(s=>s.ref.profile==="work"&&s.ref.id==="destination"));
  assert.deepEqual(preview.snapshots.find(s=>s.ref.side==="todoist").destination,{profile:"work",eventId:"destination"});
  const result=await h.execute();assert.equal(result.status,"succeeded",result.error);
  assert.ok(h.calls.find(c=>c[0]==="claim")[1].some(ref=>ref.profile==="work"&&ref.id==="destination"));
  assert.equal(h.destinationEvents.get("destination").summary,"Portugal");
  assert.equal(h.mappingMap.get("task").profile,"work");assert.ok(!h.eventMap.has("event"));
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
  await assert.rejects(h.engine.preview(actor, input), /Choose Create counterpart or Exclude for home:todoist:task/);
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

test("rebinding a Calendar master clears rejection of the persisted task/instance pair", async (t) => {
  const h = harness(t, seriesFixture());
  const result = await h.execute(intent({ eventId: "master", owner: "calendar", winner: "calendar", scope: "series" }));
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(h.controls.rejected.has("home:task:active"), false);
  assert.deepEqual(result.verified, [{ profile: "home", taskId: "task", eventId: "active" }]);
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
