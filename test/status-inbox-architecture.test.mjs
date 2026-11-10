import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GoogleCalendar, Todoist } from "../dist/providers.js";
import { ManualDecisionStore, SlackManualNotifier } from "../dist/manual-intervention.js";
import { processStatusInbox } from "../dist/status-inbox.js";
import { decision, FakeStore, TEST_SLACK_CHANNEL } from "./helpers/status-inbox-fixtures.mjs";

// The worker owns SQS dispatch. Keep this narrow wiring guard until an
// integration test covers dispatch without needing the full AWS worker stack.
test("show_status manual deliveries route through the recovery inbox", async () => {
  const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  const manualBranch = source.split('if (delivery.kind === "manual") {')[1]
    ?.split('if (delivery.kind === "reconcile") {')[0];
  assert.ok(manualBranch, "worker must continue handling manual deliveries");
  assert.match(manualBranch, /delivery\.manual\?\.command === "show_status"/);
  assert.match(manualBranch, /await processStatusInbox\(delivery, state\)/);
  assert.match(manualBranch, /await manual\.processManualDelivery\(delivery, state\)/);
  assert.match(manualBranch, /await markCompleted\(\)/);
});

// Previous issue #57 tests inferred provider revalidation from names in the
// source. Exercise the actual inbox instead, with provider/API/SSM isolation.
test("provider-auth decisions are revalidated before status cards, without provider writes", async t => {
  const scenarios = [
    { name: "credentials recovered", expectStale: true, expectedRendered: ["dlq"], expectedWarning: false },
    { name: "Google Calendar still returns 401", calendarError: 401, expectedRendered: ["auth", "dlq"], expectedWarning: false },
    { name: "Todoist still returns 403", todoistError: 403, expectedRendered: ["auth", "dlq"], expectedWarning: false },
    { name: "Calendar returns inconclusive 429", calendarError: 429, expectedRendered: ["auth", "dlq"], expectedWarning: true },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async subtest => {
      const fake = new FakeStore([
        decision("auth", "operational_provider_auth", "home"),
        decision("dlq", "operational_dlq", "home"),
      ]);
      const rendered = [], messages = [], reads = [], warnings = [];
      const externalRequests = [], parameterNames = [], profiles = [];
      const googlePrefix = `/test/status-inbox-424-${index}/google`;
      const todoistPrefix = `/test/status-inbox-424-${index}/todoist`;
      const previousGoogle = process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX;
      const previousTodoist = process.env.TODOIST_TOKEN_PARAMETER_PREFIX;
      process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX = googlePrefix;
      process.env.TODOIST_TOKEN_PARAMETER_PREFIX = todoistPrefix;
      subtest.after(() => {
        if (previousGoogle === undefined) delete process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX;
        else process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX = previousGoogle;
        if (previousTodoist === undefined) delete process.env.TODOIST_TOKEN_PARAMETER_PREFIX;
        else process.env.TODOIST_TOKEN_PARAMETER_PREFIX = previousTodoist;
      });

      subtest.mock.method(SSMClient.prototype, "send", async command => {
        assert.ok(command instanceof GetParameterCommand);
        const name = command.input.Name;
        parameterNames.push(name);
        assert.equal(command.input.WithDecryption, true);
        if (name === googlePrefix + "/home") return {
          Parameter: { Value: JSON.stringify({
            client_id: "test-client", client_secret: "test-secret", refresh_token: "test-refresh",
          }) },
        };
        if (name === todoistPrefix + "/home") return { Parameter: { Value: "test-token" } };
        throw new Error("Unexpected credential read: " + name);
      });
      subtest.mock.method(globalThis, "fetch", async (...args) => {
        externalRequests.push(args);
        throw new Error("Test must not contact external providers");
      });
      subtest.mock.method(GoogleCalendar.prototype, "findByTodoistTaskId", async taskId => {
        reads.push("calendar");
        assert.equal(taskId, "__todoist_calendar_sync_auth_probe__");
        if (scenario.calendarError) throw Object.assign(new Error("Calendar check failed"), { status: scenario.calendarError });
        return undefined;
      });
      subtest.mock.method(Todoist.prototype, "listTasks", async () => {
        reads.push("todoist");
        if (scenario.todoistError) throw Object.assign(new Error("Todoist check failed"), { status: scenario.todoistError });
        return [];
      });
      subtest.mock.method(ManualDecisionStore.prototype, "listPending", async profile => {
        assert.equal(profile, "home");
        return fake.listPending(profile);
      });
      subtest.mock.method(ManualDecisionStore.prototype, "get", id => fake.get(id));
      subtest.mock.method(ManualDecisionStore.prototype, "finish",
        (id, status, resolution, actor) => fake.finish(id, status, resolution, actor));
      subtest.mock.method(SlackManualNotifier.prototype, "postText", async (message, channel) => {
        messages.push(message);
        assert.equal(channel, TEST_SLACK_CHANNEL);
      });
      subtest.mock.method(SlackManualNotifier.prototype, "postDecision", async item => {
        rendered.push(item.decisionId);
        fake.markPosted(item.decisionId, `${rendered.length}.000001`);
        return true;
      });
      subtest.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));

      const delivery = {
        id: "test-424-status", kind: "manual", profile: "home", mode: "aws",
        receivedAt: "2026-11-10T12:00:00.000Z",
        manual: { command: "show_status", slackChannelId: TEST_SLACK_CHANNEL },
      };
      const state = {
        getReconciliationState: async profile => { profiles.push(profile); return undefined; },
      };
      await processStatusInbox(delivery, state);

      assert.deepEqual(profiles, ["home"]);
      assert.deepEqual(reads.slice().sort(), ["calendar", "todoist"]);
      assert.deepEqual(parameterNames.sort(), [googlePrefix + "/home", todoistPrefix + "/home"].sort());
      assert.deepEqual(externalRequests, [], "read probes must never turn into real network writes");
      assert.deepEqual(rendered, scenario.expectedRendered);
      assert.equal(fake.finishes.length, scenario.expectStale ? 1 : 0);
      if (scenario.expectStale) {
        assert.deepEqual(fake.finishes, [{
          id: "auth", status: "stale",
          resolution: "provider authentication recovered before status rendering",
          actor: "status-revalidation",
        }]);
        assert.match(messages[0], /Recovered provider-auth alerts cleared: 1/);
      } else {
        assert.match(messages[0], /Action required: 2 manual decisions pending/);
      }
      assert.equal(warnings.length > 0, scenario.expectedWarning);
      assert.match(messages.at(-1), /Decision inbox render — home/);
    });
  }
});

test("status inbox rejects any command other than show_status", async () => {
  await assert.rejects(
    processStatusInbox({ manual: { command: "resume" }, profile: "home" }, {}),
    /requires show_status/,
  );
});
