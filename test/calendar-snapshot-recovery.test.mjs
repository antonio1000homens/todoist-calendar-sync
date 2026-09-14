import assert from "node:assert/strict";
import test from "node:test";
import { reconcileUnmappedCalendar } from "../dist/calendar-reconciliation.js";
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
  const audits = [];
  let mutations = 0;
  return {
    mappings,
    audits,
    get mutations() { return mutations; },
    async mutationAllowed() { return true; },
    async getMappingByEvent(profile, eventId) { return mappings.find((mapping) => mapping.profile === profile && mapping.eventId === eventId); },
    async getMappingByTaskAnyProfile(taskId) { return mappings.find((mapping) => mapping.taskId === taskId); },
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
          tasks.push(createdTask);
          return createdTask;
        },
        async findComment() { return undefined; },
        async upsertComment() { comments += 1; return { id: `comment-${comments}` }; },
      },
    },
    get created() { return created; },
    get comments() { return comments; },
    get listInstancesCalls() { return listInstancesCalls; },
  };
}

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
  assert.ok(state.audits.some((entry) => entry.action === "calendar_snapshot_reconcile_mutation_budget_exhausted"));
});
