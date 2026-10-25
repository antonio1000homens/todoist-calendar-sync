import assert from "node:assert/strict";
import test from "node:test";
import { reconcileUnmappedCalendar, recurringTaskIdentityCandidates } from "../dist/calendar-reconciliation.js";
import { ReconciliationMutationBudget } from "../dist/mutation-budget.js";

function futureEvent(id, day, summary = `Event ${id}`) {
  return {
    id,
    status: "confirmed",
    summary,
    description: "",
    htmlLink: `https://calendar.example/${id}`,
    start: { date: `2099-01-${String(day).padStart(2, "0")}` },
    end: { date: `2099-01-${String(day + 1).padStart(2, "0")}` },
  };
}

function fakeState() {
  const mappings = [];
  const completedProjections = [];
  const audits = [];
  let mutations = 0;
  return {
    mappings,
    completedProjections,
    audits,
    get mutations() { return mutations; },
    async syncBlocked() { return false; },
    async mutationAllowed() { return true; },
    async getMappingByEvent(profile, eventId) { return mappings.find((mapping) => mapping.profile === profile && mapping.eventId === eventId); },
    async getMappingByTaskAnyProfile(taskId) { return mappings.find((mapping) => mapping.taskId === taskId); },
    async getCompletedCalendarProjectionByEvent(profile, eventId) { return completedProjections.find((item) => item.profile === profile && item.eventId === eventId); },
    async getRecurrenceLink() { return undefined; },
    async putMapping(mapping) { mappings.push(mapping); },
    async putRecurrenceLink() {},
    async recordMutation() { mutations += 1; },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
}

function fakeClients(events, initialTasks = []) {
  const tasks = initialTasks.map((task) => ({ ...task }));
  let created = 0;
  let comments = 0;
  let deletions = 0;
  let listInstancesCalls = 0;
  return {
    pair: {
      calendar: {
        async listDelta() { return { items: events, nextSyncToken: "snapshot-token-must-be-ignored" }; },
        async listInstances() { listInstancesCalls += 1; return []; },
      },
      todoist: {
        async listTasks() { return tasks; },
        async upsertTask(task) {
          created += 1;
          const createdTask = { id: `created-${created}`, project_id: "home-project", ...task };
          return createdTask;
        },
        async deleteTask(id) { deletions += 1; const index = tasks.findIndex(task => task.id === id); if (index >= 0) tasks.splice(index,1); },
        async findComment() { return undefined; },
        async upsertComment() { comments += 1; return { id: `comment-${comments}` }; },
      },
    },
    get created() { return created; },
    get comments() { return comments; },
    get deletions() { return deletions; },
    get tasks() { return tasks; },
    get listInstancesCalls() { return listInstancesCalls; },
  };
}

for (const [series,control] of [[false,"event"],[false,"task"],[false,"pair"],[true,"master"],[true,"instance"],[true,"task"],[true,"pair"]]) {
  test(`Calendar import respects ${control} controls for ${series ? "a series" : "a standalone event"}`,async()=>{
    const state=fakeState(),master=futureEvent("master",10,"Calendar item");
    if(series)master.recurrence=["RRULE:FREQ=WEEKLY"];
    const active={...futureEvent("active",10,"Calendar item"),recurringEventId:master.id,originalStartTime:{date:master.start.date}};
    const projection=series?active:master;
    const candidate={id:"candidate",content:projection.summary,description:"",due:{date:projection.start.date}};
    const clients=fakeClients([master],[candidate]);
    clients.pair.calendar.listInstances=async()=>[active];
    state.syncBlocked=async(_profile,ids)=>control==="task"?ids.taskId==="candidate":control==="pair"?ids.taskId==="candidate"&&ids.eventId===projection.id
      :ids.eventId===(control==="instance"?active.id:master.id);
    const summary=await reconcileUnmappedCalendar("home",state,async()=>clients.pair);
    assert.equal(summary.blocked,1);assert.equal(summary.imported,0);assert.equal(summary.rebound,0);
    assert.equal(state.mappings.length,0);assert.equal(clients.created,0);assert.equal(clients.comments,0);
  });
}

test("Calendar import rechecks a resolved pair after comment lookup before writing",async()=>{
  const state=fakeState(),source=futureEvent("event",10,"Calendar item");
  const clients=fakeClients([source],[{id:"candidate",content:source.summary,description:"",due:{date:source.start.date}}]);
  let blocked=false;
  state.syncBlocked=async(_profile,ids)=>blocked&&ids.taskId==="candidate";
  clients.pair.todoist.findComment=async()=>{blocked=true;return undefined;};
  const summary=await reconcileUnmappedCalendar("home",state,async()=>clients.pair);
  assert.equal(summary.blocked,1);assert.equal(state.mappings.length,0);assert.equal(clients.comments,0);
});

test("snapshot recovery imports one future unmapped Calendar event and binds it", async () => {
  const event = futureEvent("calendar-1", 10, "Recovered appointment");
  const state = fakeState();
  const clients = fakeClients([event]);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.imported, 1);
  assert.equal(summary.rebound, 0);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.providerMutations, 2);
  assert.equal(clients.created, 1);
  assert.equal(clients.comments, 1);
  assert.equal(state.mappings.length, 1);
  assert.equal(state.mappings[0].eventId, "calendar-1");
  assert.equal(state.mappings[0].taskId, "created-1");
  assert.equal(state.mutations, 2);
});

test("snapshot recovery creates one finite weekly Todoist recurrence when account and Calendar zones match", async () => {
  const master = {
    id: "finite-master", iCalUID: "finite-series", status: "confirmed", summary: "Task", description: "",
    start: { dateTime: "2026-11-04T14:00:00Z", timeZone: "Europe/London" },
    end: { dateTime: "2026-11-04T14:15:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const occurrences = [4, 11, 18, 25].map((day) => ({
    id: `finite-${day}`, status: "confirmed", summary: "Task", description: "",
    recurringEventId: master.id, iCalUID: master.iCalUID,
    originalStartTime: { dateTime: `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`, timeZone: "Europe/London" },
    start: { dateTime: `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`, timeZone: "Europe/London" },
    end: { dateTime: `2026-11-${String(day).padStart(2, "0")}T14:15:00Z`, timeZone: "Europe/London" },
  }));
  const state = fakeState();
  const tasks = [];
  const clients = {
    calendar: {
      async listDelta() { return { items: [master] }; },
      async listInstances() { return occurrences; },
      async getTimeZone() { return "Europe/London"; },
    },
    todoist: {
      async listTasks() { return tasks.map((task) => structuredClone(task)); },
      async getTimeZone() { return "Europe/London"; },
      async upsertTask(payload) {
        const task = { id: "one-task", project_id: "home-project", ...structuredClone(payload) };
        tasks.push(task);
        return structuredClone(task);
      },
      async deleteTask(id) { const index = tasks.findIndex((task) => task.id === id); if (index >= 0) tasks.splice(index, 1); },
      async findComment() { return undefined; },
      async upsertComment() { return { id: "comment" }; },
    },
  };
  const summary = await reconcileUnmappedCalendar("home", state, async () => clients);
  assert.equal(summary.imported, 1);
  assert.equal(summary.conflicts, 0);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].due.is_recurring, true);
  assert.equal(tasks[0].due.string, "every Wednesday at 2:00pm starting 4 Nov 2026 ending 25 Nov 2026");
  assert.equal(state.mappings.length, 1);
  assert.equal(state.mappings[0].taskId, "one-task");
  assert.equal(state.mappings[0].recurrenceOwner, "calendar");
});

test("snapshot recovery fails closed without creating a timed recurrence when Todoist and Calendar zones differ", async () => {
  const master = {
    id: "finite-master", iCalUID: "finite-series", status: "confirmed", summary: "Task", description: "",
    start: { dateTime: "2026-11-04T14:00:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
  };
  const occurrences = [4, 11, 18, 25].map((day) => ({
    id: `finite-${day}`, status: "confirmed", recurringEventId: master.id, iCalUID: master.iCalUID,
    originalStartTime: { dateTime: `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`, timeZone: "Europe/London" },
    start: { dateTime: `2026-11-${String(day).padStart(2, "0")}T14:00:00Z`, timeZone: "Europe/London" },
  }));
  const state = fakeState();
  let creates = 0;
  const clients = {
    calendar: { async listDelta() { return { items: [master] }; }, async listInstances() { return occurrences; } },
    todoist: {
      async listTasks() { return []; },
      async getTimeZone() { return "America/New_York"; },
      async upsertTask() { creates += 1; throw new Error("must not create"); },
      async findComment() { return undefined; },
      async upsertComment() { return { id: "comment" }; },
    },
  };
  const summary = await reconcileUnmappedCalendar("home", state, async () => clients);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.imported, 0);
  assert.equal(creates, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_recurrence_todoist_timezone_mismatch"));
});

test("snapshot recovery skips elapsed Calendar history and imports the future event", async () => {
  const historical = {
    id: "elapsed", status: "confirmed", summary: "Historical event", description: "",
    start: { date: "2000-01-01" }, end: { date: "2000-01-02" },
  };
  const future = futureEvent("future", 10, "Current appointment");
  const state = fakeState();
  const clients = fakeClients([historical, future]);
  clients.pair.calendar.getTimeZone = async () => "Europe/London";

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.imported, 1);
  assert.deepEqual(state.mappings.map((mapping) => mapping.eventId), ["future"]);
  assert.equal(clients.created, 1);
});

test("snapshot recovery ignores a retained completed Calendar projection", async () => {
  const event = futureEvent("calendar-completed", 10, "Completed appointment");
  const state = fakeState();
  state.completedProjections.push({
    profile: "home",
    taskId: "completed-task",
    eventId: event.id,
    completedAt: "2099-01-10T12:00:00Z",
  });
  const clients = fakeClients([event]);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.skipped, 1);
  assert.equal(summary.imported, 0);
  assert.equal(summary.rebound, 0);
  assert.equal(clients.created, 0);
  assert.equal(clients.comments, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_snapshot_completed_projection_ignored"));
});

test("snapshot recovery rechecks completion before importing an unmapped event", async () => {
  const event = futureEvent("calendar-completion-race", 10, "Race appointment");
  const state = fakeState();
  const marker = {
    profile: "home",
    taskId: "completed-task",
    eventId: event.id,
    completedAt: "2099-01-10T12:00:00Z",
  };
  let reads = 0;
  state.getCompletedCalendarProjectionByEvent = async () => {
    reads += 1;
    return reads === 1 ? undefined : marker;
  };
  const clients = fakeClients([event]);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(reads >= 2, true);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.imported, 0);
  assert.equal(clients.created, 0);
  assert.equal(clients.comments, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_snapshot_completed_projection_ignored" && entry.detail.recheckedBeforeMutation === true));
});

test("snapshot recovery treats multiple canonical Todoist matches as a conflict without mutation", async () => {
  const event = futureEvent("calendar-ambiguous", 11, "Same appointment");
  const matchingTask = {
    content: "Same appointment",
    description: "",
    project_id: "home-project",
    due: { date: "2099-01-11" },
  };
  const state = fakeState();
  const clients = fakeClients([event], [
    { id: "task-a", ...matchingTask },
    { id: "task-b", ...matchingTask },
  ]);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.conflicts, 1);
  assert.equal(summary.imported, 0);
  assert.equal(summary.providerMutations, 0);
  assert.equal(clients.created, 0);
  assert.equal(clients.comments, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_snapshot_unmapped_ambiguous"));
});

test("snapshot recovery never reuses one task for two canonical Calendar events", async () => {
  const first = futureEvent("calendar-first", 12, "Shared appointment");
  const second = futureEvent("calendar-second", 12, "Shared appointment");
  const state = fakeState();
  const clients = fakeClients([first, second]);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.imported, 1);
  assert.equal(summary.conflicts, 1);
  assert.equal(state.mappings.length, 1);
  assert.equal(state.mappings[0].eventId, "calendar-first");
  assert.equal(state.mappings[0].taskId, "created-1");
  assert.equal(clients.created, 1);
});

test("snapshot recovery will not bind a canonical task already owned by another event", async () => {
  const event = futureEvent("calendar-new", 13, "Bound appointment");
  const task = { id: "task-bound", content: "Bound appointment", description: "", project_id: "home-project", due: { date: "2099-01-13" } };
  const state = fakeState();
  state.mappings.push({ profile: "work", eventId: "calendar-existing", taskId: "task-bound" });
  const clients = fakeClients([event], [task]);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.conflicts, 1);
  assert.equal(summary.rebound, 0);
  assert.equal(clients.created, 0);
  assert.equal(state.mappings.length, 1);
});

test("snapshot recovery stops provider writes at the ten-mutation budget", async () => {
  const events = Array.from({ length: 8 }, (_, index) => futureEvent(`calendar-${index + 1}`, index + 1));
  const state = fakeState();
  const clients = fakeClients(events);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.providerMutations, 10);
  assert.equal(summary.imported, 5);
  assert.equal(summary.mutationCapReached, true);
  assert.equal(clients.created, 5);
  assert.equal(clients.comments, 5);
  assert.equal(state.mappings.length, 5);
  assert.equal(state.mutations, 10);
});

test("rejected worst-case reservation still keeps reconciliation pending", async () => {
  const event = futureEvent("calendar-reservation", 14, "Reservation appointment");
  const task = { id: "task-reservation", content: "Reservation appointment", description: "", project_id: "home-project", due: { date: "2099-01-14" } };
  const state = fakeState();
  const clients = fakeClients([event], [task]);
  clients.pair.todoist.findComment = async () => ({ id: "existing-comment" });
  const budget = new ReconciliationMutationBudget(10);
  budget.consume("todoist", "prior-writes", "home", 9);

  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair, budget);

  assert.equal(budget.used, 9);
  assert.equal(budget.exhausted, false);
  assert.equal(summary.mutationCapReached, true);
  assert.equal(summary.providerMutations, 0);
  assert.equal(state.mappings.length, 0);
  const exhausted = state.audits.find((entry) => entry.action === "calendar_snapshot_reconcile_mutation_budget_exhausted");
  assert.equal(exhausted.detail.eventId, event.id);
  assert.equal(exhausted.detail.reason, "mutation_budget_exhausted");
});

test("recurrence snapshot guard recognises a competing recurring Todoist identity", async () => {
  const master = { ...futureEvent("annual-master", 11, "Fotmob expiry £2.60"), recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1"] };
  const occurrence = { ...futureEvent("annual-master_20990111", 11, "Fotmob expiry £2.60"), recurringEventId: master.id };
  const original = {
    id: "original-yearly", content: "Fotmob expiry £2.60", description: "",
    project_id: "home-project", due: { date: "2099-01-11", is_recurring: true, string: "every year" },
  };
  assert.deepEqual(recurringTaskIdentityCandidates(occurrence, [original]), ["original-yearly"]);
  const state = fakeState();
  const clients = fakeClients([master], [original]);
  clients.pair.calendar.listInstances = async () => [occurrence];
  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);
  assert.equal(summary.conflicts, 1);
  assert.equal(clients.created, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some((entry) =>
    entry.action === "calendar_snapshot_recurring_identity_conflict"
    && entry.detail.candidateTaskIds.includes("original-yearly")));
});

test("recurrence snapshot guard trusts an exact shared task ID when title and start differ", async () => {
  const master = {
    ...futureEvent("ifttt-series", 15, "IFTTT renewal reminder"),
    recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1"],
  };
  const occurrence = {
    ...futureEvent("ifttt-series_20990115", 15, "IFTTT renewal reminder"),
    recurringEventId: master.id,
    extendedProperties: { shared: { taskId: "annual-task" } },
  };
  const annualTask = {
    id: "annual-task", content: "ifttt expire cancel auto-renew",
    due: { date: "2099-01-16", is_recurring: true, string: "every year" },
  };
  assert.deepEqual(recurringTaskIdentityCandidates(occurrence, [annualTask]), ["annual-task"]);

  const state = fakeState();
  const clients = fakeClients([master], [annualTask]);
  clients.pair.calendar.listInstances = async () => [occurrence];
  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);

  assert.equal(summary.conflicts, 1);
  assert.equal(summary.imported, 0);
  assert.equal(clients.created, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some(({ action, detail }) =>
    action === "calendar_snapshot_recurring_identity_conflict"
    && detail.candidateTaskIds.includes(annualTask.id)));
});

test("Calendar-owned recurring series still creates one active non-recurring mirror", async () => {
  const master = { ...futureEvent("calendar-series", 12, "Calendar-owned appointment"), recurrence: ["RRULE:FREQ=YEARLY"] };
  const occurrence = { ...futureEvent("calendar-series_20990112", 12, "Calendar-owned appointment"), recurringEventId: master.id };
  const state = fakeState();
  const clients = fakeClients([master]);
  clients.pair.calendar.listInstances = async () => [occurrence];
  const first = await reconcileUnmappedCalendar("home", state, async () => clients.pair);
  assert.equal(first.imported, 1);
  assert.equal(clients.created, 1);
  assert.equal(state.mappings[0].recurrenceOwner, "calendar");
  assert.equal(state.mappings[0].eventId, occurrence.id);
  // Second run should see the recorded recurrence link, not create another task.
  state.getRecurrenceLink = async () => ({ seriesId: master.id, owner: "calendar", taskId: "created-1" });
  const second = await reconcileUnmappedCalendar("home", state, async () => clients.pair);
  assert.equal(second.imported, 0);
  assert.equal(clients.created, 1);
});

test("recurring collision detection shares canonical whitespace-normalized title rules", () => {
  const occurrence = { ...futureEvent("occurrence", 16, "Pay invoice") };
  const recurring = { id: "recurring-spaces", content: "Pay  invoice", due: { date: "2099-01-16", is_recurring: true } };
  assert.deepEqual(recurringTaskIdentityCandidates(occurrence, [recurring]), ["recurring-spaces"]);
});

test("recurring collision detection compares offset timestamps across midnight", () => {
  const occurrence = {
    ...futureEvent("occurrence", 16, "Renewal"),
    start: { dateTime: "2099-06-11T00:30:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2099-06-11T01:00:00+01:00" },
  };
  const matching = { id: "matching-utc", content: "Renewal", due: { date: "2099-06-10T23:30:00Z", is_recurring: true } };
  const floating = { id: "floating-local", content: "Renewal", due: { date: "2099-06-11T00:30:00", is_recurring: true } };
  const wrongInstant = { id: "wrong-instant", content: "Renewal", due: { date: "2099-06-11T00:30:00Z", is_recurring: true } };
  const allDay = { id: "all-day", content: "Renewal", due: { date: "2099-06-11", is_recurring: true } };
  assert.deepEqual(recurringTaskIdentityCandidates(occurrence, [matching, floating, wrongInstant, allDay]), [
    "floating-local", "matching-utc",
  ]);
});

test("recurring collision detection respects all-day versus timed events", () => {
  const day = { ...futureEvent("day", 20, "Payment") };
  const allDay = { id: "all-day", content: "Payment", due: { date: "2099-01-20", is_recurring: true } };
  const timed = { id: "timed", content: "Payment", due: { date: "2099-01-20T00:00:00Z", is_recurring: true } };
  assert.deepEqual(recurringTaskIdentityCandidates(day, [allDay, timed]), ["all-day"]);
});

test("recurrence snapshot does not import a duplicate for normalized title and cross-midnight instant", async () => {
  const master = {
    ...futureEvent("series-offset", 18, "Pay invoice"),
    start: { dateTime: "2099-06-11T00:30:00+01:00", timeZone: "Europe/London" },
    end: { dateTime: "2099-06-11T01:00:00+01:00", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=YEARLY"],
  };
  const active = {
    ...master,
    id: "series-offset_20990611",
    recurringEventId: master.id,
    recurrence: undefined,
  };
  const recurringTask = {
    id: "existing-recurring", content: "Pay  invoice",
    due: { date: "2099-06-10T23:30:00Z", is_recurring: true, string: "every year" },
  };
  const state = fakeState();
  const clients = fakeClients([master], [recurringTask]);
  clients.pair.calendar.listInstances = async () => [active];
  const summary = await reconcileUnmappedCalendar("home", state, async () => clients.pair);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.imported, 0);
  assert.equal(clients.created, 0);
  assert.equal(state.mappings.length, 0);
  assert.ok(state.audits.some(({ action, detail }) =>
    action === "calendar_snapshot_recurring_identity_conflict"
    && detail.candidateTaskIds.includes(recurringTask.id)));
});


test("Calendar import rolls back a newly created task when controls change before comment write",async()=>{
  const state=fakeState(),source=futureEvent("event",10,"Calendar item"),clients=fakeClients([source]);
  let created=false;state.syncBlocked=async(_profile,ids)=>created&&ids.eventId==="event";
  const upsert=clients.pair.todoist.upsertTask;clients.pair.todoist.upsertTask=async(...args)=>{const task=await upsert(...args);created=true;return task;};
  const summary=await reconcileUnmappedCalendar("home",state,async()=>clients.pair);
  assert.equal(summary.blocked,1);assert.equal(clients.created,1);assert.equal(clients.deletions,1);
  assert.equal(clients.tasks.length,0);assert.equal(clients.comments,0);assert.equal(state.mappings.length,0);
});

for (const shape of ["missing-shared-task", "different-canonical-task"]) {
  test(`snapshot recurrence recovery preserves exact occurrence identity: ${shape}`, async () => {
    const master = {...futureEvent("owned-series",15,"Reminder"),recurrence:["RRULE:FREQ=YEARLY"]};
    const occurrence = {...futureEvent("owned-occurrence",15,"Reminder"),recurringEventId:master.id,extendedProperties:{shared:{taskId:"original-task"}}};
    const state = fakeState();
    const clients = fakeClients([master],shape === "different-canonical-task" ? [{id:"unrelated-task",content:"Reminder",due:{date:"2099-01-15"}}] : []);
    clients.pair.calendar.listInstances = async () => [occurrence];
    await reconcileUnmappedCalendar("home",state,async () => clients.pair);
    await reconcileUnmappedCalendar("home",state,async () => clients.pair);
    assert.equal(clients.created,0);
    assert.equal(state.mappings.length,0);
    assert.ok(state.audits.some(({action,detail}) => action === "calendar_snapshot_recurring_identity_conflict" && detail.candidateTaskIds.includes("original-task")));
  });
}

for (const shared of [true,false]) {
  test(`snapshot refuses an unsupported recurring canonical task (shared identity: ${shared})`, async () => {
    const master = {...futureEvent("unsupported-series",15,"Reminder"),recurrence:["RRULE:FREQ=YEARLY"]};
    const occurrence = {...futureEvent("unsupported-occurrence",15,"Reminder"),recurringEventId:master.id,
      ...(shared ? {extendedProperties:{shared:{taskId:"original-task"}}} : {})};
    const recurring = {id:"original-task",content:"Reminder",description:"",due:{date:"2099-01-15",is_recurring:true,string:"every! 365 days"}};
    const state = fakeState(), clients = fakeClients([master],[recurring]);
    clients.pair.calendar.listInstances = async () => [occurrence];
    const summary = await reconcileUnmappedCalendar("home",state,async () => clients.pair);
    assert.equal(summary.conflicts,1);
    assert.equal(clients.created,0);
    assert.equal(state.mappings.length,0);
    assert.ok(state.audits.some(({action,detail}) => action === "calendar_snapshot_recurring_identity_conflict" && detail.candidateTaskIds.includes(recurring.id)));
  });
}
