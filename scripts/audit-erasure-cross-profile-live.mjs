#!/usr/bin/env node
/**
 * Read-only live #307 cross-profile evidence capture for one exact disposable
 * or already-erased identity. All provider credentials stay in this process;
 * output contains fingerprints/counts only and can never authorize release.
 */
import {execFileSync} from "node:child_process";
import {fromIni} from "@aws-sdk/credential-provider-ini";
import {GetFunctionConfigurationCommand,LambdaClient} from "@aws-sdk/client-lambda";
import {pathToFileURL} from "node:url";

const PROFILE=/^[A-Za-z0-9+=,.@_-]{1,128}$/;
const ACCOUNT=/^\d{12}$/;
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const FUNCTION=/^[A-Za-z0-9_-]{2,64}$/;
const ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const PROFILE_NAMES=["home","antonio","work"];
const AMBIENT_CREDENTIALS=["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN","AWS_WEB_IDENTITY_TOKEN_FILE","AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI","AWS_CONTAINER_CREDENTIALS_FULL_URI"];

function option(argv,name) {
  const found=argv.filter(value=>value.startsWith("--"+name+"="));
  if(found.length!==1)throw new Error("Invalid or missing required option");
  return found[0].slice(name.length+3);
}
export function parseOptions(argv) {
  const allowed=new Set(["profile","expected-account","region","function","qualifier","task-id","event-id","scan-deadline-ms"]);
  if(argv.some(value=>!/^--[a-z-]+=[^\s]+$/.test(value)||!allowed.has(value.slice(2,value.indexOf("=")))))
    throw new Error("Unexpected audit option");
  const result={profile:option(argv,"profile"),account:option(argv,"expected-account"),
    region:option(argv,"region"),functionName:option(argv,"function"),qualifier:option(argv,"qualifier"),
    taskId:option(argv,"task-id"),eventId:option(argv,"event-id"),
    scanDeadlineMs:argv.some(value=>value.startsWith("--scan-deadline-ms="))
      ?Number(option(argv,"scan-deadline-ms")):300_000};
  if(!PROFILE.test(result.profile)||!ACCOUNT.test(result.account)||!REGION.test(result.region)
    ||!FUNCTION.test(result.functionName)||(result.qualifier!=="$LATEST"&&!ID.test(result.qualifier))
    ||!ID.test(result.taskId)||!ID.test(result.eventId)
    ||!Number.isSafeInteger(result.scanDeadlineMs)||result.scanDeadlineMs<60_000||result.scanDeadlineMs>900_000)
    throw new Error("Invalid audit option value");
  return result;
}

export function validateRoutingConfig(value) {
  let config;
  try {config=JSON.parse(value);} catch {throw new Error("Profile routing config is unavailable or invalid");}
  if(!config||typeof config!=="object"||Array.isArray(config)
    ||Object.keys(config).sort().join(",")!==PROFILE_NAMES.slice().sort().join(","))
    throw new Error("Profile routing config is incomplete");
  const calendarIds=new Set(),projectIds=new Set();
  for(const profile of PROFILE_NAMES) {
    const entry=config[profile];
    if(!entry||typeof entry!=="object"||Array.isArray(entry)
      ||typeof entry.calendarId!=="string"||!entry.calendarId.trim()
      ||typeof entry.todoistProjectId!=="string"||!entry.todoistProjectId.trim())
      throw new Error("Profile routing config is incomplete");
    if(calendarIds.has(entry.calendarId)||projectIds.has(entry.todoistProjectId))
      throw new Error("Profile routing config contains duplicate provider identities");
    calendarIds.add(entry.calendarId);projectIds.add(entry.todoistProjectId);
  }
  return config;
}

/** Classify only a small set of reviewed, non-sensitive failure strings. */
export function redactedFailureCode(error) {
  const message=typeof error?.message==="string"?error.message:"";
  if(error?.name==="CalendarRecurrenceLimitAuditError"
    &&typeof error.matchesSelectedEvent==="boolean") {
    return error.matchesSelectedEvent
      ?"CALENDAR_RECURRENCE_ALIAS_LIMIT_SELECTED_EVENT"
      :"CALENDAR_RECURRENCE_ALIAS_LIMIT_OTHER_MASTER";
  }
  if(message==="Calendar recurring series exceeds replay marker bound")
    return "CALENDAR_RECURRENCE_ALIAS_LIMIT";
  if(message==="Calendar full inventory exceeded the audit result limit")
    return "CALENDAR_INVENTORY_LIMIT";
  if(message==="Todoist task inventory exceeded the audit result limit")
    return "TODOIST_INVENTORY_LIMIT";
  if(message==="Strong state inventory repeated a pagination cursor"
    ||message==="Strong state inventory repeated a row across pages")
    return "STATE_INVENTORY_INCONSISTENT";
  if(error instanceof Error&&error.name==="ErasurePreviewDeadlineError")
    return "STATE_INVENTORY_DEADLINE";
  return "UNCLASSIFIED";
}

export function redactedFailureDetails(error) {
  if(error?.name!=="CalendarRecurrenceLimitAuditError")return {};
  const allowedOrigins=new Set(["state-row","task-comment","task-comment-read","calendar-task-tag",
    "calendar-event-identity","calendar-parent-link","calendar-history-master","calendar-series-index",
    "calendar-direct-read-parent","calendar-task-tag-parent","calendar-recurrence-instance"]);
  const originPattern=/^project-comment-(event-id|master-event-id|active-instance-id)-(selected-task|other-task)-(home|antonio|work)$/;
  const allowedFamilies=new Set(["TASK","EVENT","TASKOWNER","MAPPING","RECURRENCE",
    "CANONICAL","ERASURE","DELIVERY","MANUAL","ORPHAN","SYNC"]);
  const allowedFields=new Set(["taskId","providerTaskId","linkedTaskId","discardedTaskId","retainedTaskId",
    "ownerTaskId","eventId","providerEventId","masterEventId","activeInstanceId","calendarProjectionId",
    "oldMasterId","newMasterId","lastEventId","occurrenceId","selectedEventId","previousEventId",
    "cancelledEventId","syncHistoryMasterId","candidateTaskIds","taskIds","candidateEventIds","eventIds",
    "seriesId","seriesIds"]);
  const allowedDeliveryKinds=new Set(["calendar","todoist","manual","orphan","reconcile","repair","erasure","other"]);
  const strings=(value,allowed)=>Array.isArray(value)?[...new Set(value.filter(item=>allowed.has(item)))].sort():[];
  const origins=Array.isArray(error.auditOriginKinds)
    ?[...new Set(error.auditOriginKinds.filter(value=>allowedOrigins.has(value)||originPattern.test(value)))].sort():[];
  const details={
    selectedEvent:Boolean(error.matchesSelectedEvent),
    ...(typeof error.auditProfile==="string"&&["home","antonio","work"].includes(error.auditProfile)
      ?{profile:error.auditProfile}:{}),
    relationOrigins:origins,
    stateFamilies:strings(error.auditStateFamilies,allowedFamilies),
    stateReferenceFields:strings(error.auditStateRefFields,allowedFields),
    deliveryKinds:strings(error.auditDeliveryKinds,allowedDeliveryKinds),
  };
  for(const [name,value] of [["otherTaskMappingCount",error.auditOtherTaskMappingCount],
    ["calendarInstanceCount",error.auditCalendarInstanceCount],
    ["activeOtherTaskMappingCount",error.auditActiveOtherTaskMappingCount],
    ["otherTaskReadFound",error.auditOtherTaskReadFound],
    ["otherTaskRead404",error.auditOtherTaskRead404],
    ["otherTaskReadFailures",error.auditOtherTaskReadFailures],
    ["taggedEventCount",error.auditTaggedEventCount],
    ["taggedRecurringMasterCount",error.auditTaggedRecurringMasterCount],
    ["deliveryRowCount",error.auditDeliveryRowCount],
    ["deliveryRowsWithSelectedTask",error.auditDeliveryRowsWithSelectedTask],
    ["deliveryRowsWithSelectedEvent",error.auditDeliveryRowsWithSelectedEvent]])
    if(Number.isSafeInteger(value)&&value>=0)details[name]=value;
  return details;
}

function verifiedCliIdentity(profile) {
  const env={...process.env};
  for(const name of AMBIENT_CREDENTIALS)delete env[name];
  env.AWS_PROFILE=profile;
  env.AWS_SDK_LOAD_CONFIG="1";
  const response=execFileSync("aws",["sts","get-caller-identity","--profile",profile,"--no-cli-pager","--output","json"],
    {encoding:"utf8",maxBuffer:1024*1024,env});
  return JSON.parse(response);
}

function prepareNamedProfile(profile,region,variables) {
  for(const name of AMBIENT_CREDENTIALS)delete process.env[name];
  process.env.AWS_PROFILE=profile;
  process.env.AWS_SDK_LOAD_CONFIG="1";
  process.env.AWS_REGION=region;
  process.env.AWS_DEFAULT_REGION=region;
  process.env.SYNC_PROFILE_CONFIG_JSON=variables.SYNC_PROFILE_CONFIG_JSON;
  process.env.STATE_TABLE_NAME=variables.STATE_TABLE_NAME;
  for(const name of ["GOOGLE_CREDENTIALS_PARAMETER_PREFIX","TODOIST_TOKEN_PARAMETER_PREFIX"])
    if(variables[name])process.env[name]=variables[name];
}

function selectReadMethods(instance,names,optional=[]) {
  const selected={};
  for(const name of names) {
    if(typeof instance[name]!=="function") {
      if(optional.includes(name))continue;
      throw new Error("Required read-only provider capability is unavailable");
    }
    selected[name]=instance[name].bind(instance);
  }
  return Object.freeze(selected);
}

export function readOnlyProviderPair(clients,selectedEventId,profile) {
  const selectedCalendar=selectReadMethods(clients.calendar,[
    "findByTodoistTaskId","getEvent","listAllEventsForErasureAudit",
    "listCalendarListForErasureAudit","listEventInstances","listLinkedEventsByTodoistTaskId",
  ],["listCalendarListForErasureAudit"]);
  const listEventInstances=selectedCalendar.listEventInstances;
  const calendar=Object.freeze({...selectedCalendar,listEventInstances:async(masterId,calendarId)=>{
    try {return await listEventInstances(masterId,calendarId);}
    catch(error) {
      if(error?.message==="Calendar recurring series exceeds replay marker bound") {
        const diagnostic=new Error("Calendar recurrence alias bound exceeded");
        diagnostic.name="CalendarRecurrenceLimitAuditError";
        diagnostic.matchesSelectedEvent=masterId===selectedEventId;
        diagnostic.auditProfile=profile;
        diagnostic.auditCalendarInstanceCount=Number.isSafeInteger(error.auditAliasCount)
          ?error.auditAliasCount:undefined;
        const origins=Array.isArray(error.auditOriginKinds)?error.auditOriginKinds:[];
        diagnostic.auditOriginKinds=origins.filter(value=>typeof value==="string");
        const families=Array.isArray(error.auditStateFamilies)?error.auditStateFamilies:[];
        diagnostic.auditStateFamilies=families.filter(value=>typeof value==="string");
        const fields=Array.isArray(error.auditStateRefFields)?error.auditStateRefFields:[];
        diagnostic.auditStateRefFields=fields.filter(value=>typeof value==="string");
        for(const field of ["auditOtherTaskMappingCount","auditActiveOtherTaskMappingCount",
          "auditOtherTaskReadFound","auditOtherTaskRead404","auditOtherTaskReadFailures",
          "auditTaggedEventCount","auditTaggedRecurringMasterCount","auditDeliveryRowCount",
          "auditDeliveryRowsWithSelectedTask","auditDeliveryRowsWithSelectedEvent"])
          diagnostic[field]=Number.isSafeInteger(error[field])?error[field]:undefined;
        diagnostic.auditDeliveryKinds=Array.isArray(error.auditDeliveryKinds)?error.auditDeliveryKinds:[];
        throw diagnostic;
      }
      throw error;
    }
  }});
  return Object.freeze({
    calendar,
    todoist:selectReadMethods(clients.todoist,[
      "getTask","listAllProjectCommentsForErasureAudit","listAllTaskCommentsForErasureAudit",
      "listAllTasksForErasureAudit","listProjectComments","listTaskComments",
    ],["listAllTaskCommentsForErasureAudit"]),
  });
}

function summarizeInventory(records) {
  const summary={};
  for(const record of records) {
    const family=record.type;
    const classification=record.classification;
    if(typeof family!=="string"||typeof classification!=="string")
      throw new Error("Sanitized state inventory summary is invalid");
    const item=summary[family]||(summary[family]={count:0,classifications:{}});
    item.count++;
    item.classifications[classification]=(item.classifications[classification]||0)+1;
  }
  return Object.fromEntries(Object.entries(summary).sort(([left],[right])=>left.localeCompare(right)));
}

export async function collectLiveCrossProfileEvidence(options) {
  const identity=verifiedCliIdentity(options.profile);
  if(identity.Account!==options.account)throw new Error("AWS profile account did not match expected account");
  const credentials=fromIni({profile:options.profile});
  const lambda=new LambdaClient({region:options.region,credentials,maxAttempts:5});
  try {
    const config=await lambda.send(new GetFunctionConfigurationCommand({
      FunctionName:options.functionName,Qualifier:options.qualifier,
    }));
    if(config.FunctionName!==options.functionName||typeof config.FunctionArn!=="string"
      ||config.FunctionArn.split(":")[4]!==identity.Account||config.FunctionArn.split(":")[3]!==options.region
      ||config.Environment?.Error)
      throw new Error("Target Lambda identity or environment could not be verified");
    const variables=config.Environment?.Variables||{};
    validateRoutingConfig(variables.SYNC_PROFILE_CONFIG_JSON);
    if(typeof variables.STATE_TABLE_NAME!=="string"||!variables.STATE_TABLE_NAME.trim())
      throw new Error("State table configuration is unavailable");
    prepareNamedProfile(options.profile,options.region,variables);
  } finally {lambda.destroy();}

  // Import after installing the verified account's non-secret routing config
  // and named profile so the app's SSM/DynamoDB clients use Windsor credentials.
  const [{buildErasurePreview},{defaultProviderClientFactory}]=await Promise.all([
    import(new URL("../dist/erasure-preview.js",import.meta.url).href),
    import(new URL("../dist/mutation-budget.js",import.meta.url).href),
  ]);
  const providerFactory=async profile=>readOnlyProviderPair(
    await defaultProviderClientFactory(profile),options.eventId,profile);
  const preview=await buildErasurePreview({profile:"work",taskId:options.taskId,eventId:options.eventId,deleteCalendar:true},{
    scanDeadlineMs:options.scanDeadlineMs,
    auditCrossProfileIdentity:true,
    auditDeliveryReceipts:true,
    clients:await providerFactory("work"),
    providerFactory,
  });
  if(!preview.crossProfileEvidence)throw new Error("Cross-profile evidence was not returned");
  return {
    purpose:"issue-307-live-cross-profile-observation",
    status:"BLOCKED_READ_ONLY_EVIDENCE_ONLY",
    verifiedAccountMatchesExpected:true,
    region:options.region,
    providerMutationPerformed:false,
    crossProfileEvidence:preview.crossProfileEvidence,
    preview:{blockerCount:preview.blockers.length,relatedStateRowCount:preview.inventory.length,
      classificationCounts:preview.classificationCounts,
      stateInventoryByFamily:summarizeInventory(preview.inventory),
      deliveryReceiptAudit:preview.deliveryReceiptAudit},
    replayBarrierMayBeEnabled:false,
    executableRecoveryMayBeEnabled:false,
  };
}

export async function main(argv=process.argv.slice(2)) {
  const options=parseOptions(argv);
  const report=await collectLiveCrossProfileEvidence(options);
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.exitCode=2;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    process.stderr.write(JSON.stringify({status:"Live cross-profile evidence INCOMPLETE",
      failureCode:redactedFailureCode(error),details:redactedFailureDetails(error),
      providerIdsAndCredentials:"withheld"})+"\n");
    process.exitCode=2;
  });
}
