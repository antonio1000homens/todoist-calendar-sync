/**
 * Read-only, all-profile identity/provenance collection for #307. This report
 * is deliberately never release-authoritative: provider 404s are ambiguous,
 * Calendar's taskId index can omit legacy aliases, and DynamoDB scans are not
 * transaction snapshots. No raw task/event/comment content is returned.
 */
import {buildProjectMappingIndex,LEGACY_TASK_COMMENT_MARKERS,type TodoistCommentRecord} from "./mapping-comments.js";
import type {CalendarEvent,Profile,TodoistTask} from "./types.js";
import {fingerprint} from "../scripts/item-purge-policy.mjs";
import {calendarProvenanceIsFresh,type VerifiedCalendarProvenance} from "./erasure-calendar-provenance.js";

type ProviderPair={
  calendar:{
    listCalendarListForErasureAudit?():Promise<Array<{id:string;accessRole:string;configured:boolean}>>;
    listLinkedEventsByTodoistTaskId(taskId:string,calendarId?:string):Promise<CalendarEvent[]>;
    listAllEventsForErasureAudit(calendarId?:string):Promise<CalendarEvent[]>;
    getEvent(eventId:string,calendarId?:string):Promise<CalendarEvent>;
    listEventInstances(masterId:string,calendarId?:string):Promise<CalendarEvent[]>;
  };
  todoist:{
    getTask(taskId:string):Promise<TodoistTask>;
    listAllTasksForErasureAudit():Promise<TodoistTask[]>;
    listAllProjectCommentsForErasureAudit():Promise<{
      projects:Array<{id:string;workspaceId?:number}>;comments:TodoistCommentRecord[];
      complete?:boolean;unavailableProjectCommentCount?:number;
    }>;
    listAllTaskCommentsForErasureAudit?():Promise<{comments:TodoistCommentRecord[];fullSyncDateUtc:string}>;
    listTaskComments(taskId:string):Promise<TodoistCommentRecord[]>;
  };
};
type CalendarAuditEvent={calendarId:string;event:CalendarEvent};

const PROFILES:Profile[]=["home","antonio","work"];
const ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const TASK_FIELDS=new Set(["taskId","providerTaskId","linkedTaskId","discardedTaskId","retainedTaskId","ownerTaskId"]);
const EVENT_FIELDS=new Set(["eventId","providerEventId","masterEventId","activeInstanceId","calendarProjectionId","oldMasterId","newMasterId","lastEventId","occurrenceId","selectedEventId","previousEventId","cancelledEventId","syncHistoryMasterId"]);
const TASK_ARRAYS=new Set(["candidateTaskIds","taskIds"]);
const EVENT_ARRAYS=new Set(["candidateEventIds","eventIds"]);
// This is the read-only discovery cap, not the replay transaction limit.
// Keep enough capacity to observe large production recurrence chains while
// preserving a hard memory/work bound.
// The release proof in erasure-replay-barrier.ts remains independently capped.
const MAX_IDENTITIES=2048;
const MAX_PASSES=64;

export interface CrossProfileErasureEvidence {
  phase:"read_only_cross_profile_observation";
  eligibleForPostWriteRelease:false;
  allProfilesQueried:boolean;
  closureComplete:boolean;
  allAccessibleCalendarCoverageProven:boolean;
  knownIdentitiesAbsentFromCurrentProviders:boolean;
  stateScan:{stronglyConsistent:true;allPagesReceived:true;rowCount:number;relatedRowCount:number;fingerprint:string;tableFingerprint:string};
  identities:{taskCount:number;eventCount:number;seriesCount:number;overflowCount:number;fingerprint:string};
  profiles:Record<Profile,{
    taskReadsFound:number;task404Responses:number;tagQueries:number;taggedEvents:number;
    todoistTaskInventoryCount:number;taskInventoryMatches:number;
    taskReadConflicts:number;
    directEventReadsFound:number;cancelledDirectEventReads:number;event404Responses:number;
    recurringMasters:number;recurrenceInstances:number;
    calendarInventoryEvents:number;inventoryMatchedEvents:number;accessibleCalendarCount:number;
    cancelledInventoryMatches:number;
    freeBusyOnlyCalendarCount:number;restrictedCalendarCount:number;
    calendarInventoryComplete:boolean;calendarIdsFingerprint:string;
    calendarProvenanceComplete:boolean;calendarProvenanceFresh:boolean;
    calendarProvenanceFingerprint:string|null;directIdCalendarCount:number;
    unregisteredListedCalendarCount:number;inaccessibleCalendarCount:number;
    eventReadConflicts:number;eventsMissingEtag:number;
    projectInventoryCount:number;projectInventoryFingerprint:string;
    projectCommentInventoryComplete:boolean;unavailableProjectCommentCount:number;
    projectCommentsRead:number;relatedProjectComments:number;taskCommentsRead:number;relatedLegacyComments:number;
    taskCommentReadFailures:number;
    taskCommentInventoryCount:number;taskCommentInventoryMatches:number;taskCommentInventoryFingerprint:string;
    taskCommentInventoryComplete:boolean;taskCommentInventoryFresh:boolean;
    taskCommentInventorySnapshotAt:string|null;taskCommentReadConflicts:number;
    calendarInventoryFingerprint:string;commentInventoryFingerprint:string;
    taskInventoryFingerprint:string;
    evidenceFingerprint:string;
  }>;
  evidenceFingerprint:string;
  missingProof:readonly string[];
}

function validId(value:unknown):value is string {
  return typeof value==="string"&&ID.test(value);
}
function calendarEventKey(calendarId:string,eventId:string):string {
  return JSON.stringify([calendarId,eventId]);
}
function validCalendarId(value:unknown):value is string {
  return typeof value==="string"&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value);
}
function statusOf(error:unknown):number|undefined {
  const status=(error as {status?:unknown})?.status;
  return typeof status==="number"?status:undefined;
}
function sameCalendarIdentityVersion(left:CalendarEvent,right:CalendarEvent):boolean {
  return left.id===right.id&&left.etag===right.etag&&left.status===right.status
    &&left.recurringEventId===right.recurringEventId&&left.iCalUID===right.iCalUID
    &&JSON.stringify(left.recurrence)===JSON.stringify(right.recurrence)
    &&JSON.stringify(left.originalStartTime)===JSON.stringify(right.originalStartTime)
    &&left.extendedProperties?.shared?.taskId===right.extendedProperties?.shared?.taskId
    &&left.extendedProperties?.shared?.syncHistoryMasterId===right.extendedProperties?.shared?.syncHistoryMasterId;
}
function rowRefs(value:unknown,tasks:Set<string>,events:Set<string>,series:Set<string>,key="",depth=0):void {
  if(depth>24)throw new Error("Deep state row needs manual alias review");
  if(Array.isArray(value)) {
    if(TASK_ARRAYS.has(key))for(const item of value)if(validId(item))tasks.add(item);
    if(EVENT_ARRAYS.has(key))for(const item of value)if(validId(item))events.add(item);
    for(const item of value)if(item&&typeof item==="object")rowRefs(item,tasks,events,series,"",depth+1);
    return;
  }
  if(!value||typeof value!=="object")return;
  const row=value as Record<string,unknown>;
  for(const [childKey,child] of Object.entries(row)) {
    if(TASK_FIELDS.has(childKey)&&validId(child))tasks.add(child);
    if(EVENT_FIELDS.has(childKey)&&validId(child))events.add(child);
    if(childKey==="seriesId"&&validId(child))series.add(child);
    if(child&&typeof child==="object")rowRefs(child,tasks,events,series,childKey,depth+1);
  }
}
function rowMatches(row:Record<string,unknown>,tasks:Set<string>,events:Set<string>,series:Set<string>):boolean {
  const keys=[row.pk,row.sk].filter((value):value is string=>typeof value==="string");
  for(const key of keys)for(const token of key.split(/[#:]/))
    if(tasks.has(token)||events.has(token)||series.has(token))return true;
  const rowTasks=new Set<string>(),rowEvents=new Set<string>(),rowSeries=new Set<string>();
  rowRefs(row,rowTasks,rowEvents,rowSeries);
  return [...rowTasks].some(id=>tasks.has(id))||[...rowEvents].some(id=>events.has(id))
    ||[...rowSeries].some(id=>series.has(id));
}
function valueContainsIdentity(value:unknown,identity:string,depth=0):boolean {
  if(depth>12)return false;
  if(typeof value==="string")return value===identity;
  if(Array.isArray(value))return value.some(child=>valueContainsIdentity(child,identity,depth+1));
  if(value&&typeof value==="object")
    return Object.values(value as Record<string,unknown>).some(child=>valueContainsIdentity(child,identity,depth+1));
  return false;
}
function identityFieldNames(value:unknown,identity:string,key="",depth=0):Set<string> {
  if(depth>24)return new Set();
  if(typeof value==="string")return value===identity&&key?new Set([key]):new Set();
  if(Array.isArray(value))return new Set(value.flatMap(child=>[...identityFieldNames(child,identity,key,depth+1)]));
  if(value&&typeof value==="object") {
    const names=new Set<string>();
    for(const [childKey,child] of Object.entries(value as Record<string,unknown>))
      for(const name of identityFieldNames(child,identity,childKey,depth+1))names.add(name);
    return names;
  }
  return new Set();
}
function boundIds(set:Set<string>,overflow:{count:number}):void {
  if(set.size<=MAX_IDENTITIES)return;
  const retained=[...set].slice(0,MAX_IDENTITIES);
  overflow.count+=set.size-retained.length;
  set.clear();for(const id of retained)set.add(id);
}
function commentEventIds(comment:TodoistCommentRecord):string[] {
  const content=String(comment.content||"");
  const line=content.split(/\r?\n/).find(item=>item.startsWith("calendarEventId="));
  const value=line?.slice("calendarEventId=".length);
  return validId(value)?[value]:[];
}

/**
 * Follow exact task/event identity references across a completed strong scan,
 * all profile project/task comments and direct provider reads. Every profile
 * reader must use that profile's own credentials and calendar/project IDs.
 */
export async function observeCrossProfileErasureEvidence(input:{
  taskId:string;eventId?:string;rows:Record<string,unknown>[];fullRows:Record<string,unknown>[];
  readerForProfile:(profile:Profile)=>Promise<ProviderPair>;
  calendarProvenance?:VerifiedCalendarProvenance;
}):Promise<CrossProfileErasureEvidence> {
  if(!validId(input.taskId)||(input.eventId!==undefined&&!validId(input.eventId))
    ||!Array.isArray(input.rows)||!Array.isArray(input.fullRows)||typeof input.readerForProfile!=="function")
    throw new Error("Exact erased identity, complete state rows and all-profile readers are required");
  const taskIds=new Set<string>([input.taskId]);
  const eventIds=new Set<string>(input.eventId?[input.eventId]:[]);
  const eventIdOrigins=new Map<string,Set<string>>();
  if(input.eventId)eventIdOrigins.set(input.eventId,new Set(["selected-event"]));
  const seriesIds=new Set<string>();
  const overflow={count:0};
  const add=(set:Set<string>,value:unknown)=>{
    if(!validId(value)||set.has(value))return false;
    if(set.size>=MAX_IDENTITIES){overflow.count++;return false;}
    set.add(value);return true;
  };
  const addEventId=(value:unknown,origin:string)=>{
    if(!validId(value))return false;
    const origins=eventIdOrigins.get(value)||new Set<string>();
    origins.add(origin);eventIdOrigins.set(value,origins);
    return add(eventIds,value);
  };
  const profileReaders={} as Record<Profile,ProviderPair>;
  const projects={} as Record<Profile,TodoistCommentRecord[]>;
  const projectInventoryCounts={} as Record<Profile,number>;
  const projectInventoryFingerprints={} as Record<Profile,string>;
  const projectCommentInventoryComplete={} as Record<Profile,boolean>;
  const unavailableProjectCommentCounts={} as Record<Profile,number>;
  const taskInventories={} as Record<Profile,Map<string,TodoistTask>>;
  const taskCommentInventories={} as Record<Profile,Map<string,TodoistCommentRecord>>;
  const taskCommentInventoryComplete={} as Record<Profile,boolean>;
  const taskCommentInventorySnapshotAt={} as Record<Profile,string|null>;
  const calendarById={} as Record<Profile,Map<string,CalendarAuditEvent>>;
  const calendarByProviderId={} as Record<Profile,Map<string,CalendarAuditEvent[]>>;
  const calendarByTask={} as Record<Profile,Map<string,CalendarAuditEvent[]>>;
  const calendarByParent={} as Record<Profile,Map<string,CalendarAuditEvent[]>>;
  const calendarByHistoryMaster={} as Record<Profile,Map<string,CalendarAuditEvent[]>>;
  const calendarBySeries={} as Record<Profile,Map<string,CalendarAuditEvent[]>>;
  const calendarIdsByProfile={} as Record<Profile,Set<string>>;
  const configuredCalendarByProfile={} as Record<Profile,string|undefined>;
  const calendarInventoryCompleteByProfile={} as Record<Profile,boolean>;
  const calendarProvenanceCompleteByProfile={} as Record<Profile,boolean>;
  const calendarAccessCounts={} as Record<Profile,{accessible:number;freeBusyOnly:number}>;
  const inventoryMatchedIds={} as Record<Profile,Set<string>>;
  const cancelledDirectEventIds={} as Record<Profile,Set<string>>;
  const cancelledInventoryIds={} as Record<Profile,Set<string>>;
  const taskInventoryMatchIds={} as Record<Profile,Set<string>>;
  const projectIndexes={} as Record<Profile,ReturnType<typeof buildProjectMappingIndex>>;
  const stats={} as CrossProfileErasureEvidence["profiles"];
  const matchedComments=new Map<string,Set<string>>();
  const commentInventoryDigests={} as Record<Profile,Set<string>>;
  const matchedState=new Map<string,Record<string,unknown>>();
  const unparsedTaskComments=new Set<string>();
  const processedTaskReads=new Set<string>(),processedTags=new Set<string>(),processedTaskComments=new Set<string>();
  const processedEventReads=new Set<string>(),processedInstances=new Set<string>();
  let provider404s=0,passes=0;
  const malformedComments=new Set<string>();
  const taskReadConflicts=new Set<string>(),eventReadConflicts=new Set<string>(),missingEtags=new Set<string>();
  const taskCommentReadConflicts=new Set<string>();
  const taskCommentReadFailures=new Set<string>();
  const recordCalendarEvent=(profile:Profile,item:CalendarAuditEvent)=>{
    const {calendarId,event}=item;
    if(!validCalendarId(calendarId)||!event||!validId(event.id))
      throw new Error("Calendar audit inventory contains an invalid event");
    const composite=calendarEventKey(calendarId,event.id);
    const previous=calendarById[profile].get(composite);
    if(previous) {
      if(!sameCalendarIdentityVersion(previous.event,event))
        throw new Error("Calendar event changed during accessible-calendar inventory");
      return;
    }
    calendarById[profile].set(composite,item);
    const index=(map:Map<string,CalendarAuditEvent[]>,key:string|undefined)=>{
      if(!key)return;const values=map.get(key)||[];values.push(item);map.set(key,values);
    };
    index(calendarByProviderId[profile],event.id);
    index(calendarByTask[profile],event.extendedProperties?.shared?.taskId);
    index(calendarByParent[profile],event.recurringEventId);
    index(calendarByHistoryMaster[profile],event.extendedProperties?.shared?.syncHistoryMasterId);
    index(calendarBySeries[profile],event.iCalUID);
  };
  for(const profile of PROFILES) {
    profileReaders[profile]=await input.readerForProfile(profile);
    const taskCommentAudit=profileReaders[profile].todoist.listAllTaskCommentsForErasureAudit;
    const calendarReader=profileReaders[profile].calendar;
    const calendarInventoryPromise=(async()=>{
      const declared=input.calendarProvenance?.profiles[profile];
      const provenanceFresh=Boolean(input.calendarProvenance?.signatureVerified
        &&calendarProvenanceIsFresh(input.calendarProvenance));
      const listCalendars=calendarReader.listCalendarListForErasureAudit;
      if(!listCalendars) {
        const events=await calendarReader.listAllEventsForErasureAudit();
        return {descriptors:[{id:"configured-calendar-unverified",accessRole:"configured-only",configured:true}],
          events:events.map(event=>({calendarId:"configured-calendar-unverified",event})),
          complete:false,provenanceComplete:false,provenanceFresh,directIdCount:0,
          unregisteredListedCount:0,inaccessibleCount:0};
      }
      const listed=await listCalendars.call(calendarReader);
      if(!Array.isArray(listed)||listed.some(calendar=>!calendar||!validCalendarId(calendar.id)
        ||typeof calendar.accessRole!=="string"||typeof calendar.configured!=="boolean"))
        throw new Error("CalendarList audit returned invalid calendar descriptors");
      if(new Set(listed.map(calendar=>calendar.id)).size!==listed.length
        ||listed.filter(calendar=>calendar.configured).length!==1)
        throw new Error("CalendarList audit returned duplicate calendars or no unique configured calendar");
      const allowedRoles=new Set(["freeBusyReader","reader","writer","writerWithoutPrivateAccess","owner","configured-unlisted"]);
      if(listed.some(calendar=>!allowedRoles.has(calendar.accessRole)))
        throw new Error("CalendarList audit returned an unknown calendar access role");
      const attestedById=new Map(declared?.calendars.map(calendar=>[calendar.id,calendar])||[]);
      const configured=listed.find(calendar=>calendar.configured)!;
      const unregisteredListedCount=listed.filter(calendar=>!attestedById.has(calendar.id)).length;
      let accessRoleConflicts=0;
      const descriptors=new Map(listed.map(calendar=>[calendar.id,{...calendar}]));
      for(const calendar of declared?.calendars||[]) {
        const listedCalendar=descriptors.get(calendar.id);
        if(listedCalendar&&listedCalendar.accessRole!=="configured-unlisted"
          &&listedCalendar.accessRole!==calendar.accessRole)accessRoleConflicts++;
        if(!listedCalendar||listedCalendar.accessRole==="configured-unlisted")
          descriptors.set(calendar.id,{id:calendar.id,accessRole:calendar.accessRole,
            configured:calendar.id===declared?.configuredCalendarId});
      }
      const all=[...descriptors.values()];
      if(all.length>256)throw new Error("Calendar audit scope exceeded the safe calendar limit");
      const restrictedRoles=new Set(["freeBusyReader","writerWithoutPrivateAccess"]);
      let inaccessibleCount=0;
      const inventories=await Promise.all(all.filter(calendar=>calendar.accessRole!=="freeBusyReader")
        .map(async calendar=>{
          try {
            return {calendarId:calendar.id,
              events:await calendarReader.listAllEventsForErasureAudit(calendar.id)};
          } catch(error) {
            if(statusOf(error)!==403&&statusOf(error)!==404)throw error;
            inaccessibleCount++;
            return {calendarId:calendar.id,events:[] as CalendarEvent[]};
          }
        }));
      const events=inventories.flatMap(inventory=>inventory.events.map(event=>({
        calendarId:inventory.calendarId,event})));
      const missingInventoryEtags=events.some(item=>typeof item.event.etag!=="string"||!item.event.etag);
      const provenanceComplete=Boolean(input.calendarProvenance?.complete
        &&input.calendarProvenance?.signatureVerified&&provenanceFresh&&declared
        &&declared.configuredCalendarId===configured.id
        &&attestedById.get(configured.id)?.origin==="configured"
        &&unregisteredListedCount===0&&accessRoleConflicts===0);
      return {descriptors:all,events,
        complete:all.every(calendar=>!restrictedRoles.has(calendar.accessRole))
          &&inaccessibleCount===0&&!missingInventoryEtags,
        provenanceComplete,provenanceFresh,
        directIdCount:all.filter(calendar=>!listed.some(item=>item.id===calendar.id)).length,
        unregisteredListedCount,inaccessibleCount};
    })();
    const [projectAudit,calendarAudit,tasks,taskComments]=await Promise.all([
      profileReaders[profile].todoist.listAllProjectCommentsForErasureAudit(),
      calendarInventoryPromise,
      profileReaders[profile].todoist.listAllTasksForErasureAudit(),
      taskCommentAudit?taskCommentAudit.call(profileReaders[profile].todoist):Promise.resolve(undefined),
    ]);
    if(!projectAudit||!Array.isArray(projectAudit.projects)||!Array.isArray(projectAudit.comments))
      throw new Error("Todoist project/comment audit returned an invalid inventory");
    if((projectAudit.complete!==undefined&&typeof projectAudit.complete!=="boolean")
      ||(projectAudit.unavailableProjectCommentCount!==undefined
        &&(!Number.isSafeInteger(projectAudit.unavailableProjectCommentCount)
          ||projectAudit.unavailableProjectCommentCount<0)))
      throw new Error("Todoist project/comment audit returned invalid completeness metadata");
    if(projectAudit.projects.some(project=>!project||!validId(project.id)
      ||(project.workspaceId!==undefined&&(!Number.isSafeInteger(project.workspaceId)||project.workspaceId<=0))))
      throw new Error("Todoist project inventory contains an invalid project identity");
    const projectIds=projectAudit.projects.map(project=>project.id);
    if(new Set(projectIds).size!==projectIds.length)
      throw new Error("Todoist project inventory contains duplicate project identities");
    projects[profile]=projectAudit.comments;
    projectInventoryCounts[profile]=projectIds.length;
    projectInventoryFingerprints[profile]=fingerprint(projectAudit.projects);
    projectCommentInventoryComplete[profile]=projectAudit.complete!==false;
    unavailableProjectCommentCounts[profile]=projectAudit.unavailableProjectCommentCount||0;
    taskInventories[profile]=new Map();
    for(const task of tasks) {
      if(!task||!validId(task.id))throw new Error("Todoist audit inventory contains an invalid task");
      const previous=taskInventories[profile].get(task.id);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(task))
        throw new Error("Todoist task changed during audit inventory");
      taskInventories[profile].set(task.id,task);
    }
    taskCommentInventories[profile]=new Map();
    const taskCommentRows=taskComments?.comments;
    taskCommentInventorySnapshotAt[profile]=typeof taskComments?.fullSyncDateUtc==="string"
      &&Number.isFinite(Date.parse(taskComments.fullSyncDateUtc))?taskComments.fullSyncDateUtc:null;
    taskCommentInventoryComplete[profile]=Array.isArray(taskCommentRows)&&taskCommentInventorySnapshotAt[profile]!==null;
    for(const comment of taskCommentRows||[]) {
      if(!comment||!validId(comment.id)||!validId(comment.task_id)||typeof comment.content!=="string")
        throw new Error("Todoist full task-comment inventory contains an invalid note");
      const previous=taskCommentInventories[profile].get(comment.id);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(comment))
        throw new Error("Todoist task comment changed during full inventory");
      taskCommentInventories[profile].set(comment.id,comment);
    }
    calendarById[profile]=new Map();calendarByProviderId[profile]=new Map();calendarByTask[profile]=new Map();
    calendarByParent[profile]=new Map();calendarByHistoryMaster[profile]=new Map();calendarBySeries[profile]=new Map();
    calendarIdsByProfile[profile]=new Set(calendarAudit.descriptors.map(calendar=>calendar.id));
    configuredCalendarByProfile[profile]=calendarAudit.descriptors.find(calendar=>calendar.configured)?.id;
    calendarInventoryCompleteByProfile[profile]=calendarAudit.complete;
    calendarProvenanceCompleteByProfile[profile]=calendarAudit.provenanceComplete;
    calendarAccessCounts[profile]={accessible:calendarAudit.descriptors.length,
      freeBusyOnly:calendarAudit.descriptors.filter(calendar=>calendar.accessRole==="freeBusyReader").length};
    inventoryMatchedIds[profile]=new Set<string>();
    cancelledDirectEventIds[profile]=new Set<string>();
    cancelledInventoryIds[profile]=new Set<string>();
    taskInventoryMatchIds[profile]=new Set<string>();
    for(const item of calendarAudit.events)recordCalendarEvent(profile,item);
    projectIndexes[profile]=buildProjectMappingIndex(projects[profile]);
    commentInventoryDigests[profile]=new Set(projects[profile].map(comment=>
      "project:"+fingerprint([comment.id,comment.content||""])));
    for(const comment of taskCommentInventories[profile].values())commentInventoryDigests[profile].add(
      "task:"+fingerprint([comment.id,comment.task_id,comment.content||"",comment.is_deleted===true]));
    stats[profile]={taskReadsFound:0,task404Responses:0,tagQueries:0,taggedEvents:0,
      todoistTaskInventoryCount:taskInventories[profile].size,taskInventoryMatches:0,taskReadConflicts:0,
      directEventReadsFound:0,cancelledDirectEventReads:0,event404Responses:0,
      recurringMasters:0,recurrenceInstances:0,
      calendarInventoryEvents:calendarById[profile].size,inventoryMatchedEvents:0,cancelledInventoryMatches:0,
      accessibleCalendarCount:calendarAccessCounts[profile].accessible,
      freeBusyOnlyCalendarCount:calendarAccessCounts[profile].freeBusyOnly,
      restrictedCalendarCount:calendarAudit.descriptors.filter(calendar=>
        ["freeBusyReader","writerWithoutPrivateAccess"].includes(calendar.accessRole)).length,
      calendarInventoryComplete:calendarInventoryCompleteByProfile[profile],
      calendarProvenanceComplete:calendarProvenanceCompleteByProfile[profile],
      calendarProvenanceFresh:calendarAudit.provenanceFresh,
      calendarProvenanceFingerprint:input.calendarProvenance?.attestationFingerprint||null,
      directIdCalendarCount:calendarAudit.directIdCount,
      unregisteredListedCalendarCount:calendarAudit.unregisteredListedCount,
      inaccessibleCalendarCount:calendarAudit.inaccessibleCount,
      calendarIdsFingerprint:fingerprint([...calendarIdsByProfile[profile]].sort()),
      eventReadConflicts:0,eventsMissingEtag:0,
      projectInventoryCount:projectInventoryCounts[profile],
      projectInventoryFingerprint:projectInventoryFingerprints[profile],
      projectCommentInventoryComplete:projectCommentInventoryComplete[profile],
      unavailableProjectCommentCount:unavailableProjectCommentCounts[profile],
      projectCommentsRead:projects[profile].length,relatedProjectComments:0,
      taskCommentsRead:0,relatedLegacyComments:0,calendarInventoryFingerprint:"",
      taskCommentReadFailures:0,
      taskCommentInventoryCount:taskCommentInventories[profile].size,taskCommentInventoryMatches:0,
      taskCommentInventoryComplete:taskCommentInventoryComplete[profile],
      taskCommentInventoryFresh:false,
      taskCommentInventorySnapshotAt:taskCommentInventorySnapshotAt[profile],
      taskCommentInventoryFingerprint:fingerprint([...taskCommentInventories[profile].values()]
        .map(comment=>[comment.id,comment.task_id,fingerprint([comment.content||"",comment.is_deleted===true])])
        .sort(([left],[right])=>String(left).localeCompare(String(right)))),taskCommentReadConflicts:0,
      commentInventoryFingerprint:"",taskInventoryFingerprint:"",evidenceFingerprint:""};
    matchedComments.set(profile,new Set<string>());
  }
  let changed=true;
  while(changed&&passes++<MAX_PASSES) {
    changed=false;
    // Strongly scanned state rows can contribute historical task/event aliases.
    for(const row of input.rows) {
      if(!rowMatches(row,taskIds,eventIds,seriesIds))continue;
      const key=JSON.stringify([row.pk,row.sk]);
      if(!matchedState.has(key)){matchedState.set(key,row);changed=true;}
      const before=taskIds.size+eventIds.size;
      const previousEventIds=new Set(eventIds);
      rowRefs(row,taskIds,eventIds,seriesIds);
      for(const eventId of eventIds)if(!previousEventIds.has(eventId)) {
        const origins=eventIdOrigins.get(eventId)||new Set<string>();
        origins.add("state-row");eventIdOrigins.set(eventId,origins);
      }
      boundIds(taskIds,overflow);boundIds(eventIds,overflow);boundIds(seriesIds,overflow);
      if(taskIds.size+eventIds.size>before)changed=true;
    }
    // Complete profile project-comment snapshots can connect an old task ID,
    // event ID, recurring master and active occurrence to one another.
    for(const profile of PROFILES) {
      const index=projectIndexes[profile];
      const matched=matchedComments.get(profile)!;
      for(const item of index.parsed) {
        if(!taskIds.has(item.payload.taskId)&&!eventIds.has(item.payload.eventId)
          &&!(item.payload.masterEventId&&eventIds.has(item.payload.masterEventId))
          &&!(item.payload.activeInstanceId&&eventIds.has(item.payload.activeInstanceId)))continue;
        const before=taskIds.size+eventIds.size;
        const taskRelation=item.payload.taskId===input.taskId?"selected-task":"other-task";
        add(taskIds,item.payload.taskId);
        addEventId(item.payload.eventId,`project-comment-event-id-${taskRelation}-${profile}`);
        addEventId(item.payload.masterEventId,`project-comment-master-event-id-${taskRelation}-${profile}`);
        addEventId(item.payload.activeInstanceId,`project-comment-active-instance-id-${taskRelation}-${profile}`);
        add(seriesIds,item.payload.seriesId);
        matched.add("project:"+item.comment.id+":"+fingerprint(item.comment.content||""));
        if(taskIds.size+eventIds.size>before)changed=true;
      }
      for(const item of index.malformed)if([...taskIds,...eventIds].some(id=>item.comment.content?.includes(id))) {
        const marker="malformed:"+item.comment.id+":"+fingerprint(item.comment.content||"");
        malformedComments.add(profile+"/"+marker);
        matched.add(marker);
      }
      for(const comment of taskCommentInventories[profile].values()) {
        const content=String(comment.content||"");
        if(!taskIds.has(comment.task_id||"")&&!([...taskIds,...eventIds].some(id=>content.includes(id))))continue;
        const marker="task:"+comment.id+":"+fingerprint(content);
        matched.add(marker);
        if(add(taskIds,comment.task_id))changed=true;
        if(LEGACY_TASK_COMMENT_MARKERS.has(content.split(/\r?\n/)[0]||"")) {
          const ids=commentEventIds(comment);
          if(ids.length===0)malformedComments.add(profile+"/task-malformed/"+marker);
          for(const eventId of ids)if(addEventId(eventId,"task-comment"))changed=true;
        } else if([...taskIds,...eventIds].some(id=>content.includes(id))) {
          unparsedTaskComments.add(profile+"/task-unparsed/"+marker);
        }
      }
    }
    for(const profile of PROFILES)for(const taskId of taskIds) {
      const task=taskInventories[profile].get(taskId);
      if(!task)continue;
      taskInventoryMatchIds[profile].add(taskId);
      const parentId=(task as TodoistTask&{parent_id?:string}).parent_id;
      if(validId(parentId)&&add(taskIds,parentId))changed=true;
    }
    // Match current identities against an unfiltered all-calendar inventory,
    // not only the provider's shared-property index.
    for(const profile of PROFILES) {
      const candidates=new Map<string,CalendarAuditEvent>();
      const candidateOrigins=new Map<string,Set<string>>();
      const addCandidate=(item:CalendarAuditEvent,origin:string)=>{
        const key=calendarEventKey(item.calendarId,item.event.id);
        candidates.set(key,item);
        const origins=candidateOrigins.get(key)||new Set<string>();
        origins.add(origin);candidateOrigins.set(key,origins);
      };
      for(const taskId of taskIds)for(const item of calendarByTask[profile].get(taskId)||[])
        addCandidate(item,"calendar-task-tag");
      for(const eventId of eventIds) {
        for(const item of calendarByProviderId[profile].get(eventId)||[])addCandidate(item,"calendar-event-identity");
        for(const item of calendarByParent[profile].get(eventId)||[])addCandidate(item,"calendar-parent-link");
        for(const item of calendarByHistoryMaster[profile].get(eventId)||[])addCandidate(item,"calendar-history-master");
      }
      for(const seriesId of seriesIds)for(const item of calendarBySeries[profile].get(seriesId)||[])
        addCandidate(item,"calendar-series-index");
      for(const [candidateKey,item] of candidates) {
        const event=item.event;
        inventoryMatchedIds[profile].add(candidateKey);
        if(event.status==="cancelled")cancelledInventoryIds[profile].add(candidateKey);
        for(const origin of candidateOrigins.get(candidateKey)||[])
          if(addEventId(event.id,origin))changed=true;
        if(add(taskIds,event.extendedProperties?.shared?.taskId))changed=true;
        if(addEventId(event.recurringEventId,"calendar-parent-link"))changed=true;
        if(addEventId(event.extendedProperties?.shared?.syncHistoryMasterId,"calendar-history-master"))changed=true;
        if(add(seriesIds,event.iCalUID))changed=true;
      }
      stats[profile].inventoryMatchedEvents=inventoryMatchedIds[profile].size;
    }
    // Read every identified Todoist ID and its task-scoped comments through
    // every profile. A 404 is retained as an ambiguous response, never absence.
    for(const taskId of [...taskIds]) {
      for(const profile of PROFILES) {
        const taskKey=profile+"/"+taskId;
        if(!processedTaskReads.has(taskKey)) {
          processedTaskReads.add(taskKey);
          try {
            const task=await profileReaders[profile].todoist.getTask(taskId);
            if(task?.id!==taskId)throw new Error("Todoist task read returned a different identity");
            stats[profile].taskReadsFound++;
            if(!taskInventories[profile].has(taskId))taskReadConflicts.add(taskKey);
            const parentId=(task as TodoistTask&{parent_id?:string}).parent_id;
            if(validId(parentId)&&add(taskIds,parentId))changed=true;
          } catch(error) {
            if(statusOf(error)!==404)throw error;
            stats[profile].task404Responses++;provider404s++;
            if(taskInventories[profile].has(taskId))taskReadConflicts.add(taskKey);
          }
        }
        if(!processedTaskComments.has(taskKey)) {
          processedTaskComments.add(taskKey);
          let comments:TodoistCommentRecord[];
          try {comments=await profileReaders[profile].todoist.listTaskComments(taskId);}
          catch(error) {
            if(statusOf(error)!==404)throw error;
            taskCommentReadFailures.add(taskKey);stats[profile].taskCommentReadFailures++;provider404s++;
            continue;
          }
          stats[profile].taskCommentsRead+=comments.length;
          for(const comment of comments)commentInventoryDigests[profile].add(
            "task:"+fingerprint([taskId,comment.id,comment.content||""]));
          const matched=matchedComments.get(profile)!;
          for(const comment of comments) {
            const content=String(comment.content||"");
            if(LEGACY_TASK_COMMENT_MARKERS.has(content.split(/\r?\n/)[0]||"")) {
              for(const eventId of commentEventIds(comment))if(addEventId(eventId,"task-comment-read"))changed=true;
              matched.add("task:"+comment.id+":"+fingerprint(content));
            } else if([...taskIds,...eventIds].some(id=>content.includes(id))) {
              const marker="task-unparsed:"+comment.id+":"+fingerprint(content);
              matched.add(marker);unparsedTaskComments.add(profile+"/"+marker);
            }
          }
          if(taskCommentInventoryComplete[profile]) {
            const snapshot=[...taskCommentInventories[profile].values()].filter(comment=>comment.task_id===taskId&&!comment.is_deleted);
            const direct=new Map(comments.map(comment=>[comment.id,comment]));
            if(snapshot.some(comment=>direct.get(comment.id)?.content!==comment.content)
              ||comments.some(comment=>taskCommentInventories[profile].get(comment.id)?.task_id!==taskId
                ||taskCommentInventories[profile].get(comment.id)?.content!==comment.content))
              taskCommentReadConflicts.add(taskKey);
            stats[profile].taskCommentInventoryMatches+=snapshot.length;
          }
        }
        const tagKey=profile+"/"+taskId;
        if(!processedTags.has(tagKey)) {
          processedTags.add(tagKey);stats[profile].tagQueries++;
          const events=await profileReaders[profile].calendar.listLinkedEventsByTodoistTaskId(taskId);
          for(const event of events) {
            if(!event||!validId(event.id)||event.extendedProperties?.shared?.taskId!==taskId)
              throw new Error("Calendar task-link query returned an unattributable event");
            stats[profile].taggedEvents++;
            if(addEventId(event.id,"calendar-task-tag"))changed=true;
            if(addEventId(event.recurringEventId,"calendar-task-tag-parent"))changed=true;
            if(addEventId(event.extendedProperties?.shared?.syncHistoryMasterId,"calendar-history-master"))changed=true;
          }
        }
      }
    }
    // Read every discovered Calendar ID in all profiles. A recurring master
    // expands through its complete, bounded instances endpoint.
    for(const eventId of [...eventIds])for(const profile of PROFILES) {
      const inventoryCandidates=new Map<string,CalendarAuditEvent>();
      for(const item of calendarByProviderId[profile].get(eventId)||[])
        inventoryCandidates.set(item.calendarId,item);
      for(const item of calendarByParent[profile].get(eventId)||[])
        inventoryCandidates.set(item.calendarId,item);
      for(const item of calendarByHistoryMaster[profile].get(eventId)||[])
        inventoryCandidates.set(item.calendarId,item);
      const targets=inventoryCandidates.size?[...inventoryCandidates.keys()]:
        (configuredCalendarByProfile[profile]?[configuredCalendarByProfile[profile]!]:["configured-calendar-unverified"]);
      for(const calendarId of targets) {
        const eventKey=profile+"/"+calendarEventKey(calendarId,eventId);
        if(processedEventReads.has(eventKey))continue;
        processedEventReads.add(eventKey);
        try {
          const event=await profileReaders[profile].calendar.getEvent(eventId,
            calendarId==="configured-calendar-unverified"?undefined:calendarId);
          if(!event||event.id!==eventId)throw new Error("Calendar direct read returned a different identity");
          stats[profile].directEventReadsFound++;
          if(event.status==="cancelled")cancelledDirectEventIds[profile].add(calendarEventKey(calendarId,event.id));
          const inventoryEvent=calendarById[profile].get(calendarEventKey(calendarId,eventId));
          if(!inventoryEvent||!sameCalendarIdentityVersion(event,inventoryEvent.event))eventReadConflicts.add(eventKey);
          if(typeof event.etag!=="string"||!event.etag)missingEtags.add(eventKey);
          if(add(taskIds,event.extendedProperties?.shared?.taskId))changed=true;
          if(addEventId(event.recurringEventId,"calendar-direct-read-parent"))changed=true;
          if(addEventId(event.extendedProperties?.shared?.syncHistoryMasterId,"calendar-history-master"))changed=true;
          if(event.recurrence?.length) {
            stats[profile].recurringMasters++;
            const instanceKey=eventKey;
            if(!processedInstances.has(instanceKey)) {
              processedInstances.add(instanceKey);
              let instances:CalendarEvent[];
              try {
                instances=await profileReaders[profile].calendar.listEventInstances(eventId,
                  calendarId==="configured-calendar-unverified"?undefined:calendarId);
              } catch(error) {
                if((error as {name?:unknown})?.name==="CalendarRecurrenceLimitAuditError") {
                  const origins=[...(eventIdOrigins.get(eventId)||[])].sort();
                  (error as {auditOriginKinds?:string[]}).auditOriginKinds=origins;
                  (error as {auditProfile?:Profile}).auditProfile=profile;
                  const safeFamilies=new Set(["TASK","EVENT","TASKOWNER","MAPPING","RECURRENCE",
                    "CANONICAL","ERASURE","DELIVERY","MANUAL","ORPHAN","SYNC"]);
                  const families=[...new Set([...matchedState.values()]
                    .filter(row=>valueContainsIdentity(row,eventId))
                    .map(row=>String(row.pk||"").split("#",1)[0])
                    .filter(family=>safeFamilies.has(family)))].sort();
                  (error as {auditStateFamilies?:string[]}).auditStateFamilies=families;
                  const safeFields=new Set([...TASK_FIELDS,...EVENT_FIELDS,...TASK_ARRAYS,...EVENT_ARRAYS,"seriesIds"]);
                  const fields=[...new Set([...matchedState.values()]
                    .filter(row=>valueContainsIdentity(row,eventId))
                    .flatMap(row=>[...identityFieldNames(row,eventId)]))]
                    .filter(field=>safeFields.has(field)).sort();
                  (error as {auditStateRefFields?:string[]}).auditStateRefFields=fields;
                  const otherMappings=new Map<string,{profile:Profile;taskId:string}>();
                  for(const mappedProfile of PROFILES)for(const mapping of projectIndexes[mappedProfile].parsed) {
                    const payload=mapping.payload;
                    if(payload.taskId===input.taskId
                      ||![payload.eventId,payload.masterEventId,payload.activeInstanceId].includes(eventId))continue;
                    otherMappings.set(mappedProfile+"/"+payload.taskId,{profile:mappedProfile,taskId:payload.taskId});
                  }
                  const activeOtherMappings=[...otherMappings.values()].filter(mapping=>
                    taskInventories[mapping.profile].has(mapping.taskId));
                  let otherTaskReadFound=0;
                  let otherTaskRead404=0;
                  let otherTaskReadFailures=0;
                  for(const mapping of otherMappings.values()) {
                    try {
                      const mappedTask=await profileReaders[mapping.profile].todoist.getTask(mapping.taskId);
                      if(mappedTask?.id===mapping.taskId)otherTaskReadFound++;
                      else otherTaskReadFailures++;
                    } catch(readError) {
                      if(statusOf(readError)===404)otherTaskRead404++;
                      else otherTaskReadFailures++;
                    }
                  }
                  (error as {auditOtherTaskMappingCount?:number}).auditOtherTaskMappingCount=otherMappings.size;
                  (error as {auditActiveOtherTaskMappingCount?:number}).auditActiveOtherTaskMappingCount=activeOtherMappings.length;
                  (error as {auditOtherTaskReadFound?:number}).auditOtherTaskReadFound=otherTaskReadFound;
                  (error as {auditOtherTaskRead404?:number}).auditOtherTaskRead404=otherTaskRead404;
                  (error as {auditOtherTaskReadFailures?:number}).auditOtherTaskReadFailures=otherTaskReadFailures;
                  const taggedEvents=new Map<string,CalendarEvent>();
                  for(const taggedProfile of PROFILES)for(const item of calendarByTask[taggedProfile].get(input.taskId)||[])
                    taggedEvents.set(calendarEventKey(item.calendarId,item.event.id),item.event);
                  (error as {auditTaggedEventCount?:number}).auditTaggedEventCount=taggedEvents.size;
                  (error as {auditTaggedRecurringMasterCount?:number}).auditTaggedRecurringMasterCount=
                    [...taggedEvents.values()].filter(candidate=>Boolean(candidate.recurrence?.length)).length;
                  const deliveryRows=[...matchedState.values()].filter(row=>
                    typeof row.pk==="string"&&row.pk.startsWith("DELIVERY#")&&valueContainsIdentity(row,eventId));
                  const deliveryRef=(row:Record<string,unknown>,field:"taskIds"|"eventIds",id:string|undefined)=>
                    id!==undefined&&Array.isArray((row.identityRefs as Record<string,unknown>|undefined)?.[field])
                    &&((row.identityRefs as Record<string,unknown>)[field] as unknown[]).includes(id);
                  (error as {auditDeliveryRowCount?:number}).auditDeliveryRowCount=deliveryRows.length;
                  (error as {auditDeliveryRowsWithSelectedTask?:number}).auditDeliveryRowsWithSelectedTask=
                    deliveryRows.filter(row=>deliveryRef(row,"taskIds",input.taskId)).length;
                  (error as {auditDeliveryRowsWithSelectedEvent?:number}).auditDeliveryRowsWithSelectedEvent=
                    deliveryRows.filter(row=>deliveryRef(row,"eventIds",input.eventId)).length;
                  const deliveryKinds=[...new Set(deliveryRows.map(row=>row.kind)
                    .filter((kind):kind is string=>typeof kind==="string"&&/^[a-z][a-z0-9_-]{0,31}$/.test(kind)))].sort();
                  (error as {auditDeliveryKinds?:string[]}).auditDeliveryKinds=deliveryKinds;
                }
                throw error;
              }
              stats[profile].recurrenceInstances+=instances.length;
              for(const instance of instances) {
                if(!instance||!validId(instance.id)||instance.recurringEventId!==eventId)
                  throw new Error("Calendar instance list returned an unattributable event");
                const indexed=calendarById[profile].get(calendarEventKey(calendarId,instance.id));
                if(indexed&&!sameCalendarIdentityVersion(indexed.event,instance))
                  eventReadConflicts.add(profile+"/"+calendarEventKey(calendarId,instance.id));
                recordCalendarEvent(profile,{calendarId,event:instance});
                if(addEventId(instance.id,"calendar-recurrence-instance"))changed=true;
                if(add(taskIds,instance.extendedProperties?.shared?.taskId))changed=true;
              }
            }
          }
        } catch(error) {
          if(statusOf(error)!==404&&statusOf(error)!==410)throw error;
          stats[profile].event404Responses++;provider404s++;
        }
      }
    }
  }
  const relatedRows=[...matchedState.values()].map(row=>({key:[row.pk,row.sk],digest:fingerprint(row)}))
    .sort((a,b)=>JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
  const stateFingerprint=fingerprint(relatedRows);
  const tableFingerprint=fingerprint(input.fullRows.map(row=>({key:[row.pk,row.sk],digest:fingerprint(row)}))
    .sort((a,b)=>JSON.stringify(a.key).localeCompare(JSON.stringify(b.key))));
  const aliases={tasks:[...taskIds].sort(),events:[...eventIds].sort(),series:[...seriesIds].sort()};
  const now=Date.now();
  for(const profile of PROFILES) {
    const comments=[...matchedComments.get(profile)!].sort();
    stats[profile].relatedProjectComments=comments.filter(value=>value.startsWith("project:")||value.startsWith("malformed:")).length;
    stats[profile].relatedLegacyComments=comments.filter(value=>value.startsWith("task:")).length;
    stats[profile].taskInventoryMatches=taskInventoryMatchIds[profile].size;
    stats[profile].taskReadConflicts=[...taskReadConflicts].filter(key=>key.startsWith(profile+"/")).length;
    stats[profile].taskCommentReadConflicts=[...taskCommentReadConflicts].filter(key=>key.startsWith(profile+"/")).length;
    const snapshotAt=taskCommentInventorySnapshotAt[profile];
    const snapshotAge=snapshotAt===null?Infinity:now-Date.parse(snapshotAt);
    stats[profile].taskCommentInventoryFresh=taskCommentInventoryComplete[profile]
      &&snapshotAge<=5*60_000&&snapshotAge>=-60_000;
    stats[profile].eventReadConflicts=[...eventReadConflicts].filter(key=>key.startsWith(profile+"/")).length;
    stats[profile].eventsMissingEtag=[...missingEtags].filter(key=>key.startsWith(profile+"/")).length;
    stats[profile].calendarInventoryEvents=calendarById[profile].size;
    stats[profile].inventoryMatchedEvents=inventoryMatchedIds[profile].size;
    stats[profile].cancelledDirectEventReads=cancelledDirectEventIds[profile].size;
    stats[profile].cancelledInventoryMatches=cancelledInventoryIds[profile].size;
    stats[profile].taskInventoryFingerprint=fingerprint([...taskInventories[profile].values()]
      .map(task=>[task.id,fingerprint(task)]).sort(([left],[right])=>String(left).localeCompare(String(right))));
    stats[profile].calendarInventoryFingerprint=fingerprint([...calendarById[profile].values()]
      .map(item=>[item.calendarId,item.event.id,fingerprint(item.event)])
      .sort(([leftCalendar,leftEvent],[rightCalendar,rightEvent])=>
        String(leftCalendar).localeCompare(String(rightCalendar))||String(leftEvent).localeCompare(String(rightEvent))));
    stats[profile].commentInventoryFingerprint=fingerprint([...commentInventoryDigests[profile]].sort());
    stats[profile].evidenceFingerprint=fingerprint({
      comments,taskCommentsRead:stats[profile].taskCommentsRead,
      taskCommentReadFailures:stats[profile].taskCommentReadFailures,
      projectInventoryCount:stats[profile].projectInventoryCount,
      projectInventoryFingerprint:stats[profile].projectInventoryFingerprint,
      projectCommentInventoryComplete:stats[profile].projectCommentInventoryComplete,
      unavailableProjectCommentCount:stats[profile].unavailableProjectCommentCount,
      taskReadsFound:stats[profile].taskReadsFound,task404Responses:stats[profile].task404Responses,
      taskReadConflicts:stats[profile].taskReadConflicts,
      taggedEvents:stats[profile].taggedEvents,directEventReadsFound:stats[profile].directEventReadsFound,
      cancelledDirectEventReads:stats[profile].cancelledDirectEventReads,
      event404Responses:stats[profile].event404Responses,recurrenceInstances:stats[profile].recurrenceInstances,
      eventReadConflicts:stats[profile].eventReadConflicts,eventsMissingEtag:stats[profile].eventsMissingEtag,
      calendarInventoryEvents:stats[profile].calendarInventoryEvents,
      inventoryMatchedEvents:stats[profile].inventoryMatchedEvents,
      cancelledInventoryMatches:stats[profile].cancelledInventoryMatches,
      accessibleCalendarCount:stats[profile].accessibleCalendarCount,
      freeBusyOnlyCalendarCount:stats[profile].freeBusyOnlyCalendarCount,
      restrictedCalendarCount:stats[profile].restrictedCalendarCount,
      calendarInventoryComplete:stats[profile].calendarInventoryComplete,
      calendarProvenanceComplete:stats[profile].calendarProvenanceComplete,
      calendarProvenanceFresh:stats[profile].calendarProvenanceFresh,
      calendarProvenanceFingerprint:stats[profile].calendarProvenanceFingerprint,
      directIdCalendarCount:stats[profile].directIdCalendarCount,
      unregisteredListedCalendarCount:stats[profile].unregisteredListedCalendarCount,
      inaccessibleCalendarCount:stats[profile].inaccessibleCalendarCount,
      calendarIdsFingerprint:stats[profile].calendarIdsFingerprint,
      calendarInventoryFingerprint:stats[profile].calendarInventoryFingerprint,
      commentInventoryFingerprint:stats[profile].commentInventoryFingerprint,
      todoistTaskInventoryCount:stats[profile].todoistTaskInventoryCount,
      taskInventoryMatches:stats[profile].taskInventoryMatches,
      taskInventoryFingerprint:stats[profile].taskInventoryFingerprint,
      taskCommentInventoryCount:stats[profile].taskCommentInventoryCount,
      taskCommentInventoryMatches:stats[profile].taskCommentInventoryMatches,
      taskCommentInventoryFingerprint:stats[profile].taskCommentInventoryFingerprint,
      taskCommentInventoryComplete:stats[profile].taskCommentInventoryComplete,
      taskCommentInventoryFresh:stats[profile].taskCommentInventoryFresh,
      taskCommentInventorySnapshotAt:stats[profile].taskCommentInventorySnapshotAt,
      taskCommentReadConflicts:stats[profile].taskCommentReadConflicts,
    });
  }
  const closureComplete=!changed&&passes<=MAX_PASSES&&overflow.count===0
    &&taskReadConflicts.size===0&&eventReadConflicts.size===0&&missingEtags.size===0
    &&taskCommentReadConflicts.size===0&&taskCommentReadFailures.size===0
    &&PROFILES.every(profile=>projectCommentInventoryComplete[profile]);
  const fullTaskCommentInventoryComplete=PROFILES.every(profile=>stats[profile].taskCommentInventoryFresh);
  const fullCalendarInventoryComplete=PROFILES.every(profile=>calendarInventoryCompleteByProfile[profile]);
  const allProfilesQueried=PROFILES.every(profile=>Boolean(profileReaders[profile]));
  // CalendarList covers only calendars on each user's list. Direct-ID calendar
  // ACLs have no independent complete inventory in this observer, so this
  // remains false until that provenance is supplied by an authoritative source.
  const allAccessibleCalendarCoverageProven=false as const;
  const knownIdentitiesAbsentFromCurrentProviders=allAccessibleCalendarCoverageProven
    &&closureComplete&&allProfilesQueried&&fullTaskCommentInventoryComplete
    &&fullCalendarInventoryComplete&&PROFILES.every(profile=>projectCommentInventoryComplete[profile])
    &&provider404s===0&&PROFILES.every(profile=>
    stats[profile].taskReadsFound===0&&stats[profile].taskInventoryMatches===0
      &&stats[profile].taggedEvents===0&&stats[profile].directEventReadsFound===0
      &&inventoryMatchedIds[profile].size===0&&matchedComments.get(profile)?.size===0);
  const missingProof=[
    ...(!fullCalendarInventoryComplete?["CalendarList is unavailable or one or more calendars restrict event details"]:[]),
    ...(PROFILES.some(profile=>calendarAccessCounts[profile].freeBusyOnly>0)
      ?["One or more calendars grant only free/busy access, so their event identities cannot be inventoried"]:[]),
    ...(PROFILES.some(profile=>stats[profile].restrictedCalendarCount>calendarAccessCounts[profile].freeBusyOnly)
      ?["One or more calendars hide private event details, so their full identity inventory is incomplete"]:[]),
    "Google CalendarList enumerates calendars on each user's list; direct-ID calendars outside that list still need independent provenance",
    "Unlinked or untagged Calendar events still require explicit identity provenance; title or date matching is not accepted",
    ...(!fullTaskCommentInventoryComplete?["Todoist full Sync task-comment inventory is missing, incomplete, or older than five minutes for one or more profiles"]:[]),
    ...(!PROFILES.every(profile=>projectCommentInventoryComplete[profile])
      ?["One or more Todoist project comment inventories were unavailable during the audit"]:[]),
    "Provider 404/410 responses are observations, not proof of identity absence",
    "Project/task comment results and provider reads can change; direct ETag and action-time rechecks remain required",
    "A strongly consistent paginated table scan is not a transactionally consistent table snapshot",
    "Writer fence, lease drain, historical Lambda versions and cross-account invoke paths need independent action-time verification",
    "Cross-profile observations never constitute a complete atomic release manifest or operator authorization",
    ...(malformedComments.size?["Malformed mapping comments mention one or more candidate identities"]:[]),
    ...(unparsedTaskComments.size?["Unparsed task comments mention one or more candidate identities"]:[]),
    ...(taskReadConflicts.size?["Todoist direct reads disagreed with the complete active-task inventories"]:[]),
    ...(eventReadConflicts.size?["Calendar direct reads disagreed with the complete unfiltered inventories"]:[]),
    ...(taskCommentReadConflicts.size?["Todoist direct task-comment reads disagreed with the full Sync task-comment inventories"]:[]),
    ...(taskCommentReadFailures.size?["One or more exact Todoist task-comment reads returned 404; comment provenance remains incomplete"]:[]),
    ...(missingEtags.size?["One or more direct Calendar events have no ETag for independent version checks"]:[]),
    ...(provider404s?["One or more direct provider reads returned 404/410; keep absence unverified"]:[]),
    ...(overflow.count?["Identity closure exceeded the bounded observer capacity"]:[]),
    ...(!closureComplete?["Identity reference closure did not converge within its bounded passes"]:[]),
  ];
  const profileEvidence=Object.fromEntries(PROFILES.map(profile=>[profile,stats[profile]])) as CrossProfileErasureEvidence["profiles"];
  return {
    phase:"read_only_cross_profile_observation",eligibleForPostWriteRelease:false,
    allProfilesQueried,closureComplete,allAccessibleCalendarCoverageProven,knownIdentitiesAbsentFromCurrentProviders,
    stateScan:{stronglyConsistent:true,allPagesReceived:true,rowCount:input.fullRows.length,
      relatedRowCount:relatedRows.length,fingerprint:stateFingerprint,tableFingerprint},
    identities:{taskCount:taskIds.size,eventCount:eventIds.size,seriesCount:seriesIds.size,overflowCount:overflow.count,
      fingerprint:fingerprint(aliases)},
    profiles:profileEvidence,
    evidenceFingerprint:fingerprint({stateFingerprint,aliases,profileEvidence,closureComplete}),
    missingProof,
  };
}
