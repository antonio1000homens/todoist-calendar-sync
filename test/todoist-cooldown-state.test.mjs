import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";
import { assertTodoistAccountNotCooling } from "../dist/worker.js";
import { todoistAccountIdentity } from "../dist/providers.js";

test("Todoist cooldowns are keyed by hashed account identity, extend monotonically, and expire", async t => {
  const rows = new Map();
  const keyOf = key => `${key.pk}|${key.sk}`;
  t.mock.method(documentClient, "send", async command => {
    const input = command.input;
    if (command instanceof GetCommand)
      return { Item: structuredClone(rows.get(keyOf(input.Key))) };
    assert.ok(command instanceof UpdateCommand);
    assert.match(input.Key.pk, /^TODOIST_COOLDOWN#[a-f0-9]{64}$/);
    const values = input.ExpressionAttributeValues;
    const existing = rows.get(keyOf(input.Key));
    if (existing && existing.cooldownUntilMs >= values[":until"])
      throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
    rows.set(keyOf(input.Key), { ...input.Key, cooldownUntilMs: values[":until"], expiresAt: values[":expires"] });
    return {};
  });

  const state = new StateRepository();
  const token = "cooldown-token";
  const identity = todoistAccountIdentity(token);
  const firstUntil = Date.now() + 90_000;
  await state.extendTodoistCooldown(identity, firstUntil);
  await state.extendTodoistCooldown(identity, firstUntil - 10_000);
  assert.equal(await state.getTodoistCooldown(identity), firstUntil);

  const laterUntil = firstUntil + 60_000;
  await state.extendTodoistCooldown(identity, laterUntil);
  assert.equal(await state.getTodoistCooldown(identity), laterUntil);
  assert.equal(await assertTodoistAccountNotCooling("home", state,
    async () => "unrelated-token"), todoistAccountIdentity("unrelated-token"));
  await assert.rejects(() => assertTodoistAccountNotCooling("home", state,
    async () => token), error => error.code === "todoist_account_cooldown");
  await assert.rejects(state.getTodoistCooldown("not-an-account-token"), /Invalid Todoist account identity/);
});
