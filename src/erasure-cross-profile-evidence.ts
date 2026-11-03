/**
 * Read-only, all-profile identity/provenance collection for #307. This report
 * is deliberately never release-authoritative: provider 404s are ambiguous,
 * Calendar's taskId index can omit legacy aliases, and DynamoDB scans are not
 * transaction snapshots. No raw task/event/comment content is returned.
 */
import {buildProjectMappingIndex,LEGACY_TASK_COMMENT_MARKERS,type TodoistCommentRecord} from "./mapping-comments.js";
import type {CalendarEvent,Profile,TodoistTask} from "./types.js";
import {fingerprint} from "../scripts/item-purge-policy.mjs";

type ProviderPair={
  calendar:{
    listLinkedEventsByTodoistTaskId(taskId:string):Promise<CalendarEvent[]>;
    listAllEventsForErasureAudit():Promise<CalendarEvent[]>;
    getEvent(eventId:string):Promise<CalendarEvent>;
    listEventInstances(masterId:string):Promise<CalendarEvent[]>;
  };
  todoist:{
    getTask(taskId:string):Promise<TodoistTask>;
    listAllTasksForErasureAudit():Promise<TodoistTask[]>;
    listAllProjectCommentsForErasureAudit():Promise<{
      projects:Array<{id:string;workspaceId?:number}>;comments:TodoistCommentRecord[];
    }>;
    listTaskComments(taskId:string):Promise<TodoistCommentRecord[]>;
  };
};

const PROFILES:Profile[]=["home","antonio","work"];
const ID=/^[A-Za-z0-9_.-]{1,1024}$/;
const TASK_FIELDS=new Set(["taskId","providerTaskId","linkedTaskId","discardedTaskId","retainedTaskId","ownerTaskId"]);
const EVENT_FIELDS=new Set(["eventId","providerEventId","masterEventId","activeInstanceId","calendarProjectionId","oldMasterId","newMasterId","lastEventId","occurrenceId","selectedEventId","previousEventId","cancelledEventId","syncHistoryMasterId"]);
const TASK_ARRAYS=new Set(["candidateTaskIds","taskIds"]);
const EVENT_ARRAYS=new Set(["candidateEventIds","eventIds"]);
const MAX_IDENTITIES=32;
const MAX_PASSES=64;

export interface CrossProfileErasureEvidence {
  phase:"read_only_cross_profile_observation";
  eligibleForPostWriteRelease:false;
  allProfilesQueried:boolean;
  closureComplete:boolean;
  knownIdentitiesAbsentFromCurrentProviders:boolean;
  stateScan:{stronglyConsistent:true;allPagesReceived:true;rowCount:number;relatedRowCount:number;fingerprint:string;tableFingerprint:string};
  identities:{taskCount:number;eventCount:number;seriesCount:number;overflowCount:number;fingerprint:string};
  profiles:Record<Profile,{
    taskReadsFound:number;task404Responses:number;tagQueries:number;taggedEvents:number;
    todoistTaskInventoryCount:number;taskInventoryMatches:number;
    taskReadConflicts:number;
    directEventReadsFound:number;event404Responses:number;recurringMasters:number;recurrenceInstances:number;
    calendarInventoryEvents:number;inventoryMatchedEvents:number;
    eventReadConflicts:number;eventsMissingEtag:number;
    projectInventoryCount:number;projectInventoryFingerprint:string;
    projectCommentsRead:number;relatedProjectComments:number;taskCommentsRead:number;relatedLegacyComments:number;
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
}):Promise<CrossProfileErasureEvidence> {
  if(!validId(input.taskId)||(input.eventId!==undefined&&!validId(input.eventId))
    ||!Array.isArray(input.rows)||!Array.isArray(input.fullRows)||typeof input.readerForProfile!=="function")
    throw new Error("Exact erased identity, complete state rows and all-profile readers are required");
  const taskIds=new Set<string>([input.taskId]);
  const eventIds=new Set<string>(input.eventId?[input.eventId]:[]);
  const seriesIds=new Set<string>();
  const overflow={count:0};
  const add=(set:Set<string>,value:unknown)=>{
    if(!validId(value)||set.has(value))return false;
    if(set.size>=MAX_IDENTITIES){overflow.count++;return false;}
    set.add(value);return true;
  };
  const profileReaders={} as Record<Profile,ProviderPair>;
  const projects={} as Record<Profile,TodoistCommentRecord[]>;
  const projectInventoryCounts={} as Record<Profile,number>;
  const projectInventoryFingerprints={} as Record<Profile,string>;
  const taskInventories={} as Record<Profile,Map<string,TodoistTask>>;
  const calendarById={} as Record<Profile,Map<string,CalendarEvent>>;
  const calendarByTask={} as Record<Profile,Map<string,CalendarEvent[]>>;
  const calendarByParent={} as Record<Profile,Map<string,CalendarEvent[]>>;
  const calendarByHistoryMaster={} as Record<Profile,Map<string,CalendarEvent[]>>;
  const calendarBySeries={} as Record<Profile,Map<string,CalendarEvent[]>>;
  const inventoryMatchedIds={} as Record<Profile,Set<string>>;
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
  for(const profile of PROFILES) {
    profileReaders[profile]=await input.readerForProfile(profile);
    const [projectAudit,events,tasks]=await Promise.all([
      profileReaders[profile].todoist.listAllProjectCommentsForErasureAudit(),
      profileReaders[profile].calendar.listAllEventsForErasureAudit(),
      profileReaders[profile].todoist.listAllTasksForErasureAudit(),
    ]);
    if(!projectAudit||!Array.isArray(projectAudit.projects)||!Array.isArray(projectAudit.comments))
      throw new Error("Todoist project/comment audit returned an invalid inventory");
    if(projectAudit.projects.some(project=>!project||!validId(project.id)
      ||(project.workspaceId!==undefined&&(!Number.isSafeInteger(project.workspaceId)||project.workspaceId<=0))))
      throw new Error("Todoist project inventory contains an invalid project identity");
    const projectIds=projectAudit.projects.map(project=>project.id);
    if(new Set(projectIds).size!==projectIds.length)
      throw new Error("Todoist project inventory contains duplicate project identities");
    projects[profile]=projectAudit.comments;
    projectInventoryCounts[profile]=projectIds.length;
    projectInventoryFingerprints[profile]=fingerprint(projectAudit.projects);
    taskInventories[profile]=new Map();
    for(const task of tasks) {
      if(!task||!validId(task.id))throw new Error("Todoist audit inventory contains an invalid task");
      const previous=taskInventories[profile].get(task.id);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(task))
        throw new Error("Todoist task changed during audit inventory");
      taskInventories[profile].set(task.id,task);
    }
    calendarById[profile]=new Map();calendarByTask[profile]=new Map();
    calendarByParent[profile]=new Map();calendarByHistoryMaster[profile]=new Map();calendarBySeries[profile]=new Map();
    inventoryMatchedIds[profile]=new Set<string>();
    taskInventoryMatchIds[profile]=new Set<string>();
    const index=(map:Map<string,CalendarEvent[]>,key:string|undefined,event:CalendarEvent)=>{
      if(!key)return;const values=map.get(key)||[];values.push(event);map.set(key,values);
    };
    for(const event of events) {
      if(!event||!validId(event.id))throw new Error("Calendar audit inventory contains an invalid event");
      calendarById[profile].set(event.id,event);
      index(calendarByTask[profile],event.extendedProperties?.shared?.taskId,event);
      index(calendarByParent[profile],event.recurringEventId,event);
      index(calendarByHistoryMaster[profile],event.extendedProperties?.shared?.syncHistoryMasterId,event);
      index(calendarBySeries[profile],event.iCalUID,event);
    }
    projectIndexes[profile]=buildProjectMappingIndex(projects[profile]);
    commentInventoryDigests[profile]=new Set(projects[profile].map(comment=>
      "project:"+fingerprint([comment.id,comment.content||""])));
    stats[profile]={taskReadsFound:0,task404Responses:0,tagQueries:0,taggedEvents:0,
      todoistTaskInventoryCount:taskInventories[profile].size,taskInventoryMatches:0,taskReadConflicts:0,
      directEventReadsFound:0,event404Responses:0,recurringMasters:0,recurrenceInstances:0,
      calendarInventoryEvents:events.length,inventoryMatchedEvents:0,
      eventReadConflicts:0,eventsMissingEtag:0,
      projectInventoryCount:projectInventoryCounts[profile],
      projectInventoryFingerprint:projectInventoryFingerprints[profile],
      projectCommentsRead:projects[profile].length,relatedProjectComments:0,
      taskCommentsRead:0,relatedLegacyComments:0,calendarInventoryFingerprint:"",
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
      rowRefs(row,taskIds,eventIds,seriesIds);
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
        add(taskIds,item.payload.taskId);add(eventIds,item.payload.eventId);
        add(eventIds,item.payload.masterEventId);add(eventIds,item.payload.activeInstanceId);
        add(seriesIds,item.payload.seriesId);
        matched.add("project:"+item.comment.id+":"+fingerprint(item.comment.content||""));
        if(taskIds.size+eventIds.size>before)changed=true;
      }
      for(const item of index.malformed)if([...taskIds,...eventIds].some(id=>item.comment.content?.includes(id))) {
        const marker="malformed:"+item.comment.id+":"+fingerprint(item.comment.content||"");
        malformedComments.add(profile+"/"+marker);
        matched.add(marker);
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
      const candidates=new Map<string,CalendarEvent>();
      for(const taskId of taskIds)for(const event of calendarByTask[profile].get(taskId)||[])candidates.set(event.id,event);
      for(const eventId of eventIds) {
        const event=calendarById[profile].get(eventId);if(event)candidates.set(event.id,event);
        for(const child of calendarByParent[profile].get(eventId)||[])candidates.set(child.id,child);
        for(const child of calendarByHistoryMaster[profile].get(eventId)||[])candidates.set(child.id,child);
      }
      for(const seriesId of seriesIds)for(const event of calendarBySeries[profile].get(seriesId)||[])candidates.set(event.id,event);
      for(const event of candidates.values()) {
        inventoryMatchedIds[profile].add(event.id);
        if(add(eventIds,event.id))changed=true;
        if(add(taskIds,event.extendedProperties?.shared?.taskId))changed=true;
        if(add(eventIds,event.recurringEventId))changed=true;
        if(add(eventIds,event.extendedProperties?.shared?.syncHistoryMasterId))changed=true;
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
          const comments=await profileReaders[profile].todoist.listTaskComments(taskId);
          stats[profile].taskCommentsRead+=comments.length;
          for(const comment of comments)commentInventoryDigests[profile].add(
            "task:"+fingerprint([taskId,comment.id,comment.content||""]));
          const matched=matchedComments.get(profile)!;
          for(const comment of comments) {
            const content=String(comment.content||"");
            if(LEGACY_TASK_COMMENT_MARKERS.has(content.split(/\r?\n/)[0]||"")) {
              for(const eventId of commentEventIds(comment))if(add(eventIds,eventId))changed=true;
              matched.add("task:"+comment.id+":"+fingerprint(content));
            } else if([...taskIds,...eventIds].some(id=>content.includes(id))) {
              const marker="task-unparsed:"+comment.id+":"+fingerprint(content);
              matched.add(marker);unparsedTaskComments.add(profile+"/"+marker);
            }
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
            if(add(eventIds,event.id))changed=true;
            if(add(eventIds,event.recurringEventId))changed=true;
            if(add(eventIds,event.extendedProperties?.shared?.syncHistoryMasterId))changed=true;
          }
        }
      }
    }
    // Read every discovered Calendar ID in all profiles. A recurring master
    // expands through its complete, bounded instances endpoint.
    for(const eventId of [...eventIds])for(const profile of PROFILES) {
      const eventKey=profile+"/"+eventId;
      if(!processedEventReads.has(eventKey)) {
        processedEventReads.add(eventKey);
        try {
          const event=await profileReaders[profile].calendar.getEvent(eventId);
          if(!event||event.id!==eventId)throw new Error("Calendar direct read returned a different identity");
          stats[profile].directEventReadsFound++;
          const inventoryEvent=calendarById[profile].get(eventId);
          if(!inventoryEvent||!sameCalendarIdentityVersion(event,inventoryEvent))eventReadConflicts.add(eventKey);
          if(typeof event.etag!=="string"||!event.etag)missingEtags.add(eventKey);
          if(add(taskIds,event.extendedProperties?.shared?.taskId))changed=true;
          if(add(eventIds,event.recurringEventId))changed=true;
          if(add(eventIds,event.extendedProperties?.shared?.syncHistoryMasterId))changed=true;
          if(event.recurrence?.length) {
            stats[profile].recurringMasters++;
            const instanceKey=profile+"/"+eventId;
            if(!processedInstances.has(instanceKey)) {
              processedInstances.add(instanceKey);
              const instances=await profileReaders[profile].calendar.listEventInstances(eventId);
              stats[profile].recurrenceInstances+=instances.length;
              for(const instance of instances) {
                if(!instance||!validId(instance.id)||instance.recurringEventId!==eventId)
                  throw new Error("Calendar instance list returned an unattributable event");
                const indexed=calendarById[profile].get(instance.id);
                if(indexed&&!sameCalendarIdentityVersion(indexed,instance))
                  eventReadConflicts.add(profile+"/"+instance.id);
                calendarById[profile].set(instance.id,instance);
                if(add(eventIds,instance.id))changed=true;
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
  for(const profile of PROFILES) {
    const comments=[...matchedComments.get(profile)!].sort();
    stats[profile].relatedProjectComments=comments.filter(value=>value.startsWith("project:")||value.startsWith("malformed:")).length;
    stats[profile].relatedLegacyComments=comments.filter(value=>value.startsWith("task:")).length;
    stats[profile].taskInventoryMatches=taskInventoryMatchIds[profile].size;
    stats[profile].taskReadConflicts=[...taskReadConflicts].filter(key=>key.startsWith(profile+"/")).length;
    stats[profile].eventReadConflicts=[...eventReadConflicts].filter(key=>key.startsWith(profile+"/")).length;
    stats[profile].eventsMissingEtag=[...missingEtags].filter(key=>key.startsWith(profile+"/")).length;
    stats[profile].calendarInventoryEvents=calendarById[profile].size;
    stats[profile].inventoryMatchedEvents=[...eventIds].filter(id=>calendarById[profile].has(id)).length;
    stats[profile].taskInventoryFingerprint=fingerprint([...taskInventories[profile].values()]
      .map(task=>[task.id,fingerprint(task)]).sort(([left],[right])=>String(left).localeCompare(String(right))));
    stats[profile].calendarInventoryFingerprint=fingerprint([...calendarById[profile].values()]
      .map(event=>[event.id,fingerprint(event)]).sort(([left],[right])=>String(left).localeCompare(String(right))));
    stats[profile].commentInventoryFingerprint=fingerprint([...commentInventoryDigests[profile]].sort());
    stats[profile].evidenceFingerprint=fingerprint({
      comments,taskCommentsRead:stats[profile].taskCommentsRead,
      projectInventoryCount:stats[profile].projectInventoryCount,
      projectInventoryFingerprint:stats[profile].projectInventoryFingerprint,
      taskReadsFound:stats[profile].taskReadsFound,task404Responses:stats[profile].task404Responses,
      taskReadConflicts:stats[profile].taskReadConflicts,
      taggedEvents:stats[profile].taggedEvents,directEventReadsFound:stats[profile].directEventReadsFound,
      event404Responses:stats[profile].event404Responses,recurrenceInstances:stats[profile].recurrenceInstances,
      eventReadConflicts:stats[profile].eventReadConflicts,eventsMissingEtag:stats[profile].eventsMissingEtag,
      calendarInventoryEvents:stats[profile].calendarInventoryEvents,
      inventoryMatchedEvents:stats[profile].inventoryMatchedEvents,
      calendarInventoryFingerprint:stats[profile].calendarInventoryFingerprint,
      commentInventoryFingerprint:stats[profile].commentInventoryFingerprint,
      todoistTaskInventoryCount:stats[profile].todoistTaskInventoryCount,
      taskInventoryMatches:stats[profile].taskInventoryMatches,
      taskInventoryFingerprint:stats[profile].taskInventoryFingerprint,
    });
  }
  const closureComplete=!changed&&passes<=MAX_PASSES&&overflow.count===0
    &&taskReadConflicts.size===0&&eventReadConflicts.size===0&&missingEtags.size===0;
  const allProfilesQueried=PROFILES.every(profile=>Boolean(profileReaders[profile]));
  const knownIdentitiesAbsentFromCurrentProviders=closureComplete&&allProfilesQueried&&provider404s===0&&PROFILES.every(profile=>
    stats[profile].taskReadsFound===0&&stats[profile].taskInventoryMatches===0
      &&stats[profile].taggedEvents===0&&stats[profile].directEventReadsFound===0
      &&inventoryMatchedIds[profile].size===0&&matchedComments.get(profile)?.size===0);
  const missingProof=[
    "Calendar inventories cover only each profile's configured sync calendar; other accessible calendars are not enumerated",
    "Unlinked or untagged Calendar events still require explicit identity provenance; title or date matching is not accepted",
    "Todoist v1 has no global task-comment inventory; comments on unrelated or unknown tasks are not enumerated",
    "Provider 404/410 responses are observations, not proof of identity absence",
    "Project/task comment results and provider reads can change; direct ETag and action-time rechecks remain required",
    "A strongly consistent paginated table scan is not a transactionally consistent table snapshot",
    "Writer fence, lease drain, historical Lambda versions and cross-account invoke paths need independent action-time verification",
    "Cross-profile observations never constitute a complete atomic release manifest or operator authorization",
    ...(malformedComments.size?["Malformed mapping comments mention one or more candidate identities"]:[]),
    ...(unparsedTaskComments.size?["Unparsed task comments mention one or more candidate identities"]:[]),
    ...(taskReadConflicts.size?["Todoist direct reads disagreed with the complete active-task inventories"]:[]),
    ...(eventReadConflicts.size?["Calendar direct reads disagreed with the complete unfiltered inventories"]:[]),
    ...(missingEtags.size?["One or more direct Calendar events have no ETag for independent version checks"]:[]),
    ...(provider404s?["One or more direct provider reads returned 404/410; keep absence unverified"]:[]),
    ...(overflow.count?["Identity closure exceeded the bounded observer capacity"]:[]),
    ...(!closureComplete?["Identity reference closure did not converge within its bounded passes"]:[]),
  ];
  const profileEvidence=Object.fromEntries(PROFILES.map(profile=>[profile,stats[profile]])) as CrossProfileErasureEvidence["profiles"];
  return {
    phase:"read_only_cross_profile_observation",eligibleForPostWriteRelease:false,
    allProfilesQueried,closureComplete,knownIdentitiesAbsentFromCurrentProviders,
    stateScan:{stronglyConsistent:true,allPagesReceived:true,rowCount:input.fullRows.length,
      relatedRowCount:relatedRows.length,fingerprint:stateFingerprint,tableFingerprint},
    identities:{taskCount:taskIds.size,eventCount:eventIds.size,seriesCount:seriesIds.size,overflowCount:overflow.count,
      fingerprint:fingerprint(aliases)},
    profiles:profileEvidence,
    evidenceFingerprint:fingerprint({stateFingerprint,aliases,profileEvidence,closureComplete}),
    missingProof,
  };
}
