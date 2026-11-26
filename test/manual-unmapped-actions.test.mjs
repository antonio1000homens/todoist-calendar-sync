import assert from "node:assert/strict";
import test from "node:test";
import { ManualInterventionService, MANUAL_DECISION_CATALOG, decisionBlocks } from "../dist/manual-intervention.js";
import { profiles } from "../dist/config.js";

class DecisionStore {
  constructor(decision) { this.decision = decision; }
  async get(id) { return id === this.decision.decisionId ? this.decision : undefined; }
  async finish(id, status) { assert.equal(id, this.decision.decisionId); this.decision.status = status; }
}
class Notifier {
  async postText() {}
  async updateResolution() {}
}
function decision() {
  return {
    decisionId:"legacy-unmapped-conflict", type:"todoist_unmapped_conflict", profile:"home", status:"pending",
    decisionDeadline:"2099-01-01T00:00:00.000Z", permittedActions:[
      {id:"use_todoist_recurrence",label:"Use Todoist recurrence"},
      {id:"use_calendar_version",label:"Use Calendar version"},
      {id:"bind_task:other",label:"Bind another task"},
    ], context:{candidateTaskIds:["other"]},
  };
}

test("unmapped recurrence conflicts expose no owner choice, conversion, or candidate binding", () => {
  const item = decision();
  assert.deepEqual(MANUAL_DECISION_CATALOG.todoist_unmapped_conflict.actions, []);
  const blocks = decisionBlocks(item);
  assert.equal(blocks.some(block => block.type === "actions"), false);
});

test("stale manual recurrence decisions cannot mutate providers", async () => {
  const item = decision();
  const store = new DecisionStore(item);
  const service = new ManualInterventionService(store, new Notifier());
  const state = { async syncBlocked() { return false; } };
  const delivery = action => ({id:`manual:${action}`,kind:"manual",profile:profiles.home.name || "home",mode:"aws",
    receivedAt:new Date().toISOString(),headers:{},body:"",manual:{decisionId:item.decisionId,action}});
  for (const action of ["use_todoist_recurrence","use_calendar_version","bind_task:other"]) {
    await assert.rejects(service.processManualDelivery(delivery(action),state),/not permitted/);
    assert.equal(item.status,"pending");
  }
});
