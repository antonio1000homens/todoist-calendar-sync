#!/usr/bin/env node
/**
 * Issue #113: deliberately destructive, out-of-band item erasure.
 *
 * This command does NOT run in normal reconciliation, and never logs a
 * retained audit entry. Execution requires a fresh full-table preview and
 * explicit, action-time confirmation. Execution disables the worker SQS event
 * source, acquires a DynamoDB admission fence, and waits for verifiable writer
 * and enqueue leases to drain. Pending messages are retained and replayed only
 * after provider reads confirm erased objects are absent.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand, GetEventSourceMappingCommand, GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { profiles } from "../dist/config.js";
import { defaultProviderClientFactory } from "../dist/mutation-budget.js";
import { buildProjectMappingIndex, LEGACY_TASK_COMMENT_MARKERS } from "../dist/mapping-comments.js";
import { beginErasureFence, finishErasureProtocol, inspectErasureFence } from "../dist/erasure-protocol.js";
import { restoreMappings } from "./erasure-mappings.mjs";
import { fingerprint, planPurge, publicInventoryRecord } from "./item-purge-policy.mjs";

const argumentsMap = new Map();
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith("--") || (argument.includes("=") && argument.indexOf("=") < 3)) throw new Error("Invalid command argument");
  const [key, ...rest] = argument.slice(2).split("=");
  if (argumentsMap.has(key)) throw new Error("Duplicate argument: " + key);
  argumentsMap.set(key, rest.length ? rest.join("=") : true);
}
const allowed = new Set(["profile", "task-id", "event-id", "delete-calendar", "apply",
  "confirm", "confirm-task", "confirm-calendar", "worker-function", "ingress-function",
  "operation-id",
  "inventory-only", "preserve-task", "protect-event-ids"]);
for (const name of argumentsMap.keys()) if (!allowed.has(name)) throw new Error("Unknown argument: " + name);
const stringArg = name => typeof argumentsMap.get(name) === "string" ? argumentsMap.get(name) : undefined;
const flag = name => argumentsMap.get(name) === true;
const profile = stringArg("profile"), taskId = stringArg("task-id"), eventId = stringArg("event-id");
const inventoryOnly = flag("inventory-only");
const preserveTask = flag("preserve-task");
const protectedEventIds = (stringArg("protect-event-ids") || "").split(",").filter(Boolean);
for (const name of ["inventory-only", "preserve-task", "delete-calendar", "apply"])
  if (argumentsMap.has(name) && !flag(name)) throw new Error("--" + name + " is a flag");
if (argumentsMap.has("protect-event-ids") && (!stringArg("protect-event-ids")
  || protectedEventIds.some(id => !/^[A-Za-z0-9_.-]{1,1024}$/.test(id))))
  throw new Error("--protect-event-ids must be a comma-separated list of exact Calendar IDs");
if (flag("apply") && (preserveTask || protectedEventIds.length))
  throw new Error("Protected-item inventory is read-only; no destructive executor supports preserved-item selection");
if (inventoryOnly && flag("apply")) throw new Error("--inventory-only never supports apply");
if (inventoryOnly && flag("delete-calendar")) throw new Error("--inventory-only cannot request a provider deletion");
if ((preserveTask || protectedEventIds.length) && !inventoryOnly)
  throw new Error("--preserve-task and --protect-event-ids require --inventory-only");
const table = process.env.STATE_TABLE_NAME?.trim();
if (!table) throw new Error("STATE_TABLE_NAME must be explicitly configured");
if (!profile || !taskId) throw new Error("--profile and --task-id are required");
if (flag("delete-calendar") && !eventId) throw new Error("Calendar deletion requires an exact --event-id");
if (argumentsMap.has("delete-calendar") && !flag("delete-calendar")) throw new Error("--delete-calendar is a flag");
if (argumentsMap.has("apply") && !flag("apply")) throw new Error("--apply is a flag");
if (flag("apply") !== Boolean(stringArg("confirm"))) throw new Error("A confirmation token is only valid with --apply");
if (!flag("apply") && ["confirm-task", "confirm-calendar"].some(name => argumentsMap.has(name)))
  throw new Error("Action-time confirmations are only valid with --apply");
const target = { profile, taskId, ...(eventId ? {eventId} : {}), ...(preserveTask ? {preserveTask:true} : {}),
  ...(protectedEventIds.length ? {protectedEventIds} : {}) };
planPurge([], target); // Validate the exact selectors before any external calls.
const raw = new DynamoDBClient({ maxAttempts: 5, retryMode: "standard" });
const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const lambda = new LambdaClient({});
const workerFunction = stringArg("worker-function");
const ingressFunction = stringArg("ingress-function");
const journalKey = { pk: `ERASURE#${profile}`, sk: "JOURNAL" };
const protocolRows = rows => rows.filter(row => row.pk !== journalKey.pk);
const activeJournal = async () => (await send(new GetCommand({TableName:table,Key:journalKey,ConsistentRead:true}))).Item;
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
  return { rows:protocolRows(rows), scanned };
}
async function verifyProtocolDeployment() {
  if (!workerFunction || !ingressFunction) throw new Error("--worker-function and --ingress-function are required for apply");
  const configurations = await Promise.all([workerFunction, ingressFunction].map(FunctionName =>
    lambda.send(new GetFunctionConfigurationCommand({ FunctionName }))));
  for (const configuration of configurations) {
    if (configuration.Environment?.Variables?.ERASURE_PROTOCOL_VERSION !== "1")
      throw new Error("Ingress and worker must run erasure protocol version 1 before applying this purge");
  }
  const mappings = (await lambda.send(new ListEventSourceMappingsCommand({ FunctionName:workerFunction, MaxItems:100 }))).EventSourceMappings || [];
  const sqsMappings = mappings.filter(mapping => mapping.EventSourceArn?.includes(":sqs:") && mapping.UUID);
  if (!sqsMappings.length) throw new Error("No SQS event-source mapping was found for the worker function");
  return { mappings:sqsMappings, timeoutSeconds:Math.max(...configurations.map(item=>Number(item.Timeout || 3))) };
}
async function disableWorkerMappings(mappings) {
  const enabled = mappings.filter(mapping => mapping.State === "Enabled").map(mapping => mapping.UUID);
  await Promise.all(enabled.map(UUID => lambda.send(new UpdateEventSourceMappingCommand({UUID,Enabled:false}))));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await Promise.all(mappings.map(mapping => lambda.send(new GetEventSourceMappingCommand({UUID:mapping.UUID}))));
    if (current.every(mapping => mapping.State === "Disabled")) return enabled;
    await sleep(1000);
  }
  throw new Error("Worker SQS event source did not reach Disabled state; no purge writes were started");
}
async function waitForLeaseDrain() {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const state = await inspectErasureFence(profile);
    if (!state.leases.length) return;
    await sleep(1000);
  }
  throw new Error("Admission or writer leases did not drain; keep the worker event source disabled and investigate before resuming");
}
async function restoreWorkerMappings(mappingIds) {
  return restoreMappings(mappingIds, {
    update: UUID => lambda.send(new UpdateEventSourceMappingCommand({UUID,Enabled:true})),
    get: UUID => lambda.send(new GetEventSourceMappingCommand({UUID})),
    pause: sleep,
  });
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
  if (data.task?.due?.is_recurring && !inventoryOnly) blocks.push("Recurring Todoist task: series must be investigated manually");
  if (data.event?.recurrence?.length || data.event?.recurringEventId)
    blocks.push("Recurring Calendar item: series/exception requires manual handling");
  if (data.event && !flag("delete-calendar") && !inventoryOnly) blocks.push("Calendar item exists; select and confirm its exact deletion or handle re-import risk manually");
  if (data.event?.extendedProperties?.shared?.taskId && data.event.extendedProperties.shared.taskId !== taskId)
    blocks.push("Selected Calendar event is linked to a different Todoist task");
  if (data.linked && (!eventId || data.linked.id !== eventId))
    blocks.push("Another Calendar projection links to this task; manual inspection required");
  if (data.linked && !flag("delete-calendar") && !inventoryOnly)
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
function sameTarget(a, b) { return fingerprint(a) === fingerprint(b); }
function resumeInventoryMatches(plan, journal) {
  const expected = new Map((journal.records || []).map(record => [record.pk + "\n" + record.sk, record.digest]));
  return plan.records.every(record => expected.get(record.pk + "\n" + record.sk) === record.digest);
}
function resumeProviderSnapshotMatches(current, journal) {
  const expected = journal.provider || {};
  if (current.task && fingerprint(current.task) !== expected.taskDigest) return false;
  if (current.event && fingerprint(current.event) !== expected.eventDigest) return false;
  if (current.linked && fingerprint(current.linked) !== expected.linkedDigest) return false;
  const comments = new Map((expected.comments || []).map(item => [item.id, item.digest]));
  const legacy = new Map((expected.legacy || []).map(item => [item.id, item.digest]));
  return current.comments.every(item => comments.get(item.id) === fingerprint(item.content))
    && current.legacy.every(item => legacy.get(item.id) === fingerprint(item.content));
}
async function saveJournal(journal) {
  await send(new PutCommand({ TableName:table, Item:{...journal, ...journalKey, updatedAt:new Date().toISOString()},
    ConditionExpression:"attribute_not_exists(pk) OR operationId = :operationId",
    ExpressionAttributeValues:{":operationId":journal.operationId} }));
}
function output(data) { console.log(JSON.stringify(data, null, 2)); }
try {
  const [initialScan, observed, journal] = await Promise.all([scan(), providers(), activeJournal()]);
  const plan = planPurge(initialScan.rows,target);
  const mappings = workerFunction ? await verifyProtocolDeployment() : undefined;
  const mappingState = (mappings?.mappings || []).map(item => [item.UUID,item.State,item.EventSourceArn]).sort();
  const targetMatchesJournal = !journal || sameTarget(journal.target, target);
  const operationId = journal?.operationId || fingerprint({
    target, table, deleteCalendar:flag("delete-calendar"),
    inventoryDigest:plan.inventoryDigest, providerDigest:fingerprint(observed),
    workerFunction, ingressFunction,
  }).slice(0,24);
  const token = fingerprint({
    operationId, target, deleteCalendar:flag("delete-calendar"),
    inventoryDigest:plan.inventoryDigest, providerDigest:fingerprint(observed), mappingState,
  }).slice(0,24);
  const protocol = await inspectErasureFence(profile);
  const blockers = [...plan.blockers, ...providerBlockers(observed)];
  if (!targetMatchesJournal) blockers.push("A different item-erasure journal already owns this profile");
  if (protocol.fence && protocol.fence.operationId !== operationId) blockers.push("A different item-erasure operation owns the profile fence");
  if (journal && !resumeInventoryMatches(plan,journal)) blockers.push("Current state contains records outside the resumable inventory or changed record contents");
  if (journal && !resumeProviderSnapshotMatches(observed,journal)) blockers.push("Provider state changed from the resumable operation snapshot");
  if (journal && !protocol.fence) blockers.push("A resumable journal exists without its profile fence; inspect before continuing");
  if (flag("apply") && (!workerFunction || !ingressFunction)) blockers.push("Apply requires the exact deployed worker and ingress function names");
  output({
    mode:flag("apply") ? "apply" : inventoryOnly ? "inventory-only" : "preview", target, table,
    selectedActions:{deleteTodoist:!inventoryOnly && !preserveTask,deleteCalendar:!inventoryOnly && flag("delete-calendar")},
    providerBefore:{todoist:observed.task ? {id:observed.task.id,title:observed.task.content,updatedAt:observed.task.updated_at} : null,
      calendar:observed.event ? {id:observed.event.id,title:observed.event.summary,etag:observed.event.etag} : null,
      linkedCalendar:observed.linked ? {id:observed.linked.id,status:observed.linked.status} : null,
      matchingMappingComments:observed.comments.map(item=>item.id),matchingLegacyComments:observed.legacy.map(item=>item.id)},
    scanned:initialScan.scanned, classificationCounts:plan.counts, records:plan.records.map(publicInventoryRecord), blockers,
    operationId, admissionFence:{state:protocol.fence?.state || "not active",leases:protocol.leases.length},
    workerEventSources:mappingState,
    warning:"PURGE PERMANENTLY REMOVES AUDIT/HISTORY AND DISABLES HISTORICAL REPAIR/FORENSICS. Apply disables the SQS worker mapping, fences new queue admissions, drains verifiable writers, advances a persistent profile-only epoch so delayed old deliveries are dropped, and retains pending messages. Legacy receipts without identity refs remain blockers.",
    ...(blockers.length || inventoryOnly ? {} : {actionTimeConfirmation:"PERMANENTLY_ERASE_" + token}),
  });
  if (!flag("apply")) process.exit(0);
  if (blockers.length) throw new Error("Refused: unsafe or shared state in preview");
  if (stringArg("confirm") !== "PERMANENTLY_ERASE_" + token) throw new Error("Inventory/provider state changed or confirmation token is invalid. Preview again.");
  if (stringArg("operation-id") !== operationId) throw new Error("The reviewed operation ID must be supplied with --operation-id");
  if (stringArg("confirm-task") !== taskId) throw new Error("Action-time Todoist task ID confirmation required");
  if (flag("delete-calendar") && stringArg("confirm-calendar") !== eventId) throw new Error("Separate exact Calendar ID confirmation required");
  const deployment = await verifyProtocolDeployment();
  const currentMappings = deployment.mappings;
  const enabledMappings = journal?.enabledMappings || currentMappings.filter(item=>item.State === "Enabled").map(item=>item.UUID);
  if (!journal) {
    const taskComments = [...observed.comments,...observed.legacy];
    await saveJournal({
      operationId, target,
      records:plan.records.map(({pk,sk,type,digest})=>({pk,sk,type,digest})),
      provider:{
        taskDigest:observed.task ? fingerprint(observed.task) : undefined,
        eventDigest:observed.event ? fingerprint(observed.event) : undefined,
        linkedDigest:observed.linked ? fingerprint(observed.linked) : undefined,
        comments:observed.comments.map(item=>({id:item.id,digest:fingerprint(item.content)})),
        legacy:observed.legacy.map(item=>({id:item.id,digest:fingerprint(item.content)})),
      },
      enabledMappings, stage:"prepared",
    });
  }
  // Disable the SQS event source before fencing. An already-running worker
  // drains normally; a racing direct invocation is serialized by the fence
  // transaction and remains visible as a writer lease until its finally block.
  await disableWorkerMappings(currentMappings);
  await waitForLeaseDrain();
  await beginErasureFence(profile,operationId);
  // The fence covers protocol-aware executions. This wait also lets any
  // invocation that started before the deployment marker was checked reach
  // Lambda's hard timeout before provider deletion begins.
  await sleep((deployment.timeoutSeconds * 1000) + 2000);
  await waitForLeaseDrain();
  // Explicit second fresh read at action time. No changes are permitted between
  // the displayed preview and the first provider mutation.
  const [secondScan, secondProvider] = await Promise.all([scan(),providers()]);
  const secondPlan = planPurge(secondScan.rows,target);
  const currentJournal = await activeJournal();
  if (!currentJournal || currentJournal.operationId !== operationId
    || !resumeInventoryMatches(secondPlan,currentJournal)
    || !resumeProviderSnapshotMatches(secondProvider,currentJournal)
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
      currentJournal.deletedComments = [...(currentJournal.deletedComments||[]),comment.id];
      await saveJournal(currentJournal);
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
    if (afterPlan.blockers.length || !resumeInventoryMatches(afterPlan,currentJournal))
      throw new Error("State changed after provider deletion: inspect the retained journal and resume after reviewing a fresh preview");
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
      currentJournal.stage = "state-purge";
      currentJournal.lastDeleted = {pk:record.pk,sk:record.sk};
      await saveJournal(currentJournal);
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
    // Restore under the retained fence and journal. If this fails or the final
    // transaction response is lost, a retry still knows the original UUIDs.
    await restoreWorkerMappings(enabledMappings);
    await finishErasureProtocol(profile,operationId,journalKey);
    output({status:"succeeded",deletedProvider:result.deletedProvider,alreadyAbsent:result.alreadyAbsent,deletedComments:result.deletedComments,deletedState:result.deletedState,
      retainedPerItemOperationRecord:false,workerMappingsRestored:enabledMappings.length});
  } catch (error) {
    output({status:"partial_failure",deletedProvider:result.deletedProvider,alreadyAbsent:result.alreadyAbsent,
      deletedComments:result.deletedComments,deletedState:result.deletedState, error:error instanceof Error?error.message:String(error),
      operationId,profileFenceRetained:true,workerMappingState:"may be partially restored but workers remain fenced",
      nextAction:"Keep the profile fence and journal. Run a fresh PREVIEW for the same exact IDs, review its current inventory/token and mapping states, then APPLY with the reported --operation-id. The journal preserves the original mapping UUIDs and the fence blocks worker writes until finalization."});
    process.exitCode = 2;
  }
} finally {
  db.destroy();
  lambda.destroy();
}
