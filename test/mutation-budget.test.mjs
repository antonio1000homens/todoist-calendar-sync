import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createBudgetedClientFactory,
  MutationBudgetExhaustedError,
  ReconciliationMutationBudget,
} from "../dist/mutation-budget.js";

function mockClients(calls) {
  return {
    calendar: {
      async listDelta() { calls.push("calendar.listDelta"); return { items: [] }; },
      async findByTodoistTaskId() { calls.push("calendar.findByTodoistTaskId"); return undefined; },
      async getEvent() { calls.push("calendar.getEvent"); return { id: "event" }; },
      async listInstances() { calls.push("calendar.listInstances"); return []; },
      async upsertEvent(event) { calls.push("calendar.upsertEvent"); return { ...event, id: event.id || "event" }; },
      async deleteEvent() { calls.push("calendar.deleteEvent"); },
    },
    todoist: {
      async listTasks() { calls.push("todoist.listTasks"); return []; },
      async getTask() { calls.push("todoist.getTask"); return { id: "task", content: "Task" }; },
      async upsertTask(task) { calls.push("todoist.upsertTask"); return { ...task, id: "task" }; },
      async updateRecurringOccurrence(task) { calls.push("todoist.updateRecurringOccurrence"); return task; },
      async deleteTask() { calls.push("todoist.deleteTask"); },
      async upsertComment() { calls.push("todoist.upsertComment"); return { id: "comment" }; },
      async findComment() { calls.push("todoist.findComment"); return undefined; },
      async deleteComment() { calls.push("todoist.deleteComment"); },
    },
  };
}

test("provider reads do not consume the reconciliation mutation budget", async () => {
  const calls = [];
  const budget = new ReconciliationMutationBudget(3);
  const factory = createBudgetedClientFactory(budget, async () => mockClients(calls));
  const clients = await factory("home");

  await clients.calendar.listDelta();
  await clients.calendar.getEvent("event");
  await clients.todoist.listTasks();
  await clients.todoist.findComment("task", "event");

  assert.equal(budget.used, 0);
  assert.equal(budget.remaining, 3);
  assert.equal(calls.length, 4);
});

test("Calendar and Todoist writes across profiles share one strict budget", async () => {
  const calls = [];
  const budget = new ReconciliationMutationBudget(3);
  const factory = createBudgetedClientFactory(budget, async () => mockClients(calls));
  const home = await factory("home");
  const work = await factory("work");

  await home.calendar.upsertEvent({ id: "", summary: "One" });
  await home.todoist.upsertTask({ content: "Two" });
  await work.todoist.deleteTask("task");

  assert.equal(budget.used, 3);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.exhausted, true);

  await assert.rejects(
    async () => work.calendar.deleteEvent("event"),
    (error) => {
      assert.ok(error instanceof MutationBudgetExhaustedError);
      assert.equal(error.limit, 3);
      assert.equal(error.used, 3);
      assert.equal(error.profile, "work");
      assert.equal(error.provider, "calendar");
      assert.equal(error.operation, "deleteEvent");
      return true;
    },
  );

  assert.equal(budget.used, 3, "rejected mutation must not increase the counter beyond the cap");
  assert.equal(calls.filter((call) => call === "calendar.deleteEvent").length, 0, "11th-equivalent mutation must not reach the provider");
});

test("methods with an internal write fallback reserve their worst-case cost before the provider call", async () => {
  const calls = [];
  const budget = new ReconciliationMutationBudget(2);
  const factory = createBudgetedClientFactory(budget, async () => mockClients(calls));
  const clients = await factory("home");

  await clients.calendar.upsertEvent({ id: "", summary: "One" });
  assert.equal(budget.remaining, 1);

  await assert.rejects(
    async () => clients.todoist.upsertComment("task", "comment", "existing-comment"),
    (error) => {
      assert.ok(error instanceof MutationBudgetExhaustedError);
      assert.equal(error.requested, 2);
      assert.equal(error.used, 1);
      return true;
    },
  );

  assert.equal(budget.used, 1);
  assert.equal(calls.includes("todoist.upsertComment"), false, "fallback-capable method must not start with insufficient budget");
});

test("worker uses the same budgeted client factory for every reconciliation mutation path", async () => {
  const workerSource = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.match(workerSource, /const mutationBudget = new ReconciliationMutationBudget\(\)/);
  assert.match(workerSource, /const budgetedClientFactory = createBudgetedClientFactory\(mutationBudget, defaultProviderClientFactory\)/);
  assert.match(workerSource, /new SnapshotReconciler\([\s\S]*?budgetedClientFactory/);
  assert.match(workerSource, /new ProjectAwareSynchronizer\(state, undefined, budgetedClientFactory\)/);
  assert.match(workerSource, /new Synchronizer\(state, undefined, budgetedClientFactory\)/);
  assert.match(workerSource, /reconcileUnmappedCalendar\([\s\S]*?defaultProviderClientFactory,[\s\S]*?mutationBudget/);
  assert.match(workerSource, /if \(mutationBudget\.exhausted\) return deferForMutationBudget\("mapped_state"\)/);
});
