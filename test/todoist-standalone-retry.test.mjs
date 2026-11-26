import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Synchronizer } from "../dist/sync.js";
import { profiles } from "../dist/config.js";
import { failedDeliveryDisposition } from "../dist/sqs-failure-policy.js";
import { SafeProviderReplayError } from "../dist/safe-provider-replay.js";

test("one-off Calendar creation retries mapping persistence against its deterministic event ID", async () => {
  const task = {
    id: "one-off-mapping-retry",
    content: "Renew passport",
    description: "",
    project_id: profiles.home.todoistProjectId,
    is_completed: false,
    is_deleted: false,
    updated_at: "2098-12-01T12:00:00.000Z",
    due: { date: "2099-01-11" },
  };
  const eventId = createHash("sha256")
    .update(`todoist-standalone:home:${task.id}`)
    .digest("hex").slice(0, 32);
  const events = new Map();
  const counters = { creates: 0, mappingWrites: 0 };
  let mapping;
  let failFirstMappingWrite = true;
  const state = {
    async beginTodoistCalendarWrite() { return "write-fence"; },
    async endTodoistCalendarWrite() {},
    async getMappingByTaskAnyProfile(id) { return mapping?.taskId === id ? mapping : undefined; },
    async getMappingByTask(profile, id) { return profile === "home" && mapping?.taskId === id ? mapping : undefined; },
    async listMappings() { return mapping ? [mapping] : []; },
    async putMapping(value) {
      counters.mappingWrites += 1;
      if (failFirstMappingWrite) {
        failFirstMappingWrite = false;
        throw new Error("temporary mapping persistence failure");
      }
      mapping = structuredClone(value);
    },
    async acceptTaskVersion() { return true; },
    async syncBlocked() { return false; },
    async mutationAllowed() { return true; },
    async recordMutation() {},
    async audit() {},
  };
  const todoist = {
    async listProjectComments() { return []; },
    async getTask(id) { assert.equal(id, task.id); return structuredClone(task); },
  };
  const calendar = {
    async getEvent(id) {
      const event = events.get(id);
      if (event) return structuredClone(event);
      const error = new Error("Calendar event not found");
      error.status = 404;
      throw error;
    },
    async findByTodoistTaskId() { return undefined; },
    async listDelta() { return { items: [] }; },
    async upsertEvent(event, existingId) {
      assert.equal(existingId, undefined);
      assert.equal(event.id, eventId);
      counters.creates += 1;
      const stored = {
        ...structuredClone(event),
        status: "confirmed",
        extendedProperties: { ...event.extendedProperties,
          shared: { ...event.extendedProperties?.shared, taskId: task.id } },
      };
      events.set(eventId, stored);
      return structuredClone(stored);
    },
  };
  const sync = new Synchronizer(state, undefined, async () => ({ calendar, todoist }));
  const delivery = {
    id: "one-off-added",
    kind: "todoist",
    profile: "home",
    mode: "aws",
    receivedAt: "2098-12-01T12:01:00.000Z",
    headers: {},
    body: JSON.stringify({ event_name: "item:added", event_data: task }),
  };

  let firstFailure;
  try { await sync.process(delivery); }
  catch (error) { firstFailure = error; }
  assert.ok(firstFailure instanceof SafeProviderReplayError);
  assert.equal(counters.creates, 1);
  assert.equal(events.get(eventId).extendedProperties.shared.taskId, task.id);
  assert.deepEqual(failedDeliveryDisposition(
    firstFailure, { kind: "todoist" }, true, 1,
  ), { kind: "retry_fifo", reason: "safe_provider_replay", receiveCount: 1 });

  await sync.process({ ...delivery, id: "one-off-added-retry" });
  assert.equal(counters.creates, 1, "retry must reuse the existing Calendar event");
  assert.equal(mapping.eventId, eventId);
  assert.equal(mapping.taskId, task.id);
});
