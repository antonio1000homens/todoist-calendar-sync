#!/usr/bin/env node
/**
 * Issue #113: deliberately destructive, out-of-band item erasure.
 *
 * This command does NOT run in normal reconciliation, and never logs a
 * retained audit entry. Execution requires a fresh full-table preview and
 * explicit, action-time confirmation. Run only with ingress/worker deliveries
 * stopped and the relevant FIFO/DLQ deliveries drained.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { profiles } from "../dist/config.js";
import { defaultProviderClientFactory } from "../dist/mutation-budget.js";
import { buildProjectMappingIndex, LEGACY_TASK_COMMENT_MARKERS } from "../dist/mapping-comments.js";
import { fingerprint, planPurge } from "./item-purge-policy.mjs";

const argumentsMap = new Map();
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith("--") || (argument.includes("=") && argument.indexOf("=") < 3)) throw new Error("Invalid command argument");
  const [key, ...rest] = argument.slice(2).split("=");
  if (argumentsMap.has(key)) throw new Error("Duplicate argument: " + key);
  argumentsMap.set(key, rest.length ? rest.join("=") : true);
}
const allowed = new Set(["profile", "task-id", "event-id", "delete-calendar", "apply",
  "confirm", "confirm-task", "confirm-calendar", "ack-deliveries-quiesced"]);
for (const name of argumentsMap.keys()) if (!allowed.has(name)) throw new Error("Unknown argument: " + name);
const stringArg = name => typeof argumentsMap.get(name) === "string" ? argumentsMap.get(name) : undefined;
const flag = name => argumentsMap.get(name) === true;
const profile = stringArg("profile"), taskId = stringArg("task-id"), eventId = stringArg("event-id");
const table = process.env.STATE_TABLE_NAME?.trim();
if (!table) throw new Error("STATE_TABLE_NAME must be explicitly configured");
if (!profile || !taskId) throw new Error("--profile and --task-id are required");
if (flag("delete-calendar") && !eventId) throw new Error("Calendar deletion requires an exact --event-id");
if (argumentsMap.has("delete-calendar") && !flag("delete-calendar")) throw new Error("--delete-calendar is a flag");
if (argumentsMap.has("apply") && !flag("apply")) throw new Error("--apply is a flag");
if (flag("apply") !== Boolean(stringArg("confirm"))) throw new Error("A confirmation token is only valid with --apply");
if (!flag("apply") && ["confirm-task", "confirm-calendar", "ack-deliveries-quiesced"].some(name => argumentsMap.has(name)))
  throw new Error("Action-time confirmations are only valid with --apply");
const target = { profile, taskId, ...(eventId ? {eventId} : {}) };
planPurge([], target); // Validate the exact selectors before any external calls.
const raw = new DynamoDBClient({ maxAttempts: 5, retryMode: "standard" });
const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function send(command) {
  for (let attempt = 0; attempt < 7; attempt++) {
    try { return await db.send(command); }
    catch (error) {
      if (!["ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded"].includes(error?.name) || attempt === 6) throw error;
      await sleep(Math.min(8000, 250 * 2 ** attempt));
    }
  }
  throw new Error("DynamoDB retry budget exhausted");
}
async function scan() {
  let cursor, scanned = 0;
  const rows = [];
  do {
    const data = await send(new ScanCommand({
      TableName:table, ConsistentRead:true, Limit:25, ExclusiveStartKey:cursor, ReturnConsumedCapacity:"TOTAL",
    }));
    rows.push(...(data.Items || []));
    scanned += data.ScannedCount || 0;
    cursor = data.LastEvaluatedKey;
    if (cursor) await sleep(Math.max(250, Math.ceil(Number(data.ConsumedCapacity?.CapacityUnits || 0) * 100)));
  } while (cursor);
  return { rows, scanned };
}
const clients = await defaultProviderClientFactory(profile);
const gone = error => [404,410].includes(Number(error?.status));
async function readTask() {
  try { return await clients.todoist.getTask(taskId); }
  catch (error) { if (gone(error)) return null; throw error; }
}
async function readEvent() {
  if (!eventId) return null;
  try {
    const result = await clients.calendar.getEvent(eventId);
    return result.status === "cancelled" ? null : result;
  } catch (error) { if (gone(error)) return null; throw error; }
}
async function providers() {
  const [task, event, linked, projectComments] = await Promise.all([
    readTask(), readEvent(), clients.calendar.findByTodoistTaskId(taskId),
    clients.todoist.listProjectComments(profiles[profile].todoistProjectId, true),
  ]);
  const indexed = buildProjectMappingIndex(projectComments);
  const relevant = indexed.parsed.filter(item => item.payload.taskId === taskId || item.payload.eventId === eventId);
  const malformed = indexed.malformed.filter(item =>
    item.comment.content?.includes(taskId) || (eventId && item.comment.content?.includes(eventId)));
  let legacy = [];
  if (task) {
    const comments = await clients.todoist.listTaskComments(taskId);
    legacy = comments.filter(comment => {
      const lines = String(comment.content || "").split(/\r?\n/);
      return LEGACY_TASK_COMMENT_MARKERS.has(lines[0]);
    }).map(comment => ({id:comment.id,content:comment.content,taskId,
      eventId:String(comment.content || "").split(/\r?\n/).find(line => line.startsWith("calendarEventId="))?.slice("calendarEventId=".length)}));
  }
  return {
    task,event,linked:linked?.status === "cancelled" ? null : linked,
    comments:relevant.map(item => ({id:item.comment.id,content:item.comment.content,profile:item.payload.profile,
      taskId:item.payload.taskId,eventId:item.payload.eventId,seriesId:item.payload.seriesId})),
    legacy,malformed:malformed.map(item=>({id:item.comment.id,error:item.error})),
  };
}
function providerBlockers(data) {
  const blocks = [];
  if (data.task?.id !== undefined && data.task.id !== taskId) blocks.push("Todoist returned a different task identity");
  if (data.task?.project_id !== undefined && data.task.project_id !== profiles[profile].todoistProjectId)
    blocks.push("Task belongs to a different Todoist project");
  if (data.event?.id !== undefined && data.event.id !== eventId) blocks.push("Calendar returned a different event identity");
  if (data.task?.due?.is_recurring) blocks.push("Recurring Todoist task: series must be investigated manually");
  if (data.event?.recurrence?.length || data.event?.recurringEventId)
    blocks.push("Recurring Calendar item: series/exception requires manual handling");
  if (data.event && !flag("delete-calendar")) blocks.push("Calendar item exists; select and confirm its exact deletion or handle re-import risk manually");
  if (data.event?.extendedProperties?.shared?.taskId && data.event.extendedProperties.shared.taskId !== taskId)
    blocks.push("Selected Calendar event is linked to a different Todoist task");
  if (data.linked && (!eventId || data.linked.id !== eventId))
    blocks.push("Another Calendar projection links to this task; manual inspection required");
  if (data.linked && !flag("delete-calendar"))
    blocks.push("A live Calendar projection would recreate the Todoist task unless separately deleted");
  if (data.linked?.recurrence?.length || data.linked?.recurringEventId)
    blocks.push("Linked Calendar recurrence needs manual handling");
  if (data.comments.some(item => item.profile !== profile || item.taskId !== taskId || item.eventId !== eventId || item.seriesId))
    blocks.push("Project mapping comment belongs to another item or recurrence");
  if (data.malformed.length) blocks.push("Unparseable mapping comments contain the selected identity");
  if (data.legacy.some(item => !eventId || item.eventId !== eventId))
    blocks.push("Legacy task comments refer to another or unknown Calendar event");
  return blocks;
}
function output(data) { console.log(JSON.stringify(data, null, 2)); }
function publicRecord(record) {
  return {pk:record.pk,sk:record.sk,type:record.type,reasons:record.reasons,hazards:record.hazards};
}
try {
  const [initialScan, observed] = await Promise.all([scan(), providers()]);
  const plan = planPurge(initialScan.rows,target);
  const blockers = [...plan.blockers, ...providerBlockers(observed)];
  // Providers are read again after any mutation, but preflight must not guess
  // missing Calendar identities from title/date matches.
  const token = fingerprint({
    target, table, deleteCalendar:flag("delete-calendar"),
    inventoryDigest:plan.inventoryDigest,
    providerDigest:fingerprint(observed),
  }).slice(0,24);
  output({
    mode:flag("apply") ? "apply" : "preview", target, table,
    selectedActions:{deleteTodoist:true,deleteCalendar:flag("delete-calendar")},
    providerBefore:{todoist:observed.task ? {id:observed.task.id,title:observed.task.content,updatedAt:observed.task.updated_at} : null,
      calendar:observed.event ? {id:observed.event.id,title:observed.event.summary,etag:observed.event.etag} : null,
      linkedCalendar:observed.linked ? {id:observed.linked.id,status:observed.linked.status} : null,
      matchingMappingComments:observed.comments.map(item=>item.id),matchingLegacyComments:observed.legacy.map(item=>item.id)},
    scanned:initialScan.scanned, records:plan.records.map(publicRecord), blockers,
    warning:"PURGE PERMANENTLY REMOVES AUDIT/HISTORY AND DISABLES HISTORICAL REPAIR/FORENSICS. Untagged delivery receipts or redacted historical records cannot be proven attributable; manually inspect queued deliveries and backups.",
    ...(blockers.length ? {} : {actionTimeConfirmation:"PERMANENTLY_ERASE_" + token}),
  });
  if (!flag("apply")) process.exit(0);
  if (blockers.length) throw new Error("Refused: unsafe or shared state in preview");
  if (stringArg("confirm") !== "PERMANENTLY_ERASE_" + token) throw new Error("Inventory/provider state changed or confirmation token is invalid. Preview again.");
  if (stringArg("confirm-task") !== taskId) throw new Error("Action-time Todoist task ID confirmation required");
  if (flag("delete-calendar") && stringArg("confirm-calendar") !== eventId) throw new Error("Separate exact Calendar ID confirmation required");
  if (!flag("ack-deliveries-quiesced")) throw new Error("Stop ingress/worker, drain relevant FIFO and DLQ, then provide --ack-deliveries-quiesced");
  // Explicit second fresh read at action time. No changes are permitted between
  // the displayed preview and the first provider mutation.
  const [secondScan, secondProvider] = await Promise.all([scan(),providers()]);
  const secondPlan = planPurge(secondScan.rows,target);
  if (secondPlan.inventoryDigest !== plan.inventoryDigest || fingerprint(secondProvider) !== fingerprint(observed)
    || secondPlan.blockers.length || providerBlockers(secondProvider).length)
    throw new Error("Stale inventory or provider snapshot; no changes made. Preview again.");
  const result = {deletedProvider:[],alreadyAbsent:[],deletedComments:[],deletedState:[],partialFailure:null};
  try {
    // Provider mapping comments are durable reverse indexes. Clear only rows
    // whose validated payload matches this exact task/event selection, and
    // never leave breadcrumbs that can rebuild the erased Dynamo mappings.
    for (const comment of [...secondProvider.comments,...secondProvider.legacy]) {
      const current = await clients.todoist.getComment(comment.id);
      if (current.content !== comment.content) throw new Error("Mapping comment changed since inventory");
      await clients.todoist.deleteComment(comment.id);
      result.deletedComments.push(comment.id);
    }
    if (secondProvider.task) {
      try { await clients.todoist.deleteTask(taskId); result.deletedProvider.push("todoist"); }
      catch (error) { if (!gone(error)) throw error; result.alreadyAbsent.push("todoist"); }
    } else result.alreadyAbsent.push("todoist");
    if (flag("delete-calendar") && secondProvider.event) {
      try { await clients.calendar.deleteEvent(eventId); result.deletedProvider.push("calendar"); }
      catch (error) { if (!gone(error)) throw error; result.alreadyAbsent.push("calendar"); }
    } else if (eventId) result.alreadyAbsent.push("calendar");
    const afterProviders = await providers();
    if (afterProviders.task || afterProviders.event || afterProviders.linked || afterProviders.comments.length || afterProviders.legacy.length)
      throw new Error("Provider post-read is not absent: DynamoDB purge was not started");
    // Re-inventory after provider writes. Providers can generate late deliveries.
    const afterScan = await scan();
    const afterPlan = planPurge(afterScan.rows, target);
    if (afterPlan.blockers.length || afterPlan.inventoryDigest !== plan.inventoryDigest)
      throw new Error("State changed after provider deletion: inspect fresh preview and resume; no DB rows were deleted");
    // Verify each full row immediately before deleting. Compare every attribute
    // conditionally to reject concurrent writes even when updatedAt is absent.
    for (const record of afterPlan.records.sort((a,b) => Number(a.type === "SYNC_CONTROL") - Number(b.type === "SYNC_CONTROL"))) {
      const expected = afterScan.rows.find(row => row.pk === record.pk && row.sk === record.sk);
      const current = await send(new GetCommand({TableName:table, Key:{pk:record.pk,sk:record.sk}, ConsistentRead:true}));
      if (!current.Item) continue; // idempotent after a partial previous run
      if (fingerprint(current.Item) !== record.digest) throw new Error("Concurrent state change while deleting " + record.type);
      const attrs = Object.entries(expected).filter(([key])=> key !== "pk" && key !== "sk");
      const names = Object.fromEntries(attrs.map(([key],i)=>["#a"+i,key]));
      const values = Object.fromEntries(attrs.map(([,val],i)=>[":v"+i,val]));
      await send(new DeleteCommand({ TableName:table, Key:{pk:record.pk,sk:record.sk},
        ConditionExpression:["attribute_exists(pk)",...attrs.map(([,],i)=>"#a"+i+" = :v"+i)].join(" AND "),
        ExpressionAttributeNames:Object.keys(names).length?names:undefined,
        ExpressionAttributeValues:Object.keys(values).length?values:undefined,
      }));
      result.deletedState.push({pk:record.pk,sk:record.sk,type:record.type});
      await sleep(120); // avoid exhausting limited provisioned WCU
    }
    // Double-check provider AND strongly-consistent state after writes.
    for (let check=0;check<2;check++) {
      const [remaining, checkProviders] = await Promise.all([scan(),providers()]);
      const leftover = planPurge(remaining.rows,target);
      if (leftover.records.length || checkProviders.task || checkProviders.event || checkProviders.linked || checkProviders.comments.length || checkProviders.legacy.length) {
        throw new Error("Postflight detected retained or late-arriving state; inspect and resume");
      }
      if (!check) await sleep(500);
    }
    output({status:"succeeded",deletedProvider:result.deletedProvider,alreadyAbsent:result.alreadyAbsent,deletedComments:result.deletedComments,deletedState:result.deletedState,
      retainedPerItemOperationRecord:false});
  } catch (error) {
    output({status:"partial_failure",deletedProvider:result.deletedProvider,alreadyAbsent:result.alreadyAbsent,
      deletedComments:result.deletedComments,deletedState:result.deletedState, error:error instanceof Error?error.message:String(error),
      nextAction:"Keep delivery ingress/workers paused. Rerun PREVIEW with the same exact IDs, inspect and confirm the NEW token to resume. Do not reconcile yet."});
    process.exitCode = 2;
  }
} finally {
  db.destroy();
}
