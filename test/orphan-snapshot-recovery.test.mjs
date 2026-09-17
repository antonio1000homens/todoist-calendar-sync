import assert from "node:assert/strict";
import test from "node:test";
import { reconcileUnmappedCalendar } from "../dist/calendar-reconciliation.js";
import { todoistCanonicalIdentity } from "../dist/canonical-identity.js";
import { ReconciliationMutationBudget } from "../dist/mutation-budget.js";

class FakeIdentityStore {
  constructor() { this.values = new Map(); }
  key(profile, side, providerId) { return `${profile}:${side}:${providerId}`; }
  async get(profile, side, providerId) {
    const identity = this.values.get(this.key(profile, side, providerId));
    return identity ? { profile, side, providerId, identity, updatedAt: "2026-09-17T10:00:00Z" } : undefined;
  }
  async put(profile, side, providerId, identity) {
    this.values.set(this.key(profile, side, providerId), structuredClone(identity));
  }
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
    async putMapping(mapping) { mappings.push(structuredClone(mapping)); },
    async putRecurrenceLink() {},
    async recordMutation() { mutations += 1; },
    async audit(profile, action, detail) { audits.push({ profile, action, detail }); },
  };
}

function event(id, title, hour) {
  const hh = String(hour).padStart(2, "0");
  return {
    id,
    status: "confirmed",
    summary: title,
    description: "",
    start: { dateTime: `2099-01-10T${hh}:30:00+00:00`, timeZone: "Europe/London" },
    end: { dateTime: `2099-01-10T${hh}:45:00+00:00`, timeZone: "Europe/London" },
  };
}

function task(id, title, hour) {
  const hh = String(hour).padStart(2, "0");
  return {
    id,
    project_id: "home-project",
    content: title,
    description: "",
    due: { datetime: `2099-01-10T${hh}:30:00+00:00`, timezone: "Europe/London" },
  };
}

test("Calendar snapshot recovery re-links and updates the unique Todoist orphan matching the previous identity", async () => {
  const changedEvent = event("event-1", "School pickup", 15);
  const oldTask = task("task-1", "School run", 8);
  const tasks = [structuredClone(oldTask)];
  const identityStore = new FakeIdentityStore();
  await identityStore.put("home", "calendar", changedEvent.id, todoistCanonicalIdentity(oldTask));
  const state = fakeState();
  const writes = [];
  const clients = {
    calendar: {
      async listDelta() { return { items: [changedEvent] }; },
      async listInstances() { return []; },
    },
    todoist: {
      async listTasks() { return tasks; },
      async upsertTask(next, existingId) {
        const stored = { ...tasks.find((candidate) => candidate.id === existingId), ...next, id: existingId || "created", project_id: "home-project" };
        writes.push({ existingId, stored: structuredClone(stored) });
        const index = tasks.findIndex((candidate) => candidate.id === stored.id);
        if (index >= 0) tasks[index] = stored;
        else tasks.push(stored);
        return stored;
      },
      async findComment() { return undefined; },
      async upsertComment() { return { id: "comment-1" }; },
    },
  };

  const summary = await reconcileUnmappedCalendar(
    "home",
    state,
    async () => clients,
    new ReconciliationMutationBudget(10),
    undefined,
    20,
    identityStore,
  );

  assert.equal(summary.imported, 0);
  assert.equal(summary.rebound, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].existingId, oldTask.id);
  assert.equal(writes[0].stored.content, "School pickup");
  assert.equal(state.mappings[0].taskId, oldTask.id);
  assert.ok(state.audits.some((entry) => entry.action === "calendar_orphan_todoist_rebound_previous_identity"));
});
