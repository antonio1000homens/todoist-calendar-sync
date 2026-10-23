import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ReviewStore } from "../dist/review-store.js";
import { retainedConflictIdentity } from "../dist/audit-policy.js";
import { reviewHash } from "../dist/review-store.js";

test("active conflict incidents seed an indexed durable review case from the retained audit row", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  const sent = [];
  const detail = { taskId: "task-1", eventId: "event-1", mismatchCategories:["title_mismatch"],
    taskUpdatedAt:"2026-10-22T10:00:00Z", calendarEtag:"etag-1" };
  const action = "todoist_snapshot_reconcile_unmapped_conflict";
  const fingerprint = retainedConflictIdentity(action, detail);
  const audit = { pk: "AUDIT#home#CONFLICT#fingerprint#incident", action: "todoist_snapshot_reconcile_unmapped_conflict",
    detail, createdAt: "2026-10-22T10:00:00.000Z" };
  const id = `incident-${reviewHash(audit.pk).slice(0,32)}`;
  t.mock.method(documentClient, "send", async (command) => {
    sent.push(command);
    if (command instanceof GetCommand) return { Item: { id, profile:"home", status:"open", sourceAuditKey:audit.pk,
      conflictKey:reviewHash(retainedConflictIdentity(action,detail)) } };
    return {};
  });

  await new ReviewStore().observeConflictIncident("home", fingerprint, "incident", audit);

  const caseRow = sent.find(command => command instanceof PutCommand && command.input.Item.pk.startsWith("REVIEW_CASE#"));
  const pointer = sent.find(command => command instanceof PutCommand && command.input.Item.pk.startsWith("REVIEW_CONFLICT#"));
  assert.ok(caseRow);
  assert.equal(caseRow.input.Item.lookupPk, "PROFILE#home");
  assert.match(caseRow.input.Item.lookupSk, /^REVIEW#OPEN#/);
  assert.equal(caseRow.input.Item.taskId, "task-1");
  assert.equal(caseRow.input.Item.eventId, "event-1");
  assert.equal(caseRow.input.Item.sourceAuditKey, audit.pk);
  assert.equal(pointer.input.Item.pk, `REVIEW_CONFLICT#home#${reviewHash(fingerprint)}`);
});

test("dismissed manual choices remain history while completed repairs are resolved cases",async(t)=>{
  process.env.STATE_TABLE_NAME="review-seed-test";
  const sent=[];
  t.mock.method(ReviewStore.prototype,"getCase",async()=>undefined);
  t.mock.method(documentClient,"send",async command=>{sent.push(command);return {};});
  const decision=(decisionId,resolution)=>({
    decisionId,profile:"home",type:"todoist_unmapped_conflict",severity:"warning",status:"resolved",
    resolution,createdAt:"2026-10-22T10:00:00.000Z",decisionDeadline:"2026-10-23T10:00:00.000Z",
    context:{},fingerprint:decisionId,permittedActions:[],
  });
  await new ReviewStore().observeDecision(decision("dismissed","keep_separate"));
  await new ReviewStore().observeDecision(decision("repaired","link"));
  assert.equal(sent[0].input.Item.status,"dismissed");
  assert.match(sent[0].input.Item.lookupSk,/^REVIEW#CLOSED#/);
  assert.equal(sent[1].input.Item.status,"resolved");
  assert.match(sent[1].input.Item.lookupSk,/^REVIEW#CLOSED#/);
});

test("an open manual decision coalesces its matching audit incident while retaining the incident row", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  const sent = [];
  const conflictKey = "same-conflict-state";
  const incident = { id:"incident-old", profile:"home", status:"open", conflictKey, createdAt:"2026-10-22T10:00:00.000Z" };
  t.mock.method(ReviewStore.prototype, "getCase", async id => id === "incident-old" ? incident : undefined);
  t.mock.method(documentClient, "send", async (command) => {
    sent.push(command);
    if (command instanceof QueryCommand && command.input.KeyConditionExpression.startsWith("pk =")) return { Items: [{incidentId:"incident-old"}] };
    if (command instanceof QueryCommand) return { Items: [] };
    return {};
  });
  const decision = { decisionId:"home-conflict", profile:"home", type:"todoist_unmapped_conflict", severity:"warning",
    status:"pending", createdAt:"2026-10-23T10:00:00.000Z", decisionDeadline:"2026-10-30T10:00:00.000Z",
    context:{ conflictKey }, fingerprint:"decision-fingerprint", permittedActions:[], taskId:"task-1", eventId:"event-1" };

  await new ReviewStore().observeDecision(decision);

  const decisionCase = sent.find(command => command instanceof PutCommand && command.input.Item.id === decision.decisionId);
  assert.ok(decisionCase);
  assert.equal(decisionCase.input.Item.conflictKey, conflictKey,
    "the conflict key stored on the review case is read from the same decision context used by createDecision");
  const coalescing = sent.find((command) => command instanceof UpdateCommand);
  assert.ok(coalescing);
  assert.equal(coalescing.input.Key.pk, "REVIEW_CASE#incident-old");
  assert.equal(coalescing.input.ExpressionAttributeValues[":keeper"], decision.decisionId);
  assert.match(coalescing.input.UpdateExpression, /coalescedInto/);
});

test("a legacy incident coalesces only when its retained audit proves the exact conflict revision", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  const sent = [];
  const action = "todoist_snapshot_reconcile_unmapped_conflict";
  const detail = { taskId:"task-1", eventId:"event-1", mismatchCategories:["title_mismatch"],
    taskUpdatedAt:"2026-10-22T10:00:00.000Z", calendarUpdatedAt:"2026-10-22T10:01:00.000Z", calendarEtag:"etag-1" };
  const conflictKey = reviewHash(retainedConflictIdentity(action, detail));
  const auditKey = "AUDIT#home#legacy";
  t.mock.method(ReviewStore.prototype, "getCase", async () => undefined);
  t.mock.method(documentClient, "send", async (command) => {
    sent.push(command);
    if (command instanceof QueryCommand && command.input.KeyConditionExpression.startsWith("pk =")) return { Items: [] };
    if (command instanceof QueryCommand) return { Items: [{ id:"incident-legacy", profile:"home", status:"open",
      taskId:"task-1", eventId:"event-1", reason:action, sourceAuditKey:auditKey, createdAt:"2026-10-22T10:02:00.000Z" }] };
    if (command instanceof GetCommand) return { Item: { pk:auditKey, action, detail } };
    return {};
  });
  const decision = { decisionId:"home-conflict", profile:"home", type:"todoist_unmapped_conflict", severity:"warning",
    status:"pending", createdAt:"2026-10-23T10:00:00.000Z", decisionDeadline:"2026-10-30T10:00:00.000Z",
    context:{ conflictKey }, fingerprint:"decision-fingerprint", permittedActions:[], taskId:"task-1", eventId:"event-1" };

  await new ReviewStore().observeDecision(decision);

  const coalescing = sent.find(command => command instanceof UpdateCommand);
  assert.ok(coalescing, "matching legacy incident should be dismissed");
  assert.equal(coalescing.input.Key.pk, "REVIEW_CASE#incident-legacy");
  assert.equal(coalescing.input.ExpressionAttributeValues[":conflictKey"], conflictKey);
  assert.match(coalescing.input.ConditionExpression, /sourceAuditKey = :sourceAuditKey/);
  assert.equal(coalescing.input.ExpressionAttributeValues[":sourceAuditKey"], auditKey);
});

test("legacy incident fallback keeps changed revisions and categories distinct", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  const sent = [];
  const action = "todoist_snapshot_reconcile_unmapped_conflict";
  const current = { taskId:"task-1", eventId:"event-1", mismatchCategories:["title_mismatch"],
    taskUpdatedAt:"2026-10-23T10:00:00.000Z", calendarUpdatedAt:"2026-10-23T10:01:00.000Z", calendarEtag:"etag-2" };
  const oldRevision = { ...current, taskUpdatedAt:"2026-10-22T10:00:00.000Z", calendarUpdatedAt:"2026-10-22T10:01:00.000Z", calendarEtag:"etag-1" };
  const oldCategory = { ...current, mismatchCategories:["start_mismatch"] };
  const audits = new Map([
    ["AUDIT#home#old-revision", { pk:"AUDIT#home#old-revision", action, detail:oldRevision }],
    ["AUDIT#home#old-category", { pk:"AUDIT#home#old-category", action, detail:oldCategory }],
  ]);
  const currentKey = reviewHash(retainedConflictIdentity(action, current));
  t.mock.method(ReviewStore.prototype, "getCase", async () => undefined);
  t.mock.method(documentClient, "send", async (command) => {
    sent.push(command);
    if (command instanceof QueryCommand && command.input.KeyConditionExpression.startsWith("pk =")) return { Items: [] };
    if (command instanceof QueryCommand) return { Items: [
      { id:"incident-old-revision", profile:"home", status:"open", sourceAuditKey:"AUDIT#home#old-revision", createdAt:"2026-10-22T10:02:00.000Z" },
      { id:"incident-old-category", profile:"home", status:"open", sourceAuditKey:"AUDIT#home#old-category", createdAt:"2026-10-22T10:03:00.000Z" },
    ] };
    if (command instanceof GetCommand) return { Item:audits.get(command.input.Key.pk) };
    return {};
  });
  const decision = { decisionId:"home-conflict", profile:"home", type:"todoist_unmapped_conflict", severity:"warning",
    status:"pending", createdAt:"2026-10-23T10:00:00.000Z", decisionDeadline:"2026-10-30T10:00:00.000Z",
    context:{ conflictKey:currentKey }, fingerprint:"decision-fingerprint", permittedActions:[], taskId:"task-1", eventId:"event-1" };

  await new ReviewStore().observeDecision(decision);

  assert.equal(sent.some(command => command instanceof UpdateCommand), false,
    "legacy incidents with a different revision or conflict category remain open");
});

test("conditional decision-put races re-read the winner before coalescing", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  for (const winner of [
    { status:"dismissed", conflictKey:"same" },
    { status:"open", conflictKey:"different" },
  ]) {
    const sent = [];
    let reads = 0;
    t.mock.method(ReviewStore.prototype, "getCase", async () => ++reads === 1 ? undefined : winner);
    t.mock.method(documentClient, "send", async command => {
      sent.push(command);
      if (command instanceof PutCommand) throw Object.assign(new Error("race"), { name:"ConditionalCheckFailedException" });
      return {};
    });
    const decision = { decisionId:`decision-${winner.status}-${winner.conflictKey}`, profile:"home", type:"todoist_unmapped_conflict",
      severity:"warning", status:"pending", createdAt:"2026-10-23T10:00:00.000Z", decisionDeadline:"2026-10-30T10:00:00.000Z",
      context:{ conflictKey:"same" }, fingerprint:"decision-fingerprint", permittedActions:[] };
    await new ReviewStore().observeDecision(decision);
    assert.equal(sent.some(command => command instanceof QueryCommand), false,
      "terminal or changed-identity winner must not trigger coalescing");
    t.mock.reset();
  }
});

test("new conflict coalescing uses a strongly consistent base-table pointer without a GSI read", async (t) => {
  process.env.STATE_TABLE_NAME = "review-seed-test";
  const conflictKey = "durable-conflict";
  const sent = [];
  const incident = { id:"incident-durable", profile:"home", status:"open", conflictKey,
    createdAt:"2026-10-22T10:00:00.000Z" };
  t.mock.method(ReviewStore.prototype, "getCase", async id => id === incident.id ? incident : undefined);
  t.mock.method(documentClient, "send", async command => {
    sent.push(command);
    if (command instanceof QueryCommand) return { Items:[{incidentId:incident.id}] };
    return {};
  });
  const decision = { decisionId:"decision-durable", profile:"home", type:"todoist_unmapped_conflict", severity:"warning",
    status:"pending", createdAt:"2026-10-23T10:00:00.000Z", decisionDeadline:"2026-10-30T10:00:00.000Z",
    context:{conflictKey}, fingerprint:"decision-fingerprint", permittedActions:[] };
  await new ReviewStore().observeDecision(decision);
  const lookup = sent.find(command => command instanceof QueryCommand);
  assert.equal(lookup.input.ConsistentRead, true);
  assert.equal(lookup.input.IndexName, undefined);
  assert.equal(lookup.input.ExpressionAttributeValues[":pk"], `REVIEW_CONFLICT#home#${conflictKey}`);
  assert.equal(sent.some(command => command instanceof UpdateCommand), true);
});
