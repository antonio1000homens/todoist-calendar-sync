import assert from "node:assert/strict";
import test from "node:test";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ReviewEngine, snapshotFingerprint } from "../dist/review-engine.js";
import { SyncControls } from "../dist/review-store.js";
import { GoogleCalendar, Todoist } from "../dist/providers.js";

test("an exclusion control still blocks requests after the repair barrier is released", async () => {
  const controls = new SyncControls();
  controls.control = async () => ({ excluded: true, fencedAt: "2026-10-21T12:00:00Z" });
  controls.rejected = async () => false;
  assert.equal(await controls.blocked("home", { taskId: "task" }), true);
  assert.equal(await controls.blocked("home", { eventId: "event" }), true);
  assert.equal(await controls.blocked("home", { taskId: "task" }, "different-operation"), true);
});

test("only the repair that holds the barrier may work on an excluded entity", async () => {
  const controls = new SyncControls();
  controls.control = async () => ({ excluded: true, activeRepair: "repair" });
  controls.rejected = async () => false;
  assert.equal(await controls.blocked("home", { taskId: "task" }, "repair"), false);
});

test("a blocked webhook records a pending refresh without taking over the repair", async (t) => {
  const commands = [];
  t.mock.method(documentClient, "send", async (command) => { commands.push(command.input); return {}; });
  const controls = new SyncControls();
  controls.control = async () => ({ activeRepair: "repair" });
  process.env.STATE_TABLE_NAME ||= "test-state";
  assert.equal(await controls.blocked("home", { eventId: "event" }), true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].Key.pk, "SYNC_CONTROL#home:calendar:event");
  assert.equal(commands[0].UpdateExpression, "SET pendingRefresh = :true, pendingRefreshAt = :at");
  assert.match(commands[0].ExpressionAttributeValues[":at"], /^[0-9a-f-]{36}$/i);
});

test("pending refresh cleanup is conditional on the captured update version and released barrier", async (t) => {
  const commands=[];
  t.mock.method(documentClient,"send",async command=>{commands.push(command.input);return {};});
  process.env.STATE_TABLE_NAME ||= "test-state";
  await new SyncControls().clearPendingRefresh([{profile:"home",side:"todoist",id:"task",pendingRefreshAt:"refresh-version"}]);
  assert.equal(commands.length,1);
  assert.equal(commands[0].UpdateExpression,"REMOVE pendingRefresh, pendingRefreshAt");
  assert.match(commands[0].ConditionExpression,/pendingRefreshAt = :at/);
  assert.match(commands[0].ConditionExpression,/attribute_not_exists\(activeRepair\)/);
  assert.equal(commands[0].ExpressionAttributeValues[":at"],"refresh-version");
});

test("a stale repair preview releases its acquired barriers without writing to providers", async () => {
  const ref = { profile: "home", side: "todoist", id: "task" };
  const snapshots = [{ ref, object: { id: "task", content: "Original", updated_at: "version-1" } }];
  const operation = {
    id: "repair", status: "queued", steps: {},
    preview: { intent: { caseId: "case", profile: "home" }, case: {}, snapshots, fingerprint: snapshotFingerprint(snapshots) },
  };
  const saved = [];
  const calls = [];
  const store = {
    async getOperation() { return operation; },
    async saveOperation(value) { saved.push(structuredClone(value)); },
    async updateCase() {},
  };
  const engine = new ReviewEngine(store, {}, async () => { throw new Error("Provider writes must not run"); }, {
    async claim(refs) { calls.push(["claim", refs]); },
    async releaseUnapplied(refs, operationId) { calls.push(["release-unapplied", refs, operationId]); },
    async pendingRefreshRefs() { return []; },
  });
  engine.collect = async () => {
    assert.equal(calls[0]?.[0], "claim");
    return [{ ref, object: { ...snapshots[0].object, content: "Changed", updated_at: "version-2" } }];
  };
  const result = await engine.execute("repair");
  assert.equal(result.status, "failed");
  assert.match(result.error, /changed after preview/);
  assert.deepEqual(result.steps, {});
  assert.equal(saved.length, 1);
  assert.deepEqual(calls, [["claim", [ref]], ["release-unapplied", [ref], "repair"]]);
  assert.equal(result.abandoned,true);
});

test("provider modification versions and exclusions invalidate repair previews", () => {
  const initial = [{ ref: { profile: "home", side: "calendar", id: "event" }, object: { id: "event", updated: "version-1" } }];
  const fingerprint = snapshotFingerprint(initial);
  assert.notEqual(snapshotFingerprint([{ ...initial[0], object: { id: "event", updated: "version-2" } }]), fingerprint);
  assert.notEqual(snapshotFingerprint([{ ...initial[0], control: { excluded: true } }]), fingerprint);
  assert.equal(snapshotFingerprint([{ ...initial[0], control: { activeRepair: "own-operation" } }]), fingerprint);
});

test("Create counterpart previews include the selected source without requiring a leftover disposition", async () => {
  const saved = [];
  const engine = new ReviewEngine({
    async getCase() { return { id: "case", profile: "home" }; },
    async putPreview(preview) { saved.push(preview); },
  });
  engine.collect = async () => [{ ref: { profile: "home", side: "todoist", id: "task" }, object: { id: "task", content: "Task", due:{date:"2099-12-18"} } }];
  const preview = await engine.preview({ subject: "operator", email: "operator@example.test" }, {
    caseId: "case", profile: "home", action: "create", taskId: "task", winner: "none", scope: "occurrence", leftovers: {},
  });
  assert.ok(preview.changes.some(change => change.includes("Create a new Calendar counterpart from Todoist task task (Task)")));
  assert.equal(saved.length, 1);
});

test("relinking cannot silently discard a displaced live counterpart", async () => {
  const engine = new ReviewEngine({ async getCase() { return { id: "case", profile: "home" }; } });
  engine.collect = async () => [
    { ref: { profile: "home", side: "todoist", id: "task" }, object: { id: "task", content: "Task",due:{date:"2099-12-18"} } },
    { ref: { profile: "home", side: "calendar", id: "chosen" }, object: { id: "chosen", summary: "Chosen",status:"confirmed" } },
    { ref: { profile: "home", side: "calendar", id: "displaced" }, object: { id: "displaced", summary: "Displaced" } },
  ];
  await assert.rejects(engine.preview({ subject: "operator", email: "operator@example.test" }, {
    caseId: "case", profile: "home", action: "link", taskId: "task", eventId: "chosen", winner: "todoist", scope: "occurrence", leftovers: {},
  }), /Choose Create counterpart or Exclude for home:calendar:displaced/);
});

test("Calendar repair creation requires a deterministic ID and preserves unrelated metadata", async () => {
  const calendar = new GoogleCalendar({}, "test-calendar");
  const writes = [];
  calendar.upsertEvent = async (event) => { writes.push(event); return event; };
  await assert.rejects(calendar.createRepairEventOnce({ id: "" }, "repair"), /deterministic event ID/);
  assert.equal(writes.length, 0);
  const result = await calendar.createRepairEventOnce({ id: "event", extendedProperties: { shared: { unrelated: "retained" }, private: { privateData: "retained" } } }, "repair");
  assert.deepEqual(result.extendedProperties, { shared: { unrelated: "retained", syncRepairId: "repair" }, private: { privateData: "retained" } });
});

test("Calendar creation retries recover only the event belonging to the same repair", async () => {
  const calendar = new GoogleCalendar({}, "test-calendar");
  calendar.upsertEvent = async () => { throw Object.assign(new Error("Already exists"), { status: 409 }); };
  const owned = { id: "event", status: "confirmed", extendedProperties: { shared: { syncRepairId: "repair" } } };
  calendar.getEvent = async () => owned;
  assert.deepEqual(await calendar.createRepairEventOnce({ id: "event" }, "repair"), owned);
  await assert.rejects(calendar.createRepairEventOnce({ id: "event" }, "another-repair"), /owned by another/);
  calendar.getEvent = async () => ({ ...owned, status: "cancelled" });
  await assert.rejects(calendar.createRepairEventOnce({ id: "event" }, "repair"), /owned by another/);
});

test("Todoist counterpart creation reuses the request ID only for the same repair step", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init);
    return Response.json({ id: "task", content: "Task" });
  });
  const todoist = new Todoist("test-token");
  const task = { content: "Task", project_id: "test-project" };
  await todoist.createTaskOnce(task, "repair:event");
  await todoist.createTaskOnce(task, "repair:event");
  await todoist.createTaskOnce(task, "repair:another-event");
  const ids = requests.map(request => request.headers.get("X-Request-Id"));
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.equal(JSON.parse(requests[0].body).project_id, "test-project");
});


test("yearly repair preview names the master, occurrence, stale deleted task and same-title standalone", async () => {
  const yearly = { id:"yearly-current",content:"Write letter for Gabriel and Lennox",
    due:{date:"2027-03-01",string:"every year",is_recurring:true} };
  const master = { id:"annual-master",summary:yearly.content,status:"confirmed",
    start:{date:"2027-03-01"},end:{date:"2027-03-08"},recurrence:["RRULE:FREQ=YEARLY"] };
  const occurrence = { id:"annual-2027",summary:yearly.content,status:"confirmed",
    recurringEventId:master.id,originalStartTime:{date:"2027-03-01"},
    start:{date:"2027-03-01"},end:{date:"2027-03-08"} };
  const standalone = { id:"standalone-2026",summary:yearly.content,status:"confirmed",
    start:{date:"2026-03-01"},end:{date:"2026-03-08"} };
  const ref=(side,id)=>({profile:"home",side,id});
  const snapshots=[
    {ref:ref("todoist",yearly.id),object:yearly},
    {ref:ref("todoist","legacy-404"),object:null,mapping:{profile:"home",taskId:"legacy-404",eventId:master.id}},
    {ref:ref("calendar",master.id),object:master,calendarProjectionId:occurrence.id,
      mapping:{profile:"home",taskId:"legacy-404",eventId:master.id}},
    {ref:ref("calendar",occurrence.id),object:occurrence},
    {ref:ref("calendar",standalone.id),object:standalone},
  ];
  const engine=new ReviewEngine({
    async getCase() { return {id:"case",profile:"home"}; },
    async putPreview() {},
  });
  engine.collect=async()=>snapshots;
  const input={caseId:"case",profile:"home",action:"link",taskId:yearly.id,eventId:master.id,
    winner:"calendar",owner:"calendar",scope:"series",leftovers:{"home:calendar:standalone-2026":"exclude"}};
  const preview=await engine.preview({subject:"owner",email:"owner@example.test"},input);
  assert.equal(preview.itemPlan.length,5);
  const plan=id=>preview.itemPlan.find(row=>row.ref.id===id);
  assert.match(plan("standalone-2026").operation,/Exclude/);
  assert.match(plan("standalone-2026").result,/displaced mapping/);
  assert.match(plan("annual-2027").operation,/active Calendar occurrence/);
  assert.match(plan("annual-master").result,/yearly-current/);
  assert.match(plan("legacy-404").operation,/Missing provider object/);
  assert.equal(preview.intent.scope,"series");
  assert.deepEqual(preview.snapshots.map(s=>s.ref.id),snapshots.map(s=>s.ref.id));
});

test("backend blocks stale, unknown and unidentified Calendar disposition rows", async () => {
  const engine=new ReviewEngine({
    async getCase() { return {id:"case",profile:"home"}; },
    async putPreview() { assert.fail("Ambiguous disposition must not be saved"); },
  });
  engine.collect=async()=>[
    {ref:{profile:"home",side:"todoist",id:"selected"},object:{id:"selected",content:"Task",due:{date:"2027-03-01"}}},
    {ref:{profile:"home",side:"calendar",id:"missing-date"},object:{id:"missing-date",summary:"Title",status:"confirmed"}},
    {ref:{profile:"home",side:"todoist",id:"stale"},object:null},
  ];
  const input={caseId:"case",profile:"home",action:"create",taskId:"selected",winner:"none",scope:"occurrence",leftovers:{}};
  const actor={subject:"owner",email:"owner@example.test"};
  for (const id of ["home:calendar:missing-date","home:todoist:stale","home:calendar:not-in-snapshots"]) {
    await assert.rejects(engine.preview(actor,{...input,leftovers:{[id]:"exclude"}}),
      /Cannot identify the live item|lacks a verified start or status/);
  }
});
