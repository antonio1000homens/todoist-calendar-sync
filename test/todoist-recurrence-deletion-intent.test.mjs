import assert from "node:assert/strict";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { MANUAL_DECISION_CATALOG, ManualInterventionService, SlackManualNotifier } from "../dist/manual-intervention.js";

class DecisionStore {
  decisions = new Map();
  async putPending(input) {
    const existing = this.decisions.get(input.decisionId);
    if (existing) return { decision: existing, created: false };
    const decision = { ...input, status: "pending", createdAt: "2026-10-25T00:00:00.000Z", decisionDeadline: "2099-10-25T00:00:00.000Z" };
    this.decisions.set(decision.decisionId, decision);
    return { decision, created: true };
  }
  async get(id) { return this.decisions.get(id); }
  async finish(id, status, resolution, slackUserId) {
    const decision = this.decisions.get(id);
    assert.equal(decision.status, "pending");
    Object.assign(decision, { status, resolution, resolvedBySlackUserId: slackUserId });
  }
}

class Notifier {
  posted = [];
  updated = [];
  async postDecision(decision) { this.posted.push(decision); }
  async updateResolution(decision, text) { this.updated.push({ decision, text }); }
}

const mapping = {
  profile: "antonio", taskId: "task-1", eventId: "instance-1", masterEventId: "master-1",
  activeInstanceId: "instance-1", seriesId: "series-1", recurrenceOwner: "todoist",
  updatedAt: "2026-10-24T12:00:00.000Z",
};

test("Todoist recurrence deletion queues Calendar deletion without a Slack approval and reports after success", async () => {
  assert.equal(MANUAL_DECISION_CATALOG.todoist_owned_recurrence_task_deleted.defaultMode, "auto");
  assert.equal(MANUAL_DECISION_CATALOG.todoist_owned_recurrence_task_deleted.defaultAction, "delete_calendar_series");
  assert.equal(MANUAL_DECISION_CATALOG.todoist_owned_recurrence_task_deleted.actions.find(action => action.id === "delete_calendar_series").autoAllowed, true);

  const originalSend = SQSClient.prototype.send;
  const originalQueueUrl = process.env.QUEUE_URL;
  const originalInterventionEnabled = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  const sent = [];
  SQSClient.prototype.send = async function (command) { sent.push(command); return {}; };
  process.env.QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/123456789012/test.fifo";
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";

  const decisions = new DecisionStore();
  const notifier = new Notifier();
  const operations = [];
  const state = {
    async getMappingByTask() { return mapping; },
    async syncBlocked() { return false; },
    async mutationAllowed() { return true; },
    async recordMutation() {},
    async deleteMapping() { operations.push("mapping removed"); },
    async deleteRecurrenceLink() { operations.push("recurrence link removed"); },
    async audit() {},
  };
  const clients = async () => ({
    todoist: { async getTask() { const error = new Error("not found"); error.status = 404; throw error; } },
    calendar: { async deleteEvent(id) { operations.push(`Calendar series ${id} deleted`); } },
  });
  const catalogPolicy = { async resolve(_profile, _type, _seriesId, defaultMode) { return { mode: defaultMode, source: "catalog" }; } };
  const service = new ManualInterventionService(decisions, notifier, clients, catalogPolicy);

  try {
    const intercepted = await service.interceptTodoistDeletion({
      id: "todoist-delete-1", kind: "todoist", profile: "antonio", mode: "aws",
      receivedAt: "2026-10-25T00:00:00.000Z", headers: {},
      body: JSON.stringify({ event_name: "item:deleted", event_data: { id: "task-1", content: "Recurring item", is_deleted: true } }),
    }, state);
    assert.equal(intercepted, true);
    assert.equal(notifier.posted.length, 0, "no Slack decision card is posted before provider work");
    assert.equal(sent.length, 1, "the provider action is queued independently of Slack");
    const delivery = JSON.parse(sent[0].input.MessageBody);
    assert.equal(delivery.manual.action, "delete_calendar_series");
    assert.equal(delivery.manual.slackUserId, "AUTO_POLICY");

    await service.processManualDelivery(delivery, state);
    assert.deepEqual(operations, ["Calendar series master-1 deleted", "mapping removed", "recurrence link removed"]);
    assert.equal(decisions.decisions.get(delivery.manual.decisionId).status, "resolved");
    assert.equal(notifier.updated.length, 1, "completion is posted only after all provider and mapping operations finish");
    assert.match(notifier.updated[0].text, /Todoist recurrence deletion completed/);
    assert.match(notifier.updated[0].text, /task-1/);
    assert.match(notifier.updated[0].text, /master-1/);
    assert.match(notifier.updated[0].text, /recreate the task and Calendar series manually/);
  } finally {
    SQSClient.prototype.send = originalSend;
    if (originalQueueUrl === undefined) delete process.env.QUEUE_URL;
    else process.env.QUEUE_URL = originalQueueUrl;
    if (originalInterventionEnabled === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = originalInterventionEnabled;
  }
});

test("a failed Slack completion post does not fail the completed provider action", async () => {
  const originalSend = SSMClient.prototype.send;
  const originalFetch = globalThis.fetch;
  const originalEnabled = process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
  const originalTokenParameter = process.env.SLACK_BOT_TOKEN_PARAMETER;
  SSMClient.prototype.send = async () => ({ Parameter: { Value: "test-token" } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "channel_not_found" }) });
  process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = "true";
  process.env.SLACK_BOT_TOKEN_PARAMETER = "/test/auto-delete-slack-token";
  const notifier = new SlackManualNotifier({ async get() { return undefined; } });
  try {
    await assert.doesNotReject(() => notifier.updateResolution({
      decisionId: "decision-1", profile: "antonio", type: "todoist_owned_recurrence_task_deleted",
      severity: "destructive", status: "resolved", createdAt: "2026-10-25T00:00:00.000Z",
      decisionDeadline: "2099-10-25T00:00:00.000Z", context: {}, permittedActions: [],
    }, "Calendar series deleted"));
  } finally {
    SSMClient.prototype.send = originalSend;
    globalThis.fetch = originalFetch;
    if (originalEnabled === undefined) delete process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED;
    else process.env.TODOIST_CALENDAR_SYNC_MANUAL_INTERVENTION_ENABLED = originalEnabled;
    if (originalTokenParameter === undefined) delete process.env.SLACK_BOT_TOKEN_PARAMETER;
    else process.env.SLACK_BOT_TOKEN_PARAMETER = originalTokenParameter;
  }
});
