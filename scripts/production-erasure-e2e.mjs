#!/usr/bin/env node
/**
 * Operator-run, single-profile production E2E for the deployed erasure worker.
 * This uses a unique disposable Work event/task, the normal exact-preview and
 * durable operation store, and the real erasure SQS event-source mapping.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { GetFunctionConfigurationCommand, LambdaClient, ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { googleCredentials, profiles, todoistToken } from "../dist/config.js";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { ErasureOperationStore, erasurePreviewFingerprint } from "../dist/erasure-executor.js";
import { buildErasurePreview } from "../dist/erasure-preview.js";
import { verifyErasurePostflight } from "../dist/erasure-deletion.js";
import { acquireProfileAdmissionLease, inspectErasureFence } from "../dist/erasure-protocol.js";
import { enqueueErasureOperation } from "../dist/erasure-queue.js";
import { erasureExecutionEnabled } from "../dist/erasure-readiness.js";
import { defaultProviderClientFactory } from "../dist/mutation-budget.js";
import { GoogleCalendar, Todoist } from "../dist/providers.js";
import { StateRepository } from "../dist/repository.js";
import { activeProjectDeletionTombstone, parseDeletionTombstoneComment } from "../dist/mapping-comments.js";

const PROFILE = "work";
const CONFIRMATION = "RUN_DISPOSABLE_WORK_ERASURE_E2E";
const WAIT_MS = 15 * 60_000;
const POLL_MS = 3_000;
const TABLE = process.env.STATE_TABLE_NAME?.trim();
const OPERATION_QUEUE = process.env.ERASURE_OPERATION_QUEUE_URL?.trim();
const OPERATION_DLQ = process.env.ERASURE_OPERATION_DLQ_URL?.trim();
const SYNC_QUEUE = process.env.QUEUE_URL?.trim();
const SYNC_DLQ = process.env.SYNC_DLQ_URL?.trim();
const TARGET_WORKER = process.env.ERASURE_TARGET_WORKER_FUNCTION_NAME?.trim();
const REVIEW_FUNCTION = process.env.ERASURE_REVIEW_FUNCTION_NAME?.trim();
const ERASURE_WORKER = process.env.ERASURE_WORKER_FUNCTION_NAME?.trim();

function assertPreconditions(argv) {
  if (argv.length !== 1 || argv[0] !== `--confirm=${CONFIRMATION}`)
    throw new Error(`This production mutation requires exactly --confirm=${CONFIRMATION}`);
  for (const [name, value] of Object.entries({STATE_TABLE_NAME:TABLE,
    ERASURE_OPERATION_QUEUE_URL:OPERATION_QUEUE,ERASURE_OPERATION_DLQ_URL:OPERATION_DLQ,
    QUEUE_URL:SYNC_QUEUE,SYNC_DLQ_URL:SYNC_DLQ,ERASURE_TARGET_WORKER_FUNCTION_NAME:TARGET_WORKER,
    ERASURE_REVIEW_FUNCTION_NAME:REVIEW_FUNCTION,ERASURE_WORKER_FUNCTION_NAME:ERASURE_WORKER}))
    if (!value) throw new Error(`${name} is required`);
}

async function verifyLiveExecutionGate(lambda) {
  const configs=await Promise.all([REVIEW_FUNCTION,ERASURE_WORKER].map(FunctionName=>
    lambda.send(new GetFunctionConfigurationCommand({FunctionName}))));
  if(configs.some(config=>config.Environment?.Variables?.ERASURE_EXECUTION_ENABLED!=="true"
    ||config.Environment?.Variables?.ERASURE_PROTOCOL_VERSION!=="1"))
    throw new Error("Both deployed review and erasure-worker gates must be enabled with protocol version 1");
  process.env.ERASURE_EXECUTION_ENABLED="true";
  process.env.ERASURE_PROTOCOL_VERSION="1";
}

function log(event, detail={}) {
  console.log(JSON.stringify({service:"todoist-calendar-sync-production-erasure-e2e",event,...detail}));
}

function status(error) {
  return Number(error?.status || error?.$metadata?.httpStatusCode || 0);
}

function transient(error) {
  const codes=new Set(["EADDRNOTAVAIL","EAI_AGAIN","ECONNRESET","ETIMEDOUT","ENETUNREACH","EPIPE"]);
  let current=error;
  for(let depth=0;current&&depth<5;depth++,current=current.cause) {
    if(codes.has(current.code)||codes.has(current.errno))return true;
  }
  const http=status(error);
  return http===429||http>=500;
}

async function retryTransient(operation,{attempts=4,delayMs=500}={}) {
  let last;
  for(let attempt=0;attempt<attempts;attempt++) {
    try{return await operation();}
    catch(error) {
      last=error;
      if(!transient(error)||attempt===attempts-1)throw error;
      await new Promise(resolve=>setTimeout(resolve,delayMs*2**attempt));
    }
  }
  throw last;
}

async function queueDepth(sqs, url) {
  const response=await sqs.send(new GetQueueAttributesCommand({QueueUrl:url,AttributeNames:[
    "ApproximateNumberOfMessages","ApproximateNumberOfMessagesNotVisible","ApproximateNumberOfMessagesDelayed"]}));
  return ["ApproximateNumberOfMessages","ApproximateNumberOfMessagesNotVisible","ApproximateNumberOfMessagesDelayed"]
    .reduce((total,key)=>total+Number(response.Attributes?.[key]||0),0);
}

async function poll(label, operation, accept, timeoutMs=WAIT_MS) {
  const deadline=Date.now()+timeoutMs;
  let last,lastTransient;
  while(Date.now()<deadline) {
    try {
      last=await operation();
      if(await accept(last))return last;
      lastTransient=undefined;
    } catch(error) {
      if(!transient(error))throw error;
      lastTransient=error.code||error.cause?.code||"temporary_network_error";
    }
    await new Promise(resolve=>setTimeout(resolve,POLL_MS));
  }
  throw new Error(`Timed out waiting for ${label}${last?.status?`; last status: ${last.status}`:""}${lastTransient?`; last transient error: ${lastTransient}`:""}`);
}

async function scanIdentityReferences(taskId,eventId) {
  let cursor, pages=0, scanned=0;
  let consumed=0;
  const started=Date.now();
  const budget=Number(process.env.TODOIST_CALENDAR_SYNC_DYNAMODB_SCAN_RCU_BUDGET_PER_SECOND||10);
  if(!Number.isFinite(budget)||budget<1)throw new Error("DynamoDB scan RCU budget must be positive");
  const matches=[];
  const contains=(value,seen=new Set())=>{
    if(value===taskId||value===eventId)return true;
    if(typeof value==="string"&&(value.includes(taskId)||value.includes(eventId)))return true;
    if(!value||typeof value!=="object"||seen.has(value))return false;
    seen.add(value);
    return Object.values(value).some(item=>contains(item,seen));
  };
  do {
    const page=await documentClient.send(new ScanCommand({TableName:TABLE,ConsistentRead:true,Limit:25,
      ExclusiveStartKey:cursor,ReturnConsumedCapacity:"TOTAL"}));
    pages++;scanned+=Number(page.ScannedCount||0);
    consumed+=Number(page.ConsumedCapacity?.CapacityUnits||0);
    for(const item of page.Items||[])if(contains(item))matches.push({pk:item.pk,sk:item.sk});
    cursor=page.LastEvaluatedKey;
    if(cursor) {
      const budgetDelay=Math.max(0,Math.ceil(consumed/budget*1000-(Date.now()-started)));
      await new Promise(resolve=>setTimeout(resolve,budgetDelay));
    }
  } while(cursor);
  return {pages,scanned,consumed,matches};
}

async function sourceMappings(lambda) {
  const mappings=[];
  let marker;
  do {
    const page=await lambda.send(new ListEventSourceMappingsCommand({FunctionName:TARGET_WORKER,MaxItems:100,Marker:marker}));
    mappings.push(...(page.EventSourceMappings||[]).filter(item=>item.EventSourceArn?.includes(":sqs:")&&item.UUID));
    marker=page.NextMarker;
  } while(marker);
  return mappings.map(item=>({id:item.UUID,state:item.State,eventSourceArn:item.EventSourceArn,functionArn:item.FunctionArn}))
    .sort((a,b)=>a.id.localeCompare(b.id));
}

async function createAndQueue(operationStore, target, onCreated) {
  const owner=randomUUID();
  const release=await acquireProfileAdmissionLease(PROFILE,owner);
  let confirmationId,operationId,operationCreated=false;
  try {
    const preview=await buildErasurePreview(target,{allowLeaseOwner:owner});
    if(preview.blockers.length)throw new Error(`Exact deletion preview blocked (${preview.blockers.join("; ")})`);
    if(preview.knownTargetReadback.todoist!=="present"||preview.knownTargetReadback.calendar!=="present")
      throw new Error("The exact disposable Todoist and Calendar objects were not both read back live");
    const issued=await operationStore.issueConfirmation(preview);
    confirmationId=issued.confirmationId;operationId=preview.operationId;
    const issuedPreview=await operationStore.getIssuedPreview(preview.operationId,issued.confirmationId);
    if(!issuedPreview)throw new Error("Durable exact-preview confirmation could not be re-read");
    const current=await buildErasurePreview(target,{newOperationId:()=>preview.operationId,
      ignoreOperationId:preview.operationId,allowLeaseOwner:owner});
    if(current.blockers.length||current.previewFingerprint!==issuedPreview.previewFingerprint)
      throw new Error(`Exact deletion inventory changed before creation (${current.blockers.join("; ")})`);
    const now=new Date().toISOString();
    const operation={operationId:current.operationId,profile:current.profile,target:current.target,
      selectedActions:current.selectedActions,providerSnapshotFingerprint:current.providerSnapshotFingerprint,
      inventory:current.inventory,actionPlan:issuedPreview.actionPlan,previewFingerprint:current.previewFingerprint,
      providerDeletionReady:erasureExecutionEnabled()&&issuedPreview.executionReadyAtIssue===true,
      confirmationId:issued.confirmationId,confirmationFingerprint:current.previewFingerprint,
      status:"previewed",createdAt:now,updatedAt:now};
    if(!operation.providerDeletionReady)throw new Error("Execution readiness was not bound to the exact confirmed preview");
    if(erasurePreviewFingerprint(operation)!==operation.previewFingerprint)
      throw new Error("The durable operation does not match the exact provider preview");
    await operationStore.create(operation);
    operationCreated=true;onCreated(operation);
    await operationStore.transition(operation.operationId,"previewed","queued");
    return operation;
  } catch(error) {
    if(confirmationId&&!operationCreated) {
      try {await documentClient.send(new DeleteCommand({TableName:TABLE,
        Key:{pk:`ERASURE_CONFIRMATION#${operationId}`,sk:"STATE"},
        ConditionExpression:"#status=:issued AND confirmationId=:confirmationId AND operationId=:operationId",
        ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":issued":"issued",
          ":confirmationId":confirmationId,":operationId":operationId}}));}
      catch(cleanupError) {log("unused_confirmation_cleanup_failed",{operationId,error:cleanupError.message});}
    }
    throw error;
  } finally {
    await release();
  }
}

async function main() {
  assertPreconditions(process.argv.slice(2));
  const sqs=new SQSClient({});
  const calendar=new GoogleCalendar(await googleCredentials(PROFILE),profiles[PROFILE].calendarId);
  const todoist=new Todoist(await todoistToken(PROFILE));
  const state=new StateRepository();
  const clients=await defaultProviderClientFactory(PROFILE);
  const operations=new ErasureOperationStore();
  const lambda=new LambdaClient({});
  await verifyLiveExecutionGate(lambda);
  const initialMappings=await sourceMappings(lambda);
  if(!initialMappings.length||initialMappings.some(item=>!["Enabled","Disabled"].includes(item.state)))
    throw new Error("E2E preflight requires a complete, stable SQS mapping inventory for the sync worker");
  const initial={sync:await queueDepth(sqs,SYNC_QUEUE),syncDlq:await queueDepth(sqs,SYNC_DLQ),
    erasure:await queueDepth(sqs,OPERATION_QUEUE),erasureDlq:await queueDepth(sqs,OPERATION_DLQ)};
  const existing=await inspectErasureFence(PROFILE);
  if(initial.sync!==0||initial.erasure!==0||existing.fence||existing.leases.length)
    throw new Error("E2E preflight requires drained active sync/erasure queues and no Work-profile fence or lease");

  const tag=`[ERASURE E2E ${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID().slice(0,8)}]`;
  const title=`${tag} disposable Calendar item`;
  const {start,end}=(()=>{const value=new Date(Date.now()+36*60*60*1000);value.setUTCMinutes(0,0,0);
    return {start:value,end:new Date(value.getTime()+30*60_000)};})();
  let eventId,eventEtag,taskId,operationId,operationCreated=false;
  log("started",{profile:PROFILE,gateEnabled:true,initialQueueDepths:initial});
  try {
    const event=await calendar.upsertEvent({summary:title,description:"Disposable, user-authorized erasure acceptance fixture.",
      start:{dateTime:start.toISOString(),timeZone:"Europe/London"},end:{dateTime:end.toISOString(),timeZone:"Europe/London"}});
    eventId=event.id;eventEtag=event.etag;
    if(!eventId)throw new Error("Calendar did not return an exact event ID");
    const task=await poll("one matching Work Todoist task",async()=>{
      const matches=(await todoist.listTasks(profiles[PROFILE].todoistProjectId)).filter(item=>item.content===title);
      if(matches.length>1)throw new Error("Duplicate task projections were created for the disposable event");
      return matches[0];
    },Boolean);
    taskId=task.id;
    await poll("the exact durable Work mapping",()=>state.getMappingByEvent(PROFILE,eventId),value=>value?.taskId===taskId);
    await poll("sync queue drained after disposable fixture creation",()=>queueDepth(sqs,SYNC_QUEUE),depth=>depth===0);
    const operation=await createAndQueue(operations,{profile:PROFILE,taskId,eventId,deleteCalendar:true},created=>{
      operationId=created.operationId;operationCreated=true;
    });
    await enqueueErasureOperation(operationId);
    log("operation_queued",{profile:PROFILE,operationId});

    const terminal=await poll("durable erasure completion",async()=>{
      const current=await operations.get(operationId);
      if(current?.status==="review_required")
        throw new Error(`Erasure entered review_required at ${current.lifecycle?.phase||"unknown phase"}; keep the fence and do not clean the fixture manually`);
      if(current?.status==="partial_failure")throw new Error("Erasure entered partial_failure; keep the fixture fenced for review");
      return current;
    },current=>current===undefined);
    if(terminal!==undefined)throw new Error("Erasure terminal state was not fully removed");

    const absent=await verifyErasurePostflight(operation,{db:documentClient,clients,
      inspectFence:async profile=>inspectErasureFence(profile)});
    if(!absent.providersAbsent||!absent.stateAbsent)
      throw new Error(`Strong postflight failed (providersAbsent=${absent.providersAbsent}, stateAbsent=${absent.stateAbsent})`);
    const comments=await todoist.listProjectComments(profiles[PROFILE].todoistProjectId,true);
    const tombstone=activeProjectDeletionTombstone(comments,{profile:PROFILE,projectId:profiles[PROFILE].todoistProjectId,
      taskId,eventIds:[eventId]});
    if(!tombstone||tombstone.taskId!==taskId||!tombstone.eventIds.includes(eventId))
      throw new Error("The bounded project-comment tombstone was not verified after completion");
    if(!comments.map(parseDeletionTombstoneComment).some(marker=>marker?.taskId===taskId&&marker?.eventIds.includes(eventId)))
      throw new Error("Todoist project comment readback no longer contains the exact erased identity tombstone");
    const references=await scanIdentityReferences(taskId,eventId);
    if(references.matches.length)
      throw new Error(`DynamoDB still contains ${references.matches.length} row(s) with the erased task/event identity`);
    const restored=await poll("original Work worker mappings restored and fence released",async()=>{
      const current=await inspectErasureFence(PROFILE);
      const mappings=await sourceMappings(lambda);
      return {current,mappings};
    },value=>!value.current.fence&&value.current.leases.length===0
      &&JSON.stringify(value.mappings)===JSON.stringify(initialMappings));
    if(restored.current.fence||restored.current.leases.length
      ||JSON.stringify(restored.mappings)!==JSON.stringify(initialMappings))
      throw new Error("Original sync worker mapping states or Work fence were not restored");
    const final={sync:await queueDepth(sqs,SYNC_QUEUE),syncDlq:await queueDepth(sqs,SYNC_DLQ),
      erasure:await queueDepth(sqs,OPERATION_QUEUE),erasureDlq:await queueDepth(sqs,OPERATION_DLQ)};
    if(final.sync!==0||final.erasure!==0)
      throw new Error("An active sync or erasure queue did not drain after the disposable E2E");
    if(final.syncDlq>initial.syncDlq||final.erasureDlq>initial.erasureDlq)
      throw new Error("A sync or erasure DLQ grew during the disposable E2E");
    const result={status:"passed",profile:PROFILE,operationCompleted:true,tombstoneVerified:true,
      providerAbsenceVerified:absent.providersAbsent,dynamoIdentityRows:references.matches.length,
      stateScan:{pages:references.pages,rows:references.scanned},fenceReleased:true,
      initialQueueDepths:initial,finalQueueDepths:final};
    await writeFile(process.env.E2E_RESULT_FILE||"production-erasure-e2e-result.json",`${JSON.stringify(result,null,2)}\n`);
    log("passed",result);
  } catch(error) {
    if(!operationCreated) {
      try {if(eventId&&eventEtag)await retryTransient(()=>calendar.deleteEventIfUnchanged(eventId,eventEtag));}
      catch(cleanupError) {if(![404,410].includes(status(cleanupError)))log("fixture_calendar_cleanup_failed",{error:cleanupError.code||cleanupError.cause?.code||cleanupError.message});}
      try {if(taskId)await retryTransient(()=>todoist.deleteTask(taskId));}
      catch(cleanupError) {if(![404,410].includes(status(cleanupError)))log("fixture_task_cleanup_failed",{error:cleanupError.code||cleanupError.cause?.code||cleanupError.message});}
    }
    log("failed",{operationId,operationCreated,fixtureCreated:Boolean(eventId&&taskId),error:error.message});
    throw error;
  }
}

main().catch(error=>{
  console.error(JSON.stringify({service:"todoist-calendar-sync-production-erasure-e2e",event:"run_failed",error:error.message}));
  process.exitCode=1;
});
