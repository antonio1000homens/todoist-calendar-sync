import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";
import { assertTodoistAccountNotCooling } from "../dist/worker.js";
import { Todoist, todoistAccountIdentity, withTodoistCooldownStore } from "../dist/providers.js";
import { ReconciliationItemError } from "../dist/reconciliation-diagnostics.js";
import { failedDeliveryDisposition, providerRetryAfterMs } from "../dist/sqs-failure-policy.js";

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

test("actual failing cross-profile credential persists 1280s cooldown before returning and other accounts proceed", async t => {
  const rows = new Map(), requests = [], extensions = [];
  const store = {
    async getTodoistCooldown(id) { return rows.get(id); },
    async extendTodoistCooldown(id, until) {
      extensions.push(id);
      rows.set(id,Math.max(rows.get(id)||0,until));
    },
  };
  const a = "528-origin", b = "528-discovery";
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const token = new Headers(init.headers).get("authorization");
    requests.push(token);
    if (token === "Bearer "+b)
      return Response.json({error_tag:"LIMITS_REACHED",error_extra:{retry_after:1280}},{status:429});
    return Response.json({id:"task",content:"unaffected"});
  });
  let wrapped;
  await withTodoistCooldownStore(store,async () => {
    await new Todoist(a).getTask("task");
    try { await new Todoist(b).getTimeZone(); }
    catch (error) { wrapped = new ReconciliationItemError(error,{stage:"calendar"}); }
    assert.ok(wrapped);
    assert.equal(wrapped.cause.todoistAccountIdentity,todoistAccountIdentity(b));
    assert.equal(wrapped.cause.provider,"todoist");
    assert.ok(providerRetryAfterMs(wrapped) >= 1_279_000);
    assert.equal(failedDeliveryDisposition(wrapped,{kind:"calendar"},false,5).kind,"retry_fifo");
  });
  assert.deepEqual(extensions,[todoistAccountIdentity(b)]);
  assert.equal(rows.has(todoistAccountIdentity(a)),false);
  await Promise.all([
    withTodoistCooldownStore(store,() => assert.rejects(new Todoist(b).getTask("task"),{code:"todoist_account_cooldown"})),
    withTodoistCooldownStore(store,() => new Todoist(a).getTask("task")),
  ]);
  assert.equal(requests.filter(token => token === "Bearer "+b).length,1);
  assert.equal(requests.filter(token => token === "Bearer "+a).length,2);
  assert.equal(extensions.length,1,"suppressed requests must not extend an existing cooldown");
});
