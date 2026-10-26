import assert from "node:assert/strict";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { MANUAL_DECISION_CATALOG, ManualInterventionService } from "../dist/manual-intervention.js";

class Decisions {
  rows = new Map();
  async get(id) { return this.rows.get(id); }
  async putPending(input) {
    const existing = this.rows.get(input.decisionId);
    if (existing) return { decision: existing, created: false };
    const decision = {
      ...input, status: "pending",
      createdAt: "2026-10-26T09:00:00.000Z",
      decisionDeadline: "2099-10-26T09:00:00.000Z",
    };
    this.rows.set(input.decisionId, decision);
    return { decision, created: true };
  }
  async finish(id, status, resolution) {
    Object.assign(this.rows.get(id), { status, resolution });
  }
}
class Notifier {
  posted = [];
  updated = [];
  async postDecision(decision) { this.posted.push(decision); }
  async updateResolution(decision, text) { this.updated.push({ decision, text }); }
}
function deletion(profile) {
  return {
    id: `delete-${profile}`, kind: "todoist", profile, mode: "aws",
    receivedAt: "2026-10-26T10:00:00.000Z", headers: {},
    body: JSON.stringify({
      event_name: "item:deleted",
      event_data: { id: "task-1", content: "Standalone appointment", is_deleted: true },
    }),
  };
}
function setup(profile, { taskExists = false, differentOwner = false, recurringEvent = false,
  mappingRecurrenceId = false, mappingActiveInstanceId = false,
  syncRecurrenceOwner = false, todoistRecurrence = false, missingTaskId = false,
  historicalEvent = false, raceAfterProviderDelete = false } = {}) {
  const operations = [], decisions = new Decisions(), notifier = new Notifier();
  const original = {
    profile, taskId: "task-1", eventId: "event-1", updatedAt: "2026-10-26T09:00:00.000Z",
    ...(mappingRecurrenceId ? { recurrenceId: "legacy-weekly" } : {}),
    ...(mappingActiveInstanceId ? { activeInstanceId: "event-1" } : {}),
  };
  let current = original;
  const state = {
    async getMappingByTask() { return current; },
    async getMappingByEvent() { return differentOwner ? { ...current, taskId: "other-task" } : current; },
    async syncBlocked() { return false; },
    async mutationAllowed() { return true; },
    async recordMutation(p) { operations.push(`mutation ${p}`); },
    async deleteMapping() { throw new Error("Unsafe unconditional mapping deletion"); },
    async deleteMappingIfUnchanged(m) {
      if (!current || current.updatedAt !== m.updatedAt
        || current.eventId !== m.eventId || current.taskId !== m.taskId) return false;
      operations.push(`mapping ${m.eventId} removed`);
      current = undefined;
      return true;
    },
    async audit() {},
  };
  const clients = async () => ({
    todoist: {
      async getTask() {
        if (taskExists) return { id: "task-1", content: "Recreated" };
        throw Object.assign(new Error("not found"), { status: 404 });
      },
    },
    calendar: {
      async getEvent(id) {
        return {
          id, summary: "Standalone appointment",
          ...(recurringEvent ? { recurrence: ["RRULE:FREQ=WEEKLY"] } : {}),
          extendedProperties: { shared: {
            ...(missingTaskId ? {} : { taskId: "task-1" }),
            ...(syncRecurrenceOwner ? { syncRecurrenceOwner: "todoist" } : {}),
            ...(todoistRecurrence ? { todoistRecurrence: "every week" } : {}),
            ...(historicalEvent ? { syncHistoryOnly: "true" } : {}),
          } },
        };
      },
      async deleteEvent(id) {
        operations.push(`calendar ${id} deleted`);
        if (raceAfterProviderDelete) {
          current = { ...current, eventId: "new-owner-event", updatedAt: "2026-10-26T10:30:00.000Z" };
        }
      },
    },
  });
  const policies = { async resolve(_profile, _type, _seriesId, mode) { return { mode, source: "catalog" }; } };
  const service = new ManualInterventionService(decisions, notifier, clients, policies);
  const changeMapping = () => { current = { ...original, updatedAt: "2026-10-26T10:01:00.000Z" }; };
  return { operations, decisions, notifier, state, service, changeMapping };
}

test("standalone Todoist deletion is auto-applied without an approval in all profiles, including work", async () => {
  assert.equal(MANUAL_DECISION_CATALOG.standalone_todoist_task_deleted.defaultMode, "auto");
  assert.equal(MANUAL_DECISION_CATALOG.standalone_todoist_task_deleted.defaultAction, "delete_calendar_event");
  assert.equal(MANUAL_DECISION_CATALOG.standalone_todoist_task_deleted.actions.find(a => a.id === "delete_calendar_event").autoAllowed, true);

  const oldSend = SQSClient.prototype.send;
  const oldQueue = process.env.QUEUE_URL;
  const oldEnabled = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  const sent = [];
  SQSClient.prototype.send = async command => { sent.push(JSON.parse(command.input.MessageBody)); return {}; };
  process.env.QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/123456789012/one-sided.fifo";
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";
  try {
    for (const profile of ["work", "home", "antonio"]) {
      const h = setup(profile);
      const before = sent.length;
      assert.equal(await h.service.interceptTodoistDeletion(deletion(profile), h.state), true);
      assert.equal(h.notifier.posted.length, 0, "no Slack approval card");
      assert.equal(sent.length, before + 1, "exactly one FIFO automatic action");
      const auto = sent.at(-1);
      assert.equal(auto.profile, profile);
      assert.equal(auto.manual.action, "delete_calendar_event");
      assert.equal(auto.manual.slackUserId, "AUTO_POLICY");
      await h.service.processManualDelivery(auto, h.state);
      assert.deepEqual(h.operations, ["calendar event-1 deleted", `mutation ${profile}`, "mapping event-1 removed"]);
      assert.equal(h.decisions.rows.get(auto.manual.decisionId).status, "resolved");
    }
  } finally {
    SQSClient.prototype.send = oldSend;
    if (oldQueue === undefined) delete process.env.QUEUE_URL;
    else process.env.QUEUE_URL = oldQueue;
    if (oldEnabled === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = oldEnabled;
  }
});

test("replayed Todoist deletion does not enqueue a deletion after the task has reappeared", async () => {
  const h = setup("work", { taskExists: true });
  const oldEnabled = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";
  try {
    assert.equal(await h.service.interceptTodoistDeletion(deletion("work"), h.state), true);
    assert.equal(h.decisions.rows.size, 0);
    assert.equal(h.notifier.posted.length, 0);
    assert.deepEqual(h.operations, []);
  } finally {
    if (oldEnabled === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = oldEnabled;
  }
});

test("automatic standalone action fails closed on changed owner, legacy recurrence and provider metadata", async () => {
  const oldEnabled = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";
  try {
    for (const caseName of [
      "mappingChanged", "differentOwner", "recurringEvent", "mappingRecurrenceId",
      "mappingActiveInstanceId", "syncRecurrenceOwner", "todoistRecurrence",
      "missingTaskId", "historicalEvent",
    ]) {
      const h = setup("work", { [caseName]: true });
      const m = { ...await h.state.getMappingByTask() };
      const decision = {
        decisionId: caseName, profile: "work", type: "standalone_todoist_task_deleted",
        taskId: "task-1", eventId: "event-1", mappingSnapshot: m,
        status: "pending", createdAt: "2026-10-26T09:00:00.000Z",
        decisionDeadline: "2099-10-26T09:00:00.000Z", context: {},
        permittedActions: MANUAL_DECISION_CATALOG.standalone_todoist_task_deleted.actions,
      };
      h.decisions.rows.set(caseName, decision);
      if (caseName === "mappingChanged") h.changeMapping();
      await h.service.processManualDelivery({
        ...deletion("work"), kind: "manual", body: "",
        manual: { decisionId: caseName, action: "delete_calendar_event", slackUserId: "AUTO_POLICY" },
      }, h.state);
      assert.equal(h.decisions.rows.get(caseName).status, "stale", caseName);
      assert.deepEqual(h.operations, [], caseName);
      assert.equal(h.notifier.posted.length, 0, caseName);
    }
  } finally {
    if (oldEnabled === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = oldEnabled;
  }
});

test("a concurrent mapping update after Calendar deletion is never removed by the auto action", async () => {
  const oldEnabled = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";
  try {
    const h = setup("work", { raceAfterProviderDelete: true });
    const m = { ...await h.state.getMappingByTask() };
    h.decisions.rows.set("race", {
      decisionId: "race", profile: "work", type: "standalone_todoist_task_deleted",
      taskId: m.taskId, eventId: m.eventId, mappingSnapshot: m,
      status: "pending", createdAt: "2026-10-26T09:00:00.000Z",
      decisionDeadline: "2099-10-26T09:00:00.000Z", context: {},
      permittedActions: MANUAL_DECISION_CATALOG.standalone_todoist_task_deleted.actions,
    });
    await h.service.processManualDelivery({
      ...deletion("work"), kind: "manual", body: "",
      manual: { decisionId: "race", action: "delete_calendar_event", slackUserId: "AUTO_POLICY" },
    }, h.state);
    assert.equal(h.decisions.rows.get("race").status, "stale");
    assert.equal((await h.state.getMappingByTask()).eventId, "new-owner-event");
    assert.deepEqual(h.operations, ["calendar event-1 deleted", "mutation work"]);
    assert.equal(h.notifier.posted.length, 0);
  } finally {
    if (oldEnabled === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = oldEnabled;
  }
});
