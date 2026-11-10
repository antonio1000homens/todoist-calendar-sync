import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeSlackInteractionDelivery, isSlackControlUserAllowed } from "../dist/slack-interaction.js";

const envelope = (overrides = {}) => ({
  id: "slack-interaction:v1:fixture",
  kind: "manual",
  profile: "home",
  mode: "aws",
  receivedAt: "2026-11-03T00:00:00.000Z",
  headers: { source: "slack" },
  body: "",
  slackInteraction: {
    schemaVersion: 1,
    type: "slash_command",
    command: "/sync",
    commandText: "status home",
    userId: "U123456",
    requestTimestamp: "1793664000",
    ...overrides,
  },
});

test("typed v1 contract fixture decodes into a domain-owned manual delivery", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/slack-interaction-v1.json", import.meta.url), "utf8"));
  const decoded = decodeSlackInteractionDelivery(fixture);
  assert.equal(decoded.profile, "home");
  assert.equal(decoded.manual?.command, "show_status");
  assert.equal(decoded.manual?.targetId, "home");
  assert.equal(decoded.manual?.slackUserId, "U123456");
  assert.equal(decoded.slackInteraction, undefined);
});

test("slash command parser retains every documented /sync route", () => {
  const cases = [
    ["status home", "show_status", "home", "home"],
    ["reconcile work", "reconcile_now", "work", "work"],
    ["conflicts home", "list_conflicts", "home", "home"],
    ["inspect task task-1 home", "inspect_mapping", "task-1", "home"],
    ["inspect event event-1 home", "inspect_mapping", "event-1", "home"],
    ["inspect decision home-both_sides_changed-abc", "inspect_mapping", "home-both_sides_changed-abc", "home"],
    ["resume home", "resume_pending_reconciliation", "home", "home"],
    ["resume home-decision-1", "resume_decision", "home-decision-1", "home"],
    ["policies home", "list_policies", "home", "home"],
    ["policy home both_sides_changed prompt", "set_policy", "both_sides_changed", "home"],
    ["policy global both_sides_changed observe", "set_policy", "both_sides_changed", "antonio"],
    ["policy series home series-1 both_sides_changed prompt", "set_policy", "both_sides_changed", "home"],
    ["policy reset home both_sides_changed", "clear_policy", "both_sides_changed", "home"],
    ["policy reset series home series-1 both_sides_changed", "clear_policy", "both_sides_changed", "home"],
  ];
  for (const [commandText, expectedCommand, expectedTarget, profile] of cases) {
    const delivery = envelope({ commandText, type: "slash_command" });
    delivery.profile = profile;
    const decoded = decodeSlackInteractionDelivery(delivery);
    assert.equal(decoded.manual?.command, expectedCommand, commandText);
    assert.equal(decoded.manual?.targetId, expectedTarget, commandText);
  }
});

test("policy buttons preserve legacy IDs while profile, mode and catalog are validated by the owner", () => {
  const decoded = decodeSlackInteractionDelivery(envelope({
    type: "block_action",
    commandText: undefined,
    actionId: "gcp_sync_policy_series_auto",
    value: { realm: "attacker-chosen", profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "series", policyMode: "auto", policyAction: "todoist_wins", seriesId: "series-7" },
  }));
  assert.equal(decoded.manual?.command, "set_policy");
  assert.deepEqual(decoded.manual?.policy, { decisionType: "both_sides_changed", scope: "series", mode: "auto", defaultAction: "todoist_wins", seriesId: "series-7" });

  const denied = decodeSlackInteractionDelivery(envelope({
    type: "block_action", commandText: undefined, actionId: "gcp_sync_policy_profile_auto",
    value: { profile: "work", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "profile", policyMode: "auto", policyAction: "todoist_wins" },
  }));
  assert.equal(denied.manual?.command, "invalid_request");
});

test("every policy button emitted on current and already-posted decision cards decodes compatibly", () => {
  const cases = [
    ["gcp_sync_policy", { profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "profile", policyMode: "prompt" }, { scope: "profile", mode: "prompt" }],
    ["gcp_sync_policy_profile_prompt", { profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "profile", policyMode: "prompt", policyAction: "todoist_wins" }, { scope: "profile", mode: "prompt", defaultAction: "todoist_wins" }],
    ["gcp_sync_policy_series_prompt", { profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "series", policyMode: "prompt", policyAction: "todoist_wins", seriesId: "series-7" }, { scope: "series", mode: "prompt", defaultAction: "todoist_wins", seriesId: "series-7" }],
    ["gcp_sync_policy_profile_auto", { profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "profile", policyMode: "auto", policyAction: "todoist_wins" }, { scope: "profile", mode: "auto", defaultAction: "todoist_wins" }],
    ["gcp_sync_policy_series_auto", { profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "series", policyMode: "auto", policyAction: "todoist_wins", seriesId: "series-7" }, { scope: "series", mode: "auto", defaultAction: "todoist_wins", seriesId: "series-7" }],
    ["gcp_sync_policy_always_ask", { profile: "home", decisionType: "both_sides_changed", policyOperation: "set", policyScope: "profile", policyMode: "prompt" }, { scope: "profile", mode: "prompt" }],
  ];

  for (const [actionId, value, expectedPolicy] of cases) {
    const decoded = decodeSlackInteractionDelivery(envelope({ type: "block_action", commandText: undefined, actionId, value }));
    assert.equal(decoded.manual?.command, "set_policy", actionId);
    assert.equal(decoded.manual?.targetId, "both_sides_changed", actionId);
    assert.deepEqual(decoded.manual?.policy, { decisionType: "both_sides_changed", ...expectedPolicy }, actionId);
  }
});

test("decision and preexisting confirmation buttons produce one worker-owned manual action", () => {
  const decision = decodeSlackInteractionDelivery(envelope({
    type: "block_action", commandText: undefined, actionId: "gcp_sync_decision_confirm",
    value: { profile: "home", decisionId: "home-both_sides_changed-abc", action: "todoist_wins", confirmed: true, confirmRequired: true },
    channelId: "C123456", messageTs: "1700000000.000001",
  }));
  assert.deepEqual(decision.manual, {
    decisionId: "home-both_sides_changed-abc", action: "todoist_wins", slackUserId: "U123456",
    slackChannelId: "C123456", slackMessageTs: "1700000000.000001",
  });

  const oldFirstClick = decodeSlackInteractionDelivery(envelope({
    type: "block_action", commandText: undefined, actionId: "gcp_sync_decision_0",
    value: { profile: "home", decisionId: "home-both_sides_changed-abc", action: "todoist_wins", confirmRequired: true },
    channelId: "C123456", messageTs: "1700000000.000001",
  }));
  assert.equal(oldFirstClick.manual?.command, "confirm_legacy_action");
  assert.equal(oldFirstClick.manual?.action, "todoist_wins");

  const oldConfirmedClick = decodeSlackInteractionDelivery(envelope({
    type: "block_action", commandText: undefined, actionId: "gcp_sync_decision_confirm",
    value: { profile: "home", decisionId: "home-both_sides_changed-abc", action: "todoist_wins", confirmRequired: true, confirmed: true },
  }));
  assert.equal(oldConfirmedClick.manual?.command, undefined);
  assert.equal(oldConfirmedClick.manual?.action, "todoist_wins");

  const cancel = decodeSlackInteractionDelivery(envelope({
    type: "block_action", commandText: undefined, actionId: "gcp_sync_confirmation_cancel",
    value: { profile: "home", decisionId: "home-both_sides_changed-abc" },
  }));
  assert.equal(cancel.manual?.command, "cancel_confirmation");
});

test("malformed, mismatched and unknown controls fail closed without producing a mutation action", () => {
  const wrongProfile = decodeSlackInteractionDelivery(envelope({ commandText: "reconcile work" }));
  assert.equal(wrongProfile.manual?.command, "invalid_request");
  const unsupported = decodeSlackInteractionDelivery(envelope({ type: "block_action", commandText: undefined, actionId: "gcp_sync_future_action", value: {} }));
  assert.equal(unsupported.manual?.command, "invalid_request");
  assert.throws(() => decodeSlackInteractionDelivery(envelope({ schemaVersion: 2 })), /Unsupported Slack interaction envelope/);
});

test("worker authorization preserves workspace behavior and applies an exact optional allowlist", () => {
  assert.equal(isSlackControlUserAllowed("U123456", ""), true);
  assert.equal(isSlackControlUserAllowed("U123456", " U123456, U999999 "), true);
  assert.equal(isSlackControlUserAllowed("U1234567", "U123456"), false);
});


test("empty /sync command text preserves legacy help behaviour after gateway cutover", () => {
  const delivery = envelope({ commandText: "" });
  const decoded = decodeSlackInteractionDelivery(delivery);
  assert.equal(decoded.manual?.command, "help");
  assert.match(decoded.manual?.message || "", /\/sync policies/);
});
